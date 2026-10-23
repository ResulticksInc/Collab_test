import { api } from "./api";

// GLOBAL CLIENT ERROR REPORTER → the backend error ledger (error_logs table).
// Captures window "error" + "unhandledrejection" and ships them best-effort.
// Safety rules mirror the backend service:
//   • never throws, never awaited by callers;
//   • per-SESSION dedup by fingerprint (the backend dedups rows too, but this
//     saves the network chatter of a hot render-loop error);
//   • hard cap per session so a pathological page can't spam the API;
//   • reporting failures are swallowed — an offline app must not error-loop
//     over reporting its errors.
const seen = new Set<string>();
let sent = 0;
const MAX_PER_SESSION = 25;
let tokenRef: { current: string | null } = { current: null };

const fp = (msg: string, stack: string) => {
  const top =
    stack
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith("at ")) || "";
  return msg.slice(0, 160) + "|" + top;
};

function ship(message: string, stack: string, code?: string) {
  try {
    if (!tokenRef.current || sent >= MAX_PER_SESSION) return;
    const key = fp(message, stack);
    if (seen.has(key)) return;
    seen.add(key);
    sent++;
    api
      .reportClientError(tokenRef.current, {
        message: String(message).slice(0, 2000),
        stack: String(stack || "").slice(0, 8000),
        code: code || null,
        url:
          typeof location !== "undefined"
            ? location.pathname + location.search
            : "",
      })
      .catch(() => {});
  } catch (_) {
    /* never let the reporter become the error */
  }
}

// Idempotent: CoLabV1 calls this on mount with a live token ref; repeated calls
// only refresh the ref (listeners attach once).
let installed = false;
export function installErrorReporter(ref: { current: string | null }) {
  tokenRef = ref;
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e: ErrorEvent) => {
    // Resource-load errors (img/script) surface as plain Events with no message
    // — skip them; they're network noise, not app defects.
    if (!e || !e.message) return;
    ship(e.message, (e.error && e.error.stack) || `at ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r: any = e && e.reason;
    ship(
      (r && r.message) || String(r || "unhandled rejection"),
      (r && r.stack) || "",
      r && r.code,
    );
  });
}
