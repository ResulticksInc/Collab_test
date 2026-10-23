// Mobile push fan-out (Collab_mobile — Flutter, Android + iOS).
//
// Mirrors EVERY web-push send (webPushService.sendToUsers) to the recipient's
// registered mobile devices (push_devices, POST /api/push/devices) with the
// SAME logical payload, so the quiet-hours / notify-level / per-conversation
// mute gates the call sites already apply cover mobile for free. Per platform:
//
//   Android: FCM data-only, high priority. The app renders natively.
//   iOS:     FCM → APNs alert (+ data) for everything EXCEPT incoming calls,
//            which go to APNs directly as a VoIP push (PushKit → CallKit).
//            call_cancel retracts a ring the same way.
//
// This module never throws into a caller: pushes are best-effort by contract.
import { db } from "../platform";
import { config } from "../platform";
import * as fcm from "./fcmService";
import * as apns from "./apnsVoipService";
import { record as logError } from "./logService";

export type MobilePushPayload = {
  title: string;
  body?: string;
  tag?: string;
  type?: string;
  url?: string;
  conversationId?: string;
  targetType?: string;
  targetId?: string;
  // Optional enrichment the mobile app renders when present (web SW ignores).
  messageId?: string;
  senderId?: string;
  senderName?: string;
  senderAvatar?: string;
  conversationKind?: string; // dm | group | channel | self
  conversationTitle?: string;
  callKind?: string; // audio | video
  huddle?: boolean;
  reason?: string; // call_cancel: cancelled | declined | missed | ended | answered
  // K7: E2EE message pushes carry the recipient's envelope(s) as a JSON string
  // so the phone (which holds the keys) can show the real text from the shade;
  // the server never reads it. `encrypted` lets the app's click ledger tell the
  // cases apart. Dropped by fitDataMap when the FCM `data` map would exceed
  // its limit (the phone then shows the generic body).
  encrypted?: boolean;
  ciphertext?: string;
  // K7b: initials-on-colour disc for senders without a photo (group senders
  // aren't cached on the phone).
  senderInitials?: string;
  senderColor?: string;
  // Faster connect (Oct 2026): a call_incoming push carries the CALLEE's own
  // LiveKit room token + signalling URL so a killed-state phone can join the
  // moment it answers, without first round-tripping POST /api/calls/token.
  // Scoped to the callee's identity and that one room — exactly what the callee
  // could fetch with its bearer token. Shed before the cosmetic fields when the
  // message is over budget (the app then falls back to /token as before).
  livekitToken?: string;
  wsUrl?: string;
};

// K5: iOS icon badge — unread-conversation count for the recipient, resolved
// per user in sendToUsers for message-class pushes (a terminated app runs no
// code for a remote alert, so only the server can keep the badge honest).
export type MobilePushOptions = { badgeByUser?: Map<string, number>; exclude?: DeviceExclusion | null };

// FCM caps a message at 4096 bytes (APNs likewise); keep the `data` map well
// under it. The ciphertext is the only unbounded field, so it's the one we
// drop — everything else is short ids / names.
export const DATA_MAP_LIMIT_BYTES = 3500;
// FCM rejects the WHOLE message above 4096 bytes (INVALID_ARGUMENT "message is
// too big"), and for iOS it merges `data` into the APNs payload NEXT TO the
// apns.payload copy of the same fields — so the ciphertext counts twice there.
// Budget the serialised message as a whole, with headroom for FCM's own framing.
export const MESSAGE_LIMIT_BYTES = 3900;
export function dataMapBytes(data: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(data), "utf8");
}
export function messageBytes(message: Record<string, any>): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

// ── Payload hygiene ──────────────────────────────────────────────────────────
// Production, 7 Oct 2026: FCM answered `INVALID_ARGUMENT Message is too large.
// The maximum is 4K (4096 bytes)` for ordinary Android message pushes that
// carried NO ciphertext. The culprit is `senderAvatar`: a profile photo set in
// Settings is stored as an inline base64 `data:` URL (users.avatar_url is
// TEXT), i.e. tens of KB, and it rode along in every push. A push can only
// ever carry a short URL; the phone already receives initials + colour for
// the fallback disc. Web push (VAPID) has the same ~4 KB cap, so the strip
// happens here for BOTH legs (webPushService.sendToUsers calls it).
const AVATAR_URL_MAX = 512;
const TITLE_MAX = 120;
const BODY_MAX = 180;
export function sanitizePushPayload<T extends MobilePushPayload>(p: T): T {
  const out: any = { ...p };
  const av = typeof out.senderAvatar === "string" ? out.senderAvatar : "";
  if (av && (/^data:/i.test(av) || av.length > AVATAR_URL_MAX)) delete out.senderAvatar;
  for (const k of ["title", "senderName", "conversationTitle"] as const) {
    if (typeof out[k] === "string" && out[k].length > TITLE_MAX) out[k] = out[k].slice(0, TITLE_MAX - 1) + "…";
  }
  if (typeof out.body === "string" && out.body.length > BODY_MAX) out.body = out.body.slice(0, BODY_MAX - 1) + "…";
  return out as T;
}

// Fields a push can live without, in the order we give them up when the
// assembled message is still over the FCM limit after the ciphertext is gone.
const SHEDDABLE: Array<keyof MobilePushPayload> = ["ciphertext", "senderAvatar", "livekitToken", "wsUrl", "conversationTitle", "senderColor", "senderInitials", "body"];
/** K7 size guard: drop `ciphertext` when the map would blow the FCM limit. */
export function fitDataMap(data: Record<string, string>): Record<string, string> {
  if (data.ciphertext && dataMapBytes(data) > DATA_MAP_LIMIT_BYTES) {
    const { ciphertext: _drop, ...rest } = data;
    return rest;
  }
  return data;
}

type PushDevice = {
  id: string;
  userId: string;
  platform: string;
  token: string;
  voipToken?: string | null;
  deviceId?: string | null;
  sessionJti?: string | null;
};
/** A device to leave out of a fan-out: the one that just acted (answered). */
export type DeviceExclusion = { sessionJti?: string | null; deviceId?: string | null };
function isExcluded(d: PushDevice, ex?: DeviceExclusion | null): boolean {
  if (!ex) return false;
  if (ex.sessionJti && d.sessionJti && d.sessionJti === ex.sessionJti) return true;
  if (ex.deviceId && d.deviceId && d.deviceId === ex.deviceId) return true;
  return false;
}

// ── Ids shared with the app (Collab_mobile push_payload.dart) ────────────────
// FNV-1a 32-bit masked to a positive Java int — byte-for-byte the app's
// PushPayload.stableId, so an APNs collapse id equals the local-notification
// id the app uses to cancel/replace the same logical notification.
export function stableId(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash & 0x7fffffff;
}

const MESSAGE_TYPES = new Set(["message", "mention", "reply"]);
const CALL_TYPES = new Set(["call_incoming", "call_cancel"]);

function iosCategory(type: string | undefined): string {
  switch (type) {
    case "message": case "mention": case "reply":
      return "COLLAB_MESSAGE";
    case "call_incoming": case "call_missed":
      return "COLLAB_CALL";
    case "meeting_invite": case "meeting_started": case "meeting_reminder":
    case "meeting_updated": case "meeting_cancelled": case "meeting_declined":
      return "COLLAB_MEETING";
    default:
      return "COLLAB_GENERIC";
  }
}

/** Local-notification id the app will use for this payload (collapse target). */
export function notificationIdFor(p: MobilePushPayload): number {
  const tag = p.tag || `colab-${p.type || "generic"}-${p.targetId || stableId(`${p.title}|${p.body}|${p.conversationId}`)}`;
  // Messages collapse per conversation (native messaging-app behaviour).
  if (MESSAGE_TYPES.has(p.type || "") && p.conversationId) return stableId(`conv:${p.conversationId}`);
  return stableId(tag);
}

/** FCM `data` must be flat string→string. Drops undefined/null. */
export function toDataMap(p: MobilePushPayload): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

const isCall = (p: MobilePushPayload) => CALL_TYPES.has(p.type || "");

/** Pure: the FCM v1 message for one device. Exported for tests. */
export function buildFcmMessage(
  device: PushDevice,
  raw: MobilePushPayload,
  nowSec = Math.floor(Date.now() / 1000),
  opts: { badge?: number } = {},
): Record<string, any> {
  const p = sanitizePushPayload(raw);
  const ttl = isCall(p) ? config.fcm.callTtlSec : config.fcm.messageTtlSec;
  const data = fitDataMap(toDataMap(p));
  // The iOS `payload` mirrors the (possibly trimmed) data map, not the raw
  // object, so both platforms see the same fields.
  const trimmed: MobilePushPayload = data.ciphertext || !p.ciphertext ? p : { ...p, ciphertext: undefined };
  const message: Record<string, any> = {
    token: device.token,
    data,
    android: {
      priority: "high",
      ttl: `${ttl}s`,
      // A re-sent ring/cancel for the same call replaces the earlier one.
      ...(p.tag && isCall(p) ? { collapse_key: p.tag.slice(0, 64) } : {}),
    },
  };
  if (device.platform === "ios") {
    const id = notificationIdFor(p);
    // apns.payload.payload below is a SECOND copy of every field (the plugin's
    // userInfo contract), so the serialised iOS message is roughly 2× the data
    // map. The 3.5 KB data budget alone therefore let a ~1.8 KB envelope push the
    // message past 4096 bytes. Checked on the assembled message at the end.
    const payloadJson = JSON.stringify(trimmed);
    const alert = p.type === "call_cancel";
    // K5: badge only on message-class alerts (the count is what unread chats
    // mean); calls/meetings leave the badge alone.
    const badge = MESSAGE_TYPES.has(p.type || "") && Number.isFinite(opts.badge as number) ? Math.max(0, Math.floor(opts.badge as number)) : undefined;
    message.apns = {
      headers: {
        "apns-priority": "10",
        "apns-push-type": alert ? "background" : "alert",
        "apns-expiration": String(nowSec + ttl),
        "apns-collapse-id": String(id),
      },
      payload: {
        aps: alert
          ? { "content-available": 1 }
          : {
              alert: { title: p.title, ...(p.body ? { body: p.body } : {}) },
              sound: "default",
              ...(badge !== undefined ? { badge } : {}),
              "thread-id": p.conversationId ? `conv-${p.conversationId}` : `collab-${p.type || "generic"}`,
              category: iosCategory(p.type),
              "mutable-content": 1,
              ...(p.type === "meeting_started" || p.type === "meeting_reminder" || p.type === "call_incoming"
                ? { "interruption-level": "time-sensitive" }
                : {}),
            },
        // flutter_local_notifications userInfo shape: the plugin then owns
        // taps/actions for this remote alert and hands Dart our `payload`.
        // present* are FALSE so a foreground arrival is NOT drawn by the OS —
        // the app's socket/local path already presents (with in-chat
        // suppression + dedup) while it is open.
        NotificationId: id,
        title: p.title,
        presentAlert: false,
        presentSound: false,
        presentBadge: false,
        presentBanner: false,
        presentList: false,
        payload: payloadJson,
      },
    };
  }
  // Whole-message guard (both platforms): still over the FCM limit? Shed the
  // least important field present and rebuild — ciphertext first (the phone
  // then shows the generic body), then the cosmetic enrichment, never the
  // title/ids the app routes on. Beats a 400 from FCM and no notification at
  // all. Terminates: each pass removes one field, and the final fallback below
  // can't recurse.
  if (messageBytes(message) > MESSAGE_LIMIT_BYTES || dataMapBytes(data) > DATA_MAP_LIMIT_BYTES) {
    const shed = SHEDDABLE.find((k) => p[k] !== undefined && p[k] !== null && (k !== "ciphertext" || data.ciphertext));
    if (shed) return buildFcmMessage(device, { ...p, [shed]: undefined }, nowSec, opts);
  }
  return message;
}

/** Pure: the APNs VoIP payload (AppDelegate.swift contract). Exported for tests. */
export function buildVoipPayload(p: MobilePushPayload): Record<string, any> {
  const callId = p.targetId || p.conversationId || p.tag || "";
  return {
    action: p.type === "call_cancel" ? "cancel" : "ring",
    callId,
    callerName: p.senderName || p.title.replace(/ is calling$/, ""),
    // K1: the accept bridge needs the caller's user id up front (a terminated
    // app has no `call:accepted` yet when CallKit answers).
    ...(p.senderId ? { callerId: p.senderId } : {}),
    ...(p.senderAvatar ? { callerAvatar: p.senderAvatar } : {}),
    ...(p.conversationId ? { conversationId: p.conversationId } : {}),
    kind: p.callKind === "video" ? "video" : "audio",
    huddle: !!p.huddle || !!(p.tag && p.tag.startsWith("colab-huddle-")),
    ...(p.reason ? { reason: p.reason } : {}),
    // Callee's room credentials (see MobilePushPayload.livekitToken).
    ...(p.livekitToken ? { livekitToken: p.livekitToken } : {}),
    ...(p.wsUrl ? { wsUrl: p.wsUrl } : {}),
  };
}

let initialised = false;
export function init() {
  initialised = true;
  const f = fcm.init();
  const a = apns.init();
  if (f || a) console.log("[mobile-push] enabled — fcm=%s apnsVoip=%s", f, a);
}

export function isReady(): boolean {
  if (!initialised) init();
  return fcm.isReady() || apns.isReady();
}

/** Which mobile legs can deliver. apnsVoip alone = ONLY iOS call rings. */
export function channels(): { fcm: boolean; apnsVoip: boolean } {
  if (!initialised) init();
  return { fcm: fcm.isReady(), apnsVoip: apns.isReady() };
}

// isReady() is true with APNs VoIP alone, so call sites still hand every
// message / mention / meeting push to deliver() — where it used to vanish
// without a trace when FCM was down. Say so, throttled (the boot log already
// has the detail; this is the "it is STILL happening" breadcrumb).
const FCM_DROP_WARN_EVERY_MS = 10 * 60 * 1000;
let fcmDropWarnedAt = 0;
function warnFcmDrop(dev: PushDevice, p: MobilePushPayload) {
  const now = Date.now();
  if (now - fcmDropWarnedAt < FCM_DROP_WARN_EVERY_MS) return;
  fcmDropWarnedAt = now;
  console.warn(
    "[mobile-push] FCM not configured — dropped %s push to user=%s platform=%s (and every other non-VoIP mobile push; only iOS call rings go out). %s",
    p.type || "generic", dev.userId, dev.platform, fcm.status().error || "",
  );
  logError({
    source: "backend",
    severity: "error",
    code: "PUSH_FCM_DROPPED",
    message: `[mobile-push] FCM not configured — mobile pushes are being dropped (only iOS call rings go out). ${fcm.status().error || ""}`,
    context: { type: p.type || null, platform: dev.platform, userId: dev.userId },
    userId: dev.userId,
  });
}

// A failed send is the signal the admin page must show for "phones get no
// notifications": `fetch failed` / `oauth token failed` = this host cannot
// reach googleapis.com; `404 UNREGISTERED` = stale device token; `400 … too
// big` = payload. Varying parts (user, token) go in context so the fingerprint
// stays stable and repeats aggregate into one row.
function recordSendFailure(leg: "fcm" | "apns", dev: PushDevice, p: MobilePushPayload, r: { status: number; error?: string; stale?: boolean }) {
  logError({
    source: "backend",
    severity: r.stale ? "warn" : "error",
    code: leg === "fcm" ? "PUSH_FCM_SEND_FAILED" : "PUSH_APNS_SEND_FAILED",
    message: `[mobile-push] ${leg} send failed (${dev.platform}, ${p.type || "generic"} push): ${r.error || "unknown error"}`,
    context: { type: p.type || null, platform: dev.platform, userId: dev.userId, status: r.status, stale: !!r.stale, conversationId: p.conversationId || null },
    userId: dev.userId,
  });
}

async function forgetToken(dev: PushDevice) {
  try { await db.pushDevices.removeByToken(dev.token); } catch (_) {}
}
async function forgetVoip(dev: PushDevice) {
  if (!dev.voipToken) return;
  try { await db.pushDevices.removeByVoipToken(dev.voipToken); } catch (_) {}
}

async function deliver(dev: PushDevice, p: MobilePushPayload, opts: MobilePushOptions = {}) {
  const call = isCall(p);
  // iOS calls: VoIP push when we can (CallKit ring even when terminated).
  if (dev.platform === "ios" && call && dev.voipToken && apns.isReady()) {
    const r = await apns.sendVoip(dev.voipToken, buildVoipPayload(p), { expirationSec: config.fcm.callTtlSec });
    if (r.stale) await forgetVoip(dev);
    if (!r.ok) {
      console.warn("[mobile-push] apns voip failed user=%s: %s", dev.userId, r.error);
      recordSendFailure("apns", dev, p, r);
    }
    // A cancel is only meaningful where the ring went; don't also alert via FCM.
    if (r.ok || p.type === "call_cancel") return;
  }
  if (!fcm.isReady()) { warnFcmDrop(dev, p); return; }
  // Without VoIP, an iOS "cancel" has nothing to retract.
  if (dev.platform === "ios" && p.type === "call_cancel") return;
  const badge = opts.badgeByUser?.get(dev.userId);
  const r = await fcm.send(buildFcmMessage(dev, p, undefined, { badge }));
  if (r.stale) await forgetToken(dev);
  if (!r.ok) {
    console.warn("[mobile-push] fcm failed user=%s platform=%s: %s", dev.userId, dev.platform, r.error);
    recordSendFailure("fcm", dev, p, r);
  }
}

/** Fan a payload out to every registered mobile device of these users. */
export async function sendToUsers(userIds: string[], payload: MobilePushPayload, sendOpts: { exclude?: DeviceExclusion | null } = {}): Promise<void> {
  if (!isReady() || !userIds.length || !payload || !payload.title) return;
  let devices: PushDevice[] = [];
  try {
    devices = await db.pushDevices.listForUsers(userIds);
  } catch (e: any) {
    console.warn("[mobile-push] device lookup failed:", e?.message);
    return;
  }
  if (sendOpts.exclude) devices = devices.filter((d) => !isExcluded(d, sendOpts.exclude));
  if (!devices.length) return;
  // K5: one unread-conversation lookup per iOS recipient of a message push.
  const opts: MobilePushOptions = {};
  if (MESSAGE_TYPES.has(payload.type || "") && devices.some((d) => d.platform === "ios")) {
    const badgeByUser = new Map<string, number>();
    const iosUsers = Array.from(new Set(devices.filter((d) => d.platform === "ios").map((d) => d.userId)));
    await Promise.allSettled(iosUsers.map(async (u) => {
      try {
        const n = await db.conversations.unreadConversationCount?.(u);
        if (Number.isFinite(n)) badgeByUser.set(u, Number(n));
      } catch (_) { /* badge is best-effort */ }
    }));
    opts.badgeByUser = badgeByUser;
  }
  await Promise.allSettled(devices.map((d) => deliver(d, payload, opts)));
}

/**
 * K3: retract a GROUP-call (huddle) ring on a phone — the rung user answered
 * elsewhere, or the huddle ended before they picked up. Same tag as the ring
 * (`colab-huddle-<conversationId>`) so the app collapses it; on iOS it goes out
 * as a VoIP `cancel` like a 1:1 retraction.
 */
export async function sendHuddleCancel(userId: string, conversationId: string, reason: "ended" | "declined" = "ended") {
  if (!userId || !conversationId) return;
  return sendToUsers([userId], {
    title: "Call ended",
    tag: `colab-huddle-${conversationId}`,
    type: "call_cancel",
    conversationId,
    huddle: true,
    reason,
  });
}

/**
 * K4: a session ended server-side (revoke / evict / idle GC / logout / account
 * delete) — retire the push registrations that session made so the phone
 * stops receiving pushes it can no longer act on. Best-effort.
 */
export async function forgetDevicesForSession(jti: string): Promise<number> {
  if (!jti) return 0;
  try {
    const n = await db.pushDevices.removeBySession?.(jti);
    return Number(n) || 0;
  } catch (e: any) {
    console.warn("[mobile-push] device cleanup failed jti=%s: %s", jti, e?.message);
    return 0;
  }
}

/**
 * Retract a ring on the recipient's phones: the caller hung up / cancelled,
 * the call was answered-or-declined elsewhere, or it timed out to missed.
 * Mobile-only by design — the web service worker has no notion of it.
 */
export async function sendCallCancel(
  userId: string,
  call: { id: string; conversationId?: string | null },
  reason: "cancelled" | "declined" | "missed" | "ended" | "answered",
  // The device that ANSWERED must not get the "answered" retraction: on 21 Oct
  // 2026 that push landed 270 ms after call:accepted and the app retracted the
  // CallKit entry of the very call in progress, ending it 650 ms after answer.
  // The other devices still get it — that is what stops them ringing.
  exclude: DeviceExclusion | null = null,
) {
  if (!userId || !call || !call.id) return;
  return sendToUsers([userId], {
    title: "Call ended",
    tag: `colab-call-${call.id}`,
    type: "call_cancel",
    conversationId: call.conversationId || undefined,
    targetType: "call",
    targetId: call.id,
    reason,
  }, { exclude });
}
