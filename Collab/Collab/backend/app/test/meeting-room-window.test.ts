import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// ROOM ENTRY FOR RECURRING MEETINGS.
//
// The series anchor row stores the FIRST occurrence's startsAt and whatever
// status the LAST session left behind. enterRoom used to judge "expired"
// against that anchor, so once a host had ended any earlier occurrence, every
// later occurrence read as completed + expired and anyone arriving before the
// host (empty room) was refused with "This meeting has ended". People who
// clicked after the host was inside got in — so only SOME attendees failed to
// join. These pin the occurrence-aware window and the entry decision on it.

let dbUp = false;
let db: any;
let meetingService: any;

const HOST = "u_roomwin_host";
const GUEST = "u_roomwin_guest";

const sql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const DAY = 86400000;

before(async () => {
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  try {
    // Inside the try so the pure sessionWindow cases still run on a machine
    // with no test database; only the store-backed cases skip.
    await useTestDatabase();
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    await migrate(platform.config.database.url);
    meetingService = await import("../src/services/meetingService");
    for (const [id, name] of [
      [HOST, "Window Host"],
      [GUEST, "Window Guest"],
    ] as const) {
      await db.users.upsert({
        id, email: id + "@ex.com", name, initials: "WT",
        color: "#2563EB", presence: "off", passwordHash: null,
      });
    }
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — DB cases will skip:", e.message);
  }
});

after(async () => {
  try { await db?.close?.(); } catch {}
});

const dbTest = (name: string, fn: () => Promise<void>) =>
  test(name, async (t) => {
    if (!dbUp) return t.skip("MySQL unavailable");
    await fn();
  });

// ── sessionWindow (pure) ────────────────────────────────────────────────────

test("a one-off's window is its own slot", async () => {
  const { sessionWindow } = await import("../src/services/meetingService");
  const start = Date.parse("2026-01-01T10:00:00.000Z");
  const m = { startsAt: "2026-01-01T10:00:00.000Z", durationMin: 30, recurrence: "none" };
  assert.deepEqual(sessionWindow(m, start + 5 * 60000), { start, end: start + 30 * 60000 });
  // Long after: still the same (only) window — the caller decides it expired.
  assert.deepEqual(sessionWindow(m, start + 5 * DAY), { start, end: start + 30 * 60000 });
});

test("a weekly series resolves the occurrence running now, else the next one", async () => {
  const { sessionWindow } = await import("../src/services/meetingService");
  const anchor = Date.parse("2026-01-01T10:00:00.000Z");
  const m = { startsAt: "2026-01-01T10:00:00.000Z", durationMin: 30, recurrence: "weekly" };
  // Three weeks in, ten minutes into that occurrence → that occurrence.
  const w3 = anchor + 3 * 7 * DAY;
  assert.deepEqual(sessionWindow(m, w3 + 10 * 60000), { start: w3, end: w3 + 30 * 60000 });
  // Two days before week 4 → week 4 is what the room is for, not week 3.
  const w4 = anchor + 4 * 7 * DAY;
  assert.deepEqual(sessionWindow(m, w4 - 2 * DAY), { start: w4, end: w4 + 30 * 60000 });
});

test("a bounded series that has run out has no window", async () => {
  const { sessionWindow } = await import("../src/services/meetingService");
  const anchor = Date.parse("2026-01-01T10:00:00.000Z");
  const m = {
    startsAt: "2026-01-01T10:00:00.000Z",
    durationMin: 30,
    recurrenceRule: { freq: "weekly", interval: 1, end: { type: "after", count: 2 } },
  };
  assert.equal(sessionWindow(m, anchor + 5 * 7 * DAY), null);
});

// ── enterRoom, against the real store ──────────────────────────────────────

dbTest("an invited attendee can enter next week's occurrence after the host ended last week's", async () => {
  // Weekly series anchored a week ago; the occurrence the room is for now
  // starts in ten minutes. The host ended last week's session, which leaves
  // status='completed' on the anchor — exactly the state that used to refuse
  // everyone who arrived before the host.
  const mt = await db.meetings.create({
    title: "Weekly stand-up",
    startsAt: sql(Date.now() - 7 * DAY + 10 * 60000),
    durationMin: 30,
    recurrence: "weekly",
    createdBy: HOST,
    attendees: [GUEST],
  });
  await db.meetings.setStatus(mt.id, "completed");
  const r = await meetingService.enterRoom({ meetingId: mt.id, userId: GUEST });
  assert.ok(r, "entry answered");
  assert.notEqual((r as any).closed, true, "must not be told the meeting has ended");
  assert.ok((r as any).meeting, "gets the room");
});

dbTest("a host-ended meeting stays joinable until its scheduled time is exceeded", async () => {
  // Started five minutes ago, runs for thirty. The host pressed "End for
  // everyone" — the link must keep working for the rest of the window.
  const mt = await db.meetings.create({
    title: "Ended early",
    startsAt: sql(Date.now() - 5 * 60000),
    durationMin: 30,
    createdBy: HOST,
    attendees: [GUEST],
  });
  await meetingService.complete({ meetingId: mt.id, userId: HOST });
  const r = await meetingService.enterRoom({ meetingId: mt.id, userId: GUEST });
  assert.notEqual((r as any).closed, true, "link must not be disabled inside the window");
  assert.ok((r as any).meeting, "gets the room");
});

dbTest("a host-ended meeting past its window is closed, host included", async () => {
  const mt = await db.meetings.create({
    title: "Ended, long over",
    startsAt: sql(Date.now() - 2 * DAY),
    durationMin: 30,
    createdBy: HOST,
    attendees: [GUEST],
  });
  await meetingService.complete({ meetingId: mt.id, userId: HOST });
  const r = await meetingService.enterRoom({ meetingId: mt.id, userId: HOST });
  assert.equal((r as any).closed, true, "the link expired with the window");
});

dbTest("a one-off that was completed and is past its window stays closed to an empty room", async () => {
  const mt = await db.meetings.create({
    title: "One-off, long over",
    startsAt: sql(Date.now() - 2 * DAY),
    durationMin: 30,
    createdBy: HOST,
    attendees: [GUEST],
  });
  await db.meetings.setStatus(mt.id, "completed");
  const r = await meetingService.enterRoom({ meetingId: mt.id, userId: GUEST });
  assert.equal((r as any).closed, true, "the room really is over");
});
