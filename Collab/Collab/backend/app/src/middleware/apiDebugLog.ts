// API DEBUG LOG — console.log every API request (method, path, query, payload)
// and its response (status, duration, body). For integration debugging (e.g. the
// mobile app talking to a dev backend). OFF unless API_DEBUG_LOG=true: it prints
// request/response bodies, so it is never meant for production.
//
// Redaction: credential-bearing fields (password, tokens, secrets, OTP codes,
// PKCE verifier, private keys) are replaced with "[redacted]" in BOTH directions,
// and the Authorization header is reduced to its scheme. Bodies are truncated to
// API_DEBUG_LOG_MAX chars (default 4000) so a big conversation list cannot flood
// the terminal. Health-check polling is skipped by default (API_DEBUG_LOG_HEALTH=true
// to include it).
import type { Request, Response, NextFunction } from "express";
import { config } from "../platform";

const REDACT = /^(password|newPassword|oldPassword|currentPassword|confirmPassword|token|accessToken|refreshToken|idToken|id_token|access_token|refresh_token|secret|clientSecret|client_secret|code_verifier|codeVerifier|otp|totp|recoveryCode|privateKey|private_key|apiKey|api_key|authorization|cookie|set-cookie)$/i;
// `code` is overloaded: an OAuth authorization code (long, single-use) or an OTP
// (6–8 digits) must be hidden; an API error code ("UNAUTHORIZED") must stay visible.
function isSecretCode(k: string, v: any): boolean {
  if (!/^code$/i.test(k) || typeof v !== "string") return false;
  return /^\d{6,8}$/.test(v) || v.length >= 20;
}

function redact(v: any, depth = 0): any {
  if (v === null || v === undefined) return v;
  if (depth > 6) return "[…]";
  if (Array.isArray(v)) return v.length > 50 ? [...v.slice(0, 50).map((x) => redact(x, depth + 1)), `… ${v.length - 50} more`] : v.map((x) => redact(x, depth + 1));
  if (typeof v === "object") {
    if (Buffer.isBuffer(v)) return `<Buffer ${v.length} bytes>`;
    const out: any = {};
    for (const [k, val] of Object.entries(v))
      out[k] = (REDACT.test(k) && val) || isSecretCode(k, val) ? "[redacted]" : redact(val, depth + 1);
    return out;
  }
  if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + `… (${v.length} chars)`;
  return v;
}

function fmt(v: any, max: number): string {
  if (v === undefined) return "-";
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(redact(v));
  } catch {
    s = String(v);
  }
  return s.length > max ? s.slice(0, max) + `… (${s.length} chars)` : s;
}

export function apiDebugLog(req: Request, res: Response, next: NextFunction) {
  const max = Number(process.env.API_DEBUG_LOG_MAX) > 0 ? Number(process.env.API_DEBUG_LOG_MAX) : 4000;
  if (!/^(1|true|yes|on)$/i.test(String(process.env.API_DEBUG_LOG_HEALTH || "")) && req.path.startsWith("/api/health")) return next();
  const started = Date.now();
  const id = String((req as any).id || "").slice(0, 8);
  const auth = String(req.headers.authorization || "");
  const ctype = String(req.headers["content-type"] || "");
  const payload =
    req.body && typeof req.body === "object" && Object.keys(req.body).length
      ? req.body
      : /multipart|octet-stream/i.test(ctype) || (req.method === "POST" && req.path === "/api/files")
        ? `<stream ${ctype || "binary"} ${req.headers["content-length"] || "?"} bytes>`
        : undefined;
  // eslint-disable-next-line no-console
  console.log(
    `[api] → ${req.method} ${req.originalUrl}` +
      ` | id=${id} ip=${req.ip}` +
      (auth ? ` auth=${auth.split(" ")[0]}` : " auth=none") +
      (Object.keys(req.query || {}).length ? ` | query=${fmt(req.query, max)}` : "") +
      (payload !== undefined ? ` | payload=${fmt(payload, max)}` : ""),
  );

  // Capture the response body without changing how routes send it.
  let captured: any;
  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);
  res.json = ((body: any) => {
    captured = body;
    return origJson(body);
  }) as any;
  res.send = ((body: any) => {
    if (captured === undefined) captured = Buffer.isBuffer(body) ? `<${body.length} bytes>` : body;
    return origSend(body);
  }) as any;
  res.on("finish", () => {
    const ms = Date.now() - started;
    const loc = res.getHeader("location");
    // eslint-disable-next-line no-console
    console.log(
      `[api] ← ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms | id=${id}` +
        (loc ? ` | location=${String(loc).slice(0, 300)}` : "") +
        ` | response=${captured !== undefined ? fmt(captured, max) : res.statusCode === 304 ? "(not modified)" : "(no body / streamed)"}`,
    );
  });
  next();
}

export function apiDebugLogEnabled(): boolean {
  return !!config.backend.apiDebugLog;
}
