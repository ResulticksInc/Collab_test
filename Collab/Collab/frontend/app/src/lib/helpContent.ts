// Help Center content — user-facing product documentation, NOT developer docs.
// One entry per module. Rendered by components/HelpCenter.tsx. Content is
// authored to match real, shipped Collab behavior. Generated from the help-content
// workflow (scripts/gen-help-content.cjs), then hand-checked.

export interface TroubleItem {
  problem: string;
  solution: string;
}
export interface FaqItem {
  q: string;
  a: string;
}
export interface HelpModule {
  id: string;
  title: string;
  overview: string;
  howTo: string[];
  bestPractices: string[];
  commonIssues: string[];
  troubleshooting: TroubleItem[];
  faqs: FaqItem[];
  related: string[];
  // Optional renderer hint. Standard modules omit this (treated as "article").
  // The Keyboard-shortcuts module sets "shortcuts" so HelpCenter renders a
  // platform-aware table instead of the usual howTo/FAQ sections.
  kind?: "article" | "shortcuts";
}

// Maps the app's current `mode` (left-rail view) to the most relevant Help
// module, so opening Help is context-aware.
export const MODE_TO_HELP: Record<string, string> = {
  dashboard: "workspace",
  chats: "messaging",
  activity: "notifications",
  meetings: "meetings",
  calendar: "meetings",
  files: "files",
  tasks: "workspace",
  reminders: "workspace",
  agents: "ai",
  contacts: "dms",
  settings: "settings",
  search: "workspace",
};

import helpModulesJson from "../optimization/helpContent.json";

// Order shown in the Help Center module list.
export const HELP_MODULES: HelpModule[] = helpModulesJson as HelpModule[];

export const HELP_BY_ID: Record<string, HelpModule> = Object.fromEntries(
  HELP_MODULES.map((m) => [m.id, m]),
);

export interface SearchHit {
  moduleId: string;
  moduleTitle: string;
  section: string;
  text: string;
}

// Flat, case-insensitive search across every module's sections + troubleshooting
// problems + FAQ questions. Returns ranked hits (title matches first).
export function searchHelp(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const m of HELP_MODULES) {
    const titleMatch = m.title.toLowerCase().includes(q);
    if (titleMatch) hits.push({ moduleId: m.id, moduleTitle: m.title, section: "Overview", text: m.overview || m.title });
    if (!titleMatch && m.overview.toLowerCase().includes(q))
      hits.push({ moduleId: m.id, moduleTitle: m.title, section: "Overview", text: m.overview });
    for (const s of m.howTo) if (s.toLowerCase().includes(q)) hits.push({ moduleId: m.id, moduleTitle: m.title, section: "How to use", text: s });
    for (const t of m.troubleshooting) if (t.problem.toLowerCase().includes(q) || t.solution.toLowerCase().includes(q))
      hits.push({ moduleId: m.id, moduleTitle: m.title, section: "Troubleshooting", text: t.problem + " — " + t.solution });
    for (const f of m.faqs) if (f.q.toLowerCase().includes(q) || f.a.toLowerCase().includes(q))
      hits.push({ moduleId: m.id, moduleTitle: m.title, section: "FAQ", text: f.q });
    for (const c of m.commonIssues) if (c.toLowerCase().includes(q)) hits.push({ moduleId: m.id, moduleTitle: m.title, section: "Common issues", text: c });
  }
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = h.moduleId + "|" + h.text;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts — platform-aware data.
//
// Detect web | windows | mac | linux so the Help Center can show the right
// modifier symbol (⌘ on macOS, Ctrl elsewhere) and hide the OS-wide global
// shortcuts on the web (they only exist in the desktop app). Every shortcut
// listed here is REAL and verified against the code:
//   • In-app keys: CommandPalette (Cmd/Ctrl+K), RichTextEditor (Enter / Shift+
//     Enter / Cmd-Ctrl+B,I,U), the colab:esc convention, the "?" cheat sheet,
//     double-click-to-react (ChatView), Space push-to-talk (CoLabV1).
//   • Global keys: desktop/main.js registerGlobalShortcuts() — Show/Hide
//     (Cmd/Ctrl+Shift+C), Mute (+M), Picture-in-Picture (+D), Answer (+A),
//     Decline (+J).
// ─────────────────────────────────────────────────────────────────────────────

export type HelpPlatform = "web" | "windows" | "mac" | "linux";

/** Detect the running platform for shortcut display. Prefers the desktop bridge
 *  (collabDesktop.platform), then falls back to navigator on the web. */
export function detectHelpPlatform(): HelpPlatform {
  if (typeof window === "undefined") return "web";
  const w = window as unknown as {
    collabDesktop?: { platform?: string };
    navigator?: Navigator & { userAgentData?: { platform?: string } };
  };

  // 1) Desktop shell exposes the raw Node platform string.
  const desk = w.collabDesktop?.platform;
  if (desk) {
    if (desk === "darwin") return "mac";
    if (desk === "win32") return "windows";
    return "linux"; // linux + any other unix
  }

  // 2) Web: classify the OS from navigator so the modifier symbol is correct.
  const nav = (typeof navigator !== "undefined" ? navigator : w.navigator) as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;
  const hint = (
    nav?.userAgentData?.platform ||
    nav?.platform ||
    nav?.userAgent ||
    ""
  ).toLowerCase();
  if (/mac|iphone|ipad|ipod/.test(hint)) return "mac"; // web on a Mac → still ⌘
  if (/win/.test(hint)) return "windows";
  if (/linux|x11|cros/.test(hint)) return "linux";
  return "web"; // unknown → neutral (Ctrl, no global section)
}

export const isMacPlatform = (p: HelpPlatform): boolean => p === "mac";
export const isDesktopPlatform = (p: HelpPlatform): boolean =>
  p === "windows" || p === "mac" || p === "linux";

/** Human label for the small "which set am I seeing" badge. */
export function platformLabel(p: HelpPlatform): string {
  switch (p) {
    case "mac": return "macOS";
    case "windows": return "Windows";
    case "linux": return "Linux";
    default: return "Web";
  }
}

export interface ShortcutRow {
  /** Token list for the keycap(s). "MOD" is substituted with ⌘ or Ctrl,
   *  "MODSHIFT" with ⌘⇧ or Ctrl+Shift, per platform. */
  keys: string[];
  label: string;
}
export interface ShortcutGroup {
  heading: string;
  /** Only shown in the desktop app (global OS-wide hotkeys). */
  desktopOnly?: boolean;
  rows: ShortcutRow[];
}

// In-app shortcuts work everywhere Collab runs, including the browser.
const IN_APP_GROUPS: ShortcutGroup[] = [
  {
    heading: "Navigation",
    rows: [
      { keys: ["MOD", "K"], label: "Open the command palette (quick switcher) — jump to any chat, person, or screen" },
      { keys: ["Esc"], label: "Close the topmost menu, picker, panel, or dialog — or go back" },
      { keys: ["?"], label: "Open the keyboard-shortcuts cheat sheet" },
    ],
  },
  {
    heading: "Messaging",
    rows: [
      { keys: ["Enter"], label: "Send the message" },
      { keys: ["Shift", "Enter"], label: "Start a new line" },
      { keys: ["MOD", "B"], label: "Bold the selected text" },
      { keys: ["MOD", "I"], label: "Italicise the selected text" },
      { keys: ["MOD", "U"], label: "Underline the selected text" },
      { keys: ["Double-click"], label: "React to a message with a heart" },
    ],
  },
  {
    heading: "Calls & meetings",
    rows: [
      { keys: ["Space"], label: "Push-to-talk — hold to speak while you're muted, release to mute again" },
    ],
  },
];

// Global OS-wide hotkeys — desktop app only (registered in main.js). They fire
// even when Collab is in the background, and only act when relevant (e.g. the
// call hotkeys do nothing unless a call is ringing or active).
const GLOBAL_GROUP: ShortcutGroup = {
  heading: "Global — works anywhere on your computer",
  desktopOnly: true,
  rows: [
    { keys: ["MODSHIFT", "C"], label: "Show or hide the Collab window" },
    { keys: ["MODSHIFT", "M"], label: "Mute or unmute your mic during a call" },
    { keys: ["MODSHIFT", "D"], label: "Toggle Picture-in-Picture for the call" },
    { keys: ["MODSHIFT", "A"], label: "Answer an incoming call" },
    { keys: ["MODSHIFT", "J"], label: "Decline an incoming call" },
  ],
};

/** The shortcut groups to show for a platform: in-app always, plus the global
 *  group only on desktop. */
export function shortcutGroupsFor(p: HelpPlatform): ShortcutGroup[] {
  return isDesktopPlatform(p) ? [...IN_APP_GROUPS, GLOBAL_GROUP] : IN_APP_GROUPS;
}

/** Resolve a key token to its display label for the platform (handles the MOD /
 *  MODSHIFT placeholders so macOS shows ⌘ / ⌘⇧ and everyone else Ctrl / Ctrl+Shift). */
export function renderKeyToken(token: string, p: HelpPlatform): string {
  const mac = isMacPlatform(p);
  if (token === "MOD") return mac ? "⌘" : "Ctrl";
  if (token === "MODSHIFT") return mac ? "⌘⇧" : "Ctrl+Shift";
  if (token === "Shift") return mac ? "⇧" : "Shift";
  return token;
}

/** One-line note shown under the shortcuts when a desktop-only section is hidden
 *  on the web, or a short OS nicety per platform. */
export function platformShortcutNote(p: HelpPlatform): string {
  switch (p) {
    case "windows":
      return "Tip: right-click the Collab icon in the taskbar for the Jump List — start a New message, jump to a recent chat, or set your status without opening the window.";
    case "mac":
      return "Tip: right-click (or Control-click) the Collab icon in the Dock for quick actions — start a New message, jump to a recent chat, or set your status.";
    case "linux":
      return "Tip: Collab adds quick actions (New message, recent chats, status) to the taskbar or dock where your desktop environment supports them — availability varies by distribution.";
    default:
      return "The Global shortcuts above need the Collab desktop app — in the browser, use the in-app shortcuts. Install the desktop app to control calls from anywhere on your computer.";
  }
}
