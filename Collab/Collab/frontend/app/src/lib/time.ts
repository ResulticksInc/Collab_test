// Local-timezone time formatting.
//
// The backend pre-formats some timestamps (conversation `time`, message `time`,
// etc.) with toLocaleTimeString on the SERVER, which uses the server's timezone
// (UTC in production). Displaying those strings mixes UTC with the browser-local
// times that other views compute from the raw ISO `createdAt`. The fix: ALWAYS
// format from the raw ISO string in the browser, so every timestamp shows in the
// viewer's own local timezone. Use these helpers instead of the server `time`.

// Timezone preference (Settings › Language & Region). "auto"/empty = follow the OS
// zone. Stored module-level so these pure formatters read it without threading the
// settings object through every call site; CoLabV1 calls setTimeZonePref when
// settings load/change. Every helper below spreads zoneOpt() so a user who picks an
// explicit zone sees all times rendered in it.
let _tz: string | undefined = undefined; // undefined = auto (OS zone)
export function setTimeZonePref(tz: string | null | undefined): void {
  _tz = tz && tz !== "auto" ? tz : undefined;
}
/** The explicitly chosen zone, or "" when following the OS ("auto"). */
export function getTimeZonePref(): string {
  return _tz || "";
}
function zoneOpt(): Intl.DateTimeFormatOptions {
  return _tz ? { timeZone: _tz } : {};
}

/** "3:45 PM" / "15:45" in the viewer's chosen (or OS) timezone. fmt: "12h" | "24h". */
export function localTime(iso: string | number | Date, fmt: string = "12h"): string {
  const d = new Date(iso as any);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: fmt !== "24h",
    ...zoneOpt(),
  });
}

/** "Mon, Jun 23" in the viewer's chosen (or OS) timezone. */
export function localDay(iso: string | number | Date): string {
  const d = new Date(iso as any);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...zoneOpt(),
  });
}

/**
 * Conversation-list timestamp (WhatsApp/Teams style), local timezone:
 *   today      -> time ("3:45 PM")
 *   yesterday  -> "Yesterday"
 *   this week  -> weekday ("Mon")
 *   older      -> short date ("Jun 23" / "6/23/24")
 */
export function sidebarTime(iso: string | number | Date, fmt: string = "12h"): string {
  const d = new Date(iso as any);
  if (!Number.isFinite(d.getTime())) return "";
  const now = new Date();
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (dayDiff <= 0) return localTime(d, fmt);
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return d.toLocaleDateString([], { weekday: "short", ...zoneOpt() });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString([], { month: "short", day: "numeric", ...zoneOpt() });
  return d.toLocaleDateString([], {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    ...zoneOpt(),
  });
}
