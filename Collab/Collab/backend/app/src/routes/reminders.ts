import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, shared, db } from "../platform";
import authMiddleware from "../middleware/auth";
import { broadcast } from "../realtime/socket";
import {
  listFolders,
  createFolder,
  deleteFolder,
  renameFolder,
  listReminders,
  createReminder,
  toggleReminder,
  updateReminder,
  deleteReminder,
  setReminderStatus,
  snoozeReminder,
  completeReminder,
  bulk,
} from "../services/reminderService";
import { parseReminder } from "../services/reminderNL";
const { EVENTS } = shared;
const emit = (req) => {
  const io = req.app.get("io");
  if (io)
    io.to(broadcast.userRoom(req.user.userId)).emit(
      EVENTS.REMINDER_CHANGED,
      {},
    );
};

router.use(authMiddleware);
// folders (declared before /:id reminder routes)
router.get("/folders", async (req, res) =>
  res.json(ok(await listFolders(req.user.userId))),
);
router.post("/folders", async (req, res) => {
  const f = await createFolder({
    userId: req.user.userId,
    name: ((req.body || {}).name || "New List").trim(),
    icon: (req.body || {}).icon,
  });
  emit(req);
  res.json(ok(f));
});
router.patch("/folders/:id", async (req, res) => {
  const f = await renameFolder({
    id: req.params.id,
    userId: req.user.userId,
    name: (req.body || {}).name,
    icon: (req.body || {}).icon,
  });
  emit(req);
  res.json(ok(f));
});
router.delete("/folders/:id", async (req, res) => {
  const r = await deleteFolder({ id: req.params.id, userId: req.user.userId });
  emit(req);
  res.json(ok(r));
});
// reminders
// GET /api/reminders?limit=&cursor= — paginated. Returns { reminders, hasMore,
// nextCursor, count, counts }. `cursor` is the opaque base64 keyset token from
// the previous page; `limit` is clamped server-side. `count` is the total live
// count and `counts` the per-smart-view / per-folder / open totals (so badges
// never undercount once the client only holds a page). Mirrors GET /api/tasks.
router.get("/", async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  let cursor: any = null;
  if (req.query.cursor) {
    try {
      cursor = JSON.parse(
        Buffer.from(String(req.query.cursor), "base64").toString("utf8"),
      );
    } catch {
      cursor = null; // a malformed cursor just restarts from page 1
    }
  }
  const page = await listReminders(req.user.userId, { limit, cursor });
  res.json(
    ok({
      reminders: page.reminders,
      hasMore: page.hasMore,
      count: page.count,
      counts: page.counts,
      // Re-encode the keyset as an opaque token the client passes back verbatim.
      nextCursor: page.nextCursor
        ? Buffer.from(JSON.stringify(page.nextCursor), "utf8").toString("base64")
        : null,
    }),
  );
});
router.post("/", async (req, res) => {
  const b = req.body || {};
  // AUDIT #31: for a RECURRING reminder, resolve the series timezone so occurrences
  // expand DST-correctly — prefer the IANA zone the modal sends, else the user's
  // profile timezone. Skipped for one-offs (createReminder ignores tz there anyway).
  const recurring = !!(b.recurrenceRule || (b.recurrence && b.recurrence !== "none"));
  let timeZone = typeof b.timeZone === "string" && b.timeZone ? b.timeZone : null;
  if (recurring && !timeZone) {
    try {
      const u = await db.users.getById(req.user.userId);
      if (u && (u as any).timezone) timeZone = (u as any).timezone;
    } catch {
      /* fall back to server-local (NULL tz) if the lookup fails */
    }
  }
  const r = await createReminder({
    userId: req.user.userId,
    text: (b.text || "").trim(),
    folderId: b.folderId || null,
    dueLabel: b.dueLabel || null,
    description: b.description || null,
    dueAt: b.dueAt || null,
    priority: b.priority || "Medium",
    recurrence: b.recurrence || "none",
    // CUSTOM LEAD TIME + STRUCTURED RECURRENCE (#53). Both optional/nullable; the
    // service validates them (validateLeadMinutes / validateRecurrenceRule).
    leadMinutes: b.leadMinutes ?? null,
    recurrenceRule: b.recurrenceRule ?? null,
    timezone: timeZone,
  });
  emit(req);
  res.json(ok(r));
});
// NL QUICK-ADD (#53): parse one line of natural language ("remind me to call John
// tomorrow at 3pm", "every Monday 9am standup") into { text, dueAt, recurrence,
// recurrenceRule }. The hand-rolled parser is dependency-free + server-side. When
// the parse is CONFIDENT we create the reminder and return it ({ created:true,
// reminder }). When it's AMBIGUOUS (text but no concrete time) we DO NOT create —
// we return the parsed draft ({ created:false, draft }) so the client opens the
// full modal pre-filled. Either way the SERVER still validates via createReminder.
router.post("/quick", async (req, res) => {
  const b = req.body || {};
  // TIMEZONE-CORRECT parse (#53): resolve clock/relative times in the USER's zone,
  // not the server's (the prod box is UTC). Prefer the IANA zone the client sends
  // (Intl.DateTimeFormat().resolvedOptions().timeZone); fall back to the numeric
  // getTimezoneOffset() the client also sends, then to the user's profile timezone.
  // With none of these the parser keeps its legacy server-local behaviour.
  let timeZone =
    typeof b.timeZone === "string" && b.timeZone ? b.timeZone : null;
  const tzOffsetMinutes =
    b.tzOffsetMinutes != null && Number.isFinite(Number(b.tzOffsetMinutes))
      ? Number(b.tzOffsetMinutes)
      : null;
  // Profile-timezone fallback: only read the user row when the client sent neither a
  // zone nor an offset, so the common path stays a single insert with no extra query.
  if (!timeZone && tzOffsetMinutes == null) {
    try {
      const u = await db.users.getById(req.user.userId);
      if (u && (u as any).timezone) timeZone = (u as any).timezone;
    } catch {
      /* fall back to server-local parse if the lookup fails */
    }
  }
  const parsed = parseReminder(String(b.text || ""), { timeZone, tzOffsetMinutes });
  if (!parsed || !parsed.text.trim()) {
    res.status(400).json({ ok: false, error: "Could not parse a reminder." });
    return;
  }
  if (parsed.ambiguous) {
    // Hand back the draft for the client to confirm in the modal; nothing persisted.
    res.json(ok({ created: false, draft: parsed }));
    return;
  }
  const folderId = b.folderId || null;
  const r = await createReminder({
    userId: req.user.userId,
    text: parsed.text,
    folderId,
    dueLabel: null,
    description: null,
    dueAt: parsed.dueAt,
    priority: "Medium",
    recurrence: parsed.recurrence,
    recurrenceRule: parsed.recurrenceRule,
    leadMinutes: null,
    // AUDIT #31: store the zone the occurrence was parsed in so it keeps expanding
    // there (the parser already resolved timeZone above).
    timezone: timeZone,
  });
  emit(req);
  res.json(ok({ created: true, reminder: r }));
});
router.post("/bulk", async (req, res) => {
  const b = req.body || {};
  const r = await bulk({
    ids: b.ids || [],
    action: b.action,
    value: b.value,
    userId: req.user.userId,
  });
  emit(req);
  res.json(ok(r));
});
router.post("/:id/toggle", async (req, res) => {
  const r = await toggleReminder({
    id: req.params.id,
    userId: req.user.userId,
  });
  emit(req);
  res.json(ok(r));
});
router.post("/:id/status", async (req, res) => {
  const r = await setReminderStatus({
    id: req.params.id,
    userId: req.user.userId,
    status: (req.body || {}).status,
  });
  emit(req);
  res.json(ok(r));
});
// Snooze: re-arm to fire again now + `minutes` (default 10). Ownership-scoped in
// the service via user_id. Re-uses the firing engine (clears notified_at) — does
// NOT bypass/duplicate it.
router.post("/:id/snooze", async (req, res) => {
  const r = await snoozeReminder({
    id: req.params.id,
    userId: req.user.userId,
    minutes: (req.body || {}).minutes,
  });
  emit(req);
  res.json(ok(r));
});
// Complete from a notification action — mark done (spawns the next recurring
// occurrence exactly once via the idempotent spawnNext).
router.post("/:id/complete", async (req, res) => {
  const r = await completeReminder({
    id: req.params.id,
    userId: req.user.userId,
  });
  emit(req);
  res.json(ok(r));
});
router.patch("/:id", async (req, res) => {
  const r = await updateReminder({
    id: req.params.id,
    userId: req.user.userId,
    patch: req.body || {},
  });
  emit(req);
  res.json(ok(r));
});
router.delete("/:id", async (req, res) => {
  const r = await deleteReminder({
    id: req.params.id,
    userId: req.user.userId,
  });
  emit(req);
  res.json(ok(r));
});
export default router;
