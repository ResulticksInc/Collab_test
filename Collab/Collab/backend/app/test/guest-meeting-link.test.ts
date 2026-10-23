// Public (guest) meeting link: token lifecycle, guest identity/session minting,
// the org binding, and — most importantly — the fence around what a guest token
// may reach (REST allowlist in middleware/auth.ts).
//
// Pure cases (name rules, token shape, redaction) always run. The DB-backed cases
// skip when MySQL is unavailable, like the other suites.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { useTestDatabase } from "./_setup";
import {
  normalizeGuestName,
  looksLikePublicToken,
  looksLikeDeviceId,
  rawGuestName,
  redactRoomForGuest,
  slimPerson,
} from "../src/services/guestMeetingService";

// ── pure ─────────────────────────────────────────────────────────────────────

test("guest names: trims, collapses whitespace, enforces 2–50 chars with a letter/digit", () => {
  const ok = (v: any) => normalizeGuestName(v);
  assert.deepEqual(ok("  Ada   Lovelace "), { ok: true, name: "Ada Lovelace" });
  assert.equal(ok("A").ok, false, "1 char is too short");
  assert.equal(ok("   ").ok, false, "blank");
  assert.equal(ok("").ok, false, "empty");
  assert.equal(ok(undefined).ok, false, "missing");
  assert.equal(ok(42).ok, false, "non-string");
  assert.equal(ok("x".repeat(51)).ok, false, "51 chars is too long");
  assert.equal(ok("x".repeat(50)).ok, true, "50 chars is fine");
  assert.equal(ok("!!!???").ok, false, "needs a letter or digit");
  assert.equal(ok("<b>Bob</b>").ok, false, "angle brackets are rejected");
  assert.equal(ok("李雷").ok, true, "non-latin letters are valid");
  assert.equal(ok("R2").ok, true, "digits count");
});

test("guest names: control, zero-width and bidi-override characters are stripped", () => {
  assert.deepEqual(normalizeGuestName("Eve‮txt​"), { ok: true, name: "Evetxt" });
  assert.deepEqual(normalizeGuestName("Bo\u0000b"), { ok: true, name: "Bob" });
});

test("guest names: a typed '(Guest)' suffix is not doubled", () => {
  assert.deepEqual(normalizeGuestName("Sam (guest)"), { ok: true, name: "Sam" });
  assert.equal(normalizeGuestName("(Guest)").ok, false, "nothing left once the suffix is removed");
});

test("public tokens: only the shape we mint is worth a lookup", () => {
  assert.equal(looksLikePublicToken("A".repeat(32)), true);
  assert.equal(looksLikePublicToken("short"), false);
  assert.equal(looksLikePublicToken("a/b".padEnd(32, "x")), false);
  assert.equal(looksLikePublicToken("x".repeat(65)), false);
  assert.equal(looksLikePublicToken(undefined), false);
});

test("device ids: only the opaque shape the lobby generates is accepted", () => {
  assert.equal(looksLikeDeviceId("a".repeat(32)), true);
  assert.equal(looksLikeDeviceId("0123456789abcdef0123456789abcdef"), true, "uuid without dashes");
  assert.equal(looksLikeDeviceId("short"), false);
  assert.equal(looksLikeDeviceId("x".repeat(65)), false);
  assert.equal(looksLikeDeviceId("has space".padEnd(32, "x")), false);
  assert.equal(looksLikeDeviceId(undefined), false);
  assert.equal(looksLikeDeviceId(null), false);
  assert.equal(looksLikeDeviceId(42), false);
  assert.equal(rawGuestName("Ada Lovelace (Guest)"), "Ada Lovelace");
  assert.equal(rawGuestName("Ada"), "Ada");
  assert.equal(rawGuestName(null), "");
});

test("redactRoomForGuest strips contact details from attendees and participants only", () => {
  const person = { id: "u1", name: "Pat", initials: "P", color: "#fff", avatarUrl: null, email: "pat@acme.io", phone: "+1", title: "CEO", presence: "on", role: "member" };
  const room = { count: 1, state: "active", meeting: { id: "m", title: "T", attendees: [person] }, participants: [{ ...person, joinedAt: "now" }] };
  const out: any = redactRoomForGuest(room);
  for (const p of [out.meeting.attendees[0], out.participants[0]]) {
    assert.equal(p.email, undefined);
    assert.equal(p.phone, undefined);
    assert.equal(p.title, undefined);
    assert.equal(p.name, "Pat");
  }
  assert.equal(out.participants[0].joinedAt, "now");
  assert.equal(out.meeting.title, "T");
  assert.equal(out.meeting.conversationId, null, "the org chat group id isn't handed to guests");
  assert.equal(out.count, 1);
  // non-destructive
  assert.equal(room.participants[0].email, "pat@acme.io");
  assert.equal(slimPerson(null), null);
});

// ── DB-backed ────────────────────────────────────────────────────────────────

let dbUp = false;
let db: any;
let svc: typeof import("../src/services/guestMeetingService");
let authMiddleware: any;
let meetingSvc: any;
let orgContext: any;
let currentOrgId: any;
let secret = "";

const sfx = Math.random().toString(36).slice(2, 8);
const HOST = "u_gl_host_" + sfx;
const MEMBER = "u_gl_member_" + sfx;
let ORG = "";
let ORG2 = "";
let MID = "";
let OTHER_MID = "";

before(async () => {
  await useTestDatabase();
  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    secret = platform.config.auth.jwtSecret;
    orgContext = platform.orgContext;
    currentOrgId = platform.currentOrgId;
    await migrate(platform.config.database.url);
    svc = await import("../src/services/guestMeetingService");
    authMiddleware = (await import("../src/middleware/auth")).default;
    meetingSvc = await import("../src/services/meetingService");
    for (const id of [HOST, MEMBER])
      await db.users.upsert({ id, email: `${id}@t.test`, name: id, initials: "ZZ", color: "#94A3B8", avatarUrl: "", role: "member", presence: "off" });
    const org = await db.orgs.create({ name: "Acme " + sfx, slug: "acme-" + sfx, kind: "team", ownerId: HOST });
    const org2 = await db.orgs.create({ name: "Other " + sfx, slug: "other-" + sfx, kind: "team", ownerId: MEMBER });
    ORG = org.id;
    ORG2 = org2.id;
    await orgContext.run({ orgId: ORG }, async () => {
      const m = await db.meetings.create({ title: "Board sync", startsAt: new Date(Date.now() + 3600_000), durationMin: 30, createdBy: HOST, attendees: [MEMBER] });
      MID = m.id;
      const o = await db.meetings.create({ title: "Unrelated", startsAt: new Date(Date.now() + 3600_000), durationMin: 30, createdBy: HOST, attendees: [] });
      OTHER_MID = o.id;
    });
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — guest-meeting-link DB cases will skip:", e.message);
  }
});

function dbTest(name: string, fn: () => Promise<void>) {
  test(name, async (t) => {
    if (!dbUp) return (t as any).skip("MySQL unavailable");
    await fn();
  });
}

const inOrg = <T>(orgId: string, fn: () => Promise<T>) => orgContext.run({ orgId }, fn);

dbTest("only the host or a co-host can create / read / revoke the link", async () => {
  await assert.rejects(inOrg(ORG, () => svc.ensureLink({ meetingId: MID, userId: MEMBER })), (e: any) => e.status === 403);
  await assert.rejects(inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: MEMBER })), (e: any) => e.status === 403);
  await assert.rejects(inOrg(ORG, () => svc.revokeLink({ meetingId: MID, userId: MEMBER })), (e: any) => e.status === 403);
  // …and a host of one tenant can't reach another tenant's meeting.
  await assert.rejects(inOrg(ORG2, () => svc.ensureLink({ meetingId: MID, userId: HOST })), (e: any) => e.status === 404);
});

dbTest("ensureLink is idempotent and the token is unguessable-shaped", async () => {
  const a = await inOrg(ORG, () => svc.ensureLink({ meetingId: MID, userId: HOST }));
  const b = await inOrg(ORG, () => svc.ensureLink({ meetingId: MID, userId: HOST }));
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.token, b.token);
  assert.equal(svc.looksLikePublicToken(a.token), true);
  assert.ok(a.token.length >= 32);
  const got = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  assert.equal(got.enabled, true);
  // the unrelated meeting has no link
  const none = await inOrg(ORG, () => svc.getLink({ meetingId: OTHER_MID, userId: HOST }));
  assert.equal(none.enabled, false);
});

dbTest("describeLink exposes only title / host / org — and nothing for a bad token", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const info: any = await svc.describeLink(token as string);
  assert.equal(info.title, "Board sync");
  assert.equal(info.hostName, HOST);
  assert.equal(info.organizationName, "Acme " + sfx);
  assert.equal(info.attendees, undefined, "no attendee list leaks");
  assert.equal(await svc.describeLink("z".repeat(32)), null);
  assert.equal(await svc.describeLink("nope"), null);
});

dbTest("joinAsGuest mints a guest user bound to the meeting's org (not the client's)", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const out: any = await svc.joinAsGuest({ token: token as string, name: "  Ada  Lovelace ", ip: "203.0.113.9", userAgent: "test" });
  assert.equal(out.meetingId, MID);
  assert.equal(out.user.name, "Ada Lovelace (Guest)");
  assert.equal(out.user.role, "guest");
  assert.equal(out.user.email, null, "synthetic address is never exposed");

  const claims: any = jwt.verify(out.token, secret);
  assert.equal(claims.guest, true);
  assert.equal(claims.mid, MID);
  assert.equal(claims.sub, out.user.id);
  assert.ok(claims.jti);

  const u = await db.users.getById(out.user.id);
  assert.equal(u.role, "guest");
  assert.match(u.email, /@guest\.invalid$/);
  assert.equal(u.passwordHash || null, null, "guests have no password");

  const sess = await db.sessions.getForAuth(claims.jti);
  assert.equal(sess.activeOrgId, ORG, "tenant comes from the meeting row");
  assert.equal(sess.revoked, false);

  // no org membership: a guest never appears in the org directory
  const members = await db.orgs.membership(out.user.id, ORG);
  assert.ok(!members || members.status !== "active");
});

// ── One guest identity per browser profile per meeting ──────────────────────
dbTest("same browser profile, different names → ONE guest identity, original name kept", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const device = "dev_" + sfx + "_" + "a".repeat(24);

  const first: any = await svc.joinAsGuest({ token: token as string, name: "Hari Vigenesh", deviceId: device });
  assert.equal(first.resumed, false);
  assert.equal(first.name, "Hari Vigenesh");
  assert.equal(first.user.name, "Hari Vigenesh (Guest)");

  // comes back under a different name → same user, same display name
  const second: any = await svc.joinAsGuest({ token: token as string, name: "Hari", deviceId: device });
  assert.equal(second.resumed, true);
  assert.equal(second.user.id, first.user.id, "no second participant identity");
  assert.equal(second.user.name, "Hari Vigenesh (Guest)", "the original display name is retained");
  assert.equal(second.name, "Hari Vigenesh");
  assert.notEqual(second.token, first.token, "a fresh session is minted each time");
  const c1: any = jwt.verify(first.token, secret);
  const c2: any = jwt.verify(second.token, secret);
  assert.equal(c1.sub, c2.sub);
  assert.notEqual(c1.jti, c2.jti);
  assert.equal((await db.sessions.getForAuth(c1.jti)).revoked, false, "the earlier session is left alone (another tab / reconnect)");

  // …and a third time under yet another name — still the same identity
  const third: any = await svc.joinAsGuest({ token: token as string, name: "Vicky", deviceId: device });
  assert.equal(third.user.id, first.user.id);
  const bound = await db.meetings.getGuestDevice(MID, device);
  assert.equal(bound.userId, first.user.id);
  assert.equal(bound.joinCount, 3);

  // the lobby lookup tells this browser who it already is
  const info: any = await svc.describeLink(token as string, device);
  assert.deepEqual(info.identity, { name: "Hari Vigenesh", joinCount: 3 });
  const fresh: any = await svc.describeLink(token as string, "dev_unknown_" + "b".repeat(24));
  assert.equal(fresh.identity, null);
  const none: any = await svc.describeLink(token as string);
  assert.equal(none.identity, null);

  // the room sees ONE participant for that browser
  const room: any = await inOrg(ORG, () => meetingSvc.enterRoom({ meetingId: MID, userId: third.user.id }));
  assert.equal(room.participants.filter((p: any) => p.id === first.user.id).length, 1);
});

dbTest("a different browser/device with the same name is a different participant", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const a: any = await svc.joinAsGuest({ token: token as string, name: "Same Name", deviceId: "dev_" + sfx + "_" + "c".repeat(24) });
  const b: any = await svc.joinAsGuest({ token: token as string, name: "Same Name", deviceId: "dev_" + sfx + "_" + "d".repeat(24) });
  assert.notEqual(a.user.id, b.user.id);
  assert.equal(b.resumed, false);
});

dbTest("the device binding is per MEETING — the same browser is a new guest in another meeting", async () => {
  const device = "dev_" + sfx + "_" + "e".repeat(24);
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const a: any = await svc.joinAsGuest({ token: token as string, name: "Roamer", deviceId: device });
  await inOrg(ORG, () => db.meetings.setStatus(OTHER_MID, "scheduled"));
  const other = await inOrg(ORG, () => svc.ensureLink({ meetingId: OTHER_MID, userId: HOST }));
  const b: any = await svc.joinAsGuest({ token: other.token as string, name: "Roamer", deviceId: device });
  assert.notEqual(a.user.id, b.user.id);
  assert.equal(b.resumed, false);
  assert.equal(b.meetingId, OTHER_MID);
});

dbTest("no / malformed device id → a fresh identity per join (pre-existing behaviour)", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const a: any = await svc.joinAsGuest({ token: token as string, name: "Anon" });
  const b: any = await svc.joinAsGuest({ token: token as string, name: "Anon" });
  const c: any = await svc.joinAsGuest({ token: token as string, name: "Anon", deviceId: "bad id!" });
  assert.notEqual(a.user.id, b.user.id);
  assert.notEqual(b.user.id, c.user.id);
  assert.equal(a.resumed, false);
});

dbTest("a binding whose guest user was deleted is treated as absent", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const device = "dev_" + sfx + "_" + "f".repeat(24);
  const a: any = await svc.joinAsGuest({ token: token as string, name: "Gone Soon", deviceId: device });
  await db.pool.query("UPDATE users SET deleted=1 WHERE id=?", [a.user.id]);
  const info: any = await svc.describeLink(token as string, device);
  assert.equal(info.identity, null);
  const b: any = await svc.joinAsGuest({ token: token as string, name: "Back Again", deviceId: device });
  assert.notEqual(b.user.id, a.user.id);
  assert.equal(b.resumed, false);
  assert.equal((await db.meetings.getGuestDevice(MID, device)).userId, b.user.id, "the binding now points at the new guest");
});

dbTest("joinAsGuest rejects invalid names (400) and unknown links (404)", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  await assert.rejects(svc.joinAsGuest({ token: token as string, name: "x" }), (e: any) => e.status === 400 && e.code === "INVALID_NAME");
  await assert.rejects(svc.joinAsGuest({ token: token as string, name: "" }), (e: any) => e.status === 400);
  await assert.rejects(svc.joinAsGuest({ token: "q".repeat(32), name: "Valid Name" }), (e: any) => e.status === 404);
});

// Drive the real auth middleware with a fake req/res.
async function callAs(bearer: string, method: string, url: string, body: any = {}) {
  let status = 0;
  let json: any = null;
  let nextCalled = false;
  let orgSeen: string | null = "unset";
  const req: any = { headers: { authorization: "Bearer " + bearer }, method, originalUrl: url, url, body };
  const res: any = {
    status(c: number) { status = c; return this; },
    json(j: any) { json = j; return this; },
  };
  await authMiddleware(req, res, () => { nextCalled = true; orgSeen = currentOrgId(); });
  return { status, json, nextCalled, req, orgSeen };
}

dbTest("a guest token reaches ONLY its own meeting's room endpoints", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const g: any = await svc.joinAsGuest({ token: token as string, name: "Grace Hopper" });

  // allowed — and the tenant context is the meeting's org
  for (const [m, u] of [
    ["POST", `/api/meetings/${MID}/room/enter`],
    ["POST", `/api/meetings/${MID}/room/heartbeat`],
    ["POST", `/api/meetings/${MID}/room/leave`],
    ["GET", `/api/meetings/${MID}/lobby/self`],
    ["GET", `/api/meetings/${MID}/options`],
    ["GET", `/api/meetings/${MID}/polls`],
    ["POST", `/api/meetings/${MID}/polls/p1/vote`],
    ["POST", `/api/meetings/${MID}__occ_3/room/enter`],
    ["POST", `/api/auth/logout`],
  ]) {
    const r = await callAs(g.token, m, u);
    assert.equal(r.nextCalled, true, `${m} ${u} should pass`);
    assert.equal(r.orgSeen, ORG, "request runs inside the meeting's tenant");
    assert.equal(r.req.user.guest, true);
    assert.equal(r.req.user.guestMeetingId, MID);
  }
  const tok = await callAs(g.token, "POST", "/api/calls/token", { meetingId: MID });
  assert.equal(tok.nextCalled, true, "livekit token for its own meeting");
  const mute = await callAs(g.token, "POST", "/api/calls/media/self-mute-state", { room: `meeting_${MID}`, muted: true });
  assert.equal(mute.nextCalled, true);

  // refused — with a 403 before any route code runs
  const denied: Array<[string, string, any?]> = [
    ["POST", `/api/meetings/${OTHER_MID}/room/enter`],
    ["GET", `/api/meetings/${OTHER_MID}/options`],
    ["GET", `/api/meetings`],
    ["POST", `/api/meetings/${MID}/public-link`],
    ["DELETE", `/api/meetings/${MID}/public-link`],
    ["POST", `/api/meetings/${MID}/lobby/admit`],
    ["POST", `/api/meetings/${MID}/controls/mute-all`],
    ["POST", `/api/meetings/${MID}/complete`],
    ["GET", `/api/meetings/${MID}/recordings`],
    ["GET", `/api/conversations`],
    ["GET", `/api/users`],
    ["GET", `/api/files`],
    ["GET", `/api/orgs/current`],
    ["GET", `/api/auth/me`],
    ["GET", `/api/settings`],
    ["POST", `/api/calls/token`, { meetingId: OTHER_MID }],
    ["POST", `/api/calls/token`, { conversationId: "c1" }],
    ["POST", `/api/calls/token`, { callId: "x" }],
    ["POST", `/api/calls/token`, { meetingId: MID, conversationId: "c1" }],
    ["POST", `/api/calls/media/self-mute-state`, { room: `meeting_${OTHER_MID}` }],
    ["POST", `/api/calls/media/self-mute-state`, { room: `conv_${MID}` }],
    ["POST", `/api/meetings/${MID}/room/enter/extra`],
    ["GET", `/api/meetings/${MID}/room/enter`], // wrong method
  ];
  for (const [m, u, b] of denied) {
    const r = await callAs(g.token, m, u, b || {});
    assert.equal(r.nextCalled, false, `${m} ${u} must be blocked`);
    assert.equal(r.status, 403, `${m} ${u} → 403`);
    assert.equal(r.json?.error?.code, "GUEST_FORBIDDEN");
  }
});

dbTest("a malformed %-escape in the path fails closed instead of crashing", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const g: any = await svc.joinAsGuest({ token: token as string, name: "Edsger Dijkstra" });
  const r = await callAs(g.token, "POST", `/api/meetings/%E0%A4%A/room/enter`);
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 403);
});

dbTest("a guest token without a jti / meeting binding, or with a revoked session, is refused", async () => {
  const bare = jwt.sign({ sub: "x", name: "x", guest: true, mid: MID }, secret, { expiresIn: "1h" });
  assert.equal((await callAs(bare, "POST", `/api/meetings/${MID}/room/enter`)).status, 401, "no jti");
  const nomid = jwt.sign({ sub: "x", name: "x", guest: true, jti: "j" }, secret, { expiresIn: "1h" });
  assert.equal((await callAs(nomid, "POST", `/api/meetings/${MID}/room/enter`)).status, 401, "no meeting binding");

  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const g: any = await svc.joinAsGuest({ token: token as string, name: "Linus Torvalds" });
  const claims: any = jwt.decode(g.token);
  assert.equal((await callAs(g.token, "POST", `/api/meetings/${MID}/room/enter`)).nextCalled, true);
  await db.sessions.revoke(claims.sub, claims.jti);
  // the middleware caches a good session lookup briefly; a fresh jti-keyed cache
  // entry is only reused inside the grace window on a DB ERROR, never on a clean
  // "revoked" answer, so this must now be refused.
  const after = await callAs(g.token, "POST", `/api/meetings/${MID}/room/enter`);
  assert.equal(after.nextCalled, false);
  assert.equal(after.status, 401);
});

dbTest("a guest enters the room through the normal flow and obeys the lobby policy", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const g: any = await svc.joinAsGuest({ token: token as string, name: "Alan Turing" });

  // default policy 'everyone' → straight in
  const room: any = await inOrg(ORG, () => meetingSvc.enterRoom({ meetingId: MID, userId: g.user.id }));
  assert.ok(room.meeting, "admitted");
  assert.ok(room.participants.some((p: any) => p.id === g.user.id));
  const me = room.participants.find((p: any) => p.id === g.user.id);
  assert.equal(me.role, "guest");
  assert.equal(me.email, null, "guest's synthetic address is not exposed to the room");
  assert.equal(me.name, "Alan Turing (Guest)");

  // host turns the lobby on → a NEW guest has to wait (a guest is never 'invited')
  await inOrg(ORG, () => db.meetings.setLobbyEnabled(MID, true));
  try {
    const g2: any = await svc.joinAsGuest({ token: token as string, name: "Barbara Liskov" });
    const held: any = await inOrg(ORG, () => meetingSvc.enterRoom({ meetingId: MID, userId: g2.user.id }));
    assert.equal(held.lobbyStatus, "waiting");
    assert.equal(held.meeting, undefined, "no room access while waiting");
  } finally {
    await inOrg(ORG, () => db.meetings.setLobbyEnabled(MID, false));
  }
});

dbTest("the meeting chat group never includes guests", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const g: any = await svc.joinAsGuest({ token: token as string, name: "Ken Thompson" });
  const ids = await svc.withoutGuests([HOST, MEMBER, g.user.id, MEMBER]);
  assert.deepEqual(ids.sort(), [HOST, MEMBER].sort());
});

dbTest("revoking the link kills the URL at once (lookup + join)", async () => {
  const { token } = await inOrg(ORG, () => svc.getLink({ meetingId: MID, userId: HOST }));
  const r = await inOrg(ORG, () => svc.revokeLink({ meetingId: MID, userId: HOST }));
  assert.equal(r.enabled, false);
  assert.equal(await svc.describeLink(token as string), null);
  await assert.rejects(svc.joinAsGuest({ token: token as string, name: "Too Late" }), (e: any) => e.status === 404);
  // a fresh link is a DIFFERENT token
  const again = await inOrg(ORG, () => svc.ensureLink({ meetingId: MID, userId: HOST }));
  assert.notEqual(again.token, token);
});

dbTest("hard-ended meetings: link stays valid inside the scheduled window, closes after it", async () => {
  // A fresh meeting with a link, then "End for everyone" while still inside its window.
  let m: any;
  await inOrg(ORG, async () => {
    m = await db.meetings.create({ title: "Ends early", startsAt: new Date(Date.now() + 600_000), durationMin: 30, createdBy: HOST, attendees: [] });
  });
  const { token } = await inOrg(ORG, () => svc.ensureLink({ meetingId: m.id, userId: HOST }));
  await inOrg(ORG, () => db.meetings.setHardEnded(m.id));
  const during: any = await svc.describeLink(token as string);
  assert.equal(during.ended, false, "same rule as enterRoom: re-joinable inside the window");
  const g: any = await svc.joinAsGuest({ token: token as string, name: "Within Window" });
  assert.ok(g.token);

  // Slide the meeting into the past → closed for new joiners.
  await db.pool.query("UPDATE meetings SET starts_at = ? WHERE id = ?", [new Date(Date.now() - 3 * 3600_000), m.id]);
  const after: any = await svc.describeLink(token as string);
  assert.equal(after.ended, true);
  await assert.rejects(svc.joinAsGuest({ token: token as string, name: "Too Late" }), (e: any) => e.status === 410 && e.code === "MEETING_ENDED");
});

dbTest("a cancelled meeting can't mint a link or admit a new guest", async () => {
  const { token } = await inOrg(ORG, () => svc.ensureLink({ meetingId: OTHER_MID, userId: HOST }));
  await inOrg(ORG, () => db.meetings.setStatus(OTHER_MID, "cancelled"));
  assert.equal(((await svc.describeLink(token as string)) as any).ended, true);
  await assert.rejects(svc.joinAsGuest({ token: token as string, name: "Cancelled Join" }), (e: any) => e.status === 410);
  // …and a fresh link can't be minted for it
  await assert.rejects(
    inOrg(ORG, async () => {
      await db.meetings.setPublicLinkToken(OTHER_MID, null);
      return svc.ensureLink({ meetingId: OTHER_MID, userId: HOST });
    }),
    (e: any) => e.status === 409,
  );
});

// The lobby's Join button (frontend/lib/guestName.ts) must enable exactly when the
// server would accept the name — assert the two rule sets agree on a corpus.
test("frontend and backend guest-name rules agree", async () => {
  const { validateGuestName } = await import("../../../frontend/app/src/lib/guestName");
  const corpus: any[] = [
    "Ada", "A", "", "  ", "x".repeat(50), "x".repeat(51), "!!!", "<b>Bob</b>", "李雷", "R2",
    "  Ada   Lovelace ", "Eve\u202Etxt", "Bo\u0000b", "Sam (guest)", "(Guest)", "a>b", "😀😀", "😀a",
    "\u200b\u200b", "Zoë Müller-Ñandú", "x".repeat(49) + "(guest)", undefined, null, 42,
  ];
  for (const c of corpus) {
    const be = normalizeGuestName(c);
    const fe = validateGuestName(c);
    assert.equal(fe.ok, be.ok, `ok mismatch for ${JSON.stringify(c)}`);
    if (be.ok) assert.equal(fe.name, be.name, `name mismatch for ${JSON.stringify(c)}`);
    else assert.equal(fe.error, be.message, `message mismatch for ${JSON.stringify(c)}`);
  }
});
