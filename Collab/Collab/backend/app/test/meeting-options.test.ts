import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// PER-MEETING OPTIONS (0116/0117) — the policy layer over the host controls.
//
// The parts worth pinning are the ones a typecheck cannot see: that the SAME
// function decides a joiner's LiveKit grant and a live participant's
// re-permission (so the two can never drift), that hosts are never restricted
// by a policy they can change, that "invited" keeps meaning the host's invite
// list rather than "anyone who has joined before", and that the legacy lobby
// boolean stays in step with the policy that replaced it.

let dbUp = false;
let db: any;
let shared: any;
let meetingService: any;
let policy: any;

const HOST = "u_opttest_host";
const INVITED = "u_opttest_invited";
const OUTSIDER = "u_opttest_outsider";
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
    shared = platform.shared;
    await migrate(platform.config.database.url);
    meetingService = await import("../src/services/meetingService");
    policy = await import("../src/services/meetingPolicy");

    for (const [id, name] of [
      [HOST, "Opt Host"],
      [INVITED, "Opt Invited"],
      [OUTSIDER, "Opt Outsider"],
    ] as const) {
      await db.users.upsert({
        id, email: id + "@ex.com", name, initials: "OT",
        color: "#2563EB", presence: "off", passwordHash: null,
      });
    }
    const mt = await db.meetings.create({
      title: "Options test",
      startsAt: new Date(Date.now() + 5 * 60000).toISOString().slice(0, 19).replace("T", " "),
      durationMin: 120,
      createdBy: HOST,
      attendees: [INVITED],
    });
    meetingId = mt.id;
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

// ── Defaults ────────────────────────────────────────────────────────────────

dbTest("a new meeting behaves exactly as meetings did before the feature", async () => {
  const o = await meetingService.getOptions({ meetingId, userId: HOST });
  assert.deepEqual(
    {
      lobbyPolicy: o.lobbyPolicy,
      allowMic: o.allowMic, allowCamera: o.allowCamera,
      allowChat: o.allowChat, allowReactions: o.allowReactions, autoRecord: o.autoRecord,
    },
    {
      lobbyPolicy: "everyone",
      allowMic: true, allowCamera: true,
      allowChat: true, allowReactions: true, autoRecord: false,
    },
  );
  assert.equal(o.canEdit, true, "the host can edit");
});

dbTest("a meeting row with no option columns still reads as fully permissive", () => {
  // Guards the fallback path: a driver row from before the migration.
  const o = policy.optionsOf({ id: "x" });
  assert.deepEqual(o, policy.OPTION_DEFAULTS);
  // …and a legacy lobby boolean is still honoured rather than silently dropped.
  assert.equal(policy.optionsOf({ lobbyEnabled: 1 }).lobbyPolicy, "nobody");
  assert.equal(policy.optionsOf({ lobbyEnabled: 0 }).lobbyPolicy, "everyone");
});

// ── Authorization ───────────────────────────────────────────────────────────

dbTest("only a host or co-host can change options", async () => {
  await assert.rejects(
    () => meetingService.setOptions({ meetingId, userId: INVITED, patch: { allowMic: false } }),
    (e: any) => e.status === 403,
  );
  await db.meetings.setAttendeeRole(meetingId, INVITED, "co-host");
  const out = await meetingService.setOptions({
    meetingId, userId: INVITED, patch: { allowChat: false },
  });
  assert.equal(out.allowChat, false, "a co-host may change options");
  await meetingService.setOptions({ meetingId, userId: HOST, patch: { allowChat: true } });
  await db.meetings.setAttendeeRole(meetingId, INVITED, "participant");
});

dbTest("someone outside the meeting cannot even read the options", async () => {
  await assert.rejects(
    () => meetingService.getOptions({ meetingId, userId: OUTSIDER }),
    (e: any) => e.status === 403,
  );
});

dbTest("invalid values are refused, never coerced", async () => {
  for (const bad of [
    { lobbyPolicy: "sometimes" },
    { allowMic: "yes" },
    { autoRecord: 1 },
  ]) {
    await assert.rejects(
      () => meetingService.setOptions({ meetingId, userId: HOST, patch: bad }),
      (e: any) => e.status === 400,
      `refused: ${JSON.stringify(bad)}`,
    );
  }
});

// ── The grant: what a participant may publish ───────────────────────────────

dbTest("the publish grant narrows exactly as the policy says", async () => {
  const m0 = await db.meetings.getById(meetingId);
  assert.deepEqual(
    policy.effectiveSources(m0, { isHost: false, isCoHost: false }).sort(),
    ["camera", "microphone", "screen_share", "screen_share_audio"],
  );

  await meetingService.setOptions({ meetingId, userId: HOST, patch: { allowMic: false } });
  const m = await db.meetings.getById(meetingId);
  assert.deepEqual(
    policy.effectiveSources(m, { isHost: false, isCoHost: false }).sort(),
    ["camera", "screen_share", "screen_share_audio"],
    "losing the mic never costs an attendee the ability to present",
  );
});

dbTest("presenting is open to everyone and cannot be taken away (0120)", async () => {
  // The product rule: if you are in the meeting, you can share your screen.
  // Pinned as a test because it was previously a policy, so a future change that
  // re-introduces a gate should have to delete this deliberately.
  await meetingService.setOptions({
    meetingId, userId: HOST,
    patch: { allowMic: false, allowCamera: false, allowChat: false, allowReactions: false },
  });
  const m = await db.meetings.getById(meetingId);
  const g = policy.effectiveGrant(m, { isHost: false, isCoHost: false });
  assert.equal(g.canPublish, true, "an attendee is never fully silenced — they can still present");
  assert.deepEqual(
    g.canPublishSources.sort(),
    ["screen_share", "screen_share_audio"],
    "with mic and camera off, screen share remains",
  );
  // A client still sending the retired option is IGNORED, not rejected —
  // normalizePatch copies only known keys, so an old client or a stale
  // integration keeps working instead of erroring on a field that no longer
  // exists. It must not resurrect the restriction either.
  const stale = await meetingService.setOptions({
    meetingId, userId: HOST, patch: { whoCanPresent: "hosts" } as any,
  });
  assert.equal(stale.changed, false, "an unknown option is a no-op");
  assert.ok(
    policy
      .effectiveSources(await db.meetings.getById(meetingId), { isHost: false, isCoHost: false })
      .includes("screen_share"),
    "and cannot bring the restriction back",
  );
  await meetingService.setOptions({
    meetingId, userId: HOST, patch: { allowMic: true, allowCamera: true, allowChat: true, allowReactions: true },
  });
});

dbTest("a host is never restricted by their own policy", async () => {
  const m = await db.meetings.getById(meetingId); // still fully locked down
  for (const who of [{ isHost: true, isCoHost: false }, { isHost: false, isCoHost: true }]) {
    assert.deepEqual(
      policy.effectiveSources(m, who).sort(),
      ["camera", "microphone", "screen_share", "screen_share_audio"],
      "a policy is imposed by hosts, not on them",
    );
  }
});

dbTest("the empty-grant guard still holds if every source is ever removed", async () => {
  // With presenting unconditional (0120) no real policy can empty the source
  // list — but the guard matters, because LiveKit reads an EMPTY
  // canPublishSources as "no restriction", so an empty list with
  // canPublish:true would grant EVERYTHING, the opposite of intent.
  const g = policy.effectiveGrant({ allowMic: false, allowCamera: false }, {
    isHost: false, isCoHost: false,
  });
  assert.equal(g.canPublish, true);
  assert.ok(g.canPublishSources.includes("screen_share"));
  // The degenerate case the guard exists for.
  const empty = policy.effectiveGrant(null, { isHost: false, isCoHost: false });
  assert.ok(empty.canPublish);
});

// ── Lobby policy ────────────────────────────────────────────────────────────

dbTest("each lobby policy holds the right people", async () => {
  const cases = [
    ["everyone", false, false, false],
    ["invited", false, false, true],
    ["nobody", false, true, true],
  ] as const;
  for (const [pol, host, invited, outsider] of cases) {
    await meetingService.setOptions({ meetingId, userId: HOST, patch: { lobbyPolicy: pol } });
    const m = await db.meetings.getById(meetingId);
    assert.equal(
      policy.mustWaitInLobby(m, { isHost: true, isCoHost: false, isInvited: true }), host,
      `${pol}: host`,
    );
    assert.equal(
      policy.mustWaitInLobby(m, { isHost: false, isCoHost: false, isInvited: true }), invited,
      `${pol}: invited attendee`,
    );
    assert.equal(
      policy.mustWaitInLobby(m, { isHost: false, isCoHost: false, isInvited: false }), outsider,
      `${pol}: uninvited`,
    );
  }
});

dbTest('"invited" means the host invited them, not "has joined before"', async () => {
  // The outsider joins while the lobby is open to everyone — which creates an
  // attendee row for them. Before 0117 that row alone made them "invited", so
  // tightening the policy afterwards would not have held them.
  await meetingService.setOptions({ meetingId, userId: HOST, patch: { lobbyPolicy: "everyone" } });
  await meetingService.enterRoom({ meetingId, userId: OUTSIDER });
  assert.equal(
    await db.meetings.isInvitedByHost(meetingId, OUTSIDER),
    false,
    "joining does not confer invited status",
  );
  assert.equal(
    await db.meetings.isInvitedByHost(meetingId, INVITED),
    true,
    "the host's invite list does",
  );

  await meetingService.setOptions({ meetingId, userId: HOST, patch: { lobbyPolicy: "invited" } });
  await db.pool.query("DELETE FROM meeting_lobby WHERE meeting_id = ?", [meetingId]);
  const r = await meetingService.enterRoom({ meetingId, userId: OUTSIDER });
  assert.equal(r.lobbyStatus, "waiting", "a previous joiner is still held by 'invited'");
});

dbTest("being invited is monotonic — a later join cannot clear it", async () => {
  await db.meetings.setAttendeeStatus(meetingId, OUTSIDER, "invited"); // the host invites them
  assert.equal(await db.meetings.isInvitedByHost(meetingId, OUTSIDER), true);
  await db.meetings.setAttendeeStatus(meetingId, OUTSIDER, "accepted"); // they join / RSVP
  assert.equal(
    await db.meetings.isInvitedByHost(meetingId, OUTSIDER),
    true,
    "an RSVP or re-join must not silently revoke invited status",
  );
});

// ── The legacy boolean ──────────────────────────────────────────────────────

dbTest("the old lobbyEnabled boolean stays in step with the policy", async () => {
  for (const [pol, expected] of [["everyone", false], ["invited", true], ["nobody", true]] as const) {
    await meetingService.setOptions({ meetingId, userId: HOST, patch: { lobbyPolicy: pol } });
    const m = await db.meetings.getById(meetingId);
    assert.equal(!!m.lobbyEnabled, expected, `${pol} -> lobbyEnabled ${expected}`);
  }
  // …and the legacy toggle moves the policy, so neither can be stale.
  await db.meetings.setLobbyEnabled(meetingId, true);
  assert.equal((await db.meetings.getById(meetingId)).lobbyPolicy, "nobody");
  await db.meetings.setLobbyEnabled(meetingId, false);
  assert.equal((await db.meetings.getById(meetingId)).lobbyPolicy, "everyone");
});

dbTest("an empty patch is a no-op rather than an error", async () => {
  const out = await meetingService.setOptions({ meetingId, userId: HOST, patch: {} });
  assert.equal(out.changed, false);
});

// ── Phase 1: agenda + attendance ────────────────────────────────────────────

dbTest("a meeting carries an agenda and a location, and can clear them", async () => {
  const mt = await db.meetings.create({
    title: "Agenda test",
    startsAt: new Date(Date.now() + 6 * 60000).toISOString().slice(0, 19).replace("T", " "),
    durationMin: 30,
    createdBy: HOST,
    attendees: [],
    description: "1. Budget\n2. Headcount",
    location: "Room 4",
  });
  assert.equal(mt.description, "1. Budget\n2. Headcount");
  assert.equal(mt.location, "Room 4");

  // A partial edit must not wipe the field it does not mention…
  await db.meetings.update(mt.id, { title: "Agenda test v2" });
  let after = await db.meetings.getById(mt.id);
  assert.equal(after.description, "1. Budget\n2. Headcount", "an unrelated edit keeps the agenda");
  assert.equal(after.location, "Room 4");

  // …but an explicit empty string CLEARS it. The generic update uses COALESCE,
  // where null means "leave alone", so clearing needs its own path.
  await db.meetings.update(mt.id, { description: "" });
  after = await db.meetings.getById(mt.id);
  assert.equal(after.description, null, "an empty agenda genuinely clears");
  assert.equal(after.location, "Room 4", "and does not touch the location");
});

dbTest("attendance records every separate session, not just the last one", async () => {
  const mt = await db.meetings.create({
    title: "Attendance test",
    startsAt: new Date(Date.now() + 7 * 60000).toISOString().slice(0, 19).replace("T", " "),
    durationMin: 60,
    createdBy: HOST,
    attendees: [INVITED, OUTSIDER],
  });
  await db.meetings.enterRoom(mt.id, HOST);
  await db.meetings.enterRoom(mt.id, INVITED);
  await db.meetings.leaveRoom(mt.id, INVITED);
  await db.meetings.enterRoom(mt.id, INVITED); // dropped off and came back

  const rep = await meetingService.attendance({ meetingId: mt.id, userId: HOST });
  const byId = Object.fromEntries(rep.rows.map((r: any) => [r.userId, r]));
  assert.equal(byId[INVITED].sessions, 2, "a rejoin is a second session, not an overwrite");
  assert.equal(byId[HOST].sessions, 1);
  assert.equal(byId[INVITED].stillPresent, true);
  // Someone invited who never turned up belongs in the report too.
  assert.equal(rep.absent.length, 1);
  assert.equal(rep.absent[0].userId, OUTSIDER);
  assert.equal(rep.invitedCount, 2);
});

dbTest("a reconnect does not open a second attendance session", async () => {
  const mt = await db.meetings.create({
    title: "Reconnect test",
    startsAt: new Date(Date.now() + 8 * 60000).toISOString().slice(0, 19).replace("T", " "),
    durationMin: 30,
    createdBy: HOST,
    attendees: [],
  });
  await db.meetings.enterRoom(mt.id, HOST);
  await db.meetings.enterRoom(mt.id, HOST); // flaky network re-entering
  await db.meetings.enterRoom(mt.id, HOST);
  const rep = await meetingService.attendance({ meetingId: mt.id, userId: HOST });
  assert.equal(
    rep.rows[0].sessions,
    1,
    "re-entering an already-open session must not inflate the count",
  );
});

dbTest("only a host or co-host can read the attendance report", async () => {
  const mt = await db.meetings.create({
    title: "Attendance authz",
    startsAt: new Date(Date.now() + 9 * 60000).toISOString().slice(0, 19).replace("T", " "),
    durationMin: 30,
    createdBy: HOST,
    attendees: [INVITED],
  });
  await assert.rejects(
    () => meetingService.attendance({ meetingId: mt.id, userId: INVITED }),
    (e: any) => e.status === 403,
  );
});

// ── Admin-controlled whiteboard (0133) ──────────────────────────────────────

dbTest("the whiteboard is on by default and only the admin path can switch it off", async () => {
  assert.equal((await meetingService.getOptions({ meetingId, userId: HOST })).allowWhiteboard, true);

  // A host's options PATCH must NOT be able to touch it — otherwise a host could
  // re-enable a board an administrator shut down.
  const clean = policy.normalizePatch({ allowWhiteboard: false, allowChat: false });
  assert.equal("allowWhiteboard" in clean, false, "normalizePatch drops allowWhiteboard");

  // The admin route writes through db.meetings.setOptions directly.
  await db.meetings.setOptions(meetingId, { allowWhiteboard: false });
  assert.equal((await meetingService.getOptions({ meetingId, userId: HOST })).allowWhiteboard, false);

  await db.meetings.setOptions(meetingId, { allowWhiteboard: true });
  assert.equal((await meetingService.getOptions({ meetingId, userId: HOST })).allowWhiteboard, true);
});
