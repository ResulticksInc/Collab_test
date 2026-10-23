// Shared timezone catalogue + helpers.
//
// One curated list, used by BOTH Settings › Language & Region and the meeting
// scheduler, so the two can never offer different zones. Rather than the full
// ~400-entry IANA database (which is mostly obscure aliases and duplicates),
// this is a representative set — one zone per meaningful UTC offset, keyed to a
// major city — the same shape Slack/Google/Microsoft show.

export const ENTERPRISE_ZONES: string[] = [
  "Pacific/Midway", "Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles",
  "America/Tijuana", "America/Denver", "America/Phoenix", "America/Chicago",
  "America/Mexico_City", "America/Guatemala", "America/New_York", "America/Toronto",
  "America/Bogota", "America/Lima", "America/Caracas", "America/Halifax",
  "America/Santiago", "America/Sao_Paulo", "America/Argentina/Buenos_Aires",
  "Atlantic/South_Georgia", "Atlantic/Azores", "Atlantic/Cape_Verde", "UTC",
  "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Africa/Casablanca",
  "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam",
  "Europe/Zurich", "Europe/Stockholm", "Europe/Warsaw", "Africa/Lagos",
  "Africa/Johannesburg", "Europe/Athens", "Europe/Helsinki", "Europe/Bucharest",
  "Africa/Cairo", "Africa/Nairobi", "Europe/Istanbul", "Europe/Moscow",
  "Asia/Riyadh", "Asia/Tehran", "Asia/Dubai", "Asia/Baku", "Asia/Kabul",
  "Asia/Karachi", "Asia/Tashkent", "Asia/Kolkata", "Asia/Colombo", "Asia/Kathmandu",
  "Asia/Dhaka", "Asia/Yangon", "Asia/Bangkok", "Asia/Jakarta", "Asia/Shanghai",
  "Asia/Hong_Kong", "Asia/Singapore", "Asia/Kuala_Lumpur", "Asia/Manila",
  "Asia/Taipei", "Asia/Tokyo", "Asia/Seoul", "Australia/Perth", "Australia/Adelaide",
  "Australia/Sydney", "Australia/Brisbane", "Pacific/Guam", "Pacific/Noumea",
  "Pacific/Auckland", "Pacific/Fiji", "Pacific/Tongatapu",
];

// Zones no common English locale abbreviates — Intl answers "GMT+8" for these,
// which is exactly the label people did NOT want to see. Standard-time forms;
// zones in this map either do not observe DST or are not commonly written with a
// separate summer abbreviation in English.
const ABBR_FALLBACK: Record<string, string> = {
  "Asia/Tokyo": "JST", "Asia/Seoul": "KST", "Asia/Shanghai": "CST",
  "Asia/Hong_Kong": "HKT", "Asia/Taipei": "CST", "Asia/Singapore": "SGT",
  "Asia/Kuala_Lumpur": "MYT", "Asia/Jakarta": "WIB", "Asia/Manila": "PHT",
  "Asia/Bangkok": "ICT", "Asia/Yangon": "MMT", "Asia/Dhaka": "BST",
  "Asia/Kathmandu": "NPT", "Asia/Colombo": "IST", "Asia/Karachi": "PKT",
  "Asia/Tashkent": "UZT", "Asia/Kabul": "AFT", "Asia/Baku": "AZT",
  "Asia/Tehran": "IRST", "Asia/Dubai": "GST", "Asia/Riyadh": "AST",
  "Europe/Moscow": "MSK", "Europe/Istanbul": "TRT",
  "Africa/Lagos": "WAT", "Africa/Nairobi": "EAT", "Africa/Cairo": "EET",
  "Africa/Johannesburg": "SAST",
  "America/Bogota": "COT", "America/Lima": "PET", "America/Caracas": "VET",
  "America/Santiago": "CLT", "America/Sao_Paulo": "BRT",
  "America/Argentina/Buenos_Aires": "ART",
  "Pacific/Guam": "ChST", "Pacific/Noumea": "NCT", "Pacific/Fiji": "FJT",
  "Pacific/Tongatapu": "TOT", "Pacific/Midway": "SST",
  "Atlantic/Azores": "AZOT", "Atlantic/Cape_Verde": "CVT",
};

// Tried in order for the live abbreviation. Different English locales know
// different regional abbreviations — en-GB knows BST/EST, en-AU knows AEDT,
// en-IN knows IST — so the first locale that answers with a real abbreviation
// (rather than a numeric offset) wins.
const ABBR_LOCALES = ["en-GB", "en-AU", "en-NZ", "en-IN", "en-US"];

// "GMT+5:30" / "+05:30" are offsets, not abbreviations. Bare "GMT" and "UTC"
// ARE abbreviations (London in winter), so they must not be rejected.
const isOffsetForm = (v: string) => /^(?:GMT|UTC)[+\-−]/.test(v) || /^[+\-−]\d/.test(v);

/** The zone's live abbreviation — "IST", "SGT", "EDT", "AEDT". DST-aware. */
export function tzAbbr(tz: string, at: Date = new Date()): string {
  for (const loc of ABBR_LOCALES) {
    try {
      const parts = new Intl.DateTimeFormat(loc, {
        timeZone: tz,
        timeZoneName: "short",
      }).formatToParts(at);
      const v = (parts.find((p) => p.type === "timeZoneName") || ({} as any)).value || "";
      if (v && !isOffsetForm(v)) return v;
    } catch {
      /* unknown zone — fall through */
    }
  }
  return ABBR_FALLBACK[tz] || tzOffsetLabel(tz, at);
}

/** Minutes east of UTC for `tz` at `at` (DST-aware). */
export function tzOffsetMinutes(tz: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(at);
    const p: Record<string, string> = {};
    for (const x of parts) p[x.type] = x.value;
    const asUTC = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour) % 24,
      Number(p.minute),
      Number(p.second),
    );
    return Math.round((asUTC - at.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** "UTC+05:30" — always signed, always padded. */
export function tzOffsetLabel(tz: string, at: Date = new Date()): string {
  const off = tzOffsetMinutes(tz, at);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return (
    "UTC" + sign + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0")
  );
}

/** "Asia/Kolkata" -> "Kolkata". The city is the part people recognise. */
export function tzCity(tz: string): string {
  return (String(tz).split("/").pop() || String(tz)).replace(/_/g, " ");
}

export interface TzOption {
  tz: string;
  abbr: string;
  city: string;
  offsetLabel: string;
  offsetMin: number;
}

/**
 * The picker list, sorted west→east. `extra` (the zone a meeting was created in,
 * or a device zone outside the curated set) is folded in so a saved value is
 * never silently dropped from the list that is supposed to contain it.
 */
export function tzOptions(extra?: string | null, at: Date = new Date()): TzOption[] {
  const zones = ENTERPRISE_ZONES.slice();
  if (extra && !zones.includes(extra)) {
    try {
      // Reject a bad string here rather than rendering a broken row.
      new Intl.DateTimeFormat("en-US", { timeZone: extra });
      zones.push(extra);
    } catch {
      /* not a real zone — leave it out */
    }
  }
  return zones
    .map((tz) => ({
      tz,
      abbr: tzAbbr(tz, at),
      city: tzCity(tz),
      offsetLabel: tzOffsetLabel(tz, at),
      offsetMin: tzOffsetMinutes(tz, at),
    }))
    .sort((a, b) => a.offsetMin - b.offsetMin || a.city.localeCompare(b.city));
}

/** This device's IANA zone, e.g. "Asia/Kolkata". "" when Intl is unavailable. */
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/**
 * Turn a wall-clock date + time IN `tz` into the absolute instant.
 *
 * `new Date("2026-09-05T12:30")` reads the string in the BROWSER's zone, so a
 * host in Chennai scheduling "12:30 SGT" would otherwise create a meeting at
 * 12:30 IST. Two passes converge even when the guess lands on the far side of a
 * DST transition (the first pass' offset is re-read at the corrected instant).
 */
export function zonedWallTimeToUtc(
  dateStr: string,
  timeStr: string,
  tz: string,
): Date {
  const [Y, M, D] = String(dateStr).split("-").map(Number);
  const [h, m] = String(timeStr).split(":").map(Number);
  const wall = Date.UTC(Y, (M || 1) - 1, D || 1, h || 0, m || 0, 0);
  if (!Number.isFinite(wall)) return new Date(NaN);
  if (!tz) return new Date(`${dateStr}T${timeStr}`);
  let ts = wall;
  for (let i = 0; i < 2; i++) ts = wall - tzOffsetMinutes(tz, new Date(ts)) * 60000;
  return new Date(ts);
}

/** The inverse: the wall-clock {date,time} that `at` shows as in `tz`. */
export function utcToZonedWallTime(
  at: Date,
  tz: string,
): { date: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (!tz || !Number.isFinite(at.getTime()))
    return {
      date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
      time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    };
  const shifted = new Date(at.getTime() + tzOffsetMinutes(tz, at) * 60000);
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  };
}
