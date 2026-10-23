import { db, config } from "../platform";
import * as policy from "./meetingPolicy";
import { isWhiteboardBlocked, setWhiteboardBlocked, whiteboardBlockedUserIds } from "./whiteboardAccess";
import {
  restrictionsOf,
  restrictedUserIds,
  setCameraBlocked,
  setScreenShareBlocked,
} from "./participantRestrictions";
import { applyPermissions, stopCamera, stopScreenShare } from "./livekitService";
import { serializeMeeting, serializeMeetingList, pubUser } from "../serialize";
import { withoutGuests } from "./guestMeetingService";
import { civilFields, wallClockToInstant, addCivilDays } from "./tz";
import { validateRecurrenceRule, ruleFromLegacy, nextOccurrenceAfter } from "./recurrenceRule";
// UNIFIED CONNECTOR ENGINE: mirror meetings onto Google / Outlook calendars.
// Fire-and-forget (queues a job per calendar account) — never blocks a save.
import { dispatchMeeting as syncMeetingToCalendars } from "./connectorService";

// Meetings may not be scheduled in the past. Throws a 400 the route layer
// surfaces verbatim. ISO/epoch comparison is timezone-correct (UTC vs UTC).
function assertFutureStart(startsAt: any) {
  if (startsAt == null || startsAt === "") return;
  const t = Date.parse(startsAt);
  if (!Number.isFinite(t))
    throw Object.assign(new Error("Invalid meeting start time."), {
      status: 400,
    });
  if (t <= Date.now())
    throw Object.assign(
      new Error("Meeting start time must be in the future."),
      {
        status: 400,
      },
    );
}
// A host-chosen meeting duration must be a positive integer of minutes, at most
// 24h. Absent (null/undefined) is fine — the caller defaults it. create() has
// always enforced this; update() (PATCH) did NOT, so a reschedule with an
// end <= start could persist durationMin=0 (or a client bug could persist a
// >24h value), bypassing an invariant create guarantees. Shared here so create
// and update apply exactly the same rule.
function assertDuration(durationMin: any) {
  if (durationMin == null) return;
  const dm = Number(durationMin);
  if (!Number.isInteger(dm) || dm <= 0 || dm > 24 * 60) {
    const e: any = new Error("Invalid meeting duration.");
    e.status = 400;
    throw e;
  }
}
const RECURRENCE = new Set(["none", "daily", "weekly", "biweekly", "monthly", "yearly"]);
// Meeting-reminder lead (#53): minutes before starts_at to notify attendees.
// null/0 = no reminder. Bounded to a week so the scan window stays sane.
function normLead(v: any): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return Math.min(n, 7 * 24 * 60);
}
async function create({
  title,
  startsAt,
  durationMin,
  attendees = [],
  creatorId,
  conversationId,
  lobbyEnabled = false,
  recurrence = "none",
  recurrenceRule = null,
  reminderLeadMin = null,
  timezone = null,
  // Agenda / where (0118).
  description = null,
  location = null,
}: any) {
  assertFutureStart(startsAt);
  // Duration is now host-chosen (end − start on the client). Validate the
  // explicit value: a positive integer, at most 24h. Absent → default below.
  assertDuration(durationMin);
  const rec = RECURRENCE.has(recurrence) ? recurrence : "none";
  // RCR-01..04 + RCR-03 horizon: a structured rule is validated up front — the
  // meeting paths previously accepted ANY recurrenceRule JSON unchecked.
  if (rec !== "none" && recurrenceRule) validateRecurrenceRule(recurrenceRule);
  // AUDIT #31: the timezone a meeting was created in. Originally persisted only
  // for RECURRING meetings (where it drives DST-correct occurrence expansion),
  // now stored for every meeting so the scheduler can show the organiser's zone
  // on a one-off too — which is precisely when it matters, scheduling across
  // timezones. Harmless for expansion: a one-off has no occurrences to expand.
  // Validated IANA-ish; anything else becomes NULL (legacy server-local).
  const tz =
    typeof timezone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(timezone)
      ? timezone
      : null;
  const mt = await (db.withTransaction
    ? db.withTransaction(async () => {
        const row = await db.meetings.create({
          title: (title || "Untitled meeting").trim() || "Untitled meeting",
          startsAt: startsAt || new Date().toISOString(),
          durationMin: durationMin || 120,
          attendees,
          createdBy: creatorId,
          conversationId,
          recurrence: rec,
          recurrenceRule: rec === "none" ? null : recurrenceRule || null,
          reminderLeadMin: normLead(reminderLeadMin),
          timezone: tz,
          description,
          location,
        });
        if (lobbyEnabled) await db.meetings.setLobbyEnabled(row.id, true);
        return row;
      })
    : (async () => {
        const row = await db.meetings.create({
          title: (title || "Untitled meeting").trim() || "Untitled meeting",
          startsAt: startsAt || new Date().toISOString(),
          durationMin: durationMin || 120,
          attendees,
          createdBy: creatorId,
          conversationId,
          recurrence: rec,
          recurrenceRule: rec === "none" ? null : recurrenceRule || null,
          reminderLeadMin: normLead(reminderLeadMin),
          timezone: tz,
          description,
          location,
        });
        if (lobbyEnabled) await db.meetings.setLobbyEnabled(row.id, true);
        return row;
      })());
  const fresh = await db.meetings.getById(mt.id);
  // MCHAT-01/20: the meeting chat exists from the moment of SCHEDULING, with
  // the host and every invitee as members — reachable from the chat list
  // before the meeting starts, whether or not they end up attending. Returned
  // as `meetingGroup` so the route can announce CONVERSATION_NEW.
  const grp = await ensureMeetingGroup(fresh);
  const out: any = await serializeMeeting(fresh, creatorId);
  if (out && grp) out.meetingGroup = grp;
  syncMeetingToCalendars("meeting.upserted", fresh);
  return out;
}

// Expand a recurring meeting into N upcoming occurrences (for calendar/list
// display). The stored row is the series anchor; occurrences are derived, not
// persisted, so changing the series updates every future instance.
// The nth (1-4, or -1=last) weekday of a month, at the given time. Null if that
// ordinal doesn't exist in the month (e.g. a 5th Tuesday).
// AUDIT #31: civil (calendar) day-of-month for the Nth weekday — zone-independent
// (weekday of a calendar date is the same in every zone), so UTC scratch dates.
// Returns {y,mo,d} or null (ordinal absent, e.g. a 5th Tuesday). The caller builds
// the instant in the series zone. Day-of-month result matches the prior local one.
function nthWeekdayCivil(year: number, month: number, ordinal: number, weekday: number) {
  const dim = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let day: number;
  if (ordinal === -1) {
    const lastDow = new Date(Date.UTC(year, month, dim)).getUTCDay();
    day = dim - ((lastDow - weekday + 7) % 7);
  } else {
    const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
    day = 1 + ((weekday - firstDow + 7) % 7) + (ordinal - 1) * 7;
    if (day > dim) return null;
  }
  return { y: year, mo: month, d: day };
}

// Expand an Outlook-style recurrence rule into upcoming occurrences (display
// only). Handles interval, weekly day selection, monthly day-vs-nth-weekday,
// yearly, and end conditions (never / after N / on date).
function expandByRule(meeting: any, rule: any, count: number) {
  const start = Date.parse(meeting.startsAt);
  if (!Number.isFinite(start)) return [meeting];
  const sd = new Date(start);
  // AUDIT #31: build occurrences in the SERIES timezone (null → legacy server-local,
  // byte-identical) so a recurring meeting doesn't drift ±1h across DST. Mirrors
  // recurrenceRule.nextOccurrenceAfter exactly (keeps display + firing in lockstep).
  const tz = meeting.timezone || null;
  const cv = civilFields(sd, tz);
  const hh = cv.hh, mm = cv.mm, ss = cv.ss;
  const mk = (y: number, mo: number, d: number) => wallClockToInstant(y, mo, d, hh, mm, ss, tz);
  const interval = Math.max(1, rule.interval || 1);
  const end = rule.end || { type: "never" };
  const endMs = end.type === "on" && end.date ? Date.parse(end.date + "T23:59:59") : Infinity;
  const maxN = end.type === "after" ? Math.max(1, end.count || 1) : Infinity;
  const out: any[] = [];
  const add = (d: Date | null) => {
    if (!d || d.getTime() < start || d.getTime() > endMs) return true;
    const iso = d.toISOString();
    out.push({
      ...meeting,
      startsAt: iso,
      seriesStartsAt: meeting.startsAt,
      occurrenceStartsAt: iso,
      occurrenceIndex: out.length,
    });
    return out.length < count && out.length < maxN;
  };
  if (rule.freq === "weekly" || rule.freq === "biweekly") {
    const effInterval = rule.freq === "biweekly" ? interval * 2 : interval;
    const days = (rule.byWeekday && rule.byWeekday.length ? rule.byWeekday : [cv.dow]).slice().sort((a: number, b: number) => a - b);
    const weekStart = addCivilDays(cv, -cv.dow); // Sunday of the anchor's week (civil)
    for (let w = 0; out.length < count && out.length < maxN && w < 600; w++)
      for (const dow of days) {
        const occ = addCivilDays(weekStart, w * 7 * effInterval + dow);
        if (!add(mk(occ.y, occ.mo, occ.d))) return out;
      }
  } else if (rule.freq === "monthly" || rule.freq === "yearly") {
    const step = rule.freq === "yearly" ? 12 * interval : interval;
    for (let i = 0; out.length < count && out.length < maxN && i < 600; i++) {
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
        // the month's last day (mirrors recurrenceRule.nextOccurrenceAfter).
        d =
          want > dim && rule.monthlyShortMode === "skip"
            ? null
            : mk(yy, mo, Math.min(want, dim));
      }
      if (!add(d)) return out;
    }
  } else if (tz) { // daily, zoned → advance civil days so the wall clock holds
    for (let i = 0; out.length < count && out.length < maxN && i < 2000; i++) {
      const occ = addCivilDays(cv, i * interval);
      if (!add(mk(occ.y, occ.mo, occ.d))) return out;
    }
  } else { // daily, legacy: exact ms arithmetic (byte-identical to prior behaviour)
    for (let i = 0; out.length < count && out.length < maxN && i < 2000; i++)
      if (!add(new Date(start + i * interval * 86400000))) return out;
  }
  // Empty-expansion fallback: for a NEVER-ending rule an empty result can only
  // be a malformed rule — keep the anchor visible rather than vanishing the
  // meeting. For a BOUNDED rule (after N / on date) an empty result means the
  // series has genuinely ENDED (RCR-27: "end after today") — resurrecting the
  // anchor kept a dead series on the calendar forever.
  return out.length ? out : end.type === "never" ? [meeting] : [];
}

// Stable per-occurrence key: the ORIGINAL occurrence's UTC day. Day-keyed (not
// full-instant) so a later series-level time-of-day edit KEEPS the exceptions
// (RSCH-09's default "keep") — the trade-off is that a series moved to a
// different weekday orphans its old exceptions, which is the rarer edit.
function occKey(iso: any): string {
  return String(iso || "").slice(0, 10);
}

// RSCH-02 / RCR-20 / RCR-21 / RCR-23: apply the series' per-occurrence state to
// freshly expanded occurrences — drop the cancelled ones (exdates), re-time the
// moved ones (occurrenceOverrides, flagged isException so the calendar can mark
// them). occurrenceStartsAt stays the ORIGINAL slot (it is the occurrence's
// identity — the RECURRENCE-ID analogue); startsAt becomes the display time.
function applyOccurrenceState(meeting: any, occs: any[]): any[] {
  const ex = new Set((meeting.exdates || []).map(String));
  const ov = meeting.occurrenceOverrides || {};
  const out: any[] = [];
  for (const o of occs) {
    // The ORIGINAL slot's day is the occurrence's stable identity (the
    // RECURRENCE-ID analogue) — attached to every occurrence so a re-edit of an
    // already-moved one still addresses the same override entry.
    const key = occKey(o.occurrenceStartsAt || o.startsAt);
    if (ex.has(key)) continue; // RCR-23: cancelled occurrence — series untouched
    const patch = ov[key];
    out.push(
      patch
        ? {
            ...o,
            startsAt: patch.startsAt || o.startsAt,
            // The serializer displays occurrenceStartsAt — move it too; the
            // identity lives in occurrenceKey.
            occurrenceStartsAt: patch.startsAt || o.occurrenceStartsAt,
            durationMin: patch.durationMin ?? o.durationMin,
            occurrenceKey: key,
            isException: true, // RCR-21: visually marked as an exception
          }
        : { ...o, occurrenceKey: key },
    );
  }
  return out;
}

function expandOccurrences(meeting: any, count = 8) {
  const rec = meeting.recurrence || "none";
  if (rec === "none") return [meeting];
  // Outlook-style structured rule takes precedence when present.
  if (meeting.recurrenceRule && meeting.recurrenceRule.freq)
    return applyOccurrenceState(
      meeting,
      expandByRule(meeting, meeting.recurrenceRule, count),
    );
  const start = Date.parse(meeting.startsAt);
  if (!Number.isFinite(start)) return [meeting];
  const stepMs: any = { daily: 86400000, weekly: 604800000, biweekly: 1209600000 };
  const out: any[] = [];
  for (let i = 0; i < count; i++) {
    let when: number;
    if (rec === "monthly") {
      const d = new Date(start);
      d.setMonth(d.getMonth() + i);
      when = d.getTime();
    } else {
      when = start + (stepMs[rec] || 0) * i;
    }
    const iso = new Date(when).toISOString();
    out.push({
      ...meeting,
      startsAt: iso,
      seriesStartsAt: meeting.startsAt,
      occurrenceStartsAt: iso,
      occurrenceIndex: i,
    });
  }
  return applyOccurrenceState(meeting, out);
}

// RCR-05: preview the next occurrences of a rule BEFORE saving, computed by the
// SAME expansion the calendar uses — the editor shows these dates so "every 2
// weeks on Tuesday" is verifiable at a glance, one source of truth.
function previewOccurrences({ startsAt, recurrence, recurrenceRule, timezone, count = 5 }: any) {
  const t = Date.parse(startsAt);
  if (!Number.isFinite(t)) {
    const e: any = new Error("Invalid start time.");
    e.status = 400;
    throw e;
  }
  if (recurrenceRule) validateRecurrenceRule(recurrenceRule);
  const tz =
    typeof timezone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(timezone)
      ? timezone
      : null;
  const synthetic = {
    id: "preview",
    startsAt: new Date(t).toISOString(),
    recurrence: RECURRENCE.has(recurrence) ? recurrence : "none",
    recurrenceRule: recurrenceRule || null,
    timezone: tz,
    exdates: [],
    occurrenceOverrides: {},
  };
  const n = Math.min(Math.max(1, Number(count) || 5), 10);
  return expandOccurrences(synthetic, n)
    .slice(0, n)
    .map((o: any) => o.startsAt);
}
async function listForUser(userId) {
  const rows = await db.meetings.listForUser(userId);
  const ids = rows.map((m) => m.id);
  const counts = await db.meetings.presenceCounts(ids);
  // Batched: ONE users query for every attendee across every meeting, instead of
  // meetings × attendees individual reads.
  return serializeMeetingList(rows, userId, counts);
}

async function listForUserCalendar(userId: string, count = 8) {
  const rows = await db.meetings.listForUser(userId);
  const now = Date.now();
  const expandedRows: any[] = [];
  for (const m of rows) {
    if (m.recurrence && m.recurrence !== "none") {
      const occs = expandOccurrences(m, count);
      expandedRows.push(...occs.map((o) => {
        const occStart = Date.parse(o.startsAt);
        // A completed/cancelled status on the series anchor means the LAST
        // session ended — it must not mark a FUTURE occurrence as terminal.
        if ((o.status === "completed" || o.status === "cancelled") && occStart > now) {
          return { ...o, status: "scheduled" };
        }
        return o;
      }));
    } else {
      expandedRows.push(m);
    }
  }
  const ids = rows.map((m) => m.id);
  const counts = await db.meetings.presenceCounts(ids);
  return serializeMeetingList(expandedRows, userId, counts);
}

function formatIcsDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Generate an RFC 5545 iCalendar payload for a meeting (compatible with Outlook,
// Google Calendar, Apple Calendar).
function generateIcs(meeting: any, host: any = null): string {
  const start = new Date(meeting.startsAt);
  const durationMin = meeting.durationMin || 60;
  const end = new Date(start.getTime() + durationMin * 60000);
  const now = new Date();
  const uid = `meeting-${meeting.id}@colab`;
  const summary = (meeting.title || "Meeting").replace(/[\r\n]+/g, " ");
  const organizer = host?.email
    ? `ORGANIZER;CN=${(host.name || "Host").replace(/[;:]/g, " ")}:mailto:${host.email}`
    : `ORGANIZER;CN=Host:mailto:noreply@colab`;

  // RSCH-06: build the RRULE from the STRUCTURED rule when present — the legacy
  // enum export dropped weekly day selection, intervals and end conditions, so
  // external calendars saw a bare weekly forever-series.
  let rrule = "";
  const rule = meeting.recurrenceRule;
  if (rule && rule.freq) {
    const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    const interval = Math.max(1, Number(rule.interval) || 1);
    const parts: string[] = [];
    const freq =
      rule.freq === "biweekly"
        ? "WEEKLY"
        : String(rule.freq).toUpperCase();
    parts.push("FREQ=" + freq);
    const effInterval = rule.freq === "biweekly" ? interval * 2 : interval;
    if (effInterval > 1) parts.push("INTERVAL=" + effInterval);
    if (
      (rule.freq === "weekly" || rule.freq === "biweekly") &&
      Array.isArray(rule.byWeekday) &&
      rule.byWeekday.length
    )
      parts.push("BYDAY=" + rule.byWeekday.map((d: number) => DAYS[d]).filter(Boolean).join(","));
    if ((rule.freq === "monthly" || rule.freq === "yearly") && rule.monthlyMode === "weekday" && rule.ordinal && rule.weekday != null)
      parts.push("BYDAY=" + rule.ordinal + DAYS[rule.weekday]);
    else if (rule.freq === "monthly" && rule.day)
      parts.push("BYMONTHDAY=" + rule.day);
    const end0 = rule.end || { type: "never" };
    if (end0.type === "after" && end0.count) parts.push("COUNT=" + end0.count);
    else if (end0.type === "on" && end0.date)
      parts.push("UNTIL=" + String(end0.date).replace(/-/g, "") + "T235959Z");
    rrule = `\r\nRRULE:${parts.join(";")}`;
  } else if (meeting.recurrence && meeting.recurrence !== "none") {
    const freqMap: Record<string, string> = {
      daily: "DAILY",
      weekly: "WEEKLY",
      biweekly: "WEEKLY;INTERVAL=2",
      monthly: "MONTHLY",
      yearly: "YEARLY",
    };
    if (freqMap[meeting.recurrence]) {
      rrule = `\r\nRRULE:FREQ=${freqMap[meeting.recurrence]}`;
    }
  }
  // RCR-23 → iCalendar EXDATE: cancelled single occurrences, reconstructed at
  // the series' time-of-day on each excluded day (UTC compose).
  // startsAt is a Date object from the MySQL driver (an ISO string from JSON) —
  // normalize through Date before slicing the time-of-day out.
  const timeOfDay = (() => {
    const d0 = new Date(meeting.startsAt);
    return Number.isFinite(d0.getTime())
      ? d0.toISOString().slice(11)
      : "00:00:00.000Z";
  })();
  const exdateLines = (meeting.exdates || [])
    .map((day: string) => {
      const d = new Date(day + "T" + timeOfDay);
      return Number.isFinite(d.getTime()) ? `EXDATE:${formatIcsDate(d)}` : null;
    })
    .filter(Boolean) as string[];
  const cancelled = meeting.status === "cancelled";

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CoLab//Collaboration Platform//EN",
    "CALSCALE:GREGORIAN",
    // RSCH-06/CNCL-03: an update is a REQUEST and a cancellation a CANCEL —
    // paired with the incrementing SEQUENCE below, Outlook/Google update or
    // remove the EXISTING event in place instead of duplicating it.
    cancelled ? "METHOD:CANCEL" : "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SEQUENCE:${Number(meeting.icsSequence) || 0}`,
    `DTSTAMP:${formatIcsDate(now)}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:Join CoLab Meeting: ${meeting.title || "Meeting"}`,
    organizer,
    ...exdateLines,
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}${rrule}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}
async function update({ meetingId, userId, patch }) {
  const m = await db.meetings.getById(meetingId);
  if (!m || m.createdBy !== userId) return null;
  const p: any = { ...(patch || {}) };
  // Only a CHANGED start must be in the future. The edit form always re-sends
  // startsAt, so without this a meeting that has already started could not be
  // edited at all — not extended, renamed, or given another guest.
  const startUntouched =
    p.startsAt != null &&
    Math.abs(Date.parse(p.startsAt) - Date.parse(m.startsAt)) < 60000;
  if (!startUntouched) assertFutureStart(p.startsAt);
  if (p.recurrenceRule) validateRecurrenceRule(p.recurrenceRule);
  // ── RSCH-02 / RCR-20: "This event only" on a recurring meeting ────────────
  // A single-occurrence edit writes a per-occurrence OVERRIDE (keyed by the
  // occurrence's original day) and leaves every series-level field — and every
  // other occurrence — untouched. Previously occurrenceScope was sent by the
  // client and read by nothing, so "This event only" silently rewrote the
  // whole series.
  if (
    p.occurrenceScope === "single" &&
    m.recurrence &&
    m.recurrence !== "none"
  ) {
    const key =
      (typeof p.occurrenceKey === "string" && p.occurrenceKey) ||
      occKey(p.occurrenceStartsAt || p.startsAt);
    if (!key || key.length !== 10) {
      const e: any = new Error(
        "A single-occurrence edit needs the occurrence being edited (occurrenceStartsAt).",
      );
      e.status = 400;
      throw e;
    }
    // RSCH-08: a PAST occurrence can't be rescheduled (the new time is already
    // future-checked above; this blocks picking a bygone occurrence).
    const origMs = Date.parse(p.occurrenceStartsAt || "");
    if (Number.isFinite(origMs) && origMs < Date.now() - 60 * 60000) {
      const e: any = new Error("A past occurrence can't be rescheduled.");
      e.status = 400;
      throw e;
    }
    if ("durationMin" in p) assertDuration(p.durationMin);
    const overrides = { ...(m.occurrenceOverrides || {}) };
    overrides[key] = {
      ...(overrides[key] || {}),
      ...(p.startsAt ? { startsAt: p.startsAt } : {}),
      ...(p.durationMin != null ? { durationMin: Number(p.durationMin) } : {}),
    };
    const updatedOcc = await db.meetings.update(meetingId, {
      occurrenceOverrides: overrides,
      // RSCH-06: any time-affecting change bumps the iCalendar SEQUENCE.
      icsSequence: (m.icsSequence || 0) + 1,
    });
    const outOcc: any = updatedOcc
      ? await serializeMeeting(await db.meetings.getById(meetingId), userId)
      : null;
    if (outOcc) outOcc._occurrenceMoved = { key, startsAt: p.startsAt || null };
    return outOcc;
  }
  // ── RCR-22: "This and all following" — split the series at an occurrence ──
  // The past keeps its rule (truncated to end the day before the split), the
  // future becomes a NEW series carrying the edit, and BOTH stay linked to the
  // same meeting chat (the new row's conversationId is the original's group).
  // Per-occurrence exceptions partition at the split: earlier ones stay with
  // the old series, later ones move to the new one.
  if (
    p.occurrenceScope === "following" &&
    m.recurrence &&
    m.recurrence !== "none"
  ) {
    const key =
      (typeof p.occurrenceKey === "string" && p.occurrenceKey) ||
      occKey(p.occurrenceStartsAt || p.startsAt);
    const splitMs = Date.parse(key + "T00:00:00Z");
    if (!key || key.length !== 10 || !Number.isFinite(splitMs)) {
      const e: any = new Error(
        'A "this and following" edit needs the occurrence it starts from.',
      );
      e.status = 400;
      throw e;
    }
    if (splitMs < Date.now() - 86400000) {
      const e: any = new Error("A past occurrence can't start a series split.");
      e.status = 400;
      throw e;
    }
    if ("durationMin" in p) assertDuration(p.durationMin);
    if (p.recurrenceRule) validateRecurrenceRule(p.recurrenceRule);
    const baseRule =
      m.recurrenceRule && m.recurrenceRule.freq
        ? m.recurrenceRule
        : ruleFromLegacy(m.recurrence);
    // An "after N" end double-counts unless the occurrences already consumed by
    // the OLD series come off the new one's count.
    let newEnd: any = (baseRule && baseRule.end) || { type: "never" };
    if (newEnd.type === "after" && baseRule) {
      const total = Math.min(Number(newEnd.count) || 1, 730);
      const consumed = expandByRule(m, baseRule, total).filter(
        (o: any) => occKey(o.occurrenceStartsAt || o.startsAt) < key,
      ).length;
      newEnd = { type: "after", count: Math.max(1, total - consumed) };
    }
    // First start of the new series: the edited time, else the split
    // occurrence's original slot (split day at the series' time-of-day).
    const timeOfDay0 = new Date(m.startsAt).toISOString().slice(11);
    const newStart =
      p.startsAt ||
      (p.occurrenceStartsAt && String(p.occurrenceStartsAt).length > 10
        ? p.occurrenceStartsAt
        : key + "T" + timeOfDay0);
    const exAll = (m.exdates || []).map(String);
    const ovAll = m.occurrenceOverrides || {};
    const ovStay: any = {};
    const ovMove: any = {};
    for (const k of Object.keys(ovAll)) (k < key ? ovStay : ovMove)[k] = ovAll[k];
    const grp = await ensureMeetingGroup(m);
    const created = await db.meetings.create({
      title: (typeof p.title === "string" && p.title.trim()) || m.title || "Untitled meeting",
      startsAt: newStart,
      durationMin: p.durationMin ?? m.durationMin,
      attendees: (m.attendees || []).map((a: any) => a.userId || a.id).filter(Boolean),
      createdBy: m.createdBy,
      // RCR-22: both series share the ORIGINAL's meeting chat.
      conversationId: (grp && grp.id) || m.conversationId || null,
      recurrence: m.recurrence,
      recurrenceRule: { ...(p.recurrenceRule || baseRule || {}), end: newEnd },
      reminderLeadMin: m.reminderLeadMin,
      timezone: m.timezone,
    });
    const movedEx = exAll.filter((k: string) => k >= key);
    if (movedEx.length || Object.keys(ovMove).length)
      await db.meetings.update(created.id, {
        exdates: movedEx,
        occurrenceOverrides: ovMove,
      });
    const dayBefore = new Date(splitMs - 86400000).toISOString().slice(0, 10);
    await db.meetings.update(meetingId, {
      recurrenceRule: {
        ...(baseRule || { freq: m.recurrence }),
        end: { type: "on", date: dayBefore },
      },
      exdates: exAll.filter((k: string) => k < key),
      occurrenceOverrides: ovStay,
      icsSequence: (m.icsSequence || 0) + 1, // RSCH-06
    });
    const outSplit: any = await serializeMeeting(
      await db.meetings.getById(created.id),
      userId,
    );
    if (outSplit)
      outSplit._seriesSplit = { originalId: meetingId, newId: created.id, splitKey: key };
    return outSplit;
  }
  delete p.occurrenceScope;
  delete p.occurrenceKey;
  delete p.occurrenceStartsAt;
  // Same duration invariant create() enforces — PATCH previously skipped it, so
  // an end<=start reschedule could persist a 0-minute (or >24h) meeting.
  if ("durationMin" in p) assertDuration(p.durationMin);
  // Normalize the meeting-reminder lead if the patch sets it (#53). COALESCE in the
  // driver means undefined leaves it untouched; an explicit value is bounded here.
  if ("reminderLeadMin" in p) p.reminderLeadMin = normLead(p.reminderLeadMin);
  // AUDIT #31: sanitize a patched series timezone (else leave it untouched via the
  // driver's COALESCE). A junk value becomes NULL → legacy server-local expansion.
  if ("timezone" in p)
    p.timezone =
      typeof p.timezone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(p.timezone)
        ? p.timezone
        : null;
  // RSCH-04: Reset RSVP responses ONLY when date, time or duration changes.
  const timeChanged =
    (p.startsAt && new Date(p.startsAt).getTime() !== new Date(m.startsAt).getTime()) ||
    (p.durationMin != null && Number(p.durationMin) !== Number(m.durationMin));
  // RSCH-06: a time-affecting series edit bumps the iCalendar SEQUENCE so
  // external calendars update the existing event instead of duplicating it.
  if (timeChanged) p.icsSequence = (m.icsSequence || 0) + 1;

  const updated = await db.meetings.update(meetingId, p);
  if (updated && timeChanged && m.attendees?.length) {
    for (const att of m.attendees) {
      const uid = att.userId || att.id;
      if (uid) {
        await db.meetings.setAttendeeStatus(meetingId, uid, "invited");
      }
    }
  }
  // Meeting-chat sync: newly invited people gain chat membership (MCHAT-20),
  // and renaming the meeting renames its chat (MCHAT-03) — but never a
  // pre-existing conversation the meeting was scheduled FROM (that thread's
  // name belongs to the thread, not the meeting).
  if (updated) {
    try {
      const fresh = await db.meetings.getById(meetingId);
      const grp = await ensureMeetingGroup(fresh);
      if (
        grp &&
        !m.conversationId &&
        typeof p.title === "string" &&
        p.title.trim() &&
        p.title !== m.title
      ) {
        await db.conversations.update(grp.id, { title: p.title.trim() });
      }
    } catch (_) {}
  }
  const outUpd: any = updated
    ? await serializeMeeting(await db.meetings.getById(meetingId), userId)
    : null;
  if (updated) syncMeetingToCalendars("meeting.upserted", await db.meetings.getById(meetingId));
  // Let the route post the RSCH-10 "meeting moved" trace + audit without
  // re-deriving what changed.
  if (outUpd && timeChanged) outUpd._rescheduled = true;
  return outUpd;
}
async function remove({ meetingId, userId }) {
  const m = await db.meetings.getById(meetingId);
  if (!m || m.createdBy !== userId) return { id: meetingId, deleted: false };
  await db.meetings.remove(meetingId);
  syncMeetingToCalendars("meeting.deleted", m);
  return { id: meetingId, deleted: true };
}
async function leave({ meetingId, userId }) {
  await db.meetings.removeAttendee(meetingId, userId);
  return { id: meetingId, left: true };
}
// RSVP: an invitee sets their attendance to accepted / tentative / declined.
// Declining keeps the row (so the meeting stays visible and can be changed);
// `leave` removes the attendee entirely. Only invitees (or the host) may RSVP.
const RSVP_STATES = new Set(["accepted", "tentative", "declined"]);
async function respond({ meetingId, userId, status }: any) {
  if (!RSVP_STATES.has(status)) {
    const e: any = new Error("Invalid RSVP status.");
    e.status = 400;
    throw e;
  }
  const m = await db.meetings.getById(meetingId);
  if (!m) {
    const e: any = new Error("Meeting not found.");
    e.status = 404;
    throw e;
  }
  const invited = (m.attendees || []).some((a: any) => a.userId === userId);
  if (!invited && m.createdBy !== userId) {
    const e: any = new Error("You're not invited to this meeting.");
    e.status = 403;
    throw e;
  }
  await db.meetings.setAttendeeStatus(meetingId, userId, status);
  return serializeMeeting(await db.meetings.getById(meetingId), userId);
}
// The window the ROOM is for right now. A one-off has exactly one:
// [startsAt, startsAt + duration]. A recurring series has many, and the anchor
// row only ever stores the FIRST — so reading `startsAt` off the row to decide
// whether "the meeting" has expired is wrong from the second occurrence on.
// Resolve the occurrence whose window contains now, else the next upcoming one
// (arriving early for next week's stand-up is arriving early, not arriving
// late for last week's). Null means nothing is left: a one-off with an
// unparseable start, or a bounded series that has run out.
function sessionWindow(m: any, nowMs = Date.now()): { start: number; end: number } | null {
  const durMs = Math.max(1, Number(m.durationMin) || 30) * 60000;
  const anchor = Date.parse(m.startsAt);
  if (!Number.isFinite(anchor)) return null;
  const rule = m.recurrenceRule || ruleFromLegacy(m.recurrence);
  if (!rule) return { start: anchor, end: anchor + durMs };
  // Walk forward from just before the earliest occurrence that could still be
  // running. nextOccurrenceAfter is strictly-after, so the cursor sits one
  // minute before that bound; a couple of steps covers the margin.
  let cursor = nowMs - durMs - 60000;
  for (let i = 0; i < 4; i++) {
    const iso = nextOccurrenceAfter(m.startsAt, rule, cursor, m.timezone ?? null);
    if (!iso) return null; // the series has ended
    const start = Date.parse(iso);
    if (nowMs <= start + durMs) return { start, end: start + durMs };
    cursor = start;
  }
  return null;
}

function isRecurringMeeting(m: any): boolean {
  return !!(m.recurrenceRule || (m.recurrence && m.recurrence !== "none"));
}

// Derive a meeting's lifecycle state from its stored status, schedule, and the
// number of participants currently in the room. Covers the full enterprise set:
// scheduled / starting / waiting / active / completed / cancelled / expired.
// ACTUAL room presence always wins over the stored status — a meeting with
// active participants is never "completed" or "cancelled", regardless of what
// the status field says. This prevents the "Meeting has ended" screen from
// appearing while participants are still connected.
function computeState(m: any, present: number) {
  // LIVE as soon as anyone is in the room — overrides any stored status.
  if (present >= 1) return "active";
  if (m.status === "cancelled") return "cancelled";
  const now = Date.now();
  const win = sessionWindow(m, now);
  // A completed status on a series anchor means the LAST session ended — the
  // same rule the calendar applies (listForUserCalendar): it must not mark a
  // FUTURE occurrence as finished.
  if (m.status === "completed" && !(isRecurringMeeting(m) && win && win.start > now))
    return "completed";
  if (win) {
    if (now < win.start - 5 * 60000) return "scheduled";
    if (now < win.start) return "starting";
    if (now > win.end) return "expired";
  }
  return "starting";
}

async function getRoom({ meetingId, userId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) return null;
  const present = await db.meetings.roomParticipants(meetingId);
  // Batch the participant user lookups into ONE query. getRoom runs on every
  // heartbeat, so the old per-participant getById was N queries per beat — at N
  // participants each beating on a timer that's ~N²/window queries against MySQL
  // (the #1 DB bottleneck for large meetings). getByIds resolves all N at once.
  const users = await db.users.getByIds(present.map((p: any) => p.userId));
  const byId = new Map((users || []).map((u: any) => [u.id, u]));
  const participants = present.map((p: any) => ({
    ...(pubUser(byId.get(p.userId)) || {}),
    joinedAt: p.joinedAt,
  }));
  const meeting = await serializeMeeting(m, userId);
  const hostPresent = present.some((p: any) => p.userId === m.createdBy);
  return {
    meeting,
    participants,
    count: participants.length,
    state: computeState(m, participants.length),
    isHost: m.createdBy === userId,
    hostPresent,
  };
}

// Entering the room gates on lobby: if lobby is enabled and the user is not
// host or co-host, they are placed in the lobby and must wait for admission.
async function enterRoom({ meetingId, userId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) return null;
  const isHost = m.createdBy === userId;
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  const isCoHost = role === "co-host";
  // A HARD-ended meeting ("End for everyone") stops the live SESSION, but the
  // join link stays valid for the whole scheduled window — it is disabled only
  // once the scheduled time has been exceeded. Past the window a hard-ended
  // meeting is over for EVERYONE, host included, with no lingering-participant
  // grace period. (Reminders for a hard-ended meeting stay suppressed — see
  // db.meetings.withReminderLead.)
  if ((m as any).hardEnded) {
    const win = sessionWindow(m);
    if (!win || Date.now() > win.end) return { closed: true, meetingId };
  }
  // "Ended" (completed) means the live SESSION stopped — the room stays OPEN for
  // the whole scheduled window [startsAt, startsAt + durationMin] so anyone can
  // rejoin without scheduling a fresh meeting. Only a CANCELLED meeting (host
  // called it off) is closed early; a COMPLETED meeting closes only once truly
  // EXPIRED (past its window). As before, this only bites an EMPTY room (active
  // participants keep it live), and host/co-host remain immune (matching lock/
  // lobby) so they can always return.
  if (!isHost && !isCoHost) {
    // "Expired" is judged against the occurrence the room is for NOW, not the
    // series anchor. For a recurring meeting the anchor's startsAt is the FIRST
    // occurrence and its status is whatever the LAST session left behind — so
    // once the host had ended any earlier occurrence, every later one read as
    // completed + expired, and anyone arriving before the host (empty room) was
    // told "This meeting has ended" and never got in. Attendees who clicked
    // after the host was already inside passed, which is why it looked like
    // only SOME people failed to join.
    const win = sessionWindow(m);
    const expired = !win || Date.now() > win.end;
    const closedNow =
      m.status === "cancelled" || (m.status === "completed" && expired);
    if (closedNow) {
      const present = await db.meetings.roomParticipants(meetingId);
      if (present.length === 0) {
        return { closed: true, meetingId };
      }
    }
  }
  // Host eject check FIRST — before lock, before lobby. A removed user must
  // not be able to re-mint a token and rejoin (the "remove participant" host
  // control was previously cosmetic because the user could just /calls/token
  // again with the same auth). Host/co-host are immune (they removed someone,
  // they shouldn't be able to lock themselves out by mistake).
  if (!isHost && !isCoHost) {
    if (await (db.meetings as any).meetingIsEjected(meetingId, userId)) {
      return { ejected: true, meetingId };
    }
  }
  // Locked meeting: only host/co-host may enter; everyone else is refused, even
  // if already admitted past the lobby. People already in the room are unaffected.
  if (m.locked && !isHost && !isCoHost) {
    const present = await db.meetings.roomParticipants(meetingId);
    const alreadyIn = present.some((p: any) => p.userId === userId);
    if (!alreadyIn) {
      return { locked: true, meetingId };
    }
  }
  // LOBBY POLICY (0116). 'everyone' lets anyone straight in, 'invited' lets
  // people on the invite list past and holds everyone else, 'nobody' holds all
  // non-hosts. `role` above is non-null exactly when the user is on the invite
  // list, which is what "invited" means here.
  // "Invited" means the HOST put them on the list — NOT merely that an
  // attendee row exists, because joining creates one of those too (0117).
  const isInvited = await (db.meetings as any).isInvitedByHost(meetingId, userId).catch(() => !!role);
  if (policy.mustWaitInLobby(m, { isHost, isCoHost, isInvited })) {
    const lobbyStatus = await db.meetings.lobbyStatus(meetingId, userId);
    if (lobbyStatus === "admitted") {
      await db.meetings.enterRoom(meetingId, userId);
      await db.meetings.setAttendeeStatus(meetingId, userId, "accepted");
      return { ...(await getRoom({ meetingId, userId })), lobbyStatus: "admitted" };
    }
    if (!lobbyStatus || lobbyStatus === "denied") {
      await db.meetings.lobbyRequest(meetingId, userId);
    }
    return {
      lobbyStatus: lobbyStatus === "admitted" ? "admitted" : "waiting",
      meetingId,
      lobby: await roomPreview({ meetingId, userId }),
    };
  }
  await db.meetings.enterRoom(meetingId, userId);
  await db.meetings.setAttendeeStatus(meetingId, userId, "accepted");
  return getRoom({ meetingId, userId });
}

async function heartbeatRoom({ meetingId, userId }: any) {
  await db.meetings.heartbeatRoom(meetingId, userId);
  return getRoom({ meetingId, userId });
}

async function leaveRoom({ meetingId, userId }: any) {
  await db.meetings.leaveRoom(meetingId, userId);
  return { id: meetingId, left: true };
}

async function cancel({ meetingId, userId, scope, occurrenceStartsAt }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m || m.createdBy !== userId) return null;
  // ── CNCL-01 / RCR-23: cancel ONE occurrence of a recurring series ─────────
  // Adds an exclusion (day-keyed EXDATE); the series and every other
  // occurrence — plus all recordings/files/chat from past occurrences
  // (CNCL-06, they live in the meeting group) — are untouched.
  // Accepts either the day key ("YYYY-MM-DD") or the occurrence's ISO start.
  const occAnchor =
    typeof occurrenceStartsAt === "string" && occurrenceStartsAt
      ? occurrenceStartsAt
      : null;
  if (
    scope === "occurrence" &&
    occAnchor &&
    m.recurrence &&
    m.recurrence !== "none"
  ) {
    const key = occAnchor.length === 10 ? occAnchor : occKey(occAnchor);
    const exdates = Array.from(new Set([...(m.exdates || []), key]));
    const updatedOcc = await db.meetings.update(meetingId, {
      exdates,
      icsSequence: (m.icsSequence || 0) + 1, // RSCH-06 / CNCL-03
    });
    const outOcc: any = updatedOcc
      ? await serializeMeeting(await db.meetings.getById(meetingId), userId)
      : null;
    if (outOcc) outOcc._occurrenceCancelled = key;
    return outOcc;
  }
  const updated = await db.meetings.setStatus(meetingId, "cancelled");
  // RSCH-06 / CNCL-03: a cancellation is an iCalendar state change too.
  try {
    await db.meetings.update(meetingId, { icsSequence: (m.icsSequence || 0) + 1 });
  } catch (_) {}
  // Cancelled meeting — clear the eject list so the same meeting being
  // restarted (or reused) doesn't carry stale removals.
  try { await (db.meetings as any).meetingEjectClearAll(meetingId); } catch (_) {}
  if (updated) syncMeetingToCalendars("meeting.upserted", await db.meetings.getById(meetingId));
  return updated ? serializeMeeting(updated, userId) : null;
}

async function complete({ meetingId, userId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m || m.createdBy !== userId) return null;
  // Capture who was PRESENT before teardown clears presence — the temp-group
  // membership must include everyone who was in the meeting, not just whoever
  // happened to send a chat message. In a 2-person meeting where only the host
  // recorded/chatted, the other attendee would otherwise be left out entirely.
  let presentIds: string[] = [];
  try {
    const present = await (db.meetings as any).roomParticipants?.(meetingId);
    presentIds = (present || []).map((p: any) => p.userId).filter(Boolean);
  } catch (_) {}
  // AUDIT P1 (#9): "End for everyone" HARD-ends the session — hard_ended seals it so
  // a re-joining attendee can't resurrect it as "active" (setHardEnded also sets
  // status='completed'). A natural session-stop keeps the reusable 'completed'.
  //
  // FIX: For a RECURRING series the anchor row is shared across all occurrences.
  // Setting hard_ended=1 permanently on the anchor means EVERY future occurrence
  // is blocked forever — a weekly standup becomes unrecoverable with no UI to fix it.
  // For recurring meetings we fall back to setStatus('completed') only, which closes
  // the current occurrence window but leaves the series joinable at the next occurrence.
  const isRecurring = m.recurrence && m.recurrence !== "none";
  const updated = isRecurring
    ? (await (db.meetings as any).clearHardEndedAndComplete?.(meetingId) ??
       await db.meetings.setStatus(meetingId, "completed"))
    : ((await (db.meetings as any).setHardEnded(meetingId)) ||
       (await db.meetings.setStatus(meetingId, "completed")));
  // Room presence is cleared so computeState can't report 'active' during teardown.
  try { await (db.meetings as any).clearRoom?.(meetingId); } catch (_) {}
  // Disconnect EVERYONE from the SFU room NOW — before the (potentially slow)
  // temp-group chat porting below — so "End for everyone" ejects participants
  // immediately instead of after up to 500 messages are copied. Best-effort;
  // the /complete route also calls deleteRoom (idempotent) as a belt-and-braces.
  try {
    const { deleteRoom } = await import("./livekitService");
    await deleteRoom("meeting_" + meetingId);
  } catch (_) {}
  // Same as cancel — meeting is over, ejects don't carry over.
  try { await (db.meetings as any).meetingEjectClearAll(meetingId); } catch (_) {}
  // MCHAT-04: the meeting chat is a PERSISTENT group that has existed since the
  // meeting was scheduled (ensureMeetingGroup). At meeting end: make sure
  // everyone who was actually there (or chatted) is a member, then back-fill
  // any in-meeting chat lines whose LIVE mirror (socket layer) didn't land —
  // the merge dedups by text+filename, so already-mirrored lines are no-ops.
  // Best-effort — a failure here must never block the meeting-end teardown. The
  // group is returned via `tempGroup` so the /complete route can push a
  // realtime CONVERSATION_NEW (+ join member sockets).
  let tempGroup: { id: string; memberIds: string[] } | null = null;
  try {
    const grp = await ensureMeetingGroup(m);
    if (grp) {
      const msgs =
        (await (db as any).meetingMessages?.listRecent?.(meetingId, 500)) || [];
      const convSvc = await import("./conversationService");
      const extras = (
        await withoutGuests(
          [userId, ...presentIds, ...msgs.map((x: any) => x.senderId)].filter(
            Boolean,
          ),
        )
      ).filter((u: any) => !grp.memberIds.includes(u)) as string[];
      if (extras.length) {
        try {
          // MCHAT-21 cutoffs were stamped at session start (startTemporaryGroup);
          // addMembers skips existing members, so nothing is re-widened here.
          await (convSvc as any).addMembers(grp.id, extras);
          grp.memberIds.push(...extras);
        } catch (_) {}
      }
      if (msgs.length) {
        await (convSvc as any).createTemporaryGroup({
          title: m.title || "Meeting chat",
          icon: "📹",
          memberIds: grp.memberIds,
          creatorId: userId,
          // Append into the meeting's OWN group — never re-dedup by name/set.
          targetGroupId: grp.id,
          messages: msgs.map((x: any) => ({
            senderId: x.senderId,
            text: x.body || "",
            file: x.file || null,
          })),
        });
      }
      tempGroup = { id: grp.id, memberIds: grp.memberIds };
    }
  } catch (e: any) {
    console.warn(
      "[meeting] meeting-group finalize failed mid=%s: %s",
      meetingId,
      e?.message,
    );
  }
  // REC-15: attendance report into the meeting chat when the meeting ends —
  // who joined, when, and for how long. Presence rows survive the room
  // teardown as soft-deletes (deleted_at doubles as the leave time), so this
  // reads the FULL session, not just whoever was present at the final moment.
  // Best-effort and after the group finalize so the report lands under this
  // occurrence's chatter.
  // The chat gets ONE "Meeting ended: <duration>" line carrying an Attendance
  // card (type "meeting_attendance", JSON body like the invite card). The card
  // holds only the session summary; the per-person table is fetched on click
  // from the host-gated /attendance endpoint, so nobody's join/leave times sit
  // in a message every member can read.
  let attendanceMessage: any = null;
  if (tempGroup) {
    try {
      const summary = await sessionSummary(meetingId, reportSince(m));
      if (summary) {
        const msgSvc: any = await import("./messageService");
        attendanceMessage = await msgSvc.send({
          conversationId: tempGroup.id,
          senderId: userId,
          text: JSON.stringify({
            meetingId,
            title: m.title || "Meeting",
            ...summary,
            viewerIds: [
              m.createdBy,
              ...(m.attendees || [])
                .filter((a: any) => a.role === "co-host")
                .map((a: any) => a.userId || a.id),
            ].filter(Boolean),
          }),
          file: null,
          type: "meeting_attendance",
          bumpUnread: false,
        });
      }
    } catch (_) {
      /* the report is informational — never block meeting-end */
    }
  }
  const out = updated ? serializeMeeting(updated, userId) : null;
  if (out) (out as any).tempGroup = tempGroup;
  if (out) (out as any).attendanceMessage = attendanceMessage;
  return out;
}

// ── Meeting-linked group chat (MCHAT-01/03/04/05/20/21) ─────────────────────
// Every meeting has ONE group conversation, keyed by the stable dmKey
// "call|m:<meetingId>" — the SAME key the socket layer's live chat mirror
// looks up, so in-meeting messages land in it as they're sent. It is created
// at SCHEDULING time with the host + every invitee as members (reachable from
// the chat list before the meeting starts, whether or not they attend) and it
// PERSISTS like any other group — no temp-group TTL. A recurring series shares
// its anchor meeting row, so every occurrence funnels into this one group by
// construction. A meeting scheduled FROM an existing conversation uses THAT
// thread as its chat instead of minting a second one.
// Idempotent: later calls only sync newly invited members in.
async function ensureMeetingGroup(
  m: any,
): Promise<{ id: string; memberIds: string[]; title: string } | null> {
  try {
    if (!m || !m.id) return null;
    const attendeeIds = (m.attendees || [])
      .map((a: any) => a.userId || a.id)
      .filter(Boolean);
    // Public-link guests (role 'guest') are walk-in attendee rows; they are never
    // members of the org's meeting chat group.
    const memberIds = (await withoutGuests(
      [m.createdBy, ...attendeeIds].filter(Boolean),
    )) as string[];
    const convSvc: any = await import("./conversationService");
    if (m.conversationId) {
      // Scheduled from a chat → that conversation IS the meeting chat. Sync the
      // invitees into it when it's a group (addMembers rejects DMs by design —
      // a DM's two people already are the meeting).
      try {
        await convSvc.addMembers(m.conversationId, memberIds);
      } catch (_) {}
      return { id: m.conversationId, memberIds, title: m.title || "Meeting chat" };
    }
    const dmKey = "call|m:" + m.id;
    let convId =
      (db.conversations as any).findByDmKey &&
      (await (db.conversations as any).findByDmKey(dmKey));
    if (!convId) {
      const res: any = await convSvc.create({
        kind: "group",
        title: m.title || "Meeting chat",
        icon: "📹",
        memberIds: memberIds.filter((x) => x !== m.createdBy),
        creatorId: m.createdBy,
        temporary: false, // MCHAT-04: persists like any other group
        sessionKey: "m:" + m.id,
      });
      convId = (res && res.conversation && res.conversation.id) || (res && res.id) || null;
    } else {
      try {
        await convSvc.addMembers(convId, memberIds);
      } catch (_) {}
    }
    return convId
      ? { id: convId, memberIds, title: m.title || "Meeting chat" }
      : null;
  } catch (e: any) {
    console.warn(
      "[meeting] ensureMeetingGroup failed mid=%s: %s",
      m && m.id,
      e?.message,
    );
    return null;
  }
}

// MCHAT-05: one divider per occurrence ("Sprint planning · 9 Sep 2026") so a
// recurring series' single chat reads as a timeline, with each occurrence's
// chatter and artifacts under its own divider. Deduped by the same §sd§ marker
// scheme the call-session dividers use — N participants entering the room post
// exactly one divider per occurrence-day.
async function postOccurrenceDivider(conversationId: string, m: any) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const marker = "§sd:m:" + m.id + ":" + day + "§";
    const pre = await db.messages.listForConversation(conversationId, {
      limit: 500,
    });
    if ((pre || []).some((r: any) => String(r.body || "").includes(marker)))
      return;
    const when = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const msgSvc: any = await import("./messageService");
    await msgSvc.send({
      conversationId,
      senderId: m.createdBy,
      text: marker + (m.title || "Meeting") + " · " + when,
      file: null,
      type: "session_divider",
      bumpUnread: false,
    });
  } catch (_) {
    /* the divider is cosmetic — never block room entry */
  }
}

// Ensure the meeting group AT SESSION START and stamp the occurrence divider.
// The group itself already exists from scheduling (ensureMeetingGroup); this
// adds everyone actually IN the room — link joiners included (MCHAT-21) — as
// chat members and marks the occurrence. Returns { id, memberIds, title } for
// the route to announce over the socket, or null.
async function startTemporaryGroup({ meetingId, userId }: any): Promise<{ id: string; memberIds: string[]; title: string } | null> {
  try {
    const m = await db.meetings.getById(meetingId);
    if (!m) return null;
    // MCHAT-21 (§11 Q4): who counted as a member BEFORE this session touched
    // the group. enterRoom upserts every room entrant as an "accepted"
    // attendee, so by now a link-joiner is indistinguishable from an invitee
    // in m.attendees — the pre-ensure snapshot is what actually separates
    // "invited at scheduling" (already a member) from "walked in via link".
    const preConvId =
      m.conversationId ||
      ((db.conversations as any).findByDmKey &&
        (await (db.conversations as any).findByDmKey("call|m:" + meetingId)));
    const preMembers = new Set<string>(
      preConvId
        ? ((await db.conversations.members(preConvId)) || []).map((x: any) => x.userId)
        : [],
    );
    const grp = await ensureMeetingGroup(m);
    if (!grp) return null;
    // Anyone actually IN the room becomes a chat member the moment the session
    // is live (link joiners included).
    const present = await db.meetings.roomParticipants(meetingId).catch(() => []);
    const presentIds = (await withoutGuests(
      [userId, ...(present || []).map((p: any) => p.userId)].filter(Boolean),
    )) as string[];
    const joiners = presentIds.filter((u) => !grp.memberIds.includes(u));
    if (joiners.length) {
      try {
        const convSvc: any = await import("./conversationService");
        await convSvc.addMembers(grp.id, joiners);
        grp.memberIds.push(...joiners);
      } catch (_) {}
    }
    // Default "joinpoint": everyone present who was NOT a member before this
    // call reads from their join forward — a per-member history cutoff the
    // message reads enforce. MEETING_LINK_JOINER_HISTORY=full flips the policy
    // once legal settles it. The organizer is never scoped (their group).
    const fullHistory =
      ((config as any).meetings?.linkJoinerHistory || "joinpoint") === "full";
    if (!fullHistory) {
      for (const uid of presentIds) {
        if (uid === m.createdBy || preMembers.has(uid)) continue;
        try {
          await (db.conversations as any).setMemberHistoryCutoff(grp.id, uid);
        } catch (_) {}
      }
    }
    // MCHAT-05: stamp this occurrence's divider (idempotent per day).
    await postOccurrenceDivider(grp.id, m);
    return grp;
  } catch (e: any) {
    console.warn("[meeting] start meeting-group failed mid=%s: %s", meetingId, e?.message);
    return null;
  }
}

async function toggleLobby({ meetingId, userId, enabled }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m || m.createdBy !== userId) return null;
  await db.meetings.setLobbyEnabled(meetingId, !!enabled);
  return { meetingId, lobbyEnabled: !!enabled };
}

// ── Free/busy (scheduler redesign) ──────────────────────────────────────────
// "Is everyone free then?" answered from the meetings we already store. This is
// deliberately INTERNAL-only: it says nothing about anyone's Outlook or Google
// calendar, because there is no calendar integration — so a "free" answer means
// "free as far as CoLab knows", and the UI must not overstate it.
async function availability({ userIds, startsAt, durationMin, excludeMeetingId, viewerId }: any) {
  const ids: string[] = Array.from(
    new Set<string>((userIds || []).filter(Boolean).map((u: any) => String(u))),
  );
  if (!ids.length) return { busy: [], free: [], checked: [] };
  const start = new Date(startsAt);
  if (!Number.isFinite(start.getTime())) {
    const e: any = new Error("A valid start time is required.");
    e.status = 400;
    throw e;
  }
  const mins = Math.max(1, Math.min(24 * 60, Number(durationMin) || 30));
  const end = new Date(start.getTime() + mins * 60000);
  const fmt = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

  const clashes = await (db.meetings as any).busyAmong(
    ids,
    fmt(start),
    fmt(end),
    excludeMeetingId || null,
  );

  // Group by person. The TITLE of a clashing meeting is only returned for the
  // viewer's own conflicts — telling a host what someone else's other meeting
  // is called leaks calendar detail they never agreed to share. For everyone
  // else the answer is just "busy".
  const byUser = new Map<string, any[]>();
  for (const c of clashes || []) {
    const list = byUser.get(c.userId) || [];
    list.push(c);
    byUser.set(c.userId, list);
  }
  const busy = Array.from(byUser.entries()).map(([userId, list]) => ({
    userId,
    conflicts: list.length,
    title: userId === viewerId ? list[0].title : null,
  }));
  const busyIds = new Set(busy.map((b) => b.userId));
  return {
    checked: ids,
    busy,
    free: ids.filter((id) => !busyIds.has(id)),
  };
}

// ── Attendance report (0119) ────────────────────────────────────────────────
// Host/co-host only. Resolves the per-user rows the driver aggregates into
// names and emails in ONE batched user lookup, so a 200-person meeting is two
// queries rather than 201.
// The session of a meeting, from the attendance log: when the first person
// joined, when the last one left, and how many distinct people were in it.
// Null when nobody ever joined (nothing to report).
// For a recurring series only the CURRENT occurrence counts: every occurrence
// logs under the one meeting id, so the report is cut at this occurrence's start
// (less an hour, for people who join early).
function reportSince(m: any): Date | null {
  if (!m || !(m.recurrenceRule || (m.recurrence && m.recurrence !== "none"))) return null;
  const durMs = Math.max(1, Number(m.durationMin) || 30) * 60000;
  // An occurrence that just ended still resolves when we look back by its length.
  const win = sessionWindow(m, Date.now() - durMs) || sessionWindow(m);
  return win ? new Date(Math.min(win.start, Date.now()) - 3600000) : null;
}

async function sessionSummary(meetingId: string, since: Date | null = null) {
  const raw: any[] = ((db.meetings as any).attendanceReport &&
    (await (db.meetings as any).attendanceReport(meetingId, since))) || [];
  if (!raw.length) return null;
  const starts = raw.map((r) => new Date(r.firstJoined).getTime()).filter(Number.isFinite);
  const ends = raw.map((r) => new Date(r.lastLeft).getTime()).filter(Number.isFinite);
  if (!starts.length || !ends.length) return null;
  const startedAt = Math.min(...starts);
  const endedAt = Math.max(...ends);
  const total = raw.reduce((s, r) => s + (Number(r.seconds) || 0), 0);
  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationSec: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
    attendedCount: raw.length,
    avgSeconds: Math.round(total / raw.length),
  };
}

async function attendance({ meetingId, userId, since: sinceIn }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) return null;
  const isHost = m.createdBy === userId;
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  if (!isHost && role !== "co-host") {
    const e: any = new Error("Only the host or a co-host can see the attendance report.");
    e.status = 403;
    e.code = "FORBIDDEN";
    throw e;
  }
  // The chat card passes the session's own start, so an old card keeps opening
  // ITS occurrence; without it, fall back to the current occurrence.
  const sinceMs = sinceIn ? Date.parse(sinceIn) : NaN;
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs - 1000) : reportSince(m);
  const raw = await (db.meetings as any).attendanceReport(meetingId, since);
  const users = await db.users.getByIds((raw || []).map((r: any) => r.userId));
  const byId = new Map<string, any>((users || []).map((u: any) => [u.id, u]));
  const rows = (raw || []).map((r: any) => {
    const u: any = byId.get(r.userId);
    const att = (m.attendees || []).find((a: any) => (a.userId || a.id) === r.userId);
    return {
      userId: r.userId,
      name: (u && u.name) || "Unknown",
      email: (u && u.email) || null,
      avatar: pubUser(u),
      role:
        r.userId === m.createdBy
          ? "Organizer"
          : att && att.role === "co-host"
            ? "Co-host"
            : "Attendee",
      firstJoined: r.firstJoined,
      lastLeft: r.lastLeft,
      sessions: r.sessions,
      seconds: r.seconds,
      stillPresent: r.stillPresent,
    };
  });
  // Invitees who never showed are part of the answer — an attendance report that
  // only lists people who turned up cannot tell you who missed it.
  const invited = (m.attendees || []).map((a: any) => a.userId || a.id).filter(Boolean);
  const seen = new Set(rows.map((r: any) => r.userId));
  const absentIds = invited.filter((id: string) => !seen.has(id));
  const absentUsers = absentIds.length ? await db.users.getByIds(absentIds) : [];
  const absent = (absentUsers || []).map((u: any) => ({
    userId: u.id,
    name: u.name || "Unknown",
    email: u.email || null,
  }));
  return {
    meetingId,
    title: m.title,
    startsAt: m.startsAt,
    durationMin: m.durationMin,
    rows,
    absent,
    attendedCount: rows.length,
    invitedCount: invited.length,
    // Session summary for the report's header tiles.
    summary: await sessionSummary(meetingId, since),
  };
}

// ── Per-meeting options (0116) ──────────────────────────────────────────────
// Read by anyone who can see the meeting (the client needs them to disable the
// right controls); written by host or co-host only.
async function getOptions({ meetingId, userId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) return null;
  const isHost = m.createdBy === userId;
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  if (!isHost && !role) {
    const e: any = new Error("You are not part of this meeting.");
    e.status = 403;
    e.code = "FORBIDDEN";
    throw e;
  }
  return {
    meetingId,
    ...policy.optionsOf(m),
    // Admin blocked THIS user from the whiteboard (per-user, see whiteboardAccess).
    whiteboardBlocked: isWhiteboardBlocked(meetingId, userId),
    // The host restricted THIS user's camera / screen share (per-person).
    ...restrictionsOf(meetingId, userId),
    canEdit: isHost || role === "co-host",
  };
}

// Rewrite the LiveKit grant of everyone currently in a meeting's room from the
// SAME function the token route uses (policy.grantForUser), so people already
// connected and people who join later always end up with identical permissions.
// Never throws: the caller's DB write has already committed, so the policy is
// correct and enforced on every subsequent join even if the media server blips.
async function repermissionRoom(meeting: any, onlyUserId?: string) {
  let applied = { updated: 0, missed: 0 };
  try {
    const present = await db.meetings.roomParticipants(meeting.id);
    const perUser = [] as any[];
    for (const p of present || []) {
      const uid = p.userId || p.id;
      if (!uid || (onlyUserId && uid !== onlyUserId)) continue;
      const pIsHost = meeting.createdBy === uid;
      const pRole = await db.meetings.getAttendeeRole(meeting.id, uid).catch(() => null);
      perUser.push({
        userId: uid,
        // roomToken grants roomAdmin to the host only; restate it so the
        // atomic permission update does not strip it.
        roomAdmin: pIsHost,
        ...policy.grantForUser(meeting, uid, { isHost: pIsHost, isCoHost: pRole === "co-host" }),
      });
    }
    applied = await applyPermissions("meeting_" + meeting.id, perUser);
  } catch (e: any) {
    console.warn("[meetings] live re-permission failed:", e?.message || e);
  }
  return applied;
}

// Change options. The order matters and is deliberate:
//   1. persist        — so the policy is durable before anything acts on it,
//                       and a late joiner's token is built from the new value
//                       even if step 2 is still running.
//   2. re-permission  — rewrite the LiveKit grant for everyone already in the
//                       room, from the SAME function the token route uses.
//   3. broadcast      — tell clients to re-render their controls.
// If step 2 partially fails the policy is still correct and still enforced at
// the SFU for every subsequent publish; the affected participant converges on
// their next join. Nothing is left in a state where the DB and the grant
// disagree about what is ALLOWED — only about what has been applied yet.
async function setOptions({ meetingId, userId, patch }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) return null;
  const isHost = m.createdBy === userId;
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  if (!isHost && role !== "co-host") {
    const e: any = new Error("Only the host or a co-host can change meeting options.");
    e.status = 403;
    e.code = "FORBIDDEN";
    throw e;
  }
  const clean = policy.normalizePatch(patch);
  if (!Object.keys(clean).length) return { meetingId, ...policy.optionsOf(m), changed: false };

  await db.meetings.setOptions(meetingId, clean);
  const after = await db.meetings.getById(meetingId);

  // Re-permission live participants against the SAME rules the token uses.
  // Only mic and camera affect the LiveKit grant here — a change to
  // chat/reactions/lobby needs no re-permissioning round-trip to the SFU.
  const publishAffecting =
    clean.allowMic !== undefined || clean.allowCamera !== undefined;
  const applied = publishAffecting
    ? await repermissionRoom(after)
    : { updated: 0, missed: 0 };
  return { meetingId, ...policy.optionsOf(after), changed: true, applied };
}

// Host-only: lock seals the room — no one new may enter, even invitees. People
// already present stay. Host/co-host bypass so they can re-enter after a drop.
async function toggleLock({ meetingId, userId, locked }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m || m.createdBy !== userId) return null;
  await db.meetings.setLocked(meetingId, !!locked);
  return { meetingId, locked: !!locked };
}

async function lobbyList({ meetingId, userId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) return [];
  const isHost = m.createdBy === userId;
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  if (!isHost && role !== "co-host") return [];
  return db.meetings.lobbyList(meetingId);
}

/**
 * What someone OUTSIDE the room may see about it.
 *
 * Two callers, one answer, because both people are asking the same question
 * from the same place — outside the door:
 *   • the green room (everyone sees it before joining, invited or not), and
 *   • the lobby wait screen (only those the policy holds).
 *
 * enterRoom used to answer a bare { lobbyStatus: "waiting" }, so the wait screen
 * could only say "waiting to be admitted" — no meeting name, no sign the meeting
 * had even started, no idea whether anyone was coming to let you in. And the
 * green room said nothing at all beyond the title. This is the minimum that
 * makes both legible: whose meeting it is, whether it has started, who is
 * already inside, and who else is waiting.
 *
 * Deliberately narrow. It is readable by someone NOT yet admitted, so it carries
 * only what a name badge needs — never contact details (pubUser includes email
 * and phone, which the room roster may show but the lobby must not), attendee
 * status, or meeting options.
 */
const lobbyPerson = (u: any) =>
  u && {
    id: u.id,
    name: u.name || "Someone",
    initials: u.initials || null,
    color: u.color || null,
    avatarUrl: u.avatarUrl || null,
  };

/**
 * Read-only status for the person waiting. The wait screen polls this rather
 * than re-POSTing /room/enter, which MUTATES (a denied person would be silently
 * re-queued by their own poll).
 */
async function lobbySelf({ meetingId, userId }: any) {
  const status = await db.meetings.lobbyStatus(meetingId, userId);
  return {
    status: status || "waiting",
    lobby: await roomPreview({ meetingId, userId }),
  };
}

async function roomPreview({ meetingId, userId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) return null;
  const present = await db.meetings.roomParticipants(meetingId);
  const inRoomUsers = await db.users.getByIds(present.map((p: any) => p.userId));
  const byId = new Map((inRoomUsers || []).map((u: any) => [u.id, u]));
  const host = m.createdBy ? byId.get(m.createdBy) || (await db.users.getById(m.createdBy)) : null;
  const participants = present.map((p: any) => ({
    ...(lobbyPerson(pubUser(byId.get(p.userId))) || { id: p.userId, name: "Someone" }),
    isHost: p.userId === m.createdBy,
  }));
  // Everyone else holding outside with you. Your own row is dropped — the screen
  // already says you are waiting — and denied/admitted rows are not "waiting".
  let waiting: any[] = [];
  try {
    const rows = await db.meetings.lobbyList(meetingId);
    const others = (rows || []).filter(
      (r: any) => r.status === "waiting" && r.userId !== userId,
    );
    const us = await db.users.getByIds(others.map((r: any) => r.userId));
    const wById = new Map((us || []).map((u: any) => [u.id, u]));
    waiting = others.map((r: any) => ({
      ...(lobbyPerson(pubUser(wById.get(r.userId))) || {
        id: r.userId,
        name: r.name || "Someone",
      }),
      requestedAt: r.requestedAt,
    }));
  } catch {
    /* the queue is a nicety — never fail the wait screen over it */
  }
  const hostPresent = present.some((p: any) => p.userId === m.createdBy);
  return {
    meetingId,
    title: m.title || "Meeting",
    startsAt: m.startsAt,
    durationMin: m.durationMin || 30,
    timezone: (m as any).timezone || null,
    hostName: (host && host.name) || null,
    hostPresent,
    // "Has it started" is about the ROOM, not the clock: people being in it is
    // what a waiting person actually wants to know.
    started: present.length > 0,
    count: present.length,
    participants,
    waiting,
    waitingCount: waiting.length,
  };
}

async function lobbyAdmit({ meetingId, userId, targetUserId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) throw Object.assign(new Error("Meeting not found."), { status: 404 });
  const isHost = m.createdBy === userId;
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  if (!isHost && role !== "co-host")
    throw Object.assign(new Error("Only host or co-host can admit."), { status: 403 });
  await db.meetings.lobbyAdmit(meetingId, targetUserId, userId);
  return { meetingId, targetUserId, admitted: true };
}

async function lobbyDeny({ meetingId, userId, targetUserId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) throw Object.assign(new Error("Meeting not found."), { status: 404 });
  const isHost = m.createdBy === userId;
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  if (!isHost && role !== "co-host")
    throw Object.assign(new Error("Only host or co-host can deny."), { status: 403 });
  await db.meetings.lobbyDeny(meetingId, targetUserId, userId);
  return { meetingId, targetUserId, denied: true };
}

async function lobbyAdmitAll({ meetingId, userId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) throw Object.assign(new Error("Meeting not found."), { status: 404 });
  const isHost = m.createdBy === userId;
  const role = await db.meetings.getAttendeeRole(meetingId, userId);
  if (!isHost && role !== "co-host")
    throw Object.assign(new Error("Only host or co-host can admit."), { status: 403 });
  await db.meetings.lobbyAdmitAll(meetingId, userId);
  return { meetingId, admittedAll: true };
}

async function promoteCoHost({ meetingId, userId, targetUserId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) throw Object.assign(new Error("Meeting not found."), { status: 404 });
  if (m.createdBy !== userId)
    throw Object.assign(new Error("Only the host can promote co-hosts."), { status: 403 });
  await db.meetings.setAttendeeRole(meetingId, targetUserId, "co-host");
  return { meetingId, targetUserId, role: "co-host" };
}

async function demoteCoHost({ meetingId, userId, targetUserId }: any) {
  const m = await db.meetings.getById(meetingId);
  if (!m) throw Object.assign(new Error("Meeting not found."), { status: 404 });
  if (m.createdBy !== userId)
    throw Object.assign(new Error("Only the host can demote co-hosts."), { status: 403 });
  await db.meetings.setAttendeeRole(meetingId, targetUserId, "participant");
  return { meetingId, targetUserId, role: "participant" };
}


// ── Host Settings modal ─────────────────────────────────────────────────────
// Everything below is for the meeting's CREATOR only. Unlike the options above
// (host or co-host), a co-host gets nothing from these: the host asked for one
// person to hold the keys to who may use camera, screen share and the board.
async function requireCreator(meetingId: string, userId: string) {
  const m = await db.meetings.getById(meetingId);
  if (!m) throw Object.assign(new Error("Meeting not found."), { status: 404, code: "NOT_FOUND" });
  if (m.createdBy !== userId)
    throw Object.assign(new Error("Only the meeting host can change these settings."), {
      status: 403,
      code: "FORBIDDEN",
    });
  return m;
}

const badRequest = (message: string) =>
  Object.assign(new Error(message), { status: 400, code: "BAD_REQUEST" });

// The host's view of current state, for when the modal opens: the meeting-wide
// switches plus everyone who currently carries a per-person restriction.
async function getHostControls({ meetingId, userId }: any) {
  const m = await requireCreator(meetingId, userId);
  const o = policy.optionsOf(m);
  const ids = new Set<string>([...restrictedUserIds(meetingId), ...whiteboardBlockedUserIds(meetingId)]);
  const users: Record<string, any> = {};
  for (const uid of ids) {
    users[uid] = {
      ...restrictionsOf(meetingId, uid),
      whiteboardBlocked: isWhiteboardBlocked(meetingId, uid),
    };
  }
  return {
    meetingId,
    allowCamera: o.allowCamera,
    allowScreenShare: o.allowScreenShare,
    allowWhiteboard: o.hostAllowWhiteboard,
    // The /admin portal's own whiteboard switch. When off, the board is shut
    // down for everyone and the host's switch cannot bring it back.
    whiteboardLockedByAdmin: !o.allowWhiteboard,
    users,
  };
}

// Meeting-wide switches: camera, screen share, whiteboard. Persist first, then
// rewrite the live grants — same order and reasoning as setOptions.
async function setHostSettings({ meetingId, userId, patch }: any) {
  await requireCreator(meetingId, userId);
  const clean: Record<string, boolean> = {};
  for (const [from, to] of [
    ["allowCamera", "allowCamera"],
    ["allowScreenShare", "allowScreenShare"],
    ["allowWhiteboard", "hostAllowWhiteboard"],
  ] as const) {
    const v = (patch || {})[from];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw badRequest(`${from} must be true or false.`);
    clean[to] = v;
  }
  if (!Object.keys(clean).length) throw badRequest("Nothing to change.");
  await db.meetings.setOptions(meetingId, clean);
  const after = await db.meetings.getById(meetingId);
  const touchesMedia = clean.allowCamera !== undefined || clean.allowScreenShare !== undefined;
  // Stop what is running BEFORE rewriting the grants: once a source stops being
  // permitted the SFU drops that track by itself, so a stop issued afterwards
  // finds nothing — and the person's own client is never told, leaving its
  // camera button showing "on". The policy is already persisted above, so
  // nobody can slip a new publish through in the gap.
  const stopped =
    clean.allowCamera === false || clean.allowScreenShare === false
      ? await stopLiveMedia(after, {
          camera: clean.allowCamera === false,
          screen: clean.allowScreenShare === false,
        })
      : { cameraUserIds: [], screenUserIds: [] };
  const applied = touchesMedia ? await repermissionRoom(after) : { updated: 0, missed: 0 };
  return { meetingId, ...policy.optionsOf(after), changed: true, applied, stopped, patch: clean };
}

// Revoking a publish permission does not retroactively end a track that is
// already live (applyPermissions mutes it at the SFU, which blanks it for
// viewers but does not reliably tell the owner's own client). This stops what is
// running NOW and reports who was affected, so the route can tell their clients
// directly. `onlyUserId` = one person; omitted = everyone except the host and
// co-hosts, who no policy applies to.
async function stopLiveMedia(
  meeting: any,
  what: { camera?: boolean; screen?: boolean },
  onlyUserId?: string,
) {
  const room = "meeting_" + meeting.id;
  const cameraUserIds: string[] = [];
  const screenUserIds: string[] = [];
  let targets: string[] = [];
  if (onlyUserId) targets = [onlyUserId];
  else {
    for (const p of (await db.meetings.roomParticipants(meeting.id)) || []) {
      const uid = p.userId || p.id;
      if (!uid || uid === meeting.createdBy) continue;
      const role = await db.meetings.getAttendeeRole(meeting.id, uid).catch(() => null);
      if (role !== "co-host") targets.push(uid);
    }
  }
  await Promise.all(
    targets.map(async (uid) => {
      try {
        if (what.camera) {
          const r: any = await stopCamera(room, uid);
          if (r?.stoppedUserIds?.length) cameraUserIds.push(uid);
        }
        if (what.screen) {
          const r: any = await stopScreenShare(room, uid);
          if (r?.stopped > 0) screenUserIds.push(uid);
        }
      } catch (e: any) {
        console.warn("[meetings] stopLiveMedia failed for", uid, "-", e?.message || e);
      }
    }),
  );
  return { cameraUserIds, screenUserIds };
}

// Per-person switches: camera, screen share, whiteboard. `true` = allowed.
// Refuses the host and co-hosts, who are exempt from every policy by design —
// restricting one would be silently ignored by the grant, which is worse than a
// clear error. (To restrict a co-host, demote them first.)
async function setParticipantPermissions({ meetingId, userId, targetUserId, patch }: any) {
  const m = await requireCreator(meetingId, userId);
  if (!targetUserId) throw badRequest("A participant is required.");
  if (targetUserId === m.createdBy)
    throw badRequest("The host's own permissions cannot be restricted.");
  const role = await db.meetings.getAttendeeRole(meetingId, targetUserId).catch(() => null);
  if (role === "co-host")
    throw badRequest("Co-hosts can't be restricted — remove their co-host role first.");
  const changed: { camera?: boolean; screenShare?: boolean; whiteboard?: boolean } = {};
  for (const k of ["camera", "screenShare", "whiteboard"] as const) {
    const v = (patch || {})[k];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw badRequest(`${k} must be true or false.`);
    changed[k] = v;
  }
  if (!Object.keys(changed).length) throw badRequest("Nothing to change.");
  if (changed.camera !== undefined) setCameraBlocked(meetingId, targetUserId, !changed.camera);
  if (changed.screenShare !== undefined)
    setScreenShareBlocked(meetingId, targetUserId, !changed.screenShare);
  if (changed.whiteboard !== undefined)
    setWhiteboardBlocked(meetingId, targetUserId, !changed.whiteboard);
  const touchesMedia = changed.camera !== undefined || changed.screenShare !== undefined;
  // Stop first, then re-permission — see setHostSettings for why the order matters.
  const stopped = touchesMedia
    ? await stopLiveMedia(
        m,
        { camera: changed.camera === false, screen: changed.screenShare === false },
        targetUserId,
      )
    : { cameraUserIds: [], screenUserIds: [] };
  const applied = touchesMedia
    ? await repermissionRoom(m, targetUserId)
    : { updated: 0, missed: 0 };
  return {
    meetingId,
    userId: targetUserId,
    stopped,
    cameraBlocked: restrictionsOf(meetingId, targetUserId).cameraBlocked,
    screenShareBlocked: restrictionsOf(meetingId, targetUserId).screenShareBlocked,
    whiteboardBlocked: isWhiteboardBlocked(meetingId, targetUserId),
    changed,
    applied,
  };
}

export {
  create,
  listForUser,
  listForUserCalendar,
  generateIcs,
  update,
  remove,
  leave,
  respond,
  enterRoom,
  heartbeatRoom,
  leaveRoom,
  getRoom,
  cancel,
  complete,
  startTemporaryGroup,
  ensureMeetingGroup,
  previewOccurrences,
  toggleLobby,
  getOptions,
  setOptions,
  attendance,
  availability,
  toggleLock,
  expandOccurrences,
  sessionWindow,
  lobbyList,
  roomPreview,
  lobbySelf,
  lobbyAdmit,
  lobbyDeny,
  lobbyAdmitAll,
  promoteCoHost,
  demoteCoHost,
  getHostControls,
  setHostSettings,
  setParticipantPermissions,
};
