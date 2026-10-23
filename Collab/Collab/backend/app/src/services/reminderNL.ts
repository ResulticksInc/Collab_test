// NATURAL-LANGUAGE QUICK-ADD parser for reminders (feature #53). Hand-rolled,
// dependency-free, lightweight. Parses a single line of plain English into a
// reminder draft: { text, dueAt, recurrence, recurrenceRule, ambiguous }.
//
// NO LLM / paid API / heavy dep — just small regexes over relative dates, clock
// times, weekdays, and "every X" recurrence. Deliberately conservative: when it
// can't confidently extract a time it leaves dueAt null and flags `ambiguous` so
// the caller can open the full modal pre-filled instead of silently guessing.
// The SERVER still validates the resulting draft (validateText / validateDueAt /
// validateRecurrence / validateRecurrenceRule) — this parser never bypasses that.
//
// Pure (no DB / transport), so it's trivially unit-testable. `now` is injectable
// for deterministic tests. It NEVER touches the call/meeting media path.

import type { RecurrenceRule } from "./recurrenceRule";

// TIMEZONE-CORRECT wall-clock resolution (#53). The parser must produce a UTC
// instant that matches what the USER typed in THEIR timezone, not the server's.
// On the production box (UTC) "3pm" must mean 3pm in the user's zone (e.g. IST),
// not 3pm UTC. We accept an IANA zone name (e.g. "Asia/Kolkata") OR a numeric
// minutes offset (Date.getTimezoneOffset() convention: minutes to ADD to local to
// get UTC, i.e. positive WEST of UTC). When neither is given we fall back to the
// server-local Date constructor (unchanged legacy behaviour for callers that don't
// thread a zone).
export interface ParseOptions {
  now?: Date;
  // IANA timezone, e.g. "Asia/Kolkata". Preferred — it tracks DST.
  timeZone?: string | null;
  // Fallback: fixed offset in minutes, JS getTimezoneOffset() sign (UTC = local +
  // offset). Used only when timeZone is absent/invalid.
  tzOffsetMinutes?: number | null;
}

// The UTC offset (minutes to ADD to UTC to reach local wall-clock, i.e. the
// OPPOSITE sign of Date.getTimezoneOffset) for an IANA zone at a given instant.
// Uses Intl only — no dependency, DST-correct. Returns null if the zone is invalid.
function zoneOffsetMinutes(timeZone: string, atUtcMs: number): number | null {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(atUtcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    return Math.round((asUtc - atUtcMs) / 60000);
  } catch {
    return null;
  }
}

// Build the UTC instant for a wall-clock Y/M/D hh:mm in the user's zone. For an
// IANA zone we resolve the offset AT that wall-clock (handling DST, with one refine
// pass across a DST boundary). For a fixed numeric offset we apply it directly. With
// no zone we keep the legacy server-local Date constructor.
function wallClockToInstant(
  y: number,
  mo: number,
  d: number,
  hh: number,
  mm: number,
  tz: { timeZone?: string | null; tzOffsetMinutes?: number | null },
): Date {
  if (tz.timeZone) {
    // First guess: treat the wall-clock as if it were UTC, find the zone offset
    // there, subtract it, then refine once (the offset can differ if the naive
    // guess fell on the other side of a DST transition).
    const naiveUtc = Date.UTC(y, mo, d, hh, mm, 0, 0);
    let off = zoneOffsetMinutes(tz.timeZone, naiveUtc);
    if (off != null) {
      let instant = naiveUtc - off * 60000;
      const off2 = zoneOffsetMinutes(tz.timeZone, instant);
      if (off2 != null && off2 !== off) instant = naiveUtc - off2 * 60000;
      return new Date(instant);
    }
    // invalid zone → fall through to offset / legacy
  }
  if (tz.tzOffsetMinutes != null && Number.isFinite(tz.tzOffsetMinutes)) {
    // getTimezoneOffset sign: UTC = local + offsetMinutes, so the wall-clock
    // (interpreted as UTC) plus the offset gives the real UTC instant.
    return new Date(Date.UTC(y, mo, d, hh, mm, 0, 0) + tz.tzOffsetMinutes * 60000);
  }
  // Legacy: server-local wall clock.
  return new Date(y, mo, d, hh, mm, 0, 0);
}

export interface ParsedReminder {
  text: string;
  dueAt: string | null;
  recurrence: "none" | "daily" | "weekly" | "monthly";
  recurrenceRule: RecurrenceRule | null;
  // True when we parsed *something* but couldn't pin a time/date confidently, so
  // the UI should open the full modal pre-filled rather than create blindly.
  ambiguous: boolean;
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

// Parse a clock time like "3pm", "3:30 pm", "15:00", "9am", "noon", "midnight".
// Returns { hh, mm } in 24h, or null. `matched` is the substring to strip.
function parseClock(s: string): { hh: number; mm: number; matched: string } | null {
  const lower = s.toLowerCase();
  if (/\bnoon\b/.test(lower)) return { hh: 12, mm: 0, matched: (lower.match(/\bnoon\b/) || [""])[0] };
  if (/\bmidnight\b/.test(lower)) return { hh: 0, mm: 0, matched: (lower.match(/\bmidnight\b/) || [""])[0] };
  // "at 3", "at 3pm", "3:30pm", "15:00", "9 am"
  const m = lower.match(/(?:\bat\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const ap = m[3];
  if (hh > 23 || mm > 59) return null;
  // A bare number with no am/pm and no colon (e.g. "call 5") is too ambiguous to
  // treat as a time unless it was clearly "at N".
  if (!ap && !m[2] && !/\bat\s+\d/.test(lower)) return null;
  if (ap === "pm" && hh < 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  return { hh, mm, matched: m[0] };
}

const RELATIVE_DAY: Record<string, number> = { today: 0, tomorrow: 1, tonight: 0 };

// The user-zone CIVIL wall clock for an instant: the year/month/day/hour/minute/
// weekday the user would read off their clock. We do all calendar math (today,
// tomorrow, next-weekday, clock-already-passed) on these civil fields so a non-UTC
// user on a UTC server gets the right DAY and the right "already passed" decision,
// then convert the resolved wall clock back to a UTC instant via wallClockToInstant.
// With no zone we fall back to the server-local getters (legacy behaviour).
interface Civil { y: number; mo: number; d: number; hh: number; mm: number; dow: number; }
function civilNow(now: Date, tz: { timeZone?: string | null; tzOffsetMinutes?: number | null }): Civil {
  if (tz.timeZone) {
    try {
      const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: tz.timeZone, hourCycle: "h23", weekday: "short",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      });
      const parts = dtf.formatToParts(now);
      const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
      const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return {
        y: Number(get("year")), mo: Number(get("month")) - 1, d: Number(get("day")),
        hh: Number(get("hour")), mm: Number(get("minute")), dow: DOW[get("weekday")] ?? now.getUTCDay(),
      };
    } catch { /* invalid zone → offset / legacy */ }
  }
  if (tz.tzOffsetMinutes != null && Number.isFinite(tz.tzOffsetMinutes)) {
    // Shift the instant by the offset and read UTC fields to get the civil clock.
    const shifted = new Date(now.getTime() - tz.tzOffsetMinutes * 60000);
    return {
      y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate(),
      hh: shifted.getUTCHours(), mm: shifted.getUTCMinutes(), dow: shifted.getUTCDay(),
    };
  }
  return {
    y: now.getFullYear(), mo: now.getMonth(), d: now.getDate(),
    hh: now.getHours(), mm: now.getMinutes(), dow: now.getDay(),
  };
}

// Advance a civil date by N calendar days (normalising month/year + weekday) using
// a UTC scratch date so DST never shifts the day count.
function addCivilDays(c: Civil, days: number): Civil {
  const s = new Date(Date.UTC(c.y, c.mo, c.d, 12, 0, 0));
  s.setUTCDate(s.getUTCDate() + days);
  return { y: s.getUTCFullYear(), mo: s.getUTCMonth(), d: s.getUTCDate(), hh: c.hh, mm: c.mm, dow: s.getUTCDay() };
}

// Main entry. Returns a draft, or null if the input has no usable reminder text.
// `opts` may be a legacy `now: Date` (back-compat) or a {now,timeZone,tzOffsetMinutes}
// options object. When a zone is provided, clock/relative times resolve in the
// USER's timezone instead of the server's — critical on a UTC production box.
export function parseReminder(
  input: string,
  opts: Date | ParseOptions = {},
): ParsedReminder | null {
  const o: ParseOptions = opts instanceof Date ? { now: opts } : (opts || {});
  const now: Date = o.now || new Date();
  const tz = { timeZone: o.timeZone ?? null, tzOffsetMinutes: o.tzOffsetMinutes ?? null };
  // Resolve a wall clock (in the user's zone) to a UTC Date instant.
  const at = (y: number, mo: number, d: number, hh: number, mm: number): Date =>
    wallClockToInstant(y, mo, d, hh, mm, tz);
  const cnow = civilNow(now, tz);
  const raw = (input || "").trim();
  if (!raw) return null;
  let text = raw;
  let consumed = false; // did we extract any date/time/recurrence signal?
  let dueAt: string | null = null;
  let recurrence: ParsedReminder["recurrence"] = "none";
  let recurrenceRule: RecurrenceRule | null = null;

  const lower = raw.toLowerCase();

  // --- RECURRENCE: "every day", "every monday", "every 2 weeks", "daily", … ----
  // Capture the recurrence phrase and the (optional) weekday it pins.
  let recWeekday: number | null = null;
  let recWeekdaySet: number[] | null = null; // multi-day set for "every weekday/weekend"
  // "every weekday" (Mon-Fri) / "every weekend" (Sat-Sun) FIRST — these multi-day
  // phrases must win over the single-unit matcher below (which has no "weekday"
  // alternative and would otherwise leave the literal word in the text and create a
  // wrong one-off). Map to a weekly rule over the right day set.
  const everySetMatch = lower.match(/\bevery\s+(weekdays?|weekends?)\b/);
  if (everySetMatch) {
    const isWeekend = /weekend/.test(everySetMatch[1]);
    recWeekdaySet = isWeekend ? [0, 6] : [1, 2, 3, 4, 5];
    recurrence = "weekly";
    recurrenceRule = { freq: "weekly", interval: 1, byWeekday: recWeekdaySet, end: { type: "never" } };
    consumed = true;
    text = stripFirst(text, everySetMatch[0]);
  }
  const everyMatch = !everySetMatch
    ? lower.match(
        /\bevery\s+(\d+)?\s*(day|days|week|weeks|month|months|year|years|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/,
      )
    : null;
  if (everyMatch) {
    // Clamp the parsed interval to the validator's 1–999 bound. parseInt of a huge
    // digit string yields Infinity; Math.min(Infinity, 999) collapses it to the max
    // (NaN — e.g. no digits — falls back to 1). Defense-in-depth so the parser never
    // emits an out-of-range rule even before validateRecurrenceRule runs.
    const rawN = everyMatch[1] ? parseInt(everyMatch[1], 10) : 1;
    const interval = Number.isNaN(rawN) ? 1 : Math.min(Math.max(1, rawN), 999);
    const unit = everyMatch[2];
    if (unit in WEEKDAYS) {
      recurrence = "weekly";
      recWeekday = WEEKDAYS[unit];
      recurrenceRule = { freq: "weekly", interval, byWeekday: [recWeekday], end: { type: "never" } };
    } else if (/^day/.test(unit)) {
      recurrence = "daily";
      recurrenceRule = { freq: "daily", interval, end: { type: "never" } };
    } else if (/^week/.test(unit)) {
      recurrence = "weekly";
      recurrenceRule = { freq: "weekly", interval, end: { type: "never" } };
    } else if (/^month/.test(unit)) {
      recurrence = "monthly";
      recurrenceRule = { freq: "monthly", interval, monthlyMode: "day", end: { type: "never" } };
    } else if (/^year/.test(unit)) {
      // No simple-enum equivalent for yearly; keep the structured rule, leave the
      // legacy enum at the closest fallback ("monthly" would be wrong) — use
      // "none" so the structured rule is the sole driver.
      recurrence = "none";
      recurrenceRule = { freq: "yearly", interval, monthlyMode: "day", end: { type: "never" } };
    }
    consumed = true;
    text = stripFirst(text, everyMatch[0]);
  } else {
    const simple = lower.match(/\b(daily|weekly|monthly|yearly)\b/);
    if (simple) {
      const w = simple[1];
      if (w === "daily") { recurrence = "daily"; recurrenceRule = { freq: "daily", interval: 1, end: { type: "never" } }; }
      else if (w === "weekly") { recurrence = "weekly"; recurrenceRule = { freq: "weekly", interval: 1, end: { type: "never" } }; }
      else if (w === "monthly") { recurrence = "monthly"; recurrenceRule = { freq: "monthly", interval: 1, monthlyMode: "day", end: { type: "never" } }; }
      else { recurrence = "none"; recurrenceRule = { freq: "yearly", interval: 1, monthlyMode: "day", end: { type: "never" } }; }
      consumed = true;
      text = stripFirst(text, simple[0]);
    }
  }

  // --- DATE: relative day ("today"/"tomorrow"/"tonight"), "next <weekday>",
  // bare "<weekday>", "in N days/weeks". All calendar math runs on the USER's civil
  // clock (cnow); the resolved wall clock is converted to a UTC instant by at(). ---
  let baseDate: Date | null = null;
  const clock = parseClock(lower);
  const hh = clock ? clock.hh : 9; // default 9:00 when only a day is given
  const mm = clock ? clock.mm : 0;
  // Is the civil now already at/past hh:mm today (for "passed" decisions)?
  const passedToday = cnow.hh > hh || (cnow.hh === hh && cnow.mm >= mm);
  if (lower.includes("tonight") && !clock) {
    // "tonight" with no explicit clock → 8pm today (user-zone)
    baseDate = at(cnow.y, cnow.mo, cnow.d, 20, 0);
    consumed = true;
    text = stripFirst(text, "tonight");
  }

  const relDay = Object.keys(RELATIVE_DAY).find((k) => new RegExp("\\b" + k + "\\b").test(lower));
  const inMatch = lower.match(/\bin\s+(\d+)\s+(day|days|week|weeks|hour|hours|min|mins|minute|minutes)\b/);
  const nextWk = lower.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/);
  const bareWk = !nextWk ? lower.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/) : null;

  if (!baseDate && inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    if (/^hour/.test(unit)) { baseDate = new Date(now.getTime() + n * 3600000); }
    else if (/^min/.test(unit)) { baseDate = new Date(now.getTime() + n * 60000); }
    else if (/^week/.test(unit)) { const c = addCivilDays(cnow, n * 7); baseDate = at(c.y, c.mo, c.d, hh, mm); }
    else { const c = addCivilDays(cnow, n); baseDate = at(c.y, c.mo, c.d, hh, mm); }
    consumed = true;
    text = stripFirst(text, inMatch[0]);
  } else if (!baseDate && relDay) {
    const c = addCivilDays(cnow, RELATIVE_DAY[relDay]);
    baseDate = at(c.y, c.mo, c.d, hh, mm);
    consumed = true;
    text = stripFirst(text, relDay);
  } else if (!baseDate && (nextWk || bareWk || recWeekday != null || recWeekdaySet)) {
    // For an "every weekday/weekend" set, pin to the NEXT day in the set; otherwise
    // a single target weekday.
    const targetDays = recWeekdaySet
      ? recWeekdaySet
      : [nextWk ? WEEKDAYS[nextWk[1]] : bareWk ? WEEKDAYS[bareWk[1]] : (recWeekday as number)];
    let bestDelta = Infinity;
    for (const wd of targetDays) {
      let delta = (wd - cnow.dow + 7) % 7;
      // "next monday" / a recurring weekday always means the upcoming one; a bare
      // weekday (or set day) today rolls to next week if the time has already passed.
      if (delta === 0 && (nextWk || (clock && passedToday) || !clock)) delta = 7;
      if (delta < bestDelta) bestDelta = delta;
    }
    const c = addCivilDays(cnow, bestDelta);
    baseDate = at(c.y, c.mo, c.d, hh, mm);
    consumed = true;
    if (nextWk) text = stripFirst(text, nextWk[0]);
    else if (bareWk) text = stripFirst(text, bareWk[0]);
  } else if (!baseDate && clock) {
    // Just a clock, no day → today (user-zone) if still future, else tomorrow.
    let baseCivil = cnow;
    if (passedToday) baseCivil = addCivilDays(cnow, 1);
    baseDate = at(baseCivil.y, baseCivil.mo, baseCivil.d, hh, mm);
    consumed = true;
  }

  // Strip the recognized clock phrase from the text (after date handling so its
  // hh/mm were already applied).
  if (clock && clock.matched) text = stripFirst(text, clock.matched);

  if (baseDate && Number.isFinite(baseDate.getTime())) dueAt = baseDate.toISOString();

  // Clean up leftover filler the parse left behind ("remind me to", "to", dangling
  // prepositions, doubled spaces).
  text = cleanText(text);
  if (!text) text = cleanText(raw); // never lose the whole line

  // Ambiguous when we extracted *some* signal but couldn't land a concrete time,
  // or when after cleaning we have no text. The caller opens the modal pre-filled.
  const ambiguous = (consumed && !dueAt) || !text;

  return { text: text || raw, dueAt, recurrence, recurrenceRule, ambiguous };
}

// Remove the FIRST case-insensitive occurrence of `frag` from `text`.
function stripFirst(text: string, frag: string): string {
  if (!frag) return text;
  const i = text.toLowerCase().indexOf(frag.toLowerCase());
  if (i < 0) return text;
  return (text.slice(0, i) + text.slice(i + frag.length)).replace(/\s{2,}/g, " ").trim();
}

// Strip common reminder lead-ins + dangling connective words, tidy whitespace.
function cleanText(text: string): string {
  let t = (text || "").trim();
  t = t.replace(/^(remind\s+me\s+to|remind\s+me|reminder\s+to|remember\s+to|remind\s+to)\b/i, "").trim();
  // Drop a leading/trailing "to"/"at"/"on"/"every" left dangling by a strip.
  t = t.replace(/\b(at|on|by|every|next|in)\s*$/i, "").trim();
  t = t.replace(/^(to|at|on|by)\b\s*/i, "").trim();
  t = t.replace(/\s{2,}/g, " ").trim();
  // Strip a trailing/leading stray comma/preposition.
  t = t.replace(/^[,\-\s]+|[,\-\s]+$/g, "").trim();
  return t;
}
