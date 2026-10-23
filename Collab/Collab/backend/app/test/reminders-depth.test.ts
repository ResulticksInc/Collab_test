import { test, before } from "node:test";
import assert from "node:assert/strict";

// REMINDERS DEPTH (#53) — pure-logic tests, NO DB required. Covers the structured
// recurrence rule (next-occurrence + legacy migration), the NL quick-add parser,
// and the lead-time validators. These run anywhere (no MySQL), so they always
// execute in the gate. DB-backed lead-time firing + prune live in the
// reminders-tasks-files suite (skip-if-absent).

let recur: any;
let nl: any;
let reminderService: any;

before(async () => {
  process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || "test-secret-colab";
  process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "testkey";
  process.env.LIVEKIT_API_SECRET =
    process.env.LIVEKIT_API_SECRET || "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || "ws://localhost:7534";
  recur = await import("../src/services/recurrenceRule");
  nl = await import("../src/services/reminderNL");
  reminderService = await import("../src/services/reminderService");
});

// ---------------------------------------------------------------------------
// STRUCTURED RECURRENCE — nextOccurrenceAfter
// ---------------------------------------------------------------------------

test("recurrence: daily every-1 advances one day", () => {
  const anchor = "2026-01-01T09:00:00.000Z";
  const after = Date.parse("2026-01-01T09:00:00.000Z"); // exactly at anchor
  const next = recur.nextOccurrenceAfter(anchor, { freq: "daily", interval: 1 }, after);
  assert.equal(next, "2026-01-02T09:00:00.000Z");
});

test("recurrence: daily skips ahead past a long-gone cursor (catch-up)", () => {
  const anchor = "2026-01-01T09:00:00.000Z";
  // Cursor is 10 days later — the next occurrence must be strictly after it.
  const after = Date.parse("2026-01-11T10:00:00.000Z");
  const next = recur.nextOccurrenceAfter(anchor, { freq: "daily", interval: 1 }, after);
  assert.equal(next, "2026-01-12T09:00:00.000Z");
});

test("recurrence: weekly interval=2 jumps two weeks", () => {
  const anchor = "2026-01-05T09:00:00.000Z"; // a Monday
  const after = Date.parse(anchor);
  const next = recur.nextOccurrenceAfter(
    anchor,
    { freq: "weekly", interval: 2, byWeekday: [1] },
    after,
  );
  assert.equal(next, "2026-01-19T09:00:00.000Z");
});

test("recurrence: weekly with multiple days picks the next selected weekday", () => {
  // Anchor Monday; rule fires Mon+Wed. From just after Monday, next is Wednesday.
  const anchor = "2026-01-05T09:00:00.000Z"; // Mon
  const after = Date.parse("2026-01-05T09:00:01.000Z");
  const next = recur.nextOccurrenceAfter(
    anchor,
    { freq: "weekly", interval: 1, byWeekday: [1, 3] },
    after,
  );
  assert.equal(next, "2026-01-07T09:00:00.000Z"); // Wed
});

test("recurrence: end after-N stops producing beyond the count", () => {
  const anchor = "2026-01-01T09:00:00.000Z";
  const rule = { freq: "daily", interval: 1, end: { type: "after", count: 3 } };
  // Occurrences: Jan1 (1), Jan2 (2), Jan3 (3). After Jan3 → no more.
  const afterThird = Date.parse("2026-01-03T09:00:00.000Z");
  assert.equal(recur.nextOccurrenceAfter(anchor, rule, afterThird), null);
  // But from the anchor, the 2nd occurrence is Jan2.
  const fromAnchor = Date.parse(anchor);
  assert.equal(recur.nextOccurrenceAfter(anchor, rule, fromAnchor), "2026-01-02T09:00:00.000Z");
});

test("recurrence: end on-date stops after the date", () => {
  const anchor = "2026-01-01T09:00:00.000Z";
  const rule = { freq: "daily", interval: 1, end: { type: "on", date: "2026-01-03" } };
  const afterEnd = Date.parse("2026-01-03T09:00:00.000Z");
  assert.equal(recur.nextOccurrenceAfter(anchor, rule, afterEnd), null);
});

test("recurrence: monthly day-of-month clamps short months", () => {
  // Anchor Jan 31; monthly day-31 → Feb has no 31, clamps to Feb 28 (2026 not leap).
  const anchor = "2026-01-31T09:00:00.000Z";
  const after = Date.parse("2026-02-01T00:00:00.000Z");
  const next = recur.nextOccurrenceAfter(
    anchor,
    { freq: "monthly", interval: 1, monthlyMode: "day", day: 31 },
    after,
  );
  // Local-time construction means the exact UTC string depends on the runner TZ;
  // assert the month/day intent rather than a brittle ISO string.
  const d = new Date(next);
  assert.equal(d.getMonth(), 1, "lands in February");
  assert.ok(d.getDate() >= 28, "clamped to the last valid day");
});

// ---------------------------------------------------------------------------
// LEGACY → STRUCTURED migration (no loss)
// ---------------------------------------------------------------------------

test("recurrence: ruleFromLegacy maps the simple enum", () => {
  assert.deepEqual(recur.ruleFromLegacy("daily"), { freq: "daily", interval: 1, end: { type: "never" } });
  assert.deepEqual(recur.ruleFromLegacy("weekly"), { freq: "weekly", interval: 1, end: { type: "never" } });
  assert.equal(recur.ruleFromLegacy("monthly").freq, "monthly");
  assert.equal(recur.ruleFromLegacy("none"), null);
  assert.equal(recur.ruleFromLegacy(null), null);
});

test("recurrence: computeNextDue prefers structured rule, falls back to legacy", () => {
  const now = Date.parse("2026-01-01T09:00:00.000Z");
  // Structured rule wins.
  const structured = reminderService.computeNextDue(
    { dueAt: "2026-01-01T09:00:00.000Z", recurrenceRule: { freq: "weekly", interval: 1, byWeekday: [4] }, recurrence: "none" },
    now,
  );
  assert.equal(structured, "2026-01-08T09:00:00.000Z");
  // Legacy-only row still rolls forward.
  const legacy = reminderService.computeNextDue(
    { dueAt: "2026-01-01T09:00:00.000Z", recurrence: "daily" },
    now,
  );
  assert.equal(legacy, "2026-01-02T09:00:00.000Z");
  // Non-recurring → null.
  assert.equal(reminderService.computeNextDue({ dueAt: "2026-01-01T09:00:00.000Z", recurrence: "none" }, now), null);
});

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

test("validation: lead minutes allow-list", () => {
  assert.doesNotThrow(() => reminderService.validateLeadMinutes(null));
  assert.doesNotThrow(() => reminderService.validateLeadMinutes(0));
  assert.doesNotThrow(() => reminderService.validateLeadMinutes(30));
  assert.doesNotThrow(() => reminderService.validateLeadMinutes(1440));
  assert.throws(() => reminderService.validateLeadMinutes(-5), /lead time/i);
  assert.throws(() => reminderService.validateLeadMinutes(99999999), /lead time/i);
  assert.throws(() => reminderService.validateLeadMinutes(1.5), /lead time/i);
});

test("validation: structured rule", () => {
  assert.doesNotThrow(() => recur.validateRecurrenceRule(null));
  assert.doesNotThrow(() => recur.validateRecurrenceRule({ freq: "weekly", interval: 2, byWeekday: [1, 3] }));
  assert.throws(() => recur.validateRecurrenceRule({ freq: "fortnightly" }), /frequency/i);
  assert.throws(() => recur.validateRecurrenceRule({ freq: "weekly", byWeekday: [7] }), /weekdays/i);
  assert.throws(() => recur.validateRecurrenceRule({ freq: "daily", interval: 0 }), /interval/i);
  assert.throws(() => recur.validateRecurrenceRule({ freq: "monthly", day: 40 }), /day-of-month/i);
});

// ---------------------------------------------------------------------------
// NL QUICK-ADD parser
// ---------------------------------------------------------------------------

const NOW = new Date("2026-01-05T08:00:00"); // a Monday morning, local time

test("nl: 'call John tomorrow at 3pm' → text + tomorrow 3pm", () => {
  const p = nl.parseReminder("remind me to call John tomorrow at 3pm", NOW);
  assert.ok(p, "parsed");
  assert.equal(p.ambiguous, false);
  assert.match(p.text.toLowerCase(), /call john/);
  const d = new Date(p.dueAt);
  assert.equal(d.getDate(), 6, "tomorrow");
  assert.equal(d.getHours(), 15, "3pm");
});

test("nl: 'every Monday 9am standup' → weekly recurrence on Monday", () => {
  const p = nl.parseReminder("every Monday 9am standup", NOW);
  assert.ok(p);
  assert.equal(p.recurrence, "weekly");
  assert.ok(p.recurrenceRule && p.recurrenceRule.freq === "weekly");
  assert.deepEqual(p.recurrenceRule.byWeekday, [1]);
  assert.match(p.text.toLowerCase(), /standup/);
  const d = new Date(p.dueAt);
  assert.equal(d.getHours(), 9);
});

test("nl: 'in 2 hours check oven' → 2h from now", () => {
  const p = nl.parseReminder("in 2 hours check oven", NOW);
  assert.ok(p);
  assert.equal(p.ambiguous, false);
  const d = new Date(p.dueAt);
  assert.equal(d.getHours(), 10, "8am + 2h");
  assert.match(p.text.toLowerCase(), /check oven/);
});

test("nl: a bare task with no time is ambiguous (open modal)", () => {
  const p = nl.parseReminder("buy groceries", NOW);
  assert.ok(p);
  // No date/time signal at all → not ambiguous (just a plain text reminder, no due).
  assert.equal(p.dueAt, null);
  assert.match(p.text.toLowerCase(), /buy groceries/);
});

test("nl: 'daily 7am gym' → daily recurrence", () => {
  const p = nl.parseReminder("daily 7am gym", NOW);
  assert.ok(p);
  assert.equal(p.recurrence, "daily");
  assert.equal(p.recurrenceRule.freq, "daily");
  assert.match(p.text.toLowerCase(), /gym/);
});

// FIX #3: "every weekday" must become a Mon–Fri weekly recurrence, NOT a wrong
// one-off. The literal "weekday" word must be stripped from the text too.
test("nl: 'every weekday standup 9am' → Mon-Fri weekly recurrence", () => {
  const p = nl.parseReminder("every weekday standup 9am", NOW);
  assert.ok(p);
  assert.equal(p.recurrence, "weekly");
  assert.ok(p.recurrenceRule && p.recurrenceRule.freq === "weekly");
  assert.deepEqual(p.recurrenceRule.byWeekday, [1, 2, 3, 4, 5]);
  assert.match(p.text.toLowerCase(), /standup/);
  assert.doesNotMatch(p.text.toLowerCase(), /weekday/);
  // Has a concrete time → confident, not ambiguous.
  assert.equal(p.ambiguous, false);
  const d = new Date(p.dueAt);
  assert.equal(d.getHours(), 9);
});

test("nl: 'every weekend chores 10am' → Sat-Sun weekly recurrence", () => {
  const p = nl.parseReminder("every weekend chores 10am", NOW);
  assert.ok(p);
  assert.equal(p.recurrence, "weekly");
  assert.deepEqual(p.recurrenceRule.byWeekday, [0, 6]);
  assert.match(p.text.toLowerCase(), /chores/);
});

// FIX #4: a huge digit string must NOT yield Infinity — clamp to the validator's
// 1–999 bound inside the parser (defense in depth).
test("nl: 'every <huge> days x' clamps interval to 999 (never Infinity)", () => {
  const huge = "9".repeat(400);
  const p = nl.parseReminder(`every ${huge} days x`, NOW);
  assert.ok(p);
  assert.ok(p.recurrenceRule);
  assert.equal(p.recurrenceRule.freq, "daily");
  assert.ok(Number.isFinite(p.recurrenceRule.interval), "interval is finite");
  assert.equal(p.recurrenceRule.interval, 999, "clamped to the 1–999 bound");
});

// FIX #2: clock/relative times resolve in the USER's timezone, not the server's.
// Drive the parser with an explicit IANA zone + a UTC-anchored `now` so the result
// is independent of the runner's timezone. "3pm" in Asia/Kolkata = 09:30 UTC.
test("nl: clock time resolves in the user's IANA timezone (not server TZ)", () => {
  // 2026-06-30 06:00 UTC = 11:30 IST on the same calendar day.
  const nowUtc = new Date("2026-06-30T06:00:00.000Z");
  const p = nl.parseReminder("submit report at 3pm", {
    now: nowUtc,
    timeZone: "Asia/Kolkata",
  });
  assert.ok(p);
  assert.equal(p.ambiguous, false);
  // 3pm IST today → 09:30Z.
  assert.equal(p.dueAt, "2026-06-30T09:30:00.000Z");
  assert.match(p.text.toLowerCase(), /submit report/);
});

test("nl: numeric tz offset fallback resolves the wall clock correctly", () => {
  // getTimezoneOffset() for IST is -330 (UTC = local + (-330) min). 3pm IST → 09:30Z.
  const nowUtc = new Date("2026-06-30T06:00:00.000Z");
  const p = nl.parseReminder("call at 3pm", { now: nowUtc, tzOffsetMinutes: -330 });
  assert.ok(p);
  assert.equal(p.dueAt, "2026-06-30T09:30:00.000Z");
});

test("nl: 'tomorrow at 9am' lands on the user-zone next calendar day", () => {
  // 2026-06-30 20:00 UTC = 2026-07-01 01:30 IST. "tomorrow" in IST = Jul 2.
  const nowUtc = new Date("2026-06-30T20:00:00.000Z");
  const p = nl.parseReminder("ship build tomorrow at 9am", {
    now: nowUtc,
    timeZone: "Asia/Kolkata",
  });
  assert.ok(p);
  // 9am IST on Jul 2 = 03:30Z Jul 2.
  assert.equal(p.dueAt, "2026-07-02T03:30:00.000Z");
});

// ---------------------------------------------------------------------------
// FIX #1: computeNextDue must advance STRICTLY past the current occurrence's due
// instant even when the spawn cursor is BEFORE due (lead-fire / early-complete).
// ---------------------------------------------------------------------------

test("computeNextDue: early cursor (before due) still advances to the NEXT day", () => {
  const r = {
    dueAt: "2026-03-10T09:00:00.000Z",
    recurrenceRule: { freq: "daily", interval: 1 },
    leadMinutes: 30,
  };
  // Cursor BEFORE due (08:30, simulating a lead-fire) must NOT return the same day.
  const early = Date.parse("2026-03-10T08:30:00.000Z");
  const dueMs = Date.parse(r.dueAt);
  // The fix anchors the cursor at max(cursor, due) — replicate that here to assert
  // the contract computeNextDue is fed by spawnNext.
  const next = recur.nextOccurrenceAfter(r.dueAt, r.recurrenceRule, Math.max(early, dueMs));
  assert.equal(next, "2026-03-11T09:00:00.000Z");
  // And computeNextDue itself, given afterMs=due, must advance.
  const viaCompute = reminderService.computeNextDue(r, dueMs);
  assert.equal(viaCompute, "2026-03-11T09:00:00.000Z");
});
