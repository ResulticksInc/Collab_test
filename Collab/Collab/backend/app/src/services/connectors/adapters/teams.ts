// Microsoft Teams adapter — two inbound shapes, two outbound paths, one account.
//
//   GRAPH (application permissions: ChannelMessage.Read.All / Chat.Read.All,
//   Calendars.ReadWrite …): inbound = change notifications (a subscription on
//   /teams/{t}/channels/{c}/messages); we verify the echoed clientState, then
//   FETCH the message. Outbound = POST …/channels/{c}/messages (HTML body).
//
//   BOT FRAMEWORK (the registration's messaging endpoint): inbound = `message`
//   activities signed with a Bot Connector JWT (verified against the Bot
//   Framework JWKS, audience = the app id). Outbound = reply through the
//   activity's serviceUrl. A mapping that has learned a serviceUrl from an
//   activity replies that way; otherwise Graph is used.
import crypto from "crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { callJson, expectOk } from "../http";
import { getBotFrameworkToken, getMicrosoftToken } from "../oauth";
import { fromTeamsHtml, toTeamsHtml, toTeamsMarkdown } from "../transformer";
import {
  type AdapterCtx,
  type ChatAdapter,
  type InboundEvent,
  type InboundRequest,
  type MappingRef,
  type NormalizedMessage,
  PlatformError,
} from "../types";

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const BOT_ISSUER = "https://api.botframework.com";
let botJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks() {
  if (!botJwks) botJwks = createRemoteJWKSet(new URL("https://login.botframework.com/v1/.well-known/keys"));
  return botJwks;
}

const graphBase = (ctx: AdapterCtx) => `https://graph.microsoft.com/${ctx.account.settings?.graphApiVersion || "v1.0"}`;

async function graph(ctx: AdapterCtx, method: string, path: string, body?: any) {
  const token = await getMicrosoftToken("teams", ctx.credentials, GRAPH_SCOPE, ctx.timeoutMs);
  const r = await callJson("teams", `${graphBase(ctx)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body,
    timeoutMs: ctx.timeoutMs,
  });
  return r;
}

// "teams('T')/channels('C')/messages('M')" | "…/messages('M')/replies('R')" |
// "chats('X')/messages('M')" → routing ids.
function parseResource(resource: string) {
  const g = (re: RegExp) => {
    const m = re.exec(resource);
    return m ? decodeURIComponent(m[1]) : null;
  };
  return {
    teamId: g(/teams\('([^']+)'\)/i),
    channelId: g(/channels\('([^']+)'\)/i),
    chatId: g(/chats\('([^']+)'\)/i),
    messageId: g(/messages\('([^']+)'\)/i),
    replyId: g(/replies\('([^']+)'\)/i),
  };
}

function constantEq(a: string, b: string) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const isActivity = (body: any) => body && typeof body.type === "string" && body.serviceUrl && body.conversation;
const isNotification = (body: any) => body && Array.isArray(body.value);

function messagePath(meta: Record<string, any>, channelId: string, messageId?: string, replyId?: string) {
  const base = meta.teamId
    ? `/teams/${encodeURIComponent(meta.teamId)}/channels/${encodeURIComponent(channelId)}/messages`
    : `/chats/${encodeURIComponent(channelId)}/messages`;
  if (!messageId) return base;
  return replyId ? `${base}/${encodeURIComponent(messageId)}/replies/${encodeURIComponent(replyId)}` : `${base}/${encodeURIComponent(messageId)}`;
}

function eventFromGraphMessage(m: any, ids: ReturnType<typeof parseResource>, changeType: string, eventId: string): InboundEvent {
  const channelId = ids.channelId || ids.chatId || "";
  const isReply = !!(ids.replyId || m?.replyToId);
  const kind = changeType === "deleted" || m?.deletedDateTime ? "message.deleted" : changeType === "updated" ? "message.updated" : "message.created";
  return {
    kind,
    externalEventId: eventId,
    externalChannelId: channelId,
    externalMessageId: String(ids.replyId || m?.id || ids.messageId || ""),
    externalThreadId: isReply ? String(m?.replyToId || ids.messageId || "") : null,
    senderId: m?.from?.user?.id || m?.from?.application?.id || null,
    senderName: m?.from?.user?.displayName || m?.from?.application?.displayName || null,
    botId: m?.from?.application?.id || null,
    isBot: !!m?.from?.application,
    text: m?.body?.contentType === "html" ? fromTeamsHtml(m.body.content || "") : String(m?.body?.content || ""),
    attachments: Array.isArray(m?.attachments)
      ? m.attachments.map((a: any) => ({ name: a.name || "attachment", url: a.contentUrl || null, mime: a.contentType || null, size: null }))
      : [],
    timestamp: m?.lastModifiedDateTime || m?.createdDateTime || null,
    channelMeta: { teamId: ids.teamId || null, kind: ids.chatId ? "chat" : "channel", via: "graph" },
  };
}

export const teamsAdapter: ChatAdapter = {
  platform: "teams",

  handshake(req) {
    // Graph validates a new subscription's notification URL by sending
    // ?validationToken=… and expecting it echoed as text/plain within 10s.
    const vt = req.query?.validationToken;
    if (vt) return { status: 200, body: String(vt), contentType: "text/plain" };
    return null;
  },

  async verifyInbound(req, ctx) {
    const body = req.body;
    if (isNotification(body)) {
      const expected = String(ctx.credentials.clientState || "");
      if (!expected) return false;
      return body.value.every((n: any) => constantEq(String(n.clientState || ""), expected));
    }
    if (isActivity(body)) {
      const auth = String(req.headers.authorization || "");
      if (!auth.startsWith("Bearer ")) return false;
      const appId = String(ctx.credentials.clientId || "");
      if (!appId) return false;
      try {
        await jwtVerify(auth.slice(7), jwks(), { issuer: BOT_ISSUER, audience: appId, clockTolerance: 300 });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  },

  async parseInbound(req, ctx) {
    const body = req.body;
    const out: InboundEvent[] = [];
    if (isNotification(body)) {
      for (const n of body.value) {
        const ids = parseResource(String(n.resource || ""));
        const channelId = ids.channelId || ids.chatId;
        const msgId = ids.replyId || ids.messageId || n.resourceData?.id;
        if (!channelId || !msgId) continue;
        const eventId = String(n.subscriptionId || "sub") + ":" + String(n.resource) + ":" + String(n.changeType) + ":" + String(n.resourceData?.["@odata.etag"] || n.subscriptionExpirationDateTime || "");
        if (n.changeType === "deleted") {
          out.push(eventFromGraphMessage(null, ids, "deleted", eventId));
          continue;
        }
        // Notifications are a pointer, not the message: fetch it.
        const meta = { teamId: ids.teamId };
        const r = await graph(ctx, "GET", messagePath(meta, channelId, ids.messageId || msgId, ids.replyId || undefined));
        if (r.status === 404) continue;
        expectOk("teams", r, "fetch message");
        out.push(eventFromGraphMessage(r.json, ids, String(n.changeType || "created"), eventId));
      }
      return out;
    }
    if (isActivity(body)) {
      if (body.type !== "message") return [{ kind: "ignored", externalEventId: String(body.id), externalChannelId: String(body.conversation?.id || ""), externalMessageId: String(body.id), text: "", ignoreReason: `activity ${body.type}` }];
      // Channel conversation ids carry the thread root as ";messageid=<root>".
      const rawConv = String(body.conversation?.id || "");
      const [convId, rootPart] = rawConv.split(";messageid=");
      const selfId = body.recipient?.id || null;
      const fromId = body.from?.id || null;
      const text = String(body.text || "").replace(/<at>[^<]*<\/at>/gi, "").trim();
      out.push({
        kind: "message.created",
        externalEventId: String(body.id),
        externalChannelId: convId,
        externalMessageId: String(body.id),
        externalThreadId: rootPart && rootPart !== String(body.id) ? rootPart : null,
        senderId: fromId,
        senderName: body.from?.name || null,
        botId: body.from?.role === "bot" ? fromId : null,
        isBot: body.from?.role === "bot" || (!!selfId && fromId === selfId),
        text: body.textFormat === "xml" ? fromTeamsHtml(text) : text,
        attachments: Array.isArray(body.attachments)
          ? body.attachments
              .filter((a: any) => a.contentType !== "text/html")
              .map((a: any) => ({ name: a.name || "attachment", url: a.contentUrl || null, mime: a.contentType || null, size: null }))
          : [],
        timestamp: body.timestamp || null,
        channelMeta: {
          via: "bot",
          serviceUrl: body.serviceUrl,
          tenantId: body.conversation?.tenantId || body.channelData?.tenant?.id || null,
          teamId: body.channelData?.team?.id || null,
          conversationType: body.conversation?.conversationType || null,
          botId: selfId,
        },
      });
      return out;
    }
    return out;
  },

  async sendMessage(ctx, mapping: MappingRef, msg: NormalizedMessage) {
    const meta = mapping.externalMeta || {};
    if (meta.serviceUrl && !ctx.account.settings?.preferGraph) {
      const token = await getBotFrameworkToken(ctx.credentials, ctx.timeoutMs);
      const conv = msg.threadRef ? `${mapping.externalChannelId};messageid=${msg.threadRef}` : mapping.externalChannelId;
      const r = await callJson("teams", `${String(meta.serviceUrl).replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(conv)}/activities`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: { type: "message", textFormat: "markdown", text: toTeamsMarkdown(msg.text) },
        timeoutMs: ctx.timeoutMs,
      });
      expectOk("teams", r, "bot reply");
      return { externalMessageId: String(r.json?.id || ""), externalThreadId: msg.threadRef || null };
    }
    const path = msg.threadRef
      ? `${messagePath(meta, mapping.externalChannelId, msg.threadRef)}/replies`
      : messagePath(meta, mapping.externalChannelId);
    const r = await graph(ctx, "POST", path, { body: { contentType: "html", content: toTeamsHtml(msg.text) } });
    expectOk("teams", r, "post message");
    return { externalMessageId: String(r.json?.id || ""), externalThreadId: msg.threadRef || null };
  },

  async updateMessage(ctx, mapping, externalMessageId, msg) {
    const meta = mapping.externalMeta || {};
    if (meta.serviceUrl && !ctx.account.settings?.preferGraph) {
      const token = await getBotFrameworkToken(ctx.credentials, ctx.timeoutMs);
      const r = await callJson("teams", `${String(meta.serviceUrl).replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(mapping.externalChannelId)}/activities/${encodeURIComponent(externalMessageId)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}` },
        body: { type: "message", textFormat: "markdown", text: toTeamsMarkdown(msg.text) },
        timeoutMs: ctx.timeoutMs,
      });
      expectOk("teams", r, "bot update");
      return;
    }
    const path = msg.threadRef
      ? messagePath(meta, mapping.externalChannelId, msg.threadRef, externalMessageId)
      : messagePath(meta, mapping.externalChannelId, externalMessageId);
    const r = await graph(ctx, "PATCH", path, { body: { contentType: "html", content: toTeamsHtml(msg.text) } });
    expectOk("teams", r, "update message");
  },

  async deleteMessage(ctx, mapping, externalMessageId) {
    const meta = mapping.externalMeta || {};
    if (meta.serviceUrl && !ctx.account.settings?.preferGraph) {
      const token = await getBotFrameworkToken(ctx.credentials, ctx.timeoutMs);
      const r = await callJson("teams", `${String(meta.serviceUrl).replace(/\/$/, "")}/v3/conversations/${encodeURIComponent(mapping.externalChannelId)}/activities/${encodeURIComponent(externalMessageId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: ctx.timeoutMs,
      });
      if (r.status !== 404) expectOk("teams", r, "bot delete");
      return;
    }
    const r = await graph(ctx, "POST", `${messagePath(meta, mapping.externalChannelId, externalMessageId)}/softDelete`);
    if (r.status !== 404) expectOk("teams", r, "soft-delete message");
  },

  async testConnection(ctx) {
    const r = await graph(ctx, "GET", "/organization?$select=id,displayName");
    expectOk("teams", r, "organization");
    const org = r.json?.value?.[0];
    if (!org) throw new PlatformError("teams", "Graph returned no organization for this tenant", { status: 400, retryable: false });
    return { ok: true, detail: org.displayName, workspaceId: org.id, botIds: ctx.credentials.clientId ? [String(ctx.credentials.clientId)] : [] };
  },
};
