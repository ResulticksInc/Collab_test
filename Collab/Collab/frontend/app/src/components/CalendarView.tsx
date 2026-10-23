import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import Avatar from "./Avatar";
import Modal, { Btn, inp } from "./Modal";
import Select from "./ui/Select";
import { copyText } from "../lib/clipboard";
import { IconCalendarPlus, IconClock, IconMapPin, IconAlignLeft, IconRepeat, IconBell, IconVideo, IconChevronLeft, IconChevronRight, IconChevronDown, IconAlertTriangle, IconX, IconCheck, IconPlus, IconCopy, IconLink, IconUserPlus, IconUsers, IconInfo, IconPencil, IconPhoneOff, IconTrash, IconSettings } from "../lib/icons";
import TimeZonePicker from "./TimeZonePicker";
import PublicLinkControl, { type PublicLinkActions } from "./PublicLinkControl";
import { detectTimeZone, tzAbbr, utcToZonedWallTime, zonedWallTimeToUtc } from "../lib/timezones";
import { getTimeZonePref } from "../lib/time";

// Tiny inline conflict marker for event chips/rows — keeps the icon on the text
// baseline inside single-line ellipsized labels.
const ConflictMark = () => (
  <IconAlertTriangle size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} />
);

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const av = (p: any) => ({
  kind: "user",
  initials: p.initials,
  color: p.color,
  avatarUrl: p.avatarUrl,
});

const AV_PALETTE = ["#7C3AED", "#0A0A0F", "#A78BFA", "#10B981", "#F59E0B", "#3B82F6"];
const attAv = (p: any, i: number) => ({
  kind: "user",
  initials:
    p.initials ||
    String(p.name || p.email || "?")
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((x: string) => x[0].toUpperCase())
      .join(""),
  color: p.color || AV_PALETTE[i % AV_PALETTE.length],
  avatarUrl: p.avatarUrl,
});

// One-line description of a meeting's option set, for the collapsed scheduler
// section. Says "Default" only when NOTHING deviates, so a host can tell at a
// glance whether a meeting carries a policy without expanding anything.
function meetingOptionsSummary(o: any): string {
  const bits: string[] = [];
  if (o.lobbyPolicy === "invited") bits.push("lobby for uninvited");
  else if (o.lobbyPolicy === "nobody") bits.push("lobby for everyone");
  if (!o.allowMic) bits.push("no mic");
  if (!o.allowCamera) bits.push("no camera");
  if (!o.allowChat) bits.push("no chat");
  if (!o.allowReactions) bits.push("no reactions");
  if (o.autoRecord) bits.push("auto-record");
  return bits.length ? bits.join(" · ") : "Default";
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${pad(m)} ${ap}`;
}
// #1: now + 5 minutes, as {date,time} strings for the scheduler defaults.
function nowPlus5() {
  const d = new Date(Date.now() + 5 * 60000);
  return { date: keyOf(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
// End-time default: start "HH:MM" + N minutes, clamped to same-day 23:59.
function addMins(hhmm: string, mins: number) {
  const [h, m] = (hhmm || "0:0").split(":").map(Number);
  const t = Math.min((h || 0) * 60 + (m || 0) + mins, 23 * 60 + 59);
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}
// Minutes from one "HH:MM" to another, same day. 0 or negative means the second
// time is not after the first. Returns 0 when either side is missing/unparseable
// so callers can treat "unknown" and "invalid" alike.
function minutesBetween(fromHHMM: string, toHHMM: string) {
  if (!fromHHMM || !toHHMM) return 0;
  const [fh, fm] = fromHHMM.split(":").map(Number);
  const [th, tm] = toHHMM.split(":").map(Number);
  if ([fh, fm, th, tm].some((n) => !Number.isFinite(n))) return 0;
  return th * 60 + tm - (fh * 60 + fm);
}
const RECUR_LABEL: Record<string, string> = {
  daily: "Repeats daily",
  weekly: "Repeats weekly",
  biweekly: "Repeats every 2 weeks",
  monthly: "Repeats monthly",
};
function isRecurringEvent(e: any): boolean {
  return !!(
    e &&
    ((e.recurrence && e.recurrence !== "none") ||
      e.recurrenceRule ||
      e.seriesId ||
      (typeof e.id === "string" && e.id.includes("__occ_")))
  );
}

function computeNextRecurrenceDates(
  startDateStr: string,
  freq: string,
  interval: number,
  byDays: number[],
  recEnds: string = "never",
  recCount: number = 10,
  recUntil: string = "",
  maxDisplay = 5,
): string[] {
  if (!startDateStr || freq === "none") return [];
  const start = new Date(startDateStr + "T00:00:00");
  if (isNaN(start.getTime())) return [];
  
  const untilDate =
    recEnds === "on" && recUntil ? new Date(recUntil + "T23:59:59") : null;
  // If recEnds === "after", total occurrences is recCount (including start date, so max future is recCount - 1)
  const maxOccurrences =
    recEnds === "after" ? Math.max(0, (recCount || 1) - 1) : Infinity;
  const targetCount = Math.min(maxDisplay, maxOccurrences);
  if (targetCount <= 0) return [];

  const results: string[] = [];
  let cur = new Date(start);

  if (freq === "daily") {
    const step = (interval || 1) * 24 * 60 * 60 * 1000;
    for (let i = 0; i < targetCount; i++) {
      cur = new Date(cur.getTime() + step);
      if (untilDate && cur > untilDate) break;
      results.push(
        cur.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
      );
    }
  } else if (freq === "weekly" || freq === "biweekly") {
    const stepWeeks = freq === "biweekly" ? 2 : interval || 1;
    const targetDays = byDays.length ? byDays : [start.getDay()];
    let candidate = new Date(cur);
    let guard = 0;
    while (results.length < targetCount && guard++ < 300) {
      candidate.setDate(candidate.getDate() + 1);
      if (untilDate && candidate > untilDate) break;
      if (targetDays.includes(candidate.getDay())) {
        const diffWeeks = Math.floor(
          (candidate.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000),
        );
        if (diffWeeks % stepWeeks === 0) {
          results.push(
            candidate.toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            }),
          );
        }
      }
    }
  } else if (freq === "monthly") {
    for (let i = 1; i <= targetCount; i++) {
      const d = new Date(start);
      d.setMonth(d.getMonth() + i * (interval || 1));
      if (untilDate && d > untilDate) break;
      results.push(
        d.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
      );
    }
  } else if (freq === "yearly") {
    for (let i = 1; i <= targetCount; i++) {
      const d = new Date(start);
      d.setFullYear(d.getFullYear() + i * (interval || 1));
      if (untilDate && d > untilDate) break;
      results.push(
        d.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
      );
    }
  }
  return results;
}

function cleanId(id: string) {
  return (id || "").split("__occ_")[0];
}
function meetingLink(id: string) {
  const origin =
    (typeof window !== "undefined" && window.location && window.location.origin) ||
    "";
  return `${origin}/?meeting=${cleanId(id)}`;
}
// Parse a pasted meeting LINK or a raw meeting ID down to the bare meeting id.
// Accepts: the app's deep link (?meeting=<id>), any URL carrying ?meeting= or an
// id as its last path segment, or a bare id typed straight in.
function parseMeetingRef(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const q = s.match(/[?&]meeting=([^&\s]+)/i);
  if (q) return decodeURIComponent(q[1]);
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const qp = u.searchParams.get("meeting");
      if (qp) return qp;
      const seg = u.pathname.split("/").filter(Boolean).pop();
      if (seg) return seg;
    } catch { /* ignore */ }
  }
  return s;
}
// A joinable ref must resolve to a real meeting id. Meeting ids are randomUUID()
// (UUID v4), so anything that isn't a UUID — random typed text, or a link whose last
// segment isn't an id — is NOT joinable: Join stays disabled and submit rejects it up
// front, instead of marching the user into a lobby that only errors after a 2nd click.
const MEETING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function durLabel(min: number) {
  if (!min) return "";
  if (min % 60 === 0) return `${min / 60} hour${min > 60 ? "s" : ""}`;
  if (min > 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${min} min`;
}
function endMs(e: any) {
  return new Date(e.startsAt).getTime() + (e.durationMin || 30) * 60000;
}
function meetingState(e: any, now: number) {
  // A cancelled meeting is terminal regardless of the scheduled window. A
  // host-ended one (status "completed") only stopped the live SESSION — its link
  // stays joinable until the scheduled time is exceeded, so it falls through to
  // the clock-based states below and reads "ended" once the window has passed.
  if (e && e.status === "cancelled") return "ended";
  const st = new Date(e.startsAt).getTime();
  const en = endMs(e);
  if (Number.isFinite(st) && now >= st && now < en) return "live";
  if (Number.isFinite(en) && now >= en) return "ended";
  if (Number.isFinite(st) && st - now <= 10 * 60000) return "soon";
  return "upcoming";
}
function packDay(events: any[]) {
  const evs = [...events].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const out: any[] = [];
  let cluster: any[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds: number[] = [];
    const placed = cluster.map((ev) => {
      const st = new Date(ev.startsAt).getTime();
      let li = laneEnds.findIndex((e) => e <= st);
      if (li === -1) {
        li = laneEnds.length;
        laneEnds.push(endMs(ev));
      } else laneEnds[li] = endMs(ev);
      return { ev, lane: li };
    });
    placed.forEach((p) => out.push({ ...p, lanes: laneEnds.length }));
    cluster = [];
    clusterEnd = -1;
  };
  for (const ev of evs) {
    const st = new Date(ev.startsAt).getTime();
    if (cluster.length && st >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, endMs(ev));
  }
  if (cluster.length) flush();
  return out;
}

export default function CalendarView({
  meetings,
  people,
  meId,
  onCreate,
  onJoin,
  onUpdate,
  onInvite,
  onPreviewOccurrences,
  onCheckAvailability,
  onMeetingPreview,
  onDelete,
  onLeave,
  onComplete,
  onToast,
  defaultTitle = "",
  defaultAttendees = [],
  onClearDefaults,
  externalSearch,
  // Deep-link from global search (#33): focus this meeting — jump the grid to its
  // month and open that day's peek so the meeting (with its ID/join link/detail)
  // is right there. Cleared via onOpenedMeeting so re-renders don't force it back.
  openMeetingId = null,
  onOpenedMeeting,
  publicLink,
}: {
  /** Host-gated public (guest) link calls — omit to hide the control. */
  publicLink?: PublicLinkActions;
  onPreviewOccurrences?: any;
  /** Free/busy lookup, injected like every other data call in this component. */
  onCheckAvailability?: (body: any) => Promise<any>;
  /** Live room state for the details dialog (started / who is in it). */
  onMeetingPreview?: (meetingId: string) => Promise<any>;
  meetings?: any[];
  people?: any[];
  meId?: string;
  onCreate?: any;
  onJoin?: any;
  onUpdate?: any;
  onInvite?: (meetingId: string, userId: string) => Promise<void>;
  onDelete?: any;
  onLeave?: any;
  onComplete?: any;
  onToast?: any;
  defaultTitle?: string;
  defaultAttendees?: string[];
  onClearDefaults?: () => void;
  externalSearch?: string;
  openMeetingId?: string | null;
  onOpenedMeeting?: () => void;
}) {
  const [viewDate, setViewDate] = useState(() => new Date());
  const [sched, setSched] = useState<any>(null); // { date } when open
  const [editing, setEditing] = useState<any>(null);
  const [invitingMeeting, setInvitingMeeting] = useState<any>(null);
  const [infoMeetingId, setInfoMeetingId] = useState<string | null>(null);
  // Clicking a meeting anywhere in the calendar opens its DETAILS — the agenda,
  // where, who, the link — with Join and Leave right there. It used to drop
  // straight into the edit form, which answered none of those questions and, for
  // a meeting you don't own, offered a form you can't save.
  const [details, setDetails] = useState<any>(null);
  // Live room state for the open details dialog (started / count / who).
  const [detailsLive, setDetailsLive] = useState<any>(null);
  const [addMemberQuery, setAddMemberQuery] = useState("");
  const [addMemberSelected, setAddMemberSelected] = useState<string[]>([]);
  const [addMemberSubmitting, setAddMemberSubmitting] = useState(false);
  const [title, setTitle] = useState("");
  // Agenda / where (0118). A meeting could previously only say its title, so an
  // invite read "Weekly sync" and nothing else.
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  // Optional guests (0122) — ids within `sel` that are "come if it's useful"
  // rather than "you need to be there".
  const [optionalIds, setOptionalIds] = useState<string[]>([]);
  // Free/busy for the chosen window. null means "not known yet" — the UI must
  // not claim everyone is free until it has actually checked.
  const [busy, setBusy] = useState<any[] | null>(null);
  // Recurrence lives behind a chip: the common case ("doesn't repeat") costs one
  // line, and the full builder is one click away rather than removed.
  const [recOpen, setRecOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  // The zone the times above are TYPED IN — not a display label. Changing it
  // moves the meeting (12:30 SGT is a different instant from 12:30 IST), which
  // is why every startsAt below is built through zonedWallTimeToUtc rather than
  // `new Date("<date>T<time>")` (that reads the string in the BROWSER's zone).
  // Defaulted from the device's own zone, and from the meeting's stored zone
  // when editing one that was created elsewhere.
  const [tz, setTz] = useState<string>("");
  // End time — the host decides when the meeting ends (duration = end − start).
  const [endTime, setEndTime] = useState("");
  // Guards a double-submit (double-click / slow network) creating two meetings.
  const [submitting, setSubmitting] = useState(false);
  const [sel, setSel] = useState<any[]>([]);
  const [recurrence, setRecurrence] = useState("none");
  // Meeting-invite search dropdown (replaces the crowded always-on people list).
  const [inviteQuery, setInviteQuery] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  // Outlook-style recurrence detail (shown when Frequency is not "none").
  const [recInterval, setRecInterval] = useState(1);
  const [recDays, setRecDays] = useState<number[]>([]); // weekly: 0=Sun..6=Sat
  const [recMonthly, setRecMonthly] = useState<"day" | "weekday">("day");
  const [recEnds, setRecEnds] = useState<"never" | "after" | "on">("never");
  const [recCount, setRecCount] = useState(10);
  const [recUntil, setRecUntil] = useState("");
  // MEETING-REMINDER SCHEDULER (#53): minutes before start to notify attendees.
  // 0 = no reminder. Reuses the reminder firing/notify path server-side.
  const [reminderLead, setReminderLead] = useState(0);
  // PER-MEETING OPTIONS (0116). Set at schedule time so the host decides the
  // policy BEFORE anyone arrives, rather than only from inside a live meeting.
  // Defaults match the server's column defaults exactly, so leaving this section
  // untouched creates precisely the meeting it would have created before.
  const MEETING_OPTION_DEFAULTS = {
    lobbyPolicy: "everyone",
    allowMic: true,
    allowCamera: true,
    allowChat: true,
    allowReactions: true,
    autoRecord: false,
  };
  const [mOpts, setMOpts] = useState<any>({ ...MEETING_OPTION_DEFAULTS });
  // Collapsed by default: the overwhelming majority of meetings want the
  // defaults, and an eight-control block above "Invite people" would bury the
  // fields people actually fill in every time.
  const [optsOpen, setOptsOpen] = useState(false);
  // CNCL-02: Cancel confirmation modal with optional note for attendees.
  const [cancelModalMeeting, setCancelModalMeeting] = useState<any | null>(null);
  // CNCL-01: cancel scope for recurring meetings — occurrence (default) or series.
  const [cancelScope, setCancelScope] = useState<"occurrence" | "series">("occurrence");

  const [cancelNote, setCancelNote] = useState("");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  // RSCH-02 / RCR-20: Recurring meeting scope prompt ("this occurrence" vs "all events").
  const [recurringScopeModal, setRecurringScopeModal] = useState<{
    ev: any;
    targetIso?: string;
    payload?: any;
    displayNext?: string;
  } | null>(null);

  const [created, setCreated] = useState<any>(null); // just-created meeting → show ID + link
  const [err, setErr] = useState("");
  const [dayPeek, setDayPeek] = useState<any>(null);
  const [calView, setCalView] = useState("month");
  const [showSidebar, setShowSidebar] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth > 1024) {
      setShowSidebar(true);
    }
  }, []);
  const [secLim, setSecLim] = useState<Record<string, number>>({
    today: 5,
    week: 5,
    later: 5,
    past: 5,
  });
  const draggingRef = useRef<any>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const openedRef = useRef(false);
  // Global 'Calendar' search scope: filter the upcoming/past lists by title.
  const [gxq, setGxq] = useState("");
  useEffect(() => {
    setGxq(externalSearch || "");
  }, [externalSearch]);

  // AUDIT #33: deep-link to a searched meeting — jump the month grid to its date
  // and open that day's peek (which lists the meeting with its detail/ID/join
  // link). Then clear the request so closing the peek isn't undone by a re-render.
  useEffect(() => {
    if (!openMeetingId) return;
    const mt = (meetings || []).find((x: any) => x && x.id === openMeetingId);
    if (mt && mt.startsAt) {
      const d = new Date(mt.startsAt);
      const k = keyOf(d);
      setViewDate(d);
      const evs = (meetings || []).filter(
        (x: any) => x.startsAt && keyOf(new Date(x.startsAt)) === k,
      );
      setDayPeek({ date: k, events: evs });
    }
    if (onOpenedMeeting) onOpenedMeeting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMeetingId, meetings]);

  useEffect(() => {
    if (defaultTitle == null) return;
    // Open the scheduler once when a prefill arrives and nothing is open yet.
    if (!openedRef.current && !sched) {
      openedRef.current = true;
      openSched(todayKey, defaultTitle);
    }
    // ALWAYS consume the prefill — even when we DON'T open (a prefill that
    // arrives while the modal is already open used to stay uncleared, so every
    // subsequent close() re-fired this effect and re-popped the scheduler: the
    // "popup keeps opening" bug). Clearing it unconditionally breaks that loop.
    if (onClearDefaults) onClearDefaults();
  }, [defaultTitle, sched]);
  // Drag-to-reschedule: drop an event on a day to move it (keeps the time of
  // day). Only the host can move a meeting (server PATCH is host-gated); moving
  // into the past is blocked client-side to match the DB guard.
  const applyReschedule = (ev: any, next: Date, scope?: "single" | "series") => {
    const editId = scope === "single" ? ev.id : cleanId(ev.meetingId || ev.seriesId || ev.id);
    onUpdate(editId, { startsAt: next.toISOString() });
    onToast &&
      onToast(
        "Moved to " +
          next.toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
      );
  };

  const rescheduleTo = (ev: any, target: any) => {
    setDragOverKey(null);
    if (!ev) return;
    const old = new Date(ev.startsAt);
    const next = new Date(target);
    next.setHours(old.getHours(), old.getMinutes(), 0, 0);
    if (next.getTime() === old.getTime()) return;
    if (next.getTime() < Date.now() - 120000) {
      onToast && onToast("Can't move a meeting to the past.");
      return;
    }
    if (isRecurringEvent(ev)) {
      setRecurringScopeModal({
        ev,
        targetIso: next.toISOString(),
        displayNext: next.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      });
      return;
    }
    applyReschedule(ev, next);
  };
  const rescheduleAt = (ev: any, dayKey: string, hour: number) => {
    setDragOverKey(null);
    if (!ev) return;
    const old = new Date(ev.startsAt);
    const next = new Date(dayKey + "T00:00:00");
    next.setHours(hour, old.getMinutes(), 0, 0);
    if (next.getTime() === old.getTime()) return;
    if (next.getTime() < Date.now() - 120000) {
      onToast && onToast("Can't move a meeting to the past.");
      return;
    }
    if (isRecurringEvent(ev)) {
      setRecurringScopeModal({
        ev,
        targetIso: next.toISOString(),
        displayNext: next.toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      });
      return;
    }
    applyReschedule(ev, next);
  };

  const y = viewDate.getFullYear();
  const m = viewDate.getMonth();
  const todayKey = keyOf(new Date());

  const byDate: Record<string, any[]> = {};
  for (const mt of meetings || []) {
    if (!mt.startsAt) continue;
    const k = keyOf(new Date(mt.startsAt));
    (byDate[k] = byDate[k] || []).push(mt);
  }

  const now = Date.now();
  const involved = (meetings || []).filter(
    (e) =>
      e.startsAt &&
      (e.mine || (e.attendees || []).some((a) => a.id === meId)) &&
      // A meeting that's over no longer occupies its slot, so it can't conflict
      // with anything: exclude the terminal ones — the scheduled window elapsed
      // or the host cancelled it. meetingState() folds both into "ended".
      meetingState(e, now) !== "ended",
  );
  const conflicts = new Set<string>();
  const cs = [...involved].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      if (new Date(cs[j].startsAt).getTime() >= endMs(cs[i])) break;
      conflicts.add(cs[i].id);
      conflicts.add(cs[j].id);
    }
  }

  const weekStart = new Date(viewDate);
  weekStart.setDate(viewDate.getDate() - viewDate.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });
  const weekEnd = weekDays[6];
  const dayDate = new Date(viewDate);
  dayDate.setHours(0, 0, 0, 0);
  const label =
    calView === "month"
      ? `${MONTHS[m]} ${y}`
      : calView === "day"
        ? viewDate.toLocaleDateString([], {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })
        : weekStart.getMonth() === weekEnd.getMonth()
          ? `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()}–${weekEnd.getDate()}, ${weekStart.getFullYear()}`
          : `${MONTHS[weekStart.getMonth()]} ${weekStart.getDate()} – ${MONTHS[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;

  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const cells: React.ReactNode[] = [];
  // Fewer chips per day when the Upcoming panel narrows the grid, so cells stay airy.
  const maxPills = showSidebar ? 2 : 3;
  for (let i = first - 1; i >= 0; i--)
    cells.push(
      <div key={`p${i}`} className="cal-cell om is-past">
        <div className="cal-dt">{prevDays - i}</div>
      </div>,
    );
  for (let d = 1; d <= days; d++) {
    const k = `${y}-${pad(m + 1)}-${pad(d)}`;
    const isPast = k < todayKey;
    const evs = (byDate[k] || []).sort((a, b) =>
      a.startsAt.localeCompare(b.startsAt),
    );
    cells.push(
      <div
        key={k}
        className={
          "cal-cell" +
          (isPast ? " is-past" : "") +
          (k === todayKey ? " today" : "") +
          (dragOverKey === k ? " drag-over" : "")
        }
        onClick={() => {
          if (isPast) return;
          openSched(k);
        }}
        onDragOver={(ev) => {
          if (isPast) return;
          ev.preventDefault();
          setDragOverKey(k);
        }}
        onDragLeave={() => setDragOverKey((cur) => (cur === k ? null : cur))}
        onDrop={(ev) => {
          if (isPast) return;
          ev.preventDefault();
          rescheduleTo(draggingRef.current, new Date(y, m, d));
          draggingRef.current = null;
        }}
      >
        <div className="cal-dt-row">
          <div className="cal-dt">{d}</div>
          <div className="cal-dt-meta">
            {evs.some((e) => conflicts.has(e.id)) ? (
              <span className="cal-cdot" title="Time conflict" />
            ) : null}
            {evs.length > 1 ? <span className="cal-cnt">{evs.length}•</span> : null}
          </div>
        </div>
        {evs.slice(0, maxPills).map((e) => {
          const st = meetingState(e, now);
          return (
            <div
              key={e.id}
              className={
                "cal-ev st-" +
                st +
                (conflicts.has(e.id) ? " conflict" : "") +
                (e.mine ? " draggable" : "")
              }
              draggable={!isPast && !!e.mine}
              onDragStart={(ev) => {
                ev.stopPropagation();
                draggingRef.current = e;
              }}
              onDragEnd={() => {
                draggingRef.current = null;
                setDragOverKey(null);
              }}
              title={
                conflicts.has(e.id)
                  ? "Overlaps another meeting you're in"
                  : e.mine
                    ? "Drag to reschedule · click to edit"
                    : e.title
              }
              onClick={(ev) => {
                ev.stopPropagation();
                openMeeting(e);
              }}
            >
              {conflicts.has(e.id) ? <ConflictMark /> : null}
              <span className="cal-ev-t">{e.title}</span>
              <span className="cal-ev-time">
                {fmtTime(e.startsAt)} - {fmtTime(new Date(endMs(e)).toISOString())}
              </span>
            </div>
          );
        })}
        {evs.length > maxPills ? (
          <div
            className="cal-more"
            onClick={(ev) => {
              ev.stopPropagation();
              setDayPeek({ date: k, events: evs });
            }}
          >
            +{evs.length - maxPills} more
          </div>
        ) : null}
      </div>,
    );
  }
  const rem = (first + days) % 7;
  if (rem)
    for (let d = 1; d <= 7 - rem; d++)
      cells.push(
        <div key={`n${d}`} className="cal-cell om">
          <div className="cal-dt">{d}</div>
        </div>,
      );

  const upcoming = (meetings || [])
    .filter((e) => e.startsAt && new Date(e.startsAt).getTime() >= now - 36e5)
    .filter((e) => {
      const s = gxq.trim().toLowerCase();
      return !s || ((e.title || e.subject || "") + "").toLowerCase().includes(s);
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayEndMs = startOfToday.getTime() + 86400000;
  const weekEndMs = startOfToday.getTime() + 7 * 86400000;
  // Past meetings — the exact complement of `upcoming` (started > 1h ago), most
  // recent first. Keeps ENDED meetings (and their details/attendees/ID) reachable
  // from the calendar instead of vanishing once they're over. Capped so the list
  // stays manageable; the section is collapsed behind "Show more" like the others.
  const past = (meetings || [])
    .filter((e) => e.startsAt && new Date(e.startsAt).getTime() < now - 36e5)
    .filter((e) => {
      const s = gxq.trim().toLowerCase();
      return !s || ((e.title || e.subject || "") + "").toLowerCase().includes(s);
    })
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))
    .slice(0, 50);
  const nextId = (upcoming.find((x: any) => meetingState(x, now) !== "ended") || ({} as any)).id;
  const sections: { key: string; label: string; items: any[] }[] = [
    { key: "today", label: "Today", items: [] },
    { key: "week", label: "This Week", items: [] },
    { key: "later", label: "Later", items: [] },
    { key: "past", label: "Past", items: past },
  ];
  for (const e of upcoming) {
    const t = new Date(e.startsAt).getTime();
    if (t < todayEndMs) sections[0].items.push(e);
    else if (t < weekEndMs) sections[1].items.push(e);
    else sections[2].items.push(e);
  }

  function openSched(k?: string, prefillTitle?: string) {
    if (k && k < todayKey) return; // Only enable current and future dates
    setEditing(null);
    setCreated(null);
    setTitle(prefillTitle || defaultTitle || "");
    const np = nowPlus5();
    const day = k || np.date;
    setDate(day);
    if (day === todayKey) {
      setTime(np.time);
      setEndTime(addMins(np.time, 30));
    } else {
      setTime("09:00");
      setEndTime("09:30");
    }
    setRecurrence("none");
    setRecInterval(1); setRecDays([]); setRecMonthly("day"); setRecEnds("never"); setRecCount(10); setRecUntil("");
    setSel(defaultAttendees ? [...defaultAttendees] : []);
    setInviteQuery("");
    setInviteOpen(false);
    // Auto-detected, not asked for. An explicit choice in Settings › Language &
    // Region wins (a traveller who pinned their home zone means it); otherwise
    // the device's own zone, which is what the slot the host just clicked was
    // drawn in.
    setTz(getTimeZonePref() || detectTimeZone());
    setErr("");
    setSched({ date: day });
    if (onClearDefaults && (defaultTitle || defaultAttendees?.length)) {
      onClearDefaults();
    }
  }
  // Opening the details dialog. The event object the calendar already holds has
  // everything except the LIVE room state, which is fetched (and refreshed while
  // the dialog is open, because "3 people are in it right now" goes stale fast).
  function openDetails(e: any) {
    setDetails(e);
    setDetailsLive(null);
  }
  // Clicking a meeting. The organiser lands straight in the SAME popup used to
  // create it, pre-filled and editable (title, timings, guests, options) — no
  // read-only stop in between. Everyone else, and any meeting that is already
  // over or cancelled, gets the details dialog: there is nothing they can edit.
  function openMeeting(e: any) {
    if (e && e.mine && meetingState(e, Date.now()) !== "ended") openEdit(e);
    else openDetails(e);
  }

  useEffect(() => {
    if (!details || !onMeetingPreview) return;
    const id = cleanId(details.meetingId || details.id);
    if (!id) return;
    let live = true;
    const tick = () => {
      onMeetingPreview(id)
        .then((p: any) => live && setDetailsLive(p || null))
        .catch(() => {});
    };
    tick();
    const iv = setInterval(tick, 10000);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [details, onMeetingPreview]);

  function openEdit(e: any) {
    const d = new Date(e.seriesStartsAt || e.startsAt);
    // A meeting is edited in the zone it was CREATED in, the way every calendar
    // does it — otherwise a host in Chennai opening a Singapore meeting would
    // see "10:00" beside an SGT pill and be reading a lie. Falls back to this
    // device's zone for meetings saved before the zone was captured.
    const evTz = (e && e.timezone) || getTimeZonePref() || detectTimeZone();
    setTz(evTz);
    const wall = utcToZonedWallTime(d, evTz);
    setEditing(e);
    setCreated(null);
    setRecurrence(e.recurrence || "none");
    {
      const rr = e.recurrenceRule || {};
      setRecInterval(rr.interval || 1);
      setRecDays(Array.isArray(rr.byWeekday) ? rr.byWeekday : []);
      setRecMonthly(rr.monthlyMode === "weekday" ? "weekday" : "day");
      setRecEnds(rr.end && rr.end.type === "after" ? "after" : rr.end && rr.end.type === "on" ? "on" : "never");
      setRecCount((rr.end && rr.end.count) || 10);
      setRecUntil((rr.end && rr.end.date) || "");
    }
    setReminderLead(Number(e.reminderLeadMin) || 0);
    setMOpts({ ...MEETING_OPTION_DEFAULTS, ...(e.options || {}) });
    setOptsOpen(false);
    setDescription(e.description || "");
    setLocation(e.location || "");
    setOptionalIds(((e.attendees || []) as any[]).filter((a: any) => a.optional).map((a: any) => a.id));
    setRecOpen(false);
    setBusy(null);
    setTitle(e.title);
    setDate(wall.date);
    setTime(wall.time);
    setEndTime(addMins(wall.time, e.durationMin || 30));
    setSel(
      (e.attendees || []).map((a) => a.id).filter((id) => id && id !== meId),
    );
    setErr("");
    setSched({ date: wall.date });
  }
  function close() {
    setSched(null);
    setEditing(null);
    setCreated(null);
    setEndTime("");
    setSubmitting(false);
    setRecurrence("none");
    setRecInterval(1); setRecDays([]); setRecMonthly("day"); setRecEnds("never"); setRecCount(10); setRecUntil("");
    setReminderLead(0);
    setMOpts({ ...MEETING_OPTION_DEFAULTS });
    setOptsOpen(false);
    setDescription("");
    setLocation("");
    setOptionalIds([]);
    setRecOpen(false);
    setBusy(null);
    setTz("");
    setInviteQuery("");
    setInviteOpen(false);
  }
  function shift(dir: number) {
    if (calView === "month") setViewDate(new Date(y, m + dir, 1));
    else {
      const d = new Date(viewDate);
      d.setDate(viewDate.getDate() + dir * (calView === "week" ? 7 : 1));
      setViewDate(d);
    }
  }
  function openSchedAt(k: string, hour: number) {
    if (k < todayKey) return; // Only enable current date and future dates
    const nowD = new Date();
    const isToday = k === todayKey;
    const isPastHour = isToday && (hour < nowD.getHours() || (hour === nowD.getHours() && nowD.getMinutes() >= 55));

    setEditing(null);
    setCreated(null);
    setRecurrence("none");
    setRecInterval(1); setRecDays([]); setRecMonthly("day"); setRecEnds("never"); setRecCount(10); setRecUntil("");
    setReminderLead(0);
    setMOpts({ ...MEETING_OPTION_DEFAULTS });
    setOptsOpen(false);
    setDescription("");
    setLocation("");
    setOptionalIds([]);
    setRecOpen(false);
    setBusy(null);
    setTitle("");
    setSel([]);
    setErr("");
    setDate(k);

    if (isPastHour) {
      const np = nowPlus5();
      setTime(np.time);
      setEndTime(addMins(np.time, 30));
    } else {
      const slotTime = `${pad(hour)}:00`;
      setTime(slotTime);
      setEndTime(addMins(slotTime, 30));
    }
    setSched({ date: k });
  }
  // ── Scheduler helpers ─────────────────────────────────────────────────────
  // The instant a wall-clock date+time in the chosen zone actually refers to.
  // Every place that turns the form into a timestamp goes through this, so the
  // zone picker can never be a decorative label that disagrees with what is
  // saved.
  const startsAtISO = (d: string = date, t: string = time) => {
    const at = zonedWallTimeToUtc(d, t, tz);
    return Number.isFinite(at.getTime()) ? at.toISOString() : "";
  };

  // The agenda starts five lines tall and grows with what is typed, so pasting
  // a real agenda doesn't leave the host scrolling a two-line slot. Capped (see
  // .sm-desc-in) so a pasted document scrolls inside the field instead of
  // pushing the buttons off the dialog.
  const descRef = useRef<HTMLTextAreaElement>(null);
  const autoGrowDesc = () => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  };
  // Runs for programmatic changes too (opening an existing meeting's agenda),
  // not just keystrokes.
  useEffect(autoGrowDesc, [description, sched, created]);

  // Meeting options moved behind a gear in the footer. `optsDirty` is what puts
  // the dot on it — a host must be able to tell a meeting carries a non-default
  // policy without opening the panel to look.
  const optsRef = useRef<HTMLDivElement>(null);
  const optsDirty = Object.entries(mOpts).some(
    ([k, v]) => (MEETING_OPTION_DEFAULTS as any)[k] !== v,
  );
  // Opening from the footer must actually SHOW the panel — it renders at the
  // bottom of a body that is usually scrolled up.
  useEffect(() => {
    if (!optsOpen) return;
    const id = setTimeout(
      () => optsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
      0,
    );
    return () => clearTimeout(id);
  }, [optsOpen]);

  // Duration is expressed as an END TIME on the wire; the chips just set one.
  // Derived rather than stored, so a typed end time and a chip can never
  // disagree about which is authoritative.
  const setDurationMins = (mins: number) => {
    const [h, m] = (time || "00:00").split(":").map(Number);
    const t = new Date(2000, 0, 1, h || 0, m || 0);
    t.setMinutes(t.getMinutes() + mins);
    setEndTime(
      String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0"),
    );
  };

  const recurrenceChipLabel = (r: string) =>
    ({ daily: "Daily", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly", yearly: "Yearly" } as any)[r] ||
    "Repeats";

  // Footer summary: "Sat 5 Sep · 12:30–13:00 · 3 guests". Recomputed on render
  // so it can never disagree with the fields above it.
  const scheduleSummary = () => {
    if (!date || !time) return "";
    const d = new Date(date + "T" + time);
    const when = Number.isFinite(d.getTime())
      ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
      : date;
    const bits = [when];
    if (endTime && minutesBetween(time, endTime) > 0)
      bits.push(time + "–" + endTime + (tz ? " " + tzAbbr(tz) : ""));
    if (sel.length) bits.push(sel.length + (sel.length === 1 ? " guest" : " guests"));
    return bits.join(" · ");
  };

  // "Your day so far" — the scheduler's right-hand column. An hour-by-hour
  // strip of the chosen day showing the meetings already on it plus the one
  // being scheduled (highlighted), so a clash is visible while the time is
  // still being picked. Hours run 08:00–18:00 and stretch to cover anything
  // outside that window.
  const SM_HOUR_H = 84;
  const smDayRef = useRef<HTMLDivElement>(null);
  const smDay = (() => {
    const toMin = (hhmm: string) => {
      const [h, m] = (hhmm || "").split(":").map(Number);
      return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
    };
    const hm = (mins: number) => pad(Math.floor(mins / 60) % 24) + ":" + pad(mins % 60);
    const others = (meetings || [])
      .filter((x: any) => x && x.startsAt && keyOf(new Date(x.startsAt)) === date)
      .filter((x: any) => !editing || x.id !== editing.id)
      .map((x: any) => {
        const d = new Date(x.startsAt);
        const st = d.getHours() * 60 + d.getMinutes();
        const dur = Number(x.durationMin) > 0 ? Number(x.durationMin) : 30;
        return { id: String(x.id), title: String(x.title || "Meeting"), start: st, end: st + dur, mine: false };
      })
      .sort((a: any, b: any) => a.start - b.start);
    const ns = toMin(time);
    const ne = toMin(endTime);
    const cur =
      Number.isFinite(ns) && Number.isFinite(ne) && ne > ns
        ? {
            id: "__new",
            title: title.trim() || (editing ? "This meeting" : "New meeting"),
            start: ns,
            end: ne,
            mine: true,
          }
        : null;
    const events = cur ? [...others, cur] : others;
    let h0 = 8;
    let h1 = 18;
    for (const e of events) {
      h0 = Math.min(h0, Math.floor(e.start / 60));
      h1 = Math.max(h1, Math.ceil(e.end / 60));
    }
    h1 = Math.min(h1, 24);
    const hours: number[] = [];
    for (let h = h0; h <= h1; h++) hours.push(h);
    const d = date ? new Date(date + "T00:00") : null;
    const dow =
      d && Number.isFinite(d.getTime())
        ? d.toLocaleDateString(undefined, { weekday: "long" })
        : "";
    return { hours, h0, events, cur, hm, dow };
  })();

  // Keep the meeting being scheduled in view as its time changes.
  useEffect(() => {
    if (!sched || created) return;
    const el = smDayRef.current;
    if (!el || !smDay.cur) return;
    const top = ((smDay.cur.start - smDay.h0 * 60) / 60) * SM_HOUR_H;
    el.scrollTop = Math.max(0, top - 110);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sched, created, date, time]);

  const renderDayPanel = () => (
    <aside className="sm-day" aria-label="Your day so far">
      <div className="sm-day-head">
        <div className="sm-day-dow">{smDay.dow}</div>
        <div className="sm-day-h">Your day so far</div>
      </div>
      <div className="sm-day-scroll" ref={smDayRef}>
      <div
        className="sm-day-tl"
        style={{ height: (smDay.hours.length - 1) * SM_HOUR_H + 24 }}
      >
        {smDay.hours.map((h, i) => (
          <div className="sm-day-hour" key={h} style={{ top: i * SM_HOUR_H }}>
            <span className="sm-day-hour-lbl">{pad(h)}:00</span>
          </div>
        ))}
        {smDay.events.map((e) => {
          const top = ((e.start - smDay.h0 * 60) / 60) * SM_HOUR_H + 16;
          const height = Math.max(46, ((e.end - e.start) / 60) * SM_HOUR_H - 6);
          return (
            <div
              key={e.id}
              className={"sm-day-ev" + (e.mine ? " new" : "")}
              style={{ top, height }}
              title={e.title + " · " + smDay.hm(e.start) + "–" + smDay.hm(e.end)}
            >
              <div className="sm-day-ev-t">{e.title}</div>
              <div className="sm-day-ev-when">
                {smDay.hm(e.start)}–{smDay.hm(e.end)}
              </div>
            </div>
          );
        })}
      </div>
      </div>
    </aside>
  );

  // Who already has something in this window. Debounced — it re-runs on every
  // keystroke in the time fields. Availability is an ASSIST, not a gate: if the
  // check fails the host can still schedule, they just get no hint.
  useEffect(() => {
    if (!sched || created || !onCheckAvailability) return;
    const mins = minutesBetween(time, endTime);
    if (!sel.length || !date || !time || mins <= 0) {
      setBusy(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      onCheckAvailability({
        userIds: sel,
        startsAt: startsAtISO(),
        durationMin: mins,
        excludeMeetingId: editing
          ? String(editing.meetingId || editing.seriesId || editing.id || "").split("__occ_")[0]
          : null,
      })
        .then((r: any) => alive && setBusy((r && r.busy) || []))
        .catch(() => alive && setBusy(null));
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [sched, created, sel, date, time, endTime, tz, onCheckAvailability, editing]);

  async function submit() {
    if (submitting) return; // in-flight — ignore double-clicks (no dupe meetings)
    if (!title.trim() || !date || !time) return;
    // People are mandatory: a meeting with nobody invited has no one to send
    // the invite to, so it must not be created (or edited down to zero guests).
    if (!sel.length) {
      setErr("Add at least one person to the meeting.");
      return;
    }
    const startMs = zonedWallTimeToUtc(date, time, tz).getTime();
    // Editing a meeting that has ALREADY started (to extend it, rename it, add a
    // guest) keeps its original start — only a CHANGED start must be in the future.
    const startUntouched =
      !!editing &&
      Math.abs(startMs - new Date(editing.seriesStartsAt || editing.startsAt).getTime()) < 60000;
    if (!Number.isFinite(startMs) || (startMs <= Date.now() && !startUntouched)) {
      setErr("Meeting start time must be in the future.");
      return;
    }
    // End time decides the duration (host sets when the meeting ends).
    if (!endTime) {
      setErr("Please set an end time.");
      return;
    }
    const endMsVal = zonedWallTimeToUtc(date, endTime, tz).getTime();
    const durationMin = Math.round((endMsVal - startMs) / 60000);
    if (!Number.isFinite(endMsVal) || durationMin <= 0) {
      setErr("Meeting end time must be after the start time.");
      return;
    }
    setErr("");
    const recurrenceRule = buildRecurrenceRule();
    const payload = {
      title: title.trim(),
      startsAt: new Date(startMs).toISOString(),
      durationMin, // derived from the end time
      // The zone the host typed those times in. The server persists it (0082)
      // and expands recurrences against it, so a weekly 09:00 IST stays 09:00
      // IST across a DST change anywhere else in the world.
      timeZone: tz || undefined,
      attendees: sel,
      recurrence,
      recurrenceRule,
      // MEETING-REMINDER SCHEDULER (#53): lead in minutes (0 = no reminder).
      reminderLeadMin: reminderLead || null,
      // Agenda / where (0118). Always sent — an empty string CLEARS the field,
      // which is how a host deletes an agenda they no longer want.
      description: description.trim(),
      location: location.trim(),
      // Optional guests (0122): a subset of `attendees`, so the server keeps one
      // attendee set rather than two lists that could disagree.
      optionalAttendees: optionalIds.filter((id) => sel.includes(id)),
      // Only send options that DIFFER from the defaults, so an untouched
      // section sends nothing and the server's defaults stand.
      options: Object.fromEntries(
        Object.entries(mOpts).filter(
          ([k, v]) => (MEETING_OPTION_DEFAULTS as any)[k] !== v,
        ),
      ),
    };
    if (editing && isRecurringEvent(editing)) {
      setRecurringScopeModal({ ev: editing, payload });
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        const editId = (editing.meetingId || editing.seriesId || editing.id || "").split("__occ_")[0];
        await onUpdate(editId, payload);
      } else {
        await onCreate(payload);
      }
      close();
      if (onToast) onToast(editing ? "Meeting updated" : "Meeting scheduled");
    } catch (e: any) {
      setErr((e && e.message) || "Couldn't save the meeting. Please try again.");
      setSubmitting(false);
    }
  }
  const attendees = (people || []).filter((p) => p.id !== meId);
  const availablePeopleToAdd = attendees.filter((p: any) => {
    const q = addMemberQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      (p.name || "").toLowerCase().includes(q) ||
      (p.email || "").toLowerCase().includes(q) ||
      (p.title || "").toLowerCase().includes(q)
    );
  });
  const handleAddMembers = async () => {
    if (!invitingMeeting || !addMemberSelected.length || addMemberSubmitting) return;
    setAddMemberSubmitting(true);
    try {
      const targetId = cleanId(invitingMeeting.meetingId || invitingMeeting.id);
      for (const uid of addMemberSelected) {
        if (onInvite) {
          await onInvite(targetId, uid);
        }
      }
      onToast &&
        onToast(
          `Invited ${addMemberSelected.length} member${
            addMemberSelected.length > 1 ? "s" : ""
          } to ${invitingMeeting.title}`,
        );
      setInvitingMeeting(null);
      setAddMemberQuery("");
      setAddMemberSelected([]);
    } catch (err: any) {
      onToast && onToast(err?.message || "Failed to add member");
    } finally {
      setAddMemberSubmitting(false);
    }
  };
  const cardIconBtn: React.CSSProperties = {
    flex: 1,
    height: 32,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    border: "1px solid var(--g200)",
    background: "var(--sb)",
    color: "var(--g700)",
    cursor: "pointer",
    padding: 0,
    transition: "all 0.15s ease",
  };
  const copyMeetingLink = (id: string) => {
    try {
      copyText(meetingLink(id));
    } catch (_) {}
    onToast && onToast("Meeting link copied");
  };
  const renderParticipants = (e: any) => {
    const atts = e.attendees || [];
    return (
      <div className="mc-participants-block" onClick={(ev) => ev.stopPropagation()}>
        <div className="mc-p-hdr">
          <div className="mc-p-hdr-title">
            <IconUsers size={12} style={{ opacity: 0.7 }} />
            <span>Participants ({atts.length})</span>
          </div>
          <button
            type="button"
            className="mc-p-close"
            onClick={(ev) => {
              ev.stopPropagation();
              setInfoMeetingId(null);
            }}
            title="Close"
            aria-label="Close"
          >
            <IconX size={11} />
          </button>
        </div>
        {atts.length > 0 ? (
          <div className="mc-p-list">
            {atts.map((p: any) => {
              const isHost = p.role === "host" || p.id === e.hostId;
              const isAccepted = p.status === "accepted";
              const isDeclined = p.status === "declined";
              return (
                <div
                  key={p.id || p.userId}
                  className="mc-p-chip"
                  title={`${p.name || p.email || "Participant"} (${isHost ? "Host" : p.status || "Invited"})`}
                >
                  <Avatar avatar={av(p)} size={18} />
                  <span className="mc-p-name">{p.name || p.email || "User"}</span>
                  <span className={"mc-p-tag " + (isHost ? "host" : isAccepted ? "accepted" : isDeclined ? "declined" : "invited")}>
                    {isHost ? "Host" : isAccepted ? "Accepted" : isDeclined ? "Declined" : "Invited"}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "var(--g500)", fontStyle: "italic", padding: "2px 0" }}>
            No participants invited
          </div>
        )}
      </div>
    );
  };
  const lblStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--g500)",
  };
  const copyMeetingId = (id: string) => {
    try {
      copyText(id);
    } catch (_) {}
    onToast && onToast("Meeting ID copied");
  };
  // A recessed value pill with a copy button — used for the Meeting ID + link.
  const copyFieldRow: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 5,
    padding: "6px 6px 6px 12px",
    border: "1px solid var(--g200)",
    borderRadius: 9,
    background: "var(--g50)",
  };
  const copyFieldVal: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    fontSize: 12.5,
    color: "var(--g800)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    userSelect: "all",
  };
  const copyFieldBtn: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    height: 28,
    padding: "0 11px",
    fontSize: 11.5,
    fontWeight: 600,
    borderRadius: 7,
    border: "1px solid var(--g200)",
    background: "var(--sb)",
    color: "var(--g700)",
    cursor: "pointer",
    flexShrink: 0,
  };
  const CopyGlyph = () => (
    <IconCopy size={12} aria-hidden="true" />
  );
  // Enterprise detail block: Meeting ID + join link, each a tidy copy field.
  // Shown in the success state after scheduling and at the top of the Edit form.
  const idLinkBlock = (mt: any) => (
    <div
      style={{
        marginTop: 14,
        padding: 14,
        border: "1px solid var(--g200)",
        borderRadius: 12,
        background: "var(--sb)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div>
        <div style={lblStyle}>Meeting ID</div>
        <div style={copyFieldRow}>
          <span style={{ ...copyFieldVal, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
            {mt.id}
          </span>
          <button type="button" style={copyFieldBtn} onClick={() => copyMeetingId(mt.id)} aria-label="Copy meeting ID">
            <CopyGlyph />
            Copy
          </button>
        </div>
      </div>
      <div>
        <div style={lblStyle}>Meeting link</div>
        <div style={copyFieldRow}>
          <span style={copyFieldVal}>{meetingLink(mt.id)}</span>
          <button type="button" style={copyFieldBtn} onClick={() => copyMeetingLink(mt.id)} aria-label="Copy meeting link">
            <CopyGlyph />
            Copy
          </button>
        </div>
      </div>
      {/* Public (guest) link — host / co-host only. Lets people WITHOUT a Collab
          account join by entering a name; can be turned off at any time. */}
      {publicLink &&
      (mt.mine ||
        (mt.attendees || []).some((a: any) => a && a.id === meId && a.role === "co-host")) ? (
        <div>
          <div style={lblStyle}>Public link</div>
          <PublicLinkControl
            actions={publicLink}
            meetingId={mt.id}
            enabled={!!mt.publicLinkEnabled}
            onToast={onToast || (() => {})}
          />
        </div>
      ) : null}
    </div>
  );

  const HOUR_H = 44;
  const timeGrid = (days: Date[]) => (
    <div className={"cal-tg" + (days.length === 1 ? " day" : "")}>
      <div className="ctg-head">
        <div className="ctg-gh" />
        {days.map((d) => {
          const k = keyOf(d);
          const isPast = k < todayKey;
          return (
            <div
              key={k}
              className={
                "ctg-dh" +
                (k === todayKey ? " today" : "") +
                (isPast ? " is-past" : "")
              }
            >
              <span className="ctg-dow">{DOW[d.getDay()]}</span>
              <span className="ctg-dnum">{d.getDate()}</span>
            </div>
          );
        })}
      </div>
      <div className="ctg-body">
        <div className="ctg-gutter">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="ctg-hr" style={{ height: HOUR_H }}>
              {h === 0 ? "" : `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`}
            </div>
          ))}
        </div>
        <div className="ctg-cols">
          {days.map((d) => {
            const k = keyOf(d);
            const isPast = k < todayKey;
            const packed = packDay(byDate[k] || []);
            return (
              <div
                key={k}
                className={
                  "ctg-col" +
                  (isPast ? " is-past" : "") +
                  (k === todayKey ? " today" : "") +
                  (dragOverKey === k ? " drag-over" : "")
                }
                onDragOver={(e) => {
                  if (isPast) return;
                  e.preventDefault();
                  setDragOverKey(k);
                }}
                onDragLeave={() =>
                  setDragOverKey((cur) => (cur === k ? null : cur))
                }
                onDrop={(e) => {
                  if (isPast) return;
                  e.preventDefault();
                  const rect = (
                    e.currentTarget as HTMLElement
                  ).getBoundingClientRect();
                  const hour = Math.max(
                    0,
                    Math.min(23, Math.floor((e.clientY - rect.top) / HOUR_H)),
                  );
                  rescheduleAt(draggingRef.current, k, hour);
                  draggingRef.current = null;
                }}
                onClick={(e) => {
                  if (isPast) return;
                  const rect = (
                    e.currentTarget as HTMLElement
                  ).getBoundingClientRect();
                  const hour = Math.max(
                    0,
                    Math.min(23, Math.floor((e.clientY - rect.top) / HOUR_H)),
                  );
                  openSchedAt(k, hour);
                }}
              >
                {Array.from({ length: 24 }, (_, h) => {
                  const isPastSlot = isPast || (k === todayKey && h < new Date(now).getHours());
                  return (
                    <div
                      key={h}
                      className={"ctg-slot" + (isPastSlot ? " is-past-slot" : "")}
                      style={{ height: HOUR_H }}
                    />
                  );
                })}
                {packed.map(({ ev, lane, lanes }) => {
                  const sdt = new Date(ev.startsAt);
                  const top =
                    ((sdt.getHours() * 60 + sdt.getMinutes()) / 60) * HOUR_H;
                  const h = Math.max(
                    ((ev.durationMin || 30) / 60) * HOUR_H,
                    20,
                  );
                  const st = meetingState(ev, now);
                  const w = 100 / lanes;
                  return (
                    <div
                      key={ev.id}
                      className={
                        "ctg-ev st-" +
                        st +
                        (conflicts.has(ev.id) ? " conflict" : "") +
                        (ev.mine ? " draggable" : "")
                      }
                      draggable={!isPast && !!ev.mine}
                      onDragStart={(e) => {
                        e.stopPropagation();
                        draggingRef.current = ev;
                      }}
                      onDragEnd={() => {
                        draggingRef.current = null;
                        setDragOverKey(null);
                      }}
                      style={{
                        top,
                        height: h,
                        left: `calc(${lane * w}% + 2px)`,
                        width: `calc(${w}% - 4px)`,
                      }}
                      title={
                        ev.mine
                          ? "Drag to reschedule · click to edit"
                          : ev.title
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        openMeeting(ev);
                      }}
                    >
                      <div className="ctg-ev-t">{fmtTime(ev.startsAt)}</div>
                      <div className="ctg-ev-n">
                        {conflicts.has(ev.id) ? <ConflictMark /> : null}
                        {ev.title}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  // Join-by-ID/link: someone who wasn't invited can paste a meeting link or type
  // the meeting id to join (gated server-side by the host's lobby/lock).
  const [joinInput, setJoinInput] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);
  // Meeting-ID + Schedule render into the app's top header, next to the search icon.
  const [hdrSlot, setHdrSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let tries = 0;
    const find = () => {
      const el = document.getElementById("cal-header-slot");
      if (el) setHdrSlot(el);
      else if (tries++ < 20) t = window.setTimeout(find, 150);
    };
    let t = window.setTimeout(find, 0);
    return () => window.clearTimeout(t);
  }, []);
  // Only a well-formed meeting id/link is joinable — drives BOTH the Join button's
  // enabled state and a guarded submit, so an invalid id can never reach the lobby.
  const joinRef = parseMeetingRef(joinInput);
  const canJoin = MEETING_ID_RE.test(joinRef);
  const submitJoin = () => {
    if (!canJoin) {
      onToast && onToast("Enter a valid meeting ID or link");
      return;
    }
    setJoinInput("");
    onJoin(joinRef);
    onToast && onToast("Joining meeting…");
  };

  // Focus shows the 10 most-frequent contacts (people is already frequency-
  // sorted); typing filters across ALL contacts by name. Picks become chips.
  const inviteRef = useRef<HTMLDivElement | null>(null);
  const inviteResults = (() => {
    const qq = inviteQuery.trim().toLowerCase();
    if (qq) return attendees.filter((p) => (p.name || "").toLowerCase().includes(qq)).slice(0, 30);
    return attendees.slice(0, 10);
  })();
  useEffect(() => {
    if (!inviteOpen) return;
    const onDown = (e: MouseEvent) => {
      if (inviteRef.current && !inviteRef.current.contains(e.target as Node)) setInviteOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [inviteOpen]);

  // Recurrence labels derived from the chosen start date (for the monthly/yearly
  // "on the Nth weekday" option + unit pluralisation).
  const recStartD = date ? new Date(date + "T00:00") : new Date();
  const recWeekdayIdx = recStartD.getDay();
  const recDayNum = recStartD.getDate();
  const recOrd = Math.ceil(recDayNum / 7);
  const recIsLast = recOrd >= 5;
  const recOrdLabel = recIsLast ? "last" : ["first", "second", "third", "fourth"][recOrd - 1];

  const recOrdVal = recIsLast ? -1 : recOrd;
  // The ONE place the structured recurrence rule is assembled from the editor
  // state — used by save AND the RCR-05 next-dates preview below.
  const buildRecurrenceRule = () => {
    if (recurrence === "none") return null;
    return {
      freq: recurrence,
      interval: Math.max(1, recInterval || 1),
      ...(recurrence === "weekly" || recurrence === "biweekly"
        ? { byWeekday: (recDays.length ? recDays : [recWeekdayIdx]).slice().sort((a, b) => a - b) }
        : {}),
      ...(recurrence === "monthly" || recurrence === "yearly"
        ? (recMonthly === "weekday"
            ? { monthlyMode: "weekday", ordinal: recOrdVal, weekday: recWeekdayIdx }
            : { monthlyMode: "day", day: recDayNum })
        : {}),
      ...(recurrence === "yearly" ? { month: recStartD.getMonth() + 1 } : {}),
      end:
        recEnds === "after"
          ? { type: "after", count: Math.max(1, recCount || 1) }
          : recEnds === "on" && recUntil
            ? { type: "on", date: recUntil }
            : { type: "never" },
    };
  };
  // RCR-05: the editor shows the next computed dates BEFORE saving, from the
  // SAME server-side expansion the calendar uses (debounced; best-effort).
  const [recPreview, setRecPreview] = useState<string[]>([]);
  useEffect(() => {
    if (recurrence === "none" || !onPreviewOccurrences || !date || !time) {
      setRecPreview([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const dates = await onPreviewOccurrences({
          startsAt: new Date(`${date}T${time}`).toISOString(),
          recurrence,
          recurrenceRule: buildRecurrenceRule(),
          count: 5,
        });
        setRecPreview(Array.isArray(dates) ? dates : []);
      } catch (_) {
        setRecPreview([]);
      }
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recurrence, recInterval, recDays, recWeekdayIdx, recMonthly, recOrdVal, recDayNum, recEnds, recCount, recUntil, date, time]);
  const recWeekdayLabel = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][recWeekdayIdx];
  const recUnit = (n: number) =>
    (({ daily: "day", weekly: "week", monthly: "month", yearly: "year" } as any)[recurrence] || "") + (n === 1 ? "" : "s");

  const segEl = (
                <div className="cal-seg">
                <Select
                  className="cal-viewsel"
                  value={calView}
                  onChange={(e) => setCalView(e.target.value)}
                  aria-label="Calendar view"
                >
                  <option value="month">Monthly</option>
                  <option value="week">Weekly</option>
                  <option value="day">Daily</option>
                </Select>
                <button
                  type="button"
                  className={"cal-upc-toggle" + (showSidebar ? " active" : "")}
                  onClick={() => setShowSidebar((v) => !v)}
                  title={showSidebar ? "Hide upcoming meetings" : "Show upcoming meetings"}
                  aria-label="Toggle upcoming meetings"
                  aria-expanded={showSidebar}
                >
                  <IconClock size={15} />
                  <span className="cal-upc-toggle-txt">Upcoming</span>
                  {upcoming.length > 0 && (
                    <span className="cal-upc-badge">{upcoming.length}</span>
                  )}
                </button>
                </div>
  );

  const headerActions = (
    <div className="cal-hdr-actions">
                {joinOpen || joinInput ? (
                  <form
                    className="cal-join open"
                    onSubmit={(e) => { e.preventDefault(); submitJoin(); }}
                    onBlur={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node) && !joinInput) setJoinOpen(false);
                    }}
                  >
                    <IconLink size={13} aria-hidden="true" />
                    <input
                      className="cal-join-input"
                      autoFocus
                      value={joinInput}
                      onChange={(e) => setJoinInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Escape" && !joinInput) setJoinOpen(false); }}
                      placeholder="Meeting ID or link"
                      aria-label="Join a meeting by ID or link"
                    />
                    <button type="submit" className="cal-join-btn" disabled={!canJoin}>Join</button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="cal-join-toggle cal-join-pill"
                    onClick={() => setJoinOpen(true)}
                    aria-label="Join with meeting ID or link"
                    data-tip="Join with meeting ID or link"
                  >
                    Join
                  </button>
                )}
                <button className="btn-p cal-sched-btn" onClick={() => openSched()}>
                  Schedule <IconPlus size={18} />
                </button>
    </div>
  );

  return (
    <div className="view active" id="vcal">
      {hdrSlot ? createPortal(headerActions, hdrSlot) : null}
      <div className={"cal-wrap" + (!showSidebar ? " sidebar-closed" : "")}>
        <div className="cal-main">
          <div className="cal-nav">
            {/* Figma Calender-view (116:3227): ONE toolbar row —
                [Meeting ID · Join]  [‹ Month Year ›]  [Monthly ▾] [Schedule +]. */}
            <div className="cal-nav-row cal-nav-single">
              <div className={"cal-nav-center" + (calView === "month" ? " cal-nav-center-moved" : "")}>
                <div className="cal-nav-btns">
                  <button onClick={() => shift(-1)} aria-label="Previous"><IconChevronLeft size={18} /></button>
                </div>
                <h3 id="cal-month-label">
                  {calView === "month" ? (
                    <>
                      {MONTHS[m]}
                      <span className="cal-year">{y}</span>
                    </>
                  ) : (
                    label
                  )}
                </h3>
                <div className="cal-nav-btns">
                  <button onClick={() => shift(1)} aria-label="Next"><IconChevronRight size={18} /></button>
                  <button className="cal-today-btn" onClick={() => setViewDate(new Date())}>Today</button>
                </div>
              </div>
              <div className="cal-nav-right">
                {!hdrSlot ? headerActions : null}
                {calView !== "month" ? segEl : null}
              </div>
            </div>
          </div>
          {calView === "month" ? (
            <div className="cal-title-row">
              <div className="cal-title-nav">
              <button className="cal-tn-btn" onClick={() => shift(-1)} aria-label="Previous"><IconChevronLeft size={18} /></button>
              <h1 className="cal-title">{MONTHS[m]} {y}</h1>
              <button className="cal-tn-btn" onClick={() => shift(1)} aria-label="Next"><IconChevronRight size={18} /></button>
                <span className="cal-title-meta cal-title-meta-out">
                  • {(meetings || []).filter((e: any) => e.startsAt && keyOf(new Date(e.startsAt)).startsWith(`${y}-${pad(m + 1)}`)).length} meetings
                </span>
              </div>
              <button className="cal-today-btn cal-tn-today" onClick={() => setViewDate(new Date())}>Today</button>
              <div className="cal-title-right">
              <div className="cal-legend">
                <span><i style={{ background: "#7c3aed" }} />Upcoming</span>
                <span><i style={{ background: "#10b981" }} />Live</span>
                <span><i style={{ background: "#c4c4cc" }} />Ended</span>
                <span><i style={{ background: "#f59e0b" }} />Conflict</span>
              </div>
                {segEl}
              </div>
            </div>
          ) : null}
          {calView === "month" ? (
            <div className="cal-grid-area">
              <div className="cal-dh">
                {DOW.map((d) => (
                  <div key={d} className="cal-dn">
                    {d}
                  </div>
                ))}
              </div>
              <div className="cal-cells" id="cal-cells">
                {cells}
              </div>
            </div>
          ) : calView === "week" ? (
            timeGrid(weekDays)
          ) : (
            timeGrid([dayDate])
          )}
        </div>
        <div
          className={"cal-sidebar-backdrop" + (showSidebar ? " show" : "")}
          onClick={() => setShowSidebar(false)}
          aria-hidden="true"
        />
        <div className={"cal-sidebar" + (showSidebar ? " open" : " closed")}>
          <div className="cal-sidebar-header">
            <h3>Upcoming Meetings</h3>
            <button
              type="button"
              className="cal-sidebar-close"
              onClick={() => setShowSidebar(false)}
              aria-label="Close upcoming meetings"
            >
              <IconX size={16} />
            </button>
          </div>
          <div id="upcoming-meetings">
            {upcoming.length ? (
              sections.map((sec) =>
                sec.items.length ? (
                  <div className="upc-sec" key={sec.key}>
                    <div className="upc-sec-hd">
                      {sec.label}
                      <span className="upc-sec-n">{sec.items.length}</span>
                    </div>
                    {sec.items.slice(0, secLim[sec.key]).map((e, idx, arr) => {
                      const dd = new Date(e.startsAt);
                      const dk = keyOf(dd);
                      const dayCount = arr.filter((x: any) => keyOf(new Date(x.startsAt)) === dk).length;
                      const dayHdr =
                        idx === 0 || keyOf(new Date(arr[idx - 1].startsAt)) !== dk ? (
                          <div className="upc-day">
                            <span className="upc-day-n">{dd.getDate()}</span>
                            <span className="upc-day-l">
                              {MONTHS[dd.getMonth()].slice(0, 3)} {dd.getDate()} •{" "}
                              {dd.toLocaleDateString([], { weekday: "short" })}
                            </span>
                            <span className="upc-day-c">
                              {dayCount} meeting{dayCount === 1 ? "" : "s"}
                            </span>
                          </div>
                        ) : null;
                      const st = meetingState(e, now);
                      const lbl =
                        keyOf(dd) === todayKey
                          ? "Today"
                          : dd.toLocaleDateString([], {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                            });
                      // meetingState() folds cancelled meetings and an elapsed
                      // window into "ended"; a host-ended meeting stays joinable
                      // until its scheduled time is exceeded. (The Ended branch
                      // below still reads e.status to pick the "Ended" vs
                      // "Cancelled" badge.)
                      const isEnded = st === "ended";
                      const isLive = st === "live";
                      const isSoon = st === "soon";
                      const isNext = e.id === nextId && !isEnded;
                      const msTo = new Date(e.startsAt).getTime() - now;
                      const chipText = isLive
                        ? "Live now"
                        : isNext && msTo > 0 && msTo < 36e5 * 24
                          ? msTo < 36e5
                            ? `Starts in ${Math.max(1, Math.round(msTo / 60000))} min`
                            : `Starts in ${Math.floor(msTo / 36e5)} h ${Math.round((msTo % 36e5) / 60000)} min`
                          : keyOf(dd) === todayKey
                            ? "Later today"
                            : lbl;
                      const acceptedCount = (e.attendees || []).filter(
                        (a: any) =>
                          a.status === "accepted" || a.status === "host",
                      ).length;
                      return (
                        <React.Fragment key={e.id}>
                        {dayHdr}
                        <div className="upc-row">
                        <div className="upc-time">
                          <b>{fmtTime(e.startsAt)}</b>
                          <span>{fmtTime(new Date(endMs(e)).toISOString())}</span>
                        </div>
                        <div
                          className={
                            "meet-card" +
                            (isNext ? " next" : "") +
                            (isEnded ? " ended" : "") +
                            (isLive ? " live" : "") +
                            (isSoon ? " soon" : "")
                          }
                        >
                          {!isEnded ? (
                            <div className="mc-chip">
                              {isLive ? <i className="mc-chip-dot" /> : null}
                              {chipText}
                              {e.durationMin ? (
                                <span className="mc-chip-dur">{durLabel(e.durationMin)}</span>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="mc-hd">
                            <h4>{e.title}</h4>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                              <button
                                type="button"
                                className={"mc-info-btn" + (infoMeetingId === e.id ? " active" : "")}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  setInfoMeetingId((cur) => (cur === e.id ? null : e.id));
                                }}
                                title={infoMeetingId === e.id ? "Hide participants" : "View participants with status"}
                                aria-label="View participants"
                              >
                                <IconInfo size={13} />
                              </button>
                              <span className="mc-time">
                                {fmtTime(e.startsAt)} - {fmtTime(new Date(endMs(e)).toISOString())}
                              </span>
                            </div>
                          </div>
                          {e.description ? (
                            <div className="mc-desc">{e.description}</div>
                          ) : null}
                          {(e.attendees || []).length > 0 ? (
                            <div className="mc-stack" aria-label="Participants">
                              {(e.attendees as any[]).slice(0, 4).map((a: any, i: number) => (
                                <span className="mc-stack-av" key={a.id || a.userId || i} title={a.name || a.email}>
                                  <Avatar avatar={attAv(a, i)} size={24} />
                                </span>
                              ))}
                              {(e.attendees as any[]).length > 4 ? (
                                <span className="mc-stack-more">+{(e.attendees as any[]).length - 4}</span>
                              ) : null}
                            </div>
                          ) : null}

                          {isEnded ? (
                            /* ── Completed / Ended / Cancelled ── */
                            <>
                              <div className="mc-p">
                                {lbl}
                                {e.status === "cancelled" ? (
                                  <span className="mc-badge cancelled">
                                    Cancelled
                                  </span>
                                ) : (
                                  <span className="mc-badge ended">Ended</span>
                                )}
                                {e.durationMin ? (
                                  <>
                                    {" · "}
                                    {durLabel(e.durationMin)}
                                  </>
                                ) : null}
                              </div>
                              {infoMeetingId === e.id && renderParticipants(e)}
                              <div className="mc-info-row">
                                <span className="mc-info-k">Attendance</span>
                                <span className="mc-info-v">
                                  {acceptedCount} participant
                                  {acceptedCount !== 1 ? "s" : ""}
                                </span>
                              </div>
                              <div className="mc-id">
                                <span className="mc-id-k">Meeting ID</span>
                                <span className="mc-id-v" title={e.id}>
                                  {e.id}
                                </span>
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  gap: 6,
                                  marginTop: 10,
                                }}
                              >
                                <button
                                  style={cardIconBtn}
                                  onClick={() => copyMeetingLink(e.id)}
                                  title="Copy meeting link"
                                  aria-label="Copy meeting link"
                                >
                                  <IconCopy size={15} />
                                </button>
                                {e.mine ? (
                                  <button
                                    style={{
                                      ...cardIconBtn,
                                      background:
                                        "var(--red-bg, #fef2f2)",
                                      color:
                                        "var(--red, #dc2626)",
                                      borderColor:
                                        "var(--red-bg, #fef2f2)",
                                    }}
                                    onClick={() => {
                                      setCancelModalMeeting(e);
                                      setCancelNote("");
                                    }}
                                    title="Cancel meeting"
                                    aria-label="Cancel meeting"
                                  >
                                    <IconTrash size={15} />
                                  </button>
                                ) : null}
                              </div>
                            </>
                          ) : isLive ? (
                            /* ── Live / Active ── */
                            <>
                              <div className="mc-p">
                                <span className="mc-badge live">
                                  <span className="mc-badge-dot" /> Live now
                                </span>
                                {conflicts.has(e.id) ? (
                                  <span className="mc-badge conflict">
                                    <IconAlertTriangle size={11} /> Conflict
                                  </span>
                                ) : null}
                              </div>
                              {infoMeetingId === e.id && renderParticipants(e)}
                              <button
                                className="join-btn live"
                                onClick={() => {
                                  onJoin(cleanId(e.meetingId || e.id));
                                  onToast(
                                    `Joining ${e.title}…`,
                                  );
                                }}
                              >
                                Join now
                              </button>
                              <div
                                style={{
                                  display: "flex",
                                  gap: 6,
                                  marginTop: 8,
                                }}
                              >
                                <button
                                  style={cardIconBtn}
                                  onClick={() =>
                                    copyMeetingLink(e.id)
                                  }
                                  title="Copy meeting link"
                                  aria-label="Copy meeting link"
                                >
                                  <IconCopy size={15} />
                                </button>
                                {e.mine ? (
                                  <>
                                    <button
                                      style={{
                                        ...cardIconBtn,
                                        background:
                                          "color-mix(in srgb, var(--ac, #0ea5e9) 10%, transparent)",
                                        color: "var(--ac, #0ea5e9)",
                                        borderColor:
                                          "color-mix(in srgb, var(--ac, #0ea5e9) 30%, transparent)",
                                      }}
                                      onClick={() => setInvitingMeeting(e)}
                                      title="Add member"
                                      aria-label="Add member"
                                    >
                                      <IconUserPlus size={15} />
                                    </button>
                                    <button
                                      style={{
                                        ...cardIconBtn,
                                        background:
                                          "var(--red-bg, #fef2f2)",
                                        color:
                                          "var(--red, #dc2626)",
                                        borderColor:
                                          "color-mix(in srgb, var(--red, #dc2626) 20%, transparent)",
                                      }}
                                      onClick={() => {
                                        onComplete &&
                                          onComplete(cleanId(e.meetingId || e.id));
                                        onToast(
                                          `Ended ${e.title}`,
                                        );
                                      }}
                                      title="End meeting"
                                      aria-label="End meeting"
                                    >
                                      <IconPhoneOff size={15} />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    style={{
                                      ...cardIconBtn,
                                      background:
                                        "var(--red-bg, #fef2f2)",
                                      color:
                                        "var(--red, #dc2626)",
                                      borderColor:
                                        "color-mix(in srgb, var(--red, #dc2626) 20%, transparent)",
                                    }}
                                    onClick={() => {
                                      onLeave(cleanId(e.meetingId || e.id));
                                      onToast(
                                        `Left ${e.title}`,
                                      );
                                    }}
                                    title="Leave meeting"
                                    aria-label="Leave meeting"
                                  >
                                    <IconPhoneOff size={15} />
                                  </button>
                                )}
                              </div>
                            </>
                          ) : (
                            /* ── Scheduled / Soon / Upcoming ── */
                            <>
                              <div className="mc-p">
                                <IconClock size={16} aria-hidden="true" />
                                {durLabel(e.durationMin)} · {lbl}
                                {isSoon ? (
                                  <span className="mc-badge soon">
                                    Starting soon
                                  </span>
                                ) : null}
                                {conflicts.has(e.id) ? (
                                  <span className="mc-badge conflict">
                                    <IconAlertTriangle size={11} /> Conflict
                                  </span>
                                ) : null}
                                {e.recurrence &&
                                e.recurrence !== "none" ? (
                                  <span className="mc-badge recur">
                                    {RECUR_LABEL[e.recurrence] ||
                                      "Repeats"}
                                  </span>
                                ) : null}
                              </div>
                              {infoMeetingId === e.id && renderParticipants(e)}
                              <button
                                className={
                                  "join-btn" +
                                  (isSoon
                                    ? " soon"
                                    : "")
                                }
                                onClick={() => {
                                  onJoin(cleanId(e.meetingId || e.id));
                                  onToast(
                                    `Joining ${e.title}…`,
                                  );
                                }}
                              >
                                {isSoon
                                  ? "Join now"
                                  : "Join"}
                              </button>
                              <div
                                style={{
                                  display: "flex",
                                  gap: 6,
                                  marginTop: 8,
                                }}
                              >
                                <button
                                  style={cardIconBtn}
                                  onClick={() =>
                                    copyMeetingLink(e.id)
                                  }
                                  title="Copy meeting link"
                                  aria-label="Copy meeting link"
                                >
                                  <IconCopy size={15} />
                                </button>
                                {e.mine ? (
                                  <>
                                    <button
                                      style={{
                                        ...cardIconBtn,
                                        background:
                                          "color-mix(in srgb, var(--ac, #0ea5e9) 10%, transparent)",
                                        color: "var(--ac, #0ea5e9)",
                                        borderColor:
                                          "color-mix(in srgb, var(--ac, #0ea5e9) 30%, transparent)",
                                      }}
                                      onClick={() => setInvitingMeeting(e)}
                                      title="Add member"
                                      aria-label="Add member"
                                    >
                                      <IconUserPlus size={15} />
                                    </button>
                                    <button
                                      style={cardIconBtn}
                                      onClick={() =>
                                        openEdit(e)
                                      }
                                      title="Edit meeting"
                                      aria-label="Edit meeting"
                                    >
                                      <IconPencil size={15} />
                                    </button>
                                    <button
                                      style={{
                                        ...cardIconBtn,
                                        background: "var(--red-bg, #fef2f2)",
                                        color: "var(--red, #dc2626)",
                                        borderColor:
                                          "color-mix(in srgb, var(--red, #dc2626) 20%, transparent)",
                                      }}
                                      onClick={() => {
                                        setCancelModalMeeting(e);
                                        setCancelNote("");
                                      }}
                                      title="Cancel meeting"
                                      aria-label="Cancel meeting"
                                    >
                                      <IconTrash size={15} />
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    style={{
                                      ...cardIconBtn,
                                      background:
                                        "var(--red-bg, #fef2f2)",
                                      color:
                                        "var(--red, #dc2626)",
                                      borderColor:
                                        "color-mix(in srgb, var(--red, #dc2626) 20%, transparent)",
                                    }}
                                    onClick={() => {
                                      onLeave(cleanId(e.meetingId || e.id));
                                      onToast(
                                        `Left ${e.title}`,
                                      );
                                    }}
                                    title="Leave meeting"
                                    aria-label="Leave meeting"
                                  >
                                    <IconPhoneOff size={15} />
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                        </div>
                        </React.Fragment>
                      );
                    })}
                    {sec.items.length > secLim[sec.key] ? (
                      <button
                        className="upc-more"
                        onClick={() =>
                          setSecLim((p) => ({
                            ...p,
                            [sec.key]: p[sec.key] + 10,
                          }))
                        }
                      >
                        Show {sec.items.length - secLim[sec.key]} more
                      </button>
                    ) : null}
                  </div>
                ) : null,
              )
            ) : (
              <p style={{ fontSize: 12, color: "var(--g400)" }}>
                No upcoming meetings
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Meeting details ────────────────────────────────────────────────
          What a meeting IS, for anyone who has it in their calendar: when,
          where, the agenda, who is coming, the link — plus Join and Leave.
          Clicking a meeting used to open the edit FORM, which answers none of
          those and, for a meeting you don't own, is a form you can't save. */}
      {details ? (() => {
        const d = details;
        const mid = cleanId(d.meetingId || d.id);
        const st = meetingState(d, now);
        const start = new Date(d.startsAt);
        const end = new Date(endMs(d));
        const tzLabel = d.timezone ? tzAbbr(d.timezone) : "";
        const atts = d.attendees || [];
        const optionalCount = atts.filter((a: any) => a.optional).length;
        const joinable = st !== "ended";
        const stLabel =
          st === "live" ? "Happening now"
            : st === "soon" ? "Starting soon"
            : st === "ended" ? (d.status === "cancelled" ? "Cancelled" : "Ended")
            : "Scheduled";
        return (
          <Modal
            wide
            width={620}
            title={
              <span className="md-title">
                <span className={"md-state st-" + st}>{stLabel}</span>
                <span className="md-title-t">{d.title || "Meeting"}</span>
              </span>
            }
            onClose={() => setDetails(null)}
            footer={
              <>
                {d.mine ? (
                  <Btn
                    onClick={() => {
                      const target = d;
                      setDetails(null);
                      openEdit(target);
                    }}
                  >
                    Edit
                  </Btn>
                ) : onLeave ? (
                  /* Leaving is for a meeting someone ELSE owns — the organiser
                     cancels theirs instead (Edit → Cancel meeting), which is a
                     different act with different consequences for everyone. */
                  <Btn
                    danger
                    onClick={() => {
                      onLeave(mid);
                      setDetails(null);
                      onToast && onToast(`Left ${d.title || "the meeting"}`);
                    }}
                  >
                    Leave meeting
                  </Btn>
                ) : null}
                <span className="md-foot-sp" />
                <Btn onClick={() => setDetails(null)}>Close</Btn>
                <Btn
                  primary
                  disabled={!joinable}
                  onClick={() => {
                    setDetails(null);
                    onJoin && onJoin(mid);
                  }}
                >
                  {st === "live" ? "Join now" : "Join"}
                </Btn>
              </>
            }
          >
            <div className="md-body">
              {/* Live room state — the one fact the stored meeting can't tell
                  you, and the one that decides whether you join right now. */}
              {detailsLive && st !== "ended" ? (
                <div className={"md-live" + (detailsLive.started ? " on" : "")}>
                  <span className="md-live-dot" aria-hidden="true" />
                  {detailsLive.started
                    ? `In progress · ${detailsLive.count} ${detailsLive.count === 1 ? "person" : "people"} in the meeting`
                    : "Nobody has joined yet"}
                </div>
              ) : null}

              <div className="md-row">
                <span className="md-ico" aria-hidden="true"><IconClock size={17} /></span>
                <div className="md-row-b">
                  <div className="md-strong">
                    {start.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
                  </div>
                  <div className="md-sub">
                    {fmtTime(d.startsAt)} – {fmtTime(end.toISOString())}
                    {tzLabel ? " " + tzLabel : ""} · {durLabel(d.durationMin || 30)}
                    {d.recurrence && d.recurrence !== "none"
                      ? " · " + recurrenceChipLabel(d.recurrence)
                      : ""}
                  </div>
                </div>
              </div>

              <div className="md-row">
                <span className="md-ico" aria-hidden="true"><IconMapPin size={17} /></span>
                <div className="md-row-b">
                  <div className="md-strong">Collab call</div>
                  {d.location ? <div className="md-sub">{d.location}</div> : null}
                </div>
              </div>

              {/* Agenda. Rendered with its line breaks intact — an agenda is a
                  list, and collapsing it to one paragraph loses the list. */}
              <div className="md-row">
                <span className="md-ico" aria-hidden="true"><IconAlignLeft size={17} /></span>
                <div className="md-row-b">
                  <div className="md-lbl">Agenda</div>
                  {d.description ? (
                    <div className="md-agenda">{d.description}</div>
                  ) : (
                    <div className="md-empty">No agenda was added.</div>
                  )}
                </div>
              </div>

              <div className="md-row">
                <span className="md-ico" aria-hidden="true"><IconUsers size={17} /></span>
                <div className="md-row-b">
                  <div className="md-lbl">
                    Participants ({atts.length})
                    {optionalCount ? ` · ${optionalCount} optional` : ""}
                  </div>
                  {atts.length ? (
                    <div className="md-people">
                      {atts.map((p: any) => {
                        const isHost = p.role === "host" || p.id === d.hostId;
                        const tag = isHost
                          ? "host"
                          : p.status === "accepted"
                            ? "accepted"
                            : p.status === "declined"
                              ? "declined"
                              : "invited";
                        return (
                          <span className="mc-p-chip" key={p.id || p.userId}>
                            <Avatar avatar={av(p)} size={18} />
                            <span className="mc-p-name">{p.name || p.email || "User"}</span>
                            <span className={"mc-p-tag " + tag}>
                              {isHost ? "Host" : tag[0].toUpperCase() + tag.slice(1)}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="md-empty">No one else was invited.</div>
                  )}
                </div>
              </div>

              {d.reminderLeadMin ? (
                <div className="md-row">
                  <span className="md-ico" aria-hidden="true"><IconBell size={17} /></span>
                  <div className="md-row-b">
                    <div className="md-sub">
                      Reminder {durLabel(Number(d.reminderLeadMin))} before
                    </div>
                  </div>
                </div>
              ) : null}

              {idLinkBlock({ id: mid, mine: d.mine, attendees: d.attendees, publicLinkEnabled: d.publicLinkEnabled })}
            </div>
          </Modal>
        );
      })() : null}
      {dayPeek ? (
        <Modal
          title={new Date(dayPeek.date + "T00:00").toLocaleDateString([], {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
          onClose={() => setDayPeek(null)}
          footer={
            <>
              <Btn onClick={() => setDayPeek(null)}>Close</Btn>
              <Btn
                primary
                onClick={() => {
                  const k = dayPeek.date;
                  setDayPeek(null);
                  openSched(k);
                }}
              >
                <IconPlus size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />Schedule
              </Btn>
            </>
          }
        >
          <div className="day-peek">
            {dayPeek.events.map((e) => {
              const st = meetingState(e, now);
              return (
                <div
                  className={"dp-row st-" + st}
                  key={e.id}
                  onClick={() => {
                    setDayPeek(null);
                    openMeeting(e);
                  }}
                >
                  <span className="dp-time">{fmtTime(e.startsAt)}</span>
                  <span className="dp-title">
                    {conflicts.has(e.id) ? <ConflictMark /> : null}
                    {e.title}
                  </span>
                  <span className="dp-dur">{durLabel(e.durationMin)}</span>
                </div>
              );
            })}
          </div>
        </Modal>
      ) : null}

      {sched ? (
        <Modal
          wide
          width={created ? 680 : 880}
          // Edge-to-edge, fixed-height body: the form and the "Your day so far"
          // strip are two independently scrolling columns whose divider runs
          // from the header to the footer.
          bodyStyle={
            created
              ? undefined
              : {
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  height: "min(640px, 70vh)",
                }
          }
          title={
            created ? (
              "Meeting scheduled"
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                <span className="sm-title-ico" aria-hidden="true">
                  <IconCalendarPlus size={16} />
                </span>
                {editing ? "Edit meeting" : "New meeting"}
              </span>
            )
          }
          onClose={close}
          footer={
            created ? (
              <Btn primary onClick={close}>
                Done
              </Btn>
            ) : (
              <>
                {editing && editing.mine ? (
                  <Btn
                    danger
                    onClick={() => {
                      const target = editing;
                      close();
                      setCancelModalMeeting(target);
                      setCancelNote("");
                    }}
                  >
                    Cancel meeting
                  </Btn>
                ) : null}
                {/* Running summary, so the decision stays visible without
                    scrolling back up through the form. */}
                <span className="sm-foot-sum">{scheduleSummary()}</span>
                <Btn onClick={close}>Cancel</Btn>
                {editing && onJoin && meetingState(editing, now) !== "ended" ? (
                  <Btn
                    onClick={() => {
                      const mid = cleanId(editing.meetingId || editing.id);
                      close();
                      onJoin(mid);
                    }}
                  >
                    {meetingState(editing, now) === "live" ? "Join now" : "Join"}
                  </Btn>
                ) : null}
                <Btn
                  primary
                  // Also blocked while the end is at/before the start, so the
                  // inline message has a visible consequence instead of the user
                  // pressing Schedule and being bounced.
                  disabled={
                    !title.trim() ||
                    !date ||
                    !time ||
                    !endTime ||
                    minutesBetween(time, endTime) <= 0 ||
                    !sel.length || // people are mandatory
                    submitting
                  }
                  onClick={submit}
                >
                  {submitting
                    ? editing
                      ? "Saving…"
                      : "Sending…"
                    : editing
                      ? "Save"
                      : sel.length
                        ? "Send invite"
                        : "Schedule"}
                </Btn>
              </>
            )
          }
        >
          {created ? (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 6 }}>
                <span
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    background: "var(--grn-bg)",
                    color: "var(--grn)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <IconCheck size={19} aria-hidden="true" />
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--g900)" }}>
                    &ldquo;{created.title}&rdquo; is scheduled
                    {created.recurrence && created.recurrence !== "none"
                      ? ` · ${RECUR_LABEL[created.recurrence]}`
                      : ""}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--g500)", marginTop: 1 }}>
                    Share the link or ID below so people can join.
                  </div>
                </div>
              </div>
              {idLinkBlock(created)}
            </div>
          ) : (
            <div className="sm-split">
            <div className="sm-main">
              {/* ── Title ─────────────────────────────────────────── */}
              <input
                name="meeting-title"
                autoComplete="off"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Meeting title"
                maxLength={80}
                className="sm-title-in"
              />

              {/* ── Guests ────────────────────────────────────────────
                  Chips carry the avatar, the required/optional toggle and the
                  remove — the whole invitee state in one row, rather than a
                  button that opens a list somewhere else. */}
              <div className="sm-row sm-people">
                <span className="sm-row-ico" aria-hidden="true">
                  <IconUsers size={18} />
                </span>
                <div className="sm-row-body" ref={inviteRef} style={{ position: "relative" }}>
                  <div className="sm-guests">
                    {sel.map((id) => {
                      const pn = attendees.find((a) => a.id === id);
                      if (!pn) return null;
                      const isOpt = optionalIds.includes(id);
                      const isBusy = !!(busy || []).some((b: any) => b.userId === id);
                      return (
                        <span
                          key={id}
                          className={"sm-chip" + (isBusy ? " busy" : "")}
                          title={isBusy ? pn.name + " has another meeting then" : undefined}
                        >
                          <Avatar avatar={av(pn)} size={22} />
                          <span className="sm-chip-name">{pn.name}</span>
                          <button
                            type="button"
                            className="sm-chip-opt"
                            onClick={() =>
                              setOptionalIds((cur) =>
                                isOpt ? cur.filter((x) => x !== id) : [...cur, id],
                              )
                            }
                            title={isOpt ? "Make required" : "Make optional"}
                          >
                            {isOpt ? "optional" : "required"}
                          </button>
                          <button
                            type="button"
                            className="sm-chip-x"
                            onClick={() => setSel((sx) => sx.filter((x) => x !== id))}
                            aria-label={"Remove " + pn.name}
                          >
                            <IconX size={12} />
                          </button>
                        </span>
                      );
                    })}
                    <button
                      type="button"
                      className="sm-add"
                      onClick={() => setInviteOpen((v) => !v)}
                    >
                      {sel.length ? "Add more people…" : "Add people…"}
                    </button>
                    {!sel.length && (
                      <span className="sm-req-hint">At least one person is required</span>
                    )}
                  </div>
                {inviteOpen && (
                  <div className="meet-invite-popover">
                    <input
                      name="meet-invite-search"
                      autoComplete="off"
                      autoFocus
                      className="meet-invite-search-in"
                      placeholder="Search people…"
                      value={inviteQuery}
                      onChange={(e) => setInviteQuery(e.target.value)}
                    />
                    <div className="meet-invite-list">
                      {inviteResults.length === 0 ? (
                        <div className="meet-invite-empty">No people found</div>
                      ) : (
                        inviteResults.map((p) => {
                          const on = sel.includes(p.id);
                          return (
                            <button
                              type="button"
                              key={p.id}
                              className={"meet-invite-opt" + (on ? " on" : "")}
                              onClick={() =>
                                setSel((s) => (on ? s.filter((x) => x !== p.id) : [...s, p.id]))
                              }
                            >
                              <Avatar avatar={av(p)} size={24} />
                              <span className="meet-invite-optname">{p.name}</span>
                              {on && <span className="meet-invite-check"><IconCheck size={13} /></span>}
                            </button>
                          );
                        })
                      )}
                    </div>
                    <div className="meet-invite-foot">
                      <span className="meet-invite-count">{sel.length} selected</span>
                      <button type="button" className="meet-invite-done" onClick={() => setInviteOpen(false)}>
                        Done
                      </button>
                    </div>
                  </div>
                )}
                </div>
              </div>

              {/* Availability. Only ever claims what it knows: this checks
                  CoLab meetings, not anyone's external calendar. */}
              {sel.length > 0 && (
                <div className="sm-avail">
                  {busy === null ? (
                    <span className="sm-avail-pill checking">Checking availability…</span>
                  ) : busy.length === 0 ? (
                    <span className="sm-avail-pill free">
                      <IconCheck size={13} />
                      {sel.length === 1
                        ? "Free at this time"
                        : "All " + sel.length + " free at this time"}
                    </span>
                  ) : (
                    <span className="sm-avail-pill busy">
                      <IconAlertTriangle size={13} />
                      {busy
                        .slice(0, 3)
                        .map((b: any) => {
                          const pn = attendees.find((a) => a.id === b.userId);
                          return (pn && pn.name) || "Someone";
                        })
                        .join(", ")}
                      {busy.length > 3 ? " +" + (busy.length - 3) : ""} already booked
                    </span>
                  )}
                </div>
              )}

              {/* ── When ──────────────────────────────────────────────
                  The one boxed group, because when a meeting is is the
                  decision the dialog exists to make. */}
              <div className="sm-when">
                <div className="sm-when-head">
                    <div className="sm-when-fields">
                  <input
                    name="meeting-date"
                    type="date"
                    min={todayKey}
                    value={date}
                    onChange={(e) => {
                      setDate(e.target.value);
                      setRecurrence("none");
                      setRecInterval(1);
                      setRecDays([]);
                      setRecMonthly("day");
                      setRecEnds("never");
                      setRecCount(10);
                      setRecUntil("");
                    }}
                    className="sm-when-in"
                  />
                  <input
                    name="meeting-time"
                    aria-label="Start time"
                    type="time"
                    value={time}
                    onChange={(e) => {
                      const v = e.target.value;
                      const prevStart = time;
                      setTime(v);
                      if (!v) return;
                      // Moving the start MOVES the meeting — it keeps its length,
                      // the way every calendar behaves. The old rule only touched
                      // the end when it had fallen at/before the new start, and
                      // then reset it to 30 minutes: dragging the start of a
                      // 2-hour meeting forward silently turned it into a 30-minute
                      // one, and nudging it back left the length wrong the other
                      // way. Fall back to 30 minutes only when there is no
                      // existing length to preserve.
                      const held = minutesBetween(prevStart, endTime);
                      setEndTime(addMins(v, held > 0 ? held : 30));
                      setErr("");
                    }}
                    className="sm-when-in"
                  />
                  <input
                    name="meeting-end-time"
                    aria-label="End time"
                    type="time"
                    value={endTime}
                    // Constrain the picker itself to times after the start. Without
                    // this the wheel happily offered an earlier hour and the only
                    // feedback was a submit-time error after the user had filled in
                    // everything else.
                    min={time || undefined}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEndTime(v);
                      // Say it immediately rather than at submit. Schedule is
                      // disabled while this holds, so the message explains why.
                      setErr(
                        v && time && minutesBetween(time, v) <= 0
                          ? "The meeting has to end after it starts."
                          : "",
                      );
                    }}
                    className="sm-when-in"
                  />
                </div>
                  {/* The zone is SELECTABLE, not a read-only badge: a host
                      scheduling for a team in another office types their time,
                      not a converted one. Shown as the abbreviation people
                      actually read a time against — IST, SGT, AEDT. */}
                  <TimeZonePicker value={tz} onChange={setTz} />
                  {/* Meeting options live behind this gear rather than a
                      full-width card: they matter, but not on every meeting, and
                      the fields people fill in every time should own the form.
                      The dot says the meeting carries a non-default policy. */}
                  <button
                    type="button"
                    className={
                      "sm-gear" + (optsOpen ? " on" : "") + (optsDirty ? " dirty" : "")
                    }
                    onClick={() => setOptsOpen((v) => !v)}
                    aria-expanded={optsOpen}
                    aria-label="Meeting options"
                    title={"Meeting options — " + meetingOptionsSummary(mOpts)}
                  >
                    <IconSettings size={16} />
                  </button>
                </div>
                {/* Duration presets. "All day" is deliberately absent: a CoLab
                    meeting is a room you join, and an all-day room is not a
                    thing — an all-day BLOCKER would be a separate feature. */}
                <div className="sm-durs">
                  {[15, 30, 45, 60].map((mins) => (
                    <button
                      type="button"
                      key={mins}
                      className={"sm-dur" + (minutesBetween(time, endTime) === mins ? " on" : "")}
                      onClick={() => setDurationMins(mins)}
                    >
                      {mins === 60 ? "1h" : mins + "m"}
                    </button>
                  ))}
                </div>
                <div className="sm-when-btns">
                  <button
                    type="button"
                    className={"sm-pick" + (recurrence !== "none" ? " on" : "")}
                    onClick={() => setRecOpen((v) => !v)}
                    aria-expanded={recOpen}
                  >
                    <IconRepeat size={15} />
                    {recurrence === "none" ? "Doesn't repeat" : recurrenceChipLabel(recurrence)}
                    <IconChevronDown size={14} />
                  </button>
                  <span className="sm-pick">
                    <IconBell size={15} />
                    <Select
                      value={String(reminderLead)}
                      onChange={(e) => setReminderLead(Number(e.target.value))}
                      aria-label="Meeting reminder lead time"
                    >
                      <option value="0">No reminder</option>
                      <option value="5">5 min before</option>
                      <option value="10">10 min before</option>
                      <option value="15">15 min before</option>
                      <option value="30">30 min before</option>
                      <option value="60">1 hour before</option>
                      <option value="1440">1 day before</option>
                    </Select>
                  </span>
                </div>
                {/* The full recurrence builder, unchanged — behind the chip now,
                    so the common case costs one line instead of a whole panel. */}
                {recOpen && (
                  <div className="sm-rec-pop">
                  <div className="rec-panel" style={{ marginTop: 12 }}>
                    <div className="rec-sec-h">Recurrence pattern</div>
                    <div className="rec-pattern">
                      <div className="rec-freqcol">
                        {(
                          [
                            ["none", "Does not repeat"],
                            ["daily", "Daily"],
                            ["weekly", "Weekly"],
                            ["monthly", "Monthly"],
                            ["yearly", "Yearly"],
                          ] as [string, string][]
                        ).map(([val, lbl]) => (
                          <label key={val} className="rec-freq-radio">
                            <input
                              type="radio"
                              name="rec-freq"
                              checked={recurrence === val}
                              onChange={() => {
                                setRecurrence(val);
                                if (val === "weekly" && recDays.length === 0)
                                  setRecDays([recWeekdayIdx]);
                              }}
                            />
                            <span>{lbl}</span>
                          </label>
                        ))}
                      </div>
                      <div className="rec-detail">
                        {recurrence === "none" ? (
                          <div className="rec-detail-empty">
                            This meeting occurs once.
                          </div>
                        ) : (
                          <>
                      <div className="rec-row">
                        <span className="rec-lbl">Recur every</span>
                        <input
                          type="number"
                          min={1}
                          max={99}
                          value={recInterval}
                          onChange={(e) => setRecInterval(Math.max(1, parseInt(e.target.value) || 1))}
                          className="rec-num"
                          aria-label="Repeat interval"
                        />
                        <span className="rec-unit">
                          {recUnit(recInterval)}
                          {recurrence === "weekly" ? " on:" : ""}
                        </span>
                      </div>
                      {recurrence === "weekly" && (
                        <div className="rec-weekgrid">
                          {[
                            "Sunday",
                            "Monday",
                            "Tuesday",
                            "Wednesday",
                            "Thursday",
                            "Friday",
                            "Saturday",
                          ].map((d, i) => (
                            <label
                              key={i}
                              className={"rec-check" + (recDays.includes(i) ? " on" : "")}
                            >
                              <input
                                type="checkbox"
                                checked={recDays.includes(i)}
                                onChange={() =>
                                  setRecDays((ds) =>
                                    ds.includes(i)
                                      ? ds.filter((x) => x !== i)
                                      : [...ds, i],
                                  )
                                }
                              />
                              <span>{d}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      {(recurrence === "monthly" || recurrence === "yearly") && (
                        <div className="rec-row">
                          <span className="rec-lbl">On</span>
                          <Select
                            value={recMonthly}
                            onChange={(e) => setRecMonthly(e.target.value as any)}
                            style={{ ...inp, flex: 1 }}
                            aria-label="Monthly pattern"
                          >
                            <option value="day">day {recDayNum}{recurrence === "yearly" ? ` of ${MONTHS[recStartD.getMonth()]}` : ""}</option>
                            <option value="weekday">the {recOrdLabel} {recWeekdayLabel}{recurrence === "yearly" ? ` of ${MONTHS[recStartD.getMonth()]}` : ""}</option>
                          </Select>
                        </div>
                      )}
                          </>
                        )}
                      </div>
                    </div>
                    {recurrence !== "none" && (
                      <>
                      <div className="rec-sec-h rec-sec-range">Range of recurrence</div>
                      <div className="rec-row">
                        <span className="rec-lbl">Start</span>
                        <span className="rec-startdate">
                          {recStartD.toLocaleDateString(undefined, {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </span>
                      </div>
                      <label className="rec-radio">
                        <input
                          type="radio"
                          name="rec-ends"
                          checked={recEnds === "on"}
                          onChange={() => setRecEnds("on")}
                        />
                        <span className="rec-radio-lbl">End by</span>
                        <input
                          type="date"
                          min={date || todayKey}
                          value={recUntil}
                          onChange={(e) => {
                            setRecUntil(e.target.value);
                            setRecEnds("on");
                          }}
                          className="rec-date"
                          aria-label="End by date"
                        />
                      </label>
                      <label className="rec-radio">
                        <input
                          type="radio"
                          name="rec-ends"
                          checked={recEnds === "after"}
                          onChange={() => setRecEnds("after")}
                        />
                        <span className="rec-radio-lbl">End after</span>
                        <input
                          type="number"
                          min={1}
                          value={recCount}
                          onChange={(e) => {
                            setRecCount(Math.max(1, parseInt(e.target.value) || 1));
                            setRecEnds("after");
                          }}
                          className="rec-num"
                          aria-label="Occurrences"
                        />
                        <span className="rec-unit">
                          occurrence{recCount === 1 ? "" : "s"}
                        </span>
                      </label>
                      <label className="rec-radio">
                        <input
                          type="radio"
                          name="rec-ends"
                          checked={recEnds === "never"}
                          onChange={() => setRecEnds("never")}
                        />
                        <span className="rec-radio-lbl">No end date</span>
                      </label>
                        </>
                      )}
                      {recurrence !== "none" && (
                        <div
                          style={{
                            marginTop: 12,
                            padding: "10px 12px",
                            background: "var(--g100, rgba(255,255,255,0.06))",
                            borderRadius: 8,
                            border: "1px solid var(--g200, rgba(255,255,255,0.1))",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              color: "var(--g800, #fff)",
                              marginBottom: 4,
                            }}
                          >
                            Recurrence Summary
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              color: "var(--g600, #aaa)",
                              marginBottom: 8,
                            }}
                          >
                            {recurrence === "daily"
                              ? `Repeats every ${recInterval > 1 ? `${recInterval} days` : "day"}`
                              : recurrence === "weekly" || recurrence === "biweekly"
                                ? `Repeats ${recurrence === "biweekly" ? "every 2 weeks" : recInterval > 1 ? `every ${recInterval} weeks` : "weekly"} on ${recDays.length ? recDays.map((d) => DOW[d]).join(", ") : recWeekdayLabel}`
                                : recurrence === "monthly"
                                  ? `Repeats ${recInterval > 1 ? `every ${recInterval} months` : "monthly"} on ${recMonthly === "weekday" ? `the ${recOrdLabel} ${recWeekdayLabel}` : `day ${recDayNum}`}`
                                  : `Repeats yearly on ${MONTHS[recStartD.getMonth()]} ${recDayNum}`}
                            {recEnds === "after"
                              ? `, for ${recCount} occurrences`
                              : recEnds === "on" && recUntil
                                ? `, until ${(() => {
                                    try {
                                      const ud = new Date(recUntil + "T00:00:00");
                                      return isNaN(ud.getTime())
                                        ? recUntil
                                        : ud.toLocaleDateString(undefined, {
                                            month: "short",
                                            day: "numeric",
                                            year: "numeric",
                                          });
                                    } catch (_) {
                                      return recUntil;
                                    }
                                  })()}`
                                : ""}
                          </div>
                          {/* RCR-05: the next computed dates, from the server's expansion. */}
                          {recPreview.length ? (
                            <div style={{ fontSize: 11, color: "var(--g500, #888)", marginBottom: 6 }}>
                              Next:{" "}
                              {recPreview
                                .map((d) => {
                                  const dd = new Date(d);
                                  return isNaN(dd.getTime())
                                    ? null
                                    : dd.toLocaleDateString(undefined, { month: "short", day: "numeric" });
                                })
                                .filter(Boolean)
                                .join(", ")}
                            </div>
                          ) : null}
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 500,
                              color: "var(--g500, #888)",
                            }}
                          >
                            Next occurrences:
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--accent, #6366f1)",
                              marginTop: 2,
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "4px 8px",
                            }}
                          >
                            {(() => {
                              const dates = computeNextRecurrenceDates(
                                date || todayKey,
                                recurrence,
                                recInterval,
                                recDays,
                                recEnds,
                                recCount,
                                recUntil,
                                5,
                              );
                              if (!dates.length) {
                                return (
                                  <span
                                    style={{
                                      color: "var(--g500, #888)",
                                      fontStyle: "italic",
                                    }}
                                  >
                                    No upcoming occurrences before end date
                                  </span>
                                );
                              }
                              return dates.map((dStr, idx) => (
                                <span key={idx}>
                                  {dStr}
                                  {idx < dates.length - 1 ? " ·" : ""}
                                </span>
                              ));
                            })()}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* ── Where ─────────────────────────────────────────────
                  "Collab call" is implicit — every meeting has a room. The
                  field is free text: there is no room directory or dial-in to
                  book, so the placeholder must not promise one. */}
              <div className="sm-row sm-plain">
                <div className="sm-row-body">
                  <div className="sm-loc-head">
                    <span className="sm-loc-pill">
                      <IconVideo size={15} />
                      Collab call
                    </span>
                  </div>
                  <input
                    name="meeting-location"
                    autoComplete="off"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="Add a room or link (optional)"
                    maxLength={255}
                    className="sm-loc-in"
                  />
                </div>
              </div>

              {/* ── Agenda ────────────────────────────────────────── */}
              <div className="sm-row sm-plain">
                <div className="sm-row-body">
                  <textarea
                    ref={descRef}
                    name="meeting-description"
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      autoGrowDesc();
                    }}
                    placeholder="Agenda, links, pre-reads…"
                    maxLength={8000}
                    rows={5}
                    className="sm-desc-in"
                  />
                </div>
              </div>

              {/* PER-MEETING OPTIONS (0116). Collapsed by default — a summary
                  line shows what is set so a host can see at a glance whether
                  anything is non-default without opening it. Every switch here
                  is enforced server-side (LiveKit grant + socket gates); this is
                  where intent is expressed, not where it is enforced. */}
              {/* Hidden rather than unmounted, so the ref the footer gear
                  scrolls to exists before the panel is shown. */}
              <div className={"mo-sched" + (optsOpen ? "" : " closed")} ref={optsRef}>
                {optsOpen && (
                  <div className="mo-sched-head">
                    <span className="mo-sched-title">Meeting options</span>
                    <span className="mo-sched-summary">{meetingOptionsSummary(mOpts)}</span>
                    <button
                      type="button"
                      className="mo-sched-collapse"
                      onClick={() => setOptsOpen(false)}
                      aria-label="Hide meeting options"
                    >
                      <IconChevronDown size={15} />
                    </button>
                  </div>
                )}
                {optsOpen && (
                  <div className="mo-sched-body">
                    <div className="mo-sched-group">
                      <div className="mo-sched-label">Who bypasses the lobby</div>
                      {[
                        ["everyone", "Everyone"],
                        ["invited", "People I invited"],
                        ["nobody", "Nobody — I admit each one"],
                      ].map(([v, label]) => (
                        <label className="mo-sched-opt" key={v}>
                          <input
                            type="radio"
                            name="mo-lobby"
                            checked={mOpts.lobbyPolicy === v}
                            onChange={() => setMOpts((o: any) => ({ ...o, lobbyPolicy: v }))}
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                    <div className="mo-sched-group">
                      <div className="mo-sched-label">Attendees may</div>
                      {[
                        ["allowMic", "Turn on their microphone"],
                        ["allowCamera", "Turn on their camera"],
                        ["allowChat", "Use meeting chat"],
                        ["allowReactions", "React and raise hands"],
                      ].map(([k, label]) => (
                        <label className="mo-sched-opt" key={k}>
                          <input
                            type="checkbox"
                            checked={!!mOpts[k]}
                            onChange={(e) =>
                              setMOpts((o: any) => ({ ...o, [k]: e.target.checked }))
                            }
                          />
                          <span>{label}</span>
                        </label>
                      ))}
                      <div className="mo-sched-foot">
                        These never apply to you or your co-hosts.
                      </div>
                    </div>
                    <div className="mo-sched-group">
                      <div className="mo-sched-label">Recording</div>
                      <label className="mo-sched-opt">
                        <input
                          type="checkbox"
                          checked={!!mOpts.autoRecord}
                          onChange={(e) =>
                            setMOpts((o: any) => ({ ...o, autoRecord: e.target.checked }))
                          }
                        />
                        <span>Start recording when I join</span>
                      </label>
                    </div>
                  </div>
                )}
              </div>
              {editing ? idLinkBlock(editing) : null}
              {err ? <div className="meet-err">{err}</div> : null}
            </div>
            {renderDayPanel()}
            </div>
          )}
        </Modal>
      ) : null}

      {invitingMeeting ? (
        <Modal
          title={`Add member to "${invitingMeeting.title}"`}
          onClose={() => {
            setInvitingMeeting(null);
            setAddMemberQuery("");
            setAddMemberSelected([]);
          }}
          footer={
            <>
              <Btn onClick={() => setInvitingMeeting(null)}>Cancel</Btn>
              <Btn
                primary
                disabled={addMemberSelected.length === 0 || addMemberSubmitting}
                onClick={handleAddMembers}
              >
                {addMemberSubmitting
                  ? "Inviting…"
                  : `Invite (${addMemberSelected.length})`}
              </Btn>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 13, color: "var(--g600)" }}>
              Add members directly to this {meetingState(invitingMeeting, now) === "live" ? "ongoing" : "scheduled"} meeting. They will receive an instant invite card with a one-click Join action.
            </div>
            <input
              type="text"
              placeholder="Search people to add…"
              value={addMemberQuery}
              onChange={(e) => setAddMemberQuery(e.target.value)}
              style={inp}
              autoFocus
            />
            <div
              style={{
                maxHeight: 260,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {availablePeopleToAdd.length === 0 ? (
                <div
                  style={{
                    padding: "16px 0",
                    textAlign: "center",
                    color: "var(--g400)",
                    fontSize: 13,
                  }}
                >
                  No people found matching &ldquo;{addMemberQuery}&rdquo;
                </div>
              ) : (
                availablePeopleToAdd.map((p: any) => {
                  const isSelected = addMemberSelected.includes(p.id);
                  const alreadyIn = (invitingMeeting.attendees || []).some(
                    (a: any) => a.id === p.id || a.userId === p.id,
                  );
                  return (
                    <div
                      key={p.id}
                      onClick={() => {
                        if (alreadyIn) return;
                        setAddMemberSelected((prev) =>
                          isSelected
                            ? prev.filter((id) => id !== p.id)
                            : [...prev, p.id],
                        );
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 8,
                        cursor: alreadyIn ? "default" : "pointer",
                        opacity: alreadyIn ? 0.5 : 1,
                        background: isSelected
                          ? "color-mix(in srgb, var(--ac, #0ea5e9) 10%, transparent)"
                          : "transparent",
                        border: isSelected
                          ? "1px solid var(--ac, #0ea5e9)"
                          : "1px solid transparent",
                      }}
                    >
                      <Avatar avatar={av(p)} size={28} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: "var(--g800)",
                          }}
                        >
                          {p.name}
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--g500)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {p.email || p.title || "Colleague"}
                        </div>
                      </div>
                      {alreadyIn ? (
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--g500)",
                            fontWeight: 500,
                          }}
                        >
                          Already in meeting
                        </span>
                      ) : (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          readOnly
                          style={{ accentColor: "var(--ac, #0ea5e9)" }}
                        />
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </Modal>
      ) : null}

      {/* CNCL-02: Cancel Meeting Confirmation Modal with optional Note */}
      {cancelModalMeeting ? (
        <Modal
          title={`Cancel "${cancelModalMeeting.title || "Meeting"}"`}
          onClose={() => { setCancelModalMeeting(null); setCancelScope("occurrence"); }}
          footer={
            <>
              <Btn onClick={() => { setCancelModalMeeting(null); setCancelScope("occurrence"); }}>Keep meeting</Btn>
              <Btn
                danger
                disabled={cancelSubmitting}
                onClick={async () => {
                  setCancelSubmitting(true);
                  try {
                    const id = cleanId(cancelModalMeeting.meetingId || cancelModalMeeting.id);
                    // CNCL-01: for a recurring meeting the scope is explicit —
                    // one occurrence (exclusion, series untouched) or the series.
                    const occurrenceOnly =
                      cancelModalMeeting.recurrence &&
                      cancelModalMeeting.recurrence !== "none" &&
                      cancelScope === "occurrence";
                    if (onDelete) {
                      await onDelete(
                        id,
                        cancelNote.trim() || undefined,
                        occurrenceOnly
                          ? {
                              scope: "occurrence",
                              occurrenceStartsAt:
                                cancelModalMeeting.occurrenceKey ||
                                cancelModalMeeting.startsAt,
                            }
                          : undefined,
                      );
                    }
                    onToast &&
                      onToast(occurrenceOnly ? "Occurrence cancelled" : "Meeting cancelled");
                    setCancelModalMeeting(null);
                  } catch (e: any) {
                    onToast && onToast((e && e.message) || "Couldn't cancel meeting");
                  } finally {
                    setCancelSubmitting(false);
                  }
                }}
              >
                {cancelSubmitting
                  ? "Cancelling…"
                  : cancelModalMeeting.recurrence && cancelModalMeeting.recurrence !== "none" && cancelScope === "occurrence"
                    ? "Cancel occurrence"
                    : "Cancel meeting"}
              </Btn>
            </>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 13, color: "var(--g700)" }}>
              {cancelModalMeeting.recurrence && cancelModalMeeting.recurrence !== "none" && cancelScope === "occurrence"
                ? "Cancel only this occurrence? The rest of the series — and everything already in the meeting chat — stays."
                : "Are you sure you want to cancel this meeting? The join link will be deactivated and all attendees will receive a cancellation notice."}
            </div>
            {/* CNCL-01/02: recurring → say exactly WHAT will be cancelled. */}
            {cancelModalMeeting.recurrence && cancelModalMeeting.recurrence !== "none" ? (
              <div style={{ display: "flex", gap: 8 }}>
                {([
                  ["occurrence", "This occurrence"],
                  ["series", "Entire series"],
                ] as Array<[string, string]>).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    className={"btn " + (cancelScope === v ? "btn-primary" : "btn-secondary")}
                    style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12 }}
                    onClick={() => setCancelScope(v as any)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--g600)" }}>
                Note to attendees (optional):
              </span>
              <textarea
                placeholder="Explain why this meeting was cancelled or suggest next steps…"
                value={cancelNote}
                onChange={(e) => setCancelNote(e.target.value)}
                style={{
                  ...inp,
                  minHeight: 70,
                  resize: "vertical",
                  fontFamily: "inherit",
                }}
              />
            </label>
          </div>
        </Modal>
      ) : null}

      {/* RSCH-02 / RCR-20: Edit Recurring Meeting Scope Modal */}
      {recurringScopeModal ? (
        <Modal
          title="Edit recurring meeting"
          onClose={() => setRecurringScopeModal(null)}
          footer={
            <Btn onClick={() => setRecurringScopeModal(null)}>Cancel</Btn>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ fontSize: 13, color: "var(--g700)" }}>
              {recurringScopeModal.displayNext
                ? `Move this meeting to ${recurringScopeModal.displayNext}?`
                : `Save changes to "${recurringScopeModal.ev?.title || "Meeting"}"?`}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 3,
                  borderRadius: 8,
                  textAlign: "left",
                  border: "1px solid var(--g200, rgba(255,255,255,0.12))",
                  cursor: "pointer",
                }}
                onClick={async () => {
                  const { ev, targetIso, payload } = recurringScopeModal;
                  setRecurringScopeModal(null);
                  try {
                    // RSCH-02/RCR-20: name WHICH occurrence is being edited —
                    // occurrenceKey is its stable original-day identity; the
                    // display start is the fallback for older payloads.
                    const occId = {
                      occurrenceScope: "single",
                      occurrenceKey: ev.occurrenceKey || undefined,
                      occurrenceStartsAt: ev.startsAt || undefined,
                    };
                    if (targetIso) {
                      await onUpdate(ev.id, { startsAt: targetIso, ...occId });
                    } else if (payload) {
                      await onUpdate(ev.id, { ...payload, ...occId });
                      close();
                    }
                    onToast && onToast("This occurrence updated");
                  } catch (e: any) {
                    onToast && onToast((e && e.message) || "Update failed");
                  }
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 13 }}>This event only</span>
                <span style={{ fontSize: 11, opacity: 0.75 }}>
                  Change only this single occurrence. Other occurrences in the series remain unchanged.
                </span>
              </button>

              {/* RCR-22: split the series — the past keeps its schedule, the
                  future carries the edit, one shared meeting chat. */}
              <button
                type="button"
                className="btn btn-secondary"
                style={{
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 3,
                  borderRadius: 8,
                  textAlign: "left",
                  border: "1px solid var(--g200, rgba(255,255,255,0.12))",
                  cursor: "pointer",
                }}
                onClick={async () => {
                  const { ev, targetIso, payload } = recurringScopeModal;
                  setRecurringScopeModal(null);
                  try {
                    const seriesId = cleanId(ev.meetingId || ev.seriesId || ev.id);
                    const occId = {
                      occurrenceScope: "following",
                      occurrenceKey: ev.occurrenceKey || undefined,
                      occurrenceStartsAt: ev.startsAt || undefined,
                    };
                    if (targetIso) {
                      await onUpdate(seriesId, { startsAt: targetIso, ...occId });
                    } else if (payload) {
                      await onUpdate(seriesId, { ...payload, ...occId });
                      close();
                    }
                    onToast && onToast("This and all following occurrences updated");
                  } catch (e: any) {
                    onToast && onToast((e && e.message) || "Update failed");
                  }
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 13 }}>This and all following</span>
                <span style={{ fontSize: 11, opacity: 0.75 }}>
                  Change this occurrence and everything after it. Earlier occurrences keep their schedule; the meeting chat stays shared.
                </span>
              </button>

              <button
                type="button"
                className="btn btn-primary"
                style={{
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 3,
                  borderRadius: 8,
                  textAlign: "left",
                  cursor: "pointer",
                }}
                onClick={async () => {
                  const { ev, targetIso, payload } = recurringScopeModal;
                  setRecurringScopeModal(null);
                  try {
                    const seriesId = cleanId(ev.meetingId || ev.seriesId || ev.id);
                    if (targetIso) {
                      await onUpdate(seriesId, { startsAt: targetIso });
                    } else if (payload) {
                      await onUpdate(seriesId, payload);
                      close();
                    }
                    onToast && onToast("All events in series updated");
                  } catch (e: any) {
                    onToast && onToast((e && e.message) || "Update failed");
                  }
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 13 }}>All events in series</span>
                <span style={{ fontSize: 11, opacity: 0.85 }}>
                  Apply changes to every occurrence in this recurring series.
                </span>
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
