// UNIFIED CONNECTOR ENGINE — inbound ingestion (platform → CoLab).
//
// One entry point for every platform's webhook: verify, parse, filter, dedupe,
// route, post. The route layer (routes/connectors.ts) owns the raw body and
// the socket fan-out; this module owns the policy.
//
//   1. account lookup      the URL's accountId must be a live account of that platform
//   2. handshake           Slack url_verification / Graph validationToken / WhatsApp hub.challenge
//   3. signature           every event is cryptographically verified (fail closed)
//   4. parse               adapter → InboundEvent[]
//   5. loop guard          our own bot's events are dropped (loopGuard.ts)
//   6. idempotency         SET NX on the platform event id (idempotency.ts)
//   7. routing             channel → mappings (WhatsApp "*" catch-all inbox)
//   8. echo guard          an external message id we already mapped is OUR post
//   9. post                messageService.send/edit/remove AS the mapping owner,
//                          threaded via the message mappings, marked
//                          viaConnectorMappingId so dispatch never echoes it back
//
// Separate from connectorService because this imports messageService, which
// imports connectorService for outbound dispatch.
import { db, config } from "../platform";
import * as messageService from "./messageService";
import * as idem from "./connectors/idempotency";
import { originDropReason } from "./connectors/loopGuard";
import { getChatAdapter } from "./connectors/registry";
import { attribute, fromGoogleChat, fromSlack, fromWhatsApp, PLATFORM_LABEL } from "./connectors/transformer";
import { type InboundEvent, type InboundRequest, isChatPlatform } from "./connectors/types";
import { buildCtx } from "./connectorService";
import { WHATSAPP_INBOX_CHANNEL } from "./connectors/adapters/whatsapp";

const CN = config.connectors;

interface IngestResponse {
  status: number;
  body: any;
  contentType?: string;
  // What the route must broadcast, in order.
  posted: { kind: "created" | "updated" | "deleted"; conversationId: string; message: any }[];
  summary: { accepted: number; dropped: number; reasons: string[] };
}

const respond = (status: number, body: any, contentType?: string): IngestResponse => ({
  status,
  body,
  contentType,
  posted: [],
  summary: { accepted: 0, dropped: 0, reasons: [] },
});

// Per-account inbound budget — a courtesy cap under the per-IP limiter on the
// public route, so one runaway integration cannot flood a conversation.
const buckets = new Map<string, { count: number; resetAt: number }>();
function overBudget(accountId: string): boolean {
  const now = Date.now();
  const b = buckets.get(accountId);
  if (!b || now >= b.resetAt) {
    buckets.set(accountId, { count: 1, resetAt: now + 60_000 });
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    return false;
  }
  b.count += 1;
  return b.count > CN.inboundPerMinute;
}

function toCanonical(platform: string, text: string): string {
  switch (platform) {
    case "slack":
      return fromSlack(text);
    case "google_chat":
      return fromGoogleChat(text);
    case "whatsapp":
      return fromWhatsApp(text);
    default:
      return String(text || ""); // Teams: the adapter already converted HTML
  }
}

export async function handleInbound(platform: string, accountId: string, req: InboundRequest): Promise<IngestResponse> {
  // A bad platform, unknown account, wrong-platform account and disabled
  // account are ALL a 404 — a probe learns nothing about what exists.
  if (!CN.enabled || !isChatPlatform(platform)) return respond(404, { error: "not found" });
  const account = await db.connectors.getAccount(String(accountId || ""));
  if (!account || account.platform !== platform || !account.enabled) return respond(404, { error: "not found" });
  const adapter = getChatAdapter(platform);
  if (!adapter) return respond(404, { error: "not found" });

  let ctx;
  try {
    ctx = buildCtx(account);
  } catch (e: any) {
    await db.connectors.markAccountHealth(account.id, "bad_credentials", true).catch(() => {});
    return respond(500, { error: "connector credentials cannot be unsealed" });
  }

  const hs = adapter.handshake ? adapter.handshake(req, ctx) : null;
  if (hs) return respond(hs.status, hs.body, hs.contentType);

  if (!CN.insecureSkipVerify) {
    const ok = await adapter.verifyInbound(req, ctx).catch(() => false);
    if (!ok) {
      await db.connectors.markAccountHealth(account.id, "bad_signature", true).catch(() => {});
      return respond(401, { error: "signature verification failed" });
    }
  }
  if (overBudget(account.id)) return respond(429, { error: `inbound limited to ${CN.inboundPerMinute}/min per account` });

  let events: InboundEvent[];
  try {
    events = await adapter.parseInbound(req, ctx);
  } catch (e: any) {
    await db.connectors.markAccountHealth(account.id, "parse_error", true).catch(() => {});
    // 200 on purpose: a payload we cannot parse will not parse on redelivery either.
    return { ...respond(200, { ok: false, error: "unparseable event" }), summary: { accepted: 0, dropped: 1, reasons: [e?.message || "parse error"] } };
  }

  const out: IngestResponse = { status: 200, body: { ok: true }, posted: [], summary: { accepted: 0, dropped: 0, reasons: [] } };
  const drop = (why: string) => {
    out.summary.dropped++;
    if (out.summary.reasons.length < 20) out.summary.reasons.push(why);
  };

  // Self-learning loop guard: a Teams bot activity tells us our own bot id in
  // `recipient`; record it so the origin filter can key on it from now on.
  let botIds = account.botIds || [];
  for (const ev of events) {
    const learned = ev.channelMeta?.botId;
    if (learned && !botIds.includes(String(learned))) {
      botIds = [...botIds, String(learned)];
      await db.connectors.updateAccount(account.id, { botIds }).catch(() => {});
    }
  }

  for (const ev of events) {
    if (ev.kind === "ignored") {
      drop(ev.ignoreReason || "ignored");
      continue;
    }
    const originReason = originDropReason({ senderId: ev.senderId, botId: ev.botId, isBot: ev.isBot }, botIds);
    if (originReason) {
      drop(originReason);
      continue;
    }
    if (ev.isBot && account.settings?.bridgeOtherBots !== true) {
      drop("message from another bot (settings.bridgeOtherBots=false)");
      continue;
    }
    if (!(await idem.acquire(`in:${account.id}:${ev.externalEventId}`, CN.dedupeTtlSec))) {
      drop(`duplicate event ${ev.externalEventId}`);
      continue;
    }
    let mappings = await db.connectors.findMappingsByChannel(account.id, ev.externalChannelId);
    if (!mappings.length && platform === "whatsapp") mappings = await db.connectors.findMappingsByChannel(account.id, WHATSAPP_INBOX_CHANNEL);
    if (!mappings.length) {
      drop(`no mapping for channel ${ev.externalChannelId}`);
      continue;
    }
    for (const mp of mappings) {
      try {
        const r = await deliver(platform, account, mp, ev);
        if (r) {
          out.posted.push(r);
          out.summary.accepted++;
          await db.connectors.markMappingHealth(mp.id, "ok", false).catch(() => {});
        } else drop(`mapping ${mp.id}: nothing to do`);
      } catch (e: any) {
        drop(`mapping ${mp.id}: ${e?.message || e}`);
        await db.connectors.markMappingHealth(mp.id, e?.code || "error", true).catch(() => {});
      }
    }
  }
  await db.connectors.markAccountHealth(account.id, "ok", false).catch(() => {});
  out.body = { ok: true, accepted: out.summary.accepted, dropped: out.summary.dropped };
  return out;
}

async function deliver(platform: string, account: any, mp: any, ev: InboundEvent) {
  // The mapping's authority is its owner's membership, re-checked per event:
  // once the owner leaves the conversation, the bridge is dead.
  if (!(await db.conversations.isMember(mp.conversationId, mp.ownerId))) {
    await db.connectors.markMappingHealth(mp.id, "owner_not_member", true).catch(() => {});
    const e: any = new Error("mapping owner is no longer a member");
    e.code = "owner_not_member";
    throw e;
  }
  // Routing details learned from the event (Teams serviceUrl etc.) are kept on
  // the mapping so outbound replies know where to go.
  if (ev.channelMeta && Object.keys(ev.channelMeta).length) {
    const merged = { ...(mp.externalMeta || {}) };
    let changed = false;
    for (const [k, v] of Object.entries(ev.channelMeta)) {
      if (k === "botId" || v == null) continue;
      if (merged[k] !== v) {
        merged[k] = v;
        changed = true;
      }
    }
    if (changed) await db.connectors.updateMapping(mp.id, { externalMeta: merged }).catch(() => {});
  }

  // ECHO GUARD: an external id we already mapped is a message WE posted (or
  // one we already ingested) — never post it again.
  const known = ev.externalMessageId ? await db.connectors.findByExternal(mp.id, ev.externalMessageId) : null;

  if (ev.kind === "message.created") {
    if (known) return null;
    const canonical = toCanonical(platform, ev.text);
    const files = (ev.attachments || []).map((a) => `📎 ${a.name}${a.url ? ` (${a.url})` : ""}`).join("\n");
    const bodyText = [canonical.trim(), files].filter(Boolean).join("\n");
    if (!bodyText.trim()) return null;
    const text = attribute(bodyText, ev.senderName, PLATFORM_LABEL[platform] || platform).slice(0, 8000);
    let parentMessageId: string | null = null;
    if (ev.externalThreadId) {
      const root = (await db.connectors.findByExternal(mp.id, ev.externalThreadId)) || (await db.connectors.findByThread(mp.id, ev.externalThreadId));
      if (root) parentMessageId = root.messageId;
    }
    const msg = await messageService.send({
      conversationId: mp.conversationId,
      senderId: mp.ownerId,
      text,
      file: null,
      parentMessageId,
      viaConnectorMappingId: mp.id,
      bridge: { sourcePlatform: platform, authorName: ev.senderName || null },
    } as any);
    await db.connectors.recordMessage({
      mappingId: mp.id,
      conversationId: mp.conversationId,
      messageId: msg.id,
      externalMessageId: ev.externalMessageId,
      externalThreadId: ev.externalThreadId || null,
      direction: "in",
    });
    return { kind: "created" as const, conversationId: mp.conversationId, message: msg };
  }

  if (!known) return null; // an edit/delete of something we never bridged
  if (known.direction === "out") return null; // our own post changed on the far side — nothing to mirror

  if (ev.kind === "message.updated") {
    const canonical = toCanonical(platform, ev.text);
    if (!canonical.trim()) return null;
    const text = attribute(canonical.trim(), ev.senderName, PLATFORM_LABEL[platform] || platform).slice(0, 8000);
    const msg = await messageService.edit({ messageId: known.messageId, userId: mp.ownerId, text, viaConnectorMappingId: mp.id } as any);
    if (!msg) return null;
    return { kind: "updated" as const, conversationId: mp.conversationId, message: msg };
  }
  if (ev.kind === "message.deleted") {
    const r = await messageService.remove({ messageId: known.messageId, userId: mp.ownerId, viaConnectorMappingId: mp.id } as any);
    if (!r || !r.deleted) return null;
    return { kind: "deleted" as const, conversationId: mp.conversationId, message: r };
  }
  return null;
}
