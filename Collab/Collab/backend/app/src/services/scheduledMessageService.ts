import { db } from "../platform";
import { send as sendMessage } from "./messageService";
import { httpErr } from "../optimization/httpError";

function toIso(v: any) {
  if (!v) return v;
  return v instanceof Date ? v.toISOString() : v;
}

function serialize(s) {
  return {
    id: s.id,
    conversationId: s.conversationId,
    body: s.body,
    sendAt: toIso(s.sendAt),
    status: s.status,
    error: s.error || null,
    createdAt: toIso(s.createdAt),
  };
}

async function assertMember(conversationId, userId) {
  if (!(await db.conversations.isMember(conversationId, userId))) {
    const e: any = new Error("You are not a member of this conversation");
    e.status = 403;
    e.code = "FORBIDDEN";
    throw e;
  }
}

const badRequest = (message: string, code?: string) => httpErr(400, message, code);

function validFutureIso(sendAt) {
  const when = new Date(sendAt);
  if (Number.isNaN(when.getTime()))
    throw badRequest("Invalid send time", "BAD_TIME");
  if (when.getTime() <= Date.now())
    throw badRequest("Scheduled time must be in the future", "PAST_TIME");
  return when.toISOString();
}

async function schedule({ conversationId, senderId, body, sendAt, encrypted }) {
  await assertMember(conversationId, senderId);
  const text = (body || "").trim();
  if (!text) throw badRequest("Message is empty", "EMPTY");
  const iso = validFutureIso(sendAt);
  const row = await db.scheduledMessages.create({
    conversationId,
    senderId,
    body: text,
    sendAt: iso,
    // E2EE conversations: the sender's device encrypted `text` at schedule time
    // and passes the per-device envelope here (server can't encrypt — no keys).
    encrypted: encrypted || null,
  });
  return serialize(row);
}

async function listForConversation(conversationId, userId) {
  await assertMember(conversationId, userId);
  const rows = await db.scheduledMessages.listForConversation(
    conversationId,
    userId,
  );
  return rows.map(serialize);
}

async function reschedule({ id, userId, body, sendAt, encrypted }) {
  const row = await db.scheduledMessages.getById(id);
  if (!row || row.senderId !== userId) return null;
  if (row.status === "sent" || row.status === "sending") {
    const e: any = new Error("This message has already been sent");
    e.status = 409;
    e.code = "ALREADY_SENT";
    throw e;
  }
  const patch: any = {};
  if (typeof body === "string") {
    const t = body.trim();
    if (!t) throw badRequest("Message is empty", "EMPTY");
    patch.body = t;
    // Body changed → the client re-encrypted and sent a fresh envelope (or null
    // for a non-E2EE conversation). Keep ciphertext in lock-step with body.
    patch.encrypted = encrypted || null;
  }
  if (sendAt) patch.sendAt = validFutureIso(sendAt);
  const updated = await db.scheduledMessages.update(id, patch);
  return updated ? serialize(updated) : null;
}

async function cancel({ id, userId }) {
  const row = await db.scheduledMessages.getById(id);
  if (!row || row.senderId !== userId) return { id, deleted: false };
  const r = await db.scheduledMessages.remove(id);
  return { id, conversationId: row.conversationId, deleted: !!r.deleted };
}

// Worker tick: claim due messages and post them via the normal send path. The
// service stays transport-free — it returns the list of { conversationId,
// senderId, message } for the entrypoint poller to broadcast over realtime.
async function runDue(limit = 50) {
  const due = await db.scheduledMessages.claimDue(
    new Date().toISOString(),
    limit,
  );
  const sent: Array<{
    conversationId: string;
    senderId: string;
    message: any;
  }> = [];
  for (const s of due) {
    try {
      const message = await sendMessage({
        conversationId: s.conversationId,
        senderId: s.senderId,
        // E2EE: deliver the pre-computed envelope so the recipient's downgrade
        // guard accepts it. messageService.send stores ciphertext + NULLs body
        // when `encrypted` is set; falls back to plaintext for legacy/non-E2EE.
        text: s.body,
        encrypted: s.ciphertext || null,
        file: null,
      });
      await db.scheduledMessages.setStatus(s.id, "sent", {
        sentMessageId: message.id,
      });
      sent.push({
        conversationId: s.conversationId,
        senderId: s.senderId,
        message,
      });
    } catch (err: any) {
      await db.scheduledMessages.setStatus(s.id, "failed", {
        error: (err && err.message) || "Send failed",
      });
    }
  }
  return sent;
}

export { schedule, listForConversation, reschedule, cancel, runDue };
