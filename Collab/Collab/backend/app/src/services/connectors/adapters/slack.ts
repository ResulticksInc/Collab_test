// Slack adapter — Events API in, Web API (chat.postMessage / update / delete) out.
//
// Inbound verification: Slack signs every request with the app's signing
// secret: `v0=HMAC_SHA256(secret, "v0:<ts>:<raw body>")` in X-Slack-Signature,
// and we refuse anything older than 5 minutes (replay window).
import crypto from "crypto";
import { callJson, expectOk } from "../http";
import { toSlack } from "../transformer";
import {
  type AdapterCtx,
  type ChatAdapter,
  type InboundEvent,
  type InboundRequest,
  type MappingRef,
  type NormalizedMessage,
  PlatformError,
} from "../types";

const API = "https://slack.com/api";

function verifySignature(req: InboundRequest, signingSecret: string): boolean {
  const sig = String(req.headers["x-slack-signature"] || "");
  const ts = String(req.headers["x-slack-request-timestamp"] || "");
  if (!sig || !ts || !signingSecret) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${req.rawBody.toString("utf8")}`;
  const expected =
    "v0=" +
    crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Slack events carry user IDs, not names. Resolve through users.info with a
// per-account cache so a chatty channel costs one lookup per person per hour.
const nameCache = new Map<string, { name: string | null; exp: number }>();
async function resolveUserName(
  ctx: AdapterCtx,
  userId: string,
): Promise<string | null> {
  if (!userId) return null;
  const k = `${ctx.account.id}:${userId}`;
  const hit = nameCache.get(k);
  if (hit && hit.exp > Date.now()) return hit.name;
  let name: string | null = null;
  try {
    const r = await callJson(
      "slack",
      `${API}/users.info?user=${encodeURIComponent(userId)}`,
      {
        headers: { authorization: `Bearer ${ctx.credentials.botToken}` },
        timeoutMs: ctx.timeoutMs,
      },
    );
    const u = r.json?.ok ? r.json.user : null;
    name = (u && (u.profile?.display_name || u.real_name || u.name)) || null;
  } catch {
    name = null;
  }
  nameCache.set(k, { name, exp: Date.now() + 3600_000 });
  if (nameCache.size > 5000)
    for (const [key, v] of nameCache)
      if (v.exp <= Date.now()) nameCache.delete(key);
  return name;
}

async function api(ctx: AdapterCtx, method: string, body: any) {
  const r = await callJson("slack", `${API}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.credentials.botToken}`,
      "content-type": "application/json; charset=utf-8",
    },
    body,
    timeoutMs: ctx.timeoutMs,
  });
  expectOk("slack", r, method);
  if (!r.json?.ok) {
    const err = String(r.json?.error || "unknown_error");
    // Slack reports throttling as ok:false with HTTP 200/429 — retry those,
    // and nothing else (invalid_auth / channel_not_found never fix themselves).
    const retryable = [
      "ratelimited",
      "rate_limited",
      "internal_error",
      "service_unavailable",
      "fatal_error",
    ].includes(err);
    throw new PlatformError("slack", `${method}: ${err}`, {
      status: retryable ? 429 : 400,
      retryable,
      body: r.json,
    });
  }
  return r.json;
}

function filesOf(ev: any) {
  return Array.isArray(ev?.files)
    ? ev.files.map((f: any) => ({
        name: f.name || f.title || "file",
        url: f.url_private || null,
        mime: f.mimetype || null,
        size: f.size || null,
      }))
    : [];
}

export const slackAdapter: ChatAdapter = {
  platform: "slack",

  handshake(req, ctx) {
    if (req.body?.type !== "url_verification") return null;
    // The challenge is signed too — refuse to confirm an endpoint for an app
    // whose signing secret we do not hold.
    if (!verifySignature(req, String(ctx.credentials.signingSecret || "")))
      return { status: 401, body: { error: "bad signature" } };
    return { status: 200, body: { challenge: req.body.challenge } };
  },

  async verifyInbound(req, ctx) {
    return verifySignature(req, String(ctx.credentials.signingSecret || ""));
  },

  async parseInbound(req, ctx) {
    const body = req.body;
    if (!body || body.type !== "event_callback" || !body.event) return [];
    const ev = body.event;
    const eventId = String(
      body.event_id || `${ev.channel}:${ev.ts || ev.event_ts}`,
    );
    const channel = String(ev.channel || ev.item?.channel || "");
    if (ev.type !== "message" || !channel) return [];
    const sub = ev.subtype || null;
    const base = {
      externalEventId: eventId,
      externalChannelId: channel,
      channelMeta: { channelType: ev.channel_type || null },
    };

    if (sub === "message_changed" && ev.message) {
      const m = ev.message;
      return [
        {
          ...base,
          kind: "message.updated",
          externalMessageId: String(m.ts),
          externalThreadId:
            m.thread_ts && m.thread_ts !== m.ts ? String(m.thread_ts) : null,
          senderId: m.user || null,
          senderName: m.user
            ? (await resolveUserName(ctx, m.user)) || m.user
            : m.username || null,
          botId: m.bot_id || null,
          isBot: !!m.bot_id || m.subtype === "bot_message",
          text: String(m.text || ""),
          attachments: filesOf(m),
          timestamp: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : null,
        } as InboundEvent,
      ];
    }
    if (sub === "message_deleted") {
      const ts = ev.deleted_ts || ev.previous_message?.ts;
      if (!ts) return [];
      return [
        {
          ...base,
          kind: "message.deleted",
          externalMessageId: String(ts),
          senderId: ev.previous_message?.user || null,
          botId: ev.previous_message?.bot_id || null,
          isBot: !!ev.previous_message?.bot_id,
          text: "",
        } as InboundEvent,
      ];
    }
    // Plain messages, file shares and "also send to channel" thread broadcasts
    // are new messages. Joins/leaves/topic changes/pins are channel noise.
    if (
      sub &&
      !["file_share", "thread_broadcast", "bot_message"].includes(sub)
    ) {
      return [
        {
          ...base,
          kind: "ignored",
          externalMessageId: String(ev.ts || ""),
          text: "",
          ignoreReason: `subtype ${sub}`,
        } as InboundEvent,
      ];
    }
    if (!ev.ts) return [];
    return [
      {
        ...base,
        kind: "message.created",
        externalMessageId: String(ev.ts),
        externalThreadId:
          ev.thread_ts && ev.thread_ts !== ev.ts ? String(ev.thread_ts) : null,
        senderId: ev.user || null,
        senderName: ev.user
          ? (await resolveUserName(ctx, ev.user)) || ev.user
          : ev.username || null,
        botId: ev.bot_id || null,
        isBot: !!ev.bot_id || sub === "bot_message",
        text: String(ev.text || ""),
        attachments: filesOf(ev),
        timestamp: new Date(Number(ev.ts) * 1000).toISOString(),
      } as InboundEvent,
    ];
  },

  async sendMessage(ctx, mapping: MappingRef, msg: NormalizedMessage) {
    const payload: any = {
      channel: mapping.externalChannelId,
      text: toSlack(msg.text),
      unfurl_links: false,
      unfurl_media: false,
    };
    if (msg.threadRef) payload.thread_ts = msg.threadRef;
    // Optional: with chat:write.customize the bot can post under the original
    // author's name instead of a text prefix (settings.customizeSender).
    if (ctx.account.settings?.customizeSender && msg.authorName)
      payload.username = msg.authorName;
    const r = await api(ctx, "chat.postMessage", payload);
    return {
      externalMessageId: String(r.ts),
      externalThreadId: msg.threadRef || null,
      raw: { channel: r.channel },
    };
  },

  async updateMessage(ctx, mapping, externalMessageId, msg) {
    await api(ctx, "chat.update", {
      channel: mapping.externalChannelId,
      ts: externalMessageId,
      text: toSlack(msg.text),
    });
  },

  async deleteMessage(ctx, mapping, externalMessageId) {
    try {
      await api(ctx, "chat.delete", {
        channel: mapping.externalChannelId,
        ts: externalMessageId,
      });
    } catch (e: any) {
      if (e?.body?.error === "message_not_found") return; // already gone
      throw e;
    }
  },

  async testConnection(ctx) {
    const r = await api(ctx, "auth.test", {});
    return {
      ok: true,
      detail: `${r.team} as ${r.user}`,
      botIds: [r.user_id, r.bot_id].filter(Boolean),
      workspaceId: r.team_id || null,
    };
  },
};
