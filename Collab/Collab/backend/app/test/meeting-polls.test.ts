import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// MEETING POLLS (0121).
//
// The cases worth pinning are the ones where a poll stops being trustworthy:
// someone voting twice, a closed poll still accepting answers, an anonymous
// poll leaking who said what, and a plain attendee being able to start or close
// one. Percentages get a test too, because a multi-choice poll is exactly where
// naive percentage code goes wrong.

let dbUp = false;
let db: any;
let shared: any;
let polls: any;

const HOST = "u_polltest_host";
const A = "u_polltest_a";
const B = "u_polltest_b";
const OUTSIDER = "u_polltest_x";
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
    polls = await import("../src/services/meetingPollService");

    for (const [id, name] of [
      [HOST, "Poll Host"],
      [A, "Poll A"],
      [B, "Poll B"],
      [OUTSIDER, "Poll Outsider"],
    ] as const) {
      await db.users.upsert({
        id, email: id + "@ex.com", name, initials: "PT",
        color: "#2563EB", presence: "off", passwordHash: null,
      });
    }
    const mt = await db.meetings.create({
      title: "Polls test",
      startsAt: new Date(Date.now() + 5 * 60000).toISOString().slice(0, 19).replace("T", " "),
      durationMin: 60,
      createdBy: HOST,
      attendees: [A, B],
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

const mk = (over: any = {}) =>
  polls.create({
    meetingId,
    userId: HOST,
    question: "Ship on Friday?",
    options: ["Yes", "No", "Needs another week"],
    ...over,
  });

// ── Creation rules ──────────────────────────────────────────────────────────

dbTest("a host creates a poll; it opens with no votes and is anonymous by default", async () => {
  const p = await mk();
  assert.equal(p.status, "open");
  assert.equal(p.anonymous, true, "anonymous unless the host asks otherwise");
  assert.equal(p.multiChoice, false);
  assert.equal(p.voterCount, 0);
  assert.deepEqual(p.options.map((o: any) => o.label), ["Yes", "No", "Needs another week"]);
  assert.deepEqual(p.options.map((o: any) => o.votes), [0, 0, 0]);
});

dbTest("a plain attendee cannot start a poll", async () => {
  await assert.rejects(
    () => mk({ userId: A }),
    (e: any) => e.status === 403,
  );
});

dbTest("someone outside the meeting cannot even list polls", async () => {
  await assert.rejects(
    () => polls.list({ meetingId, userId: OUTSIDER }),
    (e: any) => e.status === 403,
  );
});

dbTest("a malformed poll is refused with a reason", async () => {
  for (const [over, why] of [
    [{ question: "   " }, "empty question"],
    [{ options: ["Only one"] }, "too few options"],
    [{ options: Array.from({ length: 11 }, (_, i) => "opt" + i) }, "too many options"],
    [{ options: ["Yes", "yes"] }, "duplicate options"],
    [{ options: ["Yes", ""] }, "blank option is dropped, leaving too few"],
  ] as const) {
    await assert.rejects(
      () => mk(over),
      (e: any) => e.status === 400,
      why,
    );
  }
});

// ── Voting integrity ────────────────────────────────────────────────────────

dbTest("one person, one answer — voting again replaces it", async () => {
  const p = await mk();
  await polls.vote({ pollId: p.id, userId: A, optionIndexes: [0] });
  let after = await polls.vote({ pollId: p.id, userId: A, optionIndexes: [1] });
  assert.equal(after.voterCount, 1, "changing your mind is not a second vote");
  assert.deepEqual(after.options.map((o: any) => o.votes), [0, 1, 0]);
  assert.deepEqual(after.myVote, [1]);
});

dbTest("a single-choice poll refuses two answers at once", async () => {
  const p = await mk();
  await assert.rejects(
    () => polls.vote({ pollId: p.id, userId: A, optionIndexes: [0, 1] }),
    (e: any) => e.status === 400,
  );
});

dbTest("a multi-choice poll accepts several, and counts voters not votes", async () => {
  const p = await mk({ multiChoice: true });
  await polls.vote({ pollId: p.id, userId: A, optionIndexes: [0, 2] });
  const after = await polls.vote({ pollId: p.id, userId: B, optionIndexes: [0] });
  assert.equal(after.voterCount, 2, "two people answered, three votes cast");
  assert.deepEqual(after.options.map((o: any) => o.votes), [2, 0, 1]);
  // Percentages are of VOTES CAST, so a multi-choice poll still sums to 100.
  assert.equal(
    after.options.reduce((s: number, o: any) => s + o.percent, 0),
    100,
  );
});

dbTest("an option that doesn't exist is refused", async () => {
  const p = await mk();
  for (const idx of [-1, 3, 99]) {
    await assert.rejects(
      () => polls.vote({ pollId: p.id, userId: A, optionIndexes: [idx] }),
      (e: any) => e.status === 400,
      `option ${idx}`,
    );
  }
});

// ── Closing ─────────────────────────────────────────────────────────────────

dbTest("a closed poll stops accepting answers", async () => {
  const p = await mk();
  await polls.vote({ pollId: p.id, userId: A, optionIndexes: [0] });
  const closed = await polls.close({ pollId: p.id, userId: HOST });
  assert.equal(closed.status, "closed");
  assert.ok(closed.closedAt, "closing stamps a time");
  await assert.rejects(
    () => polls.vote({ pollId: p.id, userId: B, optionIndexes: [1] }),
    (e: any) => e.status === 409,
    "a late voter is told the poll is closed, not silently dropped",
  );
  // The result survives closing.
  assert.deepEqual(closed.options.map((o: any) => o.votes), [1, 0, 0]);
});

dbTest("a plain attendee cannot close or delete a poll", async () => {
  const p = await mk();
  await assert.rejects(() => polls.close({ pollId: p.id, userId: A }), (e: any) => e.status === 403);
  await assert.rejects(() => polls.remove({ pollId: p.id, userId: A }), (e: any) => e.status === 403);
});

dbTest("a co-host can run polls", async () => {
  await db.meetings.setAttendeeRole(meetingId, B, "co-host");
  const p = await polls.create({
    meetingId, userId: B, question: "Co-host poll?", options: ["Yes", "No"],
  });
  const closed = await polls.close({ pollId: p.id, userId: B });
  assert.equal(closed.status, "closed");
  await db.meetings.setAttendeeRole(meetingId, B, "participant");
});

// ── Anonymity ───────────────────────────────────────────────────────────────

dbTest("an anonymous poll never reveals who voted, even to the host", async () => {
  const p = await mk({ anonymous: true });
  await polls.vote({ pollId: p.id, userId: A, optionIndexes: [0] });
  await assert.rejects(
    () => polls.voters({ pollId: p.id, userId: HOST }),
    (e: any) => e.status === 409 && e.code === "POLL_ANONYMOUS",
    "refused outright rather than filtered — no path can leak it",
  );
});

dbTest("a named poll reveals who voted, to the host only", async () => {
  const p = await mk({ anonymous: false });
  await polls.vote({ pollId: p.id, userId: A, optionIndexes: [1] });
  const rows = await polls.voters({ pollId: p.id, userId: HOST });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, A);
  assert.equal(rows[0].option, "No", "the label, not just the index");
  await assert.rejects(
    () => polls.voters({ pollId: p.id, userId: A }),
    (e: any) => e.status === 403,
    "an attendee cannot see the roll call",
  );
});

// ── Listing ─────────────────────────────────────────────────────────────────

dbTest("each person sees their own answer and nobody else's", async () => {
  const p = await mk();
  await polls.vote({ pollId: p.id, userId: A, optionIndexes: [2] });
  const asA = (await polls.list({ meetingId, userId: A })).find((x: any) => x.id === p.id);
  const asB = (await polls.list({ meetingId, userId: B })).find((x: any) => x.id === p.id);
  assert.deepEqual(asA.myVote, [2]);
  assert.deepEqual(asB.myVote, [], "B has not voted, and cannot see that A did");
  assert.equal(asB.voterCount, 1, "though the tally is public, as it must be");
  assert.equal(asA.canManage, false);
});

dbTest("a deleted poll disappears from the list", async () => {
  const p = await mk();
  await polls.remove({ pollId: p.id, userId: HOST });
  const list = await polls.list({ meetingId, userId: HOST });
  assert.equal(list.find((x: any) => x.id === p.id), undefined);
});
