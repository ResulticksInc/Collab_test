import { createHash } from "crypto";
import { db, config, currentOrgId } from "../platform";

// ── ERROR LEDGER SERVICE ─────────────────────────────────────────────────────
// One fail-safe entry point every capture site funnels through: the express
// error middleware, the process-level uncaught/unhandled hooks, and the
// /api/logs/client route (frontend reports). Rules this must never break:
//
//   1. record() NEVER throws and NEVER awaits into its caller's latency —
//      an error logger that can crash (or slow) the app is worse than none.
//   2. No recursion: if writing the ledger itself fails, that failure goes to
//      console ONLY, and a short circuit-breaker stops further DB attempts —
//      a dead DB would otherwise generate an error per log per request.
//   3. Dedup lives in the DRIVER (fingerprint + open-status upsert), so a
//      hot loop error becomes one row with a climbing `occurrences`, not a
//      table flood.

let breakerUntil = 0; // ms epoch — while in the future, skip DB writes
let consecutiveFailures = 0;

// Stable-ish grouping key: source + code + the message's head + the top stack
// frame. Message TAILS often vary per occurrence (ids, addresses), so only the
// head participates; the top frame pins the throw site.
export function fingerprintOf(e: {
  source?: string;
  code?: any;
  message?: any;
  stack?: any;
}): string {
  const topFrame =
    String(e.stack || "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("at ")) || "";
  return createHash("sha1")
    .update(
      [e.source || "backend", e.code || "", String(e.message || "").slice(0, 160), topFrame].join(
        "|",
      ),
    )
    .digest("hex");
}

// AUTO-CLASSIFY the owning dependency at capture time, so every row lands with
// dev | infra | external already set — triage can override it on resolve, but
// the ledger is filterable by owner from the first occurrence.
//   infra    → connectivity/resource failures: DB/Redis/storage unreachable,
//              pools exhausted, timeouts, disk/memory — fix lives in servers.
//   external → a third-party service misbehaving (IdP/SSO, GIPHY, web-push,
//              link previews) — fix is theirs; ours is at most a guard.
//   dev      → everything else: real application defects (TypeErrors, bad
//              queries, contract violations). Frontend errors default here.
const INFRA_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "ENOSPC", "EMFILE", "ENOMEM",
  "PROTOCOL_CONNECTION_LOST", "ER_CON_COUNT_ERROR", "ER_TOO_MANY_USER_CONNECTIONS",
  "POOL_CLOSED", "POOL_ENQUEUELIMIT",
]);
const EXTERNAL_HINTS = /giphy|deepl|web-?push|vapid|sso|oauth|openid|idp|jwks|link-?preview|s3|minio|livekit/i;
export function classifyDependency(e: {
  source?: string;
  code?: any;
  message?: any;
  stack?: any;
}): "infra" | "external" | "dev" {
  const code = String(e.code || "").toUpperCase();
  const msg = String(e.message || "");
  if (INFRA_CODES.has(code)) return "infra";
  if (/timed? ?out|connection (lost|refused|reset)|too many connections|pool .*exhaust|no space left|out of memory/i.test(msg))
    return "infra";
  // External calls betray themselves by the service name in the message/stack.
  if (EXTERNAL_HINTS.test(msg) || EXTERNAL_HINTS.test(String(e.stack || "").split("\n")[1] || ""))
    return "external";
  return "dev";
}

export function record(e: {
  source?: "backend" | "frontend" | "process" | "socket";
  severity?: "error" | "warn" | "fatal";
  code?: any;
  message: any;
  stack?: any;
  context?: any;
  requestPath?: string | null;
  userId?: string | null;
  organizationId?: string | null;
}): void {
  try {
    const row = {
      env: config?.env || process.env.NODE_ENV || "unknown",
      source: e.source || "backend",
      severity: e.severity || "error",
      code: e.code != null ? String(e.code) : null,
      message: String(e.message || "unknown error"),
      stack: e.stack ? String(e.stack) : null,
      context: e.context || null,
      requestPath: e.requestPath || null,
      userId: e.userId || null,
      // Prefer the explicit org, else whatever tenant context the request ran in.
      organizationId: e.organizationId || safeOrgId(),
      dependency: classifyDependency(e),
      fingerprint: "",
    };
    row.fingerprint = fingerprintOf(row);
    if (Date.now() < breakerUntil) return; // ledger writes paused — console already has it
    // Fire-and-forget: the caller's request must never wait on the ledger.
    Promise.resolve(db.errorLogs.record(row)).then(
      () => {
        consecutiveFailures = 0;
      },
      (err: any) => {
        consecutiveFailures++;
        console.error("[error-ledger] write failed:", err?.message || err);
        // 3 straight failures → the store itself is down; stop trying for 60s
        // so a dead DB doesn't get a doomed INSERT per logged error.
        if (consecutiveFailures >= 3) breakerUntil = Date.now() + 60_000;
      },
    );
  } catch (err: any) {
    // Absolute backstop — a logger must never take the process down.
    try {
      console.error("[error-ledger] record() itself failed:", err?.message || err);
    } catch (_) {
      /* nothing left to do */
    }
  }
}

function safeOrgId(): string | null {
  try {
    return currentOrgId() || null;
  } catch (_) {
    return null;
  }
}
