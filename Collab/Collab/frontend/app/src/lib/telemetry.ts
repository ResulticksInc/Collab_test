// ── Server-side error telemetry (client) ────────────────────────────────────
// Cost-free, dependency-free production observability. Buffers uncaught errors,
// unhandled rejections, and logged errors, then flushes a small BATCH to
// POST /api/telemetry/error so the operator can SEE failures across ALL users
// (not just in one local DevTools console). The server fingerprints + groups
// them so a recurring error is ONE row, not millions.
//
// Design rules (all enforced below):
//   • ERROR telemetry, NOT content — we send the error message + stack + url +
//     app version + level. Never message bodies / payloads.
//   • Fire-and-forget + no-op-safe: SSR-guarded, never throws, never blocks.
//   • Never loops on its own failure: the flush uses the `silent` api path so a
//     failed telemetry POST does NOT call log.error (which would re-queue), and
//     a flush error is swallowed.
//   • Bounded: per-session dedupe by fingerprint, throttle, hard queue cap.

import { api } from "./api";
import { subscribeErrors, describeReason, type LogEntry } from "./logger";

interface QueuedError {
  level: string;
  category?: string;
  message: string;
  stack?: string;
  url?: string;
  appVersion?: string;
  context?: Record<string, string>;
}

const QUEUE_MAX = 50; // hard cap — never buffer more than this
const BATCH_MAX = 20; // matches the server's per-request cap
const FLUSH_DEBOUNCE_MS = 4000; // coalesce bursts into one batch
const DEDUPE_TTL_MS = 60_000; // same fingerprint at most once per minute/session

let installed = false;
let queue: QueuedError[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
// Session-local dedupe: fingerprint -> last-sent epoch ms.
const seen = new Map<string, number>();

// Build-time app version for grouping client builds. Falls back gracefully.
const APP_VERSION =
  (typeof process !== "undefined" &&
    (process.env.NEXT_PUBLIC_APP_VERSION ||
      process.env.NEXT_PUBLIC_BUILD_VERSION)) ||
  "";

// A cheap client-side fingerprint for DEDUPE ONLY (the server computes the
// authoritative grouping key). message + first stack line is enough to collapse
// a hot loop within a session.
function clientFingerprint(message: string, stack?: string): string {
  const top = (stack || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  return (message + "|" + top).slice(0, 300);
}

function currentRoute(): string | undefined {
  try {
    if (typeof location === "undefined") return undefined;
    // Path + hash (no query — it can carry tokens/ids we don't want to store).
    return (location.pathname + (location.hash || "")).slice(0, 512);
  } catch {
    return undefined;
  }
}

// Non-sensitive device fingerprint so the ops portal can pinpoint an issue to a
// specific person + device (web vs desktop app, which E2EE device, screen). The
// user_agent (browser/OS) is captured server-side from the request; this adds
// what the UA can't tell us. NEVER includes message content.
function deviceContext(): Record<string, string> {
  const ctx: Record<string, string> = {};
  try {
    const w = window as any;
    const isDesktop = !!(w.desktop || w.electronAPI || w.__TAURI__) || /electron/i.test(navigator.userAgent || "");
    ctx.platform = isDesktop ? "desktop" : "web";
    const appV = (w.desktop && (w.desktop.version || w.desktop.appVersion)) || APP_VERSION;
    if (appV) ctx.app = String(appV).slice(0, 32);
    const dev =
      localStorage.getItem("clb_e2ee_device") ||
      localStorage.getItem("e2ee_device_id") ||
      localStorage.getItem("clb_device_id");
    if (dev) ctx.deviceId = String(dev).slice(0, 40);
    if (typeof screen !== "undefined" && screen.width) ctx.screen = `${screen.width}x${screen.height}`;
  } catch {
    /* best-effort */
  }
  return ctx;
}

function enqueue(level: string, message: string, stack?: string, category?: string, extraContext?: Record<string, any>) {
  try {
    const msg = String(message || "").trim();
    if (!msg) return;
    const fp = clientFingerprint((category || "general") + "|" + msg, stack);
    const now = Date.now();
    const last = seen.get(fp);
    if (last && now - last < DEDUPE_TTL_MS) return; // throttle repeats
    seen.set(fp, now);
    // Bound the dedupe map alongside the queue.
    if (seen.size > QUEUE_MAX * 4) seen.clear();
    if (queue.length >= QUEUE_MAX) return; // drop on overflow (never grow)
    const context = { ...deviceContext(), ...(extraContext || {}) };
    queue.push({
      level: level || "error",
      category: category || "general",
      message: msg.slice(0, 4096),
      stack: stack ? String(stack).slice(0, 16384) : undefined,
      url: currentRoute(),
      appVersion: APP_VERSION || undefined,
      context,
    });
    scheduleFlush();
  } catch {
    /* telemetry must never throw into the app */
  }
}

// PUBLIC: explicitly capture a categorised issue (E2EE decrypt failure, realtime
// drop, media error, …) even when it wasn't a thrown exception. Content-safe:
// pass only ids/kinds in `extra` (conversationId, kind, deviceId) — never bodies.
export function captureIssue(category: string, message: string, extra?: Record<string, any>) {
  enqueue("error", message, undefined, category, extra);
}

// ── §9.2 usage events ───────────────────────────────────────────────────────
// Content-free product counters ("view.switch.speaker", "popout.open.docpip",
// "chat.jump_pill.tap", …) — names only, no payloads, aggregated per-day
// server-side. Same discipline as error telemetry: buffered, debounced,
// capped, and a flush failure is swallowed.
const EVENT_QUEUE_MAX = 100;
const EVENT_FLUSH_MS = 5000;
let eventQueue: string[] = [];
let eventTimer: ReturnType<typeof setTimeout> | null = null;

export function trackEvent(name: string) {
  try {
    if (typeof window === "undefined") return;
    if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(name)) return;
    if (eventQueue.length >= EVENT_QUEUE_MAX) return;
    eventQueue.push(name);
    if (eventTimer) return;
    eventTimer = setTimeout(() => {
      eventTimer = null;
      const batch = eventQueue.splice(0, 50);
      if (!batch.length) return;
      // Anonymous by design — the counters carry no user dimension at all.
      void api.reportEvents(undefined, batch).catch(() => {});
    }, EVENT_FLUSH_MS);
  } catch (_) {
    /* telemetry must never throw into the app */
  }
}

function scheduleFlush() {
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DEBOUNCE_MS);
}

async function flush() {
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue.slice(0, BATCH_MAX);
  queue = queue.slice(batch.length);
  try {
    let token: string | undefined;
    try {
      token = (typeof localStorage !== "undefined" && localStorage.getItem("clb_token")) || undefined;
    } catch {
      token = undefined;
    }
    // `api.reportClientErrors` uses the silent path → a failure here NEVER calls
    // log.error, so it can't loop back into the telemetry queue.
    await api.reportClientErrors(token, batch);
  } catch {
    // Swallow — telemetry is best-effort. We intentionally do NOT re-queue the
    // batch: re-queuing a failing POST would loop forever against a down server.
  } finally {
    flushing = false;
    if (queue.length) scheduleFlush(); // drain any remainder later
  }
}

// Install once at app root. Idempotent + SSR-safe. Hooks window error events AND
// taps the existing logger.error path (covers errors routed through the logger).
export function installTelemetry() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  // Tap the structured logger: every log.error (including the ones
  // initGlobalLogging raises from window.onerror / unhandledrejection) flows here.
  subscribeErrors((e: LogEntry) => {
    const stack =
      e.data && typeof e.data === "string" ? e.data : undefined;
    enqueue("error", e.message, stack);
  });

  // Direct window hooks as a belt-and-suspenders capture in case the structured
  // logger's global capture isn't installed (e.g. a code path that mounts
  // telemetry before DiagnosticsPanel). The per-session dedupe makes any overlap
  // with the logger tap a no-op, so we never double-report.
  window.addEventListener("error", (ev: ErrorEvent) => {
    const err = ev.error;
    enqueue(
      "error",
      (err && (err.message as string)) || ev.message || "script error",
      err && (err.stack as string),
    );
  });
  window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
    const r: any = ev.reason;
    // describeReason turns Event-shaped reasons into a real message instead of
    // the unactionable "[object Event]" that used to land on the ops board.
    enqueue("error", describeReason(r) || "unhandled rejection", r && r.stack);
  });

  // Best-effort final flush when the tab goes away (page hide is the reliable
  // mobile-safe lifecycle event). Fire-and-forget; never blocks unload.
  window.addEventListener("pagehide", () => {
    if (queue.length) void flush();
  });
}
