// Google Chat adapter — Chat app HTTP endpoint in, Chat API out.
//
// Inbound verification: Google signs each event with a bearer JWT issued to
// chat@system.gserviceaccount.com whose audience is the Cloud project number.
// Outbound: service-account token with the chat.bot scope.
import { createRemoteJWKSet, jwtVerify } from "jose";
import { callJson, expectOk } from "../http";
import { getGoogleServiceAccountToken } from "../oauth";
import { toGoogleChat } from "../transformer";
import { type AdapterCtx, type ChatAdapter, type InboundEvent, type MappingRef, type NormalizedMessage } from "../types";

const API = "https://chat.googleapis.com/v1";
const ISSUER = "chat@system.gserviceaccount.com";
const SCOPES = ["https://www.googleapis.com/auth/chat.bot"];
let googleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks() {
  if (!googleJwks)
    googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com"));
  return googleJwks;
}

async function api(ctx: AdapterCtx, method: string, path: string, body?: any) {
  const token = await getGoogleServiceAccountToken("google_chat", ctx.credentials.serviceAccountJson, SCOPES, null, ctx.timeoutMs);
  return callJson("google_chat", `${API}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body,
    timeoutMs: ctx.timeoutMs,
  });
}

// Both event envelopes Google has shipped: the classic top-level
// { type, message, space } and the newer { chat: { messagePayload } }.
function extractMessage(body: any): { type: string; message: any; space: string | null; eventTime: string | null } {
  const payload = body?.chat?.messagePayload || null;
  const message = body?.message || payload?.message || null;
  const space = body?.space?.name || payload?.space?.name || message?.space?.name || null;
  const type = body?.type || (payload ? "MESSAGE" : "UNKNOWN");
  return { type, message, space, eventTime: body?.eventTime || null };
}

export const googleChatAdapter: ChatAdapter = {
  platform: "google_chat",

  async verifyInbound(req, ctx) {
    const auth = String(req.headers.authorization || "");
    if (!auth.startsWith("Bearer ")) return false;
    const audience = String(ctx.credentials.projectNumber || "");
    if (!audience) return false;
    try {
      await jwtVerify(auth.slice(7), jwks(), { issuer: ISSUER, audience, clockTolerance: 300 });
      return true;
    } catch {
      return false;
    }
  },

  async parseInbound(req) {
    const { type, message, space, eventTime } = extractMessage(req.body);
    if (!space) return [];
    if (type !== "MESSAGE" || !message?.name) {
      return [{ kind: "ignored", externalEventId: `${space}:${eventTime || Date.now()}`, externalChannelId: space, externalMessageId: "", text: "", ignoreReason: `event ${type}` }];
    }
    const sender = message.sender || {};
    const ev: InboundEvent = {
      kind: "message.created",
      externalEventId: `${message.name}:${eventTime || message.createTime || ""}`,
      externalChannelId: space,
      externalMessageId: String(message.name),
      // Every Google Chat message lives in a thread; the engine resolves the
      // thread name to the CoLab root (findByThread) and posts as a root when
      // the thread is new.
      externalThreadId: message.thread?.name ? String(message.thread.name) : null,
      senderId: sender.name || null,
      senderName: sender.displayName || null,
      botId: sender.type === "BOT" ? sender.name || null : null,
      isBot: sender.type === "BOT",
      text: String(message.argumentText ?? message.text ?? ""),
      attachments: Array.isArray(message.attachment)
        ? message.attachment.map((a: any) => ({ name: a.contentName || a.name || "attachment", url: a.downloadUri || null, mime: a.contentType || null, size: null }))
        : [],
      timestamp: message.createTime || null,
      channelMeta: { spaceType: req.body?.space?.type || req.body?.space?.spaceType || null },
    };
    return [ev];
  },

  async sendMessage(ctx, mapping: MappingRef, msg: NormalizedMessage) {
    const body: any = { text: toGoogleChat(msg.text) };
    let path = `${encodeURIComponent(mapping.externalChannelId).replace(/%2F/g, "/")}/messages`;
    if (msg.threadRef) {
      body.thread = { name: msg.threadRef };
      path += "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
    }
    const r = await api(ctx, "POST", path, body);
    expectOk("google_chat", r, "create message");
    return { externalMessageId: String(r.json?.name || ""), externalThreadId: r.json?.thread?.name || msg.threadRef || null };
  },

  async updateMessage(ctx, _mapping, externalMessageId, msg) {
    const r = await api(ctx, "PATCH", `${externalMessageId}?updateMask=text`, { text: toGoogleChat(msg.text) });
    expectOk("google_chat", r, "update message");
  },

  async deleteMessage(ctx, _mapping, externalMessageId) {
    const r = await api(ctx, "DELETE", externalMessageId);
    if (r.status !== 404) expectOk("google_chat", r, "delete message");
  },

  async testConnection(ctx) {
    const r = await api(ctx, "GET", "spaces?pageSize=1");
    expectOk("google_chat", r, "list spaces");
    const n = Array.isArray(r.json?.spaces) ? r.json.spaces.length : 0;
    return { ok: true, detail: n ? `app is a member of at least one space` : "app token valid (no spaces yet)", workspaceId: String(ctx.credentials.projectNumber || "") || null };
  },
};

