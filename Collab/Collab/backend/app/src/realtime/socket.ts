import { Server } from "socket.io";
import { config, shared, db, orgContext } from "../platform";
import { corsOrigin } from "../cors";
import { verify } from "../services/authService";
import { send, toggleReaction, sanitizeClientType } from "../services/messageService";
import * as callService from "../services/callService";
import { deleteRoom, listRoomUserIds, roomToken, publicWsUrl } from "../services/livekitService";
import * as conversationService from "../services/conversationService";
import * as notifService from "../services/notificationService";
import * as huddleStore from "../services/huddleStore";
import * as meetingPolicy from "../services/meetingPolicy";
import { isWhiteboardBlocked } from "../services/whiteboardAccess";
import { sendToUser as webPushToUser, isReady as pushReady, sendWebToUsers as webPushOnly } from "../services/webPushService";
import { sendCallCancel, sendHuddleCancel, forgetDevicesForSession } from "../services/mobilePushService";
import { suppressWebPush, pushNotif } from "./notify";
import { isBlocked } from "../services/tokenBlocklist";
import { pubUser, userAvatarUrl } from "../serialize";

// Retract a push-delivered ring on EVERY device class that has no socket to hear
// CALL_CANCELLED / CALL_DECLINED / CALL_MISSED / CALL_ENDED:
//   • phones  → sendCallCancel (FCM data / APNs VoIP) ends the native ring;
//   • browser → a closed-tab ring is a requireInteraction notification, so it
//     would otherwise sit on screen forever for a call that no longer exists.
//     The service worker closes the notification carrying the same tag, and for
//     a caller hang-up swaps it for a quiet "Missed call from X".
// Best-effort, fire-and-forget; never gated by quiet-hours (it only REMOVES noise).
type AnsweringDevice = { sessionJti?: string | null; deviceId?: string | null } | null;
function retractRing(
  userId: string | null | undefined,
  call: any,
  reason: "cancelled" | "declined" | "missed" | "ended" | "answered",
  callerName?: string,
  // "answered": the device that answered is left out of the mobile retraction
  // (it would retract the CallKit entry of the call it is now on).
  exclude: AnsweringDevice = null,
) {
  if (!userId || !call || !call.id) return;
  void sendCallCancel(userId, call, reason, exclude).catch(() => {});
  void webPushOnly([userId], {
    title: reason === "declined" ? "Call declined" : reason === "answered" ? "Call answered elsewhere" : callerName ? `Missed call from ${callerName}` : "Missed call",
    tag: `colab-call-${call.id}`,
    type: "call_cancel",
    conversationId: call.conversationId || undefined,
    targetType: "call",
    targetId: call.id,
    reason,
  }).catch(() => {});
}
// K8: closed-app preview text for a message push. Mirrors the app's socket-path
// hints (📎 file / 🎤 voice / 📅 meeting) so a terminated phone shows the same
// line as a live one. Never reveals E2EE content (the file name of an encrypted
// attachment lives inside the envelope, so encrypted stays generic — K7 lets
// the phone decrypt the real text).
const cleanPreview = (v: any) => String(v || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
// Client-supplied preview for an ENCRYPTED message (PUSH_E2EE_PLAINTEXT_PREVIEW).
// Sanitised + clipped here; the only place it is ever used is the push body.
export function sanitizePushPreview(v: any): string | null {
  if (typeof v !== "string") return null;
  const t = cleanPreview(v).slice(0, 140);
  return t || null;
}
export function pushPreview(m: { text?: any; file?: any; voice?: any; type?: string; encrypted?: any; pushPreview?: any }): string {
  if (m.encrypted) {
    const supplied = config.fcm.e2eePlaintextPreview ? sanitizePushPreview(m.pushPreview) : null;
    return supplied || "Sent a message";
  }
  const clean = cleanPreview;
  const t = clean(m.text).slice(0, 140);
  if (m.voice) return t || "🎤 Voice message";
  if (m.type === "meeting_invite") return t || "📅 Meeting";
  if (m.file) {
    const name = clean(m.file.name || m.file.filename || m.file.originalName).slice(0, 100);
    return t || (name ? `📎 ${name}` : "📎 Attachment");
  }
  if (m.type === "sticker") return "Sent a sticker";
  if (m.type === "gif") return "Sent a GIF";
  return t || "Sent a message";
}

// K7: the E2EE fields for ONE recipient's message push. `envelopes` is exactly
// what message:new carries: a per-device list for a DM (each with recipientId /
// recipientDeviceId), a single shared envelope object for a group. For a DM we
// keep only the recipient's own envelopes. Returns {} when nothing usable
// remains so the payload stays the plain shape.
export function e2eePushFields(envelopes: any, recipientId: string | null): { encrypted?: boolean; ciphertext?: string } {
  let env = envelopes;
  if (typeof env === "string") { try { env = JSON.parse(env); } catch { return {}; } }
  if (!env) return {};
  if (Array.isArray(env)) {
    const mine = recipientId ? env.filter((e: any) => e && e.recipientId === recipientId) : env;
    if (!mine.length) return {};
    env = mine;
  }
  try {
    return { encrypted: true, ciphertext: JSON.stringify(env) };
  } catch {
    return {};
  }
}

// ---- 1:1 call helpers shared by the socket handlers AND the REST mirror (K6) ----
const bothPartiesOf = (call: any) => [userRoom(call.initiatorId), userRoom(call.peerId)];
const notifyHistoryOf = (io: any, call: any) =>
  bothPartiesOf(call).forEach((r) => io.to(r).emit(EVENTS.CALL_NEW, {}));
// The conversation a call belongs to: a group call carries conversationId;
// a 1:1 call logs into the two parties' DM (if one exists).
async function callConvIdOf(call: any): Promise<string | null> {
  if (call && call.conversationId) return call.conversationId;
  if (call && call.initiatorId && call.peerId && db.conversations.findDmBetween) {
    // findDmBetween returns the conversation id STRING (not an object), so
    // don't deref .id — that made callConvId always null for 1:1 calls, so
    // call-log lines never posted and CALL_DECLINE always took the DM-create
    // fallback.
    const dm = await db.conversations.findDmBetween(call.initiatorId, call.peerId);
    return dm || null;
  }
  return null;
}
// Post a WhatsApp-style call log message into the conversation and broadcast
// it. Best-effort: a failure here must never break the call's signalling.
async function postCallLogOf(io: any, call: any, status: string) {
  try {
    const convId = await callConvIdOf(call);
    if (!convId) return;
    const isVideo = call.kind === "video";
    const icon = isVideo ? "📹" : "📞";
    const dur = Number(call.durationSec || 0);
    const mmss = dur > 0 ? ` · ${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}` : "";
    const label =
      status === "missed" ? `${icon} Missed ${isVideo ? "video " : ""}call`
      : status === "declined" ? `${icon} Call declined`
      : status === "cancelled" ? `${icon} Call cancelled`
      : `${icon} ${isVideo ? "Video call" : "Call"} ended${mmss}`;
    // A normally-ended call was answered — both parties were live in it, so
    // don't raise an unread badge for the "ended" log. Missed/declined/
    // cancelled SHOULD surface as unread (the recipient may have missed it).
    const m = await send({ conversationId: convId, senderId: call.initiatorId, text: label, file: null, type: "call", bumpUnread: status !== "ended" });
    io.to(room(convId)).emit(EVENTS.MESSAGE_NEW, m);
  } catch (_) { /* never break the call flow on a logging error */ }
}

// Faster connect (mobile handoff, Oct 2026): mint the CALLEE's LiveKit token
// for the call room and ship it inside the call_incoming push, so a killed-state
// phone joins the moment the keystore answers instead of first spending a round
// trip on POST /api/calls/token (~1.2 s measured). Same grant the /token route
// would mint for this user and this one room; nothing new is granted. The
// token TTL (LIVEKIT_TOKEN_TTL_SEC, default 1 h) comfortably covers ring + answer.
// Best-effort: on any failure the push goes out without it and the app falls
// back to /token as before.
async function calleeJoinCredentials(call: any, peerUser: any, wsUrl?: string): Promise<{ livekitToken?: string; wsUrl?: string }> {
  try {
    if (!call || !call.id || !call.peerId) return {};
    const t = await roomToken({
      userId: call.peerId,
      name: (peerUser && peerUser.name) || call.peerId,
      avatarUrl: userAvatarUrl(peerUser),
      room: "call_" + call.id,
      role: "participant",
      wsUrl,
    });
    return { livekitToken: t.token, wsUrl: t.wsUrl };
  } catch (e: any) {
    console.warn("[call:request] callee token not minted for push call=%s: %s", call && call.id, e?.message);
    return {};
  }
}

// K6: REST mirrors of CALL_ACCEPT / CALL_DECLINE for a phone that has NO socket
// (Android killed-state shade actions run in a background isolate). Same state
// transition, same events to both parties, same ring retraction + call log as
// the socket handlers — the caller stops hearing ringback immediately instead
// of waiting for CALL_MISSED_MS. Throws the callService httpError (403/404/409)
// so the route can map it.
export async function acceptDirectCall(
  io: any,
  { callId, userId, sessionJti = null, deviceId = null }: { callId: string; userId: string; sessionJti?: string | null; deviceId?: string | null },
) {
  const t0 = Date.now();
  clearCallTimer(callId);
  const call = await callService.accept({ callId, userId });
  if (io) bothPartiesOf(call).forEach((r) => io.to(r).emit(EVENTS.CALL_ACCEPTED, { call }));
  console.log("[CallTrace:server] call=%s accept→accepted +%dms", callId, Date.now() - t0);
  // Answered on this device → the user's OTHER phones stop ringing.
  retractRing(call.peerId, call, "answered", undefined, { sessionJti, deviceId });
  return call;
}
export async function declineDirectCall(io: any, { callId, userId, reason }: { callId: string; userId: string; reason?: string }) {
  clearCallTimer(callId);
  const call = await callService.decline({ callId, userId });
  const msg = typeof reason === "string" ? reason.slice(0, 200).trim() : "";
  if (io) bothPartiesOf(call).forEach((r) => io.to(r).emit(EVENTS.CALL_DECLINED, { call, reason: msg || null }));
  retractRing(call.peerId, call, "declined");
  if (io) notifyHistoryOf(io, call);
  await postCallLogOf(io, call, "declined");
  return call;
}

// REST mirrors of CALL_REQUEST / CALL_HANGUP for a caller that has NO socket —
// the External Data API (routes/external.ts) places and ends calls on behalf
// of a user from another platform. Same state machine, same events to both
// parties (the callee's app rings exactly as for a socket-initiated call), same
// push, missed-call timer and call log as the socket handlers.
export async function requestDirectCall(
  io: any,
  { initiatorId, peerId, kind, conversationId }: { initiatorId: string; peerId: string; kind?: string; conversationId?: string | null },
) {
  const t0 = Date.now();
  const [call, callerUser, peerUser] = await Promise.all([
    callService.request({ initiatorId, peerId, kind: kind || "audio", conversationId: conversationId || null }),
    db.users.getById(initiatorId),
    db.users.getById(peerId),
  ]);
  const payload = {
    call,
    caller: pubUser(callerUser),
    peer: pubUser(peerUser),
  };
  if (call.status === "busy") {
    if (io) {
      io.to(userRoom(initiatorId)).emit(EVENTS.CALL_BUSY, payload);
      notifyHistoryOf(io, call);
    }
    return call;
  }
  if (io) {
    io.to(userRoom(peerId)).emit(EVENTS.CALL_INCOMING, payload);
    io.to(userRoom(initiatorId)).emit(EVENTS.CALL_RINGING, payload);
  }
  console.log("[CallTrace:server] call=%s request→ringing +%dms", call.id, Date.now() - t0);
  if (pushReady()) {
    void (async () => {
      const join = await calleeJoinCredentials(call, peerUser);
      await webPushToUser(peerId, {
        title: `${payload.caller?.name || "Someone"} is calling`,
        body: "Tap to answer",
        tag: `colab-call-${call.id}`,
        type: "call_incoming",
        conversationId: call.conversationId || conversationId || undefined,
        targetType: "call",
        targetId: call.id,
        callKind: call.kind || kind || "audio",
        senderId: initiatorId,
        senderName: payload.caller?.name || undefined,
        senderAvatar: payload.caller?.avatarUrl || undefined,
        ...join,
      });
    })().catch(() => {});
  }
  const t = setTimeout(async () => {
    callTimers.delete(call.id);
    const missed = await callService.markMissed(call.id);
    if (!missed) return;
    if (io) bothPartiesOf(missed).forEach((r) => io.to(r).emit(EVENTS.CALL_MISSED, { call: missed }));
    retractRing(peerId, missed, "missed");
    if (io) notifyHistoryOf(io, missed);
    await postCallLogOf(io, missed, "missed");
    try {
      const n = await notifService.notifyCallMissed({
        userId: peerId,
        callerName: payload.caller?.name || "Someone",
        callId: missed.id,
        conversationId: missed.conversationId,
      });
      if (n && io) pushNotif(io, n);
    } catch (_) {}
  }, MISSED_MS);
  callTimers.set(call.id, t);
  return call;
}
export async function hangupDirectCall(
  io: any,
  { callId, userId, durationSec = 0 }: { callId: string; userId: string; durationSec?: number },
) {
  clearCallTimer(callId);
  const prior = await db.calls.getById(callId);
  const call = await callService.hangup({ callId, userId, durationSec: durationSec || 0 });
  if (io) bothPartiesOf(call).forEach((r) => io.to(r).emit(EVENTS.CALL_ENDED, { call }));
  if (prior && prior.status === "ringing")
    retractRing(call.peerId, call, "ended", (await db.users.getById(userId).catch(() => null))?.name || undefined);
  try {
    await deleteRoom("call_" + callId);
  } catch (_) {}
  if (io) notifyHistoryOf(io, call);
  if (!prior || prior.status !== call.status)
    await postCallLogOf(io, { ...call, durationSec: call.durationSec || durationSec || 0 }, call.status);
  return call;
}

export const recentIncoming = new Map<string, any>();
// Module-level reference populated when attachRealtime() is called, so the
// metrics endpoint can read the live socket count without a circular import.
let _io: any = null;
function getSocketCount(): number {
  try { return _io ? _io.engine.clientsCount : 0; } catch { return 0; }
}
const RECENT_TTL_MS = 5 * 60 * 1000;
const RECENT_MAX = 500;
function pruneRecent() {
  if (recentIncoming.size <= RECENT_MAX) return;
  const cutoff = Date.now() - RECENT_TTL_MS;
  for (const [k, v] of recentIncoming) {
    if (new Date(v.recordedAt).getTime() < cutoff) recentIncoming.delete(k);
  }
  if (recentIncoming.size > RECENT_MAX) {
    const excess = recentIncoming.size - RECENT_MAX;
    let i = 0;
    for (const k of recentIncoming.keys()) {
      if (i++ >= excess) break;
      recentIncoming.delete(k);
    }
  }
}
const { EVENTS } = shared;
const room = (cid) => `conv:${cid}`;
const userRoom = (uid) => `user:${uid}`;
// Device handoff (P0-12): a per-SESSION room (jti = auth_sessions.id) so ONE
// specific signed-in device can be targeted — userRoom fans out to all of them.
const sessionRoom = (jti) => `session:${jti}`;

// In-memory no-answer timers (ephemeral). Intentionally NOT in Redis: these hold
// setTimeout handles, which are per-process and can't be serialized. The instance
// that set the ring owns clearing/firing it (accept/decline/cancel/hangup run on
// the same socket connection that started the ring), so per-instance ownership is
// correct. Huddle membership + raised hands moved to huddleStore (Redis-backed
// when REDIS_URL is set → correct across replicas; in-process Map fallback else).
const callTimers = new Map<string, any>();

// Per-user send throttle for MESSAGE_SEND. Token bucket: capacity 20 (burst),
// refill 5 tokens/sec. A human typing/sending fast peaks ~1-2 msg/s, so this
// never rejects legitimate use; it only clamps an automated flood. Keyed by
// userId (shared across a user's tabs). In-memory / single-instance, matching
// the other ephemeral maps here.
const SEND_BUCKET_CAP = 20;
const SEND_REFILL_PER_SEC = 5;
const sendBuckets = new Map<string, { tokens: number; last: number }>();
function allowSend(userId: string): boolean {
  if (!userId) return true;
  const now = Date.now();
  let b = sendBuckets.get(userId);
  if (!b) {
    b = { tokens: SEND_BUCKET_CAP, last: now };
    sendBuckets.set(userId, b);
  }
  const elapsedSec = (now - b.last) / 1000;
  b.tokens = Math.min(SEND_BUCKET_CAP, b.tokens + elapsedSec * SEND_REFILL_PER_SEC);
  b.last = now;
  // Opportunistic prune so the map can't grow unbounded.
  if (sendBuckets.size > 5000) {
    for (const [k, v] of sendBuckets) if (now - v.last > 60000) sendBuckets.delete(k);
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Dedicated, slower bucket for durable whiteboard saves. Each save can be up to
// ~6MB, so unlike chat sends we clamp hard: ~1 save/sec sustained (burst 4).
// Legit clients debounce to <1 save/1.5s, so this never bites real use; it caps
// a flooding client's DB/bandwidth write-amplification.
const WB_SAVE_BUCKET_CAP = 4;
const WB_SAVE_REFILL_PER_SEC = 1;
const wbSaveBuckets = new Map<string, { tokens: number; last: number }>();
function allowWbSave(userId: string): boolean {
  if (!userId) return true;
  const now = Date.now();
  let b = wbSaveBuckets.get(userId);
  if (!b) {
    b = { tokens: WB_SAVE_BUCKET_CAP, last: now };
    wbSaveBuckets.set(userId, b);
  }
  const elapsedSec = (now - b.last) / 1000;
  b.tokens = Math.min(WB_SAVE_BUCKET_CAP, b.tokens + elapsedSec * WB_SAVE_REFILL_PER_SEC);
  b.last = now;
  if (wbSaveBuckets.size > 5000) {
    for (const [k, v] of wbSaveBuckets) if (now - v.last > 60000) wbSaveBuckets.delete(k);
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Meeting socket-room access gate: only the host or an invited/admitted attendee
// may join a meeting's realtime room and inject chat/reactions/hand state. Mirrors
// the host-or-attendee check the /calls/token route enforces, so a random
// authenticated user can't emit MEETING_* for an arbitrary meeting id.
async function canAccessMeeting(userId: string, mid: string): Promise<boolean> {
  if (!userId || !mid) return false;
  try {
    const m: any = await db.meetings.getById(mid);
    if (!m) return false;
    const isMember = m.createdBy === userId || (m.attendees || []).some((a: any) => a.userId === userId);
    if (!isMember) return false;
    // AUDIT P2 (#20): a host-EJECTED participant must lose the side channels too —
    // otherwise they keep flooding meeting chat/reactions/hands after being removed
    // (the eject list was only consulted on the media-join path). Host is never
    // self-ejected. Fail-open on a lookup error (never wrongly lock out a member).
    if (m.createdBy !== userId && (db.meetings as any).meetingIsEjected) {
      try {
        if (await (db.meetings as any).meetingIsEjected(mid, userId)) return false;
      } catch (_) {
        /* fail-open */
      }
    }
    return true;
  } catch {
    return false;
  }
}

// Host / co-host gate for meeting MODERATION actions arriving over the socket.
// Mirrors routes/meetings.ts requireMeetingHostOrCoHost, but returns a boolean
// (a socket handler has no response to 403 with — it just ignores the emit).
// Fail-CLOSED: a lookup error denies the moderation action rather than granting
// it, the opposite of canAccessMeeting's fail-open membership check.
async function isMeetingHostOrCoHost(userId: string, mid: string): Promise<boolean> {
  if (!userId || !mid) return false;
  try {
    const m: any = await db.meetings.getById(mid);
    if (!m) return false;
    if (m.createdBy === userId) return true;
    const role = await db.meetings.getAttendeeRole(mid, userId);
    return role === "co-host";
  } catch {
    return false;
  }
}

// Whiteboard access gate. A board key is "meeting:<id>" or "call:<id>". Only a
// participant of the underlying meeting/call may read or persist its board — this
// closes the cross-user/ejected-member read+overwrite hole (a former attendee who
// still knows the id must NOT be able to exfiltrate or wipe the durable board).
// For "call:", the id is a 1:1 call row OR (group huddle) a conversation id, so we
// accept a party of the call OR a member of the call's/board's conversation.
async function canAccessBoard(userId: string, boardKey: string): Promise<boolean> {
  if (!userId || !boardKey) return false;
  const idx = boardKey.indexOf(":");
  if (idx < 0) return false;
  const kind = boardKey.slice(0, idx);
  const id = boardKey.slice(idx + 1); // may itself contain ':' — keep the rest
  if (!id) return false;
  try {
    if (kind === "meeting") return await canAccessMeeting(userId, id);
    if (kind === "call") {
      try {
        const c: any = await db.calls.getById(id);
        if (c && (c.initiatorId === userId || c.peerId === userId)) return true;
        if (c && c.conversationId && (await db.conversations.isMember(c.conversationId, userId)))
          return true;
      } catch {
        /* fall through to conversation check */
      }
      // Group huddle: the board id can be the conversation id directly.
      try {
        if (await db.conversations.isMember(id, userId)) return true;
      } catch {
        /* deny */
      }
      return false;
    }
  } catch {
    return false;
  }
  return false;
}
// May this user still WRITE to a meeting's whiteboard snapshot? Reading stays
// governed by canAccessBoard alone. The board can be switched off for the whole
// meeting (admin portal, or the host's Settings modal) or blocked for one person.
// The live strokes travel over the LiveKit data channel and are stopped client-
// side; this closes the durable path, so a blocked person cannot overwrite what
// everyone else sees on reload. Both meeting-wide switches apply to everyone,
// the host included (the host's switch closes the board for the whole meeting).
async function canWriteBoard(userId: string, boardKey: string): Promise<boolean> {
  if (!boardKey.startsWith("meeting:")) return true;
  const mid = boardKey.slice("meeting:".length);
  try {
    const m: any = await db.meetings.getById(mid);
    if (!m) return true;
    if (isWhiteboardBlocked(mid, userId)) return false;
    const o = meetingPolicy.optionsOf(m);
    return o.allowWhiteboard && o.hostAllowWhiteboard;
  } catch {
    return true; // fail-open: never lose a board over a lookup error
  }
}
// K2: the phone's native ring is 45 s and must out-ring the server, so the
// missed-call timeout is capped at 40 s. A higher CALL_MISSED_MS is clamped
// (and logged) rather than honoured — tell mobile before raising the cap.
// Handshake auth verdict cache (see io.use). Keyed by the token's signature
// segment, like tokenBlocklist; stores only "allowed" verdicts.
const AUTH_CACHE_MS = Math.max(0, Number(config.realtime?.authCacheMs) || 0);
const authVerdicts = new Map<string, { until: number; jti: string | null }>();
function tokenCacheKey(token: any): string {
  const parts = String(token || "").split(".");
  return parts.length === 3 ? parts[2] : String(token || "");
}
function forgetAuthVerdict(jti: string) {
  if (!jti) return;
  for (const [k, v] of authVerdicts) if (v.jti === jti) authVerdicts.delete(k);
}
// Grace before a socket drop may end a CONNECTED call (config.calls).
const DISCONNECT_GRACE_MS = Math.max(0, Number(config.calls.disconnectGraceMs) || 0);
const MISSED_MS_CAP = 40_000;
const MISSED_MS = Math.min(Number(config.calls.missedTimeoutMs) || 35_000, MISSED_MS_CAP);
if ((Number(config.calls.missedTimeoutMs) || 0) > MISSED_MS_CAP)
  console.warn("[calls] CALL_MISSED_MS=%s exceeds the %sms mobile ring cap — clamped", config.calls.missedTimeoutMs, MISSED_MS_CAP);
function clearCallTimer(callId) {
  const t = callTimers.get(callId);
  if (t) {
    clearTimeout(t);
    callTimers.delete(callId);
  }
}

function attachRealtime(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin(config.backend.corsOrigins), credentials: true },
    maxHttpBufferSize: 8e6, // 8 MB ceiling per socket packet (AUDIT #92)
    // Accept the engine.io endpoint WITHOUT a trailing slash. The Next reverse
    // proxy forwards the client's "/socket.io/?..." as "/socket.io?..." (the
    // trailing slash is dropped when the rewrite's :path* capture is empty), and
    // the default socket.io server only matches "/socket.io/" → it 404s the
    // proxied handshake. addTrailingSlash:false makes the server match both
    // "/socket.io" and "/socket.io/", so the proxied long-poll connects.
    addTrailingSlash: false,
    // Notice a killed phone process in ~15 s instead of up to 45 s (defaults
    // 25 s + 20 s); see config.realtime. The disconnect handler below still
    // re-checks liveness before ending a call, so this is about presence and
    // ring cleanup speed, not correctness.
    pingInterval: Math.max(1000, Number(config.realtime?.pingIntervalMs) || 5000),
    pingTimeout: Math.max(1000, Number(config.realtime?.pingTimeoutMs) || 10000),
  });
  _io = io; // expose for getSocketCount()

  // Redis adapter readiness gate. CRITICAL: io.adapter(...) REPLACES the
  // namespace adapter with a fresh, EMPTY-rooms instance (socket.io v4
  // Namespace#_initAdapter). Any socket that already joined user:<id> on the
  // old in-memory adapter is NOT migrated and silently stops receiving
  // io.to(userRoom(...)) emits — this is what dropped CALL_INCOMING (and
  // notifications, huddle state, scheduled-message delivery) in production,
  // where REDIS_URL is set. So the swap MUST complete BEFORE any socket joins a
  // room. We hold a readiness promise and await it in the auth middleware,
  // which always runs before the connection handler — so socket.join() at line
  // ~86 always runs against the FINAL adapter. attachRealtime stays synchronous
  // for callers/tests; when REDIS_URL is empty the promise is already-resolved
  // and the await is a no-op microtask (zero behavior change).
  const adapterReady: Promise<void> = config.redis?.url
    ? (async () => {
        // Hard cap: the gate must NEVER block handshakes indefinitely. If Redis
        // is slow/unreachable, fall back to the in-memory adapter after 3s so
        // sockets can still connect (single-instance still works perfectly on
        // the in-memory adapter — Redis only matters for multi-instance fan-out).
        // `settled` ensures we log exactly ONE outcome line (not the old double
        // "disabled" + "timed out").
        let settled = false;
        let timer: any;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              console.warn("[socket] Redis unreachable — using in-memory adapter (fine for single instance)");
            }
            resolve();
          }, 3000);
          if (timer.unref) timer.unref();
        });
        const connect = (async () => {
          try {
            const [{ createAdapter }, redis] = await Promise.all([
              import("@socket.io/redis-adapter"),
              import("redis"),
            ]);
            const pubClient = redis.createClient({
              url: config.redis.url,
              // AUDIT P2 (#41): keep reconnecting after a POST-boot Redis restart/
              // failover so cross-instance fan-out (messages/calls/presence/huddle
              // state) recovers on its own — `false` left it permanently broken until
              // a backend restart. Capped backoff. The boot readiness gate is still
              // bounded by the timeout race below (a Redis down AT BOOT degrades to
              // in-memory rather than wedging the handshake).
              socket: {
                connectTimeout: 2500,
                reconnectStrategy: (retries: number) => Math.min(500 + retries * 500, 15000),
              },
            });
            const subClient = pubClient.duplicate();
            // Don't let an unhandled 'error' event crash the process when Redis
            // is absent; we degrade to in-memory.
            pubClient.on("error", () => {});
            subClient.on("error", () => {});
            await Promise.all([pubClient.connect(), subClient.connect()]);
            // If the boot window already elapsed (Redis was slow), stay on the
            // in-memory adapter for this process rather than swapping the adapter out
            // from under live handshakes. (Redis-up-at-boot is the common path and
            // still gets the reconnecting adapter above.)
            if (settled) {
              try { await pubClient.quit(); await subClient.quit(); } catch (_) {}
              return;
            }
            io.adapter(createAdapter(pubClient, subClient));
            settled = true; clearTimeout(timer); console.log("[socket] Redis adapter enabled");
          } catch (e: any) {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              console.warn("[socket] Redis unreachable — using in-memory adapter (fine for single instance)");
            }
          }
        })();
        await Promise.race([connect, timeout]);
      })()
    : Promise.resolve();

  io.use(async (socket, next) => {
    // Block the handshake until the adapter swap (if any) is done, so the socket
    // joins its room on the final adapter, never the discarded one.
    await adapterReady;
    try {
      const t = socket.handshake.auth && socket.handshake.auth.token;
      const p = verify(t);
      // AUDIT P0: enforce revocation on the realtime plane too — parity with the
      // REST middleware (middleware/auth.ts). verify() only checks signature/expiry,
      // so without this a blocklisted token or a revoked/expired session (admin
      // force-logout, account deletion, stolen device) could CONNECT — and, since
      // socket.io auto-reconnects, RE-connect — with a still-signature-valid token
      // for up to the 7-day access-token TTL, defeating force-logout. Runs on every
      // (re)connect. FAIL-OPEN on a lookup error so a DB blip can't mass-disconnect
      // everyone (same posture as REST); only an explicit revoked/expired/blocked
      // says no.
      const jti = (p as any).jti || null;
      // Cheaper handshake (mobile handoff, Oct 2026): the two revocation reads
      // run IN PARALLEL, and a positive verdict is cached per token for a few
      // seconds (config.realtime.authCacheMs) so a killed-state restart or a
      // reconnect storm does not pay two DB round trips per connect. Negative
      // verdicts are never cached; a revoke on this node evicts the entry
      // (disconnectSession → forgetAuthVerdict), so force-logout stays immediate.
      const cacheKey = tokenCacheKey(t);
      const cached = authVerdicts.get(cacheKey);
      if (!(cached && cached.until > Date.now() && cached.jti === jti)) {
        const [blocked, session] = await Promise.all([
          isBlocked(t).catch(() => false), // fail-open (same posture as REST)
          jti ? db.sessions.getForAuth(jti).catch(() => null) : Promise.resolve(null),
        ]);
        if (blocked) return next(new Error("unauthorized"));
        if (
          session &&
          (session.revoked ||
            (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()))
        )
          return next(new Error("unauthorized"));
        if (AUTH_CACHE_MS > 0) {
          if (authVerdicts.size > 20_000) authVerdicts.clear(); // bound memory
          authVerdicts.set(cacheKey, { until: Date.now() + AUTH_CACHE_MS, jti });
        }
      }
      // Public-link guest (guestMeetingService): a narrow credential bound to ONE
      // meeting. Always session-backed (revocable); the binding is kept on
      // socket.data so the connection handler can fence what the socket may emit.
      if ((p as any).guest === true) {
        if (!jti || typeof (p as any).mid !== "string" || !(p as any).mid)
          return next(new Error("unauthorized"));
        socket.data.guestMeetingId = String((p as any).mid).split("__occ_")[0];
      }
      (socket as any).userId = p.sub;
      // Device handoff (P0-12): keep the session id (JWT jti) so this socket can
      // join its per-session room and be targeted as a specific device.
      (socket as any).jti = jti;
      // Also expose identity on socket.data so cluster-wide fetchSockets() (used
      // by meeting duplicate-device detection, Phase 3c) can read it off the
      // RemoteSocket.data — the (socket as any) props don't survive that hop.
      socket.data.userId = p.sub;
      socket.data.jti = (p as any).jti || null;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const uid = (socket as any).userId;
    // Track which huddles THIS socket actually joined (via HUDDLE_JOIN). Because
    // join-all (below) now subscribes every socket to every conversation room,
    // socket.rooms can no longer identify this socket's huddles for disconnect
    // cleanup — a second/idle session (or a reconnect) would otherwise evict the
    // user from a call they joined on a DIFFERENT socket, and could post a bogus
    // "Group call ended". This per-socket set is the source of truth for the
    // "disconnecting" cleanup.
    const joinedHuddles = new Set<string>();
    // ── Public-link guest fence ───────────────────────────────────────────────
    // Every handler below is written for a signed-in member. A guest's socket may
    // emit ONLY the in-meeting events, and only for the meeting it was minted for;
    // anything else is dropped before its handler runs (so a handler added later
    // is closed to guests by default). File attachments are stripped from guest
    // chat: a guest can't upload, and an arbitrary file id must not be adopted
    // into the meeting's chat group on their say-so.
    const guestMid: string | null = (socket.data && socket.data.guestMeetingId) || null;
    if (guestMid) {
      const GUEST_EVENTS = new Set<string>([
        EVENTS.MEETING_JOIN,
        EVENTS.MEETING_HAND_RAISE,
        EVENTS.MEETING_HAND_LOWER,
        EVENTS.MEETING_REACTION,
        EVENTS.MEETING_CHAT_SEND,
        "wb:save",
        "wb:load",
      ]);
      const baseId = (v: any) => String(v || "").split("__occ_")[0];
      socket.use((packet: any[], next: (err?: Error) => void) => {
        const [event, payload] = packet;
        if (!GUEST_EVENTS.has(event)) return next(new Error("guest_forbidden"));
        const body = payload && typeof payload === "object" ? payload : {};
        const forThisMeeting =
          event === "wb:save" || event === "wb:load"
            ? typeof body.boardKey === "string" &&
              (body.boardKey === "meeting:" + guestMid ||
                body.boardKey.startsWith("meeting:" + guestMid + "__occ_"))
            : baseId(body.meetingId) === guestMid;
        if (!forThisMeeting) return next(new Error("guest_forbidden"));
        if (event === EVENTS.MEETING_CHAT_SEND && body.file) body.file = null;
        next();
      });
    }
    socket.join(userRoom(uid));
    // Device handoff (P0-12): join the per-session room so THIS device can be
    // addressed individually (move-call offers, future companion mode).
    const jti = (socket as any).jti;
    if (jti) socket.join(sessionRoom(jti));
    console.log("[socket] connect uid=%s joined room=%s", uid, userRoom(uid));

    // Live preview + unread for EVERY conversation, not just the one the user is
    // actively viewing. MESSAGE_NEW is emitted to conv:<id>; a client only joined
    // that room for the conversation it had OPEN, so a recipient who isn't looking
    // at a given chat (classically: mid call/meeting, where no tab-focus refetch
    // ever fires) never received the event — its list preview + unread stayed
    // stale until they opened it. Subscribing this socket to all of the user's
    // conversation rooms on connect closes that gap. The id query returns only the
    // caller's OWN conversations, so there's no IDOR (same gate as CONVERSATION_JOIN).
    // Fire-and-forget so it never blocks the rest of the handler registration; a
    // message landing in the sub-ms join window is still reconciled by the client's
    // initial getConversations load.
    (async () => {
      try {
        // Match the tenant the client actually renders: the REST conversation list
        // is org-scoped via currentOrgId(), but socket handlers don't run inside
        // orgContext, so scope this the same way using the session's active org —
        // otherwise a multi-org member would join conversation rooms across EVERY
        // org. Uses the id-only query (no members fan-out / last-message scan).
        let orgId: string | null = null;
        if (jti) {
          try {
            const s = await db.sessions.getForAuth(jti);
            orgId = (s && s.activeOrgId) || null;
          } catch (_) {}
        }
        const ids = await orgContext.run({ orgId }, () =>
          db.conversations.listConversationIdsForUser(uid),
        );
        for (const cid of ids || []) if (cid) socket.join(room(cid));
      } catch (_) {}
    })();

    // ── Device handoff (P0-12) ─────────────────────────────────────────────
    // devices:list — the caller's OWN signed-in devices with live/online flags
    // (sessions are the source of truth; online = a socket sits in the session
    // room right now). Ack-style so the picker can await it.
    socket.on(EVENTS.DEVICES_LIST, async (_p: any, ack: any) => {
      try {
        const rows = await db.sessions.listForUser(uid);
        const devices = [] as any[];
        for (const s of rows || []) {
          if (s.revoked) continue;
          const r = io.sockets.adapter.rooms.get(sessionRoom(s.id));
          devices.push({
            id: s.id,
            deviceLabel: s.deviceLabel || "Unknown device",
            platform: s.platform || "web",
            lastActiveAt: s.lastActiveAt || null,
            online: !!(r && r.size > 0),
            current: !!jti && s.id === jti,
          });
        }
        if (typeof ack === "function") ack({ ok: true, devices });
      } catch (_) {
        if (typeof ack === "function") ack({ ok: false, devices: [] });
      }
    });
    // handoff:request — source device asks ONE of the user's other devices to
    // continue the active call/meeting. Strictly same-user: the target session
    // must belong to the authenticated caller (never a cross-user signal).
    socket.on(EVENTS.HANDOFF_REQUEST, async (p: any) => {
      try {
        const to = String((p && p.toSessionId) || "");
        if (!to) return;
        const mine = await db.sessions.listForUser(uid);
        const me = (mine || []).find((s: any) => s.id === jti);
        const target = (mine || []).find((s: any) => s.id === to && !s.revoked);
        if (!target) return;
        io.to(sessionRoom(to)).emit(EVENTS.HANDOFF_OFFER, {
          fromSessionId: jti || null,
          fromLabel: (me && me.deviceLabel) || "another device",
          mode: p && p.mode === "join" ? "join" : "move",
          kind: (p && p.kind) || "call",
          callId: (p && p.callId) || null,
          conversationId: (p && p.conversationId) || null,
          meetingId: (p && p.meetingId) || null,
          title: (p && p.title) || null,
          video: !!(p && p.video),
          peer: (p && p.peer) || null,
        });
      } catch (_) {}
    });
    // handoff:accept / decline — target answers; route back to the SOURCE
    // session. Same-user validated (a claimed session id outside the caller's
    // own sessions is dropped) so no one can force another USER off a call.
    const routeBack = (evt: string) => async (p: any) => {
      try {
        const to = String((p && p.fromSessionId) || "");
        if (!to) return;
        const mine = await db.sessions.listForUser(uid);
        if (!(mine || []).some((s: any) => s.id === to)) return;
        io.to(sessionRoom(to)).emit(evt, {
          bySessionId: jti || null,
          mode: p && p.mode === "join" ? "join" : "move",
        });
      } catch (_) {}
    };
    socket.on(EVENTS.HANDOFF_ACCEPT, routeBack(EVENTS.HANDOFF_CONFIRMED));
    socket.on(EVENTS.HANDOFF_DECLINE, routeBack(EVENTS.HANDOFF_DECLINED));
    // Scope presence fan-out to people who actually share a conversation with
    // this user (their DM/group peers) instead of a global io.emit to EVERY
    // socket (O(N) per connect/disconnect → O(N^2) reconnect storms at scale).
    // The frontend only reacts to PRESENCE_UPDATE for users it shares a DM with,
    // so non-peers ignored it anyway — behavior-preserving for the dot. Routes
    // cross-instance via the (already-wired) Redis adapter, like every other
    // targeted emit. Also emits to the user's own room (their other tabs).
    const emitPresence = async (presence: string) => {
      // When going offline, carry the authoritative last-seen time (just stamped
      // by setPresence → last_seen=now()) so peers refresh their "last seen"
      // label live instead of showing a stale value from initial load.
      const payload: any = { userId: uid, presence };
      if (presence === shared.PRESENCE.OFFLINE)
        payload.lastSeen = new Date().toISOString();
      try {
        const peerIds = await db.conversations.listPeerIds(uid);
        const targets = new Set<string>(peerIds);
        targets.add(uid);
        for (const pid of targets) io.to(userRoom(pid)).emit(EVENTS.PRESENCE_UPDATE, payload);
      } catch (e: any) {
        console.warn("[socket] presence fan-out failed uid=%s: %s", uid, e?.message);
        io.to(userRoom(uid)).emit(EVENTS.PRESENCE_UPDATE, payload);
      }
    };
    // All socket.on(...) listeners are registered synchronously below, BEFORE
    // any await, so an event a client emits immediately on connect (e.g. a
    // call) is never dropped. Presence is announced afterwards (see end).

    socket.on(EVENTS.CONVERSATION_JOIN, async ({ conversationId } = {} as any) => {
      if (!conversationId) return;
      // Authz: only a member may subscribe to a conversation's realtime room.
      // Without this, any authenticated client could join conv:<any id> and
      // receive that conversation's MESSAGE_NEW / MESSAGE_UPDATED events (IDOR).
      // Mirrors the membership gate on the huddle/meeting joins below, and on
      // messageService.send (which already guards the MESSAGE_SEND join).
      if (!(await db.conversations.isMember(conversationId, uid))) return;
      socket.join(room(conversationId));
    });

    socket.on(
      EVENTS.MESSAGE_SEND,
      async ({ conversationId, text, file, type: rawType, voice, encrypted, forwarded, forwardCount, parentMessageId, important, clientId, mentionUserIds, mentionBroadcast, pushPreview: pushPreviewRaw } = {} as any) => {
        if (!conversationId || (!text && !file && !encrypted && !voice && !rawType)) return;
        if (!allowSend(uid)) {
          // Flood protection. The client emits MESSAGE_SEND fire-and-forget and
          // renders on the MESSAGE_NEW echo, so dropping here just means no echo;
          // this advisory event lets a client optionally show a "slow down" hint.
          socket.emit("message:rate_limited", { conversationId });
          return;
        }
        // Privileged kinds (meeting_invite/task_card/system/call) are authored ONLY
        // by trusted server callers; a client supplying one is spoofing a
        // server-authored card. sanitizeClientType coerces those to "text"; legit
        // client kinds (voice/sticker/gif/text) pass through unchanged.
        const type = sanitizeClientType(rawType);
        const payload = { conversationId, text, file, type, voice, encrypted, forwarded, forwardCount, parentMessageId, senderId: uid };
        let msg: any;
        try {
          msg = await send({
            conversationId,
            senderId: uid,
            text,
            file,
            type,
            voice,
            encrypted,
            forwarded,
            forwardCount,
            parentMessageId,
            important: !!important,
          });
        } catch (e: any) {
          // The send was rejected (e.g. BLOCKED — a DM where either party blocked
          // the other). The client renders optimistically and only reconciles on
          // the MESSAGE_NEW echo; without this the failed message would look sent
          // forever. Tell the sender so it can drop the optimistic message + show
          // why and flip the conversation to its blocked state.
          socket.emit("message:send_failed", {
            conversationId,
            code: e?.code || "SEND_FAILED",
            message: e?.message || "Message couldn't be sent.",
          });
          return;
        }
        // record the exact incoming client payload keyed by the produced message id
        try {
          // `pushPreview` (E2EE plaintext preview) is deliberately NOT part of
          // `payload` — it must never sit in the debug ledger.
          recentIncoming.set(msg.id, { payload, recordedAt: new Date().toISOString() });
          pruneRecent();
        } catch (_) {}
        socket.join(room(conversationId));
        // Deliver to the conversation room AND every member's USER room in one
        // emit (socket.io de-dupes a socket that sits in both). The user room is
        // ALWAYS joined on connect, so this guarantees delivery even when the
        // recipient's conversation-room join hasn't settled yet — the FIRST
        // message in a brand-new conversation otherwise races the room join and is
        // missed (only the 2nd message showed). The client de-dupes MESSAGE_NEW by
        // id. Members are fetched once here and reused for web push below.
        let sendMems: any[] = [];
        try {
          sendMems = (await db.conversations.members(conversationId)) || [];
        } catch (_) {}
        const memberRooms = sendMems
          .filter((m: any) => m && m.userId)
          .map((m: any) => userRoom(m.userId));
        // Echo the sender's client-local id back on the message so the sender can
        // reconcile the EXACT optimistic bubble (never persisted; recipients have
        // no matching optimistic message and simply ignore it). Prevents a fast
        // text echo from replacing a slow in-flight file bubble (or vice-versa).
        if (clientId) (msg as any).clientId = clientId;
        io.to([room(conversationId), ...memberRooms]).emit(EVENTS.MESSAGE_NEW, msg);
        if (pushReady() && type !== "system" && type !== "call") {
          void (async () => {
            try {
              const mems = sendMems;
              // db.conversations.members() maps rows to { userId, muted, … } (the
              // SQL alias `user_id` is normalised to `userId` in the driver). A
              // member who MUTED this conversation (cm.muted) must not get a
              // closed-tab message push — drop them here while we still have the
              // conversation context (suppressWebPush is conversation-agnostic).
              const targets = (mems || [])
                .filter((m: any) => m && m.userId && m.userId !== uid && !m.muted)
                .map((m: any) => m.userId as string);
              if (targets.length) {
                const snd = await db.users.getById(uid);
                const sndName = snd?.name || "New message";
                const preview = pushPreview({ text, file, voice, type, encrypted, pushPreview: pushPreviewRaw });
                // Mobile enrichment (best-effort): lets the phone render a
                // native conversation-style notification with the right
                // title/avatar even when the app process is gone. Ignored by
                // the web service worker.
                let convMeta: any = null;
                try { convMeta = await db.conversations.getById(conversationId); } catch (_) {}
                const isDm = convMeta?.kind === "dm";
                const enrich = {
                  messageId: msg.id,
                  senderId: uid,
                  senderName: sndName,
                  senderAvatar: snd?.avatarUrl || undefined,
                  // K7b: initials-on-colour disc for photo-less senders (the
                  // phone can't derive a GROUP sender's colour on its own).
                  senderInitials: snd?.initials || undefined,
                  senderColor: snd?.color || undefined,
                  conversationKind: convMeta?.kind || undefined,
                  conversationTitle: convMeta?.title || undefined,
                };
                // K7: the server can't read E2EE content, but the PHONE can — it
                // holds the keys and already decrypts on every other path. Ship
                // the envelope(s) the message:new event carries so a killed app
                // shows the real text instead of "Sent a message". Per recipient
                // for a DM (only their devices' envelopes — the sender's are
                // dead weight against the 4 KB FCM limit); the shared envelope
                // as-is for a group. mobilePushService drops the field when the
                // data map would still be too large. Gated by
                // PUSH_E2EE_CIPHERTEXT (default OFF): without it an encrypted
                // message pushes only `encrypted: true` + the generic body, so
                // no ciphertext leaves the server via FCM/APNs at all.
                const envelopes = encrypted && config.fcm.e2eeCiphertext ? (msg.ciphertext ?? encrypted) : null;
                // Route the CLOSED-TAB message push through the SAME quiet-hours /
                // notifyLevel="none" suppression gate that reminders and task_due
                // use (notify.suppressWebPush) — the gate must be pushNotif-wide,
                // not reminders-only. Per-recipient (each target evaluated against
                // their own settings/timezone); fail-open inside suppressWebPush.
                // Per-conversation mute was already applied above.
                await Promise.allSettled(targets.map(async (t: string) => {
                  try { if (await suppressWebPush(t)) return; } catch (_) {}
                  const e2ee = envelopes ? e2eePushFields(envelopes, isDm ? t : null) : encrypted ? { encrypted: true } : {};
                  return webPushToUser(t, { title: sndName, body: preview, tag: `colab-msg-${msg.id}`, type: "message", conversationId, targetType: "message", targetId: msg.id, ...enrich, ...e2ee }).catch(() => {});
                }));
              }
            } catch (_) {}
          })();
        }
        // Dispatch @mention / @channel / reply notifications (fire-and-forget).
        // Each goes through pushNotif: the live socket emit as before PLUS the
        // closed-tab / killed-app push. These are DIRECTED notifications, so
        // suppressWebPush treats them as mentions — they still reach a
        // "mentions only" user and a member who muted the conversation, whom the
        // generic message push above (correctly) skips. The tag equals the
        // message push's tag so the two collapse into one OS notification.
        void (async () => {
          try {
            const sender = await db.users.getById(uid);
            const senderName = sender?.name || "Someone";
            const msgTag = `colab-msg-${msg.id}`;
            // E2EE: never read/persist plaintext excerpts. For encrypted messages
            // `text` is absent, but gate explicitly so a buggy/malicious client
            // that sends BOTH `encrypted` and `text` can't leak a mention/reply
            // excerpt into the notifications table.
            // The sender resolves each @mention to a real user id in the composer
            // and ships those ids as METADATA (never the text). This is the only
            // mention path that works for an ENCRYPTED message — the block below
            // needs readable `text`, which by design we never have for E2EE, so
            // mentions previously notified nobody in any DM, group or channel.
            // Ids are also exact, which fixes the mention landing on the wrong
            // person when two members share a first name.
            //
            // NEVER trust the ids blindly: keep only real members of THIS
            // conversation (a client could otherwise ping anyone), and drop the
            // sender. No body is passed for an encrypted message, so no plaintext
            // excerpt is persisted.
            const memberIdSet = new Set(
              sendMems.map((m: any) => String(m.userId || m.user_id || m.id)).filter(Boolean),
            );
            // Capped before any work: this array is client-supplied, and mapping
            // then de-duplicating an unbounded list on the realtime thread is a
            // cheap way for one client to burn CPU and memory for everyone. 64 is
            // far above any plausible number of mentions in one message.
            const MAX_MENTION_IDS = 64;
            const claimedIds: string[] = Array.isArray(mentionUserIds)
              ? [
                  ...new Set(
                    mentionUserIds
                      .slice(0, MAX_MENTION_IDS)
                      .map((x: any) => String(x || ""))
                      .filter(Boolean),
                  ),
                ]
              : [];
            const targetIds = claimedIds.filter((id) => id !== uid && memberIdSet.has(id));
            if (targetIds.length) {
              const direct = await notifService.notifyMentionedIds({
                userIds: targetIds,
                senderId: uid,
                senderName,
                conversationId,
                messageId: msg.id,
                // Excerpt only when the server legitimately holds plaintext.
                body: encrypted ? undefined : text,
              });
              for (const n of direct) {
                pushNotif(io, n, { tag: msgTag });
              }
            }
            // @channel / @here in an ENCRYPTED message: the text is unreadable
            // here, so the sender flags it explicitly. Same membership fan-out as
            // the plaintext branch below, minus any excerpt.
            if (encrypted && (mentionBroadcast === "channel" || mentionBroadcast === "here")) {
              const channelNotifs = await notifService.notifyChannel({
                conversationId,
                senderId: uid,
                senderName,
                messageId: msg.id,
                memberIds: [...memberIdSet],
              });
              for (const n of channelNotifs) {
                pushNotif(io, n, { tag: msgTag });
              }
            }
            // Plaintext messages ALSO run the legacy name-resolution path, so an
            // older client that sends no ids still delivers mentions — and so a
            // message that mixes a picked mention with a hand-typed "@Name" still
            // notifies both. This used to be skipped entirely whenever any id was
            // supplied, which silently dropped the typed one. Anyone already
            // notified by id is excluded so nobody is pinged twice, and the
            // id-resolved people keep priority (their ids are exact, so the
            // first-name resolver can never override them onto the wrong person).
            if (text && !encrypted) {
              const mentionNotifs = await notifService.notifyMentions({
                body: text,
                senderId: uid,
                senderName,
                conversationId,
                messageId: msg.id,
                members: sendMems,
                exclude: targetIds,
              });
              for (const n of mentionNotifs) {
                pushNotif(io, n, { tag: msgTag });
              }
            }
            if (text && !encrypted) {
              // @channel / @here: notify every member of the conversation
              if (/@channel|@here/.test(text)) {
                const memberIds = sendMems.map((m: any) => m.userId || m.user_id || m.id);
                const channelNotifs = await notifService.notifyChannel({
                  conversationId,
                  senderId: uid,
                  senderName,
                  messageId: msg.id,
                  memberIds,
                });
                for (const n of channelNotifs) {
                  pushNotif(io, n, { tag: msgTag });
                }
              }
            }
            if (parentMessageId) {
              const parent = await db.messages.getById(parentMessageId);
              if (parent && parent.senderId !== uid) {
                const n = await notifService.notifyReply({
                  parentMessageSenderId: parent.senderId,
                  senderId: uid,
                  senderName,
                  conversationId,
                  messageId: msg.id,
                  body: encrypted ? undefined : text,
                });
                if (n) pushNotif(io, n, { tag: msgTag });
              }
            }
          } catch {}
        })();
      },
    );

    socket.on(
      EVENTS.MESSAGE_REACT,
      async ({ conversationId, messageId, emoji } = {} as any) => {
        if (!messageId || !emoji) return;
        const msg = await toggleReaction({ messageId, userId: uid, emoji });
        if (msg) {
          io.to(room(conversationId || msg.conversationId)).emit(
            EVENTS.MESSAGE_UPDATED,
            msg,
          );
          void (async () => {
            try {
              const msgOwnerId = msg.sender && (msg.sender as any).id;
              // AUDIT P2: only notify on an ADD — un-reacting (toggle-off) must not
              // fire a "reacted to your message" notification, and rapid toggling
              // must not storm the owner.
              if (msgOwnerId && msgOwnerId !== uid && (msg as any)._reactionAdded !== false) {
                const reactor = await db.users.getById(uid);
                const n = await notifService.notifyReaction({
                  userId: msgOwnerId,
                  reactorName: reactor?.name || "Someone",
                  messageId,
                  emoji,
                  conversationId: conversationId || msg.conversationId,
                });
                if (n) io.to(userRoom(n.userId)).emit(EVENTS.NOTIFICATION_NEW, n);
              }
            } catch {}
          })();
        }
      },
    );

    socket.on(EVENTS.TYPING_START, ({ conversationId } = {} as any) => {
      if (conversationId)
        socket
          .to(room(conversationId))
          .emit(EVENTS.TYPING, { conversationId, userId: uid, typing: true });
    });
    socket.on(EVENTS.TYPING_STOP, ({ conversationId } = {} as any) => {
      if (conversationId)
        socket
          .to(room(conversationId))
          .emit(EVENTS.TYPING, { conversationId, userId: uid, typing: false });
    });

    // ---- Call lifecycle signalling (no auto-connect; recipient must accept) ----
    const bothParties = bothPartiesOf;
    const notifyHistory = (call) => notifyHistoryOf(io, call);

    socket.on(
      EVENTS.CALL_REQUEST,
      async ({ peerId, kind, conversationId } = {} as any) => {
        const targetSockets = (
          io.sockets.adapter.rooms.get(userRoom(peerId)) || new Set()
        ).size;
        console.log(
          "[call:request] initiator=%s peerId=%s targetRoom=%s liveSockets=%d",
          uid,
          peerId,
          userRoom(peerId),
          targetSockets,
        );
        const t0 = Date.now();
        try {
          // The two profile reads do not depend on the call row → run them
          // alongside the atomic request instead of after it (remote DB: each
          // serial query is a network round trip on the ring path).
          const [call, callerUser, peerUser] = await Promise.all([
            callService.request({
              initiatorId: uid,
              peerId,
              kind,
              conversationId,
            }),
            db.users.getById(uid),
            db.users.getById(peerId),
          ]);
          const payload = {
            call,
            caller: pubUser(callerUser),
            peer: pubUser(peerUser),
          };
          // Recipient busy: tell only the caller, write history, don't ring.
          if (call.status === "busy") {
            socket.emit(EVENTS.CALL_BUSY, payload);
            notifyHistory(call);
            return;
          }
          // Socket signalling FIRST — both live clients hear it before any
          // push work (token minting, device lookup, FCM/APNs) starts.
          io.to(userRoom(peerId)).emit(EVENTS.CALL_INCOMING, payload); // ring recipient
          socket.emit(EVENTS.CALL_RINGING, payload); // caller hears ringback
          console.log("[CallTrace:server] call=%s request→ringing +%dms", call.id, Date.now() - t0);
          if (pushReady()) {
            void (async () => {
              // Callee's room token rides in the push (see calleeJoinCredentials);
              // the signalling URL is derived from the caller's handshake origin,
              // the same way the /token route derives it from the request.
              const join = await calleeJoinCredentials(call, peerUser, publicWsUrl(socket.handshake));
              await webPushToUser(peerId, {
                title: `${payload.caller?.name || "Someone"} is calling`,
                body: "Tap to answer",
                tag: `colab-call-${call.id}`,
                type: "call_incoming",
                conversationId: call.conversationId || conversationId,
                targetType: "call",
                targetId: call.id,
                // Mobile enrichment: CallKit / CallStyle need the caller identity
                // and audio-vs-video up front (the phone may be terminated).
                callKind: call.kind || kind || "audio",
                senderId: uid,
                senderName: payload.caller?.name || undefined,
                senderAvatar: payload.caller?.avatarUrl || undefined,
                ...join,
              });
            })().catch(() => {});
          }
          const t = setTimeout(async () => {
            callTimers.delete(call.id);
            const missed = await callService.markMissed(call.id);
            if (missed) {
              bothParties(missed).forEach((r) =>
                io.to(r).emit(EVENTS.CALL_MISSED, { call: missed }),
              );
              // A terminated phone was rung by push and has no socket to hear
              // CALL_MISSED — retract its native ring the same way it arrived.
              retractRing(peerId, missed, "missed");
              notifyHistory(missed);
              await postCallLog(missed, "missed");
              // Activity notification for the person who missed the call.
              try {
                const n = await notifService.notifyCallMissed({
                  userId: peerId,
                  callerName: payload.caller?.name || "Someone",
                  callId: missed.id,
                  conversationId: missed.conversationId,
                });
                // Same socket emit as before PLUS web/mobile push, so a missed call also
                // reaches a closed tab / closed app (it used to be live-socket only).
                if (n) pushNotif(io, n);
              } catch (_) {}
            }
          }, MISSED_MS);
          callTimers.set(call.id, t);
        } catch (e: any) {
          socket.emit("call:error", { message: e.message, code: e.status });
        }
      },
    );

    const callConvId = callConvIdOf;
    const postCallLog = (call: any, status: string) => postCallLogOf(io, call, status);

    socket.on(EVENTS.CALL_ACCEPT, async ({ callId } = {} as any) => {
      const t0 = Date.now();
      try {
        clearCallTimer(callId);
        const call = await callService.accept({ callId, userId: uid });
        bothParties(call).forEach((r) =>
          io.to(r).emit(EVENTS.CALL_ACCEPTED, { call }),
        );
        console.log("[CallTrace:server] call=%s accept→accepted +%dms", callId, Date.now() - t0);
        // Answered on this device → the user's OTHER phones stop ringing. The
        // answering session itself is excluded (a phone answering over its
        // socket must not retract its own live call).
        retractRing(call.peerId, call, "answered", undefined, { sessionJti: jti || null });
      } catch (e: any) {
        socket.emit("call:error", { message: e.message, code: e.status });
      }
    });

    socket.on(EVENTS.CALL_DECLINE, async ({ callId, reason } = {} as any) => {
      try {
        clearCallTimer(callId);
        const call = await callService.decline({ callId, userId: uid });
        const msg = typeof reason === "string" ? reason.slice(0, 200).trim() : "";
        bothParties(call).forEach((r) =>
          io.to(r).emit(EVENTS.CALL_DECLINED, { call, reason: msg || null }),
        );
        // Declined on one device (web/desktop) → the user's phones stop ringing.
        retractRing(call.peerId, call, "declined");
        notifyHistory(call);
        await postCallLog(call, "declined");
        // Decline-with-message lands in the conversation as a real message from
        // the decliner (uid), like WhatsApp's quick replies. A 1:1 call can be
        // placed from Contacts/Calls without a prior DM, so FIND-OR-CREATE the DM
        // (server-side, like invite-accept) — otherwise the reply had nowhere to
        // land. Group calls already have call.conversationId.
        if (msg) {
          try {
            let convId = await callConvId(call);
            if (!convId && call.initiatorId && call.peerId) {
              const { conversation } = await conversationService.create({
                kind: "dm",
                title: null,
                icon: null,
                memberIds: [call.initiatorId],
                creatorId: call.peerId,
              });
              convId = conversation && conversation.id;
              if (convId)
                bothParties(call).forEach((r) => {
                  // Server-side room join FIRST: the MESSAGE_NEW below fires
                  // immediately, long before a client could round-trip its own
                  // CONVERSATION_JOIN — without this the decline reply is missed.
                  io.in(r).socketsJoin(room(convId));
                  io.to(r).emit(EVENTS.CONVERSATION_NEW, { conversationId: convId });
                });
            }
            if (convId) {
              // Send as a CALL-metadata message (not "text"): the decliner picks a
              // CANNED reply ("In a meeting — call you back"), and the server can't
              // E2EE-encrypt it — a plaintext type:"text" message is rejected by the
              // receiver's E2EE gate ("[Unencrypted message — rejected]"). Call/meeting
              // metadata is plaintext by design and exempt, so it renders as a call-log
              // line with the reason instead of a broken bubble.
              const rm = await send({ conversationId: convId, senderId: uid, text: msg, file: null, type: "call" });
              io.to(room(convId)).emit(EVENTS.MESSAGE_NEW, rm);
            }
          } catch (_) { /* best-effort reply */ }
        }
      } catch (e: any) {
        socket.emit("call:error", { message: e.message, code: e.status });
      }
    });

    socket.on(EVENTS.CALL_CANCEL, async ({ callId } = {} as any) => {
      try {
        clearCallTimer(callId);
        const call = await callService.cancel({ callId, userId: uid });
        bothParties(call).forEach((r) =>
          io.to(r).emit(EVENTS.CALL_CANCELLED, { call }),
        );
        retractRing(call.peerId, call, "cancelled", (await db.users.getById(uid).catch(() => null))?.name || undefined);
        notifyHistory(call);
        await postCallLog(call, "cancelled");
      } catch (e: any) {
        socket.emit("call:error", { message: e.message, code: e.status });
      }
    });

    socket.on(
      EVENTS.CALL_HANGUP,
      async ({ callId, durationSec } = {} as any) => {
        try {
          clearCallTimer(callId);
          // Snapshot prior status so we only log when THIS hangup performed the
          // terminal transition — hangup() returns idempotently for an already-
          // terminal call, which would otherwise double-post the log.
          const prior = await db.calls.getById(callId);
          const call = await callService.hangup({
            callId,
            userId: uid,
            durationSec: durationSec || 0,
          });
          bothParties(call).forEach((r) =>
            io.to(r).emit(EVENTS.CALL_ENDED, { call }),
          );
          // Hung up before the callee answered: their phones may still be
          // showing the push-driven native ring — retract it.
          if (prior && prior.status === "ringing")
            retractRing(call.peerId, call, "ended", (await db.users.getById(uid).catch(() => null))?.name || undefined);
          // End-for-everyone: a 1:1 call is over when either party hangs up, so
          // tear down the shared SFU room too. That makes the PEER's client fire a
          // terminal Disconnected(ROOM_DELETED) and actually LEAVE — the CALL_ENDED
          // signal alone left them auto-rejoining. Idempotent/best-effort (the room
          // may not exist for a call that only ever rang).
          try {
            await deleteRoom("call_" + callId);
          } catch (_) {}
          notifyHistory(call);
          // Log with the REAL resulting status (hangup maps a still-ringing call
          // to cancelled/declined, not "ended"), and only on an actual change.
          if (!prior || prior.status !== call.status)
            await postCallLog(
              { ...call, durationSec: call.durationSec || durationSec || 0 },
              call.status,
            );
        } catch (e: any) {
          socket.emit("call:error", { message: e.message, code: e.status });
        }
      },
    );

    // ---- Group calls (huddles): join/leave/sync + presence broadcast ----
    // State lives in huddleStore (Redis when REDIS_URL set → correct across
    // replicas; in-process Map fallback otherwise → identical to before).
    const broadcastHuddle = async (cid: string) => {
      const { kind, participants } = await huddleStore.huddleGet(cid);
      const payload = { conversationId: cid, kind, participants };
      const members = await db.conversations.members(cid);
      for (const m of members)
        io.to(userRoom(m.userId)).emit(EVENTS.HUDDLE_STATE, payload);
    };
    // Group-call (huddle) lifecycle log → mirrors the 1:1 postCallLog so a group
    // call leaves a chat trace too ("fix for all contexts"). Best-effort.
    const postHuddleLog = async (cid: string, senderId: string, label: string) => {
      try {
        // "ended" lines don't raise unread (matches the 1:1 + client rule).
        const m = await send({ conversationId: cid, senderId, text: label, file: null, type: "call", bumpUnread: !/ended/i.test(label) });
        io.to(room(cid)).emit(EVENTS.MESSAGE_NEW, m);
      } catch (_) { /* never break huddle signalling on a logging error */ }
    };
    // Remove a participant and, if they were the LAST one, post "Group call
    // ended". huddleRemove returns becameEmpty ATOMICALLY, so two simultaneous
    // final leaves can't both log.
    const endHuddleLeg = async (cid: string, leaverId: string) => {
      const becameEmpty = await huddleStore.huddleRemove(cid, leaverId);
      await broadcastHuddle(cid);
      if (becameEmpty) {
        await postHuddleLog(cid, leaverId, "📞 Group call ended");
        // K3: anyone still ringing from a push (no socket) must be told the
        // call is over, or a terminated phone rings out and posts "Missed call".
        try {
          const rung = await huddleStore.huddleRungDrain(cid);
          for (const u of rung) void sendHuddleCancel(u, cid, "ended").catch(() => {});
        } catch (_) {}
      }
    };
    socket.on(
      EVENTS.HUDDLE_JOIN,
      async ({ conversationId, kind } = {} as any) => {
        if (!conversationId) return;
        if (!(await db.conversations.isMember(conversationId, uid))) return;
        const u = await db.users.getById(uid);
        // huddleAdd returns wasFirst ATOMICALLY → first person in started the call.
        const wasFirst = await huddleStore.huddleAdd(conversationId, uid, (u && u.name) || "Member", kind || "audio");
        socket.join(room(conversationId));
        joinedHuddles.add(conversationId);
        await broadcastHuddle(conversationId);
        // K3: answered here (desktop / another device) → stop the phone ring
        // that HUDDLE_RING pushed to this user.
        try {
          if (await huddleStore.huddleRungTake(conversationId, uid))
            void sendHuddleCancel(uid, conversationId, "ended").catch(() => {});
        } catch (_) {}
        if (wasFirst)
          await postHuddleLog(conversationId, uid, (kind === "video" ? "📹" : "📞") + " Group call started");
      },
    );
    socket.on(EVENTS.HUDDLE_LEAVE, async ({ conversationId } = {} as any) => {
      if (!conversationId) return;
      joinedHuddles.delete(conversationId);
      await endHuddleLeg(conversationId, uid);
    });
    socket.on(EVENTS.HUDDLE_SYNC, async ({ conversationId } = {} as any) => {
      if (!conversationId) return;
      if (!(await db.conversations.isMember(conversationId, uid))) return;
      const { kind, participants } = await huddleStore.huddleGet(conversationId);
      socket.emit(EVENTS.HUDDLE_STATE, { conversationId, kind, participants });
    });
    // Add people to a live group call. The caller (an active participant) has
    // already added the targets as conversation members over HTTP; here we (1)
    // re-broadcast so the freshly-added members receive HUDDLE_STATE and see the
    // joinable pill, and (2) ring each invitee so they get an active prompt.
    socket.on(
      EVENTS.HUDDLE_RING,
      async ({ conversationId, userIds } = {} as any) => {
        if (!conversationId || !Array.isArray(userIds) || !userIds.length)
          return;
        if (!(await huddleStore.huddleHas(conversationId, uid))) return; // only a participant can pull people in
        const { kind: huddleKind } = await huddleStore.huddleGet(conversationId);
        await broadcastHuddle(conversationId);
        const u = await db.users.getById(uid);
        const from = { id: uid, name: (u && u.name) || "Someone" };
        for (const target of userIds) {
          if (!target || target === uid) continue;
          if (!(await db.conversations.isMember(conversationId, target)))
            continue;
          io.to(userRoom(target)).emit(EVENTS.HUDDLE_RUNG, {
            conversationId,
            kind: huddleKind,
            from,
          });
          if (pushReady()) {
            // K3: remember who was rung so the ring can be retracted later.
            void huddleStore.huddleRungAdd(conversationId, [target]).catch(() => {});
            webPushToUser(target, {
              title: `${from.name} is calling`,
              body: "Group call — tap to join",
              tag: `colab-huddle-${conversationId}`,
              type: "call_incoming",
              conversationId,
              huddle: true,
              callKind: huddleKind || "audio",
              senderId: from.id,
              senderName: from.name,
            }).catch(() => {});
          }
        }
      },
    );

    // ---- Meeting interactions: hand raise, reactions, in-meeting chat ----
    const meetingRoom = (mid: string) => `meeting:${mid}`;
    // PER-MEETING OPTIONS (0116). Chat, reactions and hand-raise are socket
    // features, so the LiveKit grant cannot gate them — this does. Host and
    // co-host are never restricted by their own policy, matching the publish
    // rules in services/meetingPolicy. Fail-OPEN on a lookup error: a DB blip
    // must not silently gag a meeting.
    const meetingAllows = async (
      mid: string,
      who: string,
      key: "allowChat" | "allowReactions",
    ): Promise<boolean> => {
      try {
        const m = await db.meetings.getById(mid);
        if (!m) return true;
        if (m.createdBy === who) return true;
        const role = await db.meetings.getAttendeeRole(mid, who).catch(() => null);
        if (role === "co-host") return true;
        return meetingPolicy.optionsOf(m)[key];
      } catch {
        return true;
      }
    };

    // Broadcast hand state WITH resolved display names so clients never have to
    // show a raw user id as a fallback label.
    const emitHandState = async (mid: string) => {
      const ids = await huddleStore.handList(mid);
      const names: Record<string, string> = {};
      for (const id of ids) {
        const u = await db.users.getById(id);
        names[id] = (u && u.name) || "Participant";
      }
      io.to(meetingRoom(mid)).emit(EVENTS.MEETING_HAND_STATE, {
        meetingId: mid,
        hands: ids,
        names,
      });
    };
    // Explicit join — fixes the bug where listeners-only never received chat
    // because the room was joined lazily on hand-raise / reaction / send.
    socket.on(EVENTS.MEETING_JOIN, async ({ meetingId: mid } = {} as any) => {
      if (!mid || !(await canAccessMeeting(uid, mid))) return;
      // Duplicate-device detection (Session Mgmt Phase 3c): is THIS user already
      // present in the meeting on a DIFFERENT session (device)? If so, tell this
      // device so it can offer move / companion / cancel. Same-session tabs (same
      // jti) are NOT duplicates. Runs BEFORE the room join so the fetch can't see
      // this socket; the jti filter is belt-and-braces. Best-effort — a detection
      // hiccup must never block the join (which proceeds immediately below).
      if (jti) {
        try {
          const roomSockets = await io.in(meetingRoom(mid)).fetchSockets();
          const otherJtis = new Set<string>();
          for (const s of roomSockets) {
            const sd: any = (s as any).data || {};
            if (sd.userId === uid && sd.jti && sd.jti !== jti) otherJtis.add(sd.jti);
          }
          if (otherJtis.size > 0) {
            let devices: any[] = [];
            try {
              const rows = await db.sessions.listForUser(uid);
              devices = (rows || [])
                .filter((r: any) => otherJtis.has(r.id))
                .map((r: any) => ({
                  sessionId: r.id,
                  deviceLabel: r.deviceLabel || "another device",
                  platform: r.platform || "web",
                }));
            } catch (_) {}
            if (!devices.length)
              devices = Array.from(otherJtis).map((id) => ({
                sessionId: id,
                deviceLabel: "another device",
                platform: "web",
              }));
            socket.emit(EVENTS.MEETING_DUPLICATE, { meetingId: mid, devices });
          }
        } catch (e: any) {
          console.warn("[socket] meeting dup-detect failed mid=%s: %s", mid, e?.message);
        }
      }
      socket.join(meetingRoom(mid));
      // Replay recent persisted chat to the joiner only (so rejoin/late-join
      // sees history). Reuses MEETING_CHAT_NEW — no client change needed.
      try {
        const history = await db.meetingMessages.listRecent(mid, 100);
        for (const m of history) {
          const su = await db.users.getById(m.senderId);
          socket.emit(EVENTS.MEETING_CHAT_NEW, {
            meetingId: mid,
            senderId: m.senderId,
            senderName: (su && su.name) || "Someone",
            text: m.body || "",
            file: m.file || null,
            ts: new Date(m.createdAt).getTime(),
            id: m.id,
          });
        }
      } catch (e: any) {
        console.warn("[socket] meeting chat history load failed mid=%s: %s", mid, e?.message);
      }
    });
    // Meeting takeover (Phase 3c): "move here" from the duplicate-join prompt —
    // tell the user's OTHER sessions currently in this meeting to leave, so it
    // continues only on THIS device. Strictly same-user (we only ever signal the
    // caller's own sessions, matched by socket.data.userId === uid).
    socket.on(EVENTS.MEETING_TAKEOVER, async ({ meetingId: mid } = {} as any) => {
      if (!mid || !jti) return;
      try {
        const roomSockets = await io.in(meetingRoom(mid)).fetchSockets();
        const others = new Set<string>();
        for (const s of roomSockets) {
          const sd: any = (s as any).data || {};
          if (sd.userId === uid && sd.jti && sd.jti !== jti) others.add(sd.jti);
        }
        for (const oj of others)
          io.to(sessionRoom(oj)).emit(EVENTS.MEETING_LEAVE_NOW, { meetingId: mid, reason: "moved" });
      } catch (e: any) {
        console.warn("[socket] meeting takeover failed mid=%s: %s", mid, e?.message);
      }
    });
    socket.on(EVENTS.MEETING_HAND_RAISE, async ({ meetingId: mid } = {} as any) => {
      if (!mid || !(await canAccessMeeting(uid, mid))) return;
      // Raising a hand rides the reactions policy — the UI groups them, so
      // turning reactions off and leaving hands on would look like a bug.
      if (!(await meetingAllows(mid, uid, "allowReactions"))) return;
      socket.join(meetingRoom(mid));
      await huddleStore.handAdd(mid, uid);
      await emitHandState(mid);
    });
    socket.on(EVENTS.MEETING_HAND_LOWER, async ({ meetingId: mid, userId: target } = {} as any) => {
      if (!mid || !(await canAccessMeeting(uid, mid))) return;
      const who = target || uid;
      // Lowering YOUR OWN hand is always allowed. Lowering SOMEONE ELSE'S is a
      // moderation action, so it needs the same host/co-host gate the UI shows it
      // behind — membership alone isn't enough, or any participant could silently
      // lower another attendee's hand with a crafted emit.
      if (who !== uid && !(await isMeetingHostOrCoHost(uid, mid))) return;
      await huddleStore.handRemove(mid, who);
      await emitHandState(mid);
    });

    socket.on(EVENTS.MEETING_REACTION, async ({ meetingId: mid, emoji } = {} as any) => {
      if (!mid || !emoji || !(await canAccessMeeting(uid, mid))) return;
      if (!(await meetingAllows(mid, uid, "allowReactions"))) return;
      socket.join(meetingRoom(mid));
      const u = await db.users.getById(uid);
      io.to(meetingRoom(mid)).emit(EVENTS.MEETING_REACTION_BROADCAST, {
        meetingId: mid,
        userId: uid,
        name: u?.name || "Someone",
        emoji,
        ts: Date.now(),
      });
    });

    socket.on(EVENTS.MEETING_CHAT_SEND, async ({ meetingId: mid, text, file } = {} as any) => {
      // A message must carry text or a file, and the sender must be in the meeting.
      if (!mid || (!text && !file) || !(await canAccessMeeting(uid, mid))) return;
      if (!(await meetingAllows(mid, uid, "allowChat"))) return;
      socket.join(meetingRoom(mid));
      const u = await db.users.getById(uid);
      const safeFile = file && file.id
        ? { id: file.id, name: file.name || "file", mime: file.mime || file.type || "application/octet-stream", size: file.size || 0 }
        : null;
      // Persist for rejoin + audit trail. On DB failure, STILL broadcast (degrade
      // to ephemeral) so live meeting chat never regresses.
      let saved: any = null;
      try {
        saved = await db.meetingMessages.add({ meetingId: mid, senderId: uid, body: text || "", file: safeFile });
      } catch (e: any) {
        console.warn("[socket] meeting chat persist failed mid=%s: %s", mid, e?.message);
      }
      io.to(meetingRoom(mid)).emit(EVENTS.MEETING_CHAT_NEW, {
        meetingId: mid,
        senderId: uid,
        senderName: u?.name || "Someone",
        text: text || "",
        file: safeFile,
        ts: saved ? new Date(saved.createdAt).getTime() : Date.now(),
        id: saved ? saved.id : Math.random().toString(36).substring(2, 10),
      });
      // MCHAT-10: MIRROR EVERY in-meeting chat line — text and files — into the
      // meeting's persistent group LIVE, so the in-meeting panel and the Chat
      // list read as one thread while the meeting is still running (previously
      // only files mirrored and text waited for complete(), which never runs if
      // the host doesn't explicitly End the meeting). The group exists from
      // SCHEDULING time (ensureMeetingGroup, dmKey "call|m:<id>"); files are
      // adopted so every member can play/download them. The end-of-meeting
      // back-fill in complete() dedups by text+filename, so mirrored lines are
      // ported at most once.
      try {
        const convId = await db.conversations.findByDmKey("call|m:" + mid);
        if (convId) {
          if (safeFile) {
            try {
              if ((db.files as any).adoptIntoConversation)
                await (db.files as any).adoptIntoConversation(safeFile.id, convId);
            } catch (_) {}
          }
          const m2 = await send({
            conversationId: convId,
            senderId: uid,
            text: text || "",
            file: safeFile,
          });
          if (m2) io.to(room(convId)).emit(EVENTS.MESSAGE_NEW, m2);
        }
      } catch (e: any) {
        console.warn("[socket] meeting chat → group mirror failed mid=%s: %s", mid, e?.message);
      }
    });

    // ── Whiteboard persistence ────────────────────────────────────────────────
    // Live collaboration flows over the LiveKit data channel; this is the DURABLE
    // snapshot so a board survives all-leave / reconnect / re-open. board_key is
    // "call:<id>" or "meeting:<id>". Every read/write is gated on membership of
    // the underlying call/meeting (canAccessBoard) so a former/non-participant who
    // knows the id can't exfiltrate or overwrite the board. Saves are throttled
    // (allowWbSave). Debounced last-writer-wins upsert.
    const WB_KEY_RE = /^(call|meeting):[A-Za-z0-9._:-]{1,180}$/;
    socket.on("wb:save", async ({ boardKey, data } = {} as any) => {
      if (typeof boardKey !== "string" || !WB_KEY_RE.test(boardKey)) return;
      if (!allowWbSave(uid)) return; // clamp write-amplification floods
      let json = "";
      try {
        json = JSON.stringify(data == null ? {} : data);
      } catch {
        return;
      }
      if (json.length > 6_000_000) return; // ~6MB cap, well under MEDIUMTEXT
      if (!(await canAccessBoard(uid, boardKey))) return; // authz
      if (!(await canWriteBoard(uid, boardKey))) return; // switched off / blocked
      try {
        await db.whiteboards.save(boardKey, data, uid);
      } catch (e: any) {
        console.warn("[socket] wb save failed key=%s: %s", boardKey, e?.message);
      }
    });
    socket.on("wb:load", async ({ boardKey } = {} as any, ack?: any) => {
      const cb = typeof ack === "function" ? ack : null;
      if (typeof boardKey !== "string" || !WB_KEY_RE.test(boardKey)) {
        cb && cb(null);
        return;
      }
      if (!(await canAccessBoard(uid, boardKey))) {
        cb && cb(null); // non-participant: deny (no board contents leaked)
        return;
      }
      let data: any = null;
      try {
        data = await db.whiteboards.get(boardKey);
      } catch (e: any) {
        console.warn("[socket] wb load failed key=%s: %s", boardKey, e?.message);
      }
      if (cb) cb(data);
      else socket.emit("wb:state", { boardKey, data });
    });

    // Presence + ready are announced now that every listener above is attached.
    void (async () => {
      await db.users.setPresence(uid, shared.PRESENCE.ONLINE);
      await emitPresence(shared.PRESENCE.ONLINE);
      socket.emit(EVENTS.READY, { userId: uid });
    })();

    // Clean up ONLY the huddles this socket actually joined (tracked in
    // joinedHuddles). We can no longer infer them from socket.rooms: join-all now
    // subscribes every socket to every conversation room, so socket.rooms would
    // make a second/idle session's disconnect evict the user from a call they
    // joined on a DIFFERENT socket (and possibly post a bogus "Group call ended").
    // Runs on "disconnecting" (not "disconnect"): removing on an ungraceful drop
    // (closed tab / network loss) prevents ghost participants. (A huddle joined
    // from another replica's socket is cleaned by that replica; the 12h Redis TTL
    // is a backstop.) huddleHas is still checked so an already-left leg is a no-op.
    socket.on("disconnecting", async () => {
      try {
        for (const cid of joinedHuddles) {
          if (await huddleStore.huddleHas(cid, uid)) {
            await endHuddleLeg(cid, uid);
          }
        }
      } catch (e: any) {
        console.warn("[socket] disconnecting huddle cleanup failed uid=%s: %s", uid, e?.message);
      }
    });

    socket.on("disconnect", async () => {
      // Is this the user's LAST live socket? Multi-tab / window / device share the
      // user room; at "disconnect" this socket has already left, so fetchSockets
      // returns only the OTHERS. Fail toward "last socket" on an adapter error so we
      // never leave a ghost call/presence.
      let stillOnline = false;
      try {
        const remaining = await io.in(userRoom(uid)).fetchSockets();
        stillOnline = (remaining || []).some((s: any) => s.id !== socket.id);
      } catch (_) {
        stillOnline = false;
      }
      // AUDIT P1: only tear down 1:1 calls when this was the user's LAST socket. The
      // old code hung up EVERY active call on ANY socket disconnect, so closing an
      // unrelated second tab — or a Device-Handoff "Move" that closes the source
      // device — ended a call held on a DIFFERENT socket for BOTH parties. Gating on
      // !stillOnline mirrors the presence dedup below and the per-socket huddle
      // cleanup above. A graceful end still fires CALL_HANGUP explicitly.
      // STALE-SOCKET GUARD (mobile handoff, Oct 2026). A socket from a KILLED
      // app process is only noticed at the ping timeout, by which time the user
      // may have a NEW live socket and an answered call ("I answered and the
      // call ended", reproduced 21 Oct). The adapter may also have missed that
      // new socket (another node / a Redis blip). So before touching any call:
      // wait a short grace, then re-check (a) a live socket anywhere in the
      // cluster and (b) for a connected call, presence in its SFU room. Only a
      // user who is provably gone on both counts loses the call. An adapter
      // error no longer fails toward "hang up": it skips and logs.
      if (!stillOnline) try {
        if (DISCONNECT_GRACE_MS > 0) await new Promise((r) => setTimeout(r, DISCONNECT_GRACE_MS));
        let liveNow = false;
        let adapterOk = true;
        try {
          const again = await io.in(userRoom(uid)).fetchSockets();
          liveNow = (again || []).some((s: any) => s.id !== socket.id);
        } catch (e: any) {
          adapterOk = false;
          console.warn("[socket] disconnect liveness re-check failed uid=%s — leaving calls alone: %s", uid, e?.message);
        }
        const activeCalls = liveNow || !adapterOk ? [] : await db.calls.listActiveForUser(uid);
        for (const c of activeCalls) {
          if (c.status === "connected") {
            // In the media room = on the call, whatever the socket layer thinks.
            const { reachable, userIds } = await listRoomUserIds("call_" + c.id);
            if (reachable && userIds.has(uid)) {
              console.log("[socket] disconnect: uid=%s still in call_%s room — not hanging up", uid, c.id);
              continue;
            }
          }
          if (c.status === "ringing") {
            clearCallTimer(c.id);
            const missed = await callService.markMissed(c.id);
            if (missed) {
              bothParties(missed).forEach((r) =>
                io.to(r).emit(EVENTS.CALL_MISSED, { call: missed }),
              );
              retractRing(missed.peerId, missed, "missed");
              notifyHistory(missed);
              await postCallLog(missed, "missed");
              // Activity notification for the recipient who missed the call.
              try {
                const caller = await db.users.getById(missed.initiatorId);
                const n = await notifService.notifyCallMissed({
                  userId: missed.peerId,
                  callerName: caller?.name || "Someone",
                  callId: missed.id,
                  conversationId: missed.conversationId,
                });
                // Same socket emit as before PLUS web/mobile push, so a missed call also
                // reaches a closed tab / closed app (it used to be live-socket only).
                if (n) pushNotif(io, n);
              } catch (_) {}
            }
          } else if (c.status === "connected") {
            const ended = await callService.hangup({
              callId: c.id,
              userId: uid,
              durationSec: 0,
            });
            bothParties(ended).forEach((r) =>
              io.to(r).emit(EVENTS.CALL_ENDED, { call: ended }),
            );
            notifyHistory(ended);
            await postCallLog(ended, "ended");
          }
        }
      } catch (e: any) {
        console.warn("[socket] disconnect call cleanup failed uid=%s: %s", uid, e?.message);
      }
      // Presence dedup (Session Mgmt Phase 3): only go OFFLINE when this was the
      // user's LAST live socket (stillOnline computed above), so closing one
      // tab/device doesn't flip presence for everyone while the user is still
      // connected elsewhere.
      if (!stillOnline) {
        await db.users.setPresence(uid, shared.PRESENCE.OFFLINE);
        await emitPresence(shared.PRESENCE.OFFLINE);
      }
    });
  });
  startHuddleReconciler(io);
  return io;
}

// ── Ghost-participant reconciler (group calls) ────────────────────────────────
// The huddle roster (who is "on the call" — drives the "Call in progress" banner)
// is maintained purely by clients telling the server HUDDLE_JOIN / HUDDLE_LEAVE, plus
// socket-drop cleanup. Any path where a participant leaves the MEDIA room without
// either of those — an app killed with a half-open socket, a leg the server seeded
// itself on a 1:1 → group upgrade (never tied to a socket), a crash, a host removing
// someone — left them in the roster forever, so the banner kept saying "Call in
// progress" after everyone had left. LiveKit is the ground truth for who is really
// connected, so periodically drop roster entries that have been absent from the media
// room for HUDDLE_GHOST_GRACE_MS. FAIL-SAFE: if the SFU doesn't answer we evict nobody.
const HUDDLE_RECONCILE_MS = 20_000;
const HUDDLE_GHOST_GRACE_MS = 60_000; // covers the gap between HUDDLE_JOIN and the media connect
const huddleMissingSince = new Map<string, number>(); // "cid|uid" → first sweep it was missing
let huddleReconcilerStarted = false;

function startHuddleReconciler(io: any) {
  if (huddleReconcilerStarted || process.env.HUDDLE_RECONCILER === "off") return;
  huddleReconcilerStarted = true;
  const sweep = async () => {
    try {
      const cids = await huddleStore.huddleActiveIds();
      const seen = new Set<string>();
      for (const cid of cids) {
        const { participants } = await huddleStore.huddleGet(cid);
        if (!participants.length) continue;
        const live = await listRoomUserIds("conv_" + cid);
        if (!live.reachable) continue; // unknown ≠ gone — never evict on an SFU outage
        let changed = false;
        let emptied = false;
        let lastLeaver: string | null = null;
        for (const p of participants) {
          const key = cid + "|" + p.id;
          if (live.userIds.has(p.id)) { huddleMissingSince.delete(key); continue; }
          seen.add(key);
          const since = huddleMissingSince.get(key);
          if (since == null) { huddleMissingSince.set(key, Date.now()); continue; }
          if (Date.now() - since < HUDDLE_GHOST_GRACE_MS) continue;
          huddleMissingSince.delete(key);
          console.warn("[huddle] evicting ghost participant uid=%s conv=%s (not in the media room)", p.id, cid);
          if (await huddleStore.huddleRemove(cid, p.id)) emptied = true;
          changed = true;
          lastLeaver = p.id;
        }
        if (!changed) continue;
        const { kind, participants: left } = await huddleStore.huddleGet(cid);
        const payload = { conversationId: cid, kind, participants: left };
        const members = await db.conversations.members(cid);
        for (const m of members) io.to(userRoom(m.userId)).emit(EVENTS.HUDDLE_STATE, payload);
        if (emptied && lastLeaver) {
          try {
            const m = await send({ conversationId: cid, senderId: lastLeaver, text: "📞 Group call ended", file: null, type: "call", bumpUnread: false });
            io.to(room(cid)).emit(EVENTS.MESSAGE_NEW, m);
          } catch (_) { /* logging only */ }
          try {
            const rung = await huddleStore.huddleRungDrain(cid);
            for (const u of rung) void sendHuddleCancel(u, cid, "ended").catch(() => {});
          } catch (_) {}
        }
      }
      // Forget bookkeeping for anyone no longer in a roster (left normally / huddle gone).
      for (const k of huddleMissingSince.keys()) if (!seen.has(k)) huddleMissingSince.delete(k);
    } catch (e: any) {
      console.warn("[huddle] reconcile sweep failed: %s", e?.message);
    }
  };
  const t = setInterval(() => { void sweep(); }, HUDDLE_RECONCILE_MS);
  if (typeof (t as any).unref === "function") (t as any).unref();
}

// ── Live session enforcement (Session Mgmt Phase 3) ─────────────────────────
// Force a specific signed-in session's live sockets off the realtime channel.
// Called when a session is revoked (self "sign out this device", "sign out other
// sessions", admin force-logout, or eviction at the device limit). REST access
// is already cut on the NEXT request by the #66 session-alive check; this closes
// the OTHER hole — a socket authenticated at CONNECT with a now-revoked session
// keeps its live channel open until it happens to reconnect. We emit
// SESSION_REVOKED (the client clears its token + returns to sign-in) and then
// close the socket(s) after a short flush delay so the event lands first — the
// client sees "signed out", not a bare reconnect loop. Best-effort throughout;
// a realtime hiccup must never fail the REST revoke that triggered it.
async function disconnectSession(io: any, jti: string, reason = "revoked") {
  forgetAuthVerdict(jti);
  if (!io || !jti) return;
  // Mobile push K4: the session is over for good — retire the push
  // registrations it made so the phone stops receiving pushes it can only
  // 401 on. (On logout the app has already DELETEd its own token; harmless.)
  void forgetDevicesForSession(jti);
  try {
    io.to(sessionRoom(jti)).emit(EVENTS.SESSION_REVOKED, { sessionId: jti, reason });
    const sockets = await io.in(sessionRoom(jti)).fetchSockets();
    for (const s of sockets) {
      setTimeout(() => {
        try {
          s.disconnect(true);
        } catch (_) {}
      }, 250);
    }
  } catch (e: any) {
    console.warn("[socket] disconnectSession failed jti=%s: %s", jti, e?.message);
  }
}

// Disconnect every one of a user's live sessions EXCEPT the kept one — the socket
// counterpart to db.sessions.revokeOthers ("sign out all other sessions"). Targets
// each session room individually so the CURRENT device (keepJti) is never cut.
async function disconnectOtherSessions(io: any, userId: string, keepJti: string) {
  if (!io || !userId) return;
  try {
    const rows = await db.sessions.listForUser(userId);
    for (const s of rows || []) {
      if (!s || !s.id || s.id === keepJti) continue;
      await disconnectSession(io, s.id, "revoked");
    }
  } catch (e: any) {
    console.warn("[socket] disconnectOtherSessions failed uid=%s: %s", userId, e?.message);
  }
}

// Does a session currently have a LIVE socket anywhere in the cluster? Used by
// the Phase 5 idle-GC sweep to spare a still-connected (e.g. in-call) session —
// a connected device isn't "abandoned". Cluster-aware via the Redis adapter.
async function sessionHasLiveSocket(io: any, jti: string): Promise<boolean> {
  if (!io || !jti) return false;
  try {
    const sockets = await io.in(sessionRoom(jti)).fetchSockets();
    return (sockets || []).length > 0;
  } catch (_) {
    // Fail toward "assume live". This is the ONLY guard sparing a REST-idle but
    // actively-connected (e.g. in-call) session from the idle GC, and an in-call
    // session generates no REST traffic to refresh last_active_at. Treating an
    // errored/unknown liveness check as "not live" would boot a live call on a
    // transient adapter blip; the cost of assuming-live is at most one extra GC
    // tick before a genuinely-idle session is reclaimed.
    return true;
  }
}

// TOTAL ACCESS CLEANUP on org removal: force the removed member's live sockets
// out of every org conversation room NOW — their membership rows are already
// purged, so reconnects and message fan-out no longer include them, but a
// socket that joined those rooms at connect time would otherwise keep
// streaming until it happened to drop. Also tells their devices membership
// ended; the client re-validates its session and pivots away. Best-effort
// throughout — a realtime hiccup must never fail the REST removal.
async function evictFromOrg(io: any, userId: string, orgId: string, conversationIds: string[] = []) {
  if (!io || !userId) return;
  try {
    io.to(userRoom(userId)).emit(EVENTS.ORG_MEMBERSHIP_REVOKED, { orgId });
    if (conversationIds.length)
      io.in(userRoom(userId)).socketsLeave(conversationIds.map(room));
  } catch (e: any) {
    console.warn("[socket] evictFromOrg failed uid=%s org=%s: %s", userId, orgId, e?.message);
  }
}

const broadcast = { room, userRoom };
export { attachRealtime, broadcast, disconnectSession, disconnectOtherSessions, sessionHasLiveSocket, evictFromOrg, getSocketCount };
