import { db } from "../platform";
import * as notificationService from "./notificationService";
import { spawnNext } from "./reminderService";

// Worker tick: claim due reminders (each fires EXACTLY once via notified_at) and
// create a notification for the owner. Transport-free — returns the list of
// { userId, notification } for the entrypoint poller to deliver live (toast +
// Activity badge + notification center) and to restyle the reminders list.
// Mirrors scheduledMessageService.runDue. This is pure DB-scan + notification
// fan-out: it does NOT touch the call/meeting media path (LiveKit/TURN/SFU).
async function runDue(limit = 50) {
  const due = await db.reminders.claimDue(limit);
  const fired: Array<{ userId: string; notification: any }> = [];
  for (const r of due) {
    try {
      const n = await notificationService.create({
        userId: r.userId,
        type: "reminder",
        title: `Reminder: ${r.text}`,
        targetType: "reminder",
        targetId: r.id,
      });
      if (n) fired.push({ userId: r.userId, notification: n });
      // Recurring reminders roll forward AT FIRE TIME (not only on completion),
      // so an un-completed recurring reminder keeps reminding on schedule.
      // AUDIT P2 (#30): also match rows that carry a recurrence_rule (e.g. yearly)
      // while recurrence='none' — the legacy-enum-only check silently dropped them,
      // so yearly reminders (birthdays/renewals) never re-fired. Mirrors spawnNext's
      // own definition of "recurring".
      if ((r.recurrence && r.recurrence !== "none") || r.recurrenceRule) {
        try {
          await spawnNext(r);
        } catch (_) {
          /* a spawn failure must not stall the rest of the batch */
        }
      }
    } catch (_) {
      /* a single reminder's notify failure must not stall the batch */
    }
  }
  return fired;
}

export { runDue };
