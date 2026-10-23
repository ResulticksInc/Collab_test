import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import jwt from "jsonwebtoken";
import { io as ioc } from "socket.io-client";
import { useTestDatabase } from "./_setup";

// In-process integration test for the LiveKit-based calls module:
//   - room token issuance (a JWT the LiveKit SFU will accept, correct grants)
//   - membership gating: 1:1 tokens require call participation; group tokens
//     require conversation membership; ringing is gated too (the IDOR is closed)
//   - ringing signalling flow (request -> incoming -> accept)
//
// Boots against the existing MySQL database. DB-backed cases skip if MySQL is
// absent; the pure token-minting check always runs.

let server: any;
let base = "";
let roomToken: any;
let EVENTS: any;
let CONVERSATION: any;
let dbUp = false;
let dbRef: any;
const openSockets: any[] = [];
const LK_SECRET = "testsecret_at_least_32_characters_long_xx";

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = LK_SECRET;
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  process.env.CALL_MISSED_MS = "1500";
  // Short grace so the stale-socket tests below run in well under a second.
  process.env.CALL_DISCONNECT_GRACE_MS = "300";
  // Every subtest logs the same two seeded users in; the default 5-session cap
  // would make the 6th login mint no token (socket then says "unauthorized").
  process.env.AUTH_MAX_SESSIONS = process.env.AUTH_MAX_SESSIONS || "100";

  ({ EVENTS, CONVERSATION } = (await import("../../../shared/src")) as any);
  ({ roomToken } = await import("../src/services/livekitService"));

  try {
    const { migrate } = await import("../../../database/src");
    const { seedDemo } = await import("../../../database/seeds/demo.seed");
    const { seedIfNeeded, config, db } = await import("../src/platform");
    dbRef = db;
    await migrate(config.database.url);
    await seedIfNeeded();
    await seedDemo(db, { usersOnly: true });
    await ensureCallTestConversations();
    await resetCalls();
    const { createApp } = await import("../src/app");
    const { attachRealtime } = await import("../src/realtime/socket");
    const app = createApp();
    server = http.createServer(app);
    const io = attachRealtime(server);
    app.set("io", io);
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    base = `http://127.0.0.1:${server.address().port}`;
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — DB cases will skip:", e.message);
  }
});

after(async () => {
  closeOpenSockets();
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) =>
    setTimeout(r, (Number(process.env.CALL_MISSED_MS) || 1500) + 100),
  );
  if (dbRef?.pool?.end) await dbRef.pool.end();
});

const login = async (email) => {
  const r = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "demo1234" }),
  });
  const json = (await r.json()) as any;
  assert.equal(r.status, 200, json?.error?.message || "login failed");
  return json.data;
};
const nonMemberAuth = () => ({
  token: jwt.sign(
    { sub: `u_test_${Date.now()}_${Math.random().toString(36).slice(2)}` },
    process.env.AUTH_JWT_SECRET || "test-secret-colab",
  ),
});
const tokenReq = (tok, body) =>
  fetch(base + "/api/calls/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + tok,
    },
    body: JSON.stringify(body),
  });
const connect = (tok) =>
  new Promise<any>((res, rej) => {
    const s = ioc(base, { auth: { token: tok }, transports: ["websocket"] });
    s.on("connect", () => {
      openSockets.push(s);
      res(s);
    });
    s.on("connect_error", rej);
  });
const once = (s, ev, ms = 3000) =>
  new Promise<any>((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout " + ev)), ms);
    s.once(ev, (p) => {
      clearTimeout(t);
      res(p);
    });
  });
// Clear the test users' calls so a call left active by a prior subtest does
// not make the next request correctly return "busy".
const resetCalls = async () => {
  if (dbUp && dbRef)
    await dbRef.pool.query(
      "DELETE FROM calls WHERE initiator_id IN ('u_you','u_emily','u_marcus') OR peer_id IN ('u_you','u_emily','u_marcus')",
    );
};
const ensureCallTestConversations = async () => {
  if (!dbRef) return;
  const ensureConv = async ({
    id,
    kind,
    title = null,
    icon = null,
    members,
  }) => {
    await dbRef.conversations.create({
      id,
      kind,
      title,
      icon,
      createdBy: "u_you",
    });
    for (const uid of members) await dbRef.conversations.addMember(id, uid);
  };
  await ensureConv({
    id: "conv_emily",
    kind: CONVERSATION.DM,
    members: ["u_you", "u_emily"],
  });
  await ensureConv({
    id: "conv_general",
    kind: CONVERSATION.CHANNEL,
    title: "general",
    icon: "#",
    members: ["u_you", "u_emily", "u_marcus", "u_priya", "u_david", "u_lena"],
  });
};
const closeOpenSockets = () => {
  for (const s of openSockets.splice(0)) s.close();
};
const dbTest = (name, fn) =>
  test(name, async (t) => {
    if (!dbUp) {
      t.skip("MySQL not available");
      return;
    }
    await resetCalls();
    try {
      await fn(t);
    } finally {
      closeOpenSockets();
      await resetCalls();
    }
  });

test("roomToken mints a LiveKit-valid JWT with the right identity + room grant", async () => {
  const { token, wsUrl, room } = await roomToken({
    userId: "u_alice",
    name: "Alice",
    room: "call_demo",
  });
  assert.equal(room, "call_demo");
  assert.ok(wsUrl.startsWith("ws"), "ws url returned");
  const decoded: any = jwt.verify(token, LK_SECRET); // SFU verifies w/ same secret
  // Identity now carries a per-join UUID suffix so two tabs/devices for the
  // SAME user don't kick each other via DUPLICATE_IDENTITY. Host controls
  // strip the "__<uuid>" tail to resolve user -> live identity (see
  // livekitService.baseUserId / findLiveIdentity).
  assert.match(
    String(decoded.sub),
    /^u_alice(__[0-9a-f-]{8,})?$/i,
    "identity is u_alice or u_alice__<uuid>",
  );
  assert.ok(decoded.video, "carries a video grant");
  assert.equal(decoded.video.room, "call_demo");
  assert.equal(decoded.video.roomJoin, true);
  assert.equal(decoded.video.canPublish, true);
});

dbTest("token endpoint requires authentication", async () => {
  const r = await fetch(base + "/api/calls/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "conv_general" }),
  });
  assert.equal(r.status, 401);
});

dbTest("group token requires conversation membership", async () => {
  const you = await login("you@colab.app"); // member of conv_general (seeded)
  const okRes = await tokenReq(you.token, { conversationId: "conv_general" });
  assert.equal(okRes.status, 200);
  const data = ((await okRes.json()) as any).data;
  assert.equal(data.room, "conv_conv_general");
  const dec: any = jwt.verify(data.token, LK_SECRET);
  assert.equal(dec.video.room, "conv_conv_general");

  const outsider = nonMemberAuth(); // authenticated but not a member
  const denied = await tokenReq(outsider.token, {
    conversationId: "conv_general",
  });
  assert.equal(
    denied.status,
    403,
    "non-members cannot get a token (IDOR closed)",
  );
});

dbTest("1:1 token requires being a participant in the call", async () => {
  await resetCalls();
  const you = await login("you@colab.app");
  const emily = await login("emily@colab.app");
  const marcus = await login("marcus@colab.app"); // not in this call
  const cy = await connect(you.token);
  const ce = await connect(emily.token);

  const ringP = once(cy, EVENTS.CALL_RINGING);
  cy.emit(EVENTS.CALL_REQUEST, { peerId: "u_emily", kind: "video" });
  const callId = (await ringP).call.id;

  const mine = await tokenReq(you.token, { callId });
  assert.equal(mine.status, 200);
  assert.equal(((await mine.json()) as any).data.room, "call_" + callId);

  const theirs = await tokenReq(marcus.token, { callId });
  assert.equal(
    theirs.status,
    403,
    "a non-participant cannot get the call's token",
  );
  cy.emit(EVENTS.CALL_HANGUP, { callId });

  cy.close();
  ce.close();
});

dbTest(
  "ringing flow: request -> incoming -> accept, gated by membership",
  async () => {
    await resetCalls();
    // membership gate on initiation: a fresh user calling anyone is rejected
    const fresh = nonMemberAuth();
    const cf = await connect(fresh.token);
    const errP = once(cf, "call:error");
    cf.emit(EVENTS.CALL_REQUEST, { peerId: "u_emily", kind: "audio" });
    assert.equal(
      (await errP).code,
      403,
      "calling a non-connected user is forbidden",
    );
    cf.close();

    // happy path between a seeded connected pair
    const you = await login("you@colab.app");
    const emily = await login("emily@colab.app");
    const cy = await connect(you.token);
    const ce = await connect(emily.token);
    const incomingP = once(ce, EVENTS.CALL_INCOMING);
    const ringP = once(cy, EVENTS.CALL_RINGING);
    cy.emit(EVENTS.CALL_REQUEST, { peerId: "u_emily", kind: "audio" });
    const callId = (await ringP).call.id;
    assert.equal((await incomingP).call.id, callId, "recipient is rung");

    const acceptedP = once(cy, EVENTS.CALL_ACCEPTED);
    ce.emit(EVENTS.CALL_ACCEPT, { callId });
    assert.equal(
      (await acceptedP).call.id,
      callId,
      "caller sees the call accepted",
    );

    cy.close();
    ce.close();
  },
);

dbTest(
  "REST accept returns the callee's room token with the call (faster connect)",
  async () => {
    await resetCalls();
    const you = await login("you@colab.app");
    const emily = await login("emily@colab.app");
    const cy = await connect(you.token);
    const ringP = once(cy, EVENTS.CALL_RINGING);
    cy.emit(EVENTS.CALL_REQUEST, { peerId: "u_emily", kind: "audio" });
    const callId = (await ringP).call.id;

    const acceptedP = once(cy, EVENTS.CALL_ACCEPTED);
    const r = await fetch(base + `/api/calls/direct/${callId}/accept`, {
      method: "POST",
      headers: { Authorization: "Bearer " + emily.token },
    });
    assert.equal(r.status, 200);
    const data = ((await r.json()) as any).data;
    assert.equal(data.call.id, callId);
    assert.equal(data.call.status, "connected");
    assert.equal(data.room, "call_" + callId, "room name rides with the accept");
    assert.ok(data.wsUrl, "signalling url rides with the accept");
    const dec: any = jwt.verify(data.token, LK_SECRET);
    assert.equal(dec.video.room, "call_" + callId, "token is for this call's room");
    assert.match(String(dec.sub), /^u_emily(__[0-9a-f-]{8,})?$/i, "token is the callee's");
    assert.equal((await acceptedP).call.id, callId, "caller still sees call:accepted");

    // A second accept is refused (already connected) — the guarded write
    // reports why instead of silently re-accepting.
    const again = await fetch(base + `/api/calls/direct/${callId}/accept`, {
      method: "POST",
      headers: { Authorization: "Bearer " + emily.token },
    });
    assert.equal(again.status, 409);
    cy.emit(EVENTS.CALL_HANGUP, { callId });
    cy.close();
  },
);

dbTest(
  "a stale socket's disconnect does not end a call the user re-joined on a new socket",
  async () => {
    await resetCalls();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const you = await login("you@colab.app");
    const emily = await login("emily@colab.app");
    const cy = await connect(you.token);
    const ce1 = await connect(emily.token);
    const incomingP = once(ce1, EVENTS.CALL_INCOMING);
    cy.emit(EVENTS.CALL_REQUEST, { peerId: "u_emily", kind: "audio" });
    const callId = (await incomingP).call.id;
    const acceptedP = once(cy, EVENTS.CALL_ACCEPTED);
    ce1.emit(EVENTS.CALL_ACCEPT, { callId });
    await acceptedP;

    let ended = false;
    cy.on(EVENTS.CALL_ENDED, () => { ended = true; });
    // The "killed process" socket drops; the new process connects within the grace.
    ce1.close();
    const ce2 = await connect(emily.token);
    await wait(Number(process.env.CALL_DISCONNECT_GRACE_MS) + 400);
    assert.equal(ended, false, "call survives the stale socket's disconnect");

    // Now emily really goes away: no live socket after the grace → the call ends.
    const endedP = once(cy, EVENTS.CALL_ENDED, 2500);
    ce2.close();
    assert.equal((await endedP).call.id, callId, "a genuinely gone user still ends the call");
    cy.close();
  },
);

dbTest(
  "CALL_INCOMING reaches the correct peer in BOTH directions",
  async () => {
    await resetCalls();
    // The earlier happy-path proves only A->B. This asserts A->B AND B->A each
    // ring the correct peer — the directional bug fixed in the frontend.
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const you = await login("you@colab.app");
    const emily = await login("emily@colab.app");
    const cy = await connect(you.token);
    const ce = await connect(emily.token);

    // A (you) -> B (emily): emily rings, sees you as caller
    let inc = once(ce, EVENTS.CALL_INCOMING);
    cy.emit(EVENTS.CALL_REQUEST, { peerId: "u_emily", kind: "audio" });
    const ab = await inc;
    assert.equal(ab.caller.id, "u_you", "emily is rung with you as caller");
    cy.emit(EVENTS.CALL_HANGUP, { callId: ab.call.id });
    await wait(150);

    // B (emily) -> A (you): you rings, sees emily as caller (previously broken)
    inc = once(cy, EVENTS.CALL_INCOMING);
    ce.emit(EVENTS.CALL_REQUEST, { peerId: "u_you", kind: "audio" });
    const ba = await inc;
    assert.equal(ba.caller.id, "u_emily", "you is rung with emily as caller");
    ce.emit(EVENTS.CALL_HANGUP, { callId: ba.call.id });

    cy.close();
    ce.close();
  },
);

dbTest(
  "conversation:join is gated by membership (realtime IDOR closed)",
  async () => {
    // A non-member that emits conversation:join must NOT be subscribed to the
    // conversation's realtime room, so it never receives that conversation's
    // MESSAGE_NEW fan-out. Regression for the unguarded socket room join.
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const you = await login("you@colab.app"); // member of conv_emily (DM)
    const emily = await login("emily@colab.app"); // member of conv_emily
    const marcus = await login("marcus@colab.app"); // NOT a member of conv_emily

    const cYou = await connect(you.token);
    const cEmily = await connect(emily.token);
    const cMarcus = await connect(marcus.token);

    // Everyone asks to join the DM's realtime room. The members join; the
    // outsider's join must be silently refused by the membership gate.
    cYou.emit(EVENTS.CONVERSATION_JOIN, { conversationId: "conv_emily" });
    cEmily.emit(EVENTS.CONVERSATION_JOIN, { conversationId: "conv_emily" });
    cMarcus.emit(EVENTS.CONVERSATION_JOIN, { conversationId: "conv_emily" });
    // conversation:join is async (it runs a DB membership check) — let it settle.
    await wait(300);

    let outsiderGot = false;
    cMarcus.once(EVENTS.MESSAGE_NEW, () => {
      outsiderGot = true;
    });
    const memberGot = once(cEmily, EVENTS.MESSAGE_NEW, 3000);

    cYou.emit(EVENTS.MESSAGE_SEND, {
      conversationId: "conv_emily",
      text: "members-only realtime message",
    });

    // A real member receives the broadcast — proving the message DID fan out,
    // so the outsider's silence below is a genuine authz result, not a no-op.
    const msg = await memberGot;
    assert.ok(msg, "a member receives the conversation message");

    // Give any (erroneous) fan-out time to reach the outsider, then assert none.
    await wait(500);
    assert.equal(
      outsiderGot,
      false,
      "a non-member must NOT receive conversation messages after conversation:join",
    );

    cYou.close();
    cEmily.close();
    cMarcus.close();
  },
);

dbTest(
  "assigning a task notifies the assignee in real time",
  async () => {
    // #18 real-time: assigning a task to another user must deliver a live
    // notification to that user (no refresh). The assignee's socket is in its
    // user room from connect, so the pushed NOTIFICATION_NEW reaches it.
    const you = await login("you@colab.app");
    const marcus = await login("marcus@colab.app");
    const cMarcus = await connect(marcus.token);

    const notifP = once(cMarcus, EVENTS.NOTIFICATION_NEW, 4000);
    const r = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + you.token,
      },
      body: JSON.stringify({
        title: "Ship the realtime audit",
        assigneeId: "u_marcus",
      }),
    });
    assert.equal(r.status, 200, "task created");

    const n = await notifP;
    assert.ok(
      String(n.title || "").includes("assigned you a task"),
      "assignee receives a task-assignment notification live",
    );

    cMarcus.close();
  },
);
