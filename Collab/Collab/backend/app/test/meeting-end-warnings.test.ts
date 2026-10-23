import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// MEETING END WARNINGS (0123): "ends in 10 minutes", then "…in 5".
//
// The timing arithmetic is the whole feature, so it is tested directly rather
// than only through the worker: whether a lead is due is a pure function of
// (occurrence start, duration, now), and that is where an off-by-one lands
// someone a warning after their meeting ended.

let dbUp = false;
let db: any;
let svc: any;

const HOST = "u_endwarn_host";
const GUEST = "u_endwarn_guest";

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
    svc = await import("../src/services/meetingEndWarningService");
    for (const [id, name] of [
      [HOST, "End Host"],
      [GUEST, "End Guest"],
    ] as const) {
      await db.users.upsert({
        id, email: id + "@ex.com", name, initials: "EW",
        color: "#2563EB", presence: "off", passwordHash: null,
      });
    }
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

// ── The arithmetic (no database needed) ─────────────────────────────────────

const MIN = 60000;

test("a lead is due exactly once its instant arrives, not before", async () => {
  const { dueLeads } = await import("../src/services/meetingEndWarningService");
  const start = Date.parse("2026-01-01T10:00:00Z");
  const dur = 60; // ends 11:00
  const at = (iso: string) => Date.parse(iso);

  assert.deepEqual(dueLeads(start, dur, at("2026-01-01T10:30:00Z")), [], "mid-meeting: nothing due");
  assert.deepEqual(dueLeads(start, dur, at("2026-01-01T10:49:59Z")), [], "a second early: nothing");
  assert.deepEqual(dueLeads(start, dur, at("2026-01-01T10:50:00Z")), [10], "10 minutes before the end");
  assert.deepEqual(dueLeads(start, dur, at("2026-01-01T10:55:00Z")), [5], "5 minutes before the end");
  assert.deepEqual(dueLeads(start, dur, at("2026-01-01T11:00:00Z")), [], "at the end: too late");
});

test("a warning that has been missed for too long is dropped, not sent late", async () => {
  const { dueLeads } = await import("../src/services/meetingEndWarningService");
  const start = Date.parse("2026-01-01T10:00:00Z");
  // Grace is one tick (90s): a worker that blinked still emits, one that was
  // down for minutes does not — "ends in 10 minutes" after it ended is worse
  // than silence.
  assert.deepEqual(dueLeads(start, 60, start + 50 * MIN + 60000), [10], "60s late still fires");
  assert.deepEqual(dueLeads(start, 60, start + 50 * MIN + 120000), [], "2 minutes late does not");
});

test("a lead longer than the meeting is skipped, never fired at the start", async () => {
  const { dueLeads } = await import("../src/services/meetingEndWarningService");
  const start = Date.parse("2026-01-01T10:00:00Z");
  // A 10-minute meeting: the 10-minute warning would land exactly at the start.
  assert.deepEqual(dueLeads(start, 10, start), [], "no warning at the moment it begins");
  // …but the 5-minute one is still meaningful.
  assert.deepEqual(dueLeads(start, 10, start + 5 * MIN), [5]);
  // A 5-minute meeting warrants neither.
  assert.deepEqual(dueLeads(start, 5, start), []);
  assert.deepEqual(dueLeads(start, 5, start + 1), []);
});

test("both leads fire for a normal meeting, largest first", async () => {
  const { dueLeads } = await import("../src/services/meetingEndWarningService");
  const start = Date.parse("2026-01-01T10:00:00Z");
  // A tick that has fallen behind and catches both at once must order them 10
  // then 5, or the room reads "5 minutes left" followed by "10 minutes left".
  assert.deepEqual(dueLeads(start, 12, start + 2 * MIN, [10, 5]), [10]);
  const both = dueLeads(start, 11, start + 6 * MIN, [10, 5]);
  assert.deepEqual([...both].sort((a, b) => b - a), both, "descending");
});

test("the running occurrence is resolved for a one-off meeting", async () => {
  const { currentOccurrenceStart } = await import("../src/services/meetingEndWarningService");
  const startIso = "2026-01-01T10:00:00.000Z";
  const m = { startsAt: startIso, durationMin: 30, recurrence: "none" };
  const at = (iso: string) => Date.parse(iso);
  assert.equal(currentOccurrenceStart(m, at("2026-01-01T09:59:00Z")), null, "before it starts");
  assert.equal(currentOccurrenceStart(m, at("2026-01-01T10:15:00Z")), startIso, "while running");
  assert.equal(currentOccurrenceStart(m, at("2026-01-01T12:00:00Z")), null, "long after");
});

// ── Exactly-once, against the real ledger ───────────────────────────────────

dbTest("each (occurrence, lead) can only be claimed once", async () => {
  const mt = await db.meetings.create({
    title: "End warning test",
    startsAt: new Date(Date.now() + 60000).toISOString().slice(0, 19).replace("T", " "),
    durationMin: 60,
    createdBy: HOST,
    attendees: [GUEST],
  });
  const occ = "2026-01-01 10:00:00";
  assert.equal(await db.meetings.claimEndWarning(mt.id, occ, 10), true, "first claim wins");
  assert.equal(await db.meetings.claimEndWarning(mt.id, occ, 10), false, "a repeat tick is a no-op");
  // The 5-minute warning is a SEPARATE claim for the same occurrence — this is
  // why minutes_before is part of the key.
  assert.equal(await db.meetings.claimEndWarning(mt.id, occ, 5), true);
  assert.equal(await db.meetings.claimEndWarning(mt.id, occ, 5), false);
  // A different occurrence of the same series claims independently.
  assert.equal(await db.meetings.claimEndWarning(mt.id, "2026-01-02 10:00:00", 10), true);
});

dbTest("only meetings with someone actually in the room are scanned", async () => {
  // liveMeetings() is a PRESENCE scan — it deliberately does no time filtering
  // (that is currentOccurrenceStart's job), so this needs no past-dated meeting,
  // which the schema's future-start trigger would refuse anyway.
  const mt = await db.meetings.create({
    title: "Live scan test",
    startsAt: new Date(Date.now() + 5 * 60000).toISOString().slice(0, 19).replace("T", " "),
    durationMin: 60,
    createdBy: HOST,
    attendees: [GUEST],
  });
  let live = await db.meetings.liveMeetings();
  assert.equal(
    live.find((m: any) => m.id === mt.id),
    undefined,
    "nobody has joined, so it is not a candidate",
  );
  await db.meetings.enterRoom(mt.id, HOST);
  live = await db.meetings.liveMeetings();
  assert.ok(live.find((m: any) => m.id === mt.id), "with someone present it is scanned");
  await db.meetings.leaveRoom(mt.id, HOST);
  live = await db.meetings.liveMeetings();
  assert.equal(
    live.find((m: any) => m.id === mt.id),
    undefined,
    "once the room empties it drops out again",
  );
});

dbTest("a cancelled meeting is never warned about", async () => {
  const mt = await db.meetings.create({
    title: "Cancelled",
    startsAt: new Date(Date.now() + 5 * 60000).toISOString().slice(0, 19).replace("T", " "),
    durationMin: 60,
    createdBy: HOST,
    attendees: [],
  });
  await db.meetings.enterRoom(mt.id, HOST);
  assert.ok((await db.meetings.liveMeetings()).find((m: any) => m.id === mt.id));
  await db.pool.query("UPDATE meetings SET status='cancelled' WHERE id=?", [mt.id]);
  assert.equal(
    (await db.meetings.liveMeetings()).find((m: any) => m.id === mt.id),
    undefined,
  );
});
