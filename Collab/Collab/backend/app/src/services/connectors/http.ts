// Unified Connector Engine — one bounded HTTP helper for every platform call.
//
// Every outbound request gets a hard timeout (a hung Graph/Slack call must not
// pin a worker), never follows redirects (a platform API has no business
// redirecting, and a 3xx to an internal address would be an SSRF hop), and
// surfaces failures as PlatformError with the retry decision already made.
import { PlatformError } from "./types";

interface HttpResult {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

export async function callJson(
  platform: string,
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: any; // object → JSON; string/URLSearchParams sent as-is
    timeoutMs: number;
  },
): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, opts.timeoutMs));
  const headers: Record<string, string> = { "user-agent": "CoLab-Connectors/1.0", ...(opts.headers || {}) };
  let body: any = undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body === "string" || opts.body instanceof URLSearchParams) body = opts.body;
    else {
      body = JSON.stringify(opts.body);
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }
  }
  let res: Response;
  try {
    res = await (globalThis as any).fetch(url, {
      method: opts.method || "GET",
      headers,
      body,
      redirect: "manual",
      signal: ctrl.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    const msg = e?.name === "AbortError" ? `timeout after ${opts.timeoutMs}ms` : e?.message || String(e);
    throw new PlatformError(platform, `${opts.method || "GET"} ${safeUrl(url)}: ${msg}`, { status: null, retryable: true });
  }
  clearTimeout(timer);
  const text = await res.text().catch(() => "");
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text, headers: res.headers };
}

// Raise unless 2xx, with the platform's own error message when it gave one.
export function expectOk(platform: string, r: HttpResult, what: string): HttpResult {
  if (r.status >= 200 && r.status < 300) return r;
  const detail =
    (r.json && (r.json.error?.message || r.json.error_description || r.json.error || r.json.message)) ||
    r.text.slice(0, 200) ||
    "";
  const msg = `${what}: HTTP ${r.status}${detail ? " — " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : ""}`;
  throw new PlatformError(platform, msg, { status: r.status, body: r.json });
}

// Strip query strings (they can carry tokens) before a URL lands in a log line.
function safeUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return String(u).split("?")[0];
  }
}

export const form = (o: Record<string, string>) => new URLSearchParams(o);
