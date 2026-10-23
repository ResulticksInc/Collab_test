import type { Request, Response, NextFunction } from "express";
import { config, fail } from "../platform";

// In-memory fixed-window rate limiter. No external dependency. This is
// PER-INSTANCE (for multi-instance deployments, front it with an LB/WAF or swap
// in a Redis-backed limiter), but it closes the "zero rate limiting" gap and
// stops brute-force / DoS from a single client against sensitive endpoints.

interface Bucket {
  count: number;
  resetAt: number;
}

// Resolve the caller's IP for per-IP limiting WITHOUT trusting a spoofable
// header. X-Forwarded-For is appended left→right as a request passes through
// proxies, so its LEFT is fully client-controlled: reading the first entry let a
// caller send `X-Forwarded-For: <random>` and land in a fresh bucket every
// request, defeating brute-force limits. We instead index `trustProxyHops`
// entries from the RIGHT — only those were written by our own trusted proxies —
// and fall back to the raw TCP peer when no proxy is trusted or the header is
// absent.
export function clientIp(req: Request): string {
  const socketIp = req.socket.remoteAddress || "unknown";
  const hops = config.backend.trustProxyHops;
  if (!hops || hops <= 0) return socketIp;
  const parts = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return socketIp;
  return parts[parts.length - hops] || socketIp;
}

// The `sub` of a bearer JWT, read WITHOUT verifying it. Only ever used to pick a
// throttle bucket — never for authorization (the auth middleware verifies the
// signature on every request and rejects a forged token before it costs
// anything). Returns null when there is no well-formed bearer JWT.
export function bearerSubject(req: Request): string | null {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return null;
  const parts = h.slice(7).trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const sub = payload && typeof payload.sub === "string" ? payload.sub.trim() : "";
    return sub && sub.length <= 128 ? sub : null;
  } catch (_) {
    return null;
  }
}

// Bucket key for the GLOBAL API throttle: the signed-in user when there is one,
// else the client IP. Per-IP alone is wrong behind the corporate load balancer
// and nginx: every user in the building arrives from the same address, so one
// shared bucket of API_RATE_MAX per minute covered the whole company. An E2EE
// device-sync burst from a few users after a deploy then 429'd EVERYONE —
// including the recovery calls that put history back — and the client read the
// 429 as "no backup, no key" and showed "Encrypted message". Unauthenticated
// traffic (login, signup, public links) still shares the per-IP bucket and the
// per-endpoint brute-force limiters are unchanged.
export function apiClientKey(req: Request): string {
  const sub = bearerSubject(req);
  return sub ? "u:" + sub : "ip:" + clientIp(req);
}

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
  message?: string;
}) {
  const { windowMs, max } = opts;
  const message =
    opts.message || "Too many requests. Please slow down and try again shortly.";
  const store = new Map<string, Bucket>();
  let lastSweep = 0;

  return function rateLimiter(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    // Opportunistic sweep so the map can't grow unbounded over time.
    if (now - lastSweep > windowMs) {
      for (const [k, b] of store) if (b.resetAt <= now) store.delete(k);
      lastSweep = now;
    }
    const key = opts.key ? opts.key(req) : clientIp(req);
    let b = store.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      store.set(key, b);
    }
    b.count++;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - b.count)));
    if (b.count > max) {
      const retry = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json(fail("RATE_LIMITED", message));
    }
    next();
  };
}
