// Structured Outlook-style recurrence rule — the SHARED backend authority for
// REMINDERS (feature #53), REUSING the exact rule shape the meetings recurrence
// uses (migration 0047 + meetingService.expandByRule + the CalendarView
// Frequency UI). One rule type, one set of semantics, computed in one place so
// reminders and meetings never drift.
//
// Rule shape (all fields optional except freq):
//   {
//     freq: "daily" | "weekly" | "monthly" | "yearly",
//     interval: number >= 1,                       // every N units
//     byWeekday?: number[],                        // weekly: 0=Sun..6=Sat
//     monthlyMode?: "day" | "weekday",             // monthly/yearly
//     day?: number,                                // monthlyMode "day": day-of-month
//     ordinal?: number,                            // monthlyMode "weekday": 1..4 or -1 (last)
//     weekday?: number,                            // monthlyMode "weekday": 0=Sun..6=Sat
//     month?: number,                              // yearly: 1..12 (display only here)
//     end?: { type: "never" } | { type: "after", count } | { type: "on", date: "YYYY-MM-DD" }
//   }
//
// This module is pure (no DB / transport) so it's trivially unit-testable and is
// shared by reminderService (next-occurrence + validation) and could back the
// meeting expander too. It NEVER touches the call/meeting media path.

import { civilFields, wallClockToInstant, addCivilDays } from "./tz";

export type RecurrenceEnd =
  | { type: "never" }
  | { type: "after"; count: number }
  | { type: "on"; date: string };

export interface RecurrenceRule {
  freq: "daily" | "weekly" | "biweekly" | "monthly" | "yearly";
  interval?: number;
  byWeekday?: number[];
  monthlyMode?: "day" | "weekday";
  // RCR-04: short-month handling for monthly by-day rules — "clamp" (default:
  // last day of the month) or "skip" (no occurrence that month).
  monthlyShortMode?: "clamp" | "skip";
  day?: number;
  ordinal?: number;
  weekday?: number;
  month?: number;
  end?: RecurrenceEnd;
}

const FREqS = new Set(["daily", "weekly", "biweekly", "monthly", "yearly"]);

const badRequest = (message: string) => {
  const e: any = new Error(message);
  e.status = 400;
  return e;
};

// Validate a structured rule (or null). Throws a 400 the route surfaces verbatim.
// Lenient: a null/undefined rule is valid (means "use the legacy enum / none").
export function validateRecurrenceRule(rule: any): void {
  if (rule == null) return;
  if (typeof rule !== "object" || Array.isArray(rule))
    throw badRequest("Invalid recurrence rule.");
  if (!FREqS.has(rule.freq))
    throw badRequest(`Invalid recurrence frequency: "${rule.freq}".`);
  if (rule.interval != null) {
    const n = Number(rule.interval);
    if (!Number.isInteger(n) || n < 1 || n > 999)
      throw badRequest("Recurrence interval must be 1–999.");
  }
  if (rule.byWeekday != null) {
    if (
      !Array.isArray(rule.byWeekday) ||
      rule.byWeekday.some((d: any) => !Number.isInteger(d) || d < 0 || d > 6)
    )
      throw badRequest("Recurrence weekdays must be 0–6.");
  }
  if (rule.monthlyMode != null && rule.monthlyMode !== "day" && rule.monthlyMode !== "weekday")
    throw badRequest("Invalid monthly recurrence mode.");
  // RCR-04: how a monthly by-day rule handles SHORT months — "clamp" (default:
  // land on the month's last day) or "skip" (no occurrence that month). Never
  // a silent shift into the next month.
  if (
    rule.monthlyShortMode != null &&
    rule.monthlyShortMode !== "clamp" &&
    rule.monthlyShortMode !== "skip"
  )
    throw badRequest('Recurrence short-month mode must be "clamp" or "skip".');
  if (rule.day != null) {
    const n = Number(rule.day);
    if (!Number.isInteger(n) || n < 1 || n > 31)
      throw badRequest("Recurrence day-of-month must be 1–31.");
  }
  if (rule.ordinal != null) {
    const n = Number(rule.ordinal);
    if (!Number.isInteger(n) || !(n === -1 || (n >= 1 && n <= 4)))
      throw badRequest("Recurrence ordinal must be 1–4 or -1 (last).");
  }
  if (rule.weekday != null) {
    const n = Number(rule.weekday);
    if (!Number.isInteger(n) || n < 0 || n > 6)
      throw badRequest("Recurrence weekday must be 0–6.");
  }
  const end = rule.end;
  if (end != null) {
    if (typeof end !== "object") throw badRequest("Invalid recurrence end.");
    if (!["never", "after", "on"].includes(end.type))
      throw badRequest("Invalid recurrence end type.");
    if (end.type === "after") {
      const n = Number(end.count);
      if (!Number.isInteger(n) || n < 1)
        throw badRequest("Recurrence end count must be ≥ 1.");
      // RCR-03: series horizon — at most 730 occurrences.
      if (n > 730)
        throw badRequest("A recurring series can have at most 730 occurrences.");
    }
    if (end.type === "on") {
      const t = Date.parse(end.date + "T00:00:00");
      if (!end.date || !Number.isFinite(t))
        throw badRequest("Invalid recurrence end date.");
      // RCR-03: series horizon — the end date at most 5 years out.
      if (t > Date.now() + 5 * 366 * 86400000)
        throw badRequest("A recurring series can extend at most 5 years.");
    }
  }
}

// The nth (1-4, or -1=last) weekday of a month, at the given time. Null if that
// ordinal doesn't exist in the month (e.g. a 5th Tuesday). MIRRORS
// meetingService.nthWeekdayOfMonth EXACTLY.
// Civil (calendar) day-of-month for the Nth weekday. Weekday-of-a-calendar-date is
// zone-independent, so this uses UTC scratch dates and returns {y,mo,d} (or null if
// the ordinal doesn't exist, e.g. a 5th Tuesday). The caller converts to an instant
// in the series zone. Day-of-month result is identical to the prior local version.
function nthWeekdayCivil(
  year: number,
  month: number,
  ordinal: number,
  weekday: number,
): { y: number; mo: number; d: number } | null {
  const dim = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let day: number;
  if (ordinal === -1) {
    const lastDow = new Date(Date.UTC(year, month, dim)).getUTCDay();
    const diff = (lastDow - weekday + 7) % 7;
    day = dim - diff;
  } else {
    const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    day = 1 + ((weekday - firstDow + 7) % 7) + (ordinal - 1) * 7;
    if (day > dim) return null;
  }
  return { y: year, mo: month, d: day };
}

// Map a legacy simple recurrence enum (daily/weekly/monthly) to an equivalent
// structured rule. Used to migrate/normalize a row that only has the old enum.
// 'none'/unknown → null. WEEKLY/MONTHLY default to the anchor's own weekday /
// day-of-month, which the expander derives, so no day info is lost.
export function ruleFromLegacy(recurrence: string | null | undefined): RecurrenceRule | null {
  switch (recurrence) {
    case "daily":
      return { freq: "daily", interval: 1, end: { type: "never" } };
    case "weekly":
      return { freq: "weekly", interval: 1, end: { type: "never" } };
    case "biweekly":
      return { freq: "weekly", interval: 2, end: { type: "never" } };
    case "monthly":
      return { freq: "monthly", interval: 1, monthlyMode: "day", end: { type: "never" } };
    default:
      return null;
  }
}

// Compute the NEXT occurrence STRICTLY AFTER `afterMs`, anchored at `anchorIso`
// (the series' first/most-recent due instant), following the structured rule.
// Returns an ISO string, or null if the rule has ended (end: after N already
// reached, or end: on/by a date that's passed) before producing one.
//
// This is the structured twin of meetingService.expandByRule but yields the
// single next instant rather than a display window. Same interval / weekly-days /
// monthly day-vs-nth-weekday / yearly / end semantics, so reminders and meetings
// agree on what "the next one" is.
export function nextOccurrenceAfter(
  anchorIso: string,
  rule: RecurrenceRule | null,
  afterMs: number = Date.now(),
  timeZone?: string | null,
): string | null {
  if (!rule || !FREqS.has(rule.freq)) return null;
  const start = Date.parse(anchorIso);
  if (!Number.isFinite(start)) return null;
  const sd = new Date(start);
  const tz = timeZone || null;
  // AUDIT #31: read the anchor's intended wall-clock IN THE SERIES ZONE (server-
  // local when tz is null → identical to the legacy sd.getHours()). Every
  // occurrence is rebuilt from these civil fields via wallClockToInstant so the
  // wall-clock time never drifts ±1h across a DST transition.
  const cv = civilFields(sd, tz);
  const hh = cv.hh,
    mm = cv.mm,
    ss = cv.ss;
  // Build the UTC instant for a target CIVIL date at the anchor's wall-clock in
  // the series zone. wallClockToInstant(tz=null) === new Date(y,mo,d,hh,mm,ss),
  // and civil day/month arithmetic equals the local-Date arithmetic it replaces,
  // so the tz=null path is byte-identical to the prior behaviour.
  const mk = (y: number, mo: number, d: number) =>
    wallClockToInstant(y, mo, d, hh, mm, ss, tz);
  const interval = Math.max(1, rule.interval || 1);
  const end = rule.end || { type: "never" };
  const endMs =
    end.type === "on" && (end as any).date
      ? Date.parse((end as any).date + "T23:59:59")
      : Infinity;
  const maxN = end.type === "after" ? Math.max(1, (end as any).count || 1) : Infinity;

  // We walk candidate occurrences in chronological order (index 0 = the anchor
  // itself). `produced` counts how many real occurrences the series has emitted —
  // when end is "after N" the series stops after the Nth, so the (N+1)th candidate
  // is past the end and there is no next.
  let produced = 0;
  // The first candidate strictly after `afterMs` AND within the end bounds wins.
  const consider = (d: Date | null): string | null | undefined => {
    if (!d) return undefined; // skip a non-existent occurrence (e.g. 5th Tuesday)
    const t = d.getTime();
    if (t < start) return undefined; // before the anchor — not part of the series
    if (t > endMs) return null; // past the on/by end — series finished
    produced++;
    if (produced > maxN) return null; // past the after-N count — series finished
    if (t > afterMs) return d.toISOString(); // first one beyond the cursor — done
    return undefined; // a valid occurrence but at/before the cursor — keep walking
  };

  if (rule.freq === "weekly" || rule.freq === "biweekly") {
    const effInterval = rule.freq === "biweekly" ? interval * 2 : interval;
    const days = (rule.byWeekday && rule.byWeekday.length ? rule.byWeekday : [cv.dow])
      .slice()
      .sort((a, b) => a - b);
    // Sunday of the anchor's week, in civil space.
    const weekStart = addCivilDays(cv, -cv.dow);
    for (let w = 0; w < 4000; w++)
      for (const dow of days) {
        const occ = addCivilDays(weekStart, w * 7 * effInterval + dow);
        const r = consider(mk(occ.y, occ.mo, occ.d));
        if (r !== undefined) return r;
      }
    return null;
  }
  if (rule.freq === "monthly" || rule.freq === "yearly") {
    const step = rule.freq === "yearly" ? 12 * interval : interval;
    for (let i = 0; i < 4000; i++) {
      // Target month in civil space (normalise year/month over 12).
      const ym = cv.y * 12 + cv.mo + i * step;
      const yy = Math.floor(ym / 12);
      const mo = ((ym % 12) + 12) % 12;
      let d: Date | null;
      if (rule.monthlyMode === "weekday" && rule.ordinal && rule.weekday != null) {
        const c = nthWeekdayCivil(yy, mo, rule.ordinal, rule.weekday);
        d = c ? mk(c.y, c.mo, c.d) : null;
      } else {
        const dim = new Date(Date.UTC(yy, mo + 1, 0)).getUTCDate();
        const want = rule.day || cv.d;
        // RCR-04: short month — "skip" emits no occurrence; default clamps to
        // the month's last day. Never a silent shift into the next month.
        d =
          want > dim && rule.monthlyShortMode === "skip"
            ? null
            : mk(yy, mo, Math.min(want, dim));
      }
      const r = consider(d);
      if (r !== undefined) return r;
    }
    return null;
  }
  // daily
  if (tz) {
    // Advance by CIVIL days so the wall clock holds across DST (#31).
    for (let i = 0; i < 200000; i++) {
      const occ = addCivilDays(cv, i * interval);
      const r = consider(mk(occ.y, occ.mo, occ.d));
      if (r !== undefined) return r;
    }
    return null;
  }
  // Legacy (no zone): exact ms arithmetic — byte-identical to prior behaviour.
  for (let i = 0; i < 200000; i++) {
    const r = consider(new Date(start + i * interval * 86400000));
    if (r !== undefined) return r;
  }
  return null;
}
