import React, { useState, useEffect, useRef } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import Avatar from "./Avatar";
import { messagePreview } from "../lib/messageText";
import { IconClipboardList, IconAlarmClock, IconPaperclip, IconCalendarDays, IconX, IconMessageSquare, IconSearch, IconHelpCircle, IconArrowRight } from "../lib/icons";
import { Select } from "./ui";
import { isHiddenModule } from "../lib/hiddenModules";
import { Flip, consumeSearchBarFlip } from "../lib/searchFlip";

// Highlight matched query terms inside a result preview.
function highlight(text, query) {
  const t = String(text || "");
  const terms = String(query || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!terms || !terms.length || !t) return t;
  const re = new RegExp(
    "(" +
    terms.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
    ")",
    "ig",
  );
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(t)) !== null) {
    if (m.index > last) out.push(t.slice(last, m.index));
    out.push(
      <mark className="srch-hl" key={m.index}>
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (last < t.length) out.push(t.slice(last));
  return out;
}

const EMPTY = {
  conversations: [],
  people: [],
  messages: [],
  tasks: [],
  reminders: [],
  meetings: [],
};
const pad = (n: number) => String(n).padStart(2, "0");
function fmtMeet(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const day = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day}, ${h}:${pad(d.getMinutes())} ${ap}`;
}

export default function SearchView({
  seed,
  seedScope,
  only,
  onSearch,
  onOpenConversation,
  onOpenPerson,
  onGoMode,
  onOpenHelp,
  onJoin,
  onToast,
}) {
  const [q, setQ] = useState(seed || "");
  const [res, setRes] = useState<any>(EMPTY);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  // Entrance (GSAP — https://gsap.com/docs/v3/): if the Dashboard just
  // captured its search bar's shape (searchFlip.ts), Flip morphs THIS bar out
  // of that snapshot — the pill reads as one continuous element growing/
  // sliding into place rather than a hard cut between screens. Reached Search
  // any other way (rail nav, a deep link), it still gets a deliberate
  // entrance instead of popping in. Either way, the empty-state suggestion
  // cards stagger in right after. `dependencies: []` — this is a MOUNT
  // animation, so it must run once, never on the keystroke re-renders below.
  useGSAP(
    () => {
      const flip = consumeSearchBarFlip();
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
      if (flip && searchBoxRef.current) {
        tl.add(
          Flip.from(flip, {
            targets: searchBoxRef.current,
            duration: 0.55,
            ease: "power3.inOut",
            scale: true,
            // No `absolute` — this bar has no siblings that need to reflow
            // around it mid-flight, and toggling position modes mid-Flip is
            // what left a stale, viewport-relative transform behind (the bar
            // drifted out of place on resize). clearProps is a defensive
            // belt-and-suspenders: once the tween ends, wipe every inline
            // style Flip touched so the bar is back to pure CSS layout,
            // regardless of viewport size, sidebar state, etc.
            onComplete: () => gsap.set(searchBoxRef.current, { clearProps: "all" }),
          }),
        );
      } else if (searchBoxRef.current) {
        tl.from(searchBoxRef.current, { y: -14, opacity: 0, duration: 0.4 });
      }
      tl.from(
        ".srch-suggest-h, .srch-suggest-p",
        { y: 10, opacity: 0, duration: 0.3, stagger: 0.05 },
        "-=0.15",
      ).from(
        ".srch-suggest-cat",
        { y: 16, opacity: 0, duration: 0.35, stagger: 0.07, ease: "back.out(1.6)" },
        "-=0.15",
      );
    },
    { scope: containerRef, dependencies: [] },
  );
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState(seedScope || "all");
  const reqId = useRef(0);
  // Advanced message filters (client-side, no extra backend calls needed)
  const [filterSender, setFilterSender] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterHas, setFilterHas] = useState<"" | "file" | "image" | "mention">("");
  const hasActiveFilter = filterSender || filterDateFrom || filterDateTo || filterHas;

  useEffect(() => {
    const v = q.trim();
    if (!v) {
      setRes(EMPTY);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    const t = setTimeout(() => {
      Promise.resolve(onSearch(v))
        .then((r) => {
          if (id !== reqId.current) return;
          setRes(r || EMPTY);
          setLoading(false);
        })
        .catch(() => {
          if (id === reqId.current) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // Apply advanced filters to messages (client-side)
  const filteredMessages = (res.messages || []).filter((m: any) => {
    if (filterSender) {
      const name = ((m.sender && m.sender.name) || m.senderName || "").toLowerCase();
      if (!name.includes(filterSender.toLowerCase())) return false;
    }
    if (filterDateFrom) {
      const d = new Date(m.createdAt || m.sentAt || 0);
      if (d < new Date(filterDateFrom)) return false;
    }
    if (filterDateTo) {
      const d = new Date(m.createdAt || m.sentAt || 0);
      if (d > new Date(filterDateTo + "T23:59:59")) return false;
    }
    if (filterHas === "file") {
      if (!m.file && !m.hasAttachment) return false;
    }
    if (filterHas === "image") {
      const mime = ((m.file && (m.file.type || m.file.mime)) || "").toLowerCase();
      if (!mime.startsWith("image/")) return false;
    }
    if (filterHas === "mention") {
      if (!/@/.test(m.text || "")) return false;
    }
    return true;
  });

  // Unique senders for the From dropdown
  const senderOptions = Array.from(
    new Map(
      (res.messages || []).map((m: any) => {
        const name = (m.sender && m.sender.name) || m.senderName || "";
        return [name, name];
      })
    ).values()
  ).filter(Boolean).sort() as string[];

  const groups = [
    { key: "people", label: "People", items: res.people || [] },
    { key: "conversations", label: "Channels", items: res.conversations || [] },
    { key: "messages", label: "Messages", items: filteredMessages },
    { key: "tasks", label: "Tasks", items: res.tasks || [] },
    { key: "reminders", label: "Reminders", items: res.reminders || [] },
    { key: "meetings", label: "Meetings", items: res.meetings || [] },
    { key: "files", label: "Files", items: res.files || [] },
    { key: "help", label: "Help", items: res.help || [] },
    // Never surface results for a module the user can't open (hidden from the
    // nav). Clicking one used to route through the hidden-module gate and land
    // the user on the Dashboard — the "redirects elsewhere" from a non-chat module.
  ].filter((g) => !isHiddenModule(g.key));
  // The "Chat" scope restricts results to messages + conversations + files
  // (never People — users are found via the conversation-sidebar search — and
  // never tasks/reminders/meetings). `only` is the allow-list of group keys.
  const visibleGroups = Array.isArray(only)
    ? groups.filter((g) => only.includes(g.key))
    : groups;
  const total = visibleGroups.reduce((n, g) => n + g.items.length, 0);

  // if the scoped category empties out after a new query, fall back to All
  useEffect(() => {
    if (scope === "all") return;
    const g = visibleGroups.find((x) => x.key === scope);
    if (!g || g.items.length === 0) setScope("all");
    // eslint-disable-next-line
  }, [total]);

  const shown = visibleGroups.filter(
    (g) => g.items.length > 0 && (scope === "all" || scope === g.key),
  );

  const renderRow = (g: any, it: any, i: number) => {
    if (g.key === "people")
      return (
        <button
          key={it.id}
          className="srch-row"
          onClick={() => onOpenPerson(it.id)}
        >
          <Avatar
            avatar={{
              kind: "user",
              initials: it.initials,
              color: it.color,
              avatarUrl: it.avatarUrl,
            }}
            size={32}
          />
          <span className="srch-row-body">
            <span className="srch-row-title">{it.name}</span>
            {it.title || it.email ? (
              <span className="srch-row-sub">{it.title || it.email}</span>
            ) : null}
          </span>
          <span className="srch-act">Message</span>
        </button>
      );
    if (g.key === "conversations")
      return (
        <button
          key={it.id}
          className="srch-row"
          onClick={() => onOpenConversation(it.id)}
        >
          <span className="srch-ic-sq">{it.kind === "dm" ? "@" : "#"}</span>
          <span className="srch-row-body">
            <span className="srch-row-title">{it.name}</span>
          </span>
          <span className="srch-act">Open</span>
        </button>
      );
    if (g.key === "messages")
      return (
        <button
          key={it.id || i}
          className="srch-row"
          onClick={() => onOpenConversation(it.conversationId, it.id)}
        >
          <span className="srch-ic-sq">
            <IconMessageSquare className="srch-msg-ico" />
          </span>
          <span className="srch-row-body">
            <span className="srch-row-title">
              {(it.sender && it.sender.name) || it.senderName || "Message"}
            </span>
            <span className="srch-row-sub">{highlight(messagePreview(it.text), q)}</span>
          </span>
          <span className="srch-act">Open chat</span>
        </button>
      );
    if (g.key === "tasks")
      return (
        <button
          key={it.id}
          className="srch-row"
          onClick={() => onGoMode("tasks", it.id)}
        >
          <span className="srch-ic-sq"><IconClipboardList size={16} /></span>
          <span className="srch-row-body">
            <span className="srch-row-title">{it.title}</span>
            <span className="srch-row-sub">
              {it.status}
              {it.priority ? ` · ${it.priority}` : ""}
            </span>
          </span>
          <span className="srch-act">Open in Tasks</span>
        </button>
      );
    if (g.key === "reminders")
      return (
        <button
          key={it.id}
          className="srch-row"
          onClick={() => onGoMode("reminders", it.id)}
        >
          <span className="srch-ic-sq"><IconAlarmClock size={16} /></span>
          <span className="srch-row-body">
            <span className="srch-row-title">{it.text}</span>
            <span className="srch-row-sub">
              {it.state ? it.state[0].toUpperCase() + it.state.slice(1) : ""}
              {it.priority && it.priority !== "Medium"
                ? ` · ${it.priority}`
                : ""}
            </span>
          </span>
          <span className="srch-act">Open</span>
        </button>
      );
    if (g.key === "files")
      return (
        <button
          key={it.id}
          className="srch-row"
          onClick={() =>
            it.conversationId
              ? onOpenConversation(it.conversationId)
              : onGoMode("files")
          }
        >
          <span className="srch-ic-sq"><IconPaperclip size={16} /></span>
          <span className="srch-row-body">
            <span className="srch-row-title">{it.name}</span>
            <span className="srch-row-sub">{it.mime}</span>
          </span>
          <span className="srch-act">Open</span>
        </button>
      );
    if (g.key === "help")
      return (
        <button
          key={(it.moduleId || "help") + i}
          className="srch-row"
          onClick={() => onOpenHelp && onOpenHelp(it.moduleId)}
        >
          <span className="srch-ic-sq"><IconHelpCircle size={16} /></span>
          <span className="srch-row-body">
            <span className="srch-row-title">
              {it.moduleTitle}
              {it.section ? ` · ${it.section}` : ""}
            </span>
            <span className="srch-row-sub">{highlight(it.text, q)}</span>
          </span>
          <span className="srch-act">Open</span>
        </button>
      );
    // meetings
    return (
      <div key={it.id} className="srch-row srch-meet">
        <span className="srch-ic-sq"><IconCalendarDays size={16} /></span>
        <span
          className="srch-row-body"
          onClick={() => onGoMode("calendar", it.id)}
          style={{ cursor: "pointer" }}
        >
          <span className="srch-row-title">{it.title}</span>
          <span className="srch-row-sub">{fmtMeet(it.startsAt)}</span>
        </span>
        <button
          className="srch-join"
          onClick={() => {
            onJoin(it.id);
            onToast(`Joining ${it.title}…`);
          }}
        >
          Join
        </button>
      </div>
    );
  };

  const chips = [
    ["all", "All", total],
    ...visibleGroups
      .filter((g) => g.items.length > 0)
      .map((g) => [g.key, g.label, g.items.length] as [string, string, number]),
  ];

  return (
    <div className="view active" id="vsearch" ref={containerRef}>
      <div className="srch">
        <div className="srch-head">
          <div className="srch-box" ref={searchBoxRef}>
            <IconSearch className="srch-ico" />
            <input
              name="global-search"
              autoComplete="off"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search messages, people, calls, meetings…"
            />
            {q ? (
              <button
                className="srch-clear"
                onClick={() => setQ("")}
                aria-label="Clear search"
              >
                <IconX size={14} />
              </button>
            ) : null}
            {/* Same arrow as the dashboard pill this bar morphs out of. Results
                are live, so it just returns focus to the query. */}
            <button
              className="srch-go"
              onClick={() => searchBoxRef.current?.querySelector("input")?.focus()}
              aria-label="Search"
            >
              <IconArrowRight size={20} />
            </button>
          </div>
          {q.trim() && total > 0 ? (
            <div className="srch-scopes">
              {chips.map(([k, lbl, n]) => (
                <button
                  key={k}
                  className={"srch-chip" + (scope === k ? " active" : "")}
                  onClick={() => setScope(k as string)}
                >
                  {lbl}
                  <span className="srch-chip-n">{n}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {/* Advanced message filters — only show when scoped to Messages and query exists */}
        {scope === "messages" && q.trim() && (res.messages || []).length > 0 ? (
          <div className="srch-msg-filters">
            <Select
              className="srch-filter-sel"
              value={filterSender}
              onChange={(e) => setFilterSender(e.target.value)}
              aria-label="Filter by sender"
            >
              <option value="">From: Anyone</option>
              {senderOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </Select>
            <input
              className="srch-filter-date"
              type="date"
              value={filterDateFrom}
              onChange={(e) => setFilterDateFrom(e.target.value)}
              aria-label="From date"
              title="After date"
              placeholder="After"
            />
            <input
              className="srch-filter-date"
              type="date"
              value={filterDateTo}
              onChange={(e) => setFilterDateTo(e.target.value)}
              aria-label="To date"
              title="Before date"
              placeholder="Before"
            />
            <div className="srch-filter-has-group">
              {(["file", "image", "mention"] as const).map((tag) => (
                <button
                  key={tag}
                  className={"srch-filter-has" + (filterHas === tag ? " active" : "")}
                  onClick={() => setFilterHas(filterHas === tag ? "" : tag)}
                >
                  {tag === "file" ? "Has file" : tag === "image" ? "Has image" : "Has @mention"}
                </button>
              ))}
            </div>
            {hasActiveFilter ? (
              <button
                className="srch-filter-clear"
                onClick={() => { setFilterSender(""); setFilterDateFrom(""); setFilterDateTo(""); setFilterHas(""); }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="srch-body">
          {!q.trim() ? (
            <div className="srch-suggest">
              <div className="srch-suggest-h">Search everything in Collab</div>
              <p className="srch-suggest-p">
                Find people, channels, messages, tasks, reminders, and meetings
                — all from one place.
              </p>
              <div className="srch-suggest-cats">
                {[
                  ["People", "Find a teammate by name or email"],
                  ["Messages", "Recall something that was said"],
                  ["Reminders", "Surface a personal to-do"],
                  ["Meetings", "Find an upcoming or past meeting"],
                ].map(([t, d]) => (
                  <div className="srch-suggest-cat" key={t}>
                    <span className="srch-suggest-cat-t">{t}</span>
                    <span className="srch-suggest-cat-d">{d}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : total > 0 ? (
            shown.map((g) => (
              <div className="srch-grp" key={g.key}>
                <div className="srch-grp-h">
                  {g.label}
                  <span className="srch-grp-n">{g.items.length}</span>
                </div>
                {g.items.map((it, i) => renderRow(g, it, i))}
              </div>
            ))
          ) : loading ? (
            <div className="srch-empty">Searching…</div>
          ) : (
            <div className="srch-empty">
              No results for “{q.trim()}”. Try a different term or check the
              spelling.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
