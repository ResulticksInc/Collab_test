// DST-correct wall-clock <-> UTC helpers for the recurrence engines (AUDIT #31).
//
// The FIRST occurrence of a reminder/meeting is already computed zone-correctly by
// reminderNL. But occurrences #2..N were built from SERVER-LOCAL wall-clock fields
// (getHours()) + Date(year,month,day,...) constructors, so a series drifted ±1h
// after each DST transition. These helpers let the expanders build every occurrence
// from the SERIES timezone's civil fields and convert back to a UTC instant.
//
// Standalone (mirrors reminderNL's private logic) rather than importing it, so this
// carries ZERO risk to the well-tested first-occurrence path. CRITICAL invariant:
// when `timeZone` is null/empty, every function reproduces the EXACT legacy
// server-local behaviour, so un-migrated rows (timezone NULL) are byte-identical.

export interface Civil {
  y: number;
  mo: number; // 0-based month, matching Date.getMonth()
  d: number;
  hh: number;
  mm: number;
  ss: number;
  dow: number; // 0=Sun..6=Sat
}

// Minutes to ADD to a UTC instant to get the zone's wall clock (opposite sign of
// Date.getTimezoneOffset). Intl-only, DST-correct. null if the zone is invalid.
export function zoneOffsetMinutes(timeZone: string, atUtcMs: number): number | null {
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

// Build the UTC instant for a wall-clock Y/M/D hh:mm:ss in `timeZone`. Resolves the
// offset AT that wall clock (DST-aware, with one refine pass across a transition).
// timeZone null/invalid → legacy server-local Date constructor (identical to
// `new Date(y, mo, d, hh, mm, ss)`), preserving current behaviour exactly.
export function wallClockToInstant(
  y: number,
  mo: number,
  d: number,
  hh: number,
  mm: number,
  ss: number,
  timeZone: string | null | undefined,
): Date {
  if (timeZone) {
    const naiveUtc = Date.UTC(y, mo, d, hh, mm, ss, 0);
    const off = zoneOffsetMinutes(timeZone, naiveUtc);
    if (off != null) {
      let instant = naiveUtc - off * 60000;
      const off2 = zoneOffsetMinutes(timeZone, instant);
      if (off2 != null && off2 !== off) instant = naiveUtc - off2 * 60000;
      return new Date(instant);
    }
    // invalid zone → fall through to legacy
  }
  return new Date(y, mo, d, hh, mm, ss, 0);
}

// Read an instant's civil fields IN `timeZone`. timeZone null/invalid → server-local
// getters (identical to instant.getHours() etc.), preserving current behaviour.
export function civilFields(instant: Date, timeZone: string | null | undefined): Civil {
  if (timeZone) {
    try {
      const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const parts = dtf.formatToParts(instant);
      const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
      const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return {
        y: Number(get("year")),
        mo: Number(get("month")) - 1,
        d: Number(get("day")),
        hh: Number(get("hour")),
        mm: Number(get("minute")),
        ss: Number(get("second")),
        dow: DOW[get("weekday")] ?? instant.getUTCDay(),
      };
    } catch {
      /* invalid zone → legacy */
    }
  }
  return {
    y: instant.getFullYear(),
    mo: instant.getMonth(),
    d: instant.getDate(),
    hh: instant.getHours(),
    mm: instant.getMinutes(),
    ss: instant.getSeconds(),
    dow: instant.getDay(),
  };
}

// Advance a civil calendar date by N days (normalising month/year/weekday) via a
// UTC scratch date so DST never miscounts days. Preserves hh:mm:ss.
export function addCivilDays(c: Civil, days: number): Civil {
  const s = new Date(Date.UTC(c.y, c.mo, c.d, 12, 0, 0));
  s.setUTCDate(s.getUTCDate() + days);
  return {
    y: s.getUTCFullYear(),
    mo: s.getUTCMonth(),
    d: s.getUTCDate(),
    hh: c.hh,
    mm: c.mm,
    ss: c.ss,
    dow: s.getUTCDay(),
  };
}
