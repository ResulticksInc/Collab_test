// ── Structured client logger ────────────────────────────────────────────────
// One place every meaningful client event flows through. Two consumers:
//   1) the browser DevTools console — color-coded, prefixed, with the "what to
//      do" hint printed inline so a developer spots the cause at a glance;
//   2) the in-app Diagnostics panel (components/DiagnosticsPanel.tsx) — a
//      human-readable, copy-able report so a NON-engineer can see "what's wrong"
//      and send it to support.
//
// Design goals: zero deps, SSR-safe (guards window/console), a bounded ring
// buffer (no leak), and EVERY error carries a plain-English direction.

export type LogLevel = "info" | "success" | "warn" | "error";
export type LogCategory =
  | "app"
  | "auth"
  | "server"
  | "realtime"
  | "call"
  | "meeting"
  | "media"
  | "data";

export interface LogEntry {
  id: number;
  ts: number; // epoch ms
  iso: string;
  level: LogLevel;
  category: LogCategory;
  message: string; // plain-English: what happened
  hint?: string; // plain-English: what it means / what to do
  data?: any; // optional structured detail (kept out of the report text)
}

const BUF_MAX = 400; // ring buffer cap — last N events
const buf: LogEntry[] = [];
let seq = 0;
const subs = new Set<(entries: LogEntry[]) => void>();
// Per-event subscribers for ERROR-level entries only. Used by the server-side
// telemetry hook (lib/telemetry.ts) to forward errors for aggregation WITHOUT
// re-hooking window.onerror (initGlobalLogging already routes those into log.error).
const errorSubs = new Set<(entry: LogEntry) => void>();

const ICON: Record<LogLevel, string> = {
  info: "•",
  success: "✅",
  warn: "⚠️",
  error: "❌",
};
const CSS: Record<LogLevel, string> = {
  info: "color:#64748b",
  success: "color:#16a34a;font-weight:600",
  warn: "color:#d97706;font-weight:600",
  error: "color:#dc2626;font-weight:700",
};

function notify() {
  const snap = buf.slice();
  subs.forEach((s) => {
    try {
      s(snap);
    } catch {
      /* a bad subscriber must never break logging */
    }
  });
}

export function logEvent(
  level: LogLevel,
  category: LogCategory,
  message: string,
  opts?: { hint?: string; data?: any },
): LogEntry {
  const now = Date.now();
  const entry: LogEntry = {
    id: ++seq,
    ts: now,
    iso: new Date(now).toISOString(),
    level,
    category,
    message,
    hint: opts && opts.hint,
    data: opts && opts.data,
  };
  buf.push(entry);
  if (buf.length > BUF_MAX) buf.shift();

  // Console mirror — readable, color-coded, hint inline.
  try {
    if (typeof console !== "undefined") {
      const tag = `%c${ICON[level]} Collab·${category}`;
      const line = `${message}${entry.hint ? `  💡 ${entry.hint}` : ""}`;
      const fn =
        level === "error"
          ? console.error
          : level === "warn"
            ? console.warn
            : console.log;
      if (entry.data !== undefined) fn(tag, CSS[level], line, entry.data);
      else fn(tag, CSS[level], line);
    }
  } catch {
    /* console can throw in odd embeds — never let it break the app */
  }

  notify();
  // Fan out errors to per-event subscribers (telemetry). Guarded so a throwing
  // subscriber — or telemetry that itself errored — can never break logging or
  // loop back into more telemetry.
  if (level === "error" && errorSubs.size) {
    errorSubs.forEach((s) => {
      try {
        s(entry);
      } catch {
        /* a bad error subscriber must never break logging */
      }
    });
  }
  return entry;
}

export const log = {
  info: (c: LogCategory, m: string, o?: { hint?: string; data?: any }) =>
    logEvent("info", c, m, o),
  success: (c: LogCategory, m: string, o?: { hint?: string; data?: any }) =>
    logEvent("success", c, m, o),
  warn: (c: LogCategory, m: string, o?: { hint?: string; data?: any }) =>
    logEvent("warn", c, m, o),
  error: (c: LogCategory, m: string, o?: { hint?: string; data?: any }) =>
    logEvent("error", c, m, o),
};

export function getLogs(): LogEntry[] {
  return buf.slice();
}

export function subscribeLogs(fn: (entries: LogEntry[]) => void): () => void {
  subs.add(fn);
  fn(buf.slice());
  return () => {
    subs.delete(fn);
  };
}

export function clearLogs() {
  buf.length = 0;
  notify();
}

// Subscribe to ERROR-level log entries as they happen (one callback per error).
// Used by the telemetry hook to forward errors server-side for aggregation.
export function subscribeErrors(fn: (entry: LogEntry) => void): () => void {
  errorSubs.add(fn);
  return () => {
    errorSubs.delete(fn);
  };
}

// Turn an arbitrary error / promise-rejection reason into a MEANINGFUL one-line
// message. A bare `String(reason)` yields the useless "[object Event]" for the
// DOM Event objects that failed media/resource loads and aborted requests reject
// with — an unactionable row on the ops board. Extract the event type + target
// instead, so the operator sees e.g. "error on video (blob:…)" not "[object Event]".
export function describeReason(r: any): string {
  if (r == null) return "unknown";
  if (typeof r === "string") return r;
  if (typeof r.message === "string" && r.message) return r.message;
  // DOM Event / ErrorEvent (failed <video>/<img>/<audio> load, aborted fetch):
  // no `.message`, so String(r) is "[object Event]". Pull type + target detail.
  if (typeof Event !== "undefined" && r instanceof Event) {
    const t: any = (r as any).target || {};
    const ctor = t.constructor && t.constructor.name;
    const where = t.tagName
      ? String(t.tagName).toLowerCase()
      : ctor && ctor !== "Object"
        ? String(ctor).toLowerCase() // e.g. "websocket", "xmlhttprequest"
        : "";
    const src = t.currentSrc || t.src || t.url || "";
    const mediaCode =
      t.error && typeof t.error.code !== "undefined" ? `code=${t.error.code}` : "";
    // An "error"-type Event is a failed resource/media load; other types keep
    // their name (e.g. "abort event"). Avoids the redundant "error error".
    const label =
      (r as any).type === "error" ? "resource error" : `${(r as any).type || "event"} event`;
    return [label, where && `on ${where}`, src && `(${String(src).slice(0, 120)})`, mediaCode]
      .filter(Boolean)
      .join(" ");
  }
  const s = String(r);
  if (s !== "[object Object]") return s;
  try {
    const j = JSON.stringify(r);
    if (j && j !== "{}") return j.slice(0, 200);
  } catch {
    /* circular — fall through */
  }
  return "unknown error";
}

// Map an HTTP status to a plain-English direction for the user. Centralised so
// every API error speaks the same language.
export function hintForStatus(status: number, serverMessage?: string): string {
  if (status === 0)
    return "Couldn't reach the server — check your internet connection, then retry.";
  if (status === 401) return "Your session expired — sign in again.";
  if (status === 403)
    return (
      serverMessage ||
      "You don't have access to this. If unexpected, ask an admin."
    );
  if (status === 404)
    return "That item no longer exists (it may have been removed).";
  if (status === 408 || status === 504)
    return "The server took too long — usually a slow network. Retry.";
  if (status === 413) return "The file/message is too large.";
  if (status === 429) return "Too many requests — wait a moment and retry.";
  if (status >= 500)
    return "The server hit an error — retry shortly; if it persists, contact support with the diagnostics report.";
  return serverMessage || "Request failed.";
}

// A shareable plain-text report (environment + recent events) for support/dev.
// Intentionally text-only (no `data` blobs) so it pastes cleanly into a ticket.
export function buildReport(): string {
  const head = [
    `Collab diagnostics report — ${new Date().toISOString()}`,
    typeof location !== "undefined" ? `URL:   ${location.href}` : "",
    typeof navigator !== "undefined" ? `Agent: ${navigator.userAgent}` : "",
    typeof navigator !== "undefined" ? `Online: ${navigator.onLine}` : "",
    "",
    `Last ${buf.length} events (newest last):`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
  const lines = buf.map((e) => {
    const t = e.iso.slice(11, 23);
    const lvl = e.level.toUpperCase().padEnd(7);
    return `${t}  ${lvl} [${e.category}] ${e.message}${e.hint ? `  →  ${e.hint}` : ""}`;
  });
  return `${head}${lines.join("\n")}\n`;
}

// One-time global capture: uncaught errors, unhandled promise rejections, and
// online/offline transitions. Idempotent; safe to call on every mount.
let globalsInit = false;
export function initGlobalLogging() {
  if (globalsInit || typeof window === "undefined") return;
  globalsInit = true;
  window.addEventListener("error", (e) => {
    log.error("app", `Unexpected error: ${e.message || "script error"}`, {
      hint: "An unhandled error occurred. If something looks broken, reload — and copy the diagnostics report if it recurs.",
      data: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    log.error("app", `Unhandled rejection: ${describeReason(e.reason)}`, {
      hint: "A background task failed — usually safe to retry the action.",
    });
  });
  window.addEventListener("offline", () =>
    log.warn("app", "You went offline", {
      hint: "No internet connection — messages and calls resume when you're back online.",
    }),
  );
  window.addEventListener("online", () =>
    log.success("app", "Back online", { hint: "Connection restored." }),
  );
  // Console command API — type these in DevTools (works on the live site too):
  //   colabLogs.open()   open the Diagnostics panel
  //   colabLogs.copy()   copy the shareable report to the clipboard
  //   colabLogs.dump()   print the full report to the console + return raw events
  //   colabLogs.errors() print only the warnings/errors
  //   colabLogs.clear()  clear the buffer
  //   colabLogs.help()   list these commands
  const api = {
    open: () =>
      (window as any).__colabDiag
        ? (window as any).__colabDiag()
        : "open the app first",
    copy: () => {
      try {
        navigator.clipboard.writeText(buildReport());
        return "copied ✓";
      } catch {
        return buildReport();
      }
    },
    dump: () => {
      // eslint-disable-next-line no-console
      console.log(buildReport());
      return getLogs();
    },
    errors: () =>
      getLogs().filter((e) => e.level === "warn" || e.level === "error"),
    clear: () => {
      clearLogs();
      return "cleared";
    },
    get: () => getLogs(),
    help: () =>
      "colabLogs: open() · copy() · dump() · errors() · clear() · get()",
  };
  (window as any).colabLogs = api;
  log.info("app", "Diagnostics ready", {
    hint: "Open the panel with Ctrl+Alt+D or ?diag=1, or type colabLogs.help() in the console.",
  });
}
