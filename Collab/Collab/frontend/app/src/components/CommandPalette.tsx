import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { createPortal } from "react-dom";
import { useEsc } from "../lib/escStack";
import {
  IconMessageSquare,
  IconUsers,
  IconHash,
  IconUser,
  IconChevronRight,
  IconMessageCircle,
  IconVideo,
  IconSettings,
  IconSearch,
} from "../lib/icons";

// ---------------------------------------------------------------------------
// CommandPalette — a premium Cmd/Ctrl+K "quick switcher" for CoLab.
//
// Strictly PRESENTATIONAL about navigation: it only reads the app's existing
// state (conversations, people, modules) via props and INVOKES the existing
// handlers passed in. It owns no conversation/module/call state of its own, so
// it can never drift out of sync with the rest of the app.
//
// Conventions honoured:
//   • Portal-rendered to document.body (no-clipping convention).
//   • Esc closes via the app-wide CANCELABLE "colab:esc" event — it consumes
//     (preventDefault) so Esc doesn't fall through to the global Back action.
//   • Cmd/Ctrl+K toggles open/closed from anywhere (capture phase so it beats
//     the browser's own focus-the-omnibox default).
//   • Themed via the CSS variables in v1.css — never hard-codes colours.
// ---------------------------------------------------------------------------

type ItemType = "conversation" | "person" | "module" | "action";

interface PaletteItem {
  id: string; // stable unique key
  type: ItemType;
  label: string; // primary display text (searched)
  hint: string; // subtle type hint shown on the right
  sub?: string; // optional secondary text under the label (also searched)
  icon: React.ReactNode;
  run: () => void; // invokes an existing handler, then closes
}

// --- tiny icon set (stroke-based, inherits currentColor) -------------------
const I = {
  dm: <IconMessageSquare size={20} />,
  group: <IconUsers size={20} />,
  channel: <IconHash size={20} />,
  person: <IconUser size={20} />,
  module: <IconChevronRight size={20} />,
  newMsg: <IconMessageCircle size={20} />,
  meeting: <IconVideo size={20} />,
  settings: <IconSettings size={20} />,
  searchGlass: <IconSearch size={20} />,
};

// Modules surfaced under "Go to" — mirrors Rail's labels. The id is whatever
// onMode() expects (the same string Rail passes). Kept inline (not imported)
// so the palette stays a leaf with no extra coupling.
const MODULES: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: "dashboard", label: "Dashboard", icon: I.module },
  { id: "chats", label: "Messages", icon: I.dm },
  { id: "calls", label: "Calls", icon: I.module },
  { id: "contacts", label: "Contacts", icon: I.person },
  { id: "calendar", label: "Calendar", icon: I.meeting },
  { id: "activity", label: "Activity", icon: I.module },
  // ISSUE #15: Tasks / Reminders / Files hidden from the command palette while
  // their modules are hidden from the nav — restore these to re-enable.
  { id: "search", label: "Search", icon: I.searchGlass },
];

const GROUP_ORDER: { type: ItemType; label: string }[] = [
  { type: "conversation", label: "Jump to" },
  { type: "person", label: "People" },
  { type: "module", label: "Go to" },
  { type: "action", label: "Actions" },
];

// --- fuzzy / substring matcher with simple ranking ------------------------
// Higher score = better. 0 = no match. Ranking: exact > prefix >
// word-boundary > substring > subsequence (fuzzy). Cheap + allocation-light.
function score(query: string, text: string): number {
  if (!query) return 1; // empty query: everything passes (recents shown)
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return 1000;
  const idx = t.indexOf(q);
  if (idx === 0) return 800 - t.length; // prefix (shorter label wins ties)
  if (idx > 0) {
    // word-boundary substring scores above a mid-word substring.
    const prev = t[idx - 1];
    const boundary = prev === " " || prev === "-" || prev === "_" || prev === "/";
    return (boundary ? 600 : 400) - idx;
  }
  // subsequence (fuzzy) — all query chars appear in order.
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? 120 - (t.length - q.length) : 0;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  // EXISTING app state (read-only):
  conversations: any[];
  people: any[];
  meId?: string | null;
  // EXISTING handlers (invoked, never duplicated):
  onSelect: (conversationId: string) => void; // open a conversation
  onSelectPerson: (userId: string) => void; // open/start a DM
  onMode: (mode: string) => void; // module navigation
  onOpenSettings: () => void;
  onNewMessage: () => void;
  recentConvIds?: string[]; // optional ordering hint for empty query
}

function convIcon(kind: string): React.ReactNode {
  if (kind === "group") return I.group;
  if (kind === "channel") return I.channel;
  return I.dm;
}
function convHint(kind: string): string {
  if (kind === "group") return "Group";
  if (kind === "channel") return "Channel";
  if (kind === "self") return "You";
  return "Direct message";
}

export default function CommandPalette({
  open,
  onClose,
  conversations,
  people,
  meId,
  onSelect,
  onSelectPerson,
  onMode,
  onOpenSettings,
  onNewMessage,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset query + selection each time the palette opens, and focus the input.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus after paint so the auto-focus reliably lands on the input.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Esc closes via the central Esc stack (topmost-first; see lib/escStack).
  useEsc(open, onClose);

  // Flatten the full item catalogue from props (memoized — only recomputes when
  // the underlying data or handlers change, NOT on every keystroke).
  const allItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];

    // Jump to — every conversation by name.
    for (const c of conversations || []) {
      if (!c || !c.id || c.hidden) continue;
      const kind = c.kind || "dm";
      const name = c.name || (kind === "self" ? "You" : "Conversation");
      items.push({
        id: "conv:" + c.id,
        type: "conversation",
        label: name,
        hint: convHint(kind),
        sub: c.preview ? String(c.preview).replace(/<[^>]*>/g, "").slice(0, 80) : undefined,
        icon: convIcon(kind),
        run: () => {
          onSelect(c.id);
          onMode("chats");
          onClose();
        },
      });
    }

    // People — contacts → open/start a DM.
    for (const p of people || []) {
      if (!p || !p.id || (meId && p.id === meId)) continue;
      items.push({
        id: "person:" + p.id,
        type: "person",
        label: p.name || p.email || "Member",
        hint: "Message",
        sub: p.title || p.email || undefined,
        icon: I.person,
        run: () => {
          onSelectPerson(p.id);
          onClose();
        },
      });
    }

    // Go to — modules from the Rail.
    for (const m of MODULES) {
      items.push({
        id: "mod:" + m.id,
        type: "module",
        label: m.label,
        hint: "Go to",
        icon: m.icon,
        run: () => {
          onMode(m.id);
          onClose();
        },
      });
    }

    // Actions.
    items.push({
      id: "act:new-message",
      type: "action",
      label: "New message",
      hint: "Action",
      icon: I.newMsg,
      run: () => {
        onNewMessage();
        onClose();
      },
    });
    items.push({
      id: "act:new-meeting",
      type: "action",
      label: "New meeting",
      hint: "Action",
      icon: I.meeting,
      run: () => {
        // No standalone scheduler handler exists at this level — the scheduler
        // lives inside Calendar — so navigate there (where "New meeting" lives).
        onMode("calendar");
        onClose();
      },
    });
    items.push({
      id: "act:open-settings",
      type: "action",
      label: "Open Settings",
      hint: "Action",
      icon: I.settings,
      run: () => {
        onOpenSettings();
        onClose();
      },
    });

    return items;
  }, [
    conversations,
    people,
    meId,
    onSelect,
    onSelectPerson,
    onMode,
    onOpenSettings,
    onNewMessage,
    onClose,
  ]);

  // Filter + rank on the fly. Empty query → curated "recents": the first few
  // conversations (already recency-sorted by the app) + the Go-to modules.
  const results = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    if (!q) {
      const recents = allItems
        .filter((it) => it.type === "conversation")
        .slice(0, 6);
      const modules = allItems.filter((it) => it.type === "module");
      const actions = allItems.filter((it) => it.type === "action");
      return [...recents, ...modules, ...actions];
    }
    const scored = allItems
      .map((it) => ({
        it,
        s: Math.max(score(q, it.label), it.sub ? score(q, it.sub) - 50 : 0),
      }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.map((x) => x.it).slice(0, 60);
  }, [allItems, query]);

  // Group the results for display while keeping a flat index for keyboard nav.
  const groups = useMemo(() => {
    const out: { label: string; items: PaletteItem[] }[] = [];
    for (const g of GROUP_ORDER) {
      const its = results.filter((it) => it.type === g.type);
      if (its.length) out.push({ label: g.label, items: its });
    }
    return out;
  }, [results]);

  // Keep the active index within bounds whenever the result set changes.
  useEffect(() => {
    setActive((a) => (results.length ? Math.min(a, results.length - 1) : 0));
  }, [results.length]);

  // Scroll the active row into view as selection moves.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (results.length ? (a + 1) % results.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) =>
          results.length ? (a - 1 + results.length) % results.length : 0,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = results[active];
        if (item) item.run();
      } else if (e.key === "Home") {
        e.preventDefault();
        setActive(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setActive(Math.max(0, results.length - 1));
      }
      // Esc is intentionally NOT handled here — the global keydown listener in
      // CoLabV1 fires colab:esc, which we consume above. This keeps Esc behaviour
      // consistent with every other transient surface.
    },
    [results, active],
  );

  if (!open || typeof document === "undefined") return null;

  // Flat counter so each rendered row gets its global keyboard index.
  let flatIdx = -1;

  const node = (
    <div
      className="cmdk-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => {
        // Click on the dim backdrop (outside the panel) closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk-panel" role="combobox" aria-expanded="true">
        <div className="cmdk-search">
          <span className="cmdk-search-ico" aria-hidden="true">
            {I.searchGlass}
          </span>
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search people, conversations, actions…"
            aria-label="Command palette search"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="cmdk-kbd" aria-hidden="true">
            Esc
          </kbd>
        </div>

        <div className="cmdk-list" ref={listRef} role="listbox">
          {results.length === 0 ? (
            <div className="cmdk-empty">No matches</div>
          ) : (
            groups.map((g) => (
              <div className="cmdk-group" key={g.label}>
                <div className="cmdk-group-hdr">{g.label}</div>
                {g.items.map((item) => {
                  flatIdx += 1;
                  const idx = flatIdx;
                  const isActive = idx === active;
                  return (
                    <button
                      type="button"
                      key={item.id}
                      data-idx={idx}
                      className={"cmdk-row" + (isActive ? " active" : "")}
                      role="option"
                      aria-selected={isActive}
                      onMouseMove={() => {
                        if (!isActive) setActive(idx);
                      }}
                      onClick={() => item.run()}
                    >
                      <span className="cmdk-row-ico" aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className="cmdk-row-text">
                        <span className="cmdk-row-label">{item.label}</span>
                        {item.sub ? (
                          <span className="cmdk-row-sub">{item.sub}</span>
                        ) : null}
                      </span>
                      <span className="cmdk-row-hint">{item.hint}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="cmdk-foot">
          <span className="cmdk-foot-grp">
            <kbd className="cmdk-kbd">↑</kbd>
            <kbd className="cmdk-kbd">↓</kbd>
            to navigate
          </span>
          <span className="cmdk-foot-grp">
            <kbd className="cmdk-kbd">↵</kbd>
            to select
          </span>
          <span className="cmdk-foot-grp">
            <kbd className="cmdk-kbd">Esc</kbd>
            to close
          </span>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
