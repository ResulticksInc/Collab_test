import webpush from "web-push";
import { config, db } from "../platform";
import * as mobilePush from "./mobilePushService";

let ready = false;

function init() {
  // Mobile (FCM / APNs) fan-out shares this entry point so every existing
  // sendToUser(s) call site reaches phones with zero changes.
  mobilePush.init();
  const { publicKey, privateKey, subject } = config.vapid;
  if (!publicKey || !privateKey) {
    console.warn("[web-push] VAPID keys not configured — push notifications disabled. Generate with: npx web-push generate-vapid-keys");
    return;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  ready = true;
  console.log("[web-push] VAPID configured — push notifications enabled");
}

async function subscribe(userId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string) {
  return db.pushSubscriptions.upsert(userId, {
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
  }, userAgent);
}

async function unsubscribe(endpoint: string) {
  return db.pushSubscriptions.removeByEndpoint(endpoint);
}

async function unsubscribeAll(userId: string) {
  return db.pushSubscriptions.removeForUser(userId);
}

// Payload shape shared by web push (service worker) and mobile push. The
// mobile-only enrichment fields are optional and ignored by the web client.
type PushPayload = mobilePush.MobilePushPayload;

async function sendToUser(userId: string, payload: PushPayload) {
  if (!userId) return;
  return sendToUsers([userId], payload);
}

/**
 * One call, every channel: browser subscriptions (VAPID) AND registered mobile
 * devices (FCM / APNs VoIP). Each leg is independent and best-effort — a
 * failure on one never blocks or fails the other.
 */
async function sendToUsers(userIds: string[], rawPayload: PushPayload) {
  if (!userIds.length) return;
  // Strip what no push channel can carry (inline data: avatars, over-long
  // titles) BEFORE either leg — browser push and FCM both cap at ~4 KB.
  const payload = mobilePush.sanitizePushPayload(rawPayload);
  const legs: Promise<unknown>[] = [];
  if (ready) legs.push(sendWebToUsers(userIds, payload).catch(() => {}));
  if (mobilePush.isReady()) legs.push(mobilePush.sendToUsers(userIds, payload).catch(() => {}));
  if (legs.length) await Promise.allSettled(legs);
}

async function sendWebToUsers(userIds: string[], payload: PushPayload) {
  if (!ready || !userIds.length) return;
  const subs = await db.pushSubscriptions.listForUsers(userIds);
  if (!subs.length) return;

  // The browser service worker never decrypts (K7 `ciphertext` is for the
  // phone's handlers) and web push has its own ~4 KB payload cap, so strip the
  // envelope blob from the browser leg — everything else rides as before.
  // The callee's LiveKit token (call_incoming) is likewise phone-only: the web
  // client fetches its own via POST /token, so don't park a credential in a
  // browser notification payload.
  const { ciphertext: _mobileOnly, livekitToken: _phoneOnly, wsUrl: _phoneOnly2, ...webPayload } = payload as any;
  const data = JSON.stringify(webPayload);
  const stale: string[] = [];

  await Promise.allSettled(
    subs.map(async (sub: any) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          data,
          { TTL: 60 * 60 },
        );
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          stale.push(sub.endpoint);
        }
      }
    }),
  );

  for (const ep of stale) {
    try { await db.pushSubscriptions.removeByEndpoint(ep); } catch (_) {}
  }
}

// "Some push channel can deliver" — the call sites gate their (fire-and-forget)
// push work on this, so it must include mobile or phones would never be pushed
// on a deployment without VAPID keys.
function isReady() { return ready || mobilePush.isReady(); }
function getPublicKey() { return config.vapid.publicKey; }
/** Per-leg readiness: browser (VAPID), FCM (Android + iOS alerts), APNs VoIP (iOS rings). */
function channels(): { webPush: boolean; fcm: boolean; apnsVoip: boolean } {
  return { webPush: ready, ...mobilePush.channels() };
}

// Browser-only leg, for the rare payload that must NOT also fan out to phones
// (the phone leg is sent separately with its own platform routing — e.g. the
// call-ring retraction, which on iOS goes out as an APNs VoIP push).
export { init, subscribe, unsubscribe, unsubscribeAll, sendToUser, sendToUsers, sendWebToUsers, isReady, getPublicKey, channels };
