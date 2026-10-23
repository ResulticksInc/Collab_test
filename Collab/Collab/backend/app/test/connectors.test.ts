import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { useTestDatabase } from "./_setup";

// UNIFIED CONNECTOR ENGINE — driven through the real services + MySQL driver
// against the throwaway `colab_test` schema (same strategy as webhooks.test.ts:
// skip if MySQL is unreachable). Every platform HTTP call is stubbed at
// globalThis.fetch, so the suite exercises the engine, the queue and the
// adapters' request shapes without touching Slack/Google.
//
// Covers:
//   - accounts: credentials sealed at rest, never echoed, org-scoped
//   - mappings: conversation-membership gate, duplicate refusal
//   - inbound (Slack): signature gate, handshake, bridged message attributed to
//     the owner with the original author in the text, message mapping recorded,
//     duplicate event dropped, own-bot event dropped, unmapped channel dropped
//   - loop guard: an inbound message never enqueues an outbound job on the
//     mapping it arrived through
//   - outbound: a CoLab message enqueues ONE job per mapping (dedupe on retry),
//     the worker posts it (chat.postMessage shape) and records the mapping
//   - echo guard: the platform's own event for OUR post is dropped
//   - threading: a Slack thread reply lands as a CoLab reply to the bridged root
//   - queue: unknown job kind → permanent failure; retry re-arms it
//   - calendar: creating a meeting enqueues calendar.upsert for a Google
//     Calendar account and the worker records the external event id

let dbUp = false;
let db: any;
let connectors: any;
let ingest: any;
let messageService: any;
let meetingService: any;
let shared: any;

const A = "u_cntest_a";
const B = "u_cntest_b";
const OUTSIDER = "u_cntest_x";
let groupId: string;

// ── fetch stub: routes by URL, records every call ───────────────────────────
const calls: { url: string; method: string; body: any; headers: any }[] = [];
let realFetch: any;
let postCounter = 100;
function installFetchStub() {
  realFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const body = (() => {
      try {
        return typeof init.body === "string" ? JSON.parse(init.body) : init.body ? String(init.body) : null;
      } catch {
        return String(init.body);
      }
    })();
    calls.push({ url, method: init.method || "GET", body, headers: init.headers || {} });
    const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://slack.com/api/users.info")) return json({ ok: true, user: { real_name: "Sam Slack" } });
    if (url.startsWith("https://slack.com/api/chat.postMessage")) return json({ ok: true, ts: `1700000000.${++postCounter}`, channel: body.channel });
    if (url.startsWith("https://slack.com/api/chat.update")) return json({ ok: true, ts: body.ts });
    if (url.startsWith("https://slack.com/api/chat.delete")) return json({ ok: true });
    if (url.startsWith("https://slack.com/api/auth.test")) return json({ ok: true, team: "Acme", user: "colab", user_id: "U_BOT", bot_id: "B_BOT", team_id: "T1" });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "g-at", expires_in: 3600 });
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events") && (init.method || "GET") === "POST")
      return json({ id: "gcal-ev-1", hangoutLink: "https://meet.google.com/abc-defg-hij", updated: "2026-10-09T10:00:00.000Z" });
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events/") && init.method === "PATCH")
      return json({ id: "gcal-ev-1", hangoutLink: "https://meet.google.com/abc-defg-hij", updated: "2026-10-09T11:00:00.000Z" });
    return new Response(JSON.stringify({ error: `unstubbed ${init.method || "GET"} ${url}` }), { status: 599 });
  };
}

const waitFor = async (fn: () => Promise<any>, ms = 6000, every = 100) => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, every));
  }
};

function slackReq(body: any, secret: string, extra: Record<string, any> = {}) {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  const ts = Math.floor(Date.now() / 1000);
  const sig = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${raw.toString("utf8")}`).digest("hex");
  return { headers: { "x-slack-signature": sig, "x-slack-request-timestamp": String(ts), ...extra }, query: {}, rawBody: raw, body, method: "POST" };
}
const slackMessage = (eventId: string, ts: string, text: string, opts: any = {}) => ({
  type: "event_callback",
  event_id: eventId,
  event: { type: "message", channel: opts.channel || "C_MAPPED", user: opts.user || "U_HUMAN", ts, text, ...(opts.thread_ts ? { thread_ts: opts.thread_ts } : {}), ...(opts.bot_id ? { bot_id: opts.bot_id } : {}) },
});

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  process.env.CONNECTORS_ENABLED = "true";
  process.env.CONNECTORS_INSECURE_SKIP_VERIFY = "false";
  process.env.REDIS_URL = ""; // idempotency on the in-memory fallback
  installFetchStub();
  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    shared = platform.shared;
    await migrate(platform.config.database.url);
    connectors = await import("../src/services/connectorService");
    ingest = await import("../src/services/connectorIngestService");
    messageService = await import("../src/services/messageService");
    meetingService = await import("../src/services/meetingService");
    for (const [id, name] of [
      [A, "Connector Test A"],
      [B, "Connector Test B"],
      [OUTSIDER, "Connector Test Outsider"],
    ] as const) {
      await db.users.upsert({ id, email: id + "@ex.com", name, initials: "CT", color: "#2563EB", presence: "off", passwordHash: null });
    }
    const group = await db.conversations.create({ kind: shared.CONVERSATION.GROUP, title: "Connector Test Group", icon: "🔌", createdBy: A });
    groupId = group.id;
    await db.conversations.addMember(groupId, A, { role: "owner" });
    await db.conversations.addMember(groupId, B, { role: "member" });
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — DB cases will skip:", e.message);
  }
});

after(async () => {
  (globalThis as any).fetch = realFetch;
  if (db?.pool?.end) await db.pool.end();
});

const dbTest = (name: string, fn: any) =>
  test(name, async (t) => {
    if (!dbUp) {
      t.skip("MySQL not available");
      return;
    }
    await fn(t);
  });

let slackAccountId: string;
let mappingId: string;
const SIGNING = "slack-signing-secret";

// ── Accounts ────────────────────────────────────────────────────────────────
dbTest("an account seals its credentials and never echoes them", async () => {
  const acc = await connectors.createAccount({
    platform: "slack",
    name: "Acme Slack",
    credentials: { botToken: "xoxb-test-token-9999", signingSecret: SIGNING },
    botIds: ["U_BOT", "B_BOT"],
    createdBy: A,
    organizationId: null,
  });
  slackAccountId = acc.id;
  assert.equal(acc.hasCredentials, true);
  assert.equal(acc.credentialHint, "xoxb…9999");
  assert.equal(JSON.stringify(acc).includes("xoxb-test-token"), false, "plaintext token must not leave the service");
  const row = await db.connectors.getAccount(acc.id);
  assert.equal(String(row.credentialsEnc).includes("xoxb"), false, "sealed at rest");
  assert.match(acc.inboundUrl, /\/api\/connectors\/in\/slack\//);
  // Org scoping: a different org cannot see it.
  await assert.rejects(() => connectors.getAccount(acc.id, "org_other"), (e: any) => e.status === 404);
  const mine = await connectors.listAccounts(null);
  assert.ok(mine.some((a: any) => a.id === acc.id));
});

dbTest("required credential fields and unknown platforms are refused", async () => {
  await assert.rejects(() => connectors.createAccount({ platform: "slack", credentials: { botToken: "x" }, createdBy: A, organizationId: null }), /signingSecret/);
  await assert.rejects(() => connectors.createAccount({ platform: "irc", credentials: {}, createdBy: A, organizationId: null }), /Unknown platform/);
});

dbTest("test-connection records the platform's bot ids for the loop guard", async () => {
  const r = await connectors.testAccount(slackAccountId, null);
  assert.equal(r.ok, true);
  const row = await db.connectors.getAccount(slackAccountId);
  assert.ok(row.botIds.includes("U_BOT") && row.botIds.includes("B_BOT"));
  assert.equal(row.externalWorkspaceId, "T1");
});

// ── Mappings ────────────────────────────────────────────────────────────────
dbTest("a mapping needs conversation membership; duplicates are refused", async () => {
  await assert.rejects(
    () => connectors.createMapping({ ownerId: OUTSIDER, organizationId: null, accountId: slackAccountId, conversationId: groupId, externalChannelId: "C_MAPPED" }),
    (e: any) => e.status === 403,
  );
  const m = await connectors.createMapping({ ownerId: A, organizationId: null, accountId: slackAccountId, conversationId: groupId, externalChannelId: "C_MAPPED", externalChannelName: "#general" });
  mappingId = m.id;
  assert.equal(m.scope, "group");
  assert.equal(m.platform, "slack");
  await assert.rejects(
    () => connectors.createMapping({ ownerId: A, organizationId: null, accountId: slackAccountId, conversationId: groupId, externalChannelId: "C_MAPPED" }),
    (e: any) => e.status === 409,
  );
  await assert.rejects(() => connectors.listMappingsForConversation(groupId, OUTSIDER), (e: any) => e.status === 403);
  const listed = await connectors.listMappingsForConversation(groupId, B);
  assert.equal(listed.length, 1);
});

// ── Inbound ─────────────────────────────────────────────────────────────────
dbTest("inbound: bad signature is a 401, handshake answers the challenge", async () => {
  const bad = await ingest.handleInbound("slack", slackAccountId, slackReq(slackMessage("EvBad", "1.0", "x"), "wrong-secret"));
  assert.equal(bad.status, 401);
  const hs = await ingest.handleInbound("slack", slackAccountId, slackReq({ type: "url_verification", challenge: "c-1" }, SIGNING));
  assert.deepEqual([hs.status, hs.body], [200, { challenge: "c-1" }]);
  const unknown = await ingest.handleInbound("slack", "no-such-account", slackReq({}, SIGNING));
  assert.equal(unknown.status, 404);
  const wrongPlatform = await ingest.handleInbound("teams", slackAccountId, slackReq({}, SIGNING));
  assert.equal(wrongPlatform.status, 404);
});

let bridgedRootId: string;
dbTest("inbound: a Slack message lands in the mapped conversation, attributed and mapped", async () => {
  const r = await ingest.handleInbound("slack", slackAccountId, slackReq(slackMessage("Ev1", "1700000000.000100", "hello *world* <https://x.io|site>"), SIGNING));
  assert.equal(r.status, 200);
  assert.equal(r.summary.accepted, 1, JSON.stringify(r.summary));
  const msg = r.posted[0].message;
  bridgedRootId = msg.id;
  assert.equal(r.posted[0].conversationId, groupId);
  assert.equal(msg.sender.id, A, "posted AS the mapping owner");
  assert.match(msg.text, /\*\*Sam Slack\*\* _\(via Slack\)_/);
  assert.match(msg.text, /hello \*\*world\*\* \[site\]\(https:\/\/x\.io\)/);
  const mm = await db.connectors.findByExternal(mappingId, "1700000000.000100");
  assert.ok(mm && mm.direction === "in" && mm.messageId === msg.id);
  // Visible through the ordinary message history for every member.
  const hist = await messageService.history(groupId, B);
  assert.ok(hist.some((m: any) => m.id === msg.id));
});

dbTest("loop guard: the bridged message never enqueues an outbound job on its own mapping", async () => {
  await new Promise((r) => setTimeout(r, 300)); // dispatch is fire-and-forget
  const jobs = await db.connectors.listJobs({ mappingId });
  assert.equal(jobs.length, 0, "no echo job for the source mapping");
});

dbTest("inbound: duplicate event, own-bot event and unmapped channel are dropped", async () => {
  const dup = await ingest.handleInbound("slack", slackAccountId, slackReq(slackMessage("Ev1", "1700000000.000100", "hello again"), SIGNING));
  assert.equal(dup.summary.accepted, 0);
  assert.match(dup.summary.reasons.join(" "), /duplicate/);
  const bot = await ingest.handleInbound("slack", slackAccountId, slackReq(slackMessage("Ev2", "1700000000.000200", "I am the bot", { user: "U_BOT" }), SIGNING));
  assert.equal(bot.summary.accepted, 0);
  assert.match(bot.summary.reasons.join(" "), /own bot/);
  const unmapped = await ingest.handleInbound("slack", slackAccountId, slackReq(slackMessage("Ev3", "1700000000.000300", "elsewhere", { channel: "C_OTHER" }), SIGNING));
  assert.equal(unmapped.summary.accepted, 0);
  assert.match(unmapped.summary.reasons.join(" "), /no mapping/);
});

dbTest("threading: a Slack thread reply becomes a CoLab reply to the bridged root", async () => {
  const r = await ingest.handleInbound("slack", slackAccountId, slackReq(slackMessage("Ev4", "1700000000.000400", "in thread", { thread_ts: "1700000000.000100" }), SIGNING));
  assert.equal(r.summary.accepted, 1, JSON.stringify(r.summary));
  assert.equal(r.posted[0].message.parentMessageId, bridgedRootId);
});

// ── Outbound ────────────────────────────────────────────────────────────────
let outboundMsgId: string;
dbTest("outbound: a CoLab message is posted to Slack by the worker and mapped", async () => {
  calls.length = 0;
  const msg = await messageService.send({ conversationId: groupId, senderId: B, text: "reply **from** CoLab", file: null });
  outboundMsgId = msg.id;
  const job = await waitFor(async () => (await db.connectors.listJobs({ mappingId })).find((j: any) => j.kind === "outbound.message.created" && j.summary === undefined && JSON.stringify(j.payload).includes(msg.id)));
  assert.ok(job);
  await connectors.drain();
  const done = await waitFor(async () => {
    const j = await db.connectors.getJob(job.id);
    return j.status === "done" ? j : null;
  });
  assert.equal(done.status, "done");
  const post = calls.find((c) => c.url.startsWith("https://slack.com/api/chat.postMessage"));
  assert.ok(post, "chat.postMessage was called");
  assert.equal(post!.body.channel, "C_MAPPED");
  assert.match(post!.body.text, /\*Connector Test B\* _\(via CoLab\)_\nreply \*from\* CoLab/);
  assert.match(String(post!.headers.authorization), /^Bearer xoxb-test-token-9999$/);
  const mm = await db.connectors.findByMessage(mappingId, msg.id);
  assert.ok(mm && mm.direction === "out" && mm.externalMessageId === done.result.externalMessageId);
});

dbTest("echo guard: Slack's own event for our post is dropped", async () => {
  const mm = await db.connectors.findByMessage(mappingId, outboundMsgId);
  const r = await ingest.handleInbound("slack", slackAccountId, slackReq(slackMessage("Ev5", mm.externalMessageId, "reply from CoLab (echo)", { user: "U_SOMEONE" }), SIGNING));
  assert.equal(r.summary.accepted, 0, JSON.stringify(r.summary));
});

dbTest("outbound edit re-enqueues once per text change and calls chat.update", async () => {
  calls.length = 0;
  await messageService.edit({ messageId: outboundMsgId, userId: B, text: "reply from CoLab (edited)" });
  const job = await waitFor(async () => (await db.connectors.listJobs({ mappingId })).find((j: any) => j.kind === "outbound.message.updated"));
  await connectors.drain();
  await waitFor(async () => ((await db.connectors.getJob(job.id)).status === "done" ? true : null));
  assert.ok(calls.some((c) => c.url.startsWith("https://slack.com/api/chat.update")));
  // Same edit again → same dedupe key → no second job.
  const n1 = (await db.connectors.listJobs({ mappingId })).filter((j: any) => j.kind === "outbound.message.updated").length;
  const id = await db.connectors.enqueueJob({ accountId: slackAccountId, mappingId, kind: "outbound.message.updated", dedupeKey: job.dedupeKey, payload: {} });
  assert.equal(id, null, "duplicate dedupe key is refused");
  const n2 = (await db.connectors.listJobs({ mappingId })).filter((j: any) => j.kind === "outbound.message.updated").length;
  assert.equal(n1, n2);
});

// ── Queue mechanics ─────────────────────────────────────────────────────────
dbTest("queue: unknown job kind fails permanently; retry re-arms it", async () => {
  const id = await db.connectors.enqueueJob({ accountId: slackAccountId, mappingId: null, kind: "bogus.kind", dedupeKey: `bogus:${Date.now()}`, payload: {} });
  await connectors.drain();
  const failed = await waitFor(async () => {
    const j = await db.connectors.getJob(id);
    return j.status === "failed" ? j : null;
  });
  assert.match(failed.error, /unknown job kind/);
  const r = await connectors.retryJob(id, null);
  assert.equal(r.requeued, true);
  const again = await db.connectors.getJob(id);
  assert.equal(again.status === "pending" || again.status === "running" || again.status === "failed", true);
});

dbTest("queue: a claimed job is not handed out twice", async () => {
  const id = await db.connectors.enqueueJob({ accountId: slackAccountId, mappingId: null, kind: "calendar.pull", dedupeKey: `claim:${Date.now()}`, payload: {}, delaySec: 0 });
  // Disable the account so the worker cannot race us, then claim by hand.
  await db.connectors.updateAccount(slackAccountId, { enabled: false });
  try {
    const first = await db.connectors.claimJobs(50);
    const mine = first.find((j: any) => j.id === id);
    assert.ok(mine, "claimed");
    assert.equal(mine.account.live, false);
    const second = await db.connectors.claimJobs(50);
    assert.ok(!second.some((j: any) => j.id === id), "already running");
    await db.connectors.markJobFailed(id, "test", null);
  } finally {
    await db.connectors.updateAccount(slackAccountId, { enabled: true });
  }
});

// ── Calendar ────────────────────────────────────────────────────────────────
dbTest("calendar: creating a meeting mirrors it to a Google Calendar account", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = { client_email: "svc@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), token_uri: "https://oauth2.googleapis.com/token" };
  const cal = await connectors.createAccount({
    platform: "google_calendar",
    name: "Acme Google Calendar",
    credentials: { serviceAccountJson: JSON.stringify(sa), impersonate: "host@acme.test" },
    settings: { autoSyncMeetings: true, pullEnabled: false },
    createdBy: A,
    organizationId: null,
  });
  assert.equal(cal.credentialHint, "svc@proj.iam.gserviceaccount.com");
  calls.length = 0;
  const startsAt = new Date(Date.now() + 3600_000).toISOString();
  const mt = await meetingService.create({ title: "Connector sync", startsAt, durationMin: 45, attendees: [B], creatorId: A, description: "agenda" });
  const job = await waitFor(async () => (await db.connectors.listJobs({ accountId: cal.id })).find((j: any) => j.kind === "calendar.upsert"));
  await connectors.drain();
  const done = await waitFor(async () => {
    const j = await db.connectors.getJob(job.id);
    return j.status === "done" ? j : j.status === "failed" ? j : null;
  });
  assert.equal(done.status, "done", done.error);
  const create = calls.find((c) => c.url.includes("/calendar/v3/calendars/primary/events") && c.method === "POST");
  assert.ok(create, "events.insert called");
  assert.equal(create!.body.summary, "Connector sync");
  assert.equal(create!.body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.ok(create!.body.attendees.some((a: any) => a.email === B + "@ex.com"));
  assert.ok(create!.url.includes("conferenceDataVersion=1"));
  const mm = await db.connectors.getMeetingMapping(cal.id, mt.meetingId || mt.id);
  assert.equal(mm.externalEventId, "gcal-ev-1");
  assert.equal(mm.joinUrl, "https://meet.google.com/abc-defg-hij");
  assert.equal(mm.lastStatus, "synced");
  const viaApi = await connectors.listMeetingMappings(mt.meetingId || mt.id, B);
  assert.equal(viaApi[0].platform, "google_calendar");

  // A reschedule PATCHes the SAME external event (no duplicate).
  calls.length = 0;
  await meetingService.update({ meetingId: mt.meetingId || mt.id, userId: A, patch: { startsAt: new Date(Date.now() + 7200_000).toISOString(), durationMin: 30 } });
  const job2 = await waitFor(async () => (await db.connectors.listJobs({ accountId: cal.id })).find((j: any) => j.kind === "calendar.upsert" && j.id !== job.id));
  await connectors.drain();
  await waitFor(async () => ((await db.connectors.getJob(job2.id)).status === "done" ? true : null));
  assert.ok(calls.some((c) => c.method === "PATCH" && c.url.includes("/events/gcal-ev-1")), "events.patch on the existing id");
});
