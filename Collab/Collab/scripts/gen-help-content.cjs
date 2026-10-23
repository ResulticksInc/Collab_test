// One-off: turn the help-content workflow output into helpContent.ts.
const fs = require("fs");
const path = require("path");

const OUT = process.argv[2];
const TARGET = process.argv[3];

const raw = JSON.parse(fs.readFileSync(OUT, "utf8"));
const modules = (raw.result && raw.result.modules) || [];

// Canonical id order + titles (authority for ordering + related-link validation).
const ORDER = [
  ["messaging", "Messaging"],
  ["dms", "Direct Messages"],
  ["groups", "Groups"],
  ["channels", "Channels"],
  ["calls", "Audio Calls"],
  ["videoCalls", "Video Calls"],
  ["groupCalls", "Group Calls"],
  ["meetings", "Meetings"],
  ["screenSharing", "Screen Sharing"],
  ["files", "Files & Attachments"],
  ["notifications", "Notifications"],
  ["profiles", "Profiles"],
  ["security", "Security & Privacy"],
  ["settings", "Settings"],
  ["workspace", "Workspace"],
  ["ai", "AI Features"],
  ["admin", "Admin"],
];
const VALID = new Set(ORDER.map((o) => o[0]));
const byId = {};
for (const m of modules) if (m && m.id) byId[m.id] = m;

const clean = ORDER.map(([id, title]) => {
  const m = byId[id] || {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  // Validate related ids: keep only known ids, drop self-references, de-dupe.
  const related = [];
  for (const r of arr(m.related)) {
    if (r !== id && VALID.has(r) && !related.includes(r)) related.push(r);
  }
  return {
    id,
    title: m.title || title,
    overview: m.overview || "",
    howTo: arr(m.howTo),
    bestPractices: arr(m.bestPractices),
    commonIssues: arr(m.commonIssues),
    troubleshooting: arr(m.troubleshooting).map((t) => ({ problem: t.problem || "", solution: t.solution || "" })),
    faqs: arr(m.faqs).map((f) => ({ q: f.q || "", a: f.a || "" })),
    related,
  };
});

const missing = clean.filter((m) => !m.overview).map((m) => m.id);
if (missing.length) console.warn("WARNING: modules with no content:", missing.join(", "));

const header = `// Help Center content — user-facing product documentation, NOT developer docs.
// One entry per module. Rendered by components/HelpCenter.tsx. Content is
// authored to match real, shipped CoLab behavior. Generated from the help-content
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
}

// Maps the app's current \`mode\` (left-rail view) to the most relevant Help
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

// Order shown in the Help Center module list.
export const HELP_MODULES: HelpModule[] = ${JSON.stringify(clean, null, 2)};

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
`;

fs.writeFileSync(TARGET, header, "utf8");
console.log("Wrote", TARGET, "with", clean.length, "modules.");
