import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { config, ok, db } from "../platform";
import { pingBucket } from "../services/storageService";
import { ping as pingDisk } from "../services/diskStorageService";
import { tierOrder } from "../services/fileService";
import { getSocketCount } from "../realtime/socket";
import { channels as pushChannels } from "../services/webPushService";
import { status as fcmStatus } from "../services/fcmService";
import jwt from "jsonwebtoken";

// Lightweight LIVENESS check — unchanged. Load-balancers / "is the process up?"
// probes hit this; it must stay cheap and never touch a dependency.
router.get("/", (req, res) =>
  res.json(
    ok({
      status: "ok",
      env: config.env,
      demoMode: config.features.demoMode,
      dbDriver: db.driver,
    }),
  ),
);

// Run a check with a hard timeout so the readiness endpoint itself can NEVER hang
// on a wedged dependency. Returns { ok, ms, error? } — never throws.
async function timed(
  fn: () => Promise<unknown>,
  timeoutMs = 2500,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
    return { ok: true, ms: Date.now() - start };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - start, error: String(e?.message || e).slice(0, 200) };
  }
}

// Redis is only a dependency when REDIS_URL is configured. We open a short-lived,
// fail-fast client (mirrors huddleStore/tokenBlocklist) and PING it. When Redis
// isn't configured the app runs fine on in-process fallbacks, so it is reported
// as a NON-critical "skipped" check, not a failure.
async function pingRedis(): Promise<void> {
  if (!config.redis?.url) return; // not configured → nothing to probe
  const redis = await import("redis");
  const client = redis.createClient({
    url: config.redis.url,
    socket: { reconnectStrategy: false, connectTimeout: 2000 },
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.ping();
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
  }
}

// GET /health/ready — READINESS probe for uptime monitoring (cron / Uptime-Kuma).
// Probes each dependency with a short timeout and returns
//   { ok, checks: { db, redis, minio, disk, livekit } }
// 200 when all CRITICAL checks pass, 503 when a critical one is down. db + minio
// are critical (no DB = no app; no object storage = no attachments). redis is
// non-critical (in-process fallbacks). livekit is a cheap CONFIG-presence check
// only — we never make an expensive media-plane call here.
router.get("/ready", async (req, res) => {
  let diskInfo: any = null;
  const [dbCheck, redisCheck, minioCheck, diskCheck] = await Promise.all([
    timed(() => db.pool.query("SELECT 1")),
    timed(() => pingRedis()),
    timed(() => pingBucket()),
    timed(async () => {
      diskInfo = await pingDisk();
    }),
  ]);

  // LiveKit: config presence only (cheap, no network call). Production already
  // boot-guards that the URL isn't blank/localhost, so a configured, non-local
  // wsUrl is the readiness signal here.
  const lkUrl = config.livekit.wsUrl || "";
  const lkConfigured =
    !!lkUrl && !lkUrl.includes("localhost") && !lkUrl.includes("127.0.0.1");
  const livekitCheck = {
    ok: lkConfigured,
    configured: lkConfigured,
    // In dev the default URL is ws://localhost — report it honestly but it is
    // NON-critical to readiness (calls just won't reach a remote SFU locally).
    error: lkConfigured ? undefined : "LIVEKIT_WS_URL is blank or localhost",
  };

  // Push delivery legs: config presence only (no network call). NON-critical —
  // chat, calls and meetings work without push — but surfaced because this
  // failure is otherwise invisible from outside: a host without
  // keys/fcm-service-account.json (gitignored → NOT in the deploy bundle) boots
  // fine, iOS calls still ring through APNs VoIP, and every message / mention /
  // meeting push to phones is dropped. `degraded` flags exactly that
  // "calls-only" state (FCM configured-but-unusable, or VoIP without FCM).
  const legs = pushChannels();
  const fcmSt = fcmStatus();
  const pushCheck = {
    ok: legs.webPush || legs.fcm || legs.apnsVoip,
    configured: legs,
    critical: false,
    degraded: !legs.fcm && (fcmSt.configured || legs.apnsVoip),
    ...(legs.fcm ? {} : { error: `fcm: ${fcmSt.error || "not configured"}` }),
  };

  const checks = {
    db: { ...dbCheck, critical: true },
    redis: {
      ...redisCheck,
      configured: !!config.redis?.url,
      critical: false,
    },
    // AUDIT P3 (#51): MinIO is NON-critical for readiness. A MinIO blip only breaks
    // file uploads/downloads — chat, calls, meetings and presence keep working — so
    // it must not 503 the whole backend (which, behind a load balancer, would
    // de-rotate the instance and take the product offline for a routine object-store
    // restart). Surfaced as a degraded sub-status so monitoring can still alert.
    minio: { ...minioCheck, critical: false, degraded: !minioCheck.ok },
    // Local file-storage tier (docs/FILE_UPLOAD_STORAGE_CHAIN.md). NON-critical
    // for the same reason as MinIO: a bad volume only moves uploads to the next
    // tier. freeBytes/usedPct are the capacity signals to alert on (80 % used,
    // and again when free < FILE_STORAGE_MIN_FREE_BYTES — overflow to MinIO).
    disk: {
      ...diskCheck,
      critical: false,
      degraded: !diskCheck.ok,
      tierOrder: tierOrder().join(","),
      ...(diskInfo || {}),
    },
    livekit: { ...livekitCheck, critical: false },
    push: pushCheck,
  };

  // Overall readiness = every CRITICAL check passing. DB is the sole hard dependency.
  const allCriticalOk = dbCheck.ok;
  res.status(allCriticalOk ? 200 : 503).json({
    ok: allCriticalOk,
    checks,
  });
});

// ── OBSERVABILITY: GET /health/metrics ───────────────────────────────────────
// Returns process and infrastructure performance signals for dashboards and
// ops tooling. Protected by ops-token (same as /api/ops/*) OR a dedicated
// METRICS_SECRET env var (for unauthenticated Prometheus scraping).
//
// Signals reported (zero new npm deps — all sourced from Node built-ins and
// the existing pool/socket objects):
//   eventLoopLagMs  — measured via setTimeout(0) delta; >10ms = pressure
//   memoryMb        — process.memoryUsage().rss in MB
//   heapUsedMb      — V8 heap in use
//   socketCount     — live Socket.IO connections
//   dbPoolSize      — configured pool.connectionLimit
//   uptimeSec       — process.uptime()
//   pid, nodeVersion, env
function measureEventLoopLag(): Promise<number> {
  const start = Date.now();
  return new Promise((resolve) => setImmediate(() => resolve(Date.now() - start)));
}
function isOpsAuthed(req: any): boolean {
  // Option A: ops portal token (same JWT scope used by /api/ops/* routes).
  const h = String(req.headers.authorization || "");
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : String(req.headers["x-ops-token"] || "");
  if (bearer) {
    try {
      const p: any = jwt.verify(bearer, config.auth.jwtSecret);
      if (p?.scope === "ops") return true;
    } catch { /* fall through to next check */ }
  }
  // Option B: static METRICS_SECRET for Prometheus scraping (unauthenticated path).
  const secret = process.env.METRICS_SECRET;
  if (secret) {
    const provided = String(req.headers["x-metrics-secret"] || req.query?.secret || "");
    try {
      const { timingSafeEqual } = require("crypto");
      const a = Buffer.from(secret), b = Buffer.from(provided);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch { /* ignore */ }
  }
  return false;
}
import { isLeader } from "../services/leaderElectionService";

router.get("/metrics", async (req: any, res) => {
  if (!isOpsAuthed(req))
    return res.status(401).json({ ok: false, error: "Ops token or METRICS_SECRET required." });
  const lag = await measureEventLoopLag();
  const mem = process.memoryUsage();
  const pool = (db as any).pool;
  const dbPoolSize = pool?.config?.connectionLimit ?? pool?.pool?.config?.connectionLimit ?? null;
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    eventLoopLagMs: lag,
    memoryMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    socketCount: getSocketCount(),
    dbPoolSize,
    isLeader: isLeader(),
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    nodeVersion: process.version,
    env: config.env,
  });
});

export default router;
