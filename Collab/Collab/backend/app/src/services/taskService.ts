import { db } from "../platform";
import * as fileService from "./fileService";
import {
  serializeTask,
  serializeTaskList,
  serializeTaskActivity,
  serializeTaskComment,
  serializeProject,
  serializeSavedView,
} from "../serialize";

// ---------------------------------------------------------------------------
// SERVER-SIDE VALIDATION (P0): the API previously persisted garbage states —
// arbitrary status/priority strings, empty/over-length titles, unparseable due
// dates, and dependency cycles. These allow-lists are the SERVER's authority and
// MUST mirror the frontend's real options (TasksView.tsx): the board columns +
// the "Archived" status, and the three priority levels. Keep them in sync with
// that file if the product adds a column/level.
const TASK_STATUSES = new Set([
  "backlog",
  "todo",
  "inprogress",
  "review",
  "blocked",
  "done",
  "archived",
]);
const TASK_PRIORITIES = new Set(["High", "Medium", "Low"]);
// RECURRING TASKS (feature #52a): the recurrence allow-list MIRRORS reminders
// (reminderService.REMINDER_RECURRENCES) — the same four options the UI offers and
// nextDue() understands. The server is the authority; an out-of-list value is
// rejected on create/update so the spawn engine never reasons about garbage.
const TASK_RECURRENCES = new Set(["none", "daily", "weekly", "monthly"]);
const TITLE_MAX = 255;

const badRequest = (message: string) => {
  const e: any = new Error(message);
  e.status = 400;
  return e;
};

// Returns a normalized title or throws 400. Rejects empty/whitespace-only and
// anything longer than the column allows (the DB silently truncates otherwise).
function validateTitle(raw: any): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title) throw badRequest("A task title is required.");
  if (title.length > TITLE_MAX)
    throw badRequest(`Task title must be ${TITLE_MAX} characters or fewer.`);
  return title;
}

function validateStatus(status: any): void {
  if (status != null && !TASK_STATUSES.has(status))
    throw badRequest(`Invalid task status: "${status}".`);
}

function validatePriority(priority: any): void {
  if (priority != null && !TASK_PRIORITIES.has(priority))
    throw badRequest(`Invalid task priority: "${priority}".`);
}

// Recurrence allow-list guard (feature #52a). Lenient: an absent/empty value is
// fine (a partial patch / a non-recurring task); only a present out-of-list value
// is rejected. Mirrors reminderService.validateRecurrence.
function validateRecurrence(recurrence: any): void {
  if (
    recurrence != null &&
    recurrence !== "" &&
    !TASK_RECURRENCES.has(recurrence)
  )
    throw badRequest(`Invalid task recurrence: "${recurrence}".`);
}

// Accepts null/"" (clear the due date) but rejects an unparseable value so the
// firing scan never has to reason about garbage timestamps.
function validateDueAt(dueAt: any): void {
  if (dueAt == null || dueAt === "") return;
  const t = Date.parse(dueAt);
  if (!Number.isFinite(t)) throw badRequest("Invalid due date.");
}

// ---------------------------------------------------------------------------
// PROJECTS-AS-ENTITIES (#52b)
// ---------------------------------------------------------------------------
const PROJECT_NAME_MAX = 255;
// A hex-ish color (or empty to keep the default). Lenient: we only reject an
// obviously-bad value so a saved color can't be an injection vector / huge blob.
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
function validateProjectName(raw: any): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw badRequest("A project name is required.");
  if (name.length > PROJECT_NAME_MAX)
    throw badRequest(`Project name must be ${PROJECT_NAME_MAX} characters or fewer.`);
  return name;
}
function validateColor(color: any): void {
  if (color == null || color === "") return;
  if (typeof color !== "string" || !COLOR_RE.test(color))
    throw badRequest("Invalid project color.");
}

// Resolve a caller-supplied projectId to a project ROW the caller can see — or
// throw 403 (IDOR guard: you can only file a task into YOUR OWN project). Returns
// the project (so callers can keep the legacy `project` text consistent with its
// name), or null when projectId is absent/blank (= unfiled). The actor is the
// authority scope: a task's reporter owns its project namespace, mirroring how a
// reminder's folder is the user's own.
async function resolveProject(projectId: any, ownerId: any): Promise<any> {
  if (projectId == null || projectId === "") return null;
  if (!db.taskProjects || !db.taskProjects.getForUser) return null;
  const project = await db.taskProjects.getForUser(projectId, ownerId);
  if (!project) {
    const e: any = new Error("That project doesn't exist or isn't yours.");
    e.status = 403;
    throw e;
  }
  return project;
}

// Project CRUD — owner-scoped, mirroring the reminder-folder service shape.
async function listProjects(userId) {
  if (!db.taskProjects) return [];
  return (await db.taskProjects.listForUser(userId)).map(serializeProject);
}
async function createProject({ userId, name, color }: any) {
  const cleanName = validateProjectName(name);
  validateColor(color);
  return serializeProject(
    await db.taskProjects.create({ ownerId: userId, name: cleanName, color: color || null }),
  );
}
async function updateProject({ id, userId, name, color, archived }: any) {
  if (name !== undefined) validateProjectName(name);
  validateColor(color);
  const patch: any = {};
  if (name !== undefined) patch.name = validateProjectName(name);
  if (color !== undefined && color !== "") patch.color = color;
  if (archived !== undefined) patch.archived = !!archived;
  const p = await db.taskProjects.update(id, userId, patch);
  // Keep the legacy free-text `project` on this owner's tasks consistent with a
  // rename (so the CSV column + any text reader still shows the new name).
  if (p && patch.name) await syncProjectText(id, userId, patch.name);
  return p ? serializeProject(p) : null;
}
// Keep tasks.project (legacy text) equal to the project's current name for this
// owner. Best-effort; uses a scoped UPDATE so it can only touch the owner's rows.
async function syncProjectText(projectId, ownerId, name) {
  try {
    if (db.tasks && db.tasks.bulkSetProjectText)
      await db.tasks.bulkSetProjectText(projectId, ownerId, name);
  } catch (_) {
    /* a text-sync failure must never break the rename */
  }
}
async function deleteProject({ id, userId }: any) {
  await db.taskProjects.delete(id, userId);
  return { id, deleted: true };
}

// ---------------------------------------------------------------------------
// SAVED VIEWS / SWIMLANES (#52b)
// ---------------------------------------------------------------------------
// The allow-listed filter KEYS + the group-by / sort options. The stored filter
// JSON is validated field-by-field against these (only known keys/values survive;
// the JSON is NEVER eval'd / spread blindly) so a saved view can't smuggle an
// arbitrary column/predicate into the list query. `assignee`/`project` are opaque
// ids the LIST query treats as scalars; `status`/`priority`/`due` are constrained
// to the same vocab the board uses.
const VIEW_FILTER_KEYS = new Set([
  "status",
  "assignee",
  "priority",
  "project",
  "due",
  "search",
]);
const VIEW_DUE = new Set(["overdue", "today", "week", "none"]);
const VIEW_GROUP_BY = new Set(["none", "assignee", "priority", "project", "status"]);
const VIEW_SORT = new Set(["created", "due", "priority"]);
const VIEW_NAME_MAX = 120;
const VIEW_SEARCH_MAX = 200;

// Sanitize a caller-supplied filter object into ONLY the known keys/values — the
// server's authority over what a saved view may constrain. Throws 400 on an
// invalid enum value; silently drops unknown keys (lenient, never eval'd). Returns
// a NEW plain object (so nothing extra is persisted). `status`/`priority`/`due`
// are enum-checked; `assignee`/`project`/`search` are bounded opaque strings.
function sanitizeViewFilter(raw: any): any {
  const out: any = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (!VIEW_FILTER_KEYS.has(key)) continue; // drop unknown keys
    const v = raw[key];
    if (v == null || v === "") continue; // empty = "no constraint" — omit
    if (key === "status") {
      if (!TASK_STATUSES.has(v)) throw badRequest(`Invalid view status: "${v}".`);
      out.status = v;
    } else if (key === "priority") {
      if (!TASK_PRIORITIES.has(v)) throw badRequest(`Invalid view priority: "${v}".`);
      out.priority = v;
    } else if (key === "due") {
      if (!VIEW_DUE.has(v)) throw badRequest(`Invalid view due filter: "${v}".`);
      out.due = v;
    } else if (key === "assignee" || key === "project") {
      // Opaque id — bounded length, coerced to string (never used as SQL by the
      // saved-view metadata; the list query binds it as a scalar parameter).
      const s = String(v);
      if (s.length > 64) throw badRequest(`Invalid view ${key} value.`);
      out[key] = s;
    } else if (key === "search") {
      const s = String(v).slice(0, VIEW_SEARCH_MAX);
      if (s.trim()) out.search = s;
    }
  }
  return out;
}
function validateViewName(raw: any): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw badRequest("A view name is required.");
  if (name.length > VIEW_NAME_MAX)
    throw badRequest(`View name must be ${VIEW_NAME_MAX} characters or fewer.`);
  return name;
}
function validateGroupBy(g: any): string {
  if (g == null || g === "") return "none";
  if (!VIEW_GROUP_BY.has(g)) throw badRequest(`Invalid swimlane field: "${g}".`);
  return g;
}
function validateSort(s: any): string {
  if (s == null || s === "") return "created";
  if (!VIEW_SORT.has(s)) throw badRequest(`Invalid sort: "${s}".`);
  return s;
}

async function listSavedViews(userId) {
  if (!db.taskSavedViews) return [];
  return (await db.taskSavedViews.listForUser(userId)).map(serializeSavedView);
}
async function createSavedView({ userId, name, filter, groupBy, sort }: any) {
  const cleanName = validateViewName(name);
  const cleanFilter = sanitizeViewFilter(filter);
  const cleanGroupBy = validateGroupBy(groupBy);
  const cleanSort = validateSort(sort);
  return serializeSavedView(
    await db.taskSavedViews.create({
      userId,
      name: cleanName,
      filter: cleanFilter,
      groupBy: cleanGroupBy,
      sort: cleanSort,
    }),
  );
}
async function updateSavedView({ id, userId, name, filter, groupBy, sort }: any) {
  const patch: any = {};
  if (name !== undefined) patch.name = validateViewName(name);
  if (filter !== undefined) patch.filter = sanitizeViewFilter(filter);
  if (groupBy !== undefined) patch.groupBy = validateGroupBy(groupBy);
  if (sort !== undefined) patch.sort = validateSort(sort);
  const v = await db.taskSavedViews.update(id, userId, patch);
  return v ? serializeSavedView(v) : null;
}
async function deleteSavedView({ id, userId }: any) {
  await db.taskSavedViews.delete(id, userId);
  return { id, deleted: true };
}

// Would adding the edge `id depends-on dependsOnId` create a cycle? A cycle
// exists iff `id` is already reachable FROM `dependsOnId` by following existing
// "depends on" edges (i.e. dependsOnId transitively already depends on id). We
// walk the live dependency graph breadth-first from dependsOnId; if we reach id
// the new edge would close a loop. Bounded by a visited-set (each node once) and
// a hard node cap so a pathological graph can't run away.
async function wouldCreateCycle(id: string, dependsOnId: string): Promise<boolean> {
  if (id === dependsOnId) return true;
  const visited = new Set<string>([dependsOnId]);
  const queue: string[] = [dependsOnId];
  let budget = 5000; // safety cap on nodes walked
  while (queue.length && budget-- > 0) {
    const node = queue.shift()!;
    // The tasks `node` depends on (its "blockedBy" set). If `id` is among them
    // transitively, adding id->dependsOnId would create a cycle.
    const { blockedBy } = await db.tasks.deps(node);
    for (const dep of blockedBy || []) {
      if (dep.id === id) return true;
      if (!visited.has(dep.id)) {
        visited.add(dep.id);
        queue.push(dep.id);
      }
    }
  }
  return false;
}

// Paginated list of a user's tasks. Returns the page of serialized tasks plus
// the pagination envelope (hasMore + nextCursor) and the TOTAL live count so
// dashboard/rail badges stay correct now that the client no longer holds every
// row. `limit` is clamped in the repo; `cursor` is the opaque keyset token from
// the previous page. Authz is inherent: the repo only returns rows where the
// user is reporter or assignee (the same predicate assertTaskAccess enforces).
async function list(userId, { limit, cursor, projectId }: any = {}) {
  if (db.tasks.listForUser) {
    // PROJECTS-AS-ENTITIES (#52b): an optional SERVER-SIDE project filter — when
    // present it constrains BOTH the page and the count so pagination stays
    // correct (it is not a page-local filter). `undefined` = no filter.
    const [page, count] = await Promise.all([
      db.tasks.listForUser(userId, { limit, cursor, projectId }),
      db.tasks.countForUser
        ? db.tasks.countForUser(userId, { projectId })
        : undefined,
    ]);
    // Batched serialization: one users query for the whole page instead of a
    // getById per assignee AND per reporter per task (the old N+1).
    const tasks = await serializeTaskList(page.tasks || []);
    return {
      tasks,
      hasMore: !!page.hasMore,
      nextCursor: page.nextCursor || null,
      count: count == null ? tasks.length : count,
    };
  }
  // Fallback driver without listForUser: filter in memory, no real paging.
  const rows = (await db.tasks.list()).filter(
    (task) => task.reporterId === userId || task.assigneeId === userId,
  );
  const tasks = await serializeTaskList(rows);
  return { tasks, hasMore: false, nextCursor: null, count: tasks.length };
}
async function create({
  title,
  status,
  priority,
  dueLabel,
  assigneeId,
  description,
  labels,
  dueAt,
  project,
  projectId,
  recurrence,
  creatorId,
}: any) {
  // Server-side validation (P0): reject garbage states the DB would otherwise
  // persist. The update path already guards title; create did not.
  const cleanTitle = validateTitle(title);
  validateStatus(status);
  validatePriority(priority);
  validateDueAt(dueAt);
  validateRecurrence(recurrence);
  // PROJECTS-AS-ENTITIES (#52b): resolve the project (IDOR-guarded — must be the
  // creator's own) and keep the legacy `project` text equal to its name.
  const projectRow = await resolveProject(projectId, creatorId);
  const t = await db.tasks.create({
    title: cleanTitle,
    status,
    priority,
    dueLabel,
    assigneeId,
    description: description || null,
    labels: labels || [],
    dueAt: dueAt || null,
    reporterId: creatorId || null,
    project: projectRow ? projectRow.name : project || null,
    projectId: projectRow ? projectRow.id : null,
    recurrence: recurrence || "none",
  });
  await db.tasks.logActivity(t.id, creatorId, "created", { title: t.title });
  return serializeTask(t);
}
// MUTATION gate: the actor must be the reporter OR ONE OF the assignees. With
// multiple assignees this can no longer be a bare assignee_id check (that only
// matches the PRIMARY) — a secondary assignee is just as entitled, so we also
// consult the task_assignees join table. Watchers are intentionally NOT allowed
// here: watching grants READ only (see assertTaskReadAccess), never the right to
// mutate someone else's task — that would be an IDOR escalation.
async function assertTaskAccess(id, userId) {
  const task = await db.tasks.getById(id);
  if (!task) {
    const e: any = new Error("You do not have access to this task.");
    e.status = 404;
    throw e;
  }
  let allowed = task.reporterId === userId || task.assigneeId === userId;
  if (!allowed && db.tasks.isAssignee)
    allowed = await db.tasks.isAssignee(id, userId);
  if (!allowed) {
    const e: any = new Error("You do not have access to this task.");
    e.status = 403;
    throw e;
  }
  return task;
}
// READ gate: reporter OR any assignee OR a WATCHER. Used by the read-only
// endpoints (activity / deps / comments) so a watcher can follow the task without
// being able to mutate it. Falls back to the mutation gate's predicate plus the
// watcher check; same 403/404 shape so callers are unchanged.
async function assertTaskReadAccess(id, userId) {
  const task = await db.tasks.getById(id);
  if (!task) {
    const e: any = new Error("You do not have access to this task.");
    e.status = 404;
    throw e;
  }
  let allowed = task.reporterId === userId || task.assigneeId === userId;
  if (!allowed && db.tasks.isAssignee)
    allowed = await db.tasks.isAssignee(id, userId);
  if (!allowed && db.tasks.isWatcher)
    allowed = await db.tasks.isWatcher(id, userId);
  if (!allowed) {
    const e: any = new Error("You do not have access to this task.");
    e.status = 403;
    throw e;
  }
  return task;
}
// Statuses that mean the task is "resolved" — a due-date notification is moot,
// so moving INTO one clears the firing stamp (and moving back OUT lets it fire
// again on the next due scan). Mirrors the reminder "done → won't fire" gate.
const RESOLVED_STATUSES = new Set(["done", "archived"]);
// A status that marks the work as COMPLETE (the "Done" column / a done-equivalent).
// Transitioning INTO this while the task still has open blockers is rejected by
// dependency enforcement below. "archived" is intentionally NOT a completion (a
// task can be shelved without its blockers being resolved), so it's not gated.
const DONE_STATUSES = new Set(["done"]);

// DEPENDENCY ENFORCEMENT (feature #51): a task cannot be marked DONE while any of
// the tasks it depends on (its blockers — task_deps "blockedBy") are still OPEN
// (not in a resolved status). This is the server's authority: the UI may disable
// the Done action, but the rule lives here so no client can bypass it. Returns the
// list of still-open blockers (empty = clear to complete). Only consults the graph
// when the target status is a completion (cheap fast-path otherwise).
async function openBlockers(id: string): Promise<any[]> {
  const { blockedBy } = await db.tasks.deps(id);
  return (blockedBy || []).filter((b) => !RESOLVED_STATUSES.has(b.status));
}
// Throws 400 (with a clear, blocker-listing message) if moving `id` to `status`
// would complete it while blockers remain open. A no-op for non-completion target
// statuses, or when `before` is already done (re-saving "done" must never trip).
async function assertCanTransition(id: string, status: any, before: any) {
  if (!DONE_STATUSES.has(status)) return;
  if (before && DONE_STATUSES.has(before.status)) return; // already done — idempotent
  const open = await openBlockers(id);
  if (open.length) {
    const names = open.map((b) => `“${b.title}”`).join(", ");
    const e: any = new Error(
      `This task can't be marked done — it's blocked by ${open.length} unfinished ` +
        `task${open.length === 1 ? "" : "s"}: ${names}. Complete ${
          open.length === 1 ? "it" : "them"
        } first.`,
    );
    e.status = 400;
    e.code = "task_blocked_by_dependencies";
    e.blockers = open.map((b) => ({ id: b.id, title: b.title, status: b.status }));
    throw e;
  }
}

// ---------------------------------------------------------------------------
// RECURRING TASKS (feature #52a)
// ---------------------------------------------------------------------------
// Advance a due instant by the recurrence to the NEXT future occurrence. An exact
// copy of reminderService.nextDue (same {daily,weekly,monthly} stepping + the
// "skip past every already-elapsed occurrence" loop), kept local so tasks don't
// import the reminders module.
//
// A falsy due date returns null — mirroring reminders (reminderService.nextDue)
// EXACTLY. Anchoring an undated series to `new Date()` made the result
// non-deterministic (it advanced from the current clock, so two calls a few ms
// apart returned different instants); the spawn dedupe (the advisory-lock name +
// the existence-check predicate in db.tasks.spawnNextOccurrence) is keyed on this
// instant, so a non-deterministic value let two concurrent completions of the
// SAME undated recurring task acquire different locks and miss each other's row →
// a double-spawn. Requiring a real due date makes the next instant deterministic
// for a given series, so the lock serializes and the existence-check matches.
function nextDue(dueAtIso: any, recurrence: string): string | null {
  if (!dueAtIso || recurrence === "none") return null;
  const base = new Date(dueAtIso);
  if (Number.isNaN(base.getTime())) return null;
  let d = base;
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

// Spawn the NEXT occurrence of a recurring task EXACTLY ONCE when it transitions
// to a DONE status. IDEMPOTENT by construction: the existence-check + insert is
// done atomically in the driver (db.tasks.spawnNextOccurrence — a MySQL advisory
// lock keyed by the series identity + the next due instant, mirroring
// reminders.spawnNextOccurrence), so a double-complete or a fire/complete race
// can't create two. The original task stays done as history; the new occurrence
// copies title/description/priority/recurrence/project + the assignee & watcher
// SETS, with due_at advanced from the old due_at (or now) by the recurrence.
//
// `before` is the pre-transition task row (so we don't re-spawn when re-saving an
// already-done task). Returns the spawned task (serialized) or null (not
// recurring / already spawned / not a fresh completion). Never throws into the
// caller's request path — a spawn failure must not break the completion.
async function spawnNextTask(before: any, actorId: any): Promise<any> {
  try {
    if (!before || before.recurrence === "none" || !before.recurrence)
      return null;
    // Only top-level recurring tasks recur — a recurring SUBTASK would muddy the
    // parent's progress with an ever-growing child set, so we don't auto-spawn it.
    if (before.parentTaskId) return null;
    // A recurring task with NO due date does not roll forward (mirrors
    // reminderService.spawnNext, which `return null`s on a falsy dueAt). Without a
    // real due anchor the next instant would be non-deterministic and the spawn
    // dedupe (advisory lock + existence-check, both keyed on the next due) would
    // not serialize concurrent completions → a double-spawn. nextDue() also guards
    // this; the explicit check here keeps the contract obvious at the call site.
    if (!before.dueAt) return null;
    const nd = nextDue(before.dueAt, before.recurrence);
    if (!nd) return null;
    const spawned = await db.tasks.spawnNextOccurrence({
      sourceTaskId: before.id,
      title: before.title,
      description: before.description || null,
      priority: before.priority || "Medium",
      recurrence: before.recurrence,
      dueAt: nd,
      dueLabel: before.dueLabel || null,
      project: before.project || null,
      // Carry the project LINK forward so the next occurrence stays filed (#52b).
      projectId: before.projectId || null,
      reporterId: before.reporterId || null,
      assigneeId: before.assigneeId || null,
    });
    if (!spawned) return null; // a concurrent path already spawned this occurrence
    // Re-apply the assignee + watcher SETS so the new occurrence is owned/followed
    // like the original (the insert only carried the primary assignee_id). Each is
    // best-effort + idempotent on its PK.
    try {
      if (db.tasks.assignees && db.tasks.setAssignees) {
        const asn = await db.tasks.assignees(before.id);
        if (asn.length) await db.tasks.setAssignees(spawned.id, asn, actorId || null);
      }
      if (db.tasks.watchers && db.tasks.addWatcher) {
        const watchers = await db.tasks.watchers(before.id);
        for (const w of watchers) await db.tasks.addWatcher(spawned.id, w).catch(() => {});
      }
    } catch (_) {
      /* a copy-set failure must not break the completion */
    }
    await db.tasks
      .logActivity(spawned.id, actorId || null, "recurrence_spawned", {
        from: before.id,
      })
      .catch(() => {});
    return await serializeTask(await db.tasks.getById(spawned.id));
  } catch (_) {
    return null; // never let a recurrence-spawn failure break a completion
  }
}

async function move({ id, status, actorId }: any) {
  await assertTaskAccess(id, actorId);
  validateStatus(status);
  const before = await db.tasks.getById(id);
  // Block completing a task while its blockers are still open (server-side).
  await assertCanTransition(id, status, before);
  const patch: any = { status };
  // Reset the due-firing stamp when the task is resolved or reopened, so a
  // reopened task can fire again and a resolved one never (re)fires.
  if (
    before &&
    RESOLVED_STATUSES.has(status) !== RESOLVED_STATUSES.has(before.status)
  )
    patch.dueNotifiedAt = null;
  const t = await db.tasks.update(id, patch);
  if (t && before)
    await db.tasks.logActivity(id, actorId, "status_changed", {
      from: before.status,
      to: status,
    });
  // RECURRING (feature #52a): a transition INTO a DONE status spawns the next
  // occurrence exactly once. Only on a FRESH completion (before wasn't already
  // done) so re-saving "done" never re-spawns. Attach the spawned task so the
  // route can broadcast it to the new occurrence's audience.
  let spawned: any = null;
  if (t && before && DONE_STATUSES.has(status) && !DONE_STATUSES.has(before.status))
    spawned = await spawnNextTask(before, actorId);
  const out = t ? await serializeTask(t) : null;
  if (out && spawned) (out as any)._spawned = spawned;
  return out;
}
async function update({ id, patch, actorId, version }: any) {
  await assertTaskAccess(id, actorId);
  // Server-side validation (P0): reject garbage before building the patch. Only
  // validate fields actually present; an absent field is left untouched.
  if ("status" in patch) validateStatus(patch.status);
  if ("priority" in patch) validatePriority(patch.priority);
  if ("dueAt" in patch) validateDueAt(patch.dueAt);
  if ("title" in patch) validateTitle(patch.title);
  if ("recurrence" in patch) validateRecurrence(patch.recurrence);
  const before = await db.tasks.getById(id);
  // Dependency enforcement: a status change to a done-equivalent is rejected while
  // blockers remain open — same rule as move() (the board uses move, the detail
  // panel's Status select + the conflict "keep my changes" path go through here).
  if ("status" in patch) await assertCanTransition(id, patch.status, before);
  const clean: any = {};
  if (typeof patch.title === "string" && patch.title.trim())
    clean.title = patch.title.trim();
  if (patch.priority) clean.priority = patch.priority;
  if (patch.status) clean.status = patch.status;
  if ("dueLabel" in patch) clean.dueLabel = patch.dueLabel;
  if ("dueAt" in patch) clean.dueAt = patch.dueAt || null;
  if ("assigneeId" in patch) clean.assigneeId = patch.assigneeId || null;
  if ("description" in patch) clean.description = patch.description || null;
  if ("labels" in patch)
    clean.labels = Array.isArray(patch.labels) ? patch.labels : [];
  // PROJECTS-AS-ENTITIES (#52b): a projectId patch repoints the canonical link
  // AND keeps the legacy `project` text consistent with the project's name.
  // `projectId: null`/"" unfiles (clears both). A bare `project` text patch (no
  // projectId key) still works for back-compat.
  //
  // OWNERSHIP MODEL: a task's project belongs to the task's REPORTER, not to
  // whoever happens to be editing. We resolve against `before.reporterId` (the
  // task's reporter) — not `actorId` — so a secondary assignee can't file a
  // shared task into THEIR own private project (which would (a) leak that
  // project's name back to the reporter via serializeTask and (b) leave the
  // rename/delete mirror — scoped by reporter_id — unable to ever update or
  // un-file that link). This keeps a task's project_id always pointing at a
  // project the reporter owns, matching create() (resolved against creatorId =
  // the reporter). assertTaskAccess already gated the edit; this only narrows
  // WHICH namespace the project must come from. A reporterless legacy task
  // (reporter_id NULL) can't be filed into any project.
  if ("projectId" in patch) {
    const projectRow = await resolveProject(patch.projectId, before ? before.reporterId : null);
    clean.projectId = projectRow ? projectRow.id : null;
    clean.project = projectRow ? projectRow.name : null;
  } else if ("project" in patch) {
    clean.project = patch.project || null;
  }
  // Recurrence (feature #52a): a present value is applied (empty/none clears it).
  if ("recurrence" in patch) clean.recurrence = patch.recurrence || "none";
  // Reset the due-firing stamp so a rescheduled or reopened task can fire again:
  //  • the due date changed → the new due moment hasn't been notified yet
  //  • the resolved-ness flipped (done/archived ↔ open) → reopened tasks re-arm,
  //    resolved tasks won't (re)fire on the next scan.
  if (before) {
    const dueChanged =
      "dueAt" in clean && (clean.dueAt || null) !== (before.dueAt || null);
    const resolvedFlipped =
      "status" in clean &&
      RESOLVED_STATUSES.has(clean.status) !== RESOLVED_STATUSES.has(before.status);
    if (dueChanged || resolvedFlipped) clean.dueNotifiedAt = null;
  }
  // Optimistic concurrency: when the client sends the version it last saw,
  // guard the UPDATE on it. A mismatch (someone else edited the task in the
  // interim) matches zero rows; if the task still exists we raise 409 with the
  // CURRENT server task so the client can reconcile instead of silently
  // clobbering. A guardless update (no version) keeps last-write-wins.
  const expected =
    version === undefined || version === null || version === ""
      ? undefined
      : Number(version);
  const res = await db.tasks.update(id, clean, expected);
  let t: any;
  if (expected !== undefined && res && typeof res === "object" && "matched" in res) {
    if (!res.matched) {
      const current = res.task; // freshly re-read row (null if it was deleted)
      if (!current) {
        const e: any = new Error("This task no longer exists.");
        e.status = 404;
        throw e;
      }
      const e: any = new Error(
        "This task was changed by someone else. Review the latest version before saving.",
      );
      e.status = 409;
      e.code = "task_version_conflict";
      e.current = await serializeTask(current);
      throw e;
    }
    t = res.task;
  } else {
    t = res;
  }
  if (t && before) {
    if (clean.status && clean.status !== before.status)
      await db.tasks.logActivity(id, actorId, "status_changed", {
        from: before.status,
        to: clean.status,
      });
    if (
      "assigneeId" in clean &&
      (clean.assigneeId || null) !== (before.assigneeId || null)
    )
      await db.tasks.logActivity(id, actorId, "assigned", {
        to: clean.assigneeId || null,
      });
    const other = Object.keys(clean).filter(
      (k) => k !== "status" && k !== "assigneeId",
    );
    if (other.length)
      await db.tasks.logActivity(id, actorId, "updated", { fields: other });
  }
  // BACK-COMPAT bridge: a legacy single-`assigneeId` PATCH set the denormalized
  // column above (so the version-guarded UPDATE + 409 contract is unchanged). Now
  // reconcile the canonical join table to match — REPLACE the whole set with the
  // single id (or empty when cleared) so task_assignees never drifts from
  // assignee_id. setAssignees re-points the primary + auto-watches the new
  // assignee. Only runs when assigneeId actually changed. (The multi-assignee
  // endpoints write the join table directly and don't take this path.)
  if (
    t &&
    "assigneeId" in clean &&
    before &&
    (clean.assigneeId || null) !== (before.assigneeId || null) &&
    db.tasks.setAssignees
  ) {
    await db.tasks.setAssignees(id, clean.assigneeId ? [clean.assigneeId] : [], actorId);
    if (clean.assigneeId && db.tasks.addWatcher)
      await db.tasks.addWatcher(id, clean.assigneeId).catch(() => {});
    const fresh = await db.tasks.getById(id);
    if (fresh) t = fresh;
  }
  // RECURRING (feature #52a): a PATCH that completes the task (detail Status select,
  // or the "keep my changes" conflict path) spawns the next occurrence exactly once
  // — same rule as move(). Only on a fresh completion (before wasn't already done).
  let spawned: any = null;
  if (
    t &&
    before &&
    "status" in clean &&
    DONE_STATUSES.has(clean.status) &&
    !DONE_STATUSES.has(before.status)
  )
    spawned = await spawnNextTask(before, actorId);
  const out = t ? await serializeTask(t) : null;
  if (out && spawned) (out as any)._spawned = spawned;
  return out;
}
async function remove({ id, actorId }: any) {
  await assertTaskAccess(id, actorId);
  await db.tasks.remove(id, actorId);
  return { id, deleted: true };
}
async function getActivity(taskId, userId) {
  await assertTaskReadAccess(taskId, userId);
  return Promise.all(
    (await db.tasks.activity(taskId)).map(serializeTaskActivity),
  );
}
async function getDependencies(id, userId = null) {
  if (userId) await assertTaskReadAccess(id, userId);
  const d = await db.tasks.deps(id);
  const slim = (t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
  });
  return { blockedBy: d.blockedBy.map(slim), blocking: d.blocking.map(slim) };
}
async function addDependency({ id, dependsOnId, actorId }: any) {
  await assertTaskAccess(id, actorId);
  // A blank dependency target is a no-op (not an error) — matches prior behavior.
  if (!dependsOnId) return getDependencies(id);
  await assertTaskAccess(dependsOnId, actorId);
  // CIRCULAR-DEPENDENCY detection (P0): block a self-edge AND any longer cycle
  // (A→B then B→A, or A→B→C→A). Walk the live graph from the would-be target
  // back toward the source; if the source is already reachable, this edge would
  // close a loop. Reject with 400 instead of persisting an unsatisfiable graph.
  if (await wouldCreateCycle(id, dependsOnId))
    throw badRequest("That dependency would create a circular dependency.");
  await db.tasks.addDep(id, dependsOnId);
  await db.tasks.logActivity(id, actorId, "dependency_added", { dependsOnId });
  return getDependencies(id);
}
async function removeDependency({ id, dependsOnId, actorId }: any) {
  await assertTaskAccess(id, actorId);
  await db.tasks.removeDep(id, dependsOnId);
  return getDependencies(id);
}
// ---------------------------------------------------------------------------
// ATTACHMENTS (feature #51)
// ---------------------------------------------------------------------------
// We do NOT reimplement uploads here: the client uploads the blob through the
// EXISTING Files pipeline (POST /api/files → fileService.create → S3 multipart),
// which yields a `files` row; this LINKS that file to a task. The link inherits
// the Files permission model — so download/authz reuse fileService.permissionFor,
// and the heavy streaming/GC machinery is shared verbatim.
//
// Authz: only someone with task access (reporter or an assignee) may attach,
// detach, or list — gated by assertTaskAccess / assertTaskReadAccess, exactly
// like comments/deps. The actor must ALSO be able to see the file they're linking
// (fileService.permissionFor) so a user can't graft a file they have no rights to
// onto a task as a way to leak it.
async function listAttachments(id, userId) {
  await assertTaskReadAccess(id, userId);
  return db.tasks.attachments(id);
}
async function attach({ id, fileId, actorId }: any) {
  await assertTaskAccess(id, actorId);
  if (!fileId) {
    const e: any = new Error("No file to attach.");
    e.status = 400;
    throw e;
  }
  // The actor must have at least VIEW on the file (the Files permission model) —
  // otherwise attaching would be a way to surface a file they can't access.
  const perm = await fileService.permissionFor(fileId, actorId);
  if (!perm) {
    const e: any = new Error("You don't have access to that file.");
    e.status = 403;
    throw e;
  }
  await db.tasks.addAttachment(id, fileId, actorId);
  await db.tasks.logActivity(id, actorId, "attachment_added", { fileId });
  return db.tasks.attachments(id);
}
async function detach({ id, fileId, actorId }: any) {
  await assertTaskAccess(id, actorId);
  // Only detach a link that actually exists (so a 404-ish no-op stays harmless).
  const linked = await db.tasks.hasAttachment(id, fileId);
  await db.tasks.removeAttachment(id, fileId, actorId);
  // Unlink AND soft-delete the underlying file (into the owner's recycle bin) so
  // "remove" truly removes it — but only the file OWNER's remove() will land
  // (fileService.remove guards on uploaderId), so detaching someone else's file
  // just drops the link, leaving their file intact. Best-effort: a file-remove
  // failure never blocks the unlink.
  if (linked)
    await fileService
      .remove({ fileId, userId: actorId })
      .catch(() => {});
  await db.tasks.logActivity(id, actorId, "attachment_removed", { fileId });
  return db.tasks.attachments(id);
}
async function getComments(taskId, userId) {
  await assertTaskReadAccess(taskId, userId);
  return Promise.all(
    (await db.tasks.comments(taskId)).map(serializeTaskComment),
  );
}
async function addComment({ id, authorId, body }: any) {
  // A WATCHER may comment (read access is enough to participate in the thread);
  // commenting then auto-watches the author so they keep following the task.
  await assertTaskReadAccess(id, authorId);
  const clean = (body || "").trim();
  if (!clean) return getComments(id, authorId);
  await db.tasks.addComment(id, authorId, clean);
  await db.tasks.logActivity(id, authorId, "commented", {});
  // Auto-watch the commenter (a sensible default: people in the conversation
  // follow it). Best-effort — never block the comment on a watch-write failure.
  if (db.tasks.addWatcher)
    await db.tasks.addWatcher(id, authorId).catch(() => {});
  return getComments(id, authorId);
}
async function removeComment({ id, commentId, userId }: any) {
  await assertTaskAccess(id, userId);
  await db.tasks.removeComment(commentId, userId);
  return getComments(id, userId);
}
// ---------------------------------------------------------------------------
// MULTIPLE ASSIGNEES
// ---------------------------------------------------------------------------
// Add one assignee. Only a reporter/assignee may change the assignee set
// (assertTaskAccess gates it). The newly-assigned user auto-watches the task.
// Returns the freshly serialized task (so `assignees[]` + `assignee` primary are
// current). `actorId` is recorded as the assigner.
async function assign({ id, userId, actorId }: any) {
  await assertTaskAccess(id, actorId);
  if (!userId) return getById(id, actorId);
  const before = await db.tasks.assignees(id);
  await db.tasks.addAssignee(id, userId, actorId);
  if (db.tasks.addWatcher) await db.tasks.addWatcher(id, userId).catch(() => {});
  if (!before.includes(userId))
    await db.tasks.logActivity(id, actorId, "assignee_added", { user: userId });
  return getById(id, actorId);
}
// Remove one assignee.
async function unassign({ id, userId, actorId }: any) {
  await assertTaskAccess(id, actorId);
  if (!userId) return getById(id, actorId);
  const before = await db.tasks.assignees(id);
  await db.tasks.removeAssignee(id, userId);
  if (before.includes(userId))
    await db.tasks.logActivity(id, actorId, "assignee_removed", {
      user: userId,
    });
  return getById(id, actorId);
}
// Replace the whole assignee set. Auto-watch each NEW assignee. Logs the net add
// of newly-assigned users (so they can be notified by the route).
async function setAssignees({ id, userIds, actorId }: any) {
  await assertTaskAccess(id, actorId);
  const wanted = [...new Set((userIds || []).filter(Boolean))];
  const before = await db.tasks.assignees(id);
  await db.tasks.setAssignees(id, wanted, actorId);
  const added = wanted.filter((u) => !before.includes(u));
  const removed = before.filter((u) => !wanted.includes(u));
  for (const u of added)
    if (db.tasks.addWatcher) await db.tasks.addWatcher(id, u).catch(() => {});
  if (added.length || removed.length)
    await db.tasks.logActivity(id, actorId, "assignees_set", {
      added,
      removed,
    });
  return { task: await getById(id, actorId), added, removed };
}

// ---------------------------------------------------------------------------
// WATCHERS
// ---------------------------------------------------------------------------
// Toggle the current user as a watcher. Watching only requires READ access (a
// watcher can already read, and a reporter/assignee obviously can) — so anyone
// who can see the task may follow/unfollow it for themselves. Returns the new
// watcher id list.
async function watch({ id, userId }: any) {
  await assertTaskReadAccess(id, userId);
  if (db.tasks.addWatcher) await db.tasks.addWatcher(id, userId);
  return db.tasks.watchers(id);
}
async function unwatch({ id, userId }: any) {
  // No access assertion needed to STOP watching — a user may always remove
  // themselves; the driver scopes the delete to (task,user) so it can only ever
  // affect the caller's own watch row.
  if (db.tasks.removeWatcher) await db.tasks.removeWatcher(id, userId);
  return db.tasks.watchers(id);
}
async function getWatchers(id, userId) {
  await assertTaskReadAccess(id, userId);
  return db.tasks.watchers(id);
}
// Single-task serialize helper used by the assignee/watch ops so the route gets
// back the full serialized task (assignees[] + watchers + primary) after a change.
async function getById(id, userId?) {
  if (userId) await assertTaskReadAccess(id, userId);
  const t = await db.tasks.getById(id);
  return t ? serializeTask(t) : null;
}

// ---------------------------------------------------------------------------
// SUBTASKS / PROGRESS (feature #52a)
// ---------------------------------------------------------------------------
// A subtask is an ordinary task row with parent_task_id set. Access to a subtask
// is the SAME assertTaskAccess gate as any task (the row carries its own reporter/
// assignees) — no special inheritance is needed, and that keeps it IDOR-safe: a
// user with no access to the subtask can't read or mutate it just because they can
// see the parent. Listing/creating subtasks requires access to the PARENT.

// The serialized live subtasks of a parent. Read access to the parent is required
// (a watcher may view). Each subtask is fully serialized (progress, assignees, …).
async function listSubtasks(parentId: string, userId: string) {
  await assertTaskReadAccess(parentId, userId);
  const rows = db.tasks.subtasks ? await db.tasks.subtasks(parentId) : [];
  return serializeTaskList(rows);
}

// Create a subtask under a parent. The actor must have MUTATE access to the parent
// (reporter/assignee) — adding a child is changing the parent. The child inherits
// the parent's reporter (so it's "theirs"), defaults to the actor as reporter
// otherwise. A blank title is rejected (same validation as create). Returns the
// serialized new subtask.
async function createSubtask({ parentId, title, actorId, assigneeId, priority, dueAt }: any) {
  const parent = await assertTaskAccess(parentId, actorId);
  const cleanTitle = validateTitle(title);
  if (priority != null) validatePriority(priority);
  validateDueAt(dueAt);
  const t = await db.tasks.create({
    title: cleanTitle,
    status: "todo",
    priority: priority || "Medium",
    assigneeId: assigneeId || null,
    dueAt: dueAt || null,
    reporterId: (parent && parent.reporterId) || actorId || null,
    parentTaskId: parentId,
  });
  await db.tasks.logActivity(t.id, actorId, "subtask_added", { parentId, title: t.title });
  await db.tasks.logActivity(parentId, actorId, "subtask_added", { subtaskId: t.id, title: t.title });
  return serializeTask(t);
}

// Re-parent (or un-parent: parentId=null) a task. Guards against a CYCLE — a task
// can't become a descendant of itself (the subtask analogue of the dependency
// cycle guard). The actor needs mutate access to BOTH the task and (when setting a
// parent) the new parent.
async function setParent({ id, parentId, actorId }: any) {
  await assertTaskAccess(id, actorId);
  if (parentId) {
    await assertTaskAccess(parentId, actorId);
    if (id === parentId)
      throw badRequest("A task can't be its own subtask.");
    // Reject if `id` is an ANCESTOR of the would-be parent (that would close a
    // loop: making id a child of one of its own descendants).
    if (db.tasks.isAncestorOf && (await db.tasks.isAncestorOf(id, parentId)))
      throw badRequest("That would create a circular subtask relationship.");
  }
  const t = await db.tasks.update(id, { parentTaskId: parentId || null });
  await db.tasks.logActivity(id, actorId, "parent_changed", { parentId: parentId || null });
  return t ? serializeTask(t) : null;
}

// ---------------------------------------------------------------------------
// CSV EXPORT (feature #52a)
// ---------------------------------------------------------------------------
// CSV INJECTION GUARD: a spreadsheet treats a cell beginning with = + - @ (or a
// tab/CR that can lead into one) as a FORMULA, so an attacker-controlled task
// title like `=cmd|'/c calc'!A1` would execute on open. We neutralize this by
// prefixing such a cell with a single quote, the OWASP-recommended mitigation,
// THEN apply normal RFC-4180 CSV quoting (double quotes, escape embedded quotes,
// wrap when the value contains a comma/quote/newline). Both steps always run, so a
// value that needs neither is emitted bare.
const CSV_INJECTION_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);
function csvField(value: any): string {
  let s = value == null ? "" : String(value);
  // 1) Injection guard: neutralize a leading formula trigger BEFORE quoting.
  if (s.length && CSV_INJECTION_LEAD.has(s[0])) s = "'" + s;
  // 2) RFC-4180 quoting: wrap + double-up quotes when the value needs it.
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function csvRow(fields: any[]): string {
  return fields.map(csvField).join(",");
}
const CSV_HEADERS = [
  "id",
  "title",
  "status",
  "priority",
  "assignees",
  "reporter",
  "due",
  "created",
  "recurrence",
  "labels",
  "project",
  "progress",
];
// One serialized task → its RFC-4180 CSV row (12 columns, every field escaped +
// injection-guarded by csvField). Shared by the streaming + buffered exporters so
// the column order can never drift between them.
function taskCsvRow(t: any): string {
  const assignees = (t.assignees || []).map((a: any) => a && a.name).filter(Boolean).join("; ");
  const reporter = (t.reporter && t.reporter.name) || "";
  const labels = (t.labels || []).join("; ");
  const progress = t.subtaskCount > 0 ? `${t.doneSubtaskCount}/${t.subtaskCount}` : "";
  return csvRow([
    t.id,
    t.title,
    t.status,
    t.priority,
    assignees,
    reporter,
    t.dueAt || "",
    t.createdAt || "",
    t.recurrence || "none",
    labels,
    t.project || "",
    progress,
  ]);
}

// STREAM the CSV for every task the user can access (the FULL accessible set, not
// a page) — pushing each chunk through `write` (e.g. res.write) so memory stays
// O(page), not O(account). The route's "stream" claim is now literally true: we
// walk the accessible set in keyset PAGES (db.tasks.listForUserPage), serialize +
// emit one page, then move to the next, never holding the whole CSV in memory.
//
// Authz-scoped (no IDOR): listForUserPage uses the SAME reporter/assignee
// predicate as the list, so a caller can only ever export their OWN accessible
// tasks. CRLF line terminator (RFC-4180, opens cleanly in Excel); a trailing
// newline keeps POSIX tools happy. Falls back to the single-shot listAllForUser
// (still capped) when the paged driver method is absent (older driver).
const CSV_EXPORT_PAGE = 1000;
async function exportCsvStream(
  userId: string,
  write: (chunk: string) => void,
): Promise<void> {
  write(csvRow(CSV_HEADERS) + "\r\n");
  if (db.tasks.listForUserPage) {
    let cursor: any = null;
    // Bound the total like the old single-shot cap so a pathological account can't
    // stream unboundedly; the per-page memory is what we actually fixed.
    let remaining = 100000;
    for (;;) {
      const page = await db.tasks.listForUserPage(userId, {
        limit: Math.min(CSV_EXPORT_PAGE, remaining),
        cursor,
      });
      const rows = page.tasks || [];
      if (rows.length) {
        const serialized = await serializeTaskList(rows);
        let buf = "";
        for (const t of serialized) buf += taskCsvRow(t) + "\r\n";
        write(buf); // one write per page — O(page) memory, not O(account)
      }
      remaining -= rows.length;
      if (!page.hasMore || remaining <= 0 || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return;
  }
  // Fallback (older driver without listForUserPage): single capped read, still
  // serialized + emitted in one chunk.
  const rows = db.tasks.listAllForUser
    ? await db.tasks.listAllForUser(userId)
    : (await list(userId, { limit: 100000 })).tasks;
  const serialized = await serializeTaskList(rows);
  let buf = "";
  for (const t of serialized) buf += taskCsvRow(t) + "\r\n";
  if (buf) write(buf);
}

// Buffered variant — assembles the whole CSV string (used by tests / any caller
// that wants the text rather than a stream). Delegates to exportCsvStream so the
// row format + authz can never diverge between the two.
async function exportCsv(userId: string): Promise<string> {
  let out = "";
  await exportCsvStream(userId, (chunk) => {
    out += chunk;
  });
  return out;
}

async function bulk({ ids, action, value, actorId }: any) {
  if (!Array.isArray(ids) || !ids.length) return { count: 0 };
  for (const id of ids) await assertTaskAccess(id, actorId);
  if (action === "delete") return db.tasks.bulkRemove(ids);
  // Dependency enforcement on the BULK path (feature #51): completing a task while
  // its blockers are still open is rejected server-side in move()/update(); the bulk
  // endpoint must honor the SAME rule so no client (UI or raw POST /api/tasks/bulk)
  // can sidestep it. For a done-equivalent target we partition the ids into those
  // clear to complete and those still blocked: the clear ones are applied, the
  // blocked ones are SKIPPED and returned so the client can surface why (rather than
  // throwing and failing the whole mixed batch). A no-op for non-completion targets.
  const applyTo = async (targetIds, patch, kind, detail) => {
    if (!targetIds.length) return { count: 0 };
    const r = await db.tasks.bulkPatch(targetIds, patch);
    await db.tasks.bulkLog(targetIds, actorId, kind, detail);
    return r;
  };
  const apply = (patch, kind, detail) => applyTo(ids, patch, kind, detail);
  const partitionByBlockers = async () => {
    const allowed: string[] = [];
    const blocked: { id: string; blockers: any[] }[] = [];
    // The pre-transition rows for the ids that are NOT already done — so the
    // recurrence spawn (below) fires only on FRESH completions (mirrors move()).
    const freshBefore: any[] = [];
    for (const id of ids) {
      const before = await db.tasks.getById(id);
      // Re-saving a task that's already done must never trip (idempotent), and a
      // missing/blocked-task check mirrors assertCanTransition's fast-paths.
      if (before && DONE_STATUSES.has(before.status)) {
        allowed.push(id);
        continue;
      }
      const open = await openBlockers(id);
      if (open.length)
        blocked.push({
          id,
          blockers: open.map((b) => ({ id: b.id, title: b.title, status: b.status })),
        });
      else {
        allowed.push(id);
        if (before) freshBefore.push(before);
      }
    }
    return { allowed, blocked, freshBefore };
  };
  // Spawn next occurrences for every recurring task that just FRESHLY completed via
  // this bulk action (exactly-once per occurrence, guarded by the advisory lock).
  // COLLECT the spawned occurrences (serialized) and return them on the result as
  // `_spawned` so the /bulk route can wake THEIR rooms too — the bulk route only
  // re-serializes the original idList ids, and a spawned occurrence has a brand-new
  // id not in idList, so without this its assignees'/watchers' boards would not see
  // the new occurrence live (only on a manual refetch). Mirrors how move()/update()
  // attach `_spawned`; falsy spawns (not recurring / already spawned) are dropped.
  const spawnForBatch = async (freshBefore: any[]) => {
    const spawned: any[] = [];
    for (const before of freshBefore) {
      const s = await spawnNextTask(before, actorId);
      if (s) spawned.push(s);
    }
    return spawned;
  };
  if (action === "move") {
    validateStatus(value);
    if (DONE_STATUSES.has(value)) {
      const { allowed, blocked, freshBefore } = await partitionByBlockers();
      const r = await applyTo(allowed, { status: value }, "status_changed", { to: value });
      const spawned = await spawnForBatch(freshBefore);
      return { ...r, ...(blocked.length ? { blocked } : {}), ...(spawned.length ? { _spawned: spawned } : {}) };
    }
    return apply({ status: value }, "status_changed", { to: value });
  }
  if (action === "complete") {
    const { allowed, blocked, freshBefore } = await partitionByBlockers();
    const r = await applyTo(allowed, { status: "done" }, "status_changed", { to: "done" });
    const spawned = await spawnForBatch(freshBefore);
    return { ...r, ...(blocked.length ? { blocked } : {}), ...(spawned.length ? { _spawned: spawned } : {}) };
  }
  if (action === "archive")
    return apply({ status: "archived" }, "status_changed", { to: "archived" });
  if (action === "assign") {
    const r = await apply({ assigneeId: value || null }, "assigned", {
      to: value || null,
    });
    // Reconcile the canonical join table for each task so it matches the new
    // single primary (back-compat bridge, same as the single-PATCH path). Replace
    // the set with [value] (or empty), re-pointing the primary + auto-watching.
    if (db.tasks.setAssignees)
      for (const id of ids) {
        await db.tasks.setAssignees(id, value ? [value] : [], actorId);
        if (value && db.tasks.addWatcher)
          await db.tasks.addWatcher(id, value).catch(() => {});
      }
    return r;
  }
  return { count: 0 };
}
export {
  list,
  create,
  move,
  update,
  remove,
  getActivity,
  getDependencies,
  addDependency,
  removeDependency,
  // Attachments (feature #51): link/unlink/list files on a task (reuses Files).
  listAttachments,
  attach,
  detach,
  getComments,
  addComment,
  removeComment,
  bulk,
  // Multiple assignees + watchers (feature #50).
  assign,
  unassign,
  setAssignees,
  watch,
  unwatch,
  getWatchers,
  // Single-task serialize-by-id (read-access gated) — used by assignee/watch ops
  // and exposed for tests / project reads.
  getById,
  // Subtasks / progress + recurrence + CSV export (feature #52a).
  listSubtasks,
  createSubtask,
  setParent,
  spawnNextTask,
  exportCsv,
  exportCsvStream,
  // Projects-as-entities + saved views / swimlanes (feature #52b).
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  resolveProject,
  listSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  // Saved-view filter sanitizer + validators (pure; exposed for unit tests — the
  // sanitizer is the security-critical "no arbitrary filter" surface).
  sanitizeViewFilter,
  validateViewName,
  validateGroupBy,
  validateSort,
  validateProjectName,
  validateColor,
  // Exposed for unit tests + reuse: the read/mutation access gates + the
  // validation allow-lists/helpers and the cycle detector are pure (no transport)
  // and are the server's authority.
  assertTaskAccess,
  assertTaskReadAccess,
  validateTitle,
  validateStatus,
  validatePriority,
  validateDueAt,
  validateRecurrence,
  wouldCreateCycle,
  // Dependency enforcement (feature #51): the done-while-blocked guard + the
  // open-blocker query are pure server authority, exposed for unit tests.
  openBlockers,
  assertCanTransition,
  // CSV export helpers (feature #52a) — pure, exposed for unit tests (the
  // injection guard + RFC-4180 quoting are the security-critical surface).
  csvField,
  csvRow,
  nextDue,
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_RECURRENCES,
};
