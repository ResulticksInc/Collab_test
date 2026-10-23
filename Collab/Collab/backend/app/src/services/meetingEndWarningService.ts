import { db, config } from "../platform";
import * as notificationService from "./notificationService";
import { nextOccurrenceAfter, ruleFromLegacy } from "./recurrenceRule";

// MEETING END WARNINGS. "This meeting ends in 10 minutes", then "…in 5 minutes".
//
// The mirror of meetingReminderFireService: that one nudges you to turn up, this
// nudges the room to wrap up. Same shape — a pure DB scan plus a notification
// fan-out, exactly-once per (meeting, occurrence, lead) via a ledger claim. It
// never touches the media path.
//
// Two things are deliberately different from the start reminder:
//
//   • RECIPIENTS are the people actually IN the room, not every invitee. Telling
//     someone who never joined that a meeting they aren't in is ending is pure
//     noise, and it also means the scan can be driven off live presence — a
//     handful of meetings, not every meeting in the calendar horizon.
//
//   • It fires TWICE per occurrence (once per lead), which is why the ledger is
//     keyed by minutes_before as well.

// Leads in minutes, largest first so a tick that has fallen behind emits the
// 10-minute warning before the 5-minute one rather than out of order.
const LEADS: number[] = (() => {
  const raw = process.env.MEETING_END_WARNING_MINUTES;
  const parsed = (raw ? raw.split(",") : ["10", "5"])
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 120);
  return Array.from(new Set(parsed)).sort((a, b) => b - a);
})();

// How late a warning may still fire. Without this, a worker that was down over
// the warning instant would emit "ends in 10 minutes" well after the meeting
// ended. One tick's grace: late enough to survive a slow poll, short enough that
// a stale warning is never sent.
const GRACE_MS = 90_000;

// The occurrence RUNNING right now, as an ISO start. For a one-off that is just
// startsAt; for a series it is the expanded occurrence whose window contains now.
// Returns null when the meeting isn't currently within an occurrence — which is
// the normal case for a series between occurrences.
export function currentOccurrenceStart(meeting: any, nowMs: number): string | null {
  const durMs = Math.max(1, Number(meeting.durationMin) || 30) * 60000;
  const isRecurring = !!(
    meeting.recurrenceRule ||
    (meeting.recurrence && meeting.recurrence !== "none")
  );
  const start = Date.parse(meeting.startsAt);
  if (!isRecurring) {
    if (!Number.isFinite(start)) return null;
    // Allow the grace window past the end so a slightly-late tick still resolves
    // the occurrence it is warning about.
    if (nowMs >= start && nowMs < start + durMs + GRACE_MS)
      return new Date(start).toISOString();
    return null;
  }
  const rule = meeting.recurrenceRule || ruleFromLegacy(meeting.recurrence);
  if (!rule) return null;
  // Walk from just before the earliest occurrence that could still contain now.
  let cursor = nowMs - durMs - GRACE_MS - 60000;
  for (let i = 0; i < 4; i++) {
    const nextIso = nextOccurrenceAfter(
      meeting.startsAt,
      rule,
      cursor,
      meeting.timezone ?? null,
    );
    if (!nextIso) return null;
    const s = Date.parse(nextIso);
    if (nowMs >= s && nowMs < s + durMs + GRACE_MS) return nextIso;
    if (s > nowMs) return null; // the next one hasn't started
    cursor = s;
  }
  return null;
}

// Which leads are due for this occurrence right now? A lead is due when now is
// in [end - lead, end - lead + grace).
export function dueLeads(
  occurrenceStartMs: number,
  durationMin: number,
  nowMs: number,
  leads: number[] = LEADS,
): number[] {
  const end = occurrenceStartMs + Math.max(1, durationMin) * 60000;
  return leads.filter((lead) => {
    const at = end - lead * 60000;
    // Never warn before the meeting has started: on a 10-minute meeting the
    // 10-minute warning coincides with the start, which is not a warning, it is
    // an announcement — and on anything shorter it would land in the past.
    if (at <= occurrenceStartMs) return false;
    return nowMs >= at && nowMs < at + GRACE_MS;
  });
}

async function runDue() {
  if (!LEADS.length) return [];
  let live: any[] = [];
  try {
    live = (db.meetings as any).liveMeetings ? await (db.meetings as any).liveMeetings() : [];
  } catch (_) {
    return [];
  }
  const now = Date.now();
  const fired: Array<{ userId: string; notification: any }> = [];

  for (const m of live) {
    const occIso = currentOccurrenceStart(m, now);
    if (!occIso) continue;
    const leads = dueLeads(Date.parse(occIso), Number(m.durationMin) || 30, now);
    if (!leads.length) continue;

    // Resolve the room ONCE per meeting, not once per lead.
    let present: any[] = [];
    try {
      present = await db.meetings.roomParticipants(m.id);
    } catch (_) {
      continue;
    }
    if (!present.length) continue;

    for (const lead of leads) {
      let claimed = false;
      try {
        claimed = await (db.meetings as any).claimEndWarning(m.id, occIso, lead);
      } catch (_) {
        claimed = false;
      }
      if (!claimed) continue; // another tick or instance already sent this one

      for (const p of present) {
        const userId = p.userId || p.id;
        if (!userId) continue;
        try {
          const n = await notificationService.notifyMeetingEnding({
            userId,
            meetingId: m.id,
            meetingTitle: m.title || "Meeting",
            minutesLeft: lead,
            occurrenceStart: occIso,
          });
          if (n) fired.push({ userId, notification: n });
        } catch (_) {
          /* one recipient failing must not stall the rest */
        }
      }
    }
  }
  return fired;
}

export { runDue, LEADS };
