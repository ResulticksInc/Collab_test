import { db } from "../platform";
import * as notificationService from "./notificationService";
import { nextOccurrenceAfter, ruleFromLegacy } from "./recurrenceRule";

// MEETING-REMINDER SCHEDULER (#53). Worker tick: scan meetings that have a
// reminder_lead_min set, find any OCCURRENCE whose "notify window" is open right
// now (start - lead <= now < start), and notify every attendee + the host EXACTLY
// ONCE per occurrence. The notification routes to the MEETING via the existing
// deep-link (targetType "meeting" + the meeting id), so clicking it opens the
// meeting — same routing as meeting_invite / meeting_declined.
//
// This is the meeting twin of reminderFireService.runDue: a pure DB-scan +
// notification fan-out. Exactly-once is enforced by db.meetings.claimReminderOccurrence
// (an atomic INSERT into the meeting_reminders_sent ledger keyed by
// (meeting_id, occurrence_start) — the first inserter wins). It does NOT touch the
// call/meeting MEDIA path (LiveKit/TURN/SFU) — it never starts or joins a call.

// For a meeting + its recurrence, return the occurrence start (ISO) whose reminder
// window is open at `nowMs` for the given lead, or null. We look at the next
// occurrence at/after (now - a small grace), because the window we care about is
// [start - lead, start). A one-off meeting (no recurrence) is just its own start.
function dueOccurrence(meeting: any, leadMin: number, nowMs: number): string | null {
  const lead = Math.max(0, leadMin) * 60000;
  const isRecurring = !!(meeting.recurrenceRule || (meeting.recurrence && meeting.recurrence !== "none"));
  if (!isRecurring) {
    const start = Date.parse(meeting.startsAt);
    if (!Number.isFinite(start)) return null;
    // Window is open and not yet past the start: start-lead <= now < start.
    if (nowMs >= start - lead && nowMs < start) return new Date(start).toISOString();
    return null;
  }
  const rule = meeting.recurrenceRule || ruleFromLegacy(meeting.recurrence);
  if (!rule) return null;
  // The next occurrence strictly after (now - lead - 1 min) is the earliest one
  // whose window could still be open now. Walk a couple forward to be safe.
  let cursor = nowMs - lead - 60000;
  for (let i = 0; i < 4; i++) {
    // AUDIT #31: expand in the meeting's series timezone (null → legacy) so the
    // reminder fires at the DST-correct wall-clock, matching the calendar display.
    const nextIso = nextOccurrenceAfter(meeting.startsAt, rule, cursor, meeting.timezone ?? null);
    if (!nextIso) return null;
    const start = Date.parse(nextIso);
    if (nowMs >= start - lead && nowMs < start) return nextIso;
    if (start - lead > nowMs) return null; // its window hasn't opened yet
    cursor = start; // already past this occurrence's start — try the following one
  }
  return null;
}

async function runDue() {
  let candidates: any[] = [];
  try {
    candidates = db.meetings.withReminderLead ? await db.meetings.withReminderLead() : [];
  } catch (_) {
    return [];
  }
  const now = Date.now();
  const fired: Array<{ userId: string; notification: any }> = [];
  for (const m of candidates) {
    const lead = Number(m.reminderLeadMin) || 0;
    if (lead <= 0) continue;
    const occIso = dueOccurrence(m, lead, now);
    if (!occIso) continue;
    // EXACTLY ONCE per occurrence: the first tick to claim (meeting, occurrence)
    // wins; a duplicate/concurrent tick is a no-op and we skip the fan-out.
    let claimed = false;
    try {
      claimed = await db.meetings.claimReminderOccurrence(m.id, occIso);
    } catch (_) {
      claimed = false;
    }
    if (!claimed) continue;
    // Recipients: every attendee + the host, de-duped.
    const recipients = new Set<string>();
    for (const a of m.attendees || []) if (a && a.userId) recipients.add(a.userId);
    if (m.createdBy) recipients.add(m.createdBy);
    for (const userId of recipients) {
      try {
        // Reuse the EXISTING (previously-dead) meeting-reminder notification helper
        // — same type + meeting deep-link, nicely-formatted "starts in N minutes".
        const n = await notificationService.notifyMeetingReminder({
          userId,
          meetingId: m.id,
          meetingTitle: m.title || "Meeting",
          minutesBefore: lead,
        });
        if (n) fired.push({ userId, notification: n });
      } catch (_) {
        /* a single recipient's notify failure must not stall the batch */
      }
    }
  }
  return fired;
}

export { runDue, dueOccurrence };
