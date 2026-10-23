import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// HOST SETTINGS MODAL (0134) — camera / screen share / whiteboard, meeting-wide
// and per person, for the meeting's creator only.
//
// Pinned here: the creator-only gate (a co-host gets nothing), that the host's
// whiteboard switch is separate from the admin's, and that a per-person
// restriction survives into the token grant — a restricted person who rejoins
// must not get their camera or screen share back.

let dbUp = false;
let db: any;
let meetingService: any;
let policy: any;
let restrictions: any;
let wb: any;

const HOST = "u_hc_host";
const COHOST = "u_hc_cohost";
const GUEST = "u_hc_guest";
let meetingId: string;

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    await migrate(platform.config.database.url);
    meetingService = await import("../src/services/meetingService");
    policy = await import("../src/services/meetingPolicy");
    restrictions = await import("../src/services/participantRestrictions");
    wb = await import("../src/services/whiteboardAccess");
    for (const [id, name] of [
      [HOST, "HC Host"],
      [COHOST, "HC Cohost"],
      [GUEST, "HC Guest"],
    ] as const) {
      await db.users.upsert({
        id, email: id + "@ex.com", name, initials: "HC",
        color: "#2563EB", presence: "off", passwordHash: null,
      });
    }
    const mt = await db.meetings.create({
      title: "Host controls test",
      startsAt: new Date(Date.now() + 5 * 60000).toISOString().slice(0, 19).replace("T", " "),
      durationMin: 120,
      createdBy: HOST,
      attendees: [COHOST, GUEST],
    });
    meetingId = mt.id;
    await db.meetings.setAttendeeRole(meetingId, COHOST, "co-host");
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — DB cases will skip:", e.message);
  }
});

after(async () => {
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

dbTest("everything starts allowed", async () => {
  const c = await meetingService.getHostControls({ meetingId, userId: HOST });
  assert.equal(c.allowCamera, true);
  assert.equal(c.allowScreenShare, true);
  assert.equal(c.allowWhiteboard, true);
  assert.deepEqual(c.users, {});
});

dbTest("only the creator may read or change the controls — not even a co-host", async () => {
  for (const who of [COHOST, GUEST]) {
    await assert.rejects(
      () => meetingService.getHostControls({ meetingId, userId: who }),
      (e: any) => e.status === 403,
    );
    await assert.rejects(
      () => meetingService.setHostSettings({ meetingId, userId: who, patch: { allowCamera: false } }),
      (e: any) => e.status === 403,
    );
    await assert.rejects(
      () =>
        meetingService.setParticipantPermissions({
          meetingId, userId: who, targetUserId: GUEST, patch: { camera: false },
        }),
      (e: any) => e.status === 403,
    );
  }
});

dbTest("meeting-wide switches persist and narrow the attendee grant", async () => {
  await meetingService.setHostSettings({
    meetingId, userId: HOST,
    patch: { allowCamera: false, allowScreenShare: false, allowWhiteboard: false },
  });
  const m = await db.meetings.getById(meetingId);
  const o = policy.optionsOf(m);
  assert.equal(o.allowCamera, false);
  assert.equal(o.allowScreenShare, false);
  assert.equal(o.hostAllowWhiteboard, false);
  assert.equal(o.allowWhiteboard, true, "the admin's own whiteboard switch is untouched");
  assert.deepEqual(
    policy.effectiveSources(m, { isHost: false, isCoHost: false }),
    ["microphone"],
  );
  for (const who of [{ isHost: true, isCoHost: false }, { isHost: false, isCoHost: true }]) {
    assert.deepEqual(
      policy.effectiveSources(m, who).sort(),
      ["camera", "microphone", "screen_share", "screen_share_audio"],
      "hosts and co-hosts are never restricted by the policy",
    );
  }
  await meetingService.setHostSettings({
    meetingId, userId: HOST,
    patch: { allowCamera: true, allowScreenShare: true, allowWhiteboard: true },
  });
});

dbTest("bad values are rejected, not coerced", async () => {
  for (const bad of [{ allowCamera: "no" }, { allowScreenShare: 0 }, {}]) {
    await assert.rejects(
      () => meetingService.setHostSettings({ meetingId, userId: HOST, patch: bad }),
      (e: any) => e.status === 400,
    );
  }
});

dbTest("the general options route cannot flip the host-only switches", async () => {
  // A co-host using PATCH /options goes through normalizePatch, which must
  // drop these keys silently — they belong to the creator's Settings modal.
  const r = await meetingService.setOptions({
    meetingId, userId: COHOST,
    patch: { allowScreenShare: false, hostAllowWhiteboard: false },
  });
  assert.equal(r.changed, false);
  const o = policy.optionsOf(await db.meetings.getById(meetingId));
  assert.equal(o.allowScreenShare, true);
  assert.equal(o.hostAllowWhiteboard, true);
});

dbTest("a per-person restriction narrows only that person, and rides the token grant", async () => {
  const out = await meetingService.setParticipantPermissions({
    meetingId, userId: HOST, targetUserId: GUEST,
    patch: { camera: false, screenShare: false, whiteboard: false },
  });
  assert.equal(out.cameraBlocked, true);
  assert.equal(out.screenShareBlocked, true);
  assert.equal(out.whiteboardBlocked, true);
  const m = await db.meetings.getById(meetingId);
  // The same function the token route calls — a rejoin gets no camera/screen.
  const g = policy.grantForUser(m, GUEST, { isHost: false, isCoHost: false });
  assert.deepEqual(g.canPublishSources, ["microphone"]);
  // Someone else in the same meeting is unaffected.
  const other = policy.grantForUser(m, "u_hc_someone_else", { isHost: false, isCoHost: false });
  assert.deepEqual(other.canPublishSources.sort(), ["camera", "microphone", "screen_share", "screen_share_audio"]);
  assert.equal(wb.isWhiteboardBlocked(meetingId, GUEST), true);

  const c = await meetingService.getHostControls({ meetingId, userId: HOST });
  assert.deepEqual(c.users[GUEST], {
    cameraBlocked: true, screenShareBlocked: true, whiteboardBlocked: true,
  });
  // The restricted person sees their own flags when they read the options.
  const mine = await meetingService.getOptions({ meetingId, userId: GUEST });
  assert.equal(mine.cameraBlocked, true);
  assert.equal(mine.screenShareBlocked, true);
  assert.equal(mine.whiteboardBlocked, true);
});

dbTest("a restriction can be lifted again", async () => {
  await meetingService.setParticipantPermissions({
    meetingId, userId: HOST, targetUserId: GUEST,
    patch: { camera: true, screenShare: true, whiteboard: true },
  });
  const m = await db.meetings.getById(meetingId);
  const g = policy.grantForUser(m, GUEST, { isHost: false, isCoHost: false });
  assert.deepEqual(g.canPublishSources.sort(), ["camera", "microphone", "screen_share", "screen_share_audio"]);
  assert.deepEqual(restrictions.restrictedUserIds(meetingId), []);
  assert.equal(wb.isWhiteboardBlocked(meetingId, GUEST), false);
});

dbTest("the host and co-hosts cannot be restricted", async () => {
  for (const target of [HOST, COHOST]) {
    await assert.rejects(
      () =>
        meetingService.setParticipantPermissions({
          meetingId, userId: HOST, targetUserId: target, patch: { camera: false },
        }),
      (e: any) => e.status === 400,
    );
  }
});

dbTest("with every source removed the grant is canPublish:false, never 'unrestricted'", async () => {
  await db.meetings.setOptions(meetingId, { allowMic: false, allowCamera: false, allowScreenShare: false });
  const g = policy.effectiveGrant(await db.meetings.getById(meetingId), { isHost: false, isCoHost: false });
  assert.equal(g.canPublish, false);
  assert.deepEqual(g.canPublishSources, []);
  await db.meetings.setOptions(meetingId, { allowMic: true, allowCamera: true, allowScreenShare: true });
});
