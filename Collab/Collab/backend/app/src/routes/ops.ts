// ─── Engineering Operations Portal — telemetry + intelligence API ────────────
// Powers the internal /dev "Mission Control" portal. Read-mostly (the only write
// is resolving an error). Real telemetry from the process, MySQL, Redis, LiveKit,
// the error ledger, the deployment ledger and (when mounted) the Docker engine —
// plus a rule-based intelligence layer that CORRELATES errors with deployments,
// ATTRIBUTES faults to a domain (infra / application / external / client) and
// REASONS about what to do. Every probe is wrapped so one failing source degrades
// gracefully instead of breaking the response.
//
// ACCESS: the portal has its OWN credential (OPS_PORTAL_PASSWORD), decoupled from
// the app session, so neither the public nor ordinary Collab users can reach
// infra internals. POST /auth exchanges the password for a short-lived ops token;
// every other route requires it.
import os from "os";
import http from "http";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { asyncRouter } from "../asyncRouter";
import { db, config } from "../platform";
import { listDeployments } from "../services/deploymentService";
import architecture from "../data/architecture";

const router = asyncRouter();
const startedAt = Date.now();
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();
let lastCpuPct = 0;

const num = (v: any) => (v == null ? 0 : Number(v) || 0);

// ── Credential gate ──────────────────────────────────────────────────────────
function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// GET /access-hint — PUBLIC. Tells the login screen whether the portal is enabled
// and prefills the username (harmless). The password is NEVER returned — it stays
// secret in the backend env (OPS_PORTAL_PASSWORD).
router.get("/access-hint", (_req, res) => {
  res.json({
    ok: true,
    enabled: !!String(config.ops?.portalPassword || ""),
    env: config.env,
    user: config.ops?.portalUser || "admin",
  });
});

// POST /auth — exchange username + password for a short-lived ops token. PUBLIC
// (you have no token yet). Rate-limited in app.ts. When no password is configured
// the portal is refused everywhere (secure default).
router.post("/auth", async (req: any, res) => {
  const configured = String(config.ops?.portalPassword || "");
  if (!configured) return res.status(503).json({ ok: false, error: "The engineering portal is disabled (no OPS_PORTAL_PASSWORD set)." });
  const wantUser = String(config.ops?.portalUser || "admin");
  const gotUser = String(req.body?.username || req.body?.name || "").trim();
  const gotPass = String(req.body?.password || "");
  const userOk = !wantUser || timingSafeEqual(gotUser.toLowerCase(), wantUser.toLowerCase());
  const passOk = !!gotPass && timingSafeEqual(gotPass, configured);
  if (!userOk || !passOk)
    return res.status(401).json({ ok: false, error: "Incorrect username or password." });
  const name = gotUser || wantUser || "engineer";
  const token = jwt.sign({ scope: "ops", name }, config.auth.jwtSecret, { expiresIn: config.ops?.sessionTtl || "12h" });
  return res.json({ ok: true, token, name });
});

// Gate: every route below requires a valid ops token.
router.use((req: any, res, next) => {
  const h = String(req.headers.authorization || "");
  const token = h.startsWith("Bearer ") ? h.slice(7) : String(req.headers["x-ops-token"] || "");
  if (!token) return res.status(401).json({ ok: false, error: "Portal sign-in required." });
  try {
    const p: any = jwt.verify(token, config.auth.jwtSecret);
    if (p?.scope !== "ops") return res.status(401).json({ ok: false, error: "Invalid portal token." });
    req.ops = p;
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: "Portal session expired. Please sign in again." });
  }
});

// ── Query helpers ────────────────────────────────────────────────────────────
async function q(sql: string, params: any[] = []): Promise<any[]> {
  try {
    const [rows] = await db.pool.query(sql, params);
    return (rows as any[]) || [];
  } catch {
    return [];
  }
}
async function one(sql: string, params: any[] = []): Promise<any> {
  const rows = await q(sql, params);
  return rows[0] || {};
}
async function timed(fn: () => Promise<any>) {
  const t = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - t };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t, error: String(e?.code || e?.message || "error").slice(0, 120) };
  }
}

// ═══ Production-safety governor ═══════════════════════════════════════════════
// The engineering portal runs on the SAME box as production Collab, so the Golden
// Rule is: engineering NEVER degrades Collab. Two mechanisms enforce it, and
// NEITHER touches a production code path — they only govern the ops routes' reads:
//
//   1) A cached read layer. Expensive probes (DB SHOW STATUS, information_schema,
//      the S3 object scan, LiveKit, Redis) run at most once per TTL and are SHARED
//      across every open portal tab — so N dashboards trigger ONE refresh, not N.
//      Everything else is served from memory in microseconds.
//   2) Load shedding. Before any HEAVY refresh we read live production pressure
//      (CPU, active meetings, DB latency, RSS). Under pressure we DON'T run the
//      work — we serve the last cached value (marked stale) or a degraded
//      placeholder. Production always wins; engineering data just goes stale and
//      catches up automatically when the server is healthy again.
//
// All thresholds + TTLs are env-configurable so ops can tighten them per server.
const OPS_GOV = {
  maxCpuPct: Number(process.env.OPS_MAX_CPU_PCT) || 80,
  maxMeetings: Number(process.env.OPS_MAX_MEETINGS) || 40,
  maxDbLatencyMs: Number(process.env.OPS_MAX_DB_LATENCY_MS) || 50,
  maxRssPct: Number(process.env.OPS_MAX_RSS_PCT) || 90,
  maxConcurrentHeavy: Number(process.env.OPS_MAX_CONCURRENT_HEAVY) || 2,
};
const OPS_TTL = {
  core: Number(process.env.OPS_TTL_CORE_MS) || 15000,
  errors: Number(process.env.OPS_TTL_ERRORS_MS) || 8000,
  storage: Number(process.env.OPS_TTL_STORAGE_MS) || 300000, // 5 min — the S3 scan is the heaviest probe
  baseline: Number(process.env.OPS_TTL_BASELINE_MS) || 60000,
};
// Last-known production signals, refreshed on each core snapshot so the pressure
// gauge can decide WITHOUT issuing its own queries.
let lastLiveMeetings = 0;
let lastDbPingMs = 0;
let lastRssPct = 0;

// Order in which engineering features shed under sustained pressure (spec):
// historical analytics first, large simulations last. Surfaced by /governor.
const OPS_DEGRADE_ORDER = ["historical-analytics", "ai-recommendations", "architecture-analysis", "cost-estimation", "digital-twin", "large-simulations"];
const OPS_LEVELS = ["normal", "elevated", "high", "critical"];

function productionPressure() {
  const cpu = lastCpuPct;
  const reasons: string[] = [];
  let level = 0;
  if (cpu >= OPS_GOV.maxCpuPct) { level = Math.max(level, 2); reasons.push(`CPU ${cpu.toFixed(0)}%`); }
  else if (cpu >= OPS_GOV.maxCpuPct * 0.75) level = Math.max(level, 1);
  if (lastLiveMeetings >= OPS_GOV.maxMeetings) { level = 3; reasons.push(`${lastLiveMeetings} active meetings`); }
  else if (lastLiveMeetings >= OPS_GOV.maxMeetings * 0.6) level = Math.max(level, 1);
  if (lastDbPingMs >= OPS_GOV.maxDbLatencyMs) { level = Math.max(level, 2); reasons.push(`DB ${lastDbPingMs}ms`); }
  if (lastRssPct >= OPS_GOV.maxRssPct) { level = Math.max(level, 2); reasons.push(`RSS ${lastRssPct}%`); }
  return { level, label: OPS_LEVELS[level], shedding: level >= 2, cpuPct: cpu, meetings: lastLiveMeetings, dbLatMs: lastDbPingMs, rssPct: lastRssPct, reason: reasons.join(" · ") || "healthy" };
}

type OpsCacheEntry = { at: number; value: any; refreshing: boolean };
const opsCache = new Map<string, OpsCacheEntry>();
let opsCacheHits = 0, opsCacheMiss = 0, opsSheds = 0, opsActiveHeavy = 0;

// Serve `key` from cache; refresh via `loader` only when stale AND (for heavy work)
// production is calm and we're under the concurrency cap. Returns the value plus
// meta so endpoints can tell the operator the data is cached/stale/degraded.
async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>, heavy = false): Promise<{ value: T | null; cached: boolean; stale: boolean; ageMs: number; degraded: boolean; reason?: string }> {
  const now = Date.now();
  const e = opsCache.get(key);
  if (e && now - e.at < ttlMs) { opsCacheHits++; return { value: e.value, cached: true, stale: false, ageMs: now - e.at, degraded: false }; }
  if (heavy) {
    const p = productionPressure();
    if (p.level >= 2) {
      opsSheds++;
      if (e) { opsCacheHits++; return { value: e.value, cached: true, stale: true, ageMs: now - e.at, degraded: true, reason: "production busy — " + p.reason }; }
      return { value: null, cached: false, stale: false, ageMs: 0, degraded: true, reason: "production busy — " + p.reason };
    }
    if (opsActiveHeavy >= OPS_GOV.maxConcurrentHeavy) {
      opsSheds++;
      if (e) { opsCacheHits++; return { value: e.value, cached: true, stale: true, ageMs: now - e.at, degraded: true, reason: "engineering concurrency cap" }; }
      return { value: null, cached: false, stale: false, ageMs: 0, degraded: true, reason: "engineering concurrency cap" };
    }
  }
  if (e && e.refreshing) { opsCacheHits++; return { value: e.value, cached: true, stale: true, ageMs: now - e.at, degraded: false }; } // single-flight
  opsCacheMiss++;
  const entry: OpsCacheEntry = e || { at: 0, value: null, refreshing: false };
  entry.refreshing = true;
  opsCache.set(key, entry);
  if (heavy) opsActiveHeavy++;
  try {
    const value = await loader();
    entry.value = value; entry.at = Date.now(); entry.refreshing = false;
    return { value, cached: false, stale: false, ageMs: 0, degraded: false };
  } catch (err) {
    entry.refreshing = false;
    if (entry.value != null) return { value: entry.value, cached: true, stale: true, ageMs: Date.now() - entry.at, degraded: true, reason: "refresh failed" };
    throw err;
  } finally {
    if (heavy) opsActiveHeavy--;
  }
}
function cacheMeta(r: { cached: boolean; stale: boolean; ageMs: number; degraded: boolean; reason?: string }) {
  return { cached: r.cached, stale: r.stale, ageMs: r.ageMs, degraded: r.degraded, reason: r.reason || null };
}
function kv(rows: any[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const r of rows) m[r.Variable_name] = r.Value;
  return m;
}
// SQL fragment for a named date range, applied to a given column.
function rangeSql(col: string, range: string): string {
  switch (range) {
    case "today":
      return `${col} >= CURDATE()`;
    case "yesterday":
      return `${col} >= CURDATE() - INTERVAL 1 DAY AND ${col} < CURDATE()`;
    case "7d":
      return `${col} >= NOW() - INTERVAL 7 DAY`;
    case "30d":
      return `${col} >= NOW() - INTERVAL 30 DAY`;
    default:
      return "1=1";
  }
}

// ── Fault attribution ────────────────────────────────────────────────────────
// The core of blame-free incident triage: which SIDE owns a given error?
const INFRA_RE = /econnrefused|etimedout|timed out|timeout|connection|pool|deadlock|too many connections|redis|socket hang up|econnreset|lock wait|enospc|enomem|out of memory|epipe|eai_again|enotfound/i;
const EXTERNAL_RE = /nosuchkey|specified key|s3|bucket|object storage|giphy|jwks|sso|idp|upstream|bad gateway|502|503|504|livekit|egress/i;
function classifyFault(e: any): { domain: string; reason: string } {
  const msg = String(e.message || "");
  const sev = String(e.severity || "error");
  const dep = String(e.dependency || "");
  const src = String(e.source || "");
  if (sev === "warn")
    return { domain: "client", reason: "A validation or permission rejection — the request was refused by design (invalid or unauthorized client input), not a fault." };
  if (dep === "infra" || INFRA_RE.test(msg))
    return { domain: "infrastructure", reason: "Matches an infrastructure failure signature (database / cache / network / host resource)." };
  if (dep === "external" || EXTERNAL_RE.test(msg))
    return { domain: "external", reason: "Originates in a third-party dependency or object storage — outside Collab application code." };
  if (src === "frontend")
    return { domain: "client", reason: "A client-side runtime error in the browser/desktop app." };
  return { domain: "application", reason: "A server-side error with no infrastructure or third-party signature — most likely application code." };
}
// Plain-English explanation + the responsible owner for an error, so a
// non-engineer can understand what actually happened and who owns the fix.
function explainError(e: { message?: string; category?: string; domain?: string; code?: string; level?: string; scope?: string }): { plain: string; owner: string } {
  const msg = String(e.message || "").toLowerCase();
  const cat = e.category || "";
  const dom = e.domain || "";
  const code = String(e.code || "").toLowerCase();
  if (cat === "e2ee") {
    const map: Record<string, string> = {
      "decrypt-failed": "A message couldn't be unscrambled on this person's device — usually an encryption key that didn't sync after they switched or reinstalled. They see a placeholder instead of the text.",
      "unencrypted-rejected": "A message arrived without encryption in a chat that requires it, so the app safely refused to show it (protection against tampering). The person sees “message rejected” instead of the text.",
      "unencrypted-rendered": "A message was delivered without end-to-end encryption in a chat that normally encrypts (a past send-path issue). The app now SHOWS the real content — flagged “Not Encrypted” — so nothing is hidden; this is tracked so we can confirm no new unencrypted messages are being produced.",
      "pending-key": "The device is still waiting for the encryption key to sync. The message shows as “waiting” and usually clears itself once sync finishes.",
      "stripped-envelope": "A message was marked encrypted but arrived with no encrypted content, so the app rejected it as a safety measure.",
      "signature-invalid": "A message failed its authenticity check, so the app refused to show it because it couldn't verify the sender.",
      "replayed": "The server re-sent an old message and the app rejected the duplicate.",
    };
    return { plain: map[code] || "An end-to-end-encryption step failed on this person's device, so a message couldn't display normally.", owner: "Collab app · encryption / device key-sync" };
  }
  if (code === "object_missing" || /no longer available|specified key|nosuchkey/.test(msg))
    return { plain: "A file was requested but its stored copy is gone, so the download shows “file unavailable”.", owner: "Infrastructure · file storage" };
  if (dom === "infrastructure")
    return { plain: "The platform couldn't reach one of its core services (database, cache or network) while handling this. It's a server-side / infrastructure problem, not the user's device.", owner: "Infrastructure / DevOps" };
  if (dom === "external")
    return { plain: "A third-party service Collab relies on (object storage, the video server, or an identity provider) returned an error. The cause is outside Collab's own code.", owner: "External vendor / third-party" };
  if (e.level === "warn")
    return { plain: "The app correctly refused an invalid or not-allowed action (a missing field, or something the person didn't have permission to do). This is expected behaviour, not a fault.", owner: "Client · expected validation" };
  if (e.scope === "client")
    return { plain: "Something went wrong inside the app running on this person's browser or desktop, which may have interrupted what they were doing.", owner: "Engineering · front-end code" };
  return { plain: "Collab's own server code hit an error while handling a request. Engineering should look at the endpoint shown.", owner: "Engineering · application code" };
}

const DOMAIN_META: Record<string, { label: string; blurb: string }> = {
  infrastructure: { label: "Infrastructure / Server", blurb: "Database, cache, network or host — the platform side." },
  application: { label: "Application / Code", blurb: "Collab's own backend/frontend code." },
  external: { label: "External / Third-party", blurb: "Object storage, LiveKit, IdP or another vendor." },
  client: { label: "Client / User", blurb: "Invalid input, permissions, or the user's device/network." },
};

// Parse a browser/OS/platform from the stored user-agent + client context. Lets
// the portal pinpoint an issue to a specific device without extra columns.
function parseDevice(ua: string | null, ctx: any): { browser: string; os: string; platform: string; app: string | null; deviceId: string | null } {
  const s = String(ua || "");
  let browser = "Unknown";
  if (/edg/i.test(s)) browser = "Edge";
  else if (/opr|opera/i.test(s)) browser = "Opera";
  else if (/chrome|crios/i.test(s)) browser = "Chrome";
  else if (/firefox|fxios/i.test(s)) browser = "Firefox";
  else if (/safari/i.test(s)) browser = "Safari";
  let os = "Unknown";
  if (/windows/i.test(s)) os = "Windows";
  else if (/mac os|macintosh/i.test(s)) os = "macOS";
  else if (/android/i.test(s)) os = "Android";
  else if (/iphone|ipad|ios/i.test(s)) os = "iOS";
  else if (/linux/i.test(s)) os = "Linux";
  const platform = (ctx && ctx.platform) || (/electron/i.test(s) ? "desktop" : "web");
  return { browser, os, platform, app: (ctx && ctx.app) || null, deviceId: (ctx && ctx.deviceId) || null };
}

// Business-impact priority. E2EE failures rank high — they break user trust and
// are exactly what surfaced as "[Unencrypted message — rejected]" to the CEO.
const PRIORITY_META = ["P0", "P1", "P2", "P3"];
function priorityOf(e: { level: string; domain: string; category: string; count: number; code?: string }): number {
  if (e.level === "fatal") return 0;
  if (e.category === "e2ee") {
    // "pending-key" is a self-healing WAITING state: the device is missing a key
    // it hasn't received yet, the client has ALREADY queued a history heal, and
    // the message resolves once sync finishes. It is NOT an encryption failure, so
    // it must not sit at P0 next to real breaches (replay, forged signature,
    // decrypt-failure, downgrade-rejection). Keep those at P0/P1; cap the transient.
    if (e.code === "pending-key") return e.count >= 50 ? 2 : 3;
    return e.count >= 10 ? 0 : 1;
  }
  if (e.level === "error") {
    if (e.domain === "infrastructure") return e.count >= 10 ? 0 : 1;
    if (e.domain === "application") return e.count >= 25 ? 1 : 2;
    return 2;
  }
  return 3; // warn / info
}
function safeJson(v: any): any {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

// ── Redis / LiveKit / Docker probes (best-effort) ────────────────────────────
// Cached so a portal poll doesn't open a fresh Redis connection every few seconds
// (which is itself production load). One refresh per core TTL, shared everywhere.
async function redisInfo(): Promise<any> {
  return (await cached("redisinfo", OPS_TTL.core, redisInfoRaw, false)).value;
}
async function redisInfoRaw(): Promise<any> {
  if (!config.redis?.url) return { configured: false };
  try {
    const redis = await import("redis");
    const client = redis.createClient({ url: config.redis.url });
    await client.connect();
    const raw = await client.info();
    await client.quit();
    const info: Record<string, string> = {};
    for (const line of String(raw).split("\n")) {
      const i = line.indexOf(":");
      if (i > 0 && !line.startsWith("#")) info[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return {
      configured: true,
      ok: true,
      version: info.redis_version,
      uptimeSec: num(info.uptime_in_seconds),
      clients: num(info.connected_clients),
      memoryBytes: num(info.used_memory),
      memoryHuman: info.used_memory_human,
      maxMemoryBytes: num(info.maxmemory),
      evictionPolicy: info.maxmemory_policy || null,
      hits: num(info.keyspace_hits),
      misses: num(info.keyspace_misses),
      opsPerSec: num(info.instantaneous_ops_per_sec),
      evictedKeys: num(info.evicted_keys),
    };
  } catch (e: any) {
    return { configured: true, ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}
async function livekitRooms(): Promise<any> {
  const src = config.livekit?.serverUrl || config.livekit?.wsUrl || "";
  if (!src || !config.livekit?.apiKey) return { configured: false };
  try {
    const sdk = await import("livekit-server-sdk");
    const host = src.replace(/^ws(s?):\/\//, "http$1://");
    const svc = new (sdk as any).RoomServiceClient(host, config.livekit.apiKey, config.livekit.apiSecret);
    const rooms = await svc.listRooms();
    return {
      configured: true,
      ok: true,
      rooms: (rooms || []).map((r: any) => ({
        name: r.name,
        participants: num(r.numParticipants),
        publishers: num(r.numPublishers),
        createdAt: num(r.creationTime) * 1000,
        bitrate: num(r.bitrate),
      })),
    };
  } catch (e: any) {
    return { configured: true, ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}
function dockerGet(path: string): Promise<any> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: "/var/run/docker.sock", path, method: "GET", timeout: 2500 } as any, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}
async function dockerContainers(): Promise<any> {
  const list = await dockerGet("/containers/json?all=1");
  if (!Array.isArray(list)) return { available: false };
  const containers = await Promise.all(
    list.map(async (c: any) => {
      const [stats, inspect] = await Promise.all([
        dockerGet(`/containers/${c.Id}/stats?stream=false`).catch(() => null),
        dockerGet(`/containers/${c.Id}/json`).catch(() => null),
      ]);
      let cpuPct = 0;
      let memBytes = 0;
      let memLimit = 0;
      if (stats && stats.cpu_stats && stats.precpu_stats) {
        const cd = num(stats.cpu_stats.cpu_usage?.total_usage) - num(stats.precpu_stats.cpu_usage?.total_usage);
        const sd = num(stats.cpu_stats.system_cpu_usage) - num(stats.precpu_stats.system_cpu_usage);
        const cores = num(stats.cpu_stats.online_cpus) || stats.cpu_stats.cpu_usage?.percpu_usage?.length || 1;
        if (sd > 0 && cd > 0) cpuPct = (cd / sd) * cores * 100;
        memBytes = num(stats.memory_stats?.usage);
        memLimit = num(stats.memory_stats?.limit);
      }
      const st = inspect?.State || {};
      return {
        id: String(c.Id).slice(0, 12),
        name: String((c.Names && c.Names[0]) || "").replace(/^\//, ""),
        image: c.Image,
        state: c.State,
        status: c.Status,
        health: st.Health?.Status || (/\(healthy\)/.test(c.Status) ? "healthy" : /\(unhealthy\)/.test(c.Status) ? "unhealthy" : c.State === "running" ? "running" : "stopped"),
        restartCount: num(inspect?.RestartCount),
        startedAt: st.StartedAt ? new Date(st.StartedAt).getTime() : num(c.Created) * 1000,
        oomKilled: !!st.OOMKilled,
        exitCode: num(st.ExitCode),
        ports: (c.Ports || []).filter((p: any) => p.PublicPort).map((p: any) => `${p.PublicPort}:${p.PrivatePort}`),
        createdAt: num(c.Created) * 1000,
        cpuPct: Math.round(cpuPct * 10) / 10,
        memBytes,
        memLimit,
        memPct: memLimit ? Math.round((memBytes / memLimit) * 1000) / 10 : 0,
      };
    }),
  );
  return { available: true, containers };
}

// Shared: pull the core live signals used by /snapshot AND /insights. Cached
// (see the wrapper below) so N portal tabs cost ONE refresh per TTL, not N.
async function gatherCoreRaw() {
  let diskInfo: any = null;
  const [dbPing, redisPing, storagePing, diskPing] = await Promise.all([
    timed(() => db.pool.query("SELECT 1")),
    timed(async () => {
      if (!config.redis?.url) throw new Error("not configured");
      const redis = await import("redis");
      const c = redis.createClient({ url: config.redis.url });
      await c.connect();
      await c.ping();
      await c.quit();
    }),
    timed(async () => {
      const { pingBucket } = await import("../services/storageService");
      await pingBucket();
    }),
    // Local file-storage tier (docs/FILE_UPLOAD_STORAGE_CHAIN.md): dir, free
    // space and usage so the portal can show capacity next to the MinIO probe.
    timed(async () => {
      const { ping } = await import("../services/diskStorageService");
      diskInfo = await ping();
    }),
  ]);
  const [status, vars, redis, livekit, tables, errRows, counts] = await Promise.all([
    q("SHOW GLOBAL STATUS").then(kv),
    q("SHOW GLOBAL VARIABLES").then(kv),
    redisInfo(),
    livekitRooms(),
    q("SELECT table_name AS name, table_rows AS nrows, (data_length+index_length) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY bytes DESC LIMIT 12"),
    q("SELECT id, message, severity, dependency, source, occurrences, last_seen_at FROM error_logs WHERE status = 'open' ORDER BY last_seen_at DESC LIMIT 15").catch(() => []),
    Promise.all([
      one("SELECT COUNT(*) c FROM users"),
      one("SELECT COUNT(*) c FROM conversations"),
      one("SELECT COUNT(*) c FROM messages"),
      one("SELECT COUNT(*) c FROM messages WHERE created_at >= NOW() - INTERVAL 24 HOUR"),
      one("SELECT COUNT(*) c FROM auth_sessions WHERE revoked = 0 AND deleted = 0 AND last_active_at >= NOW() - INTERVAL 5 MINUTE").catch(() => ({ c: 0 })),
    ]),
  ]);
  // CPU% over the interval since the LAST sample. gatherCore() is shared by
  // /snapshot AND /insights; if they fire within ~1ms of each other, a fresh
  // delta divides by a near-zero window and spikes past 100% (→ false CPU-pressure
  // alerts). So only recompute when the window is meaningful (>=750ms); otherwise
  // reuse the last good reading. This keeps the two pollers from clobbering the
  // shared baseline.
  const now = Date.now();
  const dtMs = now - lastCpuAt;
  if (dtMs >= 750) {
    const nowCpu = process.cpuUsage();
    const pct = ((nowCpu.user - lastCpu.user + (nowCpu.system - lastCpu.system)) / 1000 / dtMs) * 100;
    lastCpu = nowCpu;
    lastCpuAt = now;
    lastCpuPct = Math.max(0, Math.round(pct * 10) / 10);
  }
  const mem = process.memoryUsage();
  // Refresh the production-pressure signals from this snapshot so the governor can
  // shed engineering load WITHOUT issuing its own queries.
  lastDbPingMs = num(dbPing?.ms);
  lastLiveMeetings = livekit && livekit.rooms ? livekit.rooms.length : 0;
  lastRssPct = Math.round((mem.rss / (os.totalmem() || 1)) * 100);
  return { dbPing, redisPing, storagePing, diskPing: { ...diskPing, ...(diskInfo || {}) }, status, vars, redis, livekit, tables, errRows, counts, cpuPct: lastCpuPct, mem };
}
// Cached wrapper: one core snapshot per TTL, shared across /snapshot, /insights,
// /sim/baseline and the governor — so many open tabs cost ONE refresh, not many.
async function gatherCore(): Promise<any> {
  return (await cached("core", OPS_TTL.core, gatherCoreRaw, false)).value;
}

// Derive each issue's RESOLUTION state against the deployment ledger. An issue is
// resolved when it was manually closed (backend status resolved/ignored) OR it has
// NOT recurred since the most recent deployment — i.e. the fix shipped and the
// error stopped. Auto-resolution is DERIVED, never stored: if the same error
// recurs its last_seen bumps back past the deploy and it flips to open again, so a
// regression can never hide inside a closed entry. The "resolving" deployment is
// the FIRST release that started AFTER the error was last seen — that's the build
// the operator's fix rode out on.
function stampResolution(list: any[], deployments: any[]): void {
  const times = (deployments || [])
    .map((d) => ({
      at: new Date(d.started_at).getTime(),
      version: d.version || null,
      commit: d.git_commit || null,
      kind: d.kind || "boot",
    }))
    .filter((d) => Number.isFinite(d.at))
    .sort((a, b) => a.at - b.at); // oldest → newest
  const latestAt = times.length ? times[times.length - 1].at : 0;
  for (const e of list) {
    if ((e.scope === "backend" || e.scope === "client") && (e.status === "resolved" || e.status === "ignored")) {
      e.resolved = true;
      e.resolvedReason = "manual";
      // resolvedAt / resolvedBy already carried from the row.
      e.resolvedVersion = null;
      e.resolvedCommit = null;
      continue;
    }
    const seen = new Date(e.lastSeen).getTime();
    if (latestAt && Number.isFinite(seen) && seen < latestAt) {
      const fixer = times.find((d) => d.at > seen) || times[times.length - 1];
      e.resolved = true;
      e.resolvedReason = "deployment";
      e.resolvedAt = new Date(fixer.at).toISOString();
      e.resolvedBy = null;
      e.resolvedVersion = fixer.version;
      e.resolvedCommit = fixer.commit;
    } else {
      e.resolved = false;
      e.resolvedReason = null;
    }
  }
}

// ── unified error/experience list (backend error_logs + client client_errors) ─
// The single source that powers the Error Center, E2EE Health, User Experience
// and the downloadable report: every issue with WHO (user), WHAT DEVICE, WHICH
// domain, and a P0–P3 priority — so an issue can be pinpointed to a person +
// device without ever reading message content. Every issue is also stamped with a
// derived resolution state (see stampResolution) so the Error Center can split
// OCCURRED vs RESOLVED and auto-clear issues that stopped after a deployment.
// Cached per (range, includeResolved) so the Error Center's frequent polls — and
// every other view that reads the merged issue list — share one DB round instead
// of each re-querying error_logs + client_errors + deployments.
async function unifiedErrors(range: string, opts: { includeResolved?: boolean } = {}): Promise<any[]> {
  const key = "err:" + range + (opts.includeResolved ? ":r" : "");
  return (await cached(key, OPS_TTL.errors, () => unifiedErrorsRaw(range, opts), false)).value || [];
}
async function unifiedErrorsRaw(range: string, opts: { includeResolved?: boolean } = {}): Promise<any[]> {
  const [be, ce] = await Promise.all([
    q(
      `SELECT el.id, el.message, el.severity, el.dependency, el.source, el.occurrences, el.request_path, el.code, el.created_at, el.last_seen_at, el.status, el.resolved_at, el.resolved_by, el.resolution, el.user_id, u.name uname, u.email uemail
         FROM error_logs el LEFT JOIN users u ON u.id = el.user_id
        WHERE ${rangeSql("el.last_seen_at", range)} ${opts.includeResolved ? "" : "AND el.status = 'open'"}
        ORDER BY el.last_seen_at DESC LIMIT 800`,
    ),
    q(
      `SELECT ce.id, ce.message, ce.level, ce.category, ce.user_id, ce.user_agent, ce.context, ce.url, ce.count, ce.first_seen, ce.last_seen, ce.status, ce.resolved_at, ce.resolved_by, ce.resolution, u.name uname, u.email uemail
         FROM client_errors ce LEFT JOIN users u ON u.id = ce.user_id
        WHERE ${rangeSql("ce.last_seen", range)} ${opts.includeResolved ? "" : "AND ce.status = 'open'"}
        ORDER BY ce.last_seen DESC LIMIT 800`,
    ).catch(() => []),
  ]);
  const out: any[] = [];
  for (const e of be as any[]) {
    const fault = classifyFault(e);
    const level = e.severity || "error";
    const category = e.dependency === "external" ? "external" : e.dependency === "infra" ? "infra" : "backend";
    const count = num(e.occurrences);
    const priority = priorityOf({ level, domain: fault.domain, category, count, code: e.code || undefined });
    const exp = explainError({ message: e.message, category, domain: fault.domain, code: e.code, level, scope: "backend" });
    out.push({
      scope: "backend",
      id: "b" + e.id,
      rawId: e.id,
      level,
      category,
      domain: fault.domain,
      reason: fault.reason,
      plain: exp.plain,
      owner: exp.owner,
      priority,
      message: String(e.message || ""),
      count,
      requestPath: e.request_path || null,
      code: e.code || null,
      user: e.user_id ? { id: e.user_id, name: e.uname || null, email: e.uemail || null } : null,
      device: null,
      location: null,
      firstSeen: e.created_at,
      lastSeen: e.last_seen_at,
      status: e.status,
      resolvedAt: e.resolved_at || null,
      resolvedBy: e.resolved_by || null,
      resolution: e.resolution || null,
    });
  }
  for (const e of ce as any[]) {
    const level = e.level || "error";
    const category = e.category || "general";
    const ctx = safeJson(e.context);
    const device = parseDevice(e.user_agent, ctx);
    const location = ctx && (ctx.city || ctx.country || ctx.ip) ? { city: ctx.city || null, country: ctx.country || null, ip: ctx.ip || null } : null;
    const domain = category === "e2ee" ? "application" : "client";
    const count = num(e.count);
    const priority = priorityOf({ level, domain, category, count, code: (ctx && ctx.kind) || undefined });
    const exp = explainError({ message: e.message, category, domain, code: (ctx && ctx.kind) || null, level, scope: "client" });
    out.push({
      scope: "client",
      id: "c" + e.id,
      rawId: e.id,
      level,
      category,
      domain,
      reason: category === "e2ee" ? "End-to-end encryption failure on the client device." : "Client-side runtime, render or network issue.",
      plain: exp.plain,
      owner: exp.owner,
      priority,
      message: String(e.message || ""),
      count,
      requestPath: e.url || null,
      code: (ctx && ctx.kind) || null,
      user: e.user_id ? { id: e.user_id, name: e.uname || null, email: e.uemail || null } : null,
      device,
      location,
      firstSeen: e.first_seen,
      lastSeen: e.last_seen,
      status: e.status || "open",
      resolvedAt: e.resolved_at || null,
      resolvedBy: e.resolved_by || null,
      resolution: e.resolution || null,
    });
  }
  // Stamp the derived resolution state (open vs resolved-by-deploy vs manual)
  // against the release ledger. Cheap + indexed; degrades to "all open" if the
  // ledger is unavailable.
  const deployments = await listDeployments(60).catch(() => []);
  stampResolution(out, deployments);
  out.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
  return out;
}
function userLabel(u: any): string {
  if (!u) return "Anonymous";
  return u.name || u.email || u.id || "Anonymous";
}

// ── /snapshot ────────────────────────────────────────────────────────────────
router.get("/snapshot", async (_req, res) => {
  const core = await gatherCore();
  const { dbPing, redisPing, storagePing, diskPing, status, vars, redis, livekit, tables, errRows, counts, cpuPct, mem } = core;

  const checks = { db: dbPing, redis: redisPing, storage: storagePing, disk: diskPing };
  const healthOk = [dbPing.ok, storagePing.ok].every(Boolean);
  const okCount = Object.values(checks).filter((c) => c.ok).length;
  const errPressure = Math.min(30, (errRows as any[]).reduce((s, e) => s + num(e.occurrences), 0) / 5);
  const memRss = mem.rss / (os.totalmem() || 1);
  let score = 100;
  if (!dbPing.ok) score -= 45;
  if (!storagePing.ok) score -= 25;
  // Only dock for Redis when it's actually configured — an intentionally-absent
  // Redis (single-instance deployments) must not permanently cap the score.
  if (config.redis?.url && !redisPing.ok) score -= 8;
  score -= errPressure;
  if (memRss > 0.85) score -= 10;
  score = Math.max(0, Math.min(100, Math.round(score)));

  res.json({
    ok: true,
    generatedAt: Date.now(),
    score,
    healthy: healthOk,
    server: {
      env: config.env,
      version: config.version || "1.0.0",
      gitCommit: config.gitCommit || null,
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      hostname: os.hostname(),
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      processStartedAt: startedAt,
      cpuPct,
      loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      cores: os.cpus().length,
      memRssBytes: mem.rss,
      memHeapUsed: mem.heapUsed,
      memHeapTotal: mem.heapTotal,
      sysTotalMem: os.totalmem(),
      sysFreeMem: os.freemem(),
    },
    health: { ok: healthOk, okCount, total: Object.keys(checks).length, checks },
    db: {
      ok: dbPing.ok,
      latencyMs: dbPing.ms,
      driver: db.driver,
      version: vars["version"],
      threadsConnected: num(status["Threads_connected"]),
      threadsRunning: num(status["Threads_running"]),
      maxConnections: num(vars["max_connections"]),
      uptimeSec: num(status["Uptime"]),
      queries: num(status["Queries"]),
      slowQueries: num(status["Slow_queries"]),
      abortedConnects: num(status["Aborted_connects"]),
      bytesSent: num(status["Bytes_sent"]),
      bytesReceived: num(status["Bytes_received"]),
      tables,
    },
    redis,
    livekit,
    counts: {
      users: num(counts[0]?.c),
      conversations: num(counts[1]?.c),
      messages: num(counts[2]?.c),
      messages24h: num(counts[3]?.c),
      activeSessions: num(counts[4]?.c),
      activeRooms: livekit?.rooms?.length || 0,
      liveParticipants: (livekit?.rooms || []).reduce((s: number, r: any) => s + num(r.participants), 0),
    },
    errors: (errRows as any[]).map((e) => ({
      id: e.id,
      message: String(e.message || "").slice(0, 240),
      level: e.severity || "error",
      dependency: e.dependency || "app",
      domain: classifyFault(e).domain,
      count: num(e.occurrences),
      lastSeen: e.last_seen_at,
    })),
  });
});

// ── /containers ──────────────────────────────────────────────────────────────
router.get("/containers", async (_req, res) => {
  res.json({ ok: true, generatedAt: Date.now(), ...(await dockerContainers()) });
});

// ── /errors — unified Error Center (backend + client, user/device/priority) ──
// Applies every filter IN MEMORY over the merged set (fetched bounded from each
// store), so a domain/priority/user filter can't silently drop matches beyond a
// pre-filter SQL LIMIT.
router.get("/errors", async (req, res) => {
  const range = String(req.query.range || "today");
  const severity = String(req.query.severity || "all").toLowerCase();
  const category = String(req.query.category || "all").toLowerCase();
  const domainF = String(req.query.domain || "all").toLowerCase();
  const scope = String(req.query.scope || "all").toLowerCase();
  const priorityF = String(req.query.priority || "all").toUpperCase();
  const user = String(req.query.user || "").toLowerCase().trim();
  const search = String(req.query.q || "").toLowerCase().slice(0, 120);
  const limit = Math.min(600, Math.max(10, Number(req.query.limit) || 300));
  // state: occurred (default, still open) | resolved (auto-closed by a deploy or
  // manually) | all. Always fetch BOTH so the tab badges are accurate regardless
  // of which tab is shown.
  const state = String(req.query.state || "occurred").toLowerCase();

  let list = await unifiedErrors(range, { includeResolved: true });
  const openList = list.filter((e) => !e.resolved);
  const resolvedList = list.filter((e) => e.resolved);
  const counts = { occurred: openList.length, resolved: resolvedList.length, all: list.length };
  // "all" keeps the full merged list; otherwise narrow to the selected state.
  if (state === "resolved") list = resolvedList;
  else if (state !== "all") list = openList;
  const total = list.length;
  if (severity !== "all") list = list.filter((e) => e.level === severity);
  if (category !== "all") list = list.filter((e) => e.category === category);
  if (domainF !== "all") list = list.filter((e) => e.domain === domainF);
  if (scope !== "all") list = list.filter((e) => e.scope === scope);
  if (priorityF !== "ALL" && /^P[0-3]$/.test(priorityF)) list = list.filter((e) => PRIORITY_META[e.priority] === priorityF);
  if (user) list = list.filter((e) => userLabel(e.user).toLowerCase().includes(user) || (e.user?.id || "").toLowerCase().includes(user));
  if (search) list = list.filter((e) => e.message.toLowerCase().includes(search) || (e.requestPath || "").toLowerCase().includes(search));

  const shown = list.slice(0, limit);
  res.json({
    ok: true,
    generatedAt: Date.now(),
    range,
    state,
    counts,
    total,
    count: shown.length,
    errors: shown.map((e) => ({ ...e, priorityLabel: PRIORITY_META[e.priority], userLabel: userLabel(e.user) })),
  });
});

// ── /logs — kept for the live stream view ────────────────────────────────────
router.get("/logs", async (req, res) => {
  const range = String(req.query.range || "7d");
  const level = String(req.query.level || "").toLowerCase();
  const search = String(req.query.q || "").slice(0, 120);
  const limit = Math.min(300, Math.max(10, Number(req.query.limit) || 120));
  const where: string[] = [rangeSql("last_seen_at", range)];
  const params: any[] = [];
  if (level && level !== "all") {
    where.push("severity = ?");
    params.push(level);
  }
  if (search) {
    where.push("message LIKE ?");
    params.push(`%${search}%`);
  }
  const rows = await q(
    `SELECT id, message, severity, dependency, source, occurrences, request_path, created_at, last_seen_at FROM error_logs WHERE ${where.join(" AND ")} ORDER BY last_seen_at DESC LIMIT ${limit}`,
    params,
  );
  res.json({
    ok: true,
    generatedAt: Date.now(),
    logs: (rows as any[]).map((e) => ({
      id: e.id,
      message: String(e.message || ""),
      level: e.severity || "error",
      dependency: e.dependency || "app",
      source: e.source || "backend",
      domain: classifyFault(e).domain,
      count: num(e.occurrences),
      requestPath: e.request_path || null,
      firstSeen: e.created_at,
      lastSeen: e.last_seen_at,
    })),
  });
});

// ── /storage — where the bytes actually live ──────────────────────────────────
// Four real sources, each probed independently and degrading to null on failure:
//   • disk        — the container/host filesystem (statfs): total / used / free
//   • objectStore — MinIO/S3 bucket: object count + summed bytes (bounded scan)
//   • database    — MySQL data+index size per table (information_schema)
//   • redis       — in-memory footprint + max + eviction policy
// Counts + sizes only; never touches file/message CONTENT.
async function diskUsage() {
  try {
    const fsp: any = await import("fs/promises");
    if (typeof fsp.statfs !== "function") return null; // Node < 18.15
    const path = process.platform === "win32" ? process.cwd().slice(0, 3) : "/";
    const s: any = await fsp.statfs(path);
    const totalBytes = num(s.blocks) * num(s.bsize);
    const freeBytes = num(s.bavail) * num(s.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      path,
      totalBytes,
      freeBytes,
      usedBytes,
      usedPct: totalBytes ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
    };
  } catch {
    return null;
  }
}
// The S3 object scan is the single heaviest probe → cached with a long TTL and
// flagged HEAVY, so it never runs while production is busy. Always returns a safe
// object (never null) so callers don't need to guard.
async function objectStoreUsage() {
  const r = await cached("objstore", OPS_TTL.storage, objectStoreUsageRaw, true);
  return r.value || { bucket: null, objects: 0, bytes: 0, truncated: false, degraded: true, reason: r.reason || "deferred under load" };
}
async function objectStoreUsageRaw() {
  try {
    const { s3, BUCKET } = (await import("../services/storageService")) as any;
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    let token: string | undefined;
    let objects = 0;
    let bytes = 0;
    let pages = 0;
    let truncated = false;
    do {
      const out: any = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token, MaxKeys: 1000 }),
      );
      for (const o of out.Contents || []) {
        objects++;
        bytes += num(o.Size);
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
      pages++;
      if (pages >= 25) {
        truncated = !!token; // bounded scan (~25k objects) — never walk an unbounded bucket
        break;
      }
    } while (token);
    return { bucket: BUCKET, objects, bytes, truncated };
  } catch (e: any) {
    return { bucket: null, objects: 0, bytes: 0, truncated: false, error: String(e?.message || e).slice(0, 100) };
  }
}
// information_schema over all tables is moderately heavy → cached + HEAVY so it
// also defers under production pressure. Safe object on degrade.
async function dbStorage() {
  const r = await cached("dbstorage", OPS_TTL.storage, dbStorageRaw, true);
  return r.value || { totalBytes: 0, totalRows: 0, tableCount: 0, tables: [], degraded: true, reason: r.reason || "deferred under load" };
}
async function dbStorageRaw() {
  try {
    const rows: any = await q(
      "SELECT table_name AS name, table_rows AS nrows, data_length AS data_len, index_length AS idx_len, (data_length+index_length) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY bytes DESC",
    );
    const arr = rows as any[];
    const totalBytes = arr.reduce((s, r) => s + num(r.bytes), 0);
    const totalRows = arr.reduce((s, r) => s + num(r.nrows), 0);
    return {
      totalBytes,
      totalRows,
      tableCount: arr.length,
      tables: arr.slice(0, 20).map((r) => ({
        name: r.name,
        rows: num(r.nrows),
        bytes: num(r.bytes),
        dataBytes: num(r.data_len),
        indexBytes: num(r.idx_len),
      })),
    };
  } catch (e: any) {
    return { totalBytes: 0, totalRows: 0, tableCount: 0, tables: [], error: String(e?.message || e).slice(0, 100) };
  }
}
router.get("/storage", async (_req, res) => {
  const [disk, objectStore, database, redis] = await Promise.all([
    diskUsage(),
    objectStoreUsage(),
    dbStorage(),
    redisInfo(),
  ]);
  res.json({
    ok: true,
    generatedAt: Date.now(),
    governor: productionPressure(),
    degraded: !!((objectStore as any)?.degraded || (database as any)?.degraded),
    disk,
    objectStore,
    database,
    redis: redis && redis.ok
      ? {
          usedBytes: num(redis.memoryBytes),
          maxBytes: num(redis.maxMemoryBytes) || null,
          policy: redis.evictionPolicy || null,
          evictedKeys: num(redis.evictedKeys),
          human: redis.memoryHuman || null,
        }
      : null,
  });
});

// ── /governor — the production-safety control plane's own status ──────────────
// Proves the Golden Rule is being enforced: current production pressure, what's
// being shed, cache hit-ratio (how much load the cache is absorbing), and the
// degradation order. Cheap (reads counters + last-known signals; no new queries).
router.get("/governor", (_req, res) => {
  const p = productionPressure();
  const total = opsCacheHits + opsCacheMiss;
  res.json({
    ok: true,
    generatedAt: Date.now(),
    goldenRule: "The engineering platform never degrades Collab. Under production pressure, heavy engineering reads serve cached/stale data instead of running — production always wins.",
    pressure: p,
    thresholds: OPS_GOV,
    ttlMs: OPS_TTL,
    degradeOrder: OPS_DEGRADE_ORDER,
    cache: {
      hits: opsCacheHits,
      misses: opsCacheMiss,
      hitRatioPct: total ? Math.round((opsCacheHits / total) * 100) : null,
      sheds: opsSheds,
      activeHeavy: opsActiveHeavy,
      maxConcurrentHeavy: OPS_GOV.maxConcurrentHeavy,
      entries: Array.from(opsCache.entries()).map(([k, e]) => ({ key: k, ageMs: Date.now() - e.at, refreshing: e.refreshing })),
    },
    note: "Simulation math runs entirely in the browser (zero production CPU). The only server cost is the baseline snapshot, which is cached + shed like every other probe.",
  });
});

// ── /sim/baseline — grounding constants for the Simulation Engine ─────────────
// The digital-twin simulator must never invent numbers. This endpoint hands the
// client the REAL measured state it extrapolates from: live process/host metrics,
// current data volumes + storage, the actual DB pool + infra config, and the
// committed static-analysis cost model (per-endpoint DB round-trips, N+1 sites,
// cross-pod cache gaps) — each carrying its source + basis (observed|measured|
// static-analysis). Projections are computed client-side and labelled there.
router.get("/sim/baseline", async (_req, res) => {
  const [core, obj] = await Promise.all([gatherCore(), objectStoreUsage()]);
  const cpus = os.cpus() || [];
  const tables = core.tables as any[];
  const msgTable = tables.find((t) => String(t.name).toLowerCase() === "messages");
  const dbBytes = tables.reduce((s, t) => s + num(t.bytes), 0);
  const dbRows = tables.reduce((s, t) => s + num(t.nrows), 0);
  const c = core.counts as any[];
  const users = num(c[0]?.c);
  const conversations = num(c[1]?.c);
  const messages = num(c[2]?.c);
  const messages24h = num(c[3]?.c);
  const activeSessions = num(c[4]?.c);
  const poolLimit = Number(process.env.DB_POOL_LIMIT) || 20;
  const queueLimit = Number(process.env.DB_QUEUE_LIMIT) || poolLimit * 4;
  const rooms = (core.livekit && core.livekit.rooms) || [];
  const scores = architecture.scores || [];
  const overall = scores.length ? Math.round(scores.reduce((s, x) => s + x.score, 0) / scores.length) : null;

  res.json({
    ok: true,
    generatedAt: Date.now(),
    governor: productionPressure(),
    // What the box actually is + is doing RIGHT NOW (measured).
    runtime: {
      basis: "measured",
      cpuPct: core.cpuPct,
      cores: cpus.length || null,
      cpuModel: cpus[0]?.model?.trim() || null,
      cpuSpeedMhz: cpus[0]?.speed || null,
      loadAvg: os.loadavg ? os.loadavg() : null,
      memRssBytes: num(core.mem.rss),
      memHeapUsedBytes: num(core.mem.heapUsed),
      memTotalBytes: os.totalmem() || null,
      memFreeBytes: os.freemem() || null,
      dbPingMs: core.dbPing?.ms ?? null,
      redisPingMs: core.redisPing?.ok ? core.redisPing.ms : null,
      storagePingMs: core.storagePing?.ms ?? null,
      activeSessions,
      liveMeetings: rooms.length,
      liveParticipants: rooms.reduce((s: number, r: any) => s + num(r.participants), 0),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    },
    // Current data volumes + storage (measured), plus DERIVED per-unit sizes the
    // model uses to project growth (labelled derived).
    data: {
      basis: "measured",
      users,
      conversations,
      messages,
      messages24h,
      dbBytes,
      dbRows,
      objectBytes: num(obj.bytes),
      objectCount: num(obj.objects),
      objectScanTruncated: !!obj.truncated,
      derived: {
        basis: "derived",
        avgMessageBytes: msgTable && num(msgTable.nrows) ? Math.round(num(msgTable.bytes) / num(msgTable.nrows)) : null,
        avgObjectBytes: num(obj.objects) ? Math.round(num(obj.bytes) / num(obj.objects)) : null,
        messagesPerActiveUserPerDay: activeSessions ? Math.round(messages24h / activeSessions) : null,
      },
    },
    // The infra the twin starts from (measured config, not guessed).
    capacity: {
      basis: "measured-config",
      dbPoolLimit: poolLimit,
      dbQueueLimit: queueLimit,
      dbPoolSource: "database/src/drivers/mysql.ts:66 (DB_POOL_LIMIT, default 20)",
      backendInstances: Number(process.env.BACKEND_INSTANCES) || 1,
      redisConfigured: !!config.redis?.url,
      redisMaxBytes: num(core.redis?.maxMemoryBytes) || null,
      livekitConfigured: !!(core.livekit && core.livekit.configured),
      // Verified empirical ceiling (calls-scale-roadmap): presence layer breaks
      // first at ~100–150 participants/meeting before media does.
      meetingParticipantCeiling: 130,
      meetingCeilingBasis: "observed (load-tested; presence layer is the first bottleneck)",
    },
    // The measured cost model the twin extrapolates — real per-operation costs
    // with file:line provenance. This is why a 10× workload projection isn't a
    // guess: it multiplies KNOWN round-trip counts by the KNOWN pool ceiling.
    costModel: {
      basis: "static-analysis",
      hotPaths: [
        { op: "GET /api/search", dbRoundTrips: 10, pattern: "serial-await", source: "searchService.ts:25-76", note: "~10 independent queries awaited sequentially — Promise.all would cut wall-time ~10×." },
        { op: "serializeMember (every conversation/message list)", dbRoundTrips: "N", pattern: "N+1", source: "serialize.ts:589", note: "getById per member; the getByIds batch at mysql.ts:338 is unused." },
        { op: "orgBroadcast.notifyMembers", dbRoundTrips: "N (~100 roster)", pattern: "serial-await", source: "orgBroadcastService.ts:30-49" },
        { op: "GET /api/users (directory)", dbRoundTrips: 1, pattern: "full-scan + filesort", source: "database/src/drivers/mysql.ts:355", note: "Unbounded scan sorted on the unindexed name column; paginated listPage() exists but is unused." },
      ],
      caches: { crossPodShared: false, kind: "per-process new Map()", source: "rbacService:56, linkPreviewService:19, auth.ts", note: "Multi-instance deploy (socket.io Redis adapter) → invalidation is pod-local; other pods serve stale until TTL." },
    },
    // The committed architecture scorecard the twin uses for maintainability /
    // scalability weighting (static-analysis artifact, not runtime-measured).
    architecture: { basis: "static-analysis", overall, generatedAt: architecture.generatedAt, scores },
    provenance:
      "Every value here is a live process/DB/LiveKit read or the committed static-analysis artifact. The Simulation Engine layers queuing + growth models on top and labels each projection observed | measured | estimated | predicted with its assumptions.",
  });
});

// ── POST /errors/:id/resolve — composite ids: b<numeric> backend, c<uuid> client
router.post("/errors/:id/resolve", async (req: any, res) => {
  const raw = String(req.params.id);
  const scope = raw[0] === "c" ? "client" : "backend";
  const rest = raw.replace(/^[bc]/, "");
  try {
    if (scope === "client") {
      // client_errors now carries a status (migration 0108) — mark it resolved and
      // KEEP the row so it appears under the portal's global "Resolved" view,
      // instead of hard-deleting it. `rest` is the row's UUID primary key.
      const status = req.body?.status === "ignored" ? "ignored" : "resolved";
      const note = (String(req.body?.note || "").trim() || "Resolved from the engineering portal").slice(0, 500);
      const by = String(req.ops?.name || "ops-portal").slice(0, 64);
      const [r]: any = await db.pool.query(
        "UPDATE client_errors SET status = ?, resolved_at = NOW(3), resolved_by = ?, resolution = ? WHERE id = ?",
        [status, by, note, rest],
      );
      return res.json({ ok: true, id: raw, status, changed: r?.affectedRows || 0 });
    }
    const id = Number(rest);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "Invalid error id" });
    const status = req.body?.status === "ignored" ? "ignored" : "resolved";
    const note = (String(req.body?.note || "").trim() || "Resolved from the engineering portal").slice(0, 500);
    const by = String(req.ops?.name || "ops-portal").slice(0, 64);
    const [r]: any = await db.pool.query(
      "UPDATE error_logs SET status = ?, resolved_at = NOW(), resolved_by = ?, resolution = ? WHERE id = ? AND status = 'open'",
      [status, by, note, id],
    );
    return res.json({ ok: true, id: raw, status, changed: r?.affectedRows || 0 });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 120) });
  }
});

// ── /deployments — the release ledger + per-release error blast radius ────────
router.get("/deployments", async (_req, res) => {
  const deps = await listDeployments(40);
  // Pull error timestamps once, then bucket each release's 15-minute blast radius
  // in JS (avoids N correlated subqueries).
  // Correlate on last_seen_at (error ACTIVITY), not created_at (first-seen): while
  // a fingerprint stays open a recurrence only bumps last_seen_at, so a deploy that
  // re-triggers an already-open error would be missed if we keyed on first-seen.
  const errs = await q(
    "SELECT last_seen_at, severity, occurrences FROM error_logs WHERE last_seen_at >= NOW() - INTERVAL 30 DAY AND severity IN ('error','fatal')",
  );
  const errTimes = (errs as any[]).map((e) => ({ t: new Date(e.last_seen_at).getTime(), sev: e.severity, n: num(e.occurrences) }));
  const enriched = deps.map((d: any, i: number) => {
    const start = new Date(d.started_at).getTime();
    const windowEnd = start + 15 * 60 * 1000;
    let errors = 0;
    let errOcc = 0;
    for (const e of errTimes) {
      if (e.t >= start && e.t <= windowEnd && (e.sev === "error" || e.sev === "fatal")) {
        errors++;
        errOcc += e.n;
      }
    }
    return {
      id: d.id,
      kind: d.kind,
      version: d.version,
      gitCommit: d.git_commit,
      env: d.env,
      node: d.node_version,
      hostname: d.hostname,
      pid: d.pid,
      startedAt: start,
      errorsAfter: errors,
      occurrencesAfter: errOcc,
      // A release with a cluster of errors in the first 15 minutes is suspicious.
      suspect: errors >= 3,
    };
  });
  res.json({ ok: true, generatedAt: Date.now(), deployments: enriched });
});

// ── /fault — attribute recent errors to a domain (infra/app/external/client) ─
router.get("/fault", async (req, res) => {
  const range = String(req.query.range || "today");
  const rows = await q(
    `SELECT id, message, severity, dependency, source, occurrences, request_path, last_seen_at FROM error_logs WHERE ${rangeSql("last_seen_at", range)} AND status = 'open' ORDER BY occurrences DESC LIMIT 300`,
  );
  const domains: Record<string, { key: string; label: string; blurb: string; groups: number; occurrences: number; examples: any[] }> = {};
  for (const k of Object.keys(DOMAIN_META)) domains[k] = { key: k, label: DOMAIN_META[k].label, blurb: DOMAIN_META[k].blurb, groups: 0, occurrences: 0, examples: [] };
  let totalOcc = 0;
  for (const e of rows as any[]) {
    const f = classifyFault(e);
    const d = domains[f.domain];
    if (!d) continue;
    d.groups++;
    d.occurrences += num(e.occurrences);
    totalOcc += num(e.occurrences);
    if (d.examples.length < 4)
      d.examples.push({ id: e.id, message: String(e.message || "").slice(0, 120), count: num(e.occurrences), requestPath: e.request_path || null, reason: f.reason });
  }
  const list = Object.values(domains)
    .map((d) => ({ ...d, pct: totalOcc ? Math.round((d.occurrences / totalOcc) * 1000) / 10 : 0 }))
    .sort((a, b) => b.occurrences - a.occurrences);
  res.json({ ok: true, generatedAt: Date.now(), range, totalOccurrences: totalOcc, domains: list });
});

// ── /incidents — clustered failures, correlated with deployments ─────────────
router.get("/incidents", async (_req, res) => {
  const [deps, errs] = await Promise.all([
    listDeployments(30),
    q("SELECT id, message, severity, dependency, source, occurrences, last_seen_at FROM error_logs WHERE last_seen_at >= NOW() - INTERVAL 30 DAY AND severity IN ('error','fatal') ORDER BY last_seen_at ASC"),
  ]);
  // Key on last_seen_at (activity) so deploy-triggered recurrences of already-open
  // errors are caught, not just brand-new fingerprints.
  const errList = (errs as any[]).map((e) => ({ ...e, t: new Date(e.last_seen_at).getTime() }));
  const incidents: any[] = [];
  // 1) Deployment-linked: a release with >= 3 error groups in its first 15 min.
  for (const d of deps) {
    const start = new Date(d.started_at).getTime();
    const win = errList.filter((e) => e.t >= start && e.t <= start + 15 * 60 * 1000);
    if (win.length >= 3) {
      const occ = win.reduce((s, e) => s + num(e.occurrences), 0);
      const domCount: Record<string, number> = {};
      for (const e of win) {
        const dm = classifyFault(e).domain;
        domCount[dm] = (domCount[dm] || 0) + num(e.occurrences);
      }
      const dominant = Object.entries(domCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "application";
      incidents.push({
        kind: "deployment-linked",
        at: start,
        title: `Error spike right after ${d.kind} v${d.version || "?"}`,
        deployment: { id: d.id, version: d.version, gitCommit: d.git_commit, kind: d.kind },
        errorGroups: win.length,
        occurrences: occ,
        dominantDomain: dominant,
        severity: occ >= 20 ? "critical" : "warning",
        topErrors: win.slice(0, 4).map((e) => ({ id: e.id, message: String(e.message || "").slice(0, 120), count: num(e.occurrences) })),
        note: `A ${d.kind} at this moment was immediately followed by ${win.length} error group(s). This is strong evidence the incident is deployment-related, and the dominant fault domain was ${DOMAIN_META[dominant]?.label || dominant}.`,
      });
    }
  }
  // 2) Standalone spikes: any hour bucket with >= 30 error occurrences not already
  //    attributed to a deployment window.
  const byHour: Record<number, any[]> = {};
  for (const e of errList) {
    const h = Math.floor(e.t / (60 * 60 * 1000));
    (byHour[h] = byHour[h] || []).push(e);
  }
  const depWindows = deps.map((d: any) => new Date(d.started_at).getTime());
  for (const [h, list] of Object.entries(byHour)) {
    const occ = list.reduce((s, e) => s + num(e.occurrences), 0);
    const bucketStart = Number(h) * 60 * 60 * 1000;
    const nearDeploy = depWindows.some((t) => Math.abs(t - bucketStart) < 60 * 60 * 1000);
    if (occ >= 30 && !nearDeploy) {
      const domCount: Record<string, number> = {};
      for (const e of list) {
        const dm = classifyFault(e).domain;
        domCount[dm] = (domCount[dm] || 0) + num(e.occurrences);
      }
      const dominant = Object.entries(domCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "application";
      incidents.push({
        kind: "error-spike",
        at: bucketStart,
        title: `Sustained error volume (${occ} occurrences/hour)`,
        errorGroups: list.length,
        occurrences: occ,
        dominantDomain: dominant,
        severity: occ >= 100 ? "critical" : "warning",
        topErrors: list.sort((a, b) => num(b.occurrences) - num(a.occurrences)).slice(0, 4).map((e) => ({ id: e.id, message: String(e.message || "").slice(0, 120), count: num(e.occurrences) })),
        note: `No deployment near this window — the dominant fault domain was ${DOMAIN_META[dominant]?.label || dominant}, pointing away from a release regression.`,
      });
    }
  }
  incidents.sort((a, b) => b.at - a.at);
  res.json({ ok: true, generatedAt: Date.now(), incidents: incidents.slice(0, 30) });
});

// ── /insights — rule-based reasoning: what / why / recommend / confidence ────
router.get("/insights", async (_req, res) => {
  const [core, deps, errAgg] = await Promise.all([
    gatherCore(),
    listDeployments(10),
    q("SELECT dependency, severity, source, COUNT(*) groups, SUM(occurrences) occ FROM error_logs WHERE status='open' AND last_seen_at >= NOW() - INTERVAL 24 HOUR GROUP BY dependency, severity, source"),
  ]);
  const { status, vars, redis, mem, cpuPct, dbPing, storagePing, redisPing } = core;
  const insights: any[] = [];
  const push = (i: any) => insights.push(i);

  // Fault-domain split over the last 24h (the blame-attribution headline).
  const realErr = (errAgg as any[]).filter((r) => r.severity === "error" || r.severity === "fatal");
  const domTotals: Record<string, number> = {};
  for (const r of realErr) {
    const dm = classifyFault({ message: "", severity: r.severity, dependency: r.dependency, source: r.source }).domain;
    domTotals[dm] = (domTotals[dm] || 0) + num(r.occ);
  }
  const totalReal = Object.values(domTotals).reduce((a, b) => a + b, 0);
  if (totalReal > 0) {
    const top = Object.entries(domTotals).sort((a, b) => b[1] - a[1])[0];
    const pct = Math.round((top[1] / totalReal) * 100);
    push({
      area: "Reliability",
      severity: pct >= 60 && top[0] !== "application" ? "warning" : pct >= 60 ? "critical" : "info",
      title: `${pct}% of the last 24h's real errors are ${DOMAIN_META[top[0]]?.label || top[0]}`,
      what: `Of ${totalReal} error/fatal occurrences in the last 24h, ${top[1]} (${pct}%) attribute to ${DOMAIN_META[top[0]]?.label || top[0]}.`,
      why: [DOMAIN_META[top[0]]?.blurb || "", top[0] === "application" ? "These point at Collab's own code paths." : "These point away from application code."],
      affected: "Whole platform",
      recommendation: top[0] === "infrastructure"
        ? ["Check DB/Redis/host health and connection pools first — this is a platform-side pattern, not a code bug.", "Escalate to DevOps/infra with the evidence below."]
        : top[0] === "external"
          ? ["Check the third-party/object-storage dependency and its status page.", "These failures originate outside Collab code."]
          : top[0] === "client"
            ? ["Mostly invalid input / permissions / device issues — not a platform fault.", "Review the top request paths for a broken client build if the volume is abnormal."]
            : ["Concentrate code review on the top failing endpoints below.", "Reproduce with the request paths in the Error Center."],
      confidence: 82,
      evidence: `${totalReal} occurrences classified across ${Object.keys(domTotals).length} domain(s).`,
    });
  }

  // Deployment correlation (the crash story).
  const suspectDeps = [];
  const errTimes = (await q("SELECT last_seen_at, severity FROM error_logs WHERE last_seen_at >= NOW() - INTERVAL 7 DAY AND severity IN ('error','fatal')")) as any[];
  const errT = errTimes.map((e) => new Date(e.last_seen_at).getTime());
  for (const d of deps) {
    const start = new Date(d.started_at).getTime();
    const n = errT.filter((t) => t >= start && t <= start + 15 * 60 * 1000).length;
    if (n >= 3) suspectDeps.push({ d, n });
  }
  if (suspectDeps.length) {
    const s = suspectDeps[0];
    push({
      area: "Deployments",
      severity: "critical",
      title: `Deployment v${s.d.version || "?"} correlates with an error spike`,
      what: `${s.n} error group(s) fired within 15 minutes of the ${s.d.kind} at ${new Date(new Date(s.d.started_at).getTime()).toISOString()}.`,
      why: ["A tight time correlation between a release and an error spike is the classic signature of a bad deploy.", "This is the evidence to distinguish a release regression from an unrelated code bug or infra event."],
      affected: `Everything served by ${s.d.hostname || "the backend"}`,
      recommendation: ["Compare this release's commit against the previous one.", "If confirmed, roll back and re-verify; schedule risky deploys outside live-call windows.", "Attach this correlation as proof of what actually happened."],
      confidence: 88,
      evidence: `Release id ${s.d.id}, commit ${s.d.git_commit || "n/a"}.`,
    });
  }

  // Resource pressure.
  const memRss = mem.rss / (os.totalmem() || 1);
  if (cpuPct >= 80)
    push({ area: "Performance", severity: cpuPct >= 92 ? "critical" : "warning", title: `Event-loop CPU at ${cpuPct.toFixed(0)}%`, what: `The backend process is using ${cpuPct.toFixed(1)}% CPU.`, why: ["Sustained high CPU delays every request and can cascade into timeouts."], affected: "All API + socket traffic", recommendation: ["Profile the hottest path (meeting/media or a hot loop).", "Consider horizontal scaling if load is legitimate."], confidence: 74, evidence: `cpu=${cpuPct}%` });
  if (memRss >= 0.8)
    push({ area: "Performance", severity: memRss >= 0.9 ? "critical" : "warning", title: `Process RSS at ${(memRss * 100).toFixed(0)}% of host memory`, what: `RSS is ${(memRss * 100).toFixed(1)}% of total system memory.`, why: ["Approaching the memory ceiling risks OOM kills — an abrupt crash that cuts live calls."], affected: "The whole instance", recommendation: ["Check for a leak (long-lived closures / caches).", "Raise the container memory limit or scale out."], confidence: 70, evidence: `rss=${(memRss * 100).toFixed(0)}%` });

  // DB connection saturation.
  const conns = num(status["Threads_connected"]);
  const maxConns = num(vars["max_connections"]) || 151;
  if (maxConns && conns / maxConns >= 0.7)
    push({ area: "Database", severity: conns / maxConns >= 0.9 ? "critical" : "warning", title: `MySQL connection pool ${Math.round((conns / maxConns) * 100)}% saturated`, what: `${conns} of ${maxConns} connections in use.`, why: ["Pool exhaustion makes new requests wait or fail — a common cause of a sudden site-wide stall."], affected: "All DB-backed requests", recommendation: ["Raise max_connections / the app pool size.", "Investigate long-running or leaked connections and idle timeouts."], confidence: 80, evidence: `${conns}/${maxConns}` });
  if (num(status["Slow_queries"]) > 0)
    push({ area: "Database", severity: "info", title: `${num(status["Slow_queries"])} slow queries logged`, what: `MySQL has recorded ${num(status["Slow_queries"])} slow queries since start.`, why: ["Slow queries hold connections and degrade tail latency."], affected: "Latency-sensitive endpoints", recommendation: ["Enable/inspect the slow-query log and add missing indexes."], confidence: 60, evidence: `Slow_queries=${num(status["Slow_queries"])}` });

  // Redis cache health.
  if (redis?.configured && redis.ok) {
    const total = num(redis.hits) + num(redis.misses);
    const hitRate = total ? redis.hits / total : 1;
    if (total > 1000 && hitRate < 0.8)
      push({ area: "Caching", severity: "info", title: `Redis keyspace hit rate ${(hitRate * 100).toFixed(0)}%`, what: `Redis global keyspace hit rate is ${(hitRate * 100).toFixed(1)}% over ${total} lookups.`, why: ["This is Redis's GLOBAL keyspace hit/miss ratio, not a read-through-cache metric. Collab uses Redis mainly for the token blocklist and rate-limiter, which are ABSENCE checks — a valid, non-revoked token has no key, so nearly every read is a miss BY DESIGN. A low ratio here does not indicate the actual caches (link previews, permissions) are failing."], affected: "Informational — not a cache fault on its own", recommendation: ["No action needed unless DB load is high AND traced to the link-preview / permission caches specifically.", "Optional optimisation: give the token blocklist a small in-memory negative cache so a valid token isn't re-checked against Redis on every request (trades a few seconds of revocation latency for far fewer Redis reads)."], confidence: 60, evidence: `hits=${redis.hits} misses=${redis.misses}` });
    if (num(redis.evictedKeys) > 0 && num(redis.maxMemoryBytes) > 0 && num(redis.memoryBytes) / num(redis.maxMemoryBytes) > 0.85)
      push({ area: "Caching", severity: "warning", title: `Redis approaching maxmemory (${num(redis.evictedKeys)} evictions)`, what: `Used memory is ${Math.round((num(redis.memoryBytes) / num(redis.maxMemoryBytes)) * 100)}% of maxmemory with ${num(redis.evictedKeys)} evicted keys.`, why: ["Evictions silently drop cached data and can cause thundering-herd DB load."], affected: "Cache-dependent paths", recommendation: ["Raise maxmemory or shorten TTLs on large keys."], confidence: 68, evidence: `evicted=${num(redis.evictedKeys)}` });
  }

  // Storage integrity (OBJECT_MISSING).
  const missing = await one("SELECT COUNT(*) c, SUM(occurrences) o FROM error_logs WHERE code = 'OBJECT_MISSING' AND status='open'");
  if (num(missing.c) > 0)
    push({ area: "Storage", severity: "info", title: `${num(missing.c)} file(s) missing from object storage`, what: `${num(missing.o)} download attempts hit an object that no longer exists.`, why: ["A DB file row outlived its object (failed upload, storage reset, or lifecycle expiry)."], affected: "Attachment downloads", recommendation: ["Reconcile file rows against the bucket; soft-delete orphans.", "These now return a clean 404 (fixed), so they no longer read as server errors."], confidence: 85, evidence: `code=OBJECT_MISSING` });

  // Probe failures → infra insight.
  if (!dbPing.ok) push({ area: "Infrastructure", severity: "critical", title: "MySQL probe failing", what: "The database health probe is failing.", why: ["The DB is the hard dependency — this is a platform-side outage, not a code bug."], affected: "Everything", recommendation: ["Check the DB container/host and network immediately."], confidence: 95, evidence: dbPing.error || "probe failed" });
  if (!storagePing.ok) push({ area: "Infrastructure", severity: "critical", title: "Object storage probe failing", what: "The storage (S3/MinIO) probe is failing.", why: ["Uploads/downloads and avatars will fail — infra side."], affected: "Files, avatars, recordings", recommendation: ["Check the MinIO/S3 endpoint + credentials."], confidence: 92, evidence: storagePing.error || "probe failed" });
  if (redis?.configured && !redisPing.ok) push({ area: "Infrastructure", severity: "warning", title: "Redis probe failing", what: "Redis is unreachable.", why: ["Caching + presence degrade; DB load rises."], affected: "Cache + presence", recommendation: ["Check the Redis container/host."], confidence: 88, evidence: redisPing.error || "probe failed" });

  const order: Record<string, number> = { critical: 0, warning: 1, info: 2, good: 3 };
  insights.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  if (insights.length === 0)
    insights.push({ area: "Platform", severity: "good", title: "No issues detected", what: "All probes green, no error spikes, resources within limits.", why: ["Health signals are nominal."], affected: "None", recommendation: ["Nothing to do — keep monitoring."], confidence: 90, evidence: "all green" });
  res.json({ ok: true, generatedAt: Date.now(), insights });
});

// ── /users-health — per-user error rollup ("track the CEO's experience") ─────
router.get("/users-health", async (req, res) => {
  const range = String(req.query.range || "7d");
  const list = await unifiedErrors(range);
  const byUser = new Map<string, any>();
  for (const e of list) {
    if (!e.user || !e.user.id) continue; // skip anonymous / backend-no-user
    let u = byUser.get(e.user.id);
    if (!u) {
      u = { id: e.user.id, name: userLabel(e.user), email: e.user.email || null, total: 0, e2ee: 0, groups: 0, worst: 3, devices: new Set<string>(), browsers: new Set<string>(), os: new Set<string>(), locations: new Set<string>(), categories: {} as Record<string, number>, lastSeen: 0, top: [] as any[] };
      byUser.set(e.user.id, u);
    }
    u.total += e.count;
    u.groups += 1;
    if (e.category === "e2ee") u.e2ee += e.count;
    u.worst = Math.min(u.worst, e.priority);
    if (e.device) {
      u.devices.add(`${e.device.browser} · ${e.device.os} · ${e.device.platform}`);
      if (e.device.browser && e.device.browser !== "Unknown") u.browsers.add(e.device.browser);
      if (e.device.os && e.device.os !== "Unknown") u.os.add(e.device.os);
    }
    if (e.location && (e.location.city || e.location.country)) u.locations.add([e.location.city, e.location.country].filter(Boolean).join(", "));
    u.categories[e.category] = (u.categories[e.category] || 0) + e.count;
    const ls = new Date(e.lastSeen).getTime();
    if (ls > u.lastSeen) u.lastSeen = ls;
    if (u.top.length < 4) u.top.push({ message: e.message.slice(0, 110), count: e.count, priority: PRIORITY_META[e.priority], category: e.category });
  }
  const users = [...byUser.values()]
    .map((u) => ({ ...u, devices: [...u.devices], browsers: [...u.browsers], os: [...u.os], locations: [...u.locations], worstLabel: PRIORITY_META[u.worst] }))
    .sort((a, b) => a.worst - b.worst || b.total - a.total);
  res.json({ ok: true, generatedAt: Date.now(), range, users });
});

// ── /e2ee-health — E2EE failures by kind / user / device ─────────────────────
router.get("/e2ee-health", async (req, res) => {
  const range = String(req.query.range || "7d");
  const list = (await unifiedErrors(range)).filter((e) => e.category === "e2ee");
  const totalOcc = list.reduce((s, e) => s + e.count, 0);
  const byKind: Record<string, number> = {};
  const byDevice: Record<string, number> = {};
  const byUser = new Map<string, any>();
  const affected = new Set<string>();
  for (const e of list) {
    const kind = e.code || "other";
    byKind[kind] = (byKind[kind] || 0) + e.count;
    if (e.device) {
      const d = `${e.device.browser} · ${e.device.os} · ${e.device.platform}`;
      byDevice[d] = (byDevice[d] || 0) + e.count;
    }
    if (e.user && e.user.id) {
      affected.add(e.user.id);
      const u = byUser.get(e.user.id) || { id: e.user.id, name: userLabel(e.user), count: 0, kinds: new Set<string>() };
      u.count += e.count;
      u.kinds.add(kind);
      byUser.set(e.user.id, u);
    }
  }
  res.json({
    ok: true,
    generatedAt: Date.now(),
    range,
    totalOccurrences: totalOcc,
    groups: list.length,
    affectedUsers: affected.size,
    byKind: Object.entries(byKind).map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    byUser: [...byUser.values()].map((u) => ({ id: u.id, name: u.name, count: u.count, kinds: [...u.kinds] })).sort((a, b) => b.count - a.count).slice(0, 25),
    byDevice: Object.entries(byDevice).map(([device, count]) => ({ device, count })).sort((a, b) => b.count - a.count),
    issues: list.slice(0, 60).map((e) => ({ id: e.id, kind: e.code, message: e.message, count: e.count, user: userLabel(e.user), device: e.device ? `${e.device.browser} / ${e.device.os}` : null, priority: PRIORITY_META[e.priority], lastSeen: e.lastSeen })),
  });
});

// ── /e2ee-devices — every user's E2EE identity keys per device ───────────────
// Dev-admin view of the server-blind E2EE key directory: for EVERY user, the
// per-device PUBLIC key material they have published — the ECDH identity key
// (encrypt/decrypt identity), the ECDSA signing key (sender authentication),
// the Double-Ratchet initial DH key, the signed pre-key (X3DH), the one-time
// pre-keys (forward secrecy, with consumed state) and conversation-key rows.
// Public keys ONLY — never private halves, never decryptable ciphertext, never
// message content. The existing `q` helper degrades to [] if the E2EE tables
// aren't migrated, so this endpoint stays safe on non-E2EE deployments.
router.get("/e2ee-devices", async (_req, res) => {
  const deviceRows = await q(
    `SELECT u.id AS user_id, u.name AS uname, u.email AS uemail,
            d.id, d.name AS dname, d.identity_key, d.signing_key,
            d.ratchet_initial_key, d.signed_pre_key, d.one_time_pre_key_count,
            d.trusted, d.revoked, d.created_at, d.updated_at, d.last_seen_at
       FROM e2ee_devices d
       JOIN users u ON u.id = d.user_id
      ORDER BY u.name ASC, u.email ASC, d.created_at ASC
      LIMIT 2000`,
  );
  const deviceIds = (deviceRows as any[]).map((r) => r.id);
  const [prekeyRows, convRows] = await Promise.all([
    deviceIds.length
      ? q(
          `SELECT device_id, key_id, public_key, consumed_at, created_at
             FROM e2ee_one_time_prekeys
            WHERE device_id IN (${deviceIds.map(() => "?").join(",")})
            ORDER BY device_id, key_id
            LIMIT 4000`,
          deviceIds,
        )
      : Promise.resolve([]),
    deviceIds.length
      ? q(`SELECT device_id, COUNT(*) AS c FROM e2ee_conversation_keys GROUP BY device_id`)
      : Promise.resolve([]),
  ]);
  const convCount = new Map<string, number>();
  for (const r of (convRows as any[]) || []) convCount.set(String(r.device_id), num(r.c));
  const prekeysByDevice = new Map<string, any[]>();
  for (const r of (prekeyRows as any[]) || []) {
    const arr = prekeysByDevice.get(String(r.device_id)) || [];
    arr.push({
      keyId: r.key_id,
      publicKey: r.public_key,
      consumedAt: r.consumed_at || null,
      createdAt: r.created_at,
    });
    prekeysByDevice.set(String(r.device_id), arr);
  }
  const users = new Map<string, any>();
  for (const r of deviceRows as any[]) {
    let u = users.get(r.user_id);
    if (!u) {
      u = {
        id: r.user_id,
        name: r.uname || r.uemail || r.user_id,
        email: r.uemail || null,
        deviceCount: 0,
        trustedDevices: 0,
        pendingDevices: 0,
        revokedDevices: 0,
        devices: [],
      };
      users.set(r.user_id, u);
    }
    const opks = prekeysByDevice.get(String(r.id)) || [];
    u.devices.push({
      id: r.id,
      name: r.dname || null,
      identityKey: r.identity_key,
      signingKey: r.signing_key || null,
      ratchetInitialKey: r.ratchet_initial_key || null,
      signedPreKey: safeJson(r.signed_pre_key),
      oneTimePreKeyCount: num(r.one_time_pre_key_count),
      oneTimePreKeys: opks,
      conversationKeyCount: convCount.get(String(r.id)) || 0,
      trusted: !!r.trusted,
      revoked: !!r.revoked,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastSeenAt: r.last_seen_at || null,
    });
    u.deviceCount++;
    if (r.revoked) u.revokedDevices++;
    else if (r.trusted) u.trustedDevices++;
    else u.pendingDevices++;
  }
  res.json({
    ok: true,
    generatedAt: Date.now(),
    totalDevices: deviceRows.length,
    totalUsers: users.size,
    pendingDevices: [...users.values()].reduce((s, u) => s + u.pendingDevices, 0),
    revokedDevices: [...users.values()].reduce((s, u) => s + u.revokedDevices, 0),
    users: [...users.values()],
  });
});

// ── /report — one payload for the downloadable management report ─────────────
router.get("/report", async (req, res) => {
  const range = String(req.query.range || "7d");
  const [core, list, deps] = await Promise.all([gatherCore(), unifiedErrors(range), listDeployments(8)]);
  const byPriority = [0, 0, 0, 0];
  const byDomain: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byScope: Record<string, number> = { backend: 0, client: 0 };
  const affected = new Set<string>();
  let totalOcc = 0;
  let e2eeOcc = 0;
  for (const e of list) {
    byPriority[e.priority] += e.count;
    byDomain[e.domain] = (byDomain[e.domain] || 0) + e.count;
    byCategory[e.category] = (byCategory[e.category] || 0) + e.count;
    byScope[e.scope] = (byScope[e.scope] || 0) + e.count;
    totalOcc += e.count;
    if (e.category === "e2ee") e2eeOcc += e.count;
    if (e.user && e.user.id) affected.add(e.user.id);
  }
  const topIssues = [...list].sort((a, b) => a.priority - b.priority || b.count - a.count).slice(0, 12)
    .map((e) => ({ priority: PRIORITY_META[e.priority], level: e.level, domain: e.domain, category: e.category, message: e.message.slice(0, 140), count: e.count, user: userLabel(e.user), device: e.device ? `${e.device.browser}/${e.device.os}` : null, scope: e.scope }));
  res.json({
    ok: true,
    generatedAt: Date.now(),
    range,
    server: { env: config.env, version: config.version, hostname: os.hostname() },
    health: { db: core.dbPing.ok, storage: core.storagePing.ok, redis: config.redis?.url ? core.redisPing.ok : null },
    totals: { groups: list.length, occurrences: totalOcc, affectedUsers: affected.size, e2eeOccurrences: e2eeOcc },
    byPriority: byPriority.map((count, i) => ({ priority: PRIORITY_META[i], count })),
    byDomain: Object.entries(byDomain).map(([k, v]) => ({ key: k, label: DOMAIN_META[k]?.label || k, count: v })).sort((a, b) => b.count - a.count),
    byCategory: Object.entries(byCategory).map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count),
    byScope,
    topIssues,
    deployments: deps.map((d: any) => ({ version: d.version, kind: d.kind, at: new Date(d.started_at).getTime(), gitCommit: d.git_commit })),
  });
});

// ── /config — real runtime configuration & feature flags ─────────────────────
router.get("/config", (_req, res) => {
  const cfg: any = config;
  const flag = (key: string, on: boolean, group: string, desc: string) => ({ key, on: !!on, group, desc });
  res.json({
    ok: true,
    generatedAt: Date.now(),
    env: config.env,
    version: config.version,
    flags: [
      flag("End-to-end encryption", !!cfg.e2ee?.enabled, "Security", "Message content is E2E-encrypted; the server never sees plaintext."),
      flag("E2EE device-bound (strict)", !!cfg.e2ee?.deviceBoundStrict, "Security", "Tokens without a registered device are rejected."),
      flag("Self-service signup", !!cfg.auth?.signupEnabled, "Auth", "Anyone can register (vs admin/SSO-provisioned only)."),
      flag("SSO (OpenID Connect)", String(process.env.SSO_ENABLED || "") === "true", "Auth", "Single sign-on via an external IdP."),
      flag("Demo mode", !!cfg.features?.demoMode, "Platform", "Runs against the demo dataset."),
      flag("Redis cache", !!cfg.redis?.url, "Infrastructure", "Cache + presence layer."),
      flag("LiveKit (calls/meetings)", !!(cfg.livekit?.serverUrl || cfg.livekit?.wsUrl), "Infrastructure", "Realtime audio/video SFU."),
      flag("GIPHY media search", !!process.env.GIPHY_API_KEY, "Media", "GIF/sticker search provider."),
      flag("Engineering portal", !!cfg.ops?.portalPassword, "Platform", "This Observatory portal is enabled."),
    ],
  });
});

// ── /search — unified telemetry search across errors, users & deployments ────
router.get("/search", async (req, res) => {
  const qs = String(req.query.q || "").trim().toLowerCase();
  if (!qs) return res.json({ ok: true, q: "", errors: [], users: [], deployments: [] });
  const [list, deps] = await Promise.all([unifiedErrors("30d"), listDeployments(40)]);
  const errors = list
    .filter((e) => e.message.toLowerCase().includes(qs) || (e.requestPath || "").toLowerCase().includes(qs) || (e.code || "").toLowerCase().includes(qs) || userLabel(e.user).toLowerCase().includes(qs))
    .slice(0, 25)
    .map((e) => ({ id: e.id, message: e.message.slice(0, 140), level: e.level, category: e.category, priority: PRIORITY_META[e.priority], user: userLabel(e.user), device: e.device ? `${e.device.browser}/${e.device.os}` : null, count: e.count, lastSeen: e.lastSeen }));
  // users who match by name/email AND have errors
  const userMap = new Map<string, any>();
  for (const e of list) {
    if (!e.user || !e.user.id) continue;
    if (!userLabel(e.user).toLowerCase().includes(qs) && !(e.user.email || "").toLowerCase().includes(qs)) continue;
    const u = userMap.get(e.user.id) || { id: e.user.id, name: userLabel(e.user), email: e.user.email || null, count: 0, worst: 3 };
    u.count += e.count;
    u.worst = Math.min(u.worst, e.priority);
    userMap.set(e.user.id, u);
  }
  const users = [...userMap.values()].map((u) => ({ ...u, worstLabel: PRIORITY_META[u.worst] })).sort((a, b) => a.worst - b.worst).slice(0, 15);
  const deployments = deps
    .filter((d: any) => String(d.version || "").toLowerCase().includes(qs) || String(d.git_commit || "").toLowerCase().includes(qs) || String(d.kind || "").toLowerCase().includes(qs))
    .slice(0, 10)
    .map((d: any) => ({ version: d.version, kind: d.kind, gitCommit: d.git_commit, at: new Date(d.started_at).getTime() }));
  res.json({ ok: true, q: qs, errors, users, deployments });
});

// ── /architecture — evidence-backed code analysis + LIVE efficiency signals ──
// Serves the static analysis artifact (findings typed observed/recommendation/
// prediction, each citing a real file+metric) blended with runtime signals
// measured right now — so nothing is presented as a fact unless it was measured.
router.get("/architecture", async (_req, res) => {
  const core = await gatherCore();
  const { status, vars, redis, cpuPct, mem } = core;
  const total = num(redis.hits) + num(redis.misses);
  const cacheHitRate = redis?.configured && redis?.ok && total > 0 ? Math.round((redis.hits / total) * 100) : null;
  const conns = num(status["Threads_connected"]);
  const maxConns = num(vars["max_connections"]) || 151;
  // Trend across scans (review Block 3): snapshot THIS scan's scorecard keyed by
  // the artifact's generatedAt (repeat polls dedupe on the PK), then read back the
  // last dozen scans so the dashboard can chart movement. All best-effort via q()
  // (returns [] on any error, incl. before migration 0110 runs) — never fails the
  // /dev endpoint, writes nothing outside eng_score_history.
  const overallScore =
    (architecture.scores || []).find((s: any) => s.key === "overallEngineering")?.score ??
    ((architecture.scores || []).length
      ? Math.round(
          (architecture.scores || []).reduce((a: number, x: any) => a + (x.score || 0), 0) /
            (architecture.scores || []).length,
        )
      : null);
  let trend: { at: number; overall: number | null }[] = [];
  if (architecture.generatedAt) {
    await q(
      "INSERT INTO eng_score_history (generated_at, overall, scores, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE overall=VALUES(overall), scores=VALUES(scores)",
      [architecture.generatedAt, overallScore, JSON.stringify(architecture.scores || []), Date.now()],
    );
    const rows = await q(
      "SELECT generated_at, overall FROM eng_score_history ORDER BY generated_at DESC LIMIT 12",
    );
    trend = rows
      .map((r: any) => ({
        at: Number(r.generated_at),
        overall: r.overall == null ? null : Number(r.overall),
      }))
      .reverse(); // ascending for the chart
  }
  res.json({
    ok: true,
    generatedAt: architecture.generatedAt,
    stale: !architecture.generatedAt,
    findings: architecture.findings,
    scores: architecture.scores,
    cto: architecture.cto,
    trend,
    // LIVE, measured-now signals (kept separate from the static findings).
    live: {
      cpuPct,
      memPct: os.totalmem() ? Math.round((mem.rss / os.totalmem()) * 100) : 0,
      cacheConfigured: !!redis?.configured,
      cacheHitRate, // real hit rate; null when Redis is absent or has no traffic yet
      cacheLookups: total,
      slowQueries: num(status["Slow_queries"]),
      queries: num(status["Queries"]),
      dbConnPct: maxConns ? Math.round((conns / maxConns) * 100) : 0,
    },
  });
});

export default router;
