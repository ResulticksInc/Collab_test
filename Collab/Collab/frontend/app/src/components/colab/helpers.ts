// Pure, self-contained helpers extracted from CoLabV1.tsx — decomposition step 1.
//
// Every export here is a PURE function or a frozen constant with NO dependency on
// CoLabV1's component state, props, hooks, or JSX. Moving them out of the
// 17.5k-line component shrinks the surface a reviewer/HMR/state-change has to
// reason about, with ZERO behaviour change: identical logic, and (for the frozen
// singletons) the SAME stable module reference. CoLabV1 imports them back.
//
// JSX-coupled helpers (e.g. notifIcon, which returns Lucide elements) intentionally
// stay in the component for now — a later step can extract those with their icon
// imports.

// Shared frozen empties so `x || EMPTY_ARR` keeps a STABLE identity across
// renders. Using a fresh `[]`/`{}` inline would hand ChatView a new prop every
// render and defeat its React.memo. Never mutate these.
export const EMPTY_ARR: any[] = Object.freeze([]) as any[];
export const EMPTY_OBJ: Record<string, any> = Object.freeze({}) as Record<string, any>;

// Standardized page header for every module. The shared top bar (.gx-topbar)
// renders this on the LEFT (title + optional subtitle) with the global search on
// the RIGHT — one compact row — so no module hand-rolls its own title row below,
// which is what wasted a whole row of vertical space per module. Keyed by `mode`.
// (chats has its own conversation header; dashboard owns a distinct centered
// landing layout — both intentionally absent here.)
export const MODULE_HEADERS: Record<string, { title: string; subtitle?: string }> = {
  calls: { title: "Calls", subtitle: "Active and recent" },
  contacts: { title: "Contacts", subtitle: "People in your workspace" },
  calendar: { title: "Calendar", subtitle: "Meetings and events" },
  meetings: { title: "Meetings", subtitle: "Meetings and events" },
  activity: {
    title: "Activity",
    subtitle: "Messages, calls, and meetings that need your attention",
  },
  tasks: { title: "Tasks", subtitle: "Track and manage your work" },
  reminders: { title: "Reminders", subtitle: "Stay on top of follow-ups" },
  files: { title: "Files", subtitle: "Shared across your workspace" },
  agents: { title: "Agents" },
  search: { title: "Search" },
  help: { title: "Help", subtitle: "Guides and answers" },
  settings: { title: "Settings", subtitle: "Manage your workspace and preferences" },
  org: { title: "Organization" },
};

// Which module a notification would open. Used to hide notifications that point
// at a switched-off module (see lib/hiddenModules) — clicking one used to land
// the user in Files, which they are not meant to be able to reach.
// Returns null when the destination is not a module-level target.
export function notifTargetModule(n: any): string | null {
  const t = String((n && n.type) || "");
  const target = String((n && n.targetType) || "");
  if (target === "file" || t === "file_shared") return "files";
  if (target === "reminder" || t === "reminder") return "reminders";
  if (target === "task" || t.startsWith("task_")) return "tasks";
  return null;
}

// A task is "mine" when I'm ANY of its assignees (multi-assignee, feature #50) —
// the new `assignees[]` array — falling back to the legacy single `assignee` for
// any row/payload that predates the array. Used by the dashboard/rail counts.
export function isMyTask(t: any, meId: any): boolean {
  if (!t || !meId) return false;
  if (Array.isArray(t.assignees) && t.assignees.length)
    return t.assignees.some((a: any) => a && a.id === meId);
  return !!(t.assignee && t.assignee.id === meId);
}

// Cross-browser fullscreen helpers (Chrome, Firefox, Safari vendor prefixes).
export function fsRequest(el: HTMLElement) {
  if (el.requestFullscreen) return el.requestFullscreen().catch(() => {});
  if ((el as any).webkitRequestFullscreen)
    return Promise.resolve((el as any).webkitRequestFullscreen());
  if ((el as any).mozRequestFullScreen)
    return Promise.resolve((el as any).mozRequestFullScreen());
  return Promise.resolve();
}
export function fsExit() {
  if (document.exitFullscreen) return document.exitFullscreen().catch(() => {});
  if ((document as any).webkitExitFullscreen)
    return Promise.resolve((document as any).webkitExitFullscreen());
  if ((document as any).mozCancelFullScreen)
    return Promise.resolve((document as any).mozCancelFullScreen());
  return Promise.resolve();
}
export function fsElement() {
  return (
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    (document as any).mozFullScreenElement ||
    null
  );
}

// Relative "active Nm ago" formatter for the max-devices / session list.
export function fmtWhen(v: any): string {
  const t = v ? new Date(v).getTime() : 0;
  if (!t || Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "active now";
  if (m < 60) return `active ${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `active ${h}h ago`;
  const d = Math.floor(h / 24);
  return `active ${d}d ago`;
}

// True when the current local time falls inside the user's quiet-hours window.
// Overnight windows (start > end, e.g. 22:00-07:00) are supported.
export function inQuietHours(s: any): boolean {
  if (!s || !s.quietHours) return false;
  const parse = (t: any, d: any) => {
    const [h, m] = String(t || d)
      .split(":")
      .map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const st = parse(s.quietStart, "22:00");
  const en = parse(s.quietEnd, "07:00");
  if (st === en) return false;
  return st < en ? cur >= st && cur < en : cur >= st || cur < en;
}

// Optimistic toggle of the viewer's reaction on a message. Immutable: copies each
// entry (incl. its reactors list) so we never mutate shared state, and keeps the
// optimistic `reactors` list in sync so the "who reacted" popover updates before
// the server echo.
// Two visually-identical emoji can differ by a trailing Unicode variation
// selector (U+FE0F/U+FE0E) — e.g. the quick-bar "❤️" vs an emoji-picker "❤".
// Match on a normalised key so an optimistic reaction COMBINES with an existing
// same-emoji pill instead of spawning a second one (mirrors the server's
// reactionKey() in serialize.ts, so optimistic + server states agree).
const normReactionEmoji = (e: any): string =>
  String(e || "").replace(/[︎️]/g, "").trim();
export function toggleLocalReaction(
  reactions: any,
  emoji: any,
  meId?: any,
  meName?: any,
): any[] {
  const arr = (reactions || []).map((r: any) => ({
    ...r,
    reactors: (r.reactors || []).slice(),
  }));
  const me = { id: meId, name: meName || "You" };
  const key = normReactionEmoji(emoji);
  const at = arr.findIndex(
    (r: any) => normReactionEmoji(r.emoji) === key && r.mine,
  );
  if (at >= 0) {
    // I had reacted — remove my reaction. Keep the pill if others still hold it.
    const e = arr[at];
    if ((e.count || 1) <= 1) arr.splice(at, 1);
    else
      arr[at] = {
        ...e,
        count: e.count - 1,
        mine: false,
        reactors: (e.reactors || []).filter((u: any) => u.id !== meId),
      };
  } else {
    const exAt = arr.findIndex((r: any) => normReactionEmoji(r.emoji) === key);
    if (exAt >= 0)
      arr[exAt] = {
        ...arr[exAt],
        count: (arr[exAt].count || 0) + 1,
        mine: true,
        reactors: [...(arr[exAt].reactors || []), me],
      };
    else arr.push({ emoji, count: 1, mine: true, reactors: [me] });
  }
  return arr;
}

// Messages are rich-text HTML; conversation previews must be plain text.
// Delegates to the shared messagePreview() (which spaces block elements so list
// items / paragraphs don't run together) — single source of truth. Moved here
// during the CoLabV1 split so the session hooks can share it.
import { messagePreview } from "../../lib/messageText";
export function htmlPreview(html: any) {
  return messagePreview(html);
}
