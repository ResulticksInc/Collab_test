import { db } from "../platform";
import { serializeCall } from "../serialize";
import { roomIsEmpty } from "./livekitService";
import { httpErr as httpError } from "../optimization/httpError";

// Call lifecycle state machine.
//   ringing --accept--> connected --hangup--> ended
//   ringing --decline--> declined
//   ringing --cancel--> cancelled        (caller aborts before answer)
//   ringing --timeout--> missed          (no answer)
// Transitions are guarded: only a ringing call can be accepted/declined/etc.,
// and only the correct party (peer vs initiator) may drive a given transition.
const TERMINAL = ["ended", "declined", "cancelled", "missed", "failed", "busy"];

// Self-heal GHOST calls before a busy-check. A call whose DB row is stuck
// non-terminal (both parties left ungracefully — closed tab / crashed dev server
// — so neither CALL_HANGUP nor a socket disconnect fired) would otherwise report
// the user as "in a call" FOREVER, blocking every future/rejoin call as busy.
// Reap it using LiveKit's ground truth: a 'connected' call whose SFU room is
// CONFIRMED empty is dead → mark it ended. Fail-safe: never reap a 'ringing' call
// (its room isn't created yet — the missed-timeout owns that), and never reap when
// the SFU is unreachable (can't verify) or the room still has participants.
async function reapGhostCalls(userId: string): Promise<number> {
  if (!userId) return 0;
  let n = 0;
  try {
    const active = await db.calls.listActiveForUser(userId);
    await Promise.all(
      active
        .filter((c) => c.status === "connected")
        .map(async (c) => {
          const { empty, sfuReachable } = await roomIsEmpty("call_" + c.id);
          if (sfuReachable && empty) {
            await db.calls.setStatus(c.id, "ended").catch(() => {});
            n++;
          }
        }),
    );
  } catch (_) {
    /* best-effort — a reap failure must never block placing a call */
  }
  return n;
}

async function request({
  conversationId,
  initiatorId,
  peerId,
  kind = "audio",
}) {
  if (!peerId) throw httpError(400, "peerId required");
  if (peerId === initiatorId) throw httpError(400, "cannot call yourself");
  // Authorization: you may only call someone you share a conversation with.
  // (Conversation call -> must be a member; 1:1 call -> must share a DM.)
  // The membership read and the block read are independent → one round trip
  // instead of two (the DB is remote; every serial query is ~a network RTT).
  const [allowed, blocked] = await Promise.all([
    conversationId
      ? db.conversations.isMember(conversationId, initiatorId)
      : db.conversations.findDmBetween(initiatorId, peerId).then((dm) => !!dm),
    db.blocks ? db.blocks.isBlockedEitherWay(initiatorId, peerId) : Promise.resolve(false),
  ]);
  if (!allowed)
    throw httpError(403, "You can only call people you're connected with.");
  // Block enforcement: can't call someone you've blocked or who blocked you.
  if (blocked) throw httpError(403, "You can't call this person.");
  // Busy-check + create are ATOMIC (one txn, rows locked FOR UPDATE) so two
  // concurrent callers to the same peer can't both ring — the loser gets 'busy',
  // and the initiator-already-on-a-call case still throws 409. The returned
  // object shape (mapCall, status 'ringing'|'busy') is identical to before, so
  // the socket layer (busy→CALL_BUSY, ringing→CALL_INCOMING) is unchanged.
  //
  // OPTIMISTIC: try the atomic request FIRST. Only when the busy-check trips
  // (peer busy / initiator 409) do we reap GHOST calls (both parties' dead-but-
  // non-terminal rows, verified against the SFU) and retry once. The reap used
  // to run unconditionally before every call — two listActiveForUser reads plus
  // one LiveKit room probe per connected call — and sat on the ring path for
  // every call, when it only ever matters for a wedged "already in a call".
  const attempt = () =>
    db.calls.requestAtomic({
      conversationId: conversationId || null,
      initiatorId,
      peerId,
      kind,
    });
  let first: any = null;
  try {
    first = await attempt();
  } catch (e: any) {
    if (!e || e.status !== 409) throw e; // initiator reported busy → reap + retry
  }
  if (first && first.status !== "busy") return first;
  const reaped = await Promise.all([reapGhostCalls(initiatorId), reapGhostCalls(peerId)]);
  if (reaped[0] + reaped[1] === 0) {
    // Nothing was a ghost: the busy verdict stands (a 409 is re-thrown by the
    // retry below; a 'busy' row is already recorded).
    if (first) return first;
    return attempt();
  }
  // A dead row was cleared — the real answer is a fresh attempt. (In the rare
  // peer-busy-ghost case the first 'busy' row remains as one history line; far
  // better than the pre-existing wedge where every call reported busy forever.)
  return attempt();
}

async function accept({ callId, userId }) {
  // One guarded write (ringing → connected, by the recipient) instead of
  // read + write + read: the accept round trip is what the CALLER waits for
  // before it knows the callee answered, and the DB is a network hop away.
  const updated = await db.calls.transitionIf(callId, {
    from: "ringing",
    to: "connected",
    peerId: userId,
  });
  if (updated) return updated;
  // Nothing matched — read once to say why.
  const c = await db.calls.getById(callId);
  if (!c) throw httpError(404, "call not found");
  if (c.peerId !== userId)
    throw httpError(403, "only the recipient can accept");
  if (c.status !== "ringing")
    throw httpError(409, `cannot accept a ${c.status} call`);
  return c;
}

async function decline({ callId, userId }) {
  const c = await db.calls.getById(callId);
  if (!c) throw httpError(404, "call not found");
  if (c.peerId !== userId)
    throw httpError(403, "only the recipient can decline");
  if (c.status !== "ringing")
    throw httpError(409, `cannot decline a ${c.status} call`);
  return db.calls.setStatus(callId, "declined");
}

async function cancel({ callId, userId }) {
  const c = await db.calls.getById(callId);
  if (!c) throw httpError(404, "call not found");
  if (c.initiatorId !== userId)
    throw httpError(403, "only the caller can cancel");
  if (c.status !== "ringing")
    throw httpError(409, `cannot cancel a ${c.status} call`);
  return db.calls.setStatus(callId, "cancelled");
}

async function hangup({ callId, userId, durationSec = 0 }) {
  const c = await db.calls.getById(callId);
  if (!c) throw httpError(404, "call not found");
  if (c.initiatorId !== userId && c.peerId !== userId)
    throw httpError(403, "not a participant");
  if (TERMINAL.includes(c.status)) return c; // idempotent
  // hanging up a never-answered call records it appropriately
  if (c.status === "ringing")
    return db.calls.setStatus(
      callId,
      c.initiatorId === userId ? "cancelled" : "declined",
    );
  return db.calls.setStatus(callId, "ended", durationSec);
}

// Server-side no-answer: only transitions if STILL ringing.
async function markMissed(callId) {
  const c = await db.calls.getById(callId);
  if (!c || c.status !== "ringing") return null;
  return db.calls.setStatus(callId, "missed");
}

async function history(userId, opts: any = {}) {
  const rows = await db.calls.listForUser(userId, opts.before, opts.limit);
  return Promise.all(rows.map((c) => serializeCall(c, userId)));
}

async function getById(callId) {
  return db.calls.getById(callId);
}


export {
  request,
  accept,
  decline,
  cancel,
  hangup,
  markMissed,
  history,
  getById,
};
