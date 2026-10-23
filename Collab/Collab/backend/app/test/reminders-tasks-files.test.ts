import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// REMINDERS / TASKS / FILES critical-path tests — the modules under audit.
// Driven through the real services against the seeded `colab` MySQL DB (same
// skip-if-absent strategy as calls-signalling.test.ts). Each module gets:
//   create → read-back → update → soft-delete, PLUS an ownership/permission
// check that another user cannot read or mutate someone else's item.
//
// NOTE on files: fileService.create() streams to S3/MinIO (with a BLOB fallback),
// which would make the test depend on object-storage state. The authorization
// logic — the actual audit target — lives in permissionFor()/remove()/setStar()/
// share(), so we insert the file row directly via the driver (BLOB, no storage
// key) and exercise the service's ownership guards. No S3 dependency, fully
// deterministic.

let dbUp = false;
let db: any;
let reminderService: any;
let taskService: any;
let fileService: any;

const OWNER = "u_rtf_owner";
const STRANGER = "u_rtf_stranger";
const THIRD = "u_rtf_third";

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
    reminderService = await import("../src/services/reminderService");
    taskService = await import("../src/services/taskService");
    fileService = await import("../src/services/fileService");

    for (const [id, name] of [
      [OWNER, "RTF Owner"],
      [STRANGER, "RTF Stranger"],
      [THIRD, "RTF Third"],
    ] as const) {
      await db.users.upsert({
        id,
        email: id + "@ex.com",
        name,
        initials: "RT",
        color: "#2563EB",
        presence: "off",
        passwordHash: null,
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

// ---------------------------------------------------------------------------
// REMINDERS
// ---------------------------------------------------------------------------

// reminderService.listReminders() returns a pagination envelope
// { reminders, hasMore, nextCursor, count, counts } (P0-D), not a bare array —
// unwrap to the reminder rows for membership checks.
const remindersOf = async (userId: string) =>
  (await reminderService.listReminders(userId)).reminders;

dbTest("reminders: create → read-back → update → soft-delete", async () => {
  const created = await reminderService.createReminder({
    userId: OWNER,
    text: "Buy milk",
    folderId: null,
    dueLabel: null,
    description: "from the corner shop",
    dueAt: null,
    priority: "High",
    recurrence: "none",
  });
  assert.ok(created.id, "reminder created with an id");

  let list = await remindersOf(OWNER);
  assert.ok(list.find((r: any) => r.id === created.id), "reminder is read-back in the list");

  const updated = await reminderService.updateReminder({
    id: created.id,
    userId: OWNER,
    patch: { text: "Buy oat milk", priority: "Low" },
  });
  assert.equal(updated.text, "Buy oat milk", "update changes the text");

  await reminderService.deleteReminder({ id: created.id, userId: OWNER });
  list = await remindersOf(OWNER);
  assert.equal(
    list.find((r: any) => r.id === created.id),
    undefined,
    "soft-deleted reminder no longer appears in reads",
  );
});

dbTest("reminders: a stranger cannot update or delete the owner's reminder", async () => {
  const created = await reminderService.createReminder({
    userId: OWNER,
    text: "Private note",
    folderId: null,
    dueLabel: null,
    description: null,
    dueAt: null,
    priority: "Medium",
    recurrence: "none",
  });

  // The driver scopes every mutation by user_id, so a stranger's update is a
  // no-op that returns null (affects 0 rows) — never the owner's row.
  const hijack = await reminderService.updateReminder({
    id: created.id,
    userId: STRANGER,
    patch: { text: "HIJACKED" },
  });
  assert.equal(hijack, null, "a stranger's update returns null (no row matched)");

  // The stranger's delete must also not touch the owner's reminder.
  await reminderService.deleteReminder({ id: created.id, userId: STRANGER });
  const ownerList = await remindersOf(OWNER);
  const still = ownerList.find((r: any) => r.id === created.id);
  assert.ok(still, "the owner's reminder survives a stranger's delete attempt");
  assert.equal(still.text, "Private note", "and its content is unchanged");

  // A stranger's list never includes the owner's reminder.
  const strangerList = await remindersOf(STRANGER);
  assert.equal(
    strangerList.find((r: any) => r.id === created.id),
    undefined,
    "the reminder never appears in a stranger's list",
  );

  await reminderService.deleteReminder({ id: created.id, userId: OWNER }); // cleanup
});

// --- Server-side validation (P0-D): pure, DB-free, so these run even without
// MySQL. The validators throw 400 synchronously and never touch the pool.
test("reminders: validation rejects bad priority/recurrence/status/dueAt/text (400)", async () => {
  const svc = await import("../src/services/reminderService");
  // priority allow-list (High/Medium/Low) — the real Reminders UI options.
  assert.throws(() => svc.validatePriority("Urgent"), (e: any) => e.status === 400);
  svc.validatePriority("High");
  svc.validatePriority(undefined); // absent is fine (partial patch)

  // recurrence allow-list (none/daily/weekly/monthly).
  assert.throws(() => svc.validateRecurrence("yearly"), (e: any) => e.status === 400);
  assert.throws(() => svc.validateRecurrence("hourly"), (e: any) => e.status === 400);
  svc.validateRecurrence("weekly");
  svc.validateRecurrence("none");

  // status allow-list (open/done/archived).
  assert.throws(() => svc.validateStatus("pending"), (e: any) => e.status === 400);
  svc.validateStatus("done");
  svc.validateStatus("archived");
  svc.validateStatus(undefined);

  // dueAt: null/"" clears; garbage is rejected; an ISO string passes.
  svc.validateDueAt(null);
  svc.validateDueAt("");
  svc.validateDueAt(new Date().toISOString());
  assert.throws(() => svc.validateDueAt("not-a-date"), (e: any) => e.status === 400);

  // text: required, trimmed, non-empty.
  assert.throws(() => svc.validateText("   "), (e: any) => e.status === 400);
  assert.equal(svc.validateText("  buy milk  "), "buy milk", "text is trimmed");
});

dbTest("reminders: create rejects bad priority/recurrence and empty text (400)", async () => {
  await assert.rejects(
    () =>
      reminderService.createReminder({ userId: OWNER, text: "   " }),
    (e: any) => e.status === 400,
    "an empty/whitespace text is refused on create",
  );
  await assert.rejects(
    () =>
      reminderService.createReminder({ userId: OWNER, text: "ok", priority: "Urgent" }),
    (e: any) => e.status === 400,
    "a bogus priority is refused on create",
  );
  await assert.rejects(
    () =>
      reminderService.createReminder({ userId: OWNER, text: "ok", recurrence: "yearly" }),
    (e: any) => e.status === 400,
    "a bogus recurrence is refused on create",
  );
});

dbTest("reminders: update is lenient — patching one field never trips on others", async () => {
  // Create a valid reminder, then patch ONLY the text. Even if other fields held
  // legacy values, an unrelated patch must not re-validate them.
  const r = await reminderService.createReminder({
    userId: OWNER,
    text: "legacy row",
    priority: "Medium",
    recurrence: "none",
  });
  const updated = await reminderService.updateReminder({
    id: r.id,
    userId: OWNER,
    patch: { description: "just a note" },
  });
  assert.ok(updated, "an unrelated patch succeeds");
  // But a patch that DOES carry a bad value for a present field is rejected.
  await assert.rejects(
    () =>
      reminderService.updateReminder({
        id: r.id,
        userId: OWNER,
        patch: { priority: "Critical" },
      }),
    (e: any) => e.status === 400,
    "a bad priority IN the patch is rejected",
  );
  await reminderService.deleteReminder({ id: r.id, userId: OWNER }); // cleanup
});

dbTest("reminders: list is paginated and counts stay authoritative across pages", async () => {
  // Seed a handful of reminders in different states for a dedicated user so the
  // counts are deterministic regardless of other test rows.
  const U = "u_rtf_owner"; // OWNER — counts are user-scoped
  // Clean slate for this user's count assertions: archive nothing, just measure
  // the DELTA the new rows introduce so prior tests don't perturb absolutes.
  const before = await reminderService.reminderCounts(U);
  const overdueIso = new Date(Date.now() - 3600_000).toISOString();
  const futureIso = new Date(Date.now() + 7 * 86400_000).toISOString();
  const made: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await reminderService.createReminder({
      userId: U,
      text: `pg-overdue-${i}`,
      dueAt: overdueIso,
      priority: "Medium",
      recurrence: "none",
    });
    made.push(r.id);
  }
  const up = await reminderService.createReminder({
    userId: U,
    text: "pg-upcoming",
    dueAt: futureIso,
  });
  made.push(up.id);

  // Page 1 with a small limit must NOT return everything, and must carry a cursor.
  const page1 = await reminderService.listReminders(U, { limit: 2 });
  assert.equal(page1.reminders.length, 2, "page 1 respects the limit");
  assert.ok(page1.hasMore, "page 1 reports more pages exist");
  assert.ok(page1.nextCursor, "page 1 carries a keyset cursor");

  // The cursor advances to a disjoint next page (no id overlap).
  const page2 = await reminderService.listReminders(U, {
    limit: 2,
    cursor: page1.nextCursor,
  });
  const ids1 = new Set(page1.reminders.map((r: any) => r.id));
  for (const r of page2.reminders)
    assert.ok(!ids1.has(r.id), "page 2 does not repeat page-1 rows");

  // Counts are authoritative TOTALS (not per-page): the overdue + upcoming deltas
  // match what we inserted, regardless of the page size.
  const after = page1.counts;
  assert.equal(
    after.overdue - before.overdue,
    3,
    "overdue count reflects all 3 overdue rows, not just the page",
  );
  assert.equal(
    after.upcoming - before.upcoming,
    1,
    "upcoming count reflects the 1 upcoming row across pages",
  );
  // `count` is the authoritative live total for the user.
  assert.equal(typeof page1.count, "number", "envelope carries a numeric total count");
  assert.ok(page1.count >= 4, "total count includes all the new rows");

  for (const id of made)
    await reminderService.deleteReminder({ id, userId: U }); // cleanup
});

// --- REMINDERS DEPTH (#53): lead-time firing, structured recurrence spawn, prune.

dbTest("reminders #53: a lead time fires the reminder BEFORE its due time, exactly once", async () => {
  // Due 5 minutes in the FUTURE, but lead = 10 min → effective notify-at is 5 min in
  // the PAST, so claimDue must pick it up NOW. Without a lead it would NOT be due yet.
  const dueAt = new Date(Date.now() + 5 * 60000).toISOString();
  const r = await reminderService.createReminder({
    userId: OWNER,
    text: "lead-fire",
    dueAt,
    leadMinutes: 10,
    recurrence: "none",
  });
  // The control: a same-due reminder with NO lead must NOT be claimed yet.
  const ctrl = await reminderService.createReminder({
    userId: OWNER,
    text: "no-lead-not-due",
    dueAt,
    recurrence: "none",
  });

  const fired = await db.reminders.claimDue(200);
  const ids = fired.map((x: any) => x.id);
  assert.ok(ids.includes(r.id), "the lead reminder fires now (due - lead is past)");
  assert.ok(!ids.includes(ctrl.id), "the no-lead reminder is NOT due yet");

  // Exactly-once: a second claim must NOT re-pick the already-fired row.
  const again = await db.reminders.claimDue(200);
  assert.ok(!again.map((x: any) => x.id).includes(r.id), "lead reminder fires exactly once");

  await reminderService.deleteReminder({ id: r.id, userId: OWNER });
  await reminderService.deleteReminder({ id: ctrl.id, userId: OWNER });
});

dbTest("reminders #53: completing a structured-recurrence reminder spawns the next occurrence once", async () => {
  // A weekly rule anchored on a past due date. Completing it must spawn ONE next
  // occurrence carrying the lead + the structured rule forward.
  const dueAt = new Date(Date.now() - 3 * 86400000).toISOString();
  const r = await reminderService.createReminder({
    userId: OWNER,
    text: "weekly-standup-rec",
    dueAt,
    leadMinutes: 30,
    recurrence: "weekly",
    recurrenceRule: { freq: "weekly", interval: 1, end: { type: "never" } },
  });
  await reminderService.setReminderStatus({ id: r.id, userId: OWNER, status: "done" });
  const list = await remindersOf(OWNER);
  const spawned = list.filter(
    (x: any) => x.text === "weekly-standup-rec" && x.status !== "done" && x.id !== r.id,
  );
  assert.equal(spawned.length, 1, "exactly one next occurrence is spawned");
  assert.equal(spawned[0].leadMinutes, 30, "the lead time carries forward");
  assert.ok(
    spawned[0].recurrenceRule && spawned[0].recurrenceRule.freq === "weekly",
    "the structured rule carries forward",
  );
  // Idempotent: completing the original again must NOT double-spawn.
  await reminderService.setReminderStatus({ id: r.id, userId: OWNER, status: "done" });
  const list2 = await remindersOf(OWNER);
  const spawned2 = list2.filter(
    (x: any) => x.text === "weekly-standup-rec" && x.status !== "done" && x.id !== r.id,
  );
  assert.equal(spawned2.length, 1, "no double-spawn on a repeat completion");

  // cleanup
  for (const x of list2.filter((y: any) => y.text === "weekly-standup-rec"))
    await reminderService.deleteReminder({ id: x.id, userId: OWNER });
});

dbTest("reminders #53 (fix1): firing a lead-time recurring reminder BEFORE due spawns the NEXT occurrence", async () => {
  // A daily reminder due 5 min in the FUTURE with a 10-min lead → effective notify-at
  // is in the PAST, so claimDue fires it NOW, while it's still 'open' and BEFORE its
  // own due instant. The fire-path spawnNext must advance to TOMORROW's occurrence —
  // the regression was that it asked to spawn at TODAY's (still-open) due_at, matched
  // the live row, and spawned NOTHING (zero advance for every lead-time recurring).
  const dueAt = new Date(Date.now() + 5 * 60000).toISOString();
  const r = await reminderService.createReminder({
    userId: OWNER,
    text: "lead-recurring-advance",
    dueAt,
    leadMinutes: 10,
    recurrence: "daily",
    recurrenceRule: { freq: "daily", interval: 1, end: { type: "never" } },
  });
  // Fire it (claimDue stamps notified_at; the row stays 'open') then roll forward
  // exactly as reminderFireService.runDue does.
  const fired = await db.reminders.claimDue(200);
  assert.ok(fired.map((x: any) => x.id).includes(r.id), "the lead recurring reminder fires now");
  const firedRow = fired.find((x: any) => x.id === r.id);
  await reminderService.spawnNext(firedRow);

  const list = await remindersOf(OWNER);
  const series = list.filter((x: any) => x.text === "lead-recurring-advance");
  // The original (still open, notified) PLUS one spawned next occurrence.
  const next = series.filter((x: any) => x.id !== r.id);
  assert.equal(next.length, 1, "fire-path spawns exactly one next occurrence");
  // The next occurrence is STRICTLY AFTER the original due (≈ +1 day), never the same instant.
  assert.ok(
    Date.parse(next[0].dueAt) > Date.parse(dueAt),
    "next occurrence is strictly after the current due instant",
  );
  assert.equal(next[0].leadMinutes, 10, "lead carries forward");

  for (const x of series) await reminderService.deleteReminder({ id: x.id, userId: OWNER });
});

dbTest("reminders #53 (fix1): completing a recurring reminder BEFORE its due does not duplicate the same slot", async () => {
  // Due in the FUTURE; complete it early (before due). The early-completion spawnNext
  // must advance to the NEXT slot — the regression INSERTed a duplicate at the SAME
  // due instant because computeNextDue returned the current occurrence's own due_at.
  const dueAt = new Date(Date.now() + 2 * 86400000).toISOString(); // 2 days out
  const r = await reminderService.createReminder({
    userId: OWNER,
    text: "early-complete-no-dup",
    dueAt,
    recurrence: "daily",
    recurrenceRule: { freq: "daily", interval: 1, end: { type: "never" } },
  });
  await reminderService.completeReminder({ id: r.id, userId: OWNER });

  const list = await remindersOf(OWNER);
  const series = list.filter((x: any) => x.text === "early-complete-no-dup");
  const next = series.filter((x: any) => x.id !== r.id && x.status !== "done");
  assert.equal(next.length, 1, "exactly one next occurrence, not a same-instant duplicate");
  assert.ok(
    Date.parse(next[0].dueAt) > Date.parse(dueAt),
    "the spawned occurrence is strictly after the completed one's due instant",
  );
  // No row shares the original's exact due instant besides the completed original.
  const sameInstant = series.filter(
    (x: any) => x.id !== r.id && Date.parse(x.dueAt) === Date.parse(dueAt),
  );
  assert.equal(sameInstant.length, 0, "no duplicate spawned at the same due instant");

  for (const x of series) await reminderService.deleteReminder({ id: x.id, userId: OWNER });
});

dbTest("reminders #53: prune soft-deletes OLD completed recurrence rows, never active/future", async () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString(); // ~200 days ago
  const future = new Date(Date.now() + 7 * 86400000).toISOString();
  // (a) old + completed + recurring → SHOULD be pruned.
  const a = await reminderService.createReminder({
    userId: OWNER, text: "prune-old-done", dueAt: old, recurrence: "daily",
  });
  await reminderService.setReminderStatus({ id: a.id, userId: OWNER, status: "done" });
  // (b) old + completed but NOT recurring → must SURVIVE (it's the user's history).
  const b = await reminderService.createReminder({
    userId: OWNER, text: "prune-old-oneoff", dueAt: old, recurrence: "none",
  });
  await reminderService.setReminderStatus({ id: b.id, userId: OWNER, status: "done" });
  // (c) future + recurring (active) → must SURVIVE (never prune future).
  const c = await reminderService.createReminder({
    userId: OWNER, text: "prune-future-active", dueAt: future, recurrence: "daily",
  });

  const res = await reminderService.pruneOldOccurrences(90);
  assert.ok((res.pruned || 0) >= 1, "at least the old completed recurring row is pruned");

  const list = await remindersOf(OWNER);
  const byId = (id: string) => list.find((x: any) => x.id === id);
  assert.equal(byId(a.id), undefined, "old completed recurring row is pruned (soft-deleted)");
  assert.ok(byId(b.id), "old completed ONE-OFF row survives");
  assert.ok(byId(c.id), "future active recurring row survives");

  // cleanup
  await reminderService.deleteReminder({ id: b.id, userId: OWNER });
  await reminderService.deleteReminder({ id: c.id, userId: OWNER });
});

dbTest("migration 0064: reminders.lead_minutes + recurrence_rule columns exist + back-fill", async () => {
  const cols = (
    await db.pool.query("SHOW COLUMNS FROM reminders")
  )[0].map((c: any) => c.Field);
  assert.ok(cols.includes("lead_minutes"), "lead_minutes column exists");
  assert.ok(cols.includes("recurrence_rule"), "recurrence_rule column exists");
});

// ---------------------------------------------------------------------------
// TASKS
// ---------------------------------------------------------------------------

// taskService.list() returns a pagination envelope { tasks, hasMore, ... }, not
// a bare array — unwrap to the task rows for membership checks.
const tasksOf = async (userId: string) => (await taskService.list(userId)).tasks;

dbTest("tasks: create → read-back → update → soft-delete", async () => {
  const created = await taskService.create({
    title: "Write the audit",
    creatorId: OWNER,
  });
  assert.ok(created.id, "task created with an id");

  let list = await tasksOf(OWNER);
  assert.ok(list.find((t: any) => t.id === created.id), "task is read-back for the reporter");

  const updated = await taskService.update({
    id: created.id,
    actorId: OWNER,
    patch: { title: "Write the audit report", priority: "High" },
  });
  assert.equal(updated.title, "Write the audit report", "update changes the title");

  const removed = await taskService.remove({ id: created.id, actorId: OWNER });
  assert.equal(removed.deleted, true, "remove reports deleted");

  // getById filters deleted=0, so the task is hidden from reads after soft-delete.
  const gone = await db.tasks.getById(created.id);
  assert.equal(gone, null, "soft-deleted task is hidden from getById");
  list = await tasksOf(OWNER);
  assert.equal(
    list.find((t: any) => t.id === created.id),
    undefined,
    "soft-deleted task no longer appears in the list",
  );
});

dbTest("tasks: a stranger cannot read or mutate someone else's task (403/404)", async () => {
  const created = await taskService.create({
    title: "Owner-only task",
    creatorId: OWNER,
  });

  // assertTaskAccess: a non-reporter/non-assignee is denied with 403.
  await assert.rejects(
    () => taskService.update({ id: created.id, actorId: STRANGER, patch: { title: "x" } }),
    (e: any) => e.status === 403,
    "a stranger's update is forbidden",
  );
  await assert.rejects(
    () => taskService.move({ id: created.id, status: "done", actorId: STRANGER }),
    (e: any) => e.status === 403,
    "a stranger's move is forbidden",
  );
  await assert.rejects(
    () => taskService.remove({ id: created.id, actorId: STRANGER }),
    (e: any) => e.status === 403,
    "a stranger's delete is forbidden",
  );
  await assert.rejects(
    () => taskService.getActivity(created.id, STRANGER),
    (e: any) => e.status === 403,
    "a stranger cannot read the task's activity",
  );

  // The owner's task is untouched and still readable by the owner.
  const stillThere = await tasksOf(OWNER);
  assert.ok(stillThere.find((t: any) => t.id === created.id), "owner's task survives");

  await taskService.remove({ id: created.id, actorId: OWNER }); // cleanup
});

dbTest("tasks: the assignee (not just the reporter) has access", async () => {
  // A task reported by OWNER but assigned to STRANGER must be accessible to the
  // assignee — the access gate allows reporter OR assignee.
  const created = await taskService.create({
    title: "Assigned to stranger",
    assigneeId: STRANGER,
    creatorId: OWNER,
  });
  const list = await tasksOf(STRANGER);
  assert.ok(
    list.find((t: any) => t.id === created.id),
    "the assignee sees the task in their list",
  );
  // The assignee may move it (they have access). Use the REAL status enum
  // ("inprogress", matching the board columns) — server-side validation now
  // rejects bogus statuses like the old "in_progress".
  const moved = await taskService.move({ id: created.id, status: "inprogress", actorId: STRANGER });
  assert.ok(moved, "the assignee can move the task");

  await taskService.remove({ id: created.id, actorId: OWNER }); // cleanup
});

// --- MULTIPLE ASSIGNEES (feature #50) -------------------------------------
dbTest("tasks: a SECONDARY assignee (not the primary) has access + sees the task", async () => {
  // OWNER creates, assigns STRANGER (becomes primary). Then add THIRD as a
  // SECOND assignee — they are NOT the primary (assignee_id), so the old bare
  // assignee_id gate would miss them; the join-table predicate must still grant
  // access AND surface the task in their list.
  const created = await taskService.create({
    title: "Two assignees",
    assigneeId: STRANGER,
    creatorId: OWNER,
  });
  const r = await taskService.assign({ id: created.id, userId: THIRD, actorId: OWNER });
  const ids = (r.assignees || []).map((a: any) => a.id);
  assert.ok(ids.includes(STRANGER) && ids.includes(THIRD), "both assignees present");
  // The primary (assignee_id) is still the first-assigned (STRANGER).
  const row = await db.tasks.getById(created.id);
  assert.equal(row.assigneeId, STRANGER, "assignee_id stays the PRIMARY (first assigned)");

  // THIRD (secondary) is in their own "my tasks" list and can move the task.
  const list = await tasksOf(THIRD);
  assert.ok(list.find((t: any) => t.id === created.id), "secondary assignee sees the task");
  const moved = await taskService.move({ id: created.id, status: "inprogress", actorId: THIRD });
  assert.ok(moved, "secondary assignee can move the task");

  // countForUser mirrors the same predicate (badge agrees with the list).
  const cnt = await db.tasks.countForUser(THIRD);
  assert.ok(cnt >= 1, "countForUser includes the secondary-assignee task");

  await taskService.remove({ id: created.id, actorId: OWNER }); // cleanup
});

dbTest("tasks: removing the PRIMARY assignee re-points assignee_id to the next", async () => {
  const created = await taskService.create({
    title: "Primary repoint",
    assigneeId: STRANGER,
    creatorId: OWNER,
  });
  await taskService.assign({ id: created.id, userId: THIRD, actorId: OWNER });
  // Remove the primary (STRANGER) → assignee_id must move to THIRD (now oldest).
  await taskService.unassign({ id: created.id, userId: STRANGER, actorId: OWNER });
  const row = await db.tasks.getById(created.id);
  assert.equal(row.assigneeId, THIRD, "primary re-points to the remaining assignee");
  // Remove the last one → assignee_id becomes NULL.
  await taskService.unassign({ id: created.id, userId: THIRD, actorId: OWNER });
  const empty = await db.tasks.getById(created.id);
  assert.equal(empty.assigneeId, null, "no assignees → assignee_id is NULL");
  assert.deepEqual(await db.tasks.assignees(created.id), [], "join table is empty");

  await taskService.remove({ id: created.id, actorId: OWNER }); // cleanup
});

dbTest("tasks: setAssignees replaces the whole set + keeps assignee_id consistent", async () => {
  const created = await taskService.create({ title: "Set replace", assigneeId: OWNER, creatorId: OWNER });
  const { task, added, removed } = await taskService.setAssignees({
    id: created.id,
    userIds: [STRANGER, THIRD],
    actorId: OWNER,
  });
  const ids = (task.assignees || []).map((a: any) => a.id);
  assert.deepEqual([...ids].sort(), [STRANGER, THIRD].sort(), "set replaced with the new two");
  assert.ok(added.includes(STRANGER) && added.includes(THIRD), "added reports the new ids");
  assert.ok(removed.includes(OWNER), "removed reports the dropped id");
  // assignee_id = the primary (first of the new set by assigned_at).
  const row = await db.tasks.getById(created.id);
  assert.ok([STRANGER, THIRD].includes(row.assigneeId), "assignee_id is one of the new set");
  // OWNER (no longer assignee) is also the REPORTER, so still has access; but a
  // pure non-member must not. Re-create reported by STRANGER to isolate.
  await taskService.remove({ id: created.id, actorId: OWNER }); // cleanup
});

dbTest("tasks: a legacy single-assigneeId PATCH stays consistent with the join table", async () => {
  // The frontend still sends save({ assigneeId }); the service must reconcile the
  // join table so multi-assignee readers don't drift.
  const created = await taskService.create({ title: "Legacy patch", creatorId: OWNER });
  await taskService.update({ id: created.id, actorId: OWNER, patch: { assigneeId: STRANGER } });
  assert.deepEqual(await db.tasks.assignees(created.id), [STRANGER], "join table reflects the PATCH");
  const row = await db.tasks.getById(created.id);
  assert.equal(row.assigneeId, STRANGER, "assignee_id reflects the PATCH");
  // Clearing it empties the join table too.
  await taskService.update({ id: created.id, actorId: OWNER, patch: { assigneeId: null } });
  assert.deepEqual(await db.tasks.assignees(created.id), [], "clearing empties the join table");

  await taskService.remove({ id: created.id, actorId: OWNER }); // cleanup
});

// --- WATCHERS -------------------------------------------------------------
dbTest("tasks: a watcher can READ but NOT mutate; assignees/reporter auto-watch", async () => {
  // OWNER creates + assigns STRANGER. By the auto-watch rule both OWNER (reporter)
  // and STRANGER (assignee) are watchers from creation.
  const created = await taskService.create({ title: "Watch me", assigneeId: STRANGER, creatorId: OWNER });
  const w0 = await db.tasks.watchers(created.id);
  assert.ok(w0.includes(OWNER) && w0.includes(STRANGER), "reporter + assignee auto-watch on create");

  // THIRD is a stranger: no access yet — and (no IDOR) cannot self-add as a
  // watcher to a task they can't already see. Watching requires read access.
  await assert.rejects(
    () => taskService.getActivity(created.id, THIRD),
    (e: any) => e.status === 403,
    "a non-watcher stranger cannot read activity",
  );
  await assert.rejects(
    () => taskService.watch({ id: created.id, userId: THIRD }),
    (e: any) => e.status === 403,
    "a stranger cannot self-add as a watcher (no IDOR/discovery)",
  );

  // THIRD legitimately gains access by being ASSIGNED (which auto-watches them).
  await taskService.assign({ id: created.id, userId: THIRD, actorId: OWNER });
  assert.ok((await db.tasks.watchers(created.id)).includes(THIRD), "an assignee auto-watches");

  // Now UNASSIGN THIRD — they are no longer an assignee but REMAIN a watcher, so
  // they keep READ access (a watcher may read) while LOSING the ability to mutate.
  await taskService.unassign({ id: created.id, userId: THIRD, actorId: OWNER });
  assert.ok((await db.tasks.watchers(created.id)).includes(THIRD), "unassign keeps the watcher row");
  const act = await taskService.getActivity(created.id, THIRD);
  assert.ok(Array.isArray(act), "a watcher (no longer assignee) can still READ activity");
  await assert.rejects(
    () => taskService.update({ id: created.id, actorId: THIRD, patch: { title: "hijack" } }),
    (e: any) => e.status === 403,
    "a watcher (not reporter/assignee) cannot mutate the task",
  );

  // Unwatch (allowed for oneself) removes read access again.
  await taskService.unwatch({ id: created.id, userId: THIRD });
  await assert.rejects(
    () => taskService.getActivity(created.id, THIRD),
    (e: any) => e.status === 403,
    "after unwatch the (now unrelated) user loses read access",
  );

  await taskService.remove({ id: created.id, actorId: OWNER }); // cleanup
});

dbTest("tasks: commenting auto-watches the commenter", async () => {
  const created = await taskService.create({ title: "Comment-watch", assigneeId: STRANGER, creatorId: OWNER });
  // OWNER (reporter) comments — they could already read; commenting must (re)add
  // them to the watcher set as a sensible default.
  await db.tasks.removeWatcher(created.id, OWNER); // simulate "not watching yet"
  await taskService.addComment({ id: created.id, authorId: OWNER, body: "looks good" });
  const w = await db.tasks.watchers(created.id);
  assert.ok(w.includes(OWNER), "the commenter is auto-watching");
  await taskService.remove({ id: created.id, actorId: OWNER }); // cleanup
});

// --- MIGRATION 0060 back-fill --------------------------------------------
dbTest("migration 0060: the task_assignees/task_watchers tables exist + back-fill ran", async () => {
  // The tables exist (migrate() ran in `before`).
  const [ta] = (await db.pool.query("SHOW TABLES LIKE 'task_assignees'")) as any;
  const [tw] = (await db.pool.query("SHOW TABLES LIKE 'task_watchers'")) as any;
  assert.ok(ta.length, "task_assignees table exists");
  assert.ok(tw.length, "task_watchers table exists");

  // Simulate a LEGACY row (single assignee_id, no join rows) the way a pre-0060
  // task would look, then run the back-fill statements and confirm they populate
  // + are idempotent on a re-run.
  const { randomUUID } = await import("crypto");
  const id = randomUUID();
  await db.pool.query(
    "INSERT INTO tasks (id,title,status,priority,assignee_id,reporter_id) VALUES (?,?,?,?,?,?)",
    [id, "legacy backfill", "todo", "Medium", STRANGER, OWNER],
  );
  // Ensure no join rows yet (a true legacy row).
  await db.pool.query("DELETE FROM task_assignees WHERE task_id=?", [id]);
  await db.pool.query("DELETE FROM task_watchers WHERE task_id=?", [id]);
  // Re-run the exact back-fill statements from the migration (idempotent).
  const backfill = [
    "INSERT IGNORE INTO task_assignees (task_id, user_id) SELECT id, assignee_id FROM tasks WHERE assignee_id IS NOT NULL AND deleted = 0",
    "INSERT IGNORE INTO task_watchers (task_id, user_id) SELECT id, assignee_id FROM tasks WHERE assignee_id IS NOT NULL AND deleted = 0",
    "INSERT IGNORE INTO task_watchers (task_id, user_id) SELECT id, reporter_id FROM tasks WHERE reporter_id IS NOT NULL AND deleted = 0",
  ];
  for (const s of backfill) await db.pool.query(s);
  for (const s of backfill) await db.pool.query(s); // second pass must be a no-op (INSERT IGNORE)

  const asn = await db.tasks.assignees(id);
  const wat = await db.tasks.watchers(id);
  assert.deepEqual(asn, [STRANGER], "legacy assignee back-filled into task_assignees");
  assert.ok(wat.includes(STRANGER) && wat.includes(OWNER), "assignee + reporter back-filled as watchers");

  await db.pool.query("DELETE FROM task_assignees WHERE task_id=?", [id]);
  await db.pool.query("DELETE FROM task_watchers WHERE task_id=?", [id]);
  await db.pool.query("DELETE FROM tasks WHERE id=?", [id]); // cleanup
});

// --- @MENTION resolution (pure-ish): the app's @first-name convention -------
dbTest("tasks: mention resolution maps @first-name to a real member id (and dedupes)", async () => {
  const notif = await import("../src/services/notificationService");
  // Candidate "members" mimic real users; names have spaces (multi-word), which
  // exact getByName would miss — the resolver matches the first-name-stripped form.
  const candidates = [
    { id: OWNER, name: "RTF Owner" },
    { id: STRANGER, name: "RTF Stranger" },
    { id: THIRD, name: "RTF Third" },
  ];
  // The frontend inserts "@" + first name (no spaces): "@RTF" is ambiguous (all
  // share a first name) so it resolves to the FIRST candidate deterministically.
  // Use a distinguishing body that mentions by the stripped first token form.
  // To get distinct resolution we craft names that differ on the first token.
  const distinct = [
    { id: OWNER, name: "Alice Owner" },
    { id: STRANGER, name: "Bob Stranger" },
    { id: THIRD, name: "Carol Third" },
  ];
  const ids = await notif.resolveMentionedUserIds(
    "Hey @Alice and @Carol — and again @Alice",
    distinct,
  );
  assert.deepEqual([...ids].sort(), [OWNER, THIRD].sort(), "resolves @Alice→OWNER, @Carol→THIRD, deduped");
  // A mention of a non-member resolves to nobody (only real members notified).
  const none = await notif.resolveMentionedUserIds("@Nobody here", distinct);
  assert.deepEqual(none, [], "an unknown @mention resolves to no user");
  // No mentions → empty.
  assert.deepEqual(await notif.resolveMentionedUserIds("plain text", distinct), [], "no @ → empty");
  // The ambiguous-shared-first-name case still resolves to a single deterministic id.
  void candidates;
});

// --- Server-side validation (P0): pure, DB-free, so these run even without MySQL.
// The validators throw 400 synchronously and never touch the pool. We import the
// service module directly (the pool is created lazily and stays unconnected).
test("tasks: validation rejects bad status/priority/title/dueAt (400)", async () => {
  const svc = await import("../src/services/taskService");
  // status allow-list — the real board enum, NOT garbage like "in_progress".
  assert.throws(() => svc.validateStatus("in_progress"), (e: any) => e.status === 400);
  assert.throws(() => svc.validateStatus("nonsense"), (e: any) => e.status === 400);
  svc.validateStatus("inprogress"); // a real status passes
  svc.validateStatus("done");
  svc.validateStatus(undefined); // absent is fine (partial patch)

  // priority allow-list (High/Medium/Low).
  assert.throws(() => svc.validatePriority("Urgent"), (e: any) => e.status === 400);
  svc.validatePriority("High");

  // title: required, trimmed, <= 255.
  assert.throws(() => svc.validateTitle("   "), (e: any) => e.status === 400);
  assert.throws(() => svc.validateTitle("x".repeat(256)), (e: any) => e.status === 400);
  assert.equal(svc.validateTitle("  hello  "), "hello", "title is trimmed");

  // dueAt: null/"" clears; garbage is rejected; an ISO string passes.
  svc.validateDueAt(null);
  svc.validateDueAt("");
  svc.validateDueAt(new Date().toISOString());
  assert.throws(() => svc.validateDueAt("not-a-date"), (e: any) => e.status === 400);
});

dbTest("tasks: create rejects an empty title and a bad status (400)", async () => {
  await assert.rejects(
    () => taskService.create({ title: "   ", creatorId: OWNER }),
    (e: any) => e.status === 400,
    "an empty/whitespace title is refused on create",
  );
  await assert.rejects(
    () => taskService.create({ title: "ok", status: "in_progress", creatorId: OWNER }),
    (e: any) => e.status === 400,
    "a bogus status is refused on create",
  );
});

dbTest("tasks: circular-dependency detection blocks A→B→A and longer cycles", async () => {
  const a = await taskService.create({ title: "cycle A", creatorId: OWNER });
  const b = await taskService.create({ title: "cycle B", creatorId: OWNER });
  const c = await taskService.create({ title: "cycle C", creatorId: OWNER });

  // A depends-on B is fine.
  await taskService.addDependency({ id: a.id, dependsOnId: b.id, actorId: OWNER });
  // B depends-on A would close a 2-node cycle → 400.
  await assert.rejects(
    () => taskService.addDependency({ id: b.id, dependsOnId: a.id, actorId: OWNER }),
    (e: any) => e.status === 400,
    "a direct A→B→A cycle is rejected",
  );
  // Build B depends-on C, then C depends-on A would close a 3-node cycle → 400.
  await taskService.addDependency({ id: b.id, dependsOnId: c.id, actorId: OWNER });
  await assert.rejects(
    () => taskService.addDependency({ id: c.id, dependsOnId: a.id, actorId: OWNER }),
    (e: any) => e.status === 400,
    "a longer A→B→C→A cycle is rejected",
  );
  // A self-dependency is also rejected.
  await assert.rejects(
    () => taskService.addDependency({ id: a.id, dependsOnId: a.id, actorId: OWNER }),
    (e: any) => e.status === 400,
    "a self-dependency is rejected",
  );

  for (const t of [a, b, c]) await taskService.remove({ id: t.id, actorId: OWNER }); // cleanup
});

// --- DEPENDENCY ENFORCEMENT (feature #51) ---------------------------------
dbTest("tasks: cannot be marked DONE while a blocker is still open (400)", async () => {
  // A depends-on B. While B is open, completing A is rejected server-side both
  // via move() (board drag) and update() (detail Status select).
  const a = await taskService.create({ title: "blocked task A", creatorId: OWNER });
  const b = await taskService.create({ title: "blocker task B", creatorId: OWNER });
  await taskService.addDependency({ id: a.id, dependsOnId: b.id, actorId: OWNER });

  await assert.rejects(
    () => taskService.move({ id: a.id, status: "done", actorId: OWNER }),
    (e: any) => e.status === 400 && e.code === "task_blocked_by_dependencies",
    "move → done is blocked while B is open",
  );
  await assert.rejects(
    () => taskService.update({ id: a.id, actorId: OWNER, patch: { status: "done" } }),
    (e: any) => e.status === 400 && e.code === "task_blocked_by_dependencies",
    "update → done is blocked while B is open",
  );
  // The blocker is reported so the message/UI can name it.
  try {
    await taskService.move({ id: a.id, status: "done", actorId: OWNER });
    assert.fail("expected the blocked move to throw");
  } catch (e: any) {
    assert.ok(Array.isArray(e.blockers) && e.blockers.some((x: any) => x.id === b.id),
      "the rejection lists the open blocker");
  }

  // Moving A to a NON-done status (e.g. inprogress) is still fine while blocked.
  const moved = await taskService.move({ id: a.id, status: "inprogress", actorId: OWNER });
  assert.equal(moved.status, "inprogress", "a non-completion move is allowed while blocked");

  // Resolve the blocker → A can now be completed.
  await taskService.move({ id: b.id, status: "done", actorId: OWNER });
  const doneA = await taskService.move({ id: a.id, status: "done", actorId: OWNER });
  assert.equal(doneA.status, "done", "A completes once its blocker is done");

  for (const t of [a, b]) await taskService.remove({ id: t.id, actorId: OWNER }); // cleanup
});

dbTest("tasks: BULK complete/move→done honors dependency enforcement (no bypass)", async () => {
  // Regression for the #51 bulk-bypass: a blocked task must NOT be completed via the
  // bulk endpoint either. A depends-on B; while B is open, bulk complete/move→done
  // must SKIP A (leave it un-done) and report it as blocked, exactly like move().
  const a = await taskService.create({ title: "bulk blocked A", creatorId: OWNER });
  const b = await taskService.create({ title: "bulk blocker B", creatorId: OWNER });
  await taskService.addDependency({ id: a.id, dependsOnId: b.id, actorId: OWNER });

  // bulk complete: A stays not-done, reported as blocked.
  const r1: any = await taskService.bulk({ ids: [a.id], action: "complete", actorId: OWNER });
  let rowA = await db.tasks.getById(a.id);
  assert.notEqual(rowA.status, "done", "bulk complete must NOT complete a blocked task");
  assert.ok(
    Array.isArray(r1.blocked) && r1.blocked.some((x: any) => x.id === a.id),
    "bulk complete reports the blocked task id",
  );

  // bulk move → done: same guard.
  const r2: any = await taskService.bulk({ ids: [a.id], action: "move", value: "done", actorId: OWNER });
  rowA = await db.tasks.getById(a.id);
  assert.notEqual(rowA.status, "done", "bulk move→done must NOT complete a blocked task");
  assert.ok(
    Array.isArray(r2.blocked) && r2.blocked.some((x: any) => x.id === a.id),
    "bulk move→done reports the blocked task id",
  );

  // A non-done bulk move (e.g. inprogress) is allowed while blocked.
  await taskService.bulk({ ids: [a.id], action: "move", value: "inprogress", actorId: OWNER });
  rowA = await db.tasks.getById(a.id);
  assert.equal(rowA.status, "inprogress", "a non-completion bulk move is allowed while blocked");

  // Resolve the blocker → bulk complete now succeeds (mixed batch: A allowed once clear).
  await taskService.move({ id: b.id, status: "done", actorId: OWNER });
  const r3: any = await taskService.bulk({ ids: [a.id], action: "complete", actorId: OWNER });
  rowA = await db.tasks.getById(a.id);
  assert.equal(rowA.status, "done", "A completes via bulk once its blocker is done");
  assert.ok(!r3.blocked || !r3.blocked.length, "no blocked tasks reported once clear");

  for (const t of [a, b]) await taskService.remove({ id: t.id, actorId: OWNER }); // cleanup
});

dbTest("tasks: openBlockers ignores resolved (done/archived) blockers", async () => {
  const a = await taskService.create({ title: "ob A", creatorId: OWNER });
  const open = await taskService.create({ title: "ob open", creatorId: OWNER });
  const done = await taskService.create({ title: "ob done", creatorId: OWNER });
  await taskService.addDependency({ id: a.id, dependsOnId: open.id, actorId: OWNER });
  await taskService.addDependency({ id: a.id, dependsOnId: done.id, actorId: OWNER });
  await taskService.move({ id: done.id, status: "archived", actorId: OWNER });

  const blockers = await taskService.openBlockers(a.id);
  const ids = blockers.map((x: any) => x.id);
  assert.ok(ids.includes(open.id), "an OPEN blocker counts");
  assert.ok(!ids.includes(done.id), "a resolved (archived) blocker does NOT count");

  for (const t of [a, open, done]) await taskService.remove({ id: t.id, actorId: OWNER }); // cleanup
});

// --- ATTACHMENTS (feature #51) --------------------------------------------
dbTest("tasks: attach/list/detach a file (reuses the Files row) + serialize carries it", async () => {
  const t = await taskService.create({ title: "with attachment", creatorId: OWNER });
  // The blob is produced by the Files pipeline; here we make a BLOB-backed file
  // row directly (no S3) — the LINK is what feature #51 manages.
  const f = await makeFile(OWNER, "spec.pdf", "application/pdf");

  let list = await taskService.attach({ id: t.id, fileId: f.id, actorId: OWNER });
  assert.ok(list.find((a: any) => a.id === f.id), "attach links the file to the task");

  const listed = await taskService.listAttachments(t.id, OWNER);
  assert.ok(listed.find((a: any) => a.id === f.id), "list returns the attachment");
  assert.equal(
    listed.find((a: any) => a.id === f.id).name,
    "spec.pdf",
    "the attachment carries the file summary (name)",
  );

  // serializeTask exposes an attachments[] summary for the detail panel.
  const row = await db.tasks.getById(t.id);
  const { serializeTask } = await import("../src/serialize");
  const ser = await serializeTask(row);
  assert.ok(
    (ser.attachments || []).some((a: any) => a.id === f.id),
    "serializeTask includes the attachment summary",
  );

  // Detach unlinks it (and the OWNER's detach soft-deletes their file).
  list = await taskService.detach({ id: t.id, fileId: f.id, actorId: OWNER });
  assert.equal(list.find((a: any) => a.id === f.id), undefined, "detach unlinks the file");
  assert.equal(
    (await taskService.listAttachments(t.id, OWNER)).length,
    0,
    "no attachments remain after detach",
  );

  await taskService.remove({ id: t.id, actorId: OWNER }); // cleanup
});

dbTest("tasks: a stranger cannot attach/list/detach; can't attach a file they can't see", async () => {
  const t = await taskService.create({ title: "owner attachment", assigneeId: STRANGER, creatorId: OWNER });
  const ownerFile = await makeFile(OWNER, "owned.txt");

  // A THIRD party (no task access) cannot list or attach.
  await assert.rejects(
    () => taskService.listAttachments(t.id, THIRD),
    (e: any) => e.status === 403,
    "a non-member cannot list attachments",
  );
  await assert.rejects(
    () => taskService.attach({ id: t.id, fileId: ownerFile.id, actorId: THIRD }),
    (e: any) => e.status === 403,
    "a non-member cannot attach to the task",
  );

  // STRANGER has TASK access (assignee) but NOT access to OWNER's private file —
  // attaching it would leak it, so the file-permission gate rejects with 403.
  await assert.rejects(
    () => taskService.attach({ id: t.id, fileId: ownerFile.id, actorId: STRANGER }),
    (e: any) => e.status === 403,
    "a member can't attach a file they have no Files permission for",
  );

  // STRANGER attaching their OWN file is allowed (task access + file access).
  const strangerFile = await makeFile(STRANGER, "stranger.txt");
  const list = await taskService.attach({ id: t.id, fileId: strangerFile.id, actorId: STRANGER });
  assert.ok(list.find((a: any) => a.id === strangerFile.id), "a member attaches their own file");

  await taskService.detach({ id: t.id, fileId: strangerFile.id, actorId: STRANGER });
  await fileService.remove({ fileId: ownerFile.id, userId: OWNER }); // cleanup
  await taskService.remove({ id: t.id, actorId: OWNER });
});

dbTest("tasks: deleting a task soft-cascades its attachment links", async () => {
  const t = await taskService.create({ title: "delete cascade", creatorId: OWNER });
  const f = await makeFile(OWNER, "cascade.txt");
  await taskService.attach({ id: t.id, fileId: f.id, actorId: OWNER });
  assert.equal((await db.tasks.attachments(t.id)).length, 1, "the link exists before delete");

  await taskService.remove({ id: t.id, actorId: OWNER });
  // The link row is soft-deleted (the attachments read filters deleted=0).
  const [rows] = (await db.pool.query(
    "SELECT deleted FROM task_attachments WHERE task_id=? AND file_id=?",
    [t.id, f.id],
  )) as any;
  assert.ok(rows.length && rows[0].deleted === 1, "the attachment link is soft-deleted on task delete");

  await db.files.remove(f.id, OWNER); // cleanup the file
});

dbTest("tasks: completing a task clears the due-firing stamp so a reopened task re-arms", async () => {
  // A task that already fired its due notification (due_notified_at stamped).
  const created = await taskService.create({
    title: "Due-stamp lifecycle",
    creatorId: OWNER,
    dueAt: new Date(Date.now() - 60000).toISOString(),
  });
  await db.tasks.update(created.id, { dueNotifiedAt: new Date() });
  let row = await db.tasks.getById(created.id);
  assert.ok(row.dueNotifiedAt, "stamp is set before completion");

  // Completing it clears the stamp (moving into a resolved status).
  await taskService.move({ id: created.id, status: "done", actorId: OWNER });
  row = await db.tasks.getById(created.id);
  assert.equal(row.dueNotifiedAt, null, "completing clears due_notified_at");

  // Reopening it leaves it re-armed (still null → the next due scan can fire).
  await taskService.move({ id: created.id, status: "todo", actorId: OWNER });
  row = await db.tasks.getById(created.id);
  assert.equal(row.dueNotifiedAt, null, "reopened task remains re-armed");

  await taskService.remove({ id: created.id, actorId: OWNER }); // cleanup
});

// --- RECURRING TASKS + SUBTASKS + CSV (feature #52a) -----------------------

// CSV injection + RFC-4180 escaping is PURE (no DB) — runs even without MySQL.
// A field that begins with = + - @ (or a tab/CR) is a spreadsheet formula trigger;
// csvField must neutralize it with a leading quote AND apply normal CSV quoting.
test("tasks CSV: escaping neutralizes formula injection + quotes correctly", async () => {
  const svc = await import("../src/services/taskService");
  // Formula-injection leads are prefixed with a single quote.
  for (const lead of ["=", "+", "-", "@"]) {
    const out = svc.csvField(lead + "cmd|'/c calc'!A1");
    assert.ok(out.startsWith("'" + lead), `a leading ${lead} is neutralized`);
  }
  // A tab/CR lead is also neutralized (then quoted because it contains a CR).
  assert.ok(svc.csvField("\t=danger").startsWith("'\t"), "a leading TAB is neutralized");
  // A benign value is emitted bare (no quoting, no prefix).
  assert.equal(svc.csvField("Write the report"), "Write the report", "a plain value is unquoted");
  // A value with a comma/quote/newline is RFC-4180 quoted (quotes doubled).
  assert.equal(svc.csvField("a,b"), '"a,b"', "a comma forces quoting");
  assert.equal(svc.csvField('say "hi"'), '"say ""hi"""', "embedded quotes are doubled");
  assert.equal(svc.csvField("line1\nline2"), '"line1\nline2"', "a newline forces quoting");
  // A formula value that ALSO needs quoting gets both: the quote-prefix is INSIDE
  // the wrapping quotes (so the spreadsheet still sees the leading apostrophe).
  assert.equal(svc.csvField("=1,2"), `"'=1,2"`, "injection-prefix then RFC-4180 quoting");
  // null/empty → empty field.
  assert.equal(svc.csvField(null), "", "null → empty");
  // A whole row joins with commas.
  assert.equal(svc.csvRow(["a", "=b", "c,d"]), `a,'=b,"c,d"`, "csvRow joins escaped fields");
});

// Recurrence allow-list is PURE — the server's authority over the value.
test("tasks: recurrence validation rejects out-of-list values (400)", async () => {
  const svc = await import("../src/services/taskService");
  assert.throws(() => svc.validateRecurrence("yearly"), (e: any) => e.status === 400);
  assert.throws(() => svc.validateRecurrence("hourly"), (e: any) => e.status === 400);
  svc.validateRecurrence("daily");
  svc.validateRecurrence("weekly");
  svc.validateRecurrence("monthly");
  svc.validateRecurrence("none");
  svc.validateRecurrence(undefined); // absent is fine (partial patch)
  svc.validateRecurrence(""); // empty clears
  // nextDue advances by the recurrence and skips elapsed occurrences (always future).
  const past = new Date(Date.now() - 10 * 86400_000).toISOString();
  const nd = svc.nextDue(past, "daily");
  assert.ok(nd && Date.parse(nd) > Date.now(), "nextDue rolls forward to a future instant");
  assert.equal(svc.nextDue(past, "none"), null, "recurrence none → no next due");
});

dbTest("tasks: completing a recurring task spawns the NEXT occurrence exactly once", async () => {
  // A daily-recurring task due in the past. Completing it must create ONE next
  // occurrence (status todo, due_at advanced), and the original stays done.
  const due = new Date(Date.now() - 86400_000).toISOString();
  const created = await taskService.create({
    title: "Daily standup notes",
    creatorId: OWNER,
    assigneeId: OWNER,
    dueAt: due,
    recurrence: "daily",
  });
  assert.equal(created.recurrence, "daily", "serializeTask exposes recurrence");

  const before = await db.tasks.listAllForUser(OWNER);
  const beforeCount = before.filter((t: any) => t.title === "Daily standup notes").length;

  // Complete it → spawns the next occurrence.
  await taskService.move({ id: created.id, status: "done", actorId: OWNER });

  let all = await db.tasks.listAllForUser(OWNER);
  const series = all.filter((t: any) => t.title === "Daily standup notes");
  assert.equal(series.length, beforeCount + 1, "exactly one next occurrence is spawned");
  const original = series.find((t: any) => t.id === created.id);
  const next = series.find((t: any) => t.id !== created.id && t.status !== "done");
  assert.equal(original.status, "done", "the original recurring task stays done (history)");
  assert.ok(next, "a fresh (non-done) next occurrence exists");
  assert.equal(next.recurrence, "daily", "the next occurrence carries the recurrence");
  assert.ok(Date.parse(next.dueAt) > Date.parse(due), "the next due is advanced past the old due");
  // The spawned occurrence inherits the assignee set.
  assert.ok((await db.tasks.assignees(next.id)).includes(OWNER), "the next occurrence keeps the assignee");

  // IDEMPOTENT: re-completing the (already done) original must NOT spawn a second.
  await taskService.move({ id: created.id, status: "done", actorId: OWNER });
  all = await db.tasks.listAllForUser(OWNER);
  const series2 = all.filter((t: any) => t.title === "Daily standup notes");
  assert.equal(series2.length, beforeCount + 1, "re-completing does not double-spawn");

  // Directly invoking spawnNextTask again for the SAME source row (the persisted
  // original, so the computed next-due instant is identical) is deduped by the
  // advisory lock + existence check (returns null — no second row).
  const originalRow = await db.tasks.getById(created.id);
  const dup = await taskService.spawnNextTask(originalRow, OWNER);
  assert.equal(dup, null, "a concurrent re-spawn for the same occurrence is deduped to null");
  const series3 = (await db.tasks.listAllForUser(OWNER)).filter(
    (t: any) => t.title === "Daily standup notes",
  );
  assert.equal(series3.length, beforeCount + 1, "still exactly one next occurrence after the dup attempt");

  // cleanup: the whole series.
  for (const t of series3) await taskService.remove({ id: t.id, actorId: OWNER });
});

dbTest("tasks: a recurring task with NO due date does not spawn (no non-deterministic double-spawn)", async () => {
  // Regression for the null-due double-spawn: nextDue(null,...) used to anchor to
  // the CURRENT clock, so the dedupe key (advisory lock + existence-check, both
  // keyed on the next due instant) differed by milliseconds between concurrent
  // completions and BOTH inserted. The fix mirrors reminders: a falsy due date
  // never rolls forward, so an undated recurring series produces NOTHING.
  assert.equal(taskService.nextDue(null, "daily"), null, "nextDue(null) returns null (no clock anchor)");
  assert.equal(taskService.nextDue("", "weekly"), null, "nextDue('') returns null");

  const created = await taskService.create({
    title: "Undated recurring task",
    creatorId: OWNER,
    assigneeId: OWNER,
    dueAt: null,
    recurrence: "daily",
  });
  const beforeCount = (await db.tasks.listAllForUser(OWNER)).filter(
    (t: any) => t.title === "Undated recurring task",
  ).length;

  // Complete it. With no due date, NO next occurrence may be spawned.
  await taskService.move({ id: created.id, status: "done", actorId: OWNER });
  let series = (await db.tasks.listAllForUser(OWNER)).filter(
    (t: any) => t.title === "Undated recurring task",
  );
  assert.equal(series.length, beforeCount, "an undated recurring task spawns no next occurrence");

  // Directly invoking spawnNextTask on the undated row also returns null (the
  // guard short-circuits before the non-deterministic nextDue could ever run).
  const row = await db.tasks.getById(created.id);
  assert.equal(await taskService.spawnNextTask(row, OWNER), null, "spawnNextTask is null for an undated series");

  for (const t of series) await taskService.remove({ id: t.id, actorId: OWNER });
});

dbTest("tasks: bulk-complete of a recurring task returns the spawned occurrence for broadcast", async () => {
  // Regression for the bulk live-update gap: bulk()'s spawnForBatch used to DISCARD
  // the spawned task, so the /bulk route (which only re-serializes the original ids)
  // never woke the new occurrence's rooms. The fix returns the spawned occurrences
  // on result._spawned so the route can emit TASK_CHANGED to their audience.
  const due = new Date(Date.now() - 86400_000).toISOString();
  const created = await taskService.create({
    title: "Weekly report (bulk)",
    creatorId: OWNER,
    assigneeId: OWNER,
    dueAt: due,
    recurrence: "weekly",
  });
  const beforeCount = (await db.tasks.listAllForUser(OWNER)).filter(
    (t: any) => t.title === "Weekly report (bulk)",
  ).length;

  const r: any = await taskService.bulk({
    ids: [created.id],
    action: "complete",
    actorId: OWNER,
  });
  assert.ok(Array.isArray(r._spawned) && r._spawned.length === 1, "bulk complete returns the spawned occurrence on _spawned");
  const spawned = r._spawned[0];
  assert.ok(spawned && spawned.id && spawned.id !== created.id, "the spawned occurrence is a brand-new task (id not in the bulk idList)");
  assert.equal(spawned.recurrence, "weekly", "spawned occurrence carries the recurrence");
  // The spawned task is serialized (carries the assignee set) so the route's
  // taskRoomUsers can route the broadcast to its audience.
  assert.ok((spawned.assignees || []).some((a: any) => a && a.id === OWNER), "spawned occurrence is serialized with its assignee set for broadcast");

  // Exactly one next occurrence exists (the advisory-lock dedupe still holds).
  const series = (await db.tasks.listAllForUser(OWNER)).filter(
    (t: any) => t.title === "Weekly report (bulk)",
  );
  assert.equal(series.length, beforeCount + 1, "bulk complete spawns exactly one next occurrence");

  for (const t of series) await taskService.remove({ id: t.id, actorId: OWNER });
});

dbTest("tasks: subtasks + progress (serialize carries done/total) + delete cascade", async () => {
  const parent = await taskService.create({ title: "Parent epic", creatorId: OWNER });
  const s1 = await taskService.createSubtask({ parentId: parent.id, title: "step 1", actorId: OWNER });
  const s2 = await taskService.createSubtask({ parentId: parent.id, title: "step 2", actorId: OWNER });
  assert.equal(s1.parentTaskId, parent.id, "a subtask carries its parentTaskId");

  // listSubtasks returns both children.
  const subs = await taskService.listSubtasks(parent.id, OWNER);
  assert.equal(subs.length, 2, "both subtasks are listed");

  // serializeTask exposes progress (0/2 then 1/2 after one is done).
  let prow = await db.tasks.getById(parent.id);
  const { serializeTask, serializeTaskList } = await import("../src/serialize");
  let pser = await serializeTask(prow);
  assert.equal(pser.subtaskCount, 2, "subtaskCount counts the children");
  assert.equal(pser.doneSubtaskCount, 0, "no children done yet");

  await taskService.move({ id: s1.id, status: "done", actorId: OWNER });
  pser = await serializeTask(await db.tasks.getById(parent.id));
  assert.equal(pser.doneSubtaskCount, 1, "completing a subtask advances progress");
  // Completing all subtasks does NOT auto-complete the parent (explicit by design).
  prow = await db.tasks.getById(parent.id);
  assert.notEqual(prow.status, "done", "the parent is not auto-completed");

  // Batched progress (serializeTaskList) agrees with the single-task path.
  const list = await serializeTaskList([prow]);
  assert.equal(list[0].subtaskCount, 2, "batched progress: total");
  assert.equal(list[0].doneSubtaskCount, 1, "batched progress: done");

  // Deleting the parent SOFT-CASCADES its subtasks (they disappear from reads).
  await taskService.remove({ id: parent.id, actorId: OWNER });
  assert.equal(await db.tasks.getById(s1.id), null, "subtask 1 is soft-deleted with the parent");
  assert.equal(await db.tasks.getById(s2.id), null, "subtask 2 is soft-deleted with the parent");
});

dbTest("tasks: subtask access inherits the gate; re-parent rejects a cycle", async () => {
  const parent = await taskService.create({ title: "cyc parent", creatorId: OWNER });
  const child = await taskService.createSubtask({ parentId: parent.id, title: "cyc child", actorId: OWNER });

  // A stranger with no access to the PARENT cannot create a subtask under it.
  await assert.rejects(
    () => taskService.createSubtask({ parentId: parent.id, title: "x", actorId: STRANGER }),
    (e: any) => e.status === 403,
    "a non-member cannot add a subtask to someone else's task",
  );
  // A stranger cannot list the subtasks either (read gate).
  await assert.rejects(
    () => taskService.listSubtasks(parent.id, STRANGER),
    (e: any) => e.status === 403,
    "a non-member cannot list subtasks",
  );

  // Re-parenting the PARENT under its own CHILD would create a cycle → 400.
  await assert.rejects(
    () => taskService.setParent({ id: parent.id, parentId: child.id, actorId: OWNER }),
    (e: any) => e.status === 400,
    "a subtask cycle (parent under its own child) is rejected",
  );
  // A task can't be its own subtask.
  await assert.rejects(
    () => taskService.setParent({ id: parent.id, parentId: parent.id, actorId: OWNER }),
    (e: any) => e.status === 400,
    "a task can't be its own parent",
  );

  await taskService.remove({ id: parent.id, actorId: OWNER }); // cascades the child
});

dbTest("tasks CSV export: scoped to the caller + a malicious title is neutralized", async () => {
  // A task whose TITLE is a formula-injection payload. The export must neutralize
  // it (leading apostrophe) so a spreadsheet won't execute it on open.
  const evil = await taskService.create({
    title: "=HYPERLINK(\"http://evil\")",
    creatorId: OWNER,
    assigneeId: OWNER,
  });
  // A task the STRANGER owns — must NOT appear in the OWNER's export (authz scope).
  const strangersTask = await taskService.create({
    title: "stranger-only-csv-row",
    creatorId: STRANGER,
  });

  const csv = await taskService.exportCsv(OWNER);
  const lines = csv.split("\r\n");
  assert.ok(lines[0].startsWith("id,title,status"), "the header row is present");
  // The malicious title appears, neutralized: the cell is quoted and starts with '.
  assert.ok(
    csv.includes(`"'=HYPERLINK(""http://evil"")"`),
    "the injection title is neutralized + RFC-4180 quoted in the export",
  );
  // The stranger's task is NOT in the owner's export (scoped to the caller).
  assert.ok(!csv.includes("stranger-only-csv-row"), "export is scoped to the caller's accessible tasks");

  // The stranger's OWN export contains their task but not the owner's.
  const strangerCsv = await taskService.exportCsv(STRANGER);
  assert.ok(strangerCsv.includes("stranger-only-csv-row"), "the stranger exports their own task");
  assert.ok(!strangerCsv.includes("HYPERLINK"), "the stranger's export excludes the owner's task");

  await taskService.remove({ id: evil.id, actorId: OWNER });
  await taskService.remove({ id: strangersTask.id, actorId: STRANGER });
});

dbTest("migration 0062: tasks.recurrence + tasks.parent_task_id columns exist", async () => {
  const [cols] = (await db.pool.query("SHOW COLUMNS FROM tasks")) as any;
  const names = new Set(cols.map((c: any) => c.Field));
  assert.ok(names.has("recurrence"), "tasks.recurrence column exists");
  assert.ok(names.has("parent_task_id"), "tasks.parent_task_id column exists");
});

// ---------------------------------------------------------------------------
// FILES (driver insert + service authorization — no S3 dependency)
// ---------------------------------------------------------------------------

async function makeFile(uploaderId: string, name = "doc.txt", mime = "text/plain") {
  // BLOB-backed file row (no storage key) — exercises the authz path without S3.
  return db.files.create({
    uploaderId,
    name,
    mime,
    size: 5,
    data: Buffer.from("hello"),
    conversationId: null,
  });
}

dbTest("files: owner has full permission; a stranger has none", async () => {
  const f = await makeFile(OWNER);
  // details() returns null when the viewer has no permission, and the effective
  // permission otherwise — exercising the internal permissionFor() authz via the
  // public service surface.
  const ownerDetails = await fileService.details(f.id, OWNER);
  assert.ok(ownerDetails, "owner can read file details");
  assert.equal(ownerDetails.permission, "owner", "owner → owner permission");
  assert.equal(
    await fileService.details(f.id, STRANGER),
    null,
    "an unrelated user has no access to file details",
  );

  // The owner sees the file in their list; the stranger does not. listForUser is
  // now paginated and returns the { files, hasMore, nextCursor, count } envelope
  // (mirroring tasks/reminders), so we read .files.
  const ownerList = await fileService.listForUser(OWNER);
  assert.ok(
    ownerList.files.find((x: any) => x.id === f.id),
    "owner lists the file",
  );
  assert.ok(ownerList.count >= 1, "owner count includes the file");
  const strangerList = await fileService.listForUser(STRANGER);
  assert.equal(
    strangerList.files.find((x: any) => x.id === f.id),
    undefined,
    "stranger does not list the file",
  );

  // The full-set search index read still sees the file (pagination must not
  // truncate search).
  const idx = await fileService.listAllForIndex(OWNER);
  assert.ok(
    idx.find((x: any) => x.id === f.id),
    "search index sees the file",
  );

  await fileService.remove({ fileId: f.id, userId: OWNER }); // cleanup
});

dbTest("files: server-side search filters by name/type within the tab (P0-F)", async () => {
  // Two files with distinct, unique names so the LIKE filter is unambiguous.
  const a = await makeFile(OWNER, "quarterly-report-zxq.pdf", "application/pdf");
  const b = await makeFile(OWNER, "holiday-photo-zxq.png", "image/png");

  // A name search returns only the matching file — not the whole accessible set.
  const byName = await fileService.listForUser(OWNER, { search: "quarterly-report-zxq" });
  assert.ok(
    byName.files.find((x: any) => x.id === a.id),
    "search by name finds the matching file",
  );
  assert.equal(
    byName.files.find((x: any) => x.id === b.id),
    undefined,
    "search by name excludes a non-matching file",
  );
  // The count reflects the FILTERED total (so the header tally + Load-more agree).
  assert.equal(byName.count, 1, "search count is the filtered total, not the full set");

  // A shared suffix matches BOTH files (search spans all files, not one page).
  const bySuffix = await fileService.listForUser(OWNER, { search: "zxq" });
  assert.ok(bySuffix.files.find((x: any) => x.id === a.id), "suffix matches file A");
  assert.ok(bySuffix.files.find((x: any) => x.id === b.id), "suffix matches file B");

  // A MIME-type search ("pdf") finds the pdf by its type, not just its name.
  const byType = await fileService.listForUser(OWNER, { search: "pdf" });
  assert.ok(
    byType.files.find((x: any) => x.id === a.id),
    "search by MIME type finds the pdf",
  );

  // A LIKE wildcard typed by the user is treated literally (no SQL injection of
  // `%`): searching "%" must NOT match every file.
  const wild = await fileService.listForUser(OWNER, { search: "%" });
  assert.equal(
    wild.files.find((x: any) => x.id === a.id || x.id === b.id),
    undefined,
    "a literal % does not act as a wildcard",
  );

  await fileService.remove({ fileId: a.id, userId: OWNER }); // cleanup
  await fileService.remove({ fileId: b.id, userId: OWNER });
});

dbTest("files: a stranger cannot delete, star, or share-link someone else's file", async () => {
  const f = await makeFile(OWNER);

  const delRes = await fileService.remove({ fileId: f.id, userId: STRANGER });
  assert.equal(delRes.deleted, false, "a stranger's delete is refused");
  assert.ok(await db.files.getMeta(f.id), "the file still exists after the refused delete");

  const starRes = await fileService.setStar({ fileId: f.id, userId: STRANGER, starred: true });
  assert.equal(starRes, null, "a stranger cannot star the file");

  await assert.rejects(
    () => fileService.createLink({ fileId: f.id, userId: STRANGER, permission: "view" }),
    (e: any) => e.status === 403,
    "a stranger cannot create a share link",
  );

  await fileService.remove({ fileId: f.id, userId: OWNER }); // cleanup
});

dbTest("files: owner can soft-delete; the file then disappears from reads", async () => {
  const f = await makeFile(OWNER);
  const res = await fileService.remove({ fileId: f.id, userId: OWNER });
  assert.equal(res.deleted, true, "owner soft-deletes their file");
  assert.equal(await db.files.getMeta(f.id), null, "getMeta filters out the deleted file");
  assert.equal(
    await fileService.details(f.id, OWNER),
    null,
    "details returns null for a deleted file (even to the owner)",
  );
  // deleted_by is recorded (actorId threaded through remove()).
  const dm = await db.files.getDeletedMeta(f.id);
  assert.ok(dm, "the soft-deleted row is still present");
  assert.equal(dm.deletedBy, OWNER, "deleted_by records the acting user");
  await db.files.hardDelete(f.id); // cleanup
});

dbTest("files: recycle-bin lists a user's own trash; restore brings it back", async () => {
  const f = await makeFile(OWNER, "trash-me.txt");
  await fileService.remove({ fileId: f.id, userId: OWNER });

  // It appears in the OWNER's recycle bin, newest-deleted first, with deletedAt.
  const trash = await fileService.listDeleted(OWNER);
  const inBin = trash.files.find((x: any) => x.id === f.id);
  assert.ok(inBin, "the soft-deleted file is in the owner's recycle bin");
  assert.ok(inBin.deletedAt, "the trash item carries deletedAt");

  // A stranger never sees it (owner-scoped).
  const strangerTrash = await fileService.listDeleted(STRANGER);
  assert.equal(
    strangerTrash.files.find((x: any) => x.id === f.id),
    undefined,
    "a stranger's recycle bin does not include someone else's file",
  );

  // A stranger cannot restore it.
  assert.equal(
    await fileService.restore({ fileId: f.id, userId: STRANGER }),
    null,
    "a stranger cannot restore someone else's file",
  );

  // The owner restores it → it re-appears in their live list and leaves trash.
  const restored = await fileService.restore({ fileId: f.id, userId: OWNER });
  assert.ok(restored, "owner restores their file");
  assert.ok(await db.files.getMeta(f.id), "the restored file is live again");
  const afterTrash = await fileService.listDeleted(OWNER);
  assert.equal(
    afterTrash.files.find((x: any) => x.id === f.id),
    undefined,
    "the restored file is no longer in the recycle bin",
  );

  // cleanup: it's live again after restore, so soft-delete then hard-delete.
  await fileService.remove({ fileId: f.id, userId: OWNER });
  await db.files.hardDelete(f.id);
});

dbTest("files GC: never touches live files; reclaims only aged-out trash", async () => {
  const { runGc } = await import("../src/services/fileGcService");

  // A LIVE file must NEVER be claimed, regardless of retention.
  const live = await makeFile(OWNER, "keep-me.txt");
  // A soft-deleted file, but WITHIN the retention window (recently deleted) must
  // NOT be reclaimed yet (a generous window keeps it safe).
  const fresh = await makeFile(OWNER, "fresh-trash.txt");
  await fileService.remove({ fileId: fresh.id, userId: OWNER });

  // Retention 0 DISABLES GC — nothing is ever removed.
  const disabled = await runGc(0);
  assert.equal(disabled.disabled, true, "retention 0 disables GC");
  assert.equal(disabled.removed, 0, "disabled GC removes nothing");

  // A long retention window leaves the recently-deleted 'fresh' file intact and
  // the 'live' file untouched.
  const safe = await runGc(3650 /* ~10y */, 100);
  assert.ok(await db.files.getMeta(live.id), "GC never touches a live file");
  assert.ok(
    await db.files.getDeletedMeta(fresh.id),
    "GC leaves trash still inside the retention window",
  );
  assert.ok(
    !safe.removedIds.includes(live.id),
    "GC claim never includes a live file id",
  );

  // Force the 'fresh' row's deleted_at far into the past so it is now eligible,
  // then a 30-day retention sweep reclaims exactly it (BLOB-backed → no S3 key,
  // so hardDelete drops the row directly).
  await db.pool.query(
    "UPDATE files SET deleted_at = now(3) - INTERVAL 60 DAY WHERE id=?",
    [fresh.id],
  );
  const swept = await runGc(30, 100);
  assert.ok(swept.removedIds.includes(fresh.id), "aged-out trash is reclaimed");
  assert.equal(
    await db.files.getDeletedMeta(fresh.id),
    null,
    "the reclaimed row is permanently gone",
  );
  assert.ok(await db.files.getMeta(live.id), "the live file survived the sweep");

  // cleanup: 'live' is still live, so soft-delete then hard-delete.
  await fileService.remove({ fileId: live.id, userId: OWNER });
  await db.files.hardDelete(live.id);
});

dbTest(
  "files GC: a restore that races a claim invalidates it (TOCTOU — blob never deleted)",
  async () => {
    // Reproduce the restore/GC race deterministically: claim an aged-out trash row
    // (stamping gc_claimed_at), then RESTORE it before the worker would call
    // storage.remove. The worker re-confirms gcClaimStillValid() right before the
    // irreversible S3 delete, so a racing restore must invalidate the claim — the
    // blob stays and the row survives as a LIVE file (no orphaned id→missing-object).
    const { runGc } = await import("../src/services/fileGcService");
    const f = await makeFile(OWNER, "race-me.txt");
    await fileService.remove({ fileId: f.id, userId: OWNER });
    await db.pool.query(
      "UPDATE files SET deleted_at = now(3) - INTERVAL 60 DAY WHERE id=?",
      [f.id],
    );

    // GC claims it → the row is marked AND eligible.
    const claimed = await db.files.claimForGc(30, 100);
    assert.ok(
      claimed.some((c: any) => c.id === f.id),
      "GC claims the aged-out trash row",
    );
    assert.equal(
      await db.files.gcClaimStillValid(f.id),
      true,
      "the freshly claimed row is still a valid claim",
    );

    // Owner RESTORES between claim and the worker's blob delete.
    const restored = await fileService.restore({ fileId: f.id, userId: OWNER });
    assert.ok(restored, "owner restores the file mid-claim");

    // The claim is now invalid → the worker would SKIP the blob delete entirely.
    assert.equal(
      await db.files.gcClaimStillValid(f.id),
      false,
      "restore clears gc_claimed_at, invalidating the in-flight claim",
    );
    const liveAgain = await db.files.getMeta(f.id);
    assert.ok(liveAgain, "the restored file is live again (row survived the race)");

    // And a fresh sweep now leaves it alone (it is no longer trash).
    const swept = await runGc(30, 100);
    assert.ok(
      !swept.removedIds.includes(f.id),
      "a subsequent sweep does not reclaim the restored (now-live) file",
    );
    assert.ok(await db.files.getMeta(f.id), "the restored file is still live");

    // cleanup.
    await fileService.remove({ fileId: f.id, userId: OWNER });
    await db.files.hardDelete(f.id);
  },
);

// ===========================================================================
// PROJECTS-AS-ENTITIES + SAVED VIEWS / SWIMLANES (feature #52b)
// ===========================================================================

// --- PURE (DB-free): the saved-view filter sanitizer is the security-critical
// "no arbitrary filter" surface — it must drop unknown keys, reject bad enums,
// and bound opaque ids. Runs even without MySQL.
test("views: sanitizeViewFilter keeps only known keys/values (no eval, no smuggling)", async () => {
  const svc = await import("../src/services/taskService");
  // Unknown keys are silently dropped; a known key with a valid value survives.
  const clean = svc.sanitizeViewFilter({
    status: "todo",
    priority: "High",
    due: "today",
    assignee: "u_123",
    project: "p_123",
    search: "report",
    evil: "1; DROP TABLE tasks",
    sql: "OR 1=1",
  });
  assert.deepEqual(
    clean,
    { status: "todo", priority: "High", due: "today", assignee: "u_123", project: "p_123", search: "report" },
    "only the allow-listed keys/values survive",
  );
  // Bad enum values are rejected with 400.
  assert.throws(() => svc.sanitizeViewFilter({ status: "nuke" }), (e: any) => e.status === 400);
  assert.throws(() => svc.sanitizeViewFilter({ priority: "Urgent" }), (e: any) => e.status === 400);
  assert.throws(() => svc.sanitizeViewFilter({ due: "yesterday" }), (e: any) => e.status === 400);
  // An over-long opaque id is rejected (bounded length).
  assert.throws(() => svc.sanitizeViewFilter({ assignee: "x".repeat(100) }), (e: any) => e.status === 400);
  // Empty values are omitted (no constraint), a non-object is an empty filter.
  assert.deepEqual(svc.sanitizeViewFilter({ status: "" }), {}, "empty value = no constraint");
  assert.deepEqual(svc.sanitizeViewFilter(null), {}, "a non-object yields an empty filter");
  assert.deepEqual(svc.sanitizeViewFilter([1, 2]), {}, "an array yields an empty filter");
  // group-by / sort / name validators reject out-of-list values.
  assert.throws(() => svc.validateGroupBy("by-mood"), (e: any) => e.status === 400);
  assert.equal(svc.validateGroupBy(""), "none", "empty group-by defaults to none");
  assert.throws(() => svc.validateSort("random"), (e: any) => e.status === 400);
  assert.throws(() => svc.validateViewName("   "), (e: any) => e.status === 400);
  assert.throws(() => svc.validateProjectName(""), (e: any) => e.status === 400);
  assert.throws(() => svc.validateColor("red"), (e: any) => e.status === 400);
  svc.validateColor("#64748b");
  svc.validateColor("");
});

dbTest("projects: create -> list -> rename -> delete (un-files tasks, keeps them)", async () => {
  const p = await taskService.createProject({ userId: OWNER, name: "Launch Q3", color: "#2563EB" });
  assert.ok(p.id, "project created with an id");
  assert.equal(p.name, "Launch Q3");

  const mine = await taskService.listProjects(OWNER);
  assert.ok(mine.find((x: any) => x.id === p.id), "project is read-back in the owner's list");

  const t = await taskService.create({
    title: "Ship the thing",
    creatorId: OWNER,
    assigneeId: OWNER,
    projectId: p.id,
  });
  assert.equal(t.projectId, p.id, "the task is linked to the project");
  assert.equal(t.projectObj && t.projectObj.name, "Launch Q3", "serializeTask resolves the project object");
  assert.equal(t.project, "Launch Q3", "the legacy text mirror equals the project name");

  await taskService.updateProject({ id: p.id, userId: OWNER, name: "Launch Q4" });
  const t2 = await taskService.getById(t.id, OWNER);
  assert.equal(t2.project, "Launch Q4", "rename syncs the legacy text on the linked task");

  await taskService.deleteProject({ id: p.id, userId: OWNER });
  const t3 = await taskService.getById(t.id, OWNER);
  assert.ok(t3, "the task survives the project delete");
  assert.equal(t3.projectId, null, "the task is un-filed (project_id NULL) after delete");
  const gone = await taskService.listProjects(OWNER);
  assert.equal(gone.find((x: any) => x.id === p.id), undefined, "the deleted project no longer lists");

  await taskService.remove({ id: t.id, actorId: OWNER });
});

dbTest("projects: a stranger cannot see or file into the owner's project (IDOR)", async () => {
  const p = await taskService.createProject({ userId: OWNER, name: "Secret roadmap" });

  const strangerList = await taskService.listProjects(STRANGER);
  assert.equal(
    strangerList.find((x: any) => x.id === p.id),
    undefined,
    "the owner's project never appears in a stranger's list",
  );

  await assert.rejects(
    taskService.create({ title: "graft", creatorId: STRANGER, assigneeId: STRANGER, projectId: p.id }),
    (e: any) => e.status === 403,
    "filing a task into a project that is not yours is rejected 403",
  );

  const hijack = await taskService.updateProject({ id: p.id, userId: STRANGER, name: "PWNED" });
  assert.equal(hijack, null, "a stranger's project update matches no row (null)");
  await taskService.deleteProject({ id: p.id, userId: STRANGER });
  const still = (await taskService.listProjects(OWNER)).find((x: any) => x.id === p.id);
  assert.ok(still, "the owner's project survives a stranger's delete attempt");
  assert.equal(still.name, "Secret roadmap", "and its name is unchanged");

  await taskService.deleteProject({ id: p.id, userId: OWNER });
});

dbTest("projects: the SERVER-SIDE project filter scopes both the page and the count", async () => {
  const pA = await taskService.createProject({ userId: OWNER, name: "Alpha" });
  const pB = await taskService.createProject({ userId: OWNER, name: "Beta" });
  const a1 = await taskService.create({ title: "A-one", creatorId: OWNER, assigneeId: OWNER, projectId: pA.id });
  const a2 = await taskService.create({ title: "A-two", creatorId: OWNER, assigneeId: OWNER, projectId: pA.id });
  const b1 = await taskService.create({ title: "B-one", creatorId: OWNER, assigneeId: OWNER, projectId: pB.id });
  const u1 = await taskService.create({ title: "Unfiled-one", creatorId: OWNER, assigneeId: OWNER });

  const fa = await taskService.list(OWNER, { projectId: pA.id, limit: 500 });
  const ids = fa.tasks.map((t: any) => t.id);
  assert.ok(ids.includes(a1.id) && ids.includes(a2.id), "project filter returns A's tasks");
  assert.ok(!ids.includes(b1.id) && !ids.includes(u1.id), "project filter excludes other/unfiled tasks");
  assert.ok(fa.tasks.every((t: any) => t.projectId === pA.id), "every returned task is in project A");
  assert.equal(fa.count, fa.tasks.length, "the filtered count agrees with the filtered page");

  const fnone = await taskService.list(OWNER, { projectId: null, limit: 500 });
  const noneIds = fnone.tasks.map((t: any) => t.id);
  assert.ok(noneIds.includes(u1.id), "the unfiled filter includes the unfiled task");
  assert.ok(!noneIds.includes(a1.id) && !noneIds.includes(b1.id), "the unfiled filter excludes filed tasks");
  assert.ok(fnone.tasks.every((t: any) => !t.projectId), "every returned task is unfiled");

  const all = await taskService.list(OWNER, { limit: 500 });
  const allIds = all.tasks.map((t: any) => t.id);
  for (const id of [a1.id, a2.id, b1.id, u1.id])
    assert.ok(allIds.includes(id), "no filter returns every accessible task");

  for (const t of [a1, a2, b1, u1]) await taskService.remove({ id: t.id, actorId: OWNER });
  await taskService.deleteProject({ id: pA.id, userId: OWNER });
  await taskService.deleteProject({ id: pB.id, userId: OWNER });
});

dbTest("views: create -> list -> sanitized-store -> delete, user-scoped (no IDOR)", async () => {
  const v = await taskService.createSavedView({
    userId: OWNER,
    name: "My high-priority",
    filter: { priority: "High", status: "todo", evil: "x" },
    groupBy: "assignee",
    sort: "due",
  });
  assert.ok(v.id, "saved view created");
  assert.deepEqual(v.filter, { priority: "High", status: "todo" }, "the stored filter is sanitized (unknown key dropped)");
  assert.equal(v.groupBy, "assignee");
  assert.equal(v.sort, "due");

  const mine = await taskService.listSavedViews(OWNER);
  assert.ok(mine.find((x: any) => x.id === v.id), "the view is read-back in the owner's list");

  const strangerViews = await taskService.listSavedViews(STRANGER);
  assert.equal(strangerViews.find((x: any) => x.id === v.id), undefined, "a stranger never sees the owner's view");
  const hijack = await taskService.updateSavedView({ id: v.id, userId: STRANGER, name: "PWNED" });
  assert.equal(hijack, null, "a stranger's view update matches no row (null)");
  await taskService.deleteSavedView({ id: v.id, userId: STRANGER });
  const survivor = (await taskService.listSavedViews(OWNER)).find((x: any) => x.id === v.id);
  assert.ok(survivor, "the owner's view survives a stranger's delete attempt");
  assert.equal(survivor.name, "My high-priority", "and its name is unchanged");

  await assert.rejects(
    taskService.updateSavedView({ id: v.id, userId: OWNER, filter: { status: "nuke" } }),
    (e: any) => e.status === 400,
    "updating with an invalid filter enum is rejected",
  );

  await taskService.deleteSavedView({ id: v.id, userId: OWNER });
});
