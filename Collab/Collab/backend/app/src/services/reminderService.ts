import { db } from "../platform";
import { serializeReminder, serializeFolder } from "../serialize";
import {
  validateRecurrenceRule,
  nextOccurrenceAfter,
  ruleFromLegacy,
} from "./recurrenceRule";

// ---------------------------------------------------------------------------
// SERVER-SIDE VALIDATION (P0-D): the reminders API previously persisted garbage —
// arbitrary priority / recurrence / status strings and unparseable due dates.
// These allow-lists are the SERVER's authority and MIRROR the real Reminders UI
// (RemindersView.tsx + the detail/create modal): the three priority levels, the
// four recurrence options the create/edit selects offer (which nextDue() also
// understands), and the three lifecycle statuses the status/toggle/bulk paths
// produce. Keep them in sync with that file if the product adds an option.
//
// LENIENT BY DESIGN: validation applies to INCOMING create/update payloads only.
// A field that is absent from the patch is left untouched, so editing a reminder
// that already holds a legacy value (e.g. a status the UI no longer offers) never
// fails just because an UNRELATED field is patched.
const REMINDER_PRIORITIES = new Set(["High", "Medium", "Low"]);
const REMINDER_RECURRENCES = new Set(["none", "daily", "weekly", "monthly"]);
const REMINDER_STATUSES = new Set(["open", "done", "archived"]);
const TEXT_MAX = 1000;

const badRequest = (message: string) => {
  const e: any = new Error(message);
  e.status = 400;
  return e;
};

function validatePriority(priority: any): void {
  if (priority != null && priority !== "" && !REMINDER_PRIORITIES.has(priority))
    throw badRequest(`Invalid reminder priority: "${priority}".`);
}
function validateRecurrence(recurrence: any): void {
  if (
    recurrence != null &&
    recurrence !== "" &&
    !REMINDER_RECURRENCES.has(recurrence)
  )
    throw badRequest(`Invalid reminder recurrence: "${recurrence}".`);
}
function validateStatus(status: any): void {
  if (status != null && status !== "" && !REMINDER_STATUSES.has(status))
    throw badRequest(`Invalid reminder status: "${status}".`);
}
// Accepts null/"" (clear the due date) but rejects an unparseable value so the
// firing scan / state buckets never have to reason about garbage timestamps.
function validateDueAt(dueAt: any): void {
  if (dueAt == null || dueAt === "") return;
  const t = Date.parse(dueAt);
  if (!Number.isFinite(t)) throw badRequest("Invalid reminder due date.");
}
// CUSTOM LEAD TIME (#53): minutes before the due time to NOTIFY. Accepts null/""
// (no lead → fire at due) and any non-negative integer up to a week (the picker
// offers 0/5/10/30/60/1440 but we accept any sane value the API receives). NULL
// and 0 are equivalent (fire at due). Rejects negatives / non-integers / absurd
// values so the firing predicate never gets garbage.
const LEAD_MAX = 7 * 24 * 60; // 1 week
function validateLeadMinutes(lead: any): void {
  if (lead == null || lead === "") return;
  const n = Number(lead);
  if (!Number.isInteger(n) || n < 0 || n > LEAD_MAX)
    throw badRequest("Invalid reminder lead time.");
}
// Required, non-empty, length-bounded reminder text (the DB column silently
// truncates otherwise). Returns the trimmed value.
function validateText(raw: any): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) throw badRequest("Reminder text is required.");
  if (text.length > TEXT_MAX)
    throw badRequest(`Reminder text must be ${TEXT_MAX} characters or fewer.`);
  return text;
}

function nextDue(dueAtIso, recurrence) {
  if (!dueAtIso || recurrence === "none") return null;
  let d = new Date(dueAtIso);
  if (Number.isNaN(d.getTime())) return null;
  const now = Date.now();
  const advance = () => {
    if (recurrence === "daily") d = new Date(d.getTime() + 86400000);
    else if (recurrence === "weekly") d = new Date(d.getTime() + 7 * 86400000);
    else if (recurrence === "monthly") {
      const n = new Date(d);
      n.setMonth(n.getMonth() + 1);
      d = n;
    } else return false;
    return true;
  };
  if (!advance()) return null;
  let guard = 0;
  while (d.getTime() <= now && guard++ < 1000) {
    if (!advance()) break;
  }
  return d.toISOString();
}
// Roll a recurring reminder forward to its next occurrence.
//
// IDEMPOTENT: this is intentionally called from BOTH the fire path
// (reminderFireService, so an un-completed recurring reminder keeps reminding)
// AND the completion path (toggle/setStatus/bulk, so a completed-before-it-fired
// recurring reminder still spawns its next). Either of those alone is correct;
// running BOTH used to create the next occurrence TWICE. The next occurrence is
// created EXACTLY once no matter how many paths fire.
//
// The existence-check + insert is done ATOMICALLY in the driver
// (spawnNextOccurrence: serialized via a MySQL named advisory lock keyed by the
// series identity + next due instant), so even a sub-millisecond race between
// the fire-tick and a concurrent completion can't double-spawn — the earlier
// non-atomic occurrenceExists()-then-create() left that narrow concurrent
// window open. No schema change / UNIQUE index is involved (existing
// done/deleted rows may legitimately share a due_at). The current occurrence's
// exactly-once FIRING (claimDue / notified_at) is untouched — this only governs
// the SPAWN.
// Compute a recurring reminder's NEXT due instant. Prefers the STRUCTURED rule
// (#53 — interval / weekly days / monthly day-vs-nth-weekday / yearly / end
// never-after-on, shared with meetings via recurrenceRule.nextOccurrenceAfter);
// falls back to a structured rule derived from the legacy enum (so a pre-#53 row
// with only `recurrence` still rolls forward), and finally to the legacy stepper.
// Returns null when the series has no further occurrence (end reached) or isn't
// recurring. `afterMs` defaults to now so we always land in the future.
function computeNextDue(r: any, afterMs = Date.now()): string | null {
  if (!r || !r.dueAt) return null;
  const rule = r.recurrenceRule || ruleFromLegacy(r.recurrence);
  // AUDIT #31: expand occurrences in the SERIES timezone (null → legacy server-
  // local, byte-identical) so recurring reminders don't drift ±1h across DST.
  if (rule) return nextOccurrenceAfter(r.dueAt, rule, afterMs, r.timezone ?? null);
  // No structured rule and a 'none'/unknown legacy enum → not recurring.
  if (!r.recurrence || r.recurrence === "none") return null;
  return nextDue(r.dueAt, r.recurrence);
}
async function spawnNext(r) {
  // Recurring iff a structured rule is present OR the legacy enum is non-none.
  const recurring = !!(r && (r.recurrenceRule || (r.recurrence && r.recurrence !== "none")));
  if (!recurring || !r.dueAt) return null;
  // Anchor the "next occurrence" cursor at the LATER of now and THIS occurrence's
  // own due instant, so the spawned occurrence is always STRICTLY after the current
  // one regardless of how early the spawn is triggered. spawnNext is called from
  // BOTH the fire path (at notify-at = due - lead, i.e. BEFORE due) AND the early-
  // completion path (a user checks it off before it fires). With the bare Date.now()
  // default, an early spawn (afterMs < due_at) made nextOccurrenceAfter return the
  // CURRENT occurrence's own due_at as "the next one" — the existence check then
  // either matched the still-open row (fire path → NO advance ever) or, for a now-
  // done row, INSERTed a same-instant duplicate (early-complete → double fire). Using
  // max(now, due) forces afterMs >= due_at so the walk always lands on a later slot.
  const dueMs = Date.parse(r.dueAt);
  const afterMs = Number.isFinite(dueMs) ? Math.max(Date.now(), dueMs) : Date.now();
  const nd = computeNextDue(r, afterMs);
  if (!nd) return null;
  // Atomic check-and-insert: returns the created row, or null if an equivalent
  // live occurrence already exists for this series at the next due instant. The
  // lead time + structured rule carry forward so every occurrence keeps the same
  // notify-before behaviour and recurrence.
  return db.reminders.spawnNextOccurrence({
    userId: r.userId,
    text: r.text,
    folderId: r.folderId || null,
    dueLabel: null,
    description: r.description || null,
    dueAt: nd,
    priority: r.priority || "Medium",
    recurrence: r.recurrence,
    leadMinutes: r.leadMinutes ?? null,
    recurrenceRule: r.recurrenceRule ?? null,
    // AUDIT #31: carry the series timezone forward so occurrence N+1 keeps being
    // computed in the same zone (else the series would drift once it rolls over).
    timezone: r.timezone ?? null,
    // Organizations: inherit the SOURCE reminder's tenant so a fire-tick spawn
    // (where there's no request/ambient org) still stamps the next occurrence
    // with the right org (mapRem surfaces organizationId on the claimed row).
    organizationId: r.organizationId ?? null,
  });
}

async function listFolders(userId) {
  return (await db.folders.listForUser(userId)).map(serializeFolder);
}
async function createFolder({ userId, name, icon }) {
  return serializeFolder(await db.folders.create({ userId, name, icon }));
}
async function deleteFolder({ id, userId }) {
  await db.folders.delete(id, userId);
  return { id, deleted: true };
}

// Compute the SERVER-LOCAL "today" window + now, the same basis
// serialize.reminderState uses (Date.now() / toDateString()), so the SQL count
// buckets agree with the per-row `state` the client renders.
function dayWindow() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);
  return {
    nowIso: now.toISOString(),
    dayStartIso: start.toISOString(),
    dayEndIso: end.toISOString(),
  };
}

// Authoritative smart-view / per-folder / open counts (server-side) so the
// RemindersView badges and the Rail "open reminders" badge stay correct once the
// client holds only a page. Returns the full count map (defaults if the driver
// predates countsForUser).
async function reminderCounts(userId) {
  if (!db.reminders.countsForUser)
    return {
      all: 0,
      today: 0,
      upcoming: 0,
      overdue: 0,
      completed: 0,
      archived: 0,
      open: 0,
      folders: {},
    };
  const { nowIso, dayStartIso, dayEndIso } = dayWindow();
  return db.reminders.countsForUser(userId, nowIso, dayStartIso, dayEndIso);
}

// Paginated list of a user's reminders. Returns the page of serialized reminders
// plus the pagination envelope (hasMore + nextCursor), the TOTAL live count, and
// the per-view `counts` so badges never undercount once the client only holds a
// page. Mirrors taskService.list. `limit` is clamped in the repo; `cursor` is the
// opaque keyset token from the previous page. Authz is inherent (user_id scoping).
async function listReminders(userId, { limit, cursor }: any = {}) {
  if (db.reminders.countForUser && db.reminders.countsForUser) {
    const [page, count, counts] = await Promise.all([
      db.reminders.listForUser(userId, { limit, cursor }),
      db.reminders.countForUser(userId),
      reminderCounts(userId),
    ]);
    const reminders = (page.reminders || []).map(serializeReminder);
    return {
      reminders,
      hasMore: !!page.hasMore,
      nextCursor: page.nextCursor || null,
      count: count == null ? reminders.length : count,
      counts,
    };
  }
  // Fallback driver without the count helpers: return the whole set in the same
  // envelope shape (no real paging) so callers stay uniform. Tolerates a driver
  // whose listForUser yields either the paginated envelope OR a bare array.
  const res: any = await db.reminders.listForUser(userId);
  const rows = Array.isArray(res) ? res : res.reminders || [];
  const all = rows.map(serializeReminder);
  return {
    reminders: all,
    hasMore: false,
    nextCursor: null,
    count: all.length,
    counts: await reminderCounts(userId),
  };
}
async function createReminder({
  userId,
  text,
  folderId,
  dueLabel,
  description,
  dueAt,
  priority,
  recurrence,
  leadMinutes = null,
  recurrenceRule = null,
  timezone = null,
}: any) {
  // Server-side validation (P0-D + #53): reject garbage the DB would otherwise
  // persist — including a bad lead time or a malformed structured recurrence rule.
  const cleanText = validateText(text);
  validatePriority(priority);
  validateRecurrence(recurrence);
  validateDueAt(dueAt);
  validateLeadMinutes(leadMinutes);
  validateRecurrenceRule(recurrenceRule);
  // AUDIT #31: persist the series timezone ONLY for recurring reminders (a one-off
  // has no future occurrences to expand). A basic-looking IANA name gate keeps junk
  // out; anything unusable is stored NULL → legacy server-local behaviour.
  const isRecurring = !!(recurrenceRule || (recurrence && recurrence !== "none"));
  const tz =
    isRecurring && typeof timezone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(timezone)
      ? timezone
      : null;
  return serializeReminder(
    await db.reminders.create({
      userId,
      text: cleanText,
      folderId,
      dueLabel,
      description,
      dueAt,
      priority,
      recurrence,
      leadMinutes: leadMinutes === "" ? null : leadMinutes,
      recurrenceRule,
      timezone: tz,
    }),
  );
}
async function toggleReminder({ id, userId }) {
  const r = await db.reminders.toggle(id, userId);
  if (r && r.status === "done") await spawnNext(r);
  return r ? serializeReminder(r) : null;
}
async function updateReminder({ id, userId, patch }) {
  const p = patch || {};
  // Server-side validation (P0-D): only validate fields PRESENT in the patch, so
  // editing one field never trips on a legacy value held by another (lenient on
  // existing rows). `text` is validated only when the caller actually sends it.
  if ("priority" in p) validatePriority(p.priority);
  if ("recurrence" in p) validateRecurrence(p.recurrence);
  if ("status" in p) validateStatus(p.status);
  if ("dueAt" in p) validateDueAt(p.dueAt);
  if ("leadMinutes" in p) validateLeadMinutes(p.leadMinutes);
  if ("recurrenceRule" in p) validateRecurrenceRule(p.recurrenceRule);
  if (typeof p.text === "string") validateText(p.text);
  const clean: any = {};
  if (typeof p.text === "string" && p.text.trim()) clean.text = p.text.trim();
  if ("description" in p) clean.description = p.description || null;
  if ("dueLabel" in p) clean.dueLabel = p.dueLabel;
  if ("dueAt" in p) clean.dueAt = p.dueAt || null;
  if (p.priority) clean.priority = p.priority;
  if (p.status) clean.status = p.status;
  if (p.recurrence) clean.recurrence = p.recurrence;
  // Lead + structured rule are explicitly nullable (clearing the lead / dropping
  // the structured rule is a legitimate edit), so use presence-in-patch, not truthiness.
  if ("leadMinutes" in p) clean.leadMinutes = p.leadMinutes === "" ? null : p.leadMinutes;
  if ("recurrenceRule" in p) clean.recurrenceRule = p.recurrenceRule || null;
  if ("folderId" in p) clean.folderId = p.folderId || null;
  const r = await db.reminders.update(id, userId, clean);
  return r ? serializeReminder(r) : null;
}
async function setReminderStatus({ id, userId, status }) {
  validateStatus(status);
  const before = await db.reminders.getOne(id, userId);
  const r = await db.reminders.setStatus(id, userId, status);
  if (r && status === "done" && before && before.status !== "done")
    await spawnNext(r);
  return r ? serializeReminder(r) : null;
}
async function bulk({ ids, action, value, userId }) {
  if (!Array.isArray(ids) || !ids.length) return { count: 0 };
  if (action === "delete") return db.reminders.bulkRemove(ids, userId);
  if (action === "complete") {
    const recurring = await db.reminders.recurringDueAmong(ids, userId);
    for (const r of recurring) await spawnNext(r);
    return db.reminders.bulkPatch(ids, userId, { status: "done" });
  }
  if (action === "archive")
    return db.reminders.bulkPatch(ids, userId, { status: "archived" });
  if (action === "open")
    return db.reminders.bulkPatch(ids, userId, { status: "open" });
  if (action === "move")
    return db.reminders.bulkPatch(ids, userId, { folderId: value || null });
  if (action === "priority") {
    validatePriority(value);
    return db.reminders.bulkPatch(ids, userId, { priority: value });
  }
  return { count: 0 };
}
async function renameFolder({ id, userId, name, icon }) {
  const fld = await db.folders.rename(id, userId, name, icon);
  return fld ? serializeFolder(fld) : null;
}
async function deleteReminder({ id, userId }) {
  await db.reminders.delete(id, userId);
  return { id, deleted: true };
}
// Snooze: re-arm a reminder to fire again `minutes` from now. We don't bypass or
// duplicate the firing engine — we just reset the row's gate (new due_at +
// cleared notified_at + status 'open') so the existing exactly-once claimDue
// re-fires it once at the new time. Default 10 min; clamped to a sane range.
async function snoozeReminder({ id, userId, minutes }) {
  let m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) m = 10;
  m = Math.min(Math.max(Math.round(m), 1), 7 * 24 * 60); // 1 min … 7 days
  const dueAt = new Date(Date.now() + m * 60000).toISOString();
  const r = await db.reminders.rearm(id, userId, dueAt);
  return r ? serializeReminder(r) : null;
}
// Complete from a notification action — mark done (mirrors setReminderStatus's
// completion path so a recurring reminder still spawns its next occurrence,
// guarded by spawnNext's idempotency).
async function completeReminder({ id, userId }) {
  const before = await db.reminders.getOne(id, userId);
  const r = await db.reminders.setStatus(id, userId, "done");
  if (r && before && before.status !== "done") await spawnNext(r);
  return r ? serializeReminder(r) : null;
}

// AUTO-PRUNE (#53): soft-delete very old COMPLETED recurrence occurrences so a
// daily reminder running for a year doesn't accumulate hundreds of dead rows. Thin
// wrapper over the driver's bounded, safety-guarded prune (recurring + completed +
// past the window only; never active/future). Window/limit configurable. No-ops on
// a driver that predates the method. Returns { pruned }.
async function pruneOldOccurrences(windowDays?: number, limit?: number) {
  if (!db.reminders.pruneOldOccurrences) return { pruned: 0 };
  return db.reminders.pruneOldOccurrences(windowDays, limit);
}

export {
  listFolders,
  createFolder,
  deleteFolder,
  listReminders,
  reminderCounts,
  createReminder,
  toggleReminder,
  updateReminder,
  deleteReminder,
  setReminderStatus,
  snoozeReminder,
  completeReminder,
  pruneOldOccurrences,
  renameFolder,
  bulk,
  spawnNext,
  computeNextDue,
  // Exposed for unit tests + reuse: the validation allow-lists/helpers are pure
  // (no transport) and are the server's authority over reminder field values.
  validatePriority,
  validateRecurrence,
  validateStatus,
  validateDueAt,
  validateLeadMinutes,
  validateText,
  REMINDER_PRIORITIES,
  REMINDER_RECURRENCES,
  REMINDER_STATUSES,
};
