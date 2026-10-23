import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// MOBILE PUSH (Collab_mobile FCM / APNs) tests.
//
// Part 1 — PURE: the per-platform message builders and the ids shared with
// the Flutter app. These never touch the network or the DB; they pin the
// wire contract the phone parses (push_payload.dart / AppDelegate.swift) so a
// refactor on either side fails here, not on a device.
//
// Part 2 — DB: the push_devices / push_click_events repos, driven through the
// real driver against the throwaway test schema (skipped when MySQL is down,
// like the other backend suites).

let mobilePush: any;
let pushRoute: any;
let db: any;
let dbUp = false;

const U1 = "u_mpush_a";
const U2 = "u_mpush_b";

before(async () => {
  // Pin onto the throwaway test schema when MySQL is reachable; when it isn't
  // (no local MySQL, different root password) the pure cases below must still
  // run — only the repo cases are DB-bound and they skip themselves.
  try {
    await useTestDatabase();
  } catch (e: any) {
    console.warn("[mobile-push.test] test DB unavailable — DB cases skipped:", e?.message);
  }
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  mobilePush = await import("../src/services/mobilePushService");
  pushRoute = await import("../src/routes/push");
  try {
    if (!process.env.DATABASE_URL) throw new Error("no test database");
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    await migrate(platform.config.database.url);
    for (const [id, name] of [[U1, "MPush A"], [U2, "MPush B"]] as const) {
      await db.users.upsert({ id, email: id + "@ex.com", name, initials: "MP", color: "#2563EB", presence: "off", passwordHash: null });
    }
    dbUp = true;
  } catch (e: any) {
    console.warn("[mobile-push.test] MySQL unreachable — DB cases skipped:", e?.message);
  }
});

describe("ids shared with the Flutter app", () => {
  test("stableId is the app's FNV-1a (pinned vectors, also in test/push_payload_test.dart)", () => {
    assert.equal(mobilePush.stableId("conv:abc"), 1454630857);
    assert.equal(mobilePush.stableId("colab-msg-1"), 1987154032);
    assert.equal(mobilePush.stableId("colab-call-test-call-123"), 1940074718);
    assert.equal(mobilePush.stableId("colab-huddle-c1"), 1619455312);
  });

  test("messages collapse per conversation, everything else per tag", () => {
    assert.equal(
      mobilePush.notificationIdFor({ title: "A", type: "message", tag: "colab-msg-1", conversationId: "abc" }),
      mobilePush.stableId("conv:abc"),
    );
    assert.equal(
      mobilePush.notificationIdFor({ title: "A", type: "mention", tag: "colab-mention-9", conversationId: "abc" }),
      mobilePush.stableId("conv:abc"),
    );
    assert.equal(
      mobilePush.notificationIdFor({ title: "A", type: "call_incoming", tag: "colab-call-test-call-123" }),
      mobilePush.stableId("colab-call-test-call-123"),
    );
  });
});

describe("buildFcmMessage", () => {
  const payload = {
    title: "Alice", body: "hello", tag: "colab-msg-m1", type: "message",
    conversationId: "c1", targetType: "message", targetId: "m1",
    messageId: "m1", senderId: "u1", senderName: "Alice", conversationKind: "dm",
  };

  test("android: data-only, high priority, every value a string, no notification block", () => {
    const m = mobilePush.buildFcmMessage({ id: "d", userId: "u", platform: "android", token: "tok-a" }, payload, 1_000);
    assert.equal(m.token, "tok-a");
    assert.equal(m.android.priority, "high");
    assert.ok(/^\d+s$/.test(m.android.ttl));
    assert.equal(m.notification, undefined);
    assert.equal(m.apns, undefined);
    for (const v of Object.values(m.data)) assert.equal(typeof v, "string");
    assert.equal(m.data.type, "message");
    assert.equal(m.data.conversationId, "c1");
    assert.equal(m.data.senderName, "Alice");
  });

  test("ios: APNs alert with thread/category/collapse id + flutter_local_notifications shape", () => {
    const m = mobilePush.buildFcmMessage({ id: "d", userId: "u", platform: "ios", token: "tok-i" }, payload, 1_000);
    const h = m.apns.headers;
    const aps = m.apns.payload.aps;
    assert.equal(h["apns-push-type"], "alert");
    assert.equal(h["apns-priority"], "10");
    assert.equal(h["apns-collapse-id"], String(mobilePush.stableId("conv:c1")));
    assert.equal(Number(h["apns-expiration"]) > 1_000, true);
    assert.deepEqual(aps.alert, { title: "Alice", body: "hello" });
    assert.equal(aps["thread-id"], "conv-c1");
    assert.equal(aps.category, "COLLAB_MESSAGE");
    assert.equal(aps["mutable-content"], 1);
    // flutter_local_notifications recognises the request as its own and hands
    // Dart the JSON payload on tap/action; present* false = not drawn while the
    // app is in the foreground (the socket path owns that).
    const p = m.apns.payload;
    assert.equal(p.NotificationId, mobilePush.stableId("conv:c1"));
    assert.equal(p.presentAlert, false);
    assert.equal(p.presentBanner, false);
    assert.equal(JSON.parse(p.payload).conversationId, "c1");
    // The plain data map rides along too (firebase_messaging path).
    assert.equal(m.data.tag, "colab-msg-m1");
  });

  test("ios call_cancel is a silent background push (nothing to alert)", () => {
    const m = mobilePush.buildFcmMessage(
      { id: "d", userId: "u", platform: "ios", token: "t" },
      { title: "Call ended", type: "call_cancel", tag: "colab-call-x", targetId: "x" },
      1_000,
    );
    assert.equal(m.apns.headers["apns-push-type"], "background");
    assert.deepEqual(m.apns.payload.aps, { "content-available": 1 });
  });

  test("calls get a short ttl and a collapse key so a re-ring replaces the last", () => {
    const m = mobilePush.buildFcmMessage(
      { id: "d", userId: "u", platform: "android", token: "t" },
      { title: "Bob is calling", type: "call_incoming", tag: "colab-call-x", targetId: "x", callKind: "video" },
      1_000,
    );
    assert.equal(m.android.collapse_key, "colab-call-x");
    assert.equal(Number(m.android.ttl.replace("s", "")) <= 120, true);
    assert.equal(m.data.callKind, "video");
  });

  test("meeting_started is time-sensitive on iOS", () => {
    const m = mobilePush.buildFcmMessage(
      { id: "d", userId: "u", platform: "ios", token: "t" },
      { title: "Standup started", type: "meeting_started", tag: "colab-meeting_started-1", targetId: "1" },
    );
    assert.equal(m.apns.payload.aps["interruption-level"], "time-sensitive");
    assert.equal(m.apns.payload.aps.category, "COLLAB_MEETING");
  });
});

describe("buildVoipPayload (AppDelegate.swift contract)", () => {
  test("ring", () => {
    const v = mobilePush.buildVoipPayload({
      title: "Bob is calling", type: "call_incoming", tag: "colab-call-c9", targetId: "c9",
      conversationId: "conv1", callKind: "video", senderName: "Bob", senderAvatar: "https://x/a.png",
    });
    assert.deepEqual(v, {
      action: "ring", callId: "c9", callerName: "Bob", callerAvatar: "https://x/a.png",
      conversationId: "conv1", kind: "video", huddle: false,
    });
  });
  test("cancel keeps the same callId and carries the reason", () => {
    const v = mobilePush.buildVoipPayload({ title: "Call ended", type: "call_cancel", tag: "colab-call-c9", targetId: "c9", reason: "missed" });
    assert.equal(v.action, "cancel");
    assert.equal(v.callId, "c9");
    assert.equal(v.reason, "missed");
  });
  test("huddle ring derives from the tag and strips ' is calling' when no senderName", () => {
    const v = mobilePush.buildVoipPayload({ title: "Zoe is calling", type: "call_incoming", tag: "colab-huddle-conv7", conversationId: "conv7" });
    assert.equal(v.huddle, true);
    assert.equal(v.callerName, "Zoe");
    assert.equal(v.callId, "conv7");
    assert.equal(v.kind, "audio");
  });
});

// ── Faster connect (Collab calls: backend changes for faster connect, 22 Oct 2026) ──
describe("callee room token rides in the call push", () => {
  const ring = {
    title: "Bob is calling", type: "call_incoming", tag: "colab-call-c9", targetId: "c9",
    callKind: "audio", senderId: "u_bob", senderName: "Bob",
    livekitToken: "eyJ.lk.token", wsUrl: "wss://collab.example/livekit",
  };
  test("VoIP payload carries livekitToken + wsUrl (AppDelegate.swift reads them)", () => {
    const v = mobilePush.buildVoipPayload(ring);
    assert.equal(v.livekitToken, "eyJ.lk.token");
    assert.equal(v.wsUrl, "wss://collab.example/livekit");
    assert.equal(v.action, "ring");
  });
  test("FCM data map carries livekitToken + wsUrl (PushPayload.fromFcmData reads them)", () => {
    const m = mobilePush.buildFcmMessage({ id: "d", userId: "u", platform: "android", token: "tok-a" }, ring, 1_000);
    assert.equal(m.data.livekitToken, "eyJ.lk.token");
    assert.equal(m.data.wsUrl, "wss://collab.example/livekit");
  });
  test("a cancel never carries a token", () => {
    const v = mobilePush.buildVoipPayload({ title: "Call ended", type: "call_cancel", tag: "colab-call-c9", targetId: "c9", reason: "answered" });
    assert.equal(v.livekitToken, undefined);
  });
  test("over budget, the token is shed before the ids the app routes on", () => {
    const huge = { ...ring, livekitToken: "x".repeat(5000) };
    const m = mobilePush.buildFcmMessage({ id: "d", userId: "u", platform: "android", token: "tok-a" }, huge, 1_000);
    assert.equal(m.data.livekitToken, undefined, "token dropped");
    assert.equal(m.data.targetId, "c9", "call id kept");
    assert.equal(m.data.senderId, "u_bob", "caller id kept");
    assert.ok(mobilePush.messageBytes(m) <= mobilePush.MESSAGE_LIMIT_BYTES);
  });
});

// ── Rev. 2 handoff change requests (MOBILE_PUSH_BACKEND_HANDOFF, 22 Sep 2026) ──
describe("K1 · callerId in the VoIP payload", () => {
  test("senderId is forwarded as callerId; absent when the call site has none", () => {
    const withId = mobilePush.buildVoipPayload({ title: "Alice is calling", type: "call_incoming", tag: "colab-call-k1", targetId: "k1", senderId: "u2", senderName: "Alice" });
    assert.equal(withId.callerId, "u2");
    const without = mobilePush.buildVoipPayload({ title: "Alice is calling", type: "call_incoming", tag: "colab-call-k1", targetId: "k1" });
    assert.equal("callerId" in without, false);
  });
});

describe("K3 · huddle ring retraction payload", () => {
  test("a huddle call_cancel maps to a VoIP cancel on the huddle tag", () => {
    const v = mobilePush.buildVoipPayload({ title: "Call ended", type: "call_cancel", tag: "colab-huddle-c9", conversationId: "c9", huddle: true, reason: "ended" });
    assert.equal(v.action, "cancel");
    assert.equal(v.huddle, true);
    assert.equal(v.callId, "c9");
    assert.equal(v.reason, "ended");
  });
});

describe("K5 · iOS badge", () => {
  const ios = { id: "d", userId: "u1", platform: "ios", token: "t" };
  test("message alerts carry aps.badge when a count is supplied", () => {
    const m = mobilePush.buildFcmMessage(ios, { title: "A", body: "b", type: "message", tag: "colab-msg-1", conversationId: "c1" }, 1000, { badge: 3 });
    assert.equal(m.apns.payload.aps.badge, 3);
  });
  test("no count → no badge key; call/meeting pushes never carry one", () => {
    const m = mobilePush.buildFcmMessage(ios, { title: "A", type: "message", tag: "colab-msg-1", conversationId: "c1" });
    assert.equal("badge" in m.apns.payload.aps, false);
    const c = mobilePush.buildFcmMessage(ios, { title: "A", type: "meeting_started", tag: "colab-meeting_started-1" }, 1000, { badge: 3 });
    assert.equal("badge" in c.apns.payload.aps, false);
  });
});

describe("K7 · E2EE ciphertext in message pushes", () => {
  const android = { id: "d", userId: "u1", platform: "android", token: "t" };
  test("encrypted + ciphertext ride the data map as strings", () => {
    const m = mobilePush.buildFcmMessage(android, { title: "A", body: "Sent a message", type: "message", tag: "colab-msg-2", conversationId: "c1", encrypted: true, ciphertext: '[{"recipientId":"u1","ct":"x"}]' });
    assert.equal(m.data.encrypted, "true");
    assert.equal(m.data.ciphertext, '[{"recipientId":"u1","ct":"x"}]');
  });
  test("the ciphertext is dropped (only it) when the data map would exceed the FCM limit", () => {
    const big = "x".repeat(mobilePush.DATA_MAP_LIMIT_BYTES);
    const p = { title: "A", body: "Sent a message", type: "message", tag: "colab-msg-3", conversationId: "c1", encrypted: true, ciphertext: big, senderName: "Alice" };
    const m = mobilePush.buildFcmMessage(android, p);
    assert.equal("ciphertext" in m.data, false);
    assert.equal(m.data.encrypted, "true");
    assert.equal(m.data.senderName, "Alice");
    assert.ok(mobilePush.dataMapBytes(m.data) <= mobilePush.DATA_MAP_LIMIT_BYTES);
    // iOS mirrors the trimmed map in its `payload` JSON.
    const i = mobilePush.buildFcmMessage({ ...android, platform: "ios" }, p);
    assert.equal("ciphertext" in JSON.parse(i.apns.payload.payload), false);
    assert.equal("ciphertext" in i.data, false);
  });
  test("e2eePushFields keeps only the recipient's DM envelopes; group envelope passes whole", async () => {
    const sock = await import("../src/realtime/socket");
    const dm = [
      { recipientId: "u1", recipientDeviceId: "d1", ct: "a" },
      { recipientId: "u2", recipientDeviceId: "d2", ct: "b" },
      { recipientId: "u1", recipientDeviceId: "d3", ct: "c" },
    ];
    const f = sock.e2eePushFields(dm, "u1");
    assert.equal(f.encrypted, true);
    assert.deepEqual(JSON.parse(f.ciphertext!).map((e: any) => e.ct), ["a", "c"]);
    // Nothing for this recipient → plain payload (the app shows the generic body).
    assert.deepEqual(sock.e2eePushFields(dm, "u9"), {});
    // Group: one shared envelope object, forwarded as-is (recipient filter n/a).
    const g = sock.e2eePushFields({ v: 2, ct: "g" }, null);
    assert.equal(JSON.parse(g.ciphertext!).ct, "g");
    // A JSON-string column value is accepted too; junk is ignored.
    assert.equal(JSON.parse(sock.e2eePushFields(JSON.stringify(dm), "u2").ciphertext!).length, 1);
    assert.deepEqual(sock.e2eePushFields("{not json", "u1"), {});
  });
});

describe("K8 · attachment preview hints", () => {
  test("mirrors the app's socket-path previews; E2EE stays generic", async () => {
    const sock = await import("../src/realtime/socket");
    assert.equal(sock.pushPreview({ text: "<b>hi</b> there" }), "hi there");
    assert.equal(sock.pushPreview({ file: { name: "plan.pdf" } }), "📎 plan.pdf");
    assert.equal(sock.pushPreview({ file: { name: "plan.pdf" }, text: "see attached" }), "see attached");
    assert.equal(sock.pushPreview({ voice: { durationSec: 3 } }), "🎤 Voice message");
    assert.equal(sock.pushPreview({ type: "meeting_invite" }), "📅 Meeting");
    assert.equal(sock.pushPreview({ encrypted: [{ ct: "x" }], file: { name: "secret.pdf" } }), "Sent a message");
    assert.equal(sock.pushPreview({}), "Sent a message");
  });
  test("E2EE: the sender's plaintext pushPreview becomes the body (sanitised, clipped); junk → generic", async () => {
    const sock = await import("../src/realtime/socket");
    const enc = [{ recipientId: "u1", ct: "x" }];
    assert.equal(sock.pushPreview({ encrypted: enc, pushPreview: "  <b>See you</b>\n at 3  " }), "See you at 3");
    assert.equal(sock.pushPreview({ encrypted: enc, pushPreview: "x".repeat(500) }).length, 140);
    assert.equal(sock.pushPreview({ encrypted: enc, pushPreview: "" }), "Sent a message");
    assert.equal(sock.pushPreview({ encrypted: enc, pushPreview: { evil: 1 } }), "Sent a message");
    // The preview is never used for a PLAIN message (its real text wins).
    assert.equal(sock.pushPreview({ text: "real", pushPreview: "other" }), "real");
    assert.equal(sock.sanitizePushPreview(42), null);
  });
});

describe("click event normalisation (POST /api/push/events)", () => {
  test("accepts a well-formed event and clips/validates fields", () => {
    const ev = pushRoute.normalizeClickEvent({
      eventId: "e1", kind: "click", platform: "IOS", source: "FCM", appState: "terminated",
      action: "tap", notificationType: "message", tag: "colab-msg-1", conversationId: "c1",
      targetType: "message", targetId: "m1", clickedAt: "2026-09-16T10:00:00.000Z",
    });
    assert.equal(ev.platform, "ios");
    assert.equal(ev.source, "fcm");
    assert.equal(ev.appState, "terminated");
    assert.equal(ev.notificationType, "message");
    assert.equal(ev.clickedAt, "2026-09-16 10:00:00.000");
  });
  test("rejects events without an id or with the wrong kind; drops junk enums", () => {
    assert.equal(pushRoute.normalizeClickEvent({ kind: "click" }), null);
    assert.equal(pushRoute.normalizeClickEvent({ eventId: "x", kind: "shown" }), null);
    const ev = pushRoute.normalizeClickEvent({ eventId: "x", source: "smoke", appState: "asleep", notificationType: "<script>" , clickedAt: "nope" });
    assert.equal(ev.source, null);
    assert.equal(ev.appState, null);
    assert.equal(ev.notificationType, null);
    assert.equal(ev.clickedAt, null);
  });
});

describe("push_devices / push_click_events repos", () => {
  test("upsert re-homes a token, keeps the VoIP token unless explicitly cleared, and soft-deletes", async (t) => {
    if (!dbUp) return t.skip("MySQL unreachable");
    const tok = "fcm-" + Date.now();
    const id1 = await db.pushDevices.upsert(U1, { platform: "ios", token: tok, voipToken: "voip1", deviceId: "dev1", appVersion: "1.0.2" }, "Collab/1.0.2 iOS");
    // Same token registered again WITHOUT voipToken → must keep voip1.
    const id2 = await db.pushDevices.upsert(U1, { platform: "ios", token: tok, deviceId: "dev1", appVersion: "1.0.3" });
    assert.equal(id1, id2);
    let rows = await db.pushDevices.listForUser(U1);
    const row = rows.find((r: any) => r.token === tok);
    assert.equal(row.voipToken, "voip1");
    assert.equal(row.appVersion, "1.0.3");
    // Another account signs in on the same phone → the token moves.
    await db.pushDevices.upsert(U2, { platform: "ios", token: tok, voipToken: null });
    assert.equal((await db.pushDevices.listForUser(U1)).some((r: any) => r.token === tok), false);
    rows = await db.pushDevices.listForUsers([U2]);
    assert.equal(rows.some((r: any) => r.token === tok && r.voipToken === null), true);
    await db.pushDevices.removeByToken(tok);
    assert.equal((await db.pushDevices.listForUsers([U1, U2])).some((r: any) => r.token === tok), false);
    // Re-registering a soft-deleted token revives the row.
    await db.pushDevices.upsert(U2, { platform: "android", token: tok });
    assert.equal((await db.pushDevices.listForUser(U2)).some((r: any) => r.token === tok && r.platform === "android"), true);
    await db.pushDevices.removeForUser(U2);
  });

  test("K4: a device row is bound to its session and retired with it; stale rows are swept", async (t) => {
    if (!dbUp) return t.skip("MySQL unreachable");
    const tok = "fcm-sess-" + Date.now();
    const jti = "jti-" + Date.now();
    await db.pushDevices.upsert(U2, { platform: "android", token: tok, sessionJti: jti });
    let row = (await db.pushDevices.listForUser(U2)).find((r: any) => r.token === tok);
    assert.equal(row.sessionJti, jti);
    // Re-register from a jti-less (legacy) token keeps the binding.
    await db.pushDevices.upsert(U2, { platform: "android", token: tok });
    row = (await db.pushDevices.listForUser(U2)).find((r: any) => r.token === tok);
    assert.equal(row.sessionJti, jti);
    assert.equal(await db.pushDevices.removeBySession("no-such-jti"), 0);
    assert.equal(await db.pushDevices.removeBySession(jti), 1);
    assert.equal((await db.pushDevices.listForUser(U2)).some((r: any) => r.token === tok), false);
    // Sweep: a row seen just now survives a 60-day sweep.
    const tok2 = "fcm-fresh-" + Date.now();
    await db.pushDevices.upsert(U2, { platform: "android", token: tok2 });
    await db.pushDevices.sweepStale(60);
    assert.equal((await db.pushDevices.listForUser(U2)).some((r: any) => r.token === tok2), true);
    await db.pushDevices.removeByToken(tok2);
  });

  test("K5: unreadConversationCount counts unread, unmuted conversations", async (t) => {
    if (!dbUp) return t.skip("MySQL unreachable");
    assert.equal(typeof (await db.conversations.unreadConversationCount(U1)), "number");
  });

  test("click events are idempotent on event_id", async (t) => {
    if (!dbUp) return t.skip("MySQL unreachable");
    const ev = pushRoute.normalizeClickEvent({ eventId: "evt-" + Date.now(), kind: "click", platform: "android", source: "local", appState: "background", action: "tap", notificationType: "message", tag: "colab-msg-z", conversationId: "cz", clickedAt: new Date().toISOString() });
    assert.equal(await db.pushClickEvents.record(U1, ev), true);
    assert.equal(await db.pushClickEvents.record(U1, ev), false);
    const list = await db.pushClickEvents.listForUser(U1, 10);
    assert.equal(list.filter((e: any) => e.eventId === ev.eventId).length, 1);
    assert.equal(list[0].notificationType, "message");
  });
});

// The production incident this pins: a host with the (tracked) APNs .p8 but
// without the (gitignored) FCM service-account file boots with VoIP ready and
// FCM not — iOS calls ring, every message/mention/meeting push is dropped.
// That state must be visible: status() names the failing path, channels()
// shows the calls-only split, and neither leg claims readiness it lacks.
describe("push channel readiness (calls-only host)", () => {
  test("no FCM env at all → not configured, error says so", async () => {
    const fcm = await import("../src/services/fcmService");
    const platform = await import("../src/platform");
    const saved = { ...platform.config.fcm };
    try {
      platform.config.fcm.serviceAccountJson = "";
      platform.config.fcm.serviceAccountFile = "";
      assert.equal(fcm.init(), false);
      const st = fcm.status();
      assert.equal(st.ready, false);
      assert.equal(st.configured, false);
      assert.match(String(st.error), /FCM_SERVICE_ACCOUNT_JSON\/FILE not set/);
      assert.equal(mobilePush.channels().fcm, false);
    } finally {
      Object.assign(platform.config.fcm, saved);
      fcm.init();
    }
  });

  test("FILE configured but missing on this host → configured:true, error names the path", async () => {
    const fcm = await import("../src/services/fcmService");
    const platform = await import("../src/platform");
    const saved = { ...platform.config.fcm };
    const missing = "/app/keys/fcm-service-account.json.does-not-exist";
    try {
      platform.config.fcm.serviceAccountJson = "";
      platform.config.fcm.serviceAccountFile = missing;
      assert.equal(fcm.init(), false);
      const st = fcm.status();
      assert.equal(st.ready, false);
      assert.equal(st.configured, true, "a set path counts as configured even when unreadable");
      assert.ok(String(st.error).includes(missing), `error should name the path: ${st.error}`);
      assert.match(String(st.error), /ENOENT/);
      assert.equal(mobilePush.channels().fcm, false);
    } finally {
      Object.assign(platform.config.fcm, saved);
      fcm.init();
    }
  });

  test("inline JSON that parses but lacks a key → configured:true, specific error", async () => {
    const fcm = await import("../src/services/fcmService");
    const platform = await import("../src/platform");
    const saved = { ...platform.config.fcm };
    try {
      platform.config.fcm.serviceAccountFile = "";
      platform.config.fcm.serviceAccountJson = JSON.stringify({ project_id: "collab-7531d", client_email: "x@y" });
      assert.equal(fcm.init(), false);
      const st = fcm.status();
      assert.equal(st.configured, true);
      assert.match(String(st.error), /client_email\/private_key/);
    } finally {
      Object.assign(platform.config.fcm, saved);
      fcm.init();
    }
  });
});

// FCM rejects the WHOLE message above 4096 bytes. For iOS the ciphertext was
// counted twice (data map + apns.payload.payload copy), so an envelope that
// fit the 3.5 KB data budget still produced a 400 — and no notification at
// all, while calls (no ciphertext) kept arriving. The guard must act on the
// assembled message, dropping only the ciphertext, on both platforms.
describe("whole-message FCM size guard", () => {
  const android = { id: "d", userId: "u", platform: "android", token: "t".repeat(163) };
  const ios = { ...android, platform: "ios" };
  // Under the data-map budget on its own, over the FCM limit once duplicated.
  const envelope = JSON.stringify([{ recipientId: "u", recipientDeviceId: "dev1", ek: "k".repeat(120), iv: "i".repeat(24), ct: "c".repeat(1500) }]);
  const p = {
    title: "Alice", body: "Sent a message", type: "message", tag: "colab-msg-9", conversationId: "c1",
    encrypted: true, ciphertext: envelope, messageId: "m9", senderId: "u2", senderName: "Alice",
    conversationKind: "dm", senderInitials: "AL", senderColor: "#2563EB",
  };

  test("the fixture really is under the data budget (so only the iOS copy pushes it over)", () => {
    assert.ok(mobilePush.dataMapBytes(mobilePush.toDataMap(p)) < mobilePush.DATA_MAP_LIMIT_BYTES);
  });

  test("android keeps the ciphertext when the whole message fits", () => {
    const m = mobilePush.buildFcmMessage(android, p, 1000);
    assert.equal(m.data.ciphertext, envelope);
    assert.ok(mobilePush.messageBytes(m) <= mobilePush.MESSAGE_LIMIT_BYTES);
  });

  test("ios drops ONLY the ciphertext when the duplicated payload would exceed the FCM limit", () => {
    const m = mobilePush.buildFcmMessage(ios, p, 1000, { badge: 2 });
    assert.ok(mobilePush.messageBytes(m) <= mobilePush.MESSAGE_LIMIT_BYTES, `message is ${mobilePush.messageBytes(m)} bytes`);
    assert.equal("ciphertext" in m.data, false);
    assert.equal("ciphertext" in JSON.parse(m.apns.payload.payload), false);
    // Everything else survives: the app still renders a real conversation alert.
    assert.equal(m.data.encrypted, "true");
    assert.equal(m.data.senderName, "Alice");
    assert.equal(m.apns.payload.aps.alert.title, "Alice");
    assert.equal(m.apns.payload.aps.badge, 2);
    assert.equal(m.apns.headers["apns-collapse-id"], String(mobilePush.stableId("conv:c1")));
  });

  test("ios keeps a small ciphertext", () => {
    const small = { ...p, ciphertext: '[{"recipientId":"u","ct":"abc"}]' };
    const m = mobilePush.buildFcmMessage(ios, small, 1000);
    assert.equal(m.data.ciphertext, small.ciphertext);
    assert.equal(JSON.parse(m.apns.payload.payload).ciphertext, small.ciphertext);
  });
});

// Production, 7 Oct 2026 (Admin → Server Logs, PUSH_FCM_SEND_FAILED): FCM
// rejected plain Android message pushes with "Message is too large. The
// maximum is 4K (4096 bytes)" — no ciphertext involved. The sender's profile
// photo is stored as an inline base64 data: URL and rode along as
// `senderAvatar`. A push must never carry one; and whatever else is on the
// payload, the assembled message has to come out under the limit.
describe("payload hygiene: inline avatars and the hard size cap", () => {
  const android = { id: "d", userId: "u", platform: "android", token: "t".repeat(163) };
  const ios = { ...android, platform: "ios" };
  const dataUrlAvatar = "data:image/png;base64," + "A".repeat(20_000);
  const p = {
    title: "Vijay M", body: "hello there", type: "message", tag: "colab-msg-7", conversationId: "c1",
    messageId: "m7", senderId: "u2", senderName: "Vijay M", senderAvatar: dataUrlAvatar,
    senderInitials: "VM", senderColor: "#2563EB", conversationKind: "dm",
  };

  test("a data: URL avatar is dropped from the payload; a short http(s) avatar is kept", () => {
    const s = mobilePush.sanitizePushPayload(p);
    assert.equal("senderAvatar" in s, false);
    assert.equal(s.senderInitials, "VM", "the fallback disc fields stay");
    const ok = mobilePush.sanitizePushPayload({ ...p, senderAvatar: "https://collab.example/api/files/abc/download" });
    assert.equal(ok.senderAvatar, "https://collab.example/api/files/abc/download");
  });

  test("android: the message that FCM rejected now fits, with no ciphertext in play", () => {
    const m = mobilePush.buildFcmMessage(android, p, 1000);
    assert.ok(mobilePush.messageBytes(m) <= mobilePush.MESSAGE_LIMIT_BYTES, `message is ${mobilePush.messageBytes(m)} bytes`);
    assert.equal("senderAvatar" in m.data, false);
    assert.equal(m.data.title, "Vijay M");
    assert.equal(m.data.conversationId, "c1");
  });

  test("ios: same payload fits with the apns copy included", () => {
    const m = mobilePush.buildFcmMessage(ios, p, 1000, { badge: 1 });
    assert.ok(mobilePush.messageBytes(m) <= mobilePush.MESSAGE_LIMIT_BYTES, `message is ${mobilePush.messageBytes(m)} bytes`);
    assert.equal("senderAvatar" in JSON.parse(m.apns.payload.payload), false);
  });

  test("over-long titles and bodies are capped, routing ids untouched", () => {
    const long = { ...p, senderAvatar: undefined, title: "T".repeat(400), conversationTitle: "G".repeat(400), body: "b".repeat(2000) };
    const m = mobilePush.buildFcmMessage(android, long, 1000);
    assert.ok(mobilePush.messageBytes(m) <= mobilePush.MESSAGE_LIMIT_BYTES, `message is ${mobilePush.messageBytes(m)} bytes`);
    assert.ok(m.data.title.length <= 120);
    assert.ok(m.data.body.length <= 180);
    assert.equal(m.data.messageId, "m7");
  });

  test("every push is sheddable down to the limit, never thrown or sent oversize", () => {
    // A hostile combination: huge ciphertext + big cosmetic fields.
    const worst = { ...p, senderAvatar: "https://x/" + "y".repeat(500), ciphertext: "z".repeat(3400), conversationTitle: "C".repeat(119) };
    for (const dev of [android, ios]) {
      const m = mobilePush.buildFcmMessage(dev, worst, 1000);
      assert.ok(mobilePush.messageBytes(m) <= mobilePush.MESSAGE_LIMIT_BYTES, `${dev.platform} message is ${mobilePush.messageBytes(m)} bytes`);
      assert.ok(mobilePush.dataMapBytes(m.data) <= mobilePush.DATA_MAP_LIMIT_BYTES);
      assert.equal(m.data.conversationId, "c1", "routing ids survive shedding");
    }
  });
});
