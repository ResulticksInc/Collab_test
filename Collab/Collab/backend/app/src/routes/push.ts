import { asyncRouter } from "../asyncRouter";
import { ok, fail, db } from "../platform";
import authMiddleware from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import * as webPush from "../services/webPushService";
import * as mobilePush from "../services/mobilePushService";
import * as telemetry from "../services/telemetryService";

const router = asyncRouter();
router.use(authMiddleware);

router.get("/vapid-key", (req, res) => {
  const key = webPush.getPublicKey();
  // Push being unconfigured is a NORMAL, gracefully-handled state — NOT a server
  // error. Returning 503 made every client log it as a red SERVER error and trip
  // the "Connection issue" diagnostics pill on each boot. Return 200 with a null
  // key + configured:false so the client silently disables push (see
  // pushRegistration.ts: empty key → latched-unavailable, no retry, no banner).
  if (!key) return res.json(ok({ publicKey: null, configured: false }));
  res.json(ok({ publicKey: key, configured: true }));
});

router.post("/subscribe", async (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json(fail("BAD_REQUEST", "A valid push subscription is required."));
  }
  const id = await webPush.subscribe(
    req.user.userId,
    subscription,
    req.headers["user-agent"],
  );
  res.json(ok({ id, subscribed: true }));
});

router.post("/unsubscribe", async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json(fail("BAD_REQUEST", "endpoint is required."));
  await webPush.unsubscribe(endpoint);
  res.json(ok({ unsubscribed: true }));
});

// ── Mobile devices (Collab_mobile — FCM / APNs) ─────────────────────────────
// The Flutter app registers its FCM token (and, on iOS, the PushKit VoIP
// token) after login and on every token refresh; it DELETEs on sign-out so a
// shared phone never rings for the previous account. Idempotent: the token is
// the row identity, so re-posting just refreshes ownership + last_seen.
const PLATFORMS = new Set(["android", "ios"]);
const clip = (v: unknown, max: number) => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

router.post("/devices", async (req, res) => {
  const b = req.body || {};
  const platform = String(b.platform || "").toLowerCase();
  const token = clip(b.token, 512);
  if (!PLATFORMS.has(platform)) {
    return res.status(400).json(fail("BAD_REQUEST", "platform must be 'android' or 'ios'."));
  }
  if (!token) return res.status(400).json(fail("BAD_REQUEST", "token (FCM registration token) is required."));
  // `voipToken` absent → keep whatever we hold; explicit null/"" → clear it.
  const voipToken = b.voipToken === undefined ? undefined : clip(b.voipToken, 255);
  // K4: remember which auth session registered this device, so a server-side
  // session end (revoke / evict / idle GC / account delete) retires the row and
  // the phone stops getting pushes it can't act on. A jti-less (legacy) token
  // leaves any existing binding alone.
  const sessionJti = typeof req.user.jti === "string" && req.user.jti ? String(req.user.jti).slice(0, 64) : undefined;
  const id = await db.pushDevices.upsert(
    req.user.userId,
    { platform, token, voipToken, deviceId: clip(b.deviceId, 128), appVersion: clip(b.appVersion, 32), sessionJti },
    clip(req.headers["user-agent"], 500) || undefined,
  );
  res.json(ok({
    id,
    registered: true,
    // Lets the app log at startup whether terminated-state delivery can work.
    channels: { fcm: mobilePush.isReady(), voip: platform === "ios" && !!voipToken },
  }));
});

router.delete("/devices", async (req, res) => {
  const token = clip((req.body || {}).token, 512) || clip(req.query.token, 512);
  if (!token) return res.status(400).json(fail("BAD_REQUEST", "token is required."));
  await db.pushDevices.removeByToken(token);
  res.json(ok({ unregistered: true }));
});

router.get("/devices", async (req, res) => {
  const rows = await db.pushDevices.listForUser(req.user.userId);
  // Never echo full tokens back — a token is a capability to push to the device.
  res.json(ok(rows.map((d: any) => ({
    id: d.id, platform: d.platform, deviceId: d.deviceId, appVersion: d.appVersion,
    tokenHint: String(d.token).slice(-8), voip: !!d.voipToken, lastSeenAt: d.lastSeenAt, createdAt: d.createdAt,
  }))));
});

// ── Notification click ledger ───────────────────────────────────────────────
// POST /api/push/events { events: [{ eventId, kind: "click", … }] }
// The app queues taps on disk and flushes them in batches with retries, so
// this must be IDEMPOTENT (event_id UNIQUE → a replay is a no-op) and must
// never 500 for a malformed item (one bad event can't poison the batch).
// Content-free by construction: ids and types only, sizes capped.
const MAX_EVENTS = 50;
const eventsLimiter = rateLimit({
  windowMs: Number(process.env.PUSH_EVENTS_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.PUSH_EVENTS_RATE_MAX) || 120,
  message: "Too many push events. Slow down.",
});
const SOURCES = new Set(["fcm", "local", "callkit", "voip"]);
const APP_STATES = new Set(["foreground", "background", "terminated"]);
const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;

export function normalizeClickEvent(raw: any) {
  if (!raw || typeof raw !== "object") return null;
  const eventId = clip(raw.eventId, 64);
  if (!eventId) return null;
  const kind = String(raw.kind || "click");
  if (kind !== "click") return null;
  const src = String(raw.source || "").toLowerCase();
  const state = String(raw.appState || "").toLowerCase();
  const type = clip(raw.notificationType ?? raw.type, 48);
  let clickedAt: string | null = null;
  const t = Date.parse(String(raw.clickedAt || ""));
  if (Number.isFinite(t)) clickedAt = new Date(t).toISOString().slice(0, 23).replace("T", " ");
  return {
    eventId,
    platform: PLATFORMS.has(String(raw.platform || "").toLowerCase()) ? String(raw.platform).toLowerCase() : null,
    source: SOURCES.has(src) ? src : null,
    appState: APP_STATES.has(state) ? state : null,
    action: clip(raw.action, 32),
    notificationType: type && NAME_RE.test(type) ? type : null,
    tag: clip(raw.tag, 160),
    conversationId: clip(raw.conversationId, 36),
    targetType: clip(raw.targetType, 32),
    targetId: clip(raw.targetId, 64),
    clickedAt,
  };
}

router.post("/events", eventsLimiter, async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.events) ? body.events : Array.isArray(body) ? body : [body];
  if (items.length > MAX_EVENTS)
    return res.status(413).json(fail("PAYLOAD_TOO_LARGE", `At most ${MAX_EVENTS} events per request.`));
  let stored = 0;
  let duplicates = 0;
  const counters: string[] = [];
  for (const raw of items) {
    try {
      const ev = normalizeClickEvent(raw);
      if (!ev) continue;
      const inserted = await db.pushClickEvents.record(req.user.userId, ev);
      if (inserted) {
        stored++;
        // Aggregated §9.2 counter alongside the per-user row: "how often are
        // pushes actually opened, per type" without joining the ledger.
        counters.push(`push.click.${ev.notificationType || "unknown"}`);
      } else {
        duplicates++;
      }
    } catch (e: any) {
      console.warn("[push-events] record failed:", e?.message);
    }
  }
  if (counters.length) telemetry.recordEvents(counters).catch(() => {});
  res.json(ok({ stored, duplicates }));
});

router.get("/events", async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  res.json(ok(await db.pushClickEvents.listForUser(req.user.userId, limit)));
});

export default router;
