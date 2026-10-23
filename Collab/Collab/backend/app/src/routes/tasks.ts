import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, fail, shared, db } from "../platform";
import authMiddleware from "../middleware/auth";
import {
  list,
  create,
  move,
  update,
  remove,
  getActivity,
  getDependencies,
  addDependency,
  removeDependency,
  listAttachments,
  attach,
  detach,
  getComments,
  addComment,
  removeComment,
  bulk,
  assign,
  unassign,
  setAssignees,
  watch,
  unwatch,
  getWatchers,
  listSubtasks,
  createSubtask,
  setParent,
  exportCsvStream,
  // Projects-as-entities + saved views / swimlanes (feature #52b).
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  listSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
} from "../services/taskService";
import * as notificationService from "../services/notificationService";
import { send as sendMessage } from "../services/messageService";
import { serializeTask } from "../serialize";
import { broadcast } from "../realtime/socket";
import { pushNotif } from "../realtime/notify";
const { EVENTS } = shared;

// Human status labels for watcher notifications ("moved … to In progress").
// Mirrors the board column labels in TasksView.tsx.
const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  inprogress: "In progress",
  review: "In review",
  blocked: "Blocked",
  done: "Done",
  archived: "Archived",
};

// SCOPED task broadcast. A task is shared between (at most) its reporter and its
// assignee, so a TASK_CHANGED only needs to wake THOSE users' rooms — never every
// connected client (the old global `io.emit` was an O(N) fan-out that made each
// change a herd refetch). This mirrors how Reminders/Files scope their
// *_CHANGED emit to `broadcast.userRoom(...)`. Pass every user whose board could
// be affected: the task's reporter + assignee, the acting user, and (on
// reassignment) the PREVIOUS assignee so their board drops the task live.
// Socket.IO de-dupes overlapping rooms, so duplicates are harmless.
const emitTask = (req, ...tasks /* (task|null) ... */) => {
  const io = req.app.get("io");
  if (!io) return;
  for (const uid of taskRoomUsers(req, tasks))
    io.to(broadcast.userRoom(uid)).emit(EVENTS.TASK_CHANGED, {});
};

// The set of user ids whose board could be affected by a change to these tasks:
// the actor + each task's reporter + ALL assignees + ALL watchers + (on a
// reassignment) any prev-assignee/prev-watcher ids carried on the object. Handles
// BOTH raw repo rows (assigneeId/reporterId) and serialized tasks (assignee /
// assignees[] / reporter / watchers[]). Socket.IO de-dupes overlapping rooms.
function taskRoomUsers(req, tasks: any[]): Set<string> {
  const uids = new Set<string>();
  if (req.user && req.user.userId) uids.add(req.user.userId);
  for (const t of tasks) {
    if (!t) continue;
    if (t.reporterId) uids.add(t.reporterId);
    if (t.reporter && t.reporter.id) uids.add(t.reporter.id);
    if (t.assigneeId) uids.add(t.assigneeId);
    if (t.assignee && t.assignee.id) uids.add(t.assignee.id);
    for (const a of t.assignees || []) if (a && a.id) uids.add(a.id);
    for (const w of t.watchers || []) if (w) uids.add(typeof w === "string" ? w : w.id);
    if (t.prevAssigneeId) uids.add(t.prevAssigneeId);
    for (const p of t.prevAssigneeIds || []) if (p) uids.add(p);
    for (const w of t.prevWatchers || []) if (w) uids.add(typeof w === "string" ? w : w.id);
  }
  return uids;
}

// Serialize a task by id (full assignees[] + watchers) for routing the scoped
// emit on the comment/deps paths — a raw repo row lacks the watcher set, so a
// watcher-only follower wouldn't be reached. Null-safe (deleted/missing → null).
async function serializeTaskById(id: string) {
  const row = await db.tasks.getById(id).catch(() => null);
  return row ? await serializeTask(row) : null;
}

// Resolve the @mention tokens in `body` to real user ids (the app's first-name
// convention, restricted to real members) — used to EXCLUDE just-mentioned users
// from the generic watcher "commented" notification so they aren't told twice.
async function mentionedUserIds(body: any): Promise<string[]> {
  try {
    if (!body) return [];
    const members = await db.users.list();
    return await notificationService.resolveMentionedUserIds(body, members || []);
  } catch (_) {
    return [];
  }
}

// When a task is assigned to someone OTHER than the actor, deliver a live
// notification (toast + Activity badge + notification center) AND nudge that
// user's task board to refetch — so an assigned task appears instantly for the
// assignee with no refresh. Never throws into the request path.
async function notifyAssignee(req: any, task: any, assigneeId: any) {
  const actor = req.user.userId;
  if (!assigneeId || assigneeId === actor || !task) return;
  const io = req.app.get("io");
  try {
    const assigner = await db.users.getById(actor);
    const n = await notificationService.notifyTaskAssigned({
      userId: assigneeId,
      assignerName: (assigner && assigner.name) || "Someone",
      taskId: task.id,
      taskTitle: task.title || "a task",
    });
    pushNotif(io, n);
    if (io) io.to(broadcast.userRoom(assigneeId)).emit(EVENTS.TASK_CHANGED, {});
  } catch (_) {
    /* a notification failure must never break task creation/update */
  }
}

// Notify each NEW assignee (other than the actor) when a task's assignee SET
// changes — the multi-assignee twin of notifyAssignee. Each newly-assigned user
// gets the task_assigned notification + a board nudge.
async function notifyNewAssignees(req: any, task: any, addedIds: string[]) {
  const actor = req.user.userId;
  if (!task || !addedIds || !addedIds.length) return;
  const io = req.app.get("io");
  try {
    const assigner = await db.users.getById(actor);
    const assignerName = (assigner && assigner.name) || "Someone";
    for (const uid of new Set(addedIds)) {
      if (!uid || uid === actor) continue;
      const n = await notificationService.notifyTaskAssigned({
        userId: uid,
        assignerName,
        taskId: task.id,
        taskTitle: task.title || "a task",
      });
      pushNotif(io, n);
      if (io) io.to(broadcast.userRoom(uid)).emit(EVENTS.TASK_CHANGED, {});
    }
  } catch (_) {
    /* a notification failure must never break the assign op */
  }
}

// @mentions in a task DESCRIPTION or COMMENT: resolve each mention to a REAL user
// (the app's @first-name convention via resolveMentionedUserIds against real
// members), notify them (task_mention, deep-links to the task), auto-watch them,
// and nudge their board. De-duped; never notifies the author of their own
// mention. Reuses the EXISTING notify path (pushNotif → quiet-hours gate). Never
// throws into the request path.
//
// `prevBody` is the body BEFORE this save (the previous description). Only users
// who are mentioned in the NEW body but were NOT already mentioned in the
// previous body are notified — so editing one unrelated word in a description
// that retains `@Alice @Bob @Carol` does NOT re-ping all three. For create
// (prevBody undefined → empty previous set) every mention is new; comments have
// no edit path so the caller passes no prevBody (all new).
async function notifyTaskMentions(
  req: any,
  taskId: string,
  authorId: string,
  body: any,
  prevBody?: any,
) {
  try {
    if (!body) return;
    const io = req.app.get("io");
    const [author, task, candidates] = await Promise.all([
      db.users.getById(authorId),
      db.tasks.getById(taskId),
      db.users.list(), // real members only — a mention can't notify a non-member
    ]);
    const mentionerName = (author && author.name) || "Someone";
    const userIds = await notificationService.resolveMentionedUserIds(
      body,
      candidates || [],
    );
    // Mentions that already existed in the previous body — re-notifying these on
    // an edit is the re-ping storm. Resolve them against the SAME candidate set
    // (one extra in-memory pass; no DB beyond the getByName fallback).
    const already = new Set<string>(
      prevBody
        ? await notificationService.resolveMentionedUserIds(prevBody, candidates || [])
        : [],
    );
    for (const uid of userIds) {
      if (!uid || uid === authorId) continue; // don't notify self-mention
      // Auto-watch the mentioned user so they follow the task going forward.
      // (Idempotent on the PK — safe even for an already-mentioned user.)
      if (db.tasks.addWatcher) await db.tasks.addWatcher(taskId, uid).catch(() => {});
      // Only NOTIFY a freshly-added mention — an already-mentioned user that
      // survives the edit must not be re-pinged.
      if (already.has(uid)) continue;
      const n = await notificationService.notifyTaskMention({
        userId: uid,
        mentionerName,
        taskId,
        taskTitle: (task && task.title) || "a task",
      });
      pushNotif(io, n);
      if (io) io.to(broadcast.userRoom(uid)).emit(EVENTS.TASK_CHANGED, {});
    }
  } catch (_) {
    /* a mention-notify failure must never break the save/comment */
  }
}

// Notify WATCHERS (other than the actor, and not already directly notified) about
// a meaningful change — a status move or a new comment. Reuses the existing notify
// path. `exclude` are user ids already told some other way (assignee/mention) so
// they aren't double-notified. Never throws into the request path.
async function notifyWatchers(
  req: any,
  taskId: string,
  kind: "status" | "comment",
  detail: any,
  exclude: Iterable<string> = [],
) {
  try {
    const actor = req.user.userId;
    const io = req.app.get("io");
    const [actorUser, task, watchers] = await Promise.all([
      db.users.getById(actor),
      db.tasks.getById(taskId),
      db.tasks.watchers ? db.tasks.watchers(taskId) : Promise.resolve([]),
    ]);
    if (!task) return;
    const actorName = (actorUser && actorUser.name) || "Someone";
    const skip = new Set<string>([actor, ...exclude]);
    for (const uid of watchers || []) {
      if (!uid || skip.has(uid)) continue;
      const n = await notificationService.notifyTaskWatched({
        userId: uid,
        actorName,
        taskId,
        taskTitle: task.title || "a task",
        kind,
        detail,
      });
      pushNotif(io, n);
      if (io) io.to(broadcast.userRoom(uid)).emit(EVENTS.TASK_CHANGED, {});
    }
  } catch (_) {
    /* a watcher-notify failure must never break the change */
  }
}

router.use(authMiddleware);
// GET /api/tasks/export.csv — stream the caller's FULL accessible task set as CSV
// (feature #52a). authz-scoped (exportCsvStream → listForUserPage uses the same
// reporter/assignee predicate as the list, so a caller can only export their own
// accessible tasks). Every field is CSV-escaped AND guarded against CSV INJECTION (a leading
// = + - @ is neutralized). Registered BEFORE the parameterized routes so the
// literal path isn't shadowed. Not wrapped in the { ok } envelope — it returns raw
// text/csv with a download disposition.
router.get("/export.csv", async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="tasks-${stamp}.csv"`,
  );
  // STREAM the rows out a page at a time (res.write per page) so server memory
  // stays O(page) regardless of how many tasks the account has — the comment's
  // "stream" claim is now literally true. exportCsvStream is authz-scoped (same
  // reporter/assignee predicate as the list, no IDOR). Once the first chunk is
  // written the headers are committed, so a mid-stream DB error can't switch to a
  // JSON error envelope — log it and end the response.
  try {
    await exportCsvStream(req.user.userId, (chunk) => res.write(chunk));
    res.end();
  } catch (e) {
    if (res.headersSent) {
      try { res.end(); } catch (_) {}
    } else {
      // Nothing written yet — fall back to the buffered exporter via the central
      // error handler (re-throw so it produces the standard error envelope).
      throw e;
    }
  }
});
// ---- PROJECTS-AS-ENTITIES (feature #52b) -----------------------------------
// Owner-scoped task projects (a task's project must be one you can see — no
// IDOR; the service gates every op on owner_id). Registered BEFORE the
// parameterized /:id routes so the literal paths aren't shadowed. The scoped
// TASK_CHANGED emit on rename/delete wakes the owner's board so a renamed/removed
// project (which re-files tasks) reflects live.
router.get("/projects", async (req, res) =>
  res.json(ok(await listProjects(req.user.userId))),
);
router.post("/projects", async (req, res) => {
  const b = req.body || {};
  const p = await createProject({
    userId: req.user.userId,
    name: (b.name || "").trim(),
    color: b.color,
  });
  res.json(ok(p));
});
router.patch("/projects/:id", async (req, res) => {
  const b = req.body || {};
  const p = await updateProject({
    id: req.params.id,
    userId: req.user.userId,
    name: b.name,
    color: b.color,
    archived: b.archived,
  });
  // A rename mirrors into tasks.project text → wake the owner's board.
  const io = req.app.get("io");
  if (io) io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.TASK_CHANGED, {});
  res.json(ok(p));
});
router.delete("/projects/:id", async (req, res) => {
  const r = await deleteProject({ id: req.params.id, userId: req.user.userId });
  // Deleting a project un-files its tasks → wake the owner's board.
  const io = req.app.get("io");
  if (io) io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.TASK_CHANGED, {});
  res.json(ok(r));
});

// ---- SAVED VIEWS / SWIMLANES (feature #52b) --------------------------------
// User-scoped saved board views (a user only sees/edits their OWN — no IDOR).
// The stored `filter` JSON is validated server-side (only known keys/values).
router.get("/views", async (req, res) =>
  res.json(ok(await listSavedViews(req.user.userId))),
);
router.post("/views", async (req, res) => {
  const b = req.body || {};
  const v = await createSavedView({
    userId: req.user.userId,
    name: (b.name || "").trim(),
    filter: b.filter || {},
    groupBy: b.groupBy,
    sort: b.sort,
  });
  res.json(ok(v));
});
router.patch("/views/:id", async (req, res) => {
  const b = req.body || {};
  const v = await updateSavedView({
    id: req.params.id,
    userId: req.user.userId,
    name: b.name,
    filter: b.filter,
    groupBy: b.groupBy,
    sort: b.sort,
  });
  res.json(ok(v));
});
router.delete("/views/:id", async (req, res) => {
  const r = await deleteSavedView({ id: req.params.id, userId: req.user.userId });
  res.json(ok(r));
});

// GET /api/tasks?limit=&cursor=&project= — paginated. Returns { tasks, hasMore,
// nextCursor, count }. `cursor` is the opaque base64 keyset token from the
// previous page; `limit` is clamped server-side. `count` is the total live
// count (for badges that must not undercount once the client only holds a page).
// `project` (optional) constrains BOTH the page and count SERVER-SIDE: a project
// id filters to that project; the literal "none" filters to unfiled tasks.
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
  // `project` absent → no filter (undefined); "none" → unfiled (null); else id.
  let projectId: any = undefined;
  if (req.query.project !== undefined) {
    const p = String(req.query.project);
    projectId = p === "none" || p === "" ? null : p;
  }
  const page = await list(req.user.userId, { limit, cursor, projectId });
  res.json(
    ok({
      tasks: page.tasks,
      hasMore: page.hasMore,
      count: page.count,
      // Re-encode the keyset as an opaque token the client passes back verbatim.
      nextCursor: page.nextCursor
        ? Buffer.from(JSON.stringify(page.nextCursor), "utf8").toString("base64")
        : null,
    }),
  );
});
router.post("/", async (req, res) => {
  const b = req.body || {};
  const t = await create({
    title: (b.title || "").trim(),
    status: b.status || "todo",
    priority: b.priority || "Medium",
    dueLabel: b.dueLabel || null,
    dueAt: b.dueAt || null,
    assigneeId: b.assigneeId || null,
    description: b.description || null,
    labels: b.labels || [],
    project: b.project || null,
    // PROJECTS-AS-ENTITIES (#52b): the linked project id (IDOR-guarded server-side).
    projectId: b.projectId || null,
    recurrence: b.recurrence || "none",
    creatorId: req.user.userId,
  });
  emitTask(req, t);
  await notifyAssignee(req, t, b.assigneeId);
  // @mentions in the new task's description notify + auto-watch the mentioned.
  await notifyTaskMentions(req, t.id, req.user.userId, b.description);
  // ── Task card in chat (Unified Action Bar) ────────────────────────────────
  // When the task was created FROM a conversation (/task in the composer),
  // post an actionable card into that chat — the same engagement loop as the
  // meeting-invite card (meetings.ts postInviteCardTo): payload rides as JSON
  // in the body, serializeMessage parses it into `task`, the client renders a
  // "View task" card. Best-effort: membership is enforced by messageService
  // (assertMember), and a card failure must never fail the task creation.
  if (b.conversationId) {
    try {
      const cardIds: string[] = (
        Array.isArray(b.assigneeIds) && b.assigneeIds.length
          ? b.assigneeIds
          : [b.assigneeId]
      )
        .filter(Boolean)
        .slice(0, 12);
      let assigneeNames: string[] = [];
      if (cardIds.length && (db.users as any).getByIds) {
        const us = await (db.users as any).getByIds(cardIds);
        assigneeNames = (us || [])
          .map((u: any) => (u && u.name) || "")
          .filter(Boolean);
      }
      const msg = await sendMessage({
        conversationId: String(b.conversationId),
        senderId: req.user.userId,
        text: JSON.stringify({
          taskId: t.id,
          title: t.title || "Task",
          priority: t.priority || null,
          assigneeNames,
        }),
        file: null,
        type: "task_card",
        bumpUnread: true,
      });
      const io = req.app.get("io");
      if (io)
        io.to(broadcast.room(String(b.conversationId))).emit(
          EVENTS.MESSAGE_NEW,
          msg,
        );
    } catch (_) {
      /* not a member / card failure — the task itself succeeded */
    }
  }
  res.json(ok(t));
});
router.post("/bulk", async (req, res) => {
  const b = req.body || {};
  const idList = Array.isArray(b.ids) ? b.ids.filter(Boolean) : [];
  // Capture the PRE-mutation assignee + watcher sets (2 batched queries) so that
  // on a bulk reassign — which REPLACES each task's assignee set with the single
  // new value (taskService.bulk → setAssignees), dropping any prior secondary
  // assignees — those removed users are still woken so their board drops the
  // task live. assertTaskAccess inside bulk() still gates every id; these reads
  // are only for routing the emit.
  const prevAssigneesByTask: Record<string, string[]> =
    db.tasks.assigneesFor ? await db.tasks.assigneesFor(idList) : {};
  const prevWatchersByTask: Record<string, string[]> =
    db.tasks.watchersFor ? await db.tasks.watchersFor(idList) : {};
  // For a bulk DELETE the rows are soft-deleted, so a post-mutation serialize
  // returns null — capture the FULL serialized audience (reporter + assignees[]
  // + watchers) BEFORE the mutation while the rows still exist.
  const preDeleteFull: any[] =
    b.action === "delete"
      ? await Promise.all(idList.map((id) => serializeTaskById(id)))
      : [];
  const r = await bulk({
    ids: idList,
    action: b.action,
    value: b.value,
    actorId: req.user.userId,
  });
  // Serialize each affected task AFTER the mutation so the CURRENT assignee +
  // watcher set is reached (a raw repo row carries only reporter + PRIMARY
  // assignee, so secondary assignees and watchers would miss the TASK_CHANGED
  // and their boards would not update live after a bulk move/complete/archive/
  // assign). Carry the PRE-mutation assignee + watcher ids as prevAssigneeIds/
  // prevWatchers so anyone DROPPED by a bulk reassign is also woken. For delete
  // use the pre-mutation serialized snapshot (reporter + full audience).
  const tasks: any[] = [];
  for (let i = 0; i < idList.length; i++) {
    const id = idList[i];
    const prevAssignees = prevAssigneesByTask[id] || [];
    const prevWatchers = prevWatchersByTask[id] || [];
    if (b.action === "delete") {
      const snap = preDeleteFull[i];
      tasks.push(
        snap
          ? { ...snap, prevAssigneeIds: prevAssignees, prevWatchers }
          : { prevAssigneeIds: prevAssignees, prevWatchers },
      );
    } else {
      const full = await serializeTaskById(id);
      tasks.push(
        full
          ? { ...full, prevAssigneeIds: prevAssignees, prevWatchers }
          : { prevAssigneeIds: prevAssignees, prevWatchers },
      );
    }
  }
  // On a reassign, also wake the NEW assignee's room (value = the new assignee).
  const extra =
    b.action === "assign" && b.value ? [{ assigneeId: b.value }] : [];
  // RECURRING (feature #52a): a bulk complete/move-to-done may have spawned next
  // occurrences (carried on r._spawned) whose ids are NOT in idList — wake THEIR
  // audience (reporter + assignees + watchers, already serialized by bulk()) so
  // the new occurrences appear live, then strip the internal field from the
  // response envelope (same _spawned treatment move()/update() already use).
  const spawned: any[] = Array.isArray((r as any)._spawned) ? (r as any)._spawned : [];
  if ((r as any)._spawned) delete (r as any)._spawned;
  emitTask(req, ...tasks, ...extra, ...spawned);
  res.json(ok(r));
});
router.post("/:id/move", async (req, res) => {
  const prev = await db.tasks.getById(req.params.id);
  const t = await move({
    id: req.params.id,
    status: (req.body || {}).status,
    actorId: req.user.userId,
  });
  // RECURRING (feature #52a): a completion may have spawned the next occurrence
  // (carried on t._spawned) — wake ITS audience too so it appears live for its
  // assignees/watchers, then strip the internal field from the response.
  emitTask(req, t, t && (t as any)._spawned);
  if (t && (t as any)._spawned) delete (t as any)._spawned;
  // Watchers are told about a real status change (not a no-op move).
  if (t && prev && t.status !== prev.status)
    await notifyWatchers(req, req.params.id, "status", STATUS_LABEL[t.status] || t.status);
  res.json(ok(t));
});
router.patch("/:id", async (req, res) => {
  const prev = await db.tasks.getById(req.params.id);
  let t: any;
  try {
    t = await update({
      id: req.params.id,
      patch: req.body || {},
      actorId: req.user.userId,
      version: (req.body || {}).version,
    });
  } catch (e: any) {
    // Optimistic-concurrency conflict: return 409 WITH the current server task
    // (in `details.current`) so the client can reconcile/live-merge instead of
    // clobbering. Other errors propagate to the central error handler.
    if (e && e.status === 409) {
      return res
        .status(409)
        .json(
          fail("CONFLICT", e.message, {
            code: e.code || "task_version_conflict",
            current: e.current || null,
          }),
        );
    }
    throw e;
  }
  // Scope the broadcast to the task's reporter + ALL assignees + ALL watchers
  // AND, on a reassign, the previous assignee (so their board drops the task
  // live). `t` (serialized) carries assignees[] + watchers; `prev` the old primary.
  // A recurring completion may also carry the spawned next occurrence (_spawned) —
  // wake its audience too, then strip the internal field from the response.
  emitTask(req, t, prev && { prevAssigneeId: prev.assigneeId }, t && (t as any)._spawned);
  if (t && (t as any)._spawned) delete (t as any)._spawned;
  if (req.body && "assigneeId" in req.body)
    await notifyAssignee(req, t, req.body.assigneeId);
  // @mentions in an edited description notify + auto-watch the mentioned users.
  // Pass the PREVIOUS description so only NEWLY-added mentions are notified — a
  // word fix in a body that keeps the same @mentions must not re-ping them all.
  if (req.body && "description" in req.body)
    await notifyTaskMentions(
      req,
      t.id,
      req.user.userId,
      req.body.description,
      prev && prev.description,
    );
  if (
    t && prev && req.body?.status === "done" && prev.status !== "done" &&
    prev.assigneeId && prev.assigneeId !== req.user.userId
  ) {
    try {
      const actor = await db.users.getById(req.user.userId);
      const n = await notificationService.notifyTaskCompleted({
        userId: prev.assigneeId,
        actorName: (actor && actor.name) || "Someone",
        taskId: t.id,
        taskTitle: t.title || "a task",
      });
      pushNotif(req.app.get("io"), n);
    } catch (_) {}
  }
  // Watchers hear about a status change made via PATCH (the move endpoint covers
  // drag-and-drop). Exclude the prev primary (already got task_completed above).
  if (t && prev && req.body && "status" in req.body && t.status !== prev.status)
    await notifyWatchers(
      req,
      t.id,
      "status",
      STATUS_LABEL[t.status] || t.status,
      prev.assigneeId ? [prev.assigneeId] : [],
    );
  res.json(ok(t));
});
router.delete("/:id", async (req, res) => {
  // Capture the FULL serialized task (assignees[] + watchers) BEFORE the
  // soft-delete so the scoped broadcast reaches every secondary assignee and
  // watcher room — not just reporter + PRIMARY assignee (a raw repo row carries
  // only the primary, so secondary assignees/watchers would never get the
  // TASK_CHANGED and their boards would keep showing the deleted task).
  const full = await serializeTaskById(req.params.id);
  const r = await remove({ id: req.params.id, actorId: req.user.userId });
  emitTask(req, full);
  res.json(ok(r));
});
router.get("/:id/activity", async (req, res) =>
  res.json(ok(await getActivity(req.params.id, req.user.userId))),
);
router.get("/:id/deps", async (req, res) =>
  res.json(ok(await getDependencies(req.params.id, req.user.userId))),
);
router.post("/:id/deps", async (req, res) => {
  const r = await addDependency({
    id: req.params.id,
    dependsOnId: (req.body || {}).dependsOnId,
    actorId: req.user.userId,
  });
  emitTask(req, await serializeTaskById(req.params.id));
  res.json(ok(r));
});
router.delete("/:id/deps/:depId", async (req, res) => {
  const r = await removeDependency({
    id: req.params.id,
    dependsOnId: req.params.depId,
    actorId: req.user.userId,
  });
  emitTask(req, await serializeTaskById(req.params.id));
  res.json(ok(r));
});

// ---- ATTACHMENTS (feature #51) --------------------------------------------
// Link / list / unlink files on a task. The blob is uploaded SEPARATELY through
// the existing Files pipeline (POST /api/files); these endpoints only manage the
// task<->file link. The scoped broadcast wakes the task's audience so the detail
// panel's attachment list updates live in other tabs/users.
router.get("/:id/attachments", async (req, res) =>
  res.json(ok(await listAttachments(req.params.id, req.user.userId))),
);
router.post("/:id/attachments", async (req, res) => {
  const r = await attach({
    id: req.params.id,
    fileId: (req.body || {}).fileId,
    actorId: req.user.userId,
  });
  emitTask(req, await serializeTaskById(req.params.id));
  res.json(ok(r));
});
router.delete("/:id/attachments/:fileId", async (req, res) => {
  const r = await detach({
    id: req.params.id,
    fileId: req.params.fileId,
    actorId: req.user.userId,
  });
  emitTask(req, await serializeTaskById(req.params.id));
  res.json(ok(r));
});
router.get("/:id/comments", async (req, res) =>
  res.json(ok(await getComments(req.params.id, req.user.userId))),
);
router.post("/:id/comments", async (req, res) => {
  const body = (req.body || {}).body;
  const r = await addComment({
    id: req.params.id,
    authorId: req.user.userId,
    body,
  });
  // The serialized task (assignees[] + watchers, now incl. the auto-watched
  // commenter) routes the emit to every interested room.
  const full = await serializeTaskById(req.params.id);
  emitTask(req, full);
  // 1) @mentions in the comment: notify + auto-watch the mentioned users.
  await notifyTaskMentions(req, req.params.id, req.user.userId, body);
  // 2) Other watchers hear "X commented" — but not anyone just mentioned (they
  // already got the richer task_mention) nor the author.
  const mentionedIds = await mentionedUserIds(body);
  await notifyWatchers(req, req.params.id, "comment", null, mentionedIds);
  res.json(ok(r));
});
router.delete("/:id/comments/:cid", async (req, res) => {
  const r = await removeComment({
    id: req.params.id,
    commentId: req.params.cid,
    userId: req.user.userId,
  });
  emitTask(req, await serializeTaskById(req.params.id));
  res.json(ok(r));
});

// ---- SUBTASKS / PROGRESS (feature #52a) ------------------------------------
// List a parent's live subtasks (read access to the parent suffices). Each is a
// fully serialized task (its own progress/assignees/status).
router.get("/:id/subtasks", async (req, res) =>
  res.json(ok(await listSubtasks(req.params.id, req.user.userId))),
);
// Create a subtask under a parent. Body: { title, assigneeId?, priority?, dueAt? }.
// Mutate access to the parent is required (createSubtask gates it). The scoped
// broadcast wakes the parent's audience so its progress bar updates live; the new
// subtask is its own task so its assignee is notified like any assignment.
router.post("/:id/subtasks", async (req, res) => {
  const b = req.body || {};
  const t = await createSubtask({
    parentId: req.params.id,
    title: (b.title || "").trim(),
    assigneeId: b.assigneeId || null,
    priority: b.priority || null,
    dueAt: b.dueAt || null,
    actorId: req.user.userId,
  });
  // Wake the new subtask's audience AND the parent's (its progress changed).
  emitTask(req, t, await serializeTaskById(req.params.id));
  await notifyAssignee(req, t, b.assigneeId);
  res.json(ok(t));
});
// Re-parent (or un-parent) a task. Body: { parentId|null }. Cycle-guarded.
router.put("/:id/parent", async (req, res) => {
  const parentId = (req.body || {}).parentId || null;
  const t = await setParent({
    id: req.params.id,
    parentId,
    actorId: req.user.userId,
  });
  // Wake the task's audience + both the old and new parent (progress moved).
  emitTask(req, t, await serializeTaskById(req.params.id));
  if (parentId) emitTask(req, await serializeTaskById(parentId));
  res.json(ok(t));
});

// ---- MULTIPLE ASSIGNEES ----------------------------------------------------
// Add one assignee. Body: { userId }. Reporter/assignee only (assign() gates).
router.post("/:id/assignees", async (req, res) => {
  const userId = (req.body || {}).userId;
  const prev = await db.tasks.getById(req.params.id);
  const t = await assign({ id: req.params.id, userId, actorId: req.user.userId });
  emitTask(req, t, prev && { prevAssigneeId: prev.assigneeId });
  await notifyNewAssignees(req, t, userId ? [userId] : []);
  res.json(ok(t));
});
// Remove one assignee.
router.delete("/:id/assignees/:userId", async (req, res) => {
  const prev = await db.tasks.getById(req.params.id);
  const t = await unassign({
    id: req.params.id,
    userId: req.params.userId,
    actorId: req.user.userId,
  });
  // Wake the removed user's room too (their board drops the task live).
  emitTask(req, t, { prevAssigneeIds: [req.params.userId, prev && prev.assigneeId].filter(Boolean) });
  res.json(ok(t));
});
// Replace the entire assignee set. Body: { userIds: string[] }.
router.put("/:id/assignees", async (req, res) => {
  const userIds = (req.body || {}).userIds || [];
  const prev = await db.tasks.getById(req.params.id);
  const before: string[] = db.tasks.assignees
    ? ((await db.tasks.assignees(req.params.id)) as string[])
    : [];
  const { task, added, removed } = (await setAssignees({
    id: req.params.id,
    userIds,
    actorId: req.user.userId,
  })) as { task: any; added: string[]; removed: string[] };
  // Reach the new set (via `task`), the removed users, and the old primary.
  emitTask(req, task, {
    prevAssigneeIds: [...removed, ...before, prev && prev.assigneeId].filter(Boolean),
  });
  await notifyNewAssignees(req, task, added);
  res.json(ok(task));
});

// ---- WATCHERS --------------------------------------------------------------
// List the task's watcher ids. Read access (reporter/assignee/watcher).
router.get("/:id/watchers", async (req, res) =>
  res.json(ok(await getWatchers(req.params.id, req.user.userId))),
);
// Start watching (the caller follows the task). Read access is enough.
router.post("/:id/watch", async (req, res) => {
  const watchers = await watch({ id: req.params.id, userId: req.user.userId });
  emitTask(req, await serializeTaskById(req.params.id));
  res.json(ok({ watching: true, watchers }));
});
// Stop watching (always allowed for oneself; only affects the caller's row).
router.delete("/:id/watch", async (req, res) => {
  const watchers = await unwatch({ id: req.params.id, userId: req.user.userId });
  emitTask(req, await serializeTaskById(req.params.id));
  res.json(ok({ watching: false, watchers }));
});

export default router;
