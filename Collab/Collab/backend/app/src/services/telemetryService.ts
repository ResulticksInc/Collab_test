import { createHash } from "crypto";
import { db } from "../platform";

// Server-side client-error aggregation. The web client buffers uncaught errors /
// unhandled rejections / logged errors and POSTs a small BATCH; this service
// sanitizes + size-caps each item, computes a stable GROUPING fingerprint, and
// upserts via the driver so a recurring error is ONE row (count bumps) rather
// than millions. This is ERROR telemetry, NOT content — callers must never send
// message bodies; we additionally cap sizes here as defense in depth.

// Abuse-resistance caps. The route also rate-limits and bounds the batch size;
// these bound the per-item payload so a single row can't be used as blob storage.
export const MAX_BATCH = 20;
const MAX_MESSAGE = 4 * 1024; // ~4KB
const MAX_STACK = 16 * 1024; // ~16KB
const MAX_URL = 512;
const MAX_UA = 512;
const MAX_VERSION = 32;

export interface ClientErrorInput {
  level?: string;
  category?: string;
  message?: string;
  stack?: string;
  url?: string;
  appVersion?: string;
  context?: any;
}

const LEVELS = new Set(["error", "warn", "fatal", "info"]);
const CATEGORIES = new Set(["general", "e2ee", "realtime", "network", "media", "auth", "render"]);
// A small, non-sensitive diagnostic context bag (platform, deviceId, e2ee kind,
// conversationId). Size-capped and key-whitelisted so it can never be used to
// smuggle message content into the ledger.
const CONTEXT_KEYS = new Set(["platform", "app", "appVersion", "deviceId", "browser", "os", "kind", "conversationId", "messageId", "detail", "screen"]);
function sanitizeContext(raw: any): Record<string, string> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string> = {};
  for (const k of Object.keys(raw)) {
    if (!CONTEXT_KEYS.has(k)) continue;
    const v = raw[k];
    if (v == null) continue;
    out[k] = String(v).slice(0, 200);
  }
  return Object.keys(out).length ? out : null;
}

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

// The grouping key: SHA-256 over the message + the top stack frame. The top
// frame (first "at …" line, or the first line of the stack) keeps two errors with
// the same message but different origins distinct, while collapsing the same
// error fired from the same place across thousands of sessions into one row.
function fingerprint(message: string, stack: string | null): string {
  let top = "";
  if (stack) {
    const lines = stack.split("\n").map((l) => l.trim()).filter(Boolean);
    top = lines.find((l) => l.startsWith("at ")) || lines[0] || "";
  }
  return createHash("sha256").update(message + "\n" + top).digest("hex").slice(0, 64);
}

// Normalize + validate ONE raw client error. Returns null if it isn't usable
// (no message) so the route can skip it without failing the whole batch.
export function normalize(
  raw: ClientErrorInput,
  ctx: { userId?: string | null; userAgent?: string | null; ip?: string | null; city?: string | null; country?: string | null },
) {
  const message = clip(raw?.message, MAX_MESSAGE);
  if (!message) return null;
  const stack = clip(raw?.stack, MAX_STACK);
  const level = LEVELS.has(String(raw?.level)) ? String(raw.level) : "error";
  const category = CATEGORIES.has(String(raw?.category)) ? String(raw.category) : "general";
  // Merge SERVER-AUTHORITATIVE location (from CDN geo headers, set by the route)
  // into the sanitized client context. Location is derived server-side so it can't
  // be spoofed by the client, and it's tracking metadata — never content.
  const context: Record<string, string> = sanitizeContext(raw?.context) || {};
  if (ctx.country) context.country = String(ctx.country).slice(0, 60);
  if (ctx.city) context.city = String(ctx.city).slice(0, 80);
  if (ctx.ip) context.ip = String(ctx.ip).slice(0, 64);
  return {
    fingerprint: fingerprint(category + "\n" + message, stack),
    userId: ctx.userId || null,
    level,
    category,
    message,
    stack,
    url: clip(raw?.url, MAX_URL),
    userAgent: clip(ctx.userAgent, MAX_UA),
    context: Object.keys(context).length ? context : null,
    appVersion: clip(raw?.appVersion, MAX_VERSION),
  };
}

// Persist a batch. Best-effort per item: one bad/duplicate row never sinks the
// rest. Returns how many were stored.
export async function recordBatch(
  items: ClientErrorInput[],
  ctx: { userId?: string | null; userAgent?: string | null; ip?: string | null; city?: string | null; country?: string | null },
): Promise<number> {
  if (!Array.isArray(items)) return 0;
  let stored = 0;
  for (const raw of items.slice(0, MAX_BATCH)) {
    try {
      // normalize() is inside the try too: a single malformed item must not throw
      // the whole batch (which would bubble a 500 out of the error reporter).
      const norm = normalize(raw, ctx);
      if (!norm) continue;
      await db.telemetry.recordClientError(norm);
      stored++;
    } catch (e: any) {
      // Telemetry must never become a source of 500s; log and move on.
      console.warn("[telemetry] record failed:", e?.message);
    }
  }
  return stored;
}

export async function listRecent(opts: { limit?: number; sinceHours?: number } = {}) {
  return db.telemetry.listClientErrors(opts);
}

// §9.2 usage events — aggregated, content-free counters. Names are a strict
// dotted-kebab vocabulary so a buggy/hostile client can't mint unbounded rows
// of arbitrary text; anything else in a batch is silently dropped.
const EVENT_NAME_RE = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
export const MAX_EVENT_BATCH = 50;

export async function recordEvents(names: unknown): Promise<number> {
  const clean = (Array.isArray(names) ? names : [])
    .filter((n): n is string => typeof n === "string" && EVENT_NAME_RE.test(n))
    .slice(0, MAX_EVENT_BATCH);
  if (!clean.length) return 0;
  try {
    await (db as any).telemetry.bumpEvents(clean);
  } catch (err) {
    // Counters must never take a feature down with them.
    console.warn("[telemetry] bumpEvents failed:", (err as any)?.message);
    return 0;
  }
  return clean.length;
}

export async function eventSummary(days = 7) {
  return (db as any).telemetry.eventSummary(days);
}

export async function purgeOld(days: number) {
  return db.telemetry.purgeOldClientErrors(days);
}
