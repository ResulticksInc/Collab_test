// Chat webhooks, both directions, scoped to ONE conversation — a DM with a
// particular user, or a group.
//
//   INCOMING  An external system POSTs JSON to /api/webhooks/in/<token>; the
//             text lands in the conversation as an ordinary message. The token
//             IS the credential (it rides in the URL), so it is generated with
//             crypto.randomBytes, stored only as a sha256 hash, shown exactly
//             once at create/rotate time, and rate-limited per webhook.
//
//   OUTGOING  Every matching chat event is queued and POSTed to the target URL,
//             HMAC-SHA256 signed, at-least-once, with exponential backoff. The
//             queue is what keeps a dead endpoint from ever adding latency to
//             sending a chat message: the send path only does an INSERT.
//
// AUTHORIZATION is deliberately boring — a webhook is only ever as privileged as
// the member who created it. Every management call and every ingest re-checks
// db.conversations.isMember(conversationId, ownerId), so a webhook created by
// someone who later leaves the group stops working immediately, and nothing
// here can read or write a conversation its owner cannot.
import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import { db, config } from "../platform";

const WH = config.webhooks;
export const EVENTS_SUPPORTED = [
  "message.created",
  "message.updated",
  "message.deleted",
] as const;
type SupportedEvent = (typeof EVENTS_SUPPORTED)[number];

function disabled(): never {
  const e: any = new Error("Webhooks are disabled on this deployment.");
  e.status = 503;
  e.code = "WEBHOOKS_DISABLED";
  throw e;
}
function bad(message: string, status = 400, code = "BAD_REQUEST"): never {
  const e: any = new Error(message);
  e.status = status;
  e.code = code;
  throw e;
}

const sha256 = (s: string) =>
  crypto.createHash("sha256").update(s, "utf8").digest("hex");

// ── Outgoing target validation (SSRF) ───────────────────────────────────────
// Same posture as link unfurling (services/linkPreviewService.ts): a chat
// webhook target is a URL a USER supplies and the SERVER fetches, so on a
// corporate network it is an SSRF primitive unless private space is refused.
// Validated at CREATE time (fail fast, with a real message) and again at every
// DELIVERY (DNS answers change; a hostname that resolved publicly yesterday can
// point at 169.254.169.254 today).
function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const l = ip.toLowerCase();
  return (
    l === "::1" ||
    l === "::" ||
    l.startsWith("fe80") ||
    l.startsWith("fc") ||
    l.startsWith("fd") ||
    l.startsWith("::ffff:")
  );
}

export async function assertDeliverableUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    bad("That is not a valid URL.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    bad("The target URL must be http or https.");
  if (config.env === "production" && u.protocol !== "https:")
    bad("The target URL must use https.");
  if (u.username || u.password)
    bad("The target URL must not contain credentials.");
  if (WH.allowPrivateTargets) return u; // explicit on-prem opt-in
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host.toLowerCase() === "localhost")
    bad("That host is not allowed as a webhook target.");
  let ips: string[];
  try {
    ips = net.isIP(host)
      ? [host]
      : (await dns.lookup(host, { all: true })).map((r) => r.address);
  } catch {
    bad("That host could not be resolved.");
  }
  if (!ips.length || ips.some(isBlockedIp))
    bad(
      "That host resolves to a private or loopback address. Set WEBHOOKS_ALLOW_PRIVATE_TARGETS=true if this deployment really does target an internal endpoint.",
    );
  return u;
}

// ── Scope resolution ────────────────────────────────────────────────────────
// "A particular user" and "a group" are the SAME row: a DM is a conversation.
// The caller may pass either a conversationId or a userId; a userId is resolved
// to the caller's existing DM with that person. We do NOT create a DM here — a
// webhook should attach to a conversation that already exists, so that creating
// an integration can never be a way to open an unsolicited DM.
async function resolveConversation(
  ownerId: string,
  input: { conversationId?: string; userId?: string },
) {
  let conversationId = (input.conversationId || "").trim();
  if (!conversationId && input.userId) {
    if (input.userId === ownerId)
      bad("Pick a group, or another person's direct message.");
    // Both drivers return the conversation ID (or null), not a row.
    const dmId = await db.conversations.findDmBetween(ownerId, input.userId);
    if (!dmId)
      bad(
        "You don't have a direct message with that person yet. Send them a message first, then add the webhook.",
        404,
        "NOT_FOUND",
      );
    conversationId = dmId;
  }
  if (!conversationId)
    bad("Provide a conversationId, or a userId for a direct message.");
  const conv = await db.conversations.getById(conversationId);
  if (!conv) bad("That conversation no longer exists.", 404, "NOT_FOUND");
  // The one authorization check, shared with every other message mutation.
  if (!(await db.conversations.isMember(conversationId, ownerId)))
    bad("You are not a member of this conversation.", 403, "FORBIDDEN");
  return conv;
}

// Exposed for the routes: turn a { conversationId } or { userId } request into
// the one conversation this webhook attaches to, with the membership check
// already applied.
export async function resolveScope(
  ownerId: string,
  input: { conversationId?: string; userId?: string },
) {
  return resolveConversation(ownerId, input);
}

function normalizeEvents(events: any): SupportedEvent[] {
  const list = Array.isArray(events)
    ? events
    : typeof events === "string"
      ? events.split(",")
      : [];
  const clean = list
    .map((e: any) => String(e || "").trim())
    .filter((e: string): e is SupportedEvent =>
      (EVENTS_SUPPORTED as readonly string[]).includes(e),
    );
  return clean.length ? Array.from(new Set(clean)) : ["message.created"];
}

// A webhook is returned WITHOUT its credential everywhere except the create and
// rotate responses, which are the only two moments the plaintext exists.
function publicShape(w: any, conv?: any) {
  if (!w) return null;
  return {
    id: w.id,
    direction: w.direction,
    name: w.name,
    conversationId: w.conversationId,
    scope: conv ? (conv.kind === "dm" ? "user" : "group") : undefined,
    conversationTitle: conv ? conv.title || null : undefined,
    ownerId: w.ownerId,
    events: w.events,
    enabled: w.enabled,
    targetUrl: w.targetUrl || null,
    tokenHint: w.tokenHint || null,
    lastStatus: w.lastStatus,
    lastDeliveryAt: w.lastDeliveryAt,
    failureCount: w.failureCount,
    createdAt: w.createdAt,
  };
}

// ── Management ──────────────────────────────────────────────────────────────
export async function create(opts: {
  ownerId: string;
  direction: "in" | "out";
  name?: string;
  conversationId?: string;
  userId?: string;
  targetUrl?: string;
  events?: any;
}) {
  if (!WH.enabled) disabled();
  const direction =
    opts.direction === "out" ? "out" : opts.direction === "in" ? "in" : null;
  if (!direction)
    bad('direction must be "in" (post into chat) or "out" (chat to your URL).');
  const conv = await resolveConversation(opts.ownerId, opts);

  const existing = await db.webhooks.listForConversation(conv.id);
  if (existing.length >= WH.maxPerConversation)
    bad(
      `This conversation already has the maximum of ${WH.maxPerConversation} webhooks.`,
      409,
      "LIMIT_REACHED",
    );

  const name =
    (opts.name || "").trim().slice(0, 120) ||
    (direction === "in" ? "Incoming webhook" : "Outgoing webhook");
  const events = normalizeEvents(opts.events);

  if (direction === "in") {
    // 32 random bytes, url-safe. The plaintext is returned once and never stored.
    const token = "whin_" + crypto.randomBytes(24).toString("base64url");
    const row = await db.webhooks.create({
      direction,
      name,
      conversationId: conv.id,
      ownerId: opts.ownerId,
      tokenHash: sha256(token),
      tokenHint: token.slice(-6),
      events,
    });
    return { webhook: publicShape(row, conv), token, url: ingestUrl(token) };
  }

  await assertDeliverableUrl(opts.targetUrl || "");
  const secret = "whsec_" + crypto.randomBytes(24).toString("base64url");
  const row = await db.webhooks.create({
    direction,
    name,
    conversationId: conv.id,
    ownerId: opts.ownerId,
    targetUrl: String(opts.targetUrl).trim(),
    secret,
    events,
  });
  return { webhook: publicShape(row, conv), secret };
}

function ingestUrl(token: string) {
  const base = config.backend.publicUrl || "";
  const path = `${config.constants.api.prefix}/webhooks/in/${token}`;
  return base ? `${String(base).replace(/\/$/, "")}${path}` : path;
}

// Load a webhook and prove the caller may manage it: the owner, or any member
// with an admin role on the conversation (so a group is not held hostage by a
// webhook whose creator has moved on).
async function loadManageable(id: string, userId: string) {
  const w = await db.webhooks.getById(id);
  if (!w) bad("Webhook not found.", 404, "NOT_FOUND");
  if (w.ownerId !== userId) {
    const members = await db.conversations.members(w.conversationId);
    const me = (members || []).find((m: any) => (m.userId || m.id) === userId);
    if (!me || !["owner", "admin"].includes(String(me.role || "member")))
      bad(
        "Only the webhook's creator or a conversation admin can manage it.",
        403,
        "FORBIDDEN",
      );
  }
  return w;
}

export async function listForConversation(
  conversationId: string,
  viewerId: string,
) {
  if (!WH.enabled) return [];
  const conv = await resolveConversation(viewerId, { conversationId });
  const rows = await db.webhooks.listForConversation(conv.id);
  return rows.map((w: any) => publicShape(w, conv));
}

export async function listMine(userId: string) {
  if (!WH.enabled) return [];
  const rows = await db.webhooks.listForOwner(userId);
  const out: any[] = [];
  for (const w of rows) {
    // Membership can have lapsed since creation; don't list a webhook onto a
    // conversation the caller can no longer see.
    if (!(await db.conversations.isMember(w.conversationId, userId))) continue;
    const conv = await db.conversations.getById(w.conversationId);
    out.push(publicShape(w, conv));
  }
  return out;
}

export async function update(
  id: string,
  userId: string,
  patch: { name?: string; enabled?: boolean; events?: any },
) {
  if (!WH.enabled) disabled();
  await loadManageable(id, userId);
  const next: any = {};
  if (patch.name !== undefined)
    next.name = String(patch.name).trim().slice(0, 120);
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.events !== undefined) next.events = normalizeEvents(patch.events);
  const w = await db.webhooks.update(id, next);
  return publicShape(w);
}

// Rotate the credential in place, keeping the id and delivery history. The old
// token/secret stops working the moment this returns.
export async function rotate(id: string, userId: string) {
  if (!WH.enabled) disabled();
  const w = await loadManageable(id, userId);
  if (w.direction === "in") {
    const token = "whin_" + crypto.randomBytes(24).toString("base64url");
    const row = await db.webhooks.rotate(id, {
      tokenHash: sha256(token),
      tokenHint: token.slice(-6),
    });
    return { webhook: publicShape(row), token, url: ingestUrl(token) };
  }
  const secret = "whsec_" + crypto.randomBytes(24).toString("base64url");
  const row = await db.webhooks.rotate(id, { secret });
  return { webhook: publicShape(row), secret };
}

export async function remove(id: string, userId: string) {
  if (!WH.enabled) disabled();
  await loadManageable(id, userId);
  return db.webhooks.remove(id);
}

export async function deliveries(id: string, userId: string, limit = 25) {
  if (!WH.enabled) return [];
  await loadManageable(id, userId);
  return db.webhooks.listDeliveries(id, limit);
}

// ── Incoming: external system → conversation ────────────────────────────────
// Per-webhook token bucket. In-process by design: this is a courtesy budget
// that protects the conversation from a runaway integration, layered UNDER the
// global per-IP API limiter which is the real abuse control.
const ingestBuckets = new Map<string, { count: number; resetAt: number }>();
function overIngestBudget(webhookId: string): boolean {
  const now = Date.now();
  const b = ingestBuckets.get(webhookId);
  if (!b || now >= b.resetAt) {
    ingestBuckets.set(webhookId, { count: 1, resetAt: now + 60_000 });
    if (ingestBuckets.size > 5_000) {
      for (const [k, v] of ingestBuckets)
        if (now >= v.resetAt) ingestBuckets.delete(k);
    }
    return false;
  }
  b.count += 1;
  return b.count > WH.ingestPerMinute;
}

// Accept the shapes a person is most likely to already be sending: our own
// { text }, Slack's { text }, and Teams' { title, text } card. Anything else
// with a usable string field still gets through rather than 400-ing on a
// cosmetic difference.
function extractText(body: any): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  const parts: string[] = [];
  const title = body.title || body.summary;
  if (typeof title === "string" && title.trim())
    parts.push(`**${title.trim()}**`);
  const text = body.text ?? body.message ?? body.content ?? body.body;
  if (typeof text === "string" && text.trim()) parts.push(text.trim());
  if (!parts.length && Array.isArray(body.attachments)) {
    for (const a of body.attachments) {
      const t = a && (a.text || a.fallback || a.title);
      if (typeof t === "string" && t.trim()) parts.push(t.trim());
    }
  }
  return parts.join("\n\n");
}

// Validate a presented token and return what the caller needs to post. The
// SEND itself stays in the route (routes/webhooks.ts), which owns the socket
// fan-out — and keeping it there means this service never imports
// messageService, which imports this one for the outgoing dispatch.
export async function resolveIngest(token: string, body: any) {
  if (!WH.enabled) bad("Not found.", 404, "NOT_FOUND");
  const w = await db.webhooks.getByTokenHash(sha256(String(token || "")));
  // A bad token and a disabled webhook are BOTH reported as 404 — an attacker
  // guessing tokens learns nothing about which ones exist.
  if (!w || !w.enabled) bad("Not found.", 404, "NOT_FOUND");
  // The webhook's authority is its owner's membership, re-checked per post:
  // once the owner leaves the conversation, the integration is dead.
  if (!(await db.conversations.isMember(w.conversationId, w.ownerId))) {
    await db.webhooks.markHealth(w.id, "owner_not_member", true);
    bad(
      "This webhook's owner is no longer a member of the conversation.",
      403,
      "FORBIDDEN",
    );
  }
  if (overIngestBudget(w.id))
    bad(
      `This webhook is limited to ${WH.ingestPerMinute} messages per minute.`,
      429,
      "RATE_LIMITED",
    );

  const text = extractText(body).slice(0, 8000);
  if (!text.trim()) bad('Nothing to post — send JSON with a "text" field.');
  return { webhook: w, text };
}

// Record a successful ingest, so a healthy incoming webhook reads as healthy in
// the management UI alongside the outgoing ones.
export async function noteIngest(webhookId: string) {
  await db.webhooks.markHealth(webhookId, "ok", false).catch(() => {});
}

// ── Outgoing: conversation → external URL ───────────────────────────────────
// Called from the message send path. FIRE-AND-FORGET and defensive: a webhook
// problem must never fail, slow, or roll back sending a chat message. All this
// does synchronously is one SELECT and (usually zero) INSERTs.
export function dispatch(
  event: SupportedEvent,
  ctx: { conversationId: string; message: any; viaWebhookId?: string | null },
) {
  if (!WH.enabled) return;
  void (async () => {
    try {
      // LOOP SAFETY: a message that ARRIVED through an incoming webhook is not
      // re-emitted to outgoing webhooks. Without this, wiring this
      // conversation's outgoing hook back to its own incoming hook (directly, or
      // through two systems that bridge each other) is an infinite message loop
      // that fills the conversation. Documented in docs/CHAT_WEBHOOKS.md.
      if (ctx.viaWebhookId) return;
      const hooks = await db.webhooks.listOutgoingFor(
        ctx.conversationId,
        event,
      );
      if (!hooks.length) return;
      const conv = await db.conversations
        .getById(ctx.conversationId)
        .catch(() => null);
      for (const w of hooks) {
        // Deliver only what the owner may see — the payload carries message
        // text, so a webhook whose owner has left the conversation must stop.
        if (!(await db.conversations.isMember(ctx.conversationId, w.ownerId)))
          continue;
        const payload = JSON.stringify(
          buildPayload(event, w, conv, ctx.message),
        );
        await db.webhooks.enqueue(w.id, event, payload);
      }
      kick();
    } catch (e) {
      console.error(
        "[webhooks] dispatch failed (message send unaffected):",
        (e as any)?.message || e,
      );
    }
  })();
}

function buildPayload(event: string, w: any, conv: any, m: any) {
  return {
    event,
    // Wall-clock of the EVENT, not of the delivery attempt — a retried delivery
    // keeps its original timestamp so a consumer can order events correctly.
    timestamp: new Date().toISOString(),
    webhook: { id: w.id, name: w.name },
    conversation: {
      id: conv ? conv.id : w.conversationId,
      kind: conv ? conv.kind : null,
      title: conv ? conv.title || null : null,
    },
    message: m
      ? {
          id: m.id,
          text: m.text ?? m.body ?? null,
          type: m.type || "text",
          createdAt: m.createdAt || m.time || null,
          // E2EE conversations carry no server-readable plaintext; say so
          // explicitly rather than shipping a null that looks like an empty message.
          encrypted: !!m.encrypted || Number(m.encryptionVersion || 0) > 0,
          sender: m.sender ? { id: m.sender.id, name: m.sender.name } : null,
          parentMessageId: m.parentMessageId || null,
          file: m.file
            ? {
                name: m.file.name || null,
                mime: m.file.mime || null,
                size: m.file.size || null,
              }
            : null,
        }
      : null,
  };
}

// Stripe-style signature: the timestamp is signed alongside the body so a
// captured delivery cannot be replayed later, and the consumer compares with a
// constant-time equal. Documented for consumers in docs/CHAT_WEBHOOKS.md.
export function signPayload(
  secret: string,
  payload: string,
  timestampSec: number,
) {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`${timestampSec}.${payload}`, "utf8")
    .digest("hex");
  return `t=${timestampSec},v1=${mac}`;
}

// Exponential backoff with a cap: 30s, 2m, 8m, 32m, then give up (5 attempts by
// default). Jittered so a fleet of deliveries to one recovering endpoint does
// not re-collide on every wave.
function backoffSec(attempt: number): number | null {
  if (attempt >= WH.maxAttempts) return null;
  const base = 30 * Math.pow(4, attempt - 1);
  return Math.min(base, 3600) * (0.85 + Math.random() * 0.3);
}

let draining = false;
let drainAgain = false;

// Drain the queue. Safe to call concurrently — the second caller just marks
// "run again when the current pass finishes" instead of double-sending.
export async function drain(): Promise<number> {
  if (!WH.enabled) return 0;
  if (draining) {
    drainAgain = true;
    return 0;
  }
  draining = true;
  let delivered = 0;
  try {
    for (let pass = 0; pass < 20; pass++) {
      const batch = await db.webhooks.claimDue(25);
      if (!batch.length) break;
      const results = await Promise.all(batch.map((d: any) => deliverOne(d)));
      delivered += results.filter(Boolean).length;
    }
  } catch (e) {
    console.error("[webhooks] drain failed:", (e as any)?.message || e);
  } finally {
    draining = false;
  }
  if (drainAgain) {
    drainAgain = false;
    return delivered + (await drain());
  }
  return delivered;
}

// Nudge the drain shortly after an enqueue so a healthy endpoint sees the event
// in ~a second rather than waiting for the next poll tick.
let kickTimer: any = null;
function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void drain();
  }, 750);
  if (typeof kickTimer.unref === "function") kickTimer.unref();
}

async function deliverOne(d: any): Promise<boolean> {
  // The webhook was disabled or deleted between enqueue and drain — drop the
  // delivery rather than posting data the owner has since revoked.
  if (!d.hookLive || !d.targetUrl) {
    await db.webhooks.markFailed(
      d.id,
      null,
      "webhook disabled or removed before delivery",
      null,
    );
    return false;
  }
  const attempt = Number(d.attempts || 0) + 1;
  try {
    // Re-validate on EVERY attempt: DNS is mutable, and a target that resolved
    // publicly at create time can be re-pointed at internal space later.
    const url = await assertDeliverableUrl(d.targetUrl);
    const ts = Math.floor(Date.now() / 1000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WH.timeoutMs);
    let res: any;
    try {
      res = await (globalThis as any).fetch(url.href, {
        method: "POST",
        // No redirect following: a 3xx to an internal address would bypass the
        // check above, and a webhook endpoint has no business redirecting.
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "user-agent": "CoLab-Webhooks/1.0",
          "x-colab-event": d.event,
          "x-colab-delivery": d.id,
          "x-colab-webhook-id": d.webhookId,
          "x-colab-signature": signPayload(d.secret || "", d.payload, ts),
        },
        body: d.payload,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const code = Number(res.status) || 0;
    if (code >= 200 && code < 300) {
      await db.webhooks.markDelivered(d.id, code);
      await db.webhooks.markHealth(d.webhookId, String(code), false);
      return true;
    }
    // 4xx (other than 408/429) is the endpoint saying "this request is wrong" —
    // retrying an unchanged body will not fix it, so fail fast and let the
    // delivery log show why. 5xx and throttling are retried.
    const permanent = code >= 400 && code < 500 && code !== 408 && code !== 429;
    const retry = permanent ? null : backoffSec(attempt);
    await db.webhooks.markFailed(d.id, code, `HTTP ${code}`, retry);
    await db.webhooks.markHealth(d.webhookId, String(code), true);
    return false;
  } catch (e: any) {
    const msg =
      e?.name === "AbortError"
        ? `timeout after ${WH.timeoutMs}ms`
        : e?.message || String(e);
    await db.webhooks.markFailed(d.id, null, msg, backoffSec(attempt));
    await db.webhooks.markHealth(d.webhookId, "error", true);
    return false;
  }
}

// Queue a synthetic event so someone can verify their endpoint (signature
// verification included) without waiting for real chat traffic.
export async function test(id: string, userId: string) {
  if (!WH.enabled) disabled();
  const w = await loadManageable(id, userId);
  if (w.direction !== "out")
    bad("Only an outgoing webhook can be tested this way.");
  const conv = await db.conversations
    .getById(w.conversationId)
    .catch(() => null);
  const payload = JSON.stringify({
    ...buildPayload("message.created", w, conv, {
      id: "test",
      text: "This is a test delivery from CoLab.",
      type: "text",
      createdAt: new Date().toISOString(),
      sender: { id: userId, name: "CoLab" },
    }),
    test: true,
  });
  const deliveryId = await db.webhooks.enqueue(
    w.id,
    "message.created",
    payload,
  );
  kick();
  return { deliveryId, queued: true };
}

// Housekeeping, run from the backend's timer loop under the leader gate.
export async function sweep() {
  if (!WH.enabled) return { requeued: 0, pruned: 0 };
  const requeued = await db.webhooks.requeueStale(300).catch(() => 0);
  const pruned = await db.webhooks
    .pruneDeliveries(WH.deliveryRetentionDays)
    .catch(() => 0);
  return { requeued, pruned };
}
