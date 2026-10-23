// WhatsApp Cloud API adapter (Meta Graph API).
//
// A "channel" here is the COUNTERPART's phone number (wa_id): one mapping per
// number ↔ one CoLab conversation. A mapping whose external channel id is "*"
// is a catch-all INBOX — every unmapped number lands in that conversation
// (inbound only; replies need a per-number mapping so the engine knows whom to
// address).
//
// Inbound verification: GET handshake echoes hub.challenge when
// hub.verify_token matches; every POST carries X-Hub-Signature-256 =
// "sha256=" + HMAC_SHA256(app secret, raw body).
// WhatsApp has no message edit/delete API — those are reported as unsupported.
import crypto from "crypto";
import { callJson, expectOk } from "../http";
import { toWhatsApp } from "../transformer";
import { type AdapterCtx, type ChatAdapter, type InboundEvent, type MappingRef, type NormalizedMessage, PlatformError } from "../types";

const base = (ctx: AdapterCtx) => `https://graph.facebook.com/${ctx.account.settings?.whatsappApiVersion || "v21.0"}`;

export const WHATSAPP_INBOX_CHANNEL = "*";

export const whatsappAdapter: ChatAdapter = {
  platform: "whatsapp",

  handshake(req, ctx) {
    if (req.method !== "GET") return null;
    const q = req.query || {};
    if (q["hub.mode"] !== "subscribe") return null;
    const expected = String(ctx.credentials.verifyToken || "");
    const got = String(q["hub.verify_token"] || "");
    const a = Buffer.from(expected);
    const b = Buffer.from(got);
    if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 403, body: "verify token mismatch", contentType: "text/plain" };
    return { status: 200, body: String(q["hub.challenge"] || ""), contentType: "text/plain" };
  },

  async verifyInbound(req, ctx) {
    const sig = String(req.headers["x-hub-signature-256"] || "");
    const secret = String(ctx.credentials.appSecret || "");
    if (!sig.startsWith("sha256=") || !secret) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  async parseInbound(req, ctx) {
    const body = req.body;
    if (!body || body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return [];
    const out: InboundEvent[] = [];
    const ownPhoneId = String(ctx.credentials.phoneNumberId || "");
    for (const entry of body.entry) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        if (v.messaging_product !== "whatsapp") continue;
        const phoneId = String(v.metadata?.phone_number_id || "");
        if (ownPhoneId && phoneId && phoneId !== ownPhoneId) continue; // another number on the same WABA
        const names = new Map<string, string>();
        for (const c of v.contacts || []) if (c.wa_id && c.profile?.name) names.set(String(c.wa_id), String(c.profile.name));
        for (const m of v.messages || []) {
          const from = String(m.from || "");
          if (!from || !m.id) continue;
          const type = String(m.type || "text");
          let text = "";
          const attachments: any[] = [];
          if (type === "text") text = String(m.text?.body || "");
          else if (["image", "video", "audio", "document", "sticker"].includes(type)) {
            const media = m[type] || {};
            text = String(media.caption || "");
            attachments.push({ name: media.filename || `${type} ${media.id || ""}`.trim(), url: null, mime: media.mime_type || null, size: null });
          } else if (type === "location") text = `📍 ${m.location?.name || ""} ${m.location?.latitude},${m.location?.longitude}`.trim();
          else if (type === "contacts") text = `👤 ${(m.contacts || []).map((c: any) => c.name?.formatted_name).filter(Boolean).join(", ")}`;
          else if (type === "reaction") {
            out.push({ kind: "ignored", externalEventId: String(m.id), externalChannelId: from, externalMessageId: String(m.id), text: "", ignoreReason: "reaction" });
            continue;
          } else if (type === "button" || type === "interactive") text = String(m.button?.text || m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "");
          else text = `[${type}]`;
          out.push({
            kind: "message.created",
            externalEventId: String(m.id),
            externalChannelId: from,
            externalMessageId: String(m.id),
            externalThreadId: m.context?.id ? String(m.context.id) : null,
            senderId: from,
            senderName: names.get(from) || from,
            botId: null,
            isBot: false,
            text,
            attachments,
            timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
            channelMeta: { displayPhoneNumber: v.metadata?.display_phone_number || null },
          });
        }
        // Delivery/read receipts for OUR messages — not chat content.
        for (const s of v.statuses || [])
          out.push({ kind: "ignored", externalEventId: `${s.id}:${s.status}`, externalChannelId: String(s.recipient_id || ""), externalMessageId: String(s.id || ""), text: "", ignoreReason: `status ${s.status}` });
      }
    }
    return out;
  },

  async sendMessage(ctx, mapping: MappingRef, msg: NormalizedMessage) {
    if (mapping.externalChannelId === WHATSAPP_INBOX_CHANNEL)
      throw new PlatformError("whatsapp", "the catch-all inbox mapping has no recipient number; add a per-number mapping to reply", { status: 400, retryable: false });
    const body: any = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: mapping.externalChannelId,
      type: "text",
      text: { preview_url: false, body: toWhatsApp(msg.text).slice(0, 4096) },
    };
    if (msg.threadRef) body.context = { message_id: msg.threadRef };
    const r = await callJson("whatsapp", `${base(ctx)}/${encodeURIComponent(ctx.credentials.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.credentials.accessToken}` },
      body,
      timeoutMs: ctx.timeoutMs,
    });
    expectOk("whatsapp", r, "send message");
    const id = r.json?.messages?.[0]?.id;
    if (!id) throw new PlatformError("whatsapp", "send response had no message id", { status: 502 });
    return { externalMessageId: String(id), externalThreadId: msg.threadRef || null };
  },

  // No edit/delete in the Cloud API — left undefined on purpose; the engine
  // records the job as "unsupported" rather than failing it.

  async testConnection(ctx) {
    const r = await callJson("whatsapp", `${base(ctx)}/${encodeURIComponent(ctx.credentials.phoneNumberId)}?fields=display_phone_number,verified_name,id`, {
      headers: { authorization: `Bearer ${ctx.credentials.accessToken}` },
      timeoutMs: ctx.timeoutMs,
    });
    expectOk("whatsapp", r, "phone number");
    return { ok: true, detail: `${r.json?.verified_name || ""} ${r.json?.display_phone_number || ""}`.trim(), workspaceId: String(r.json?.id || ctx.credentials.phoneNumberId) };
  },
};
