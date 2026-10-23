import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

// UNIFIED CONNECTOR ENGINE — pure units (no database, no platform import).
//
//   - transformer: canonical ↔ Slack / Teams / WhatsApp / Google Chat
//   - loop guard: our own bot's events are dropped
//   - credential sealing: AES-GCM round trip, tamper detection, hints, merge
//   - Slack: signature verification, url_verification handshake, event parsing
//   - WhatsApp: hub.challenge handshake, X-Hub-Signature-256, message parsing
//   - Teams: Graph change-notification parsing (fetch stubbed), bot activity
//   - Google Chat: event parsing (both envelopes)
import * as tf from "../src/services/connectors/transformer";
import { verifyEventOrigin, originDropReason } from "../src/services/connectors/loopGuard";
import { sealCredentials, openCredentials, credentialHint, mergeCredentials } from "../src/services/connectors/credentials";
import { slackAdapter } from "../src/services/connectors/adapters/slack";
import { whatsappAdapter } from "../src/services/connectors/adapters/whatsapp";
import { teamsAdapter } from "../src/services/connectors/adapters/teams";
import { googleChatAdapter } from "../src/services/connectors/adapters/googleChat";
import { PlatformError, type AdapterCtx, type InboundRequest } from "../src/services/connectors/types";

const ctxFor = (platform: any, credentials: any, settings: any = {}): AdapterCtx => ({
  account: { id: "acc_1", platform, settings, botIds: [], externalWorkspaceId: null },
  credentials,
  timeoutMs: 2000,
});

const reqOf = (body: any, headers: Record<string, any> = {}, method = "POST", query: any = {}): InboundRequest => {
  const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return { headers, query, rawBody: raw, body: typeof body === "string" ? JSON.parse(body) : body, method };
};

// ── transformer ─────────────────────────────────────────────────────────────
test("canonical → Slack mrkdwn: bold, strike, links, escaping", () => {
  const out = tf.toSlack("**Deploy** done & <ok>, see [runbook](https://x.io/r) ~~old~~ `code`");
  assert.equal(out, "*Deploy* done &amp; &lt;ok&gt;, see <https://x.io/r|runbook> ~old~ `code`");
});

test("canonical → Teams HTML: escaped, tags, line breaks, code protected", () => {
  const out = tf.toTeamsHtml("**Hi** _there_ <b>\nline2 `a<b`");
  assert.equal(out, "<div><b>Hi</b> <i>there</i> &lt;b&gt;<br>line2 <code>a&lt;b</code></div>");
});

test("canonical → WhatsApp: links become text (url), code triple-fenced", () => {
  assert.equal(tf.toWhatsApp("See [docs](https://d.io) **now** `x`"), "See docs (https://d.io) *now* ```x```");
});

test("Slack mrkdwn → canonical: links, mentions, bold, entities", () => {
  const out = tf.fromSlack("<https://x.io|site> and <https://y.io> *bold* ~gone~ <@U1|sam> &amp; <!here>");
  assert.equal(out, "[site](https://x.io) and https://y.io **bold** ~~gone~~ @sam & @here");
});

test("Teams HTML → canonical: strips markup, keeps structure", () => {
  const out = tf.fromTeamsHtml('<div><b>Hi</b> <at>Bot</at>, see <a href="https://x.io">site</a><br>line&nbsp;2 &amp; <i>it</i></div>');
  assert.equal(out, "**Hi** @Bot, see [site](https://x.io)\nline 2 & _it_");
  assert.equal(tf.fromTeamsHtml("plain text"), "plain text");
});

test("WhatsApp → canonical and spec-shaped bold phrases", () => {
  assert.equal(tf.fromWhatsApp("*hey* ~no~"), "**hey** ~~no~~");
  const canon = tf.fromSpecShape({ text: "Release 1.2 is live", boldPhrases: ["Release 1.2"] });
  assert.equal(canon, "**Release 1.2** is live");
  assert.equal(tf.toPlatformFormat(canon, "slack"), "*Release 1.2* is live");
  assert.equal(tf.toPlatformFormat(canon, "whatsapp"), "*Release 1.2* is live");
  assert.equal(tf.toPlatformFormat(canon, "teams_html"), "<div><b>Release 1.2</b> is live</div>");
});

test("attribution header carries the original author across a hop", () => {
  assert.equal(tf.attribute("hello", "Sam", "Slack"), "**Sam** _(via Slack)_\nhello");
  assert.equal(tf.attribute("hello", null, "Slack"), "_(via Slack)_\nhello");
});

// ── loop guard ──────────────────────────────────────────────────────────────
test("verifyEventOrigin drops our own bot by sender id or bot id", () => {
  const ids = ["U_BOT", "B_APP"];
  assert.equal(verifyEventOrigin({ senderId: "U_HUMAN" }, ids), true);
  assert.equal(verifyEventOrigin({ senderId: "U_BOT" }, ids), false);
  assert.equal(verifyEventOrigin({ senderId: "U_HUMAN", botId: "B_APP" }, ids), false);
  assert.match(originDropReason({ botId: "B_APP" }, ids) || "", /own bot/);
  assert.equal(originDropReason({ senderId: "U_HUMAN" }, ids), null);
});

// ── credentials ─────────────────────────────────────────────────────────────
test("credentials seal/open round trip, wrong key and tamper rejected", () => {
  const creds = { botToken: "xoxb-abc-1234", signingSecret: "s3cr3t" };
  const sealed = sealCredentials(creds, "k1");
  assert.doesNotMatch(sealed, /xoxb/);
  assert.deepEqual(openCredentials(sealed, "k1"), creds);
  assert.throws(() => openCredentials(sealed, "k2"));
  const buf = Buffer.from(sealed, "base64");
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => openCredentials(buf.toString("base64"), "k1"));
  assert.deepEqual(openCredentials(null, "k1"), {});
});

test("credential hints are non-secret, merge keeps stored values for blank fields", () => {
  assert.equal(credentialHint("slack", { botToken: "xoxb-abc-1234" }), "xoxb…1234");
  assert.equal(credentialHint("whatsapp", { phoneNumberId: "1055" }), "phone 1055");
  assert.equal(credentialHint("google_chat", { serviceAccountJson: JSON.stringify({ client_email: "svc@p.iam" }) }), "svc@p.iam");
  const merged = mergeCredentials({ botToken: "old", signingSecret: "s" }, { botToken: "new", signingSecret: "" });
  assert.deepEqual(merged, { botToken: "new", signingSecret: "s" });
});

// ── Slack ───────────────────────────────────────────────────────────────────
function slackSign(raw: Buffer, secret: string, ts = Math.floor(Date.now() / 1000)) {
  const sig = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${raw.toString("utf8")}`).digest("hex");
  return { "x-slack-signature": sig, "x-slack-request-timestamp": String(ts) };
}

test("Slack: signature verification accepts valid, rejects tampered and stale", async () => {
  const ctx = ctxFor("slack", { botToken: "xoxb", signingSecret: "sekrit" });
  const body = { type: "event_callback", event_id: "Ev1", event: { type: "message", channel: "C1", user: "U1", ts: "1.1", text: "hi" } };
  const good = reqOf(body, slackSign(Buffer.from(JSON.stringify(body)), "sekrit"));
  assert.equal(await slackAdapter.verifyInbound(good, ctx), true);
  const bad = reqOf(body, slackSign(Buffer.from(JSON.stringify(body)), "wrong"));
  assert.equal(await slackAdapter.verifyInbound(bad, ctx), false);
  const stale = reqOf(body, slackSign(Buffer.from(JSON.stringify(body)), "sekrit", Math.floor(Date.now() / 1000) - 1000));
  assert.equal(await slackAdapter.verifyInbound(stale, ctx), false);
});

test("Slack: url_verification handshake echoes the challenge only when signed", () => {
  const ctx = ctxFor("slack", { botToken: "xoxb", signingSecret: "sekrit" });
  const body = { type: "url_verification", challenge: "abc123" };
  const raw = Buffer.from(JSON.stringify(body));
  const ok = slackAdapter.handshake!(reqOf(body, slackSign(raw, "sekrit")), ctx);
  assert.deepEqual(ok, { status: 200, body: { challenge: "abc123" } });
  const bad = slackAdapter.handshake!(reqOf(body, slackSign(raw, "nope")), ctx);
  assert.equal(bad?.status, 401);
  assert.equal(slackAdapter.handshake!(reqOf({ type: "event_callback" }), ctx), null);
});

test("Slack: parses created / changed / deleted / noise events", async () => {
  const ctx = ctxFor("slack", { botToken: "xoxb", signingSecret: "s" });
  const realFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => new Response(JSON.stringify({ ok: true, user: { real_name: "Sam Slack" } }), { status: 200 });
  try {
    const created = await slackAdapter.parseInbound(
      reqOf({ type: "event_callback", event_id: "Ev1", event: { type: "message", channel: "C1", user: "U1", ts: "2.0", thread_ts: "1.0", text: "yo", files: [{ name: "a.png", url_private: "https://f", mimetype: "image/png", size: 5 }] } }),
      ctx,
    );
    assert.equal(created.length, 1);
    assert.equal(created[0].kind, "message.created");
    assert.equal(created[0].externalMessageId, "2.0");
    assert.equal(created[0].externalThreadId, "1.0");
    assert.equal(created[0].senderName, "Sam Slack");
    assert.equal(created[0].attachments?.[0].name, "a.png");

    const changed = await slackAdapter.parseInbound(
      reqOf({ type: "event_callback", event_id: "Ev2", event: { type: "message", subtype: "message_changed", channel: "C1", message: { ts: "2.0", user: "U1", text: "edited" } } }),
      ctx,
    );
    assert.equal(changed[0].kind, "message.updated");
    assert.equal(changed[0].text, "edited");

    const deleted = await slackAdapter.parseInbound(
      reqOf({ type: "event_callback", event_id: "Ev3", event: { type: "message", subtype: "message_deleted", channel: "C1", deleted_ts: "2.0" } }),
      ctx,
    );
    assert.equal(deleted[0].kind, "message.deleted");
    assert.equal(deleted[0].externalMessageId, "2.0");

    const bot = await slackAdapter.parseInbound(
      reqOf({ type: "event_callback", event_id: "Ev4", event: { type: "message", subtype: "bot_message", bot_id: "B9", channel: "C1", ts: "3.0", text: "from bot" } }),
      ctx,
    );
    assert.equal(bot[0].isBot, true);
    assert.equal(bot[0].botId, "B9");

    const noise = await slackAdapter.parseInbound(
      reqOf({ type: "event_callback", event_id: "Ev5", event: { type: "message", subtype: "channel_join", channel: "C1", ts: "4.0", user: "U2" } }),
      ctx,
    );
    assert.equal(noise[0].kind, "ignored");
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

// ── WhatsApp ────────────────────────────────────────────────────────────────
test("WhatsApp: hub.challenge handshake and X-Hub-Signature-256", async () => {
  const ctx = ctxFor("whatsapp", { accessToken: "t", phoneNumberId: "PN1", appSecret: "appsec", verifyToken: "vt" });
  const hs = whatsappAdapter.handshake!(reqOf({}, {}, "GET", { "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "ch42" }), ctx);
  assert.deepEqual(hs, { status: 200, body: "ch42", contentType: "text/plain" });
  const bad = whatsappAdapter.handshake!(reqOf({}, {}, "GET", { "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "ch42" }), ctx);
  assert.equal(bad?.status, 403);
  assert.equal(whatsappAdapter.handshake!(reqOf({}, {}, "POST"), ctx), null);

  const body = { object: "whatsapp_business_account", entry: [] };
  const raw = Buffer.from(JSON.stringify(body));
  const sig = "sha256=" + crypto.createHmac("sha256", "appsec").update(raw).digest("hex");
  assert.equal(await whatsappAdapter.verifyInbound(reqOf(body, { "x-hub-signature-256": sig }), ctx), true);
  assert.equal(await whatsappAdapter.verifyInbound(reqOf(body, { "x-hub-signature-256": "sha256=00" }), ctx), false);
});

test("WhatsApp: parses text / media / reply context / statuses, ignores other numbers", async () => {
  const ctx = ctxFor("whatsapp", { accessToken: "t", phoneNumberId: "PN1", appSecret: "a", verifyToken: "v" });
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "PN1", display_phone_number: "+1555" },
              contacts: [{ wa_id: "4477", profile: { name: "Wendy" } }],
              messages: [
                { id: "wamid.1", from: "4477", timestamp: "1700000000", type: "text", text: { body: "*hi*" } },
                { id: "wamid.2", from: "4477", timestamp: "1700000001", type: "image", image: { id: "m1", mime_type: "image/jpeg", caption: "pic" }, context: { id: "wamid.1" } },
              ],
              statuses: [{ id: "wamid.out", status: "delivered", recipient_id: "4477" }],
            },
          },
          { value: { messaging_product: "whatsapp", metadata: { phone_number_id: "OTHER" }, messages: [{ id: "x", from: "1", type: "text", text: { body: "no" } }] } },
        ],
      },
    ],
  };
  const evs = await whatsappAdapter.parseInbound(reqOf(body), ctx);
  const created = evs.filter((e) => e.kind === "message.created");
  assert.equal(created.length, 2);
  assert.equal(created[0].senderName, "Wendy");
  assert.equal(created[0].externalChannelId, "4477");
  assert.equal(created[1].externalThreadId, "wamid.1");
  assert.equal(created[1].attachments?.[0].mime, "image/jpeg");
  assert.equal(evs.filter((e) => e.kind === "ignored").length, 1);
  assert.equal(whatsappAdapter.updateMessage, undefined, "no edit API on WhatsApp");
});

// ── Teams ───────────────────────────────────────────────────────────────────
test("Teams: Graph change notification verifies clientState and fetches the message", async () => {
  const ctx = ctxFor("teams", { tenantId: "T", clientId: "C", clientSecret: "S", clientState: "cs-1" });
  const notif = { value: [{ subscriptionId: "sub1", clientState: "cs-1", changeType: "created", resource: "teams('TEAM1')/channels('19:chan@thread.tacv2')/messages('M1')", resourceData: { id: "M1" } }] };
  assert.equal(await teamsAdapter.verifyInbound(reqOf(notif), ctx), true);
  assert.equal(await teamsAdapter.verifyInbound(reqOf({ value: [{ clientState: "wrong" }] }), ctx), false);
  assert.equal(teamsAdapter.handshake!(reqOf({}, {}, "POST", { validationToken: "tok" }), ctx)?.body, "tok");

  const realFetch = (globalThis as any).fetch;
  const calls: string[] = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push(`${init?.method || "GET"} ${url}`);
    if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
    if (url.includes("/messages/M1")) {
      return new Response(
        JSON.stringify({ id: "M1", replyToId: null, from: { user: { id: "U1", displayName: "Tina Teams" } }, body: { contentType: "html", content: "<p><b>hello</b> team</p>" }, createdDateTime: "2026-10-09T10:00:00Z" }),
        { status: 200 },
      );
    }
    return new Response("nope", { status: 404 });
  };
  try {
    const evs = await teamsAdapter.parseInbound(reqOf(notif), ctx);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, "message.created");
    assert.equal(evs[0].externalChannelId, "19:chan@thread.tacv2");
    assert.equal(evs[0].senderName, "Tina Teams");
    assert.equal(evs[0].text, "**hello** team");
    assert.equal(evs[0].channelMeta?.teamId, "TEAM1");
    assert.ok(calls.some((c) => c.includes("/teams/TEAM1/channels/19%3Achan%40thread.tacv2/messages/M1")));
  } finally {
    (globalThis as any).fetch = realFetch;
  }
});

test("Teams: Bot Framework activity is parsed with thread root + self-detection", async () => {
  const ctx = ctxFor("teams", { tenantId: "T", clientId: "C", clientSecret: "S" });
  const activity = {
    type: "message",
    id: "A2",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    conversation: { id: "19:chan@thread.tacv2;messageid=A1", conversationType: "channel", tenantId: "T" },
    from: { id: "29:user", name: "Bob", role: "user" },
    recipient: { id: "28:bot" },
    text: "<at>CoLab</at> ping",
    channelData: { team: { id: "TEAM1" } },
  };
  const [ev] = await teamsAdapter.parseInbound(reqOf(activity), ctx);
  assert.equal(ev.externalChannelId, "19:chan@thread.tacv2");
  assert.equal(ev.externalThreadId, "A1");
  assert.equal(ev.text, "ping");
  assert.equal(ev.channelMeta?.serviceUrl, activity.serviceUrl);
  assert.equal(ev.channelMeta?.botId, "28:bot");
  const [self] = await teamsAdapter.parseInbound(reqOf({ ...activity, id: "A3", from: { id: "28:bot", role: "bot" } }), ctx);
  assert.equal(self.isBot, true);
});

// ── Google Chat ─────────────────────────────────────────────────────────────
test("Google Chat: parses both event envelopes, flags bots", async () => {
  const ctx = ctxFor("google_chat", { serviceAccountJson: "{}", projectNumber: "123" });
  const legacy = { type: "MESSAGE", eventTime: "2026-10-09T10:00:00Z", space: { name: "spaces/S1", type: "ROOM" }, message: { name: "spaces/S1/messages/M1", thread: { name: "spaces/S1/threads/T1" }, sender: { name: "users/1", displayName: "Gina", type: "HUMAN" }, text: "hey *all*" } };
  const [ev] = await googleChatAdapter.parseInbound(reqOf(legacy), ctx);
  assert.equal(ev.kind, "message.created");
  assert.equal(ev.externalChannelId, "spaces/S1");
  assert.equal(ev.externalThreadId, "spaces/S1/threads/T1");
  assert.equal(ev.senderName, "Gina");
  const modern = { chat: { messagePayload: { space: { name: "spaces/S2" }, message: { name: "spaces/S2/messages/M2", sender: { name: "users/app", type: "BOT" }, text: "bot says" } } } };
  const [ev2] = await googleChatAdapter.parseInbound(reqOf(modern), ctx);
  assert.equal(ev2.externalChannelId, "spaces/S2");
  assert.equal(ev2.isBot, true);
  const [added] = await googleChatAdapter.parseInbound(reqOf({ type: "ADDED_TO_SPACE", space: { name: "spaces/S3" } }), ctx);
  assert.equal(added.kind, "ignored");
});

test("PlatformError retry classification", () => {
  assert.equal(new PlatformError("slack", "x", { status: 500 }).retryable, true);
  assert.equal(new PlatformError("slack", "x", { status: 429 }).retryable, true);
  assert.equal(new PlatformError("slack", "x", { status: 400 }).retryable, false);
  assert.equal(new PlatformError("slack", "x", { status: null }).retryable, true);
});
