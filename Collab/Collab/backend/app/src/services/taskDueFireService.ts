import { db } from "../platform";
import * as notificationService from "./notificationService";

// Worker tick: claim DUE tasks (each fires EXACTLY once via due_notified_at) and
// create a notification for the responsible user(s). Transport-free — returns the
// list of { userId, notification } for the entrypoint poller to deliver live
// (toast + Activity badge + notification center) and to nudge the task board.
//
// This is the task-side twin of reminderFireService.runDue: same claim → stamp →
// notify shape, REUSING tasks.claimDueTasks (FOR UPDATE SKIP LOCKED + the
// due_notified_at exactly-once stamp). Notifications go through the EXISTING task
// notification routing — type-agnostic `targetType:"task"` + `targetId` — so the
// frontend's existing deep-link opens the exact task (no parallel routing). Pure
// DB-scan + notification fan-out: it does NOT touch the call/meeting media path.
//
// Recipients: ALL ASSIGNEES own the due date; the REPORTER is also told (so a task
// you created but assigned elsewhere still surfaces to you); and WATCHERS, who
// asked to follow the task. De-duped so a self-assigned/watched task notifies once.
async function runDue(limit = 50) {
  // Skip absurdly-stale tasks (default 30 days) so a long-dormant backlog can't
  // flood on first deploy; the LIMIT + exactly-once stamp bound the rest.
  const staleDays = Number(process.env.TASK_DUE_STALE_DAYS) || 30;
  const due = await db.tasks.claimDueTasks(limit, staleDays);
  const fired: Array<{ userId: string; notification: any }> = [];
  for (const t of due) {
    const recipients = new Set<string>();
    // Every assignee (the join table; falls back to the single primary on an
    // older driver), the reporter, and every watcher.
    const assignees = db.tasks.assignees
      ? await db.tasks.assignees(t.id).catch(() => [])
      : t.assigneeId
        ? [t.assigneeId]
        : [];
    for (const a of assignees) if (a) recipients.add(a);
    if (t.assigneeId) recipients.add(t.assigneeId); // primary, in case join is empty
    if (t.reporterId) recipients.add(t.reporterId);
    const watchers = db.tasks.watchers
      ? await db.tasks.watchers(t.id).catch(() => [])
      : [];
    for (const w of watchers) if (w) recipients.add(w);
    const title = `Task due: "${t.title || "a task"}"`;
    for (const userId of recipients) {
      try {
        const n = await notificationService.create({
          userId,
          type: "task_due",
          title,
          // Existing task deep-link: targetType "task" + the task id. The client
          // opens the exact task on click (same routing as task_assigned).
          targetType: "task",
          targetId: t.id,
        });
        if (n) fired.push({ userId, notification: n });
      } catch (_) {
        /* a single task's notify failure must not stall the rest of the batch */
      }
    }
  }
  return fired;
}

export { runDue };
