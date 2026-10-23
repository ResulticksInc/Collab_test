import React, { useEffect, useState, useRef } from "react";
import Modal, { Btn, inp } from "./Modal";
import Select from "./ui/Select";
import { useAutoGrow } from "../lib/autoGrow";
import {
  IconList,
  IconAlarmClock,
  IconCalendarDays,
  IconAlertTriangle,
  IconCircleCheck,
  IconArchive,
  IconPencil,
  IconSparkles,
  IconCheck,
  IconRepeat,
  IconX,
  IconMoreHorizontal,
} from "../lib/icons";

const EMOJIS = ["📁", "💼", "🏠", "⭐", "🎯", "📚", "🛒", "💡"];
// Category icons are stroke-based Lucide (design system), not filled OS emoji.
const SMART: [string, React.ReactNode, string][] = [
  ["all", <IconList size={16} key="i" />, "All"],
  ["today", <IconAlarmClock size={16} key="i" />, "Today"],
  ["upcoming", <IconCalendarDays size={16} key="i" />, "Upcoming"],
  ["overdue", <IconAlertTriangle size={16} key="i" />, "Overdue"],
  ["completed", <IconCircleCheck size={16} key="i" />, "Completed"],
];
const SMART_STATES = ["today", "upcoming", "overdue", "completed", "archived"];
const PRIO_COLOR: any = {
  High: "var(--red)",
  Medium: "var(--amb)",
  Low: "var(--g400)",
};
const REC_LABEL: any = {
  none: "Does not repeat",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

// CUSTOM LEAD TIME (#53): notify N minutes BEFORE the due time. 0 = at due time.
const LEAD_OPTIONS: [number, string][] = [
  [0, "At time of event"],
  [5, "5 minutes before"],
  [10, "10 minutes before"],
  [30, "30 minutes before"],
  [60, "1 hour before"],
  [1440, "1 day before"],
];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Bridge the legacy simple enum ↔ the structured rule so old rows (that only have
// `recurrence`) still render in the structured editor, and the structured editor's
// rule still keeps the legacy enum roughly in sync for read paths / badges.
const legacyToRule = (recurrence: string): any => {
  if (recurrence === "daily") return { freq: "daily", interval: 1, end: { type: "never" } };
  if (recurrence === "weekly") return { freq: "weekly", interval: 1, end: { type: "never" } };
  if (recurrence === "monthly")
    return { freq: "monthly", interval: 1, monthlyMode: "day", end: { type: "never" } };
  return null;
};
const ruleToLegacy = (rule: any): string => {
  if (!rule || !rule.freq) return "none";
  if (rule.freq === "daily") return "daily";
  if (rule.freq === "weekly") return "weekly";
  if (rule.freq === "monthly") return "monthly";
  return "none"; // yearly has no legacy enum — structured rule is the source of truth
};

// STRUCTURED RECURRENCE editor (#53) — REUSES the meetings Outlook-style rule shape
// (freq / interval / weekly days / monthly day-vs-nth-weekday / yearly / end
// never-after-on; see CalendarView's Frequency UI). Controlled: `rule` is the
// structured rule object (or null = does not repeat); `onChange(rule)` emits the
// new rule (null when set to "none"). `anchor` is the reminder's due date, used to
// default the weekday / day-of-month. Compact form suited to the reminder modal.
function RecurrenceEditor({ rule, onChange, anchor }: any) {
  const a = anchor && !Number.isNaN(Date.parse(anchor)) ? new Date(anchor) : new Date();
  const freq = rule?.freq || "none";
  const interval = Math.max(1, rule?.interval || 1);
  const days: number[] = Array.isArray(rule?.byWeekday) ? rule.byWeekday : [];
  const monthlyMode = rule?.monthlyMode === "weekday" ? "weekday" : "day";
  const end = rule?.end || { type: "never" };

  const emit = (patch: any) => {
    if ((patch.freq ?? freq) === "none") return onChange(null);
    const next: any = {
      freq: patch.freq ?? freq,
      interval: patch.interval ?? interval,
      end: patch.end ?? end,
    };
    const f = next.freq;
    if (f === "weekly")
      next.byWeekday = (patch.byWeekday ?? (days.length ? days : [a.getDay()])).slice().sort((x: number, y: number) => x - y);
    if (f === "monthly" || f === "yearly") {
      const mm = patch.monthlyMode ?? monthlyMode;
      next.monthlyMode = mm;
      if (mm === "weekday") {
        next.ordinal = Math.min(4, Math.ceil(a.getDate() / 7));
        next.weekday = a.getDay();
      } else next.day = a.getDate();
    }
    if (f === "yearly") next.month = a.getMonth() + 1;
    onChange(next);
  };

  return (
    <div className="rmd-recur">
      <Select
        className="rmd-field"
        value={freq}
        onChange={(e) => emit({ freq: e.target.value })}
      >
        <option value="none">Does not repeat</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </Select>
      {freq !== "none" && (
        <>
          <div className="rmd-recur-row">
            <span className="rmd-recur-lbl">Every</span>
            <input
              type="number"
              min={1}
              max={99}
              className="rmd-recur-num"
              value={interval}
              onChange={(e) => emit({ interval: Math.max(1, parseInt(e.target.value) || 1) })}
              aria-label="Repeat interval"
            />
            <span className="rmd-recur-unit">
              {({ daily: "day", weekly: "week", monthly: "month", yearly: "year" } as any)[freq]}
              {interval === 1 ? "" : "s"}
            </span>
          </div>
          {freq === "weekly" && (
            <div className="rmd-recur-days">
              {WEEKDAY_LABELS.map((d, i) => (
                <button
                  key={i}
                  type="button"
                  className={"rmd-recur-day" + (days.includes(i) ? " on" : "")}
                  onClick={() =>
                    emit({ byWeekday: days.includes(i) ? days.filter((x) => x !== i) : [...days, i] })
                  }
                  aria-pressed={days.includes(i)}
                >
                  {d[0]}
                </button>
              ))}
            </div>
          )}
          {(freq === "monthly" || freq === "yearly") && (
            <Select
              className="rmd-field"
              value={monthlyMode}
              onChange={(e) => emit({ monthlyMode: e.target.value })}
              aria-label="Monthly pattern"
            >
              <option value="day">On day {a.getDate()}</option>
              <option value="weekday">
                On the {["first", "second", "third", "fourth"][Math.min(3, Math.ceil(a.getDate() / 7) - 1)]}{" "}
                {WEEKDAY_LABELS[a.getDay()]}
              </option>
            </Select>
          )}
          <div className="rmd-recur-row">
            <span className="rmd-recur-lbl">Ends</span>
            <Select
              className="rmd-field"
              value={end.type}
              onChange={(e) => {
                const t = e.target.value;
                emit({
                  end:
                    t === "after"
                      ? { type: "after", count: end.count || 10 }
                      : t === "on"
                        ? { type: "on", date: end.date || "" }
                        : { type: "never" },
                });
              }}
            >
              <option value="never">Never</option>
              <option value="after">After N times</option>
              <option value="on">On date</option>
            </Select>
          </div>
          {end.type === "after" && (
            <input
              type="number"
              min={1}
              className="rmd-recur-num"
              value={end.count || 10}
              onChange={(e) => emit({ end: { type: "after", count: Math.max(1, parseInt(e.target.value) || 1) } })}
              aria-label="Number of occurrences"
            />
          )}
          {end.type === "on" && (
            <input
              type="date"
              className="rmd-field"
              value={end.date || ""}
              onChange={(e) => emit({ end: { type: "on", date: e.target.value } })}
              aria-label="End date"
            />
          )}
        </>
      )}
    </div>
  );
}

const pad = (n) => String(n).padStart(2, "0");
const toLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (val) => (val ? new Date(val).toISOString() : null);
const defaultLocalInput = () => {
  const d = new Date();
  const m = d.getMinutes();
  d.setMinutes(m + (15 - (m % 15)) % 15 + 60, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtDue = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const tmr = new Date(now);
  tmr.setDate(now.getDate() + 1);
  const yst = new Date(now);
  yst.setDate(now.getDate() - 1);
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  const time = hasTime
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
  let day;
  if (same(d, now)) day = "Today";
  else if (same(d, tmr)) day = "Tomorrow";
  else if (same(d, yst)) day = "Yesterday";
  else
    day = d.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    });
  return time ? `${day}, ${time}` : day;
};

function ReminderDetail({
  reminder,
  folders,
  onClose,
  onPatch,
  onSetStatus,
  onSnooze,
  onDelete,
}) {
  const [title, setTitle] = useState(reminder.text || "");
  const [desc, setDesc] = useState(reminder.description || "");
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoGrow(descRef, desc);
  useEffect(() => {
    setTitle(reminder.text || "");
    setDesc(reminder.description || "");
  }, [reminder.id]);
  const patch = (p) => onPatch(reminder.id, p);
  const isDone = reminder.state === "completed";
  const isArch = reminder.state === "archived";
  return (
    <div className="rmd-panel">
      <div className="rmd-head">
        <span className={"rmd-state st-" + reminder.state}>
          {reminder.state}
        </span>
        <button className="rmd-x" onClick={onClose} aria-label="Close">
          <IconX size={15} />
        </button>
      </div>
      <input
        className="rmd-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          const v = title.trim();
          if (v && v !== reminder.text) patch({ text: v });
          else setTitle(reminder.text || "");
        }}
      />
      <label className="rmd-lbl">Notes</label>
      <textarea
        ref={descRef}
        className="rmd-desc"
        value={desc}
        rows={3}
        placeholder="Add notes…"
        onChange={(e) => setDesc(e.target.value)}
        onBlur={() => {
          if (desc !== (reminder.description || ""))
            patch({ description: desc });
        }}
      />
      <div className="rmd-grid">
        <label className="rmd-lbl">Due date & time</label>
        <input
          type="datetime-local"
          className="rmd-field"
          value={toLocalInput(reminder.dueAt)}
          onChange={(e) => patch({ dueAt: fromLocalInput(e.target.value) })}
        />
        {reminder.dueAt ? (
          <button
            className="rmd-clear-due"
            onClick={() => patch({ dueAt: null })}
          >
            Clear due date
          </button>
        ) : null}
        <label className="rmd-lbl">Priority</label>
        <Select
          className="rmd-field"
          value={reminder.priority || "Medium"}
          onChange={(e) => patch({ priority: e.target.value })}
        >
          <option value="High">High</option>
          <option value="Medium">Medium</option>
          <option value="Low">Low</option>
        </Select>
        <label className="rmd-lbl">Notify</label>
        <Select
          className="rmd-field"
          value={String(reminder.leadMinutes ?? 0)}
          onChange={(e) => patch({ leadMinutes: Number(e.target.value) })}
          disabled={!reminder.dueAt}
        >
          {LEAD_OPTIONS.map(([m, lbl]) => (
            <option key={m} value={m}>
              {lbl}
            </option>
          ))}
        </Select>
        <label className="rmd-lbl">Repeat</label>
        <div className="rmd-field rmd-field-recur">
          <RecurrenceEditor
            rule={
              reminder.recurrenceRule ||
              (reminder.recurrence && reminder.recurrence !== "none"
                ? legacyToRule(reminder.recurrence)
                : null)
            }
            anchor={reminder.dueAt}
            onChange={(rule: any) =>
              patch({
                recurrenceRule: rule,
                // Keep the legacy enum roughly in sync for old read paths / badges.
                recurrence: ruleToLegacy(rule),
              })
            }
          />
        </div>
        <label className="rmd-lbl">List</label>
        <Select
          className="rmd-field"
          value={reminder.folderId || ""}
          onChange={(e) => patch({ folderId: e.target.value || null })}
        >
          <option value="">No list</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {f.icon} {f.name}
            </option>
          ))}
        </Select>
      </div>
      {/* Snooze: re-arm the reminder to fire again shortly. Only meaningful for an
          active reminder (not completed/archived). Mirrors the notification
          "Snooze" action — same backend re-arm. */}
      {onSnooze && !isDone && !isArch ? (
        <div className="rmd-snooze">
          <label className="rmd-lbl">Snooze</label>
          <div className="rmd-snooze-row">
            {[
              ["10 min", 10],
              ["1 hour", 60],
              ["Tomorrow", 24 * 60],
            ].map(([lbl, mins]) => (
              <button
                key={lbl as string}
                className="btn-c"
                onClick={() => {
                  onSnooze(reminder.id, mins);
                  onClose();
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="rmd-actions">
        <button
          className="btn-c"
          onClick={() => onSetStatus(reminder.id, isDone ? "open" : "done")}
        >
          {isDone ? "Reopen" : "Mark complete"}
        </button>
        <button
          className="btn-c"
          onClick={() => onSetStatus(reminder.id, isArch ? "open" : "archived")}
        >
          {isArch ? "Unarchive" : "Archive"}
        </button>
        <button
          className="btn-c rmd-del"
          onClick={() => {
            onDelete(reminder.id);
            onClose();
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export default function RemindersView({
  reminders,
  folders,
  // Server-side authoritative counts (P0-D). `counts` holds the per-smart-view
  // (today/upcoming/overdue/completed/archived/all), `counts.folders[id]` the
  // per-folder, and `counts.open` totals — so badges reflect the TRUE totals, not
  // just the loaded page. `totalCount` is the total live reminder count; `hasMore`
  // means the server holds reminders not yet loaded; `onLoadMore` fetches the next
  // keyset page; `loadingMore` guards the control. Without these (offline/demo)
  // the component falls back to counting the loaded array.
  counts,
  totalCount,
  hasMore,
  loadingMore,
  onLoadMore,
  onAdd,
  onQuickAdd,
  onToggle,
  onDelete,
  onPatch,
  onSetStatus,
  onSnooze,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onBulk,
  externalSearch,
  focusReminderId,
  onFocusedReminder,
}: any) {
  const [cur, setCur] = useState("all");
  const [text, setText] = useState("");
  const [adv, setAdv] = useState(false);
  const [cDate, setCDate] = useState("");
  const [cPrio, setCPrio] = useState("Medium");
  const [cRec, setCRec] = useState("none");
  // CUSTOM LEAD TIME + STRUCTURED RECURRENCE for the create row (#53).
  const [cLead, setCLead] = useState(0);
  const [cRule, setCRule] = useState<any>(null);
  // NL QUICK-ADD: a single line ("call John tomorrow 3pm") the server parses.
  const [nlOpen, setNlOpen] = useState(false);
  const [nlText, setNlText] = useState("");
  const [nlBusy, setNlBusy] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    setQ(externalSearch || "");
  }, [externalSearch]);
  const [limit, setLimit] = useState(80);
  // reset pagination when the active list changes
  const [detailId, setDetailId] = useState<any>(null);
  const [folderModal, setFolderModal] = useState(false);
  const [fname, setFname] = useState("");
  const [femoji, setFemoji] = useState("📁");
  const [renId, setRenId] = useState<any>(null);
  const [renDraft, setRenDraft] = useState("");
  const [selMode, setSelMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  // Deep-link focus: when a reminder notification is clicked, the parent passes
  // its id here. Open that reminder's detail, switch to a view that contains it,
  // and flash the row briefly so it's obvious which one. Then clear the request.
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusReminderId) return;
    const r = reminders.find((x: any) => x.id === focusReminderId);
    if (!r) return; // not loaded yet — wait for the list to arrive
    // Switch to a smart view that always contains this reminder so it's visible
    // regardless of the active folder/filter.
    setCur(r.state === "completed" ? "completed" : r.state === "archived" ? "archived" : "all");
    setDetailId(r.id);
    setFlashId(r.id);
    const t = setTimeout(() => setFlashId(null), 2000);
    if (onFocusedReminder) onFocusedReminder();
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReminderId, reminders]);

  const searchMatch = (r) =>
    !q.trim() ||
    (r.text || "").toLowerCase().includes(q.toLowerCase()) ||
    (r.description || "").toLowerCase().includes(q.toLowerCase());
  const viewMatch = (r, v) => {
    if (v === "all") return r.state !== "archived" && r.state !== "completed";
    if (SMART_STATES.includes(v)) return r.state === v;
    return r.folderId === v && r.state !== "archived";
  };
  // Badge counts come from the SERVER (authoritative totals) so they stay correct
  // now that `reminders` is only a page (filtering the partial array would
  // undercount). `counts` keys mirror the smart views; `counts.folders[id]` the
  // per-folder totals. Fall back to filtering the loaded set ONLY when the server
  // counts are unavailable (offline/demo, or a pre-counts response).
  const hasServerCounts = counts && typeof counts === "object";
  const badge = (v) => {
    if (hasServerCounts) {
      if (v === "all" || SMART_STATES.includes(v)) return counts[v] || 0;
      return (counts.folders && counts.folders[v]) || 0;
    }
    if (v === "all" || SMART_STATES.includes(v))
      return reminders.filter((r) => viewMatch(r, v)).length;
    return reminders.filter(
      (r) =>
        r.folderId === v && r.state !== "archived" && r.state !== "completed",
    ).length;
  };

  const PRI: any = { High: 0, Medium: 1, Low: 2 };
  const filtered = reminders.filter((r) => viewMatch(r, cur) && searchMatch(r));
  const list = [...filtered].sort((a, b) => {
    if (cur === "completed" || cur === "archived")
      return (
        (b.updatedAt ? Date.parse(b.updatedAt) : 0) -
        (a.updatedAt ? Date.parse(a.updatedAt) : 0)
      );
    const ad = a.dueAt ? Date.parse(a.dueAt) : Infinity;
    const bd = b.dueAt ? Date.parse(b.dueAt) : Infinity;
    if (ad !== bd) return ad - bd;
    return (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1);
  });
  const shown = list.slice(0, limit);
  useEffect(() => setLimit(80), [cur, q]);

  const completedView = cur === "completed" || cur === "archived";
  const allSel = list.length > 0 && list.every((r) => sel.has(r.id));
  const toggleSel = (id) =>
    setSel((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectAll = () =>
    setSel(allSel ? new Set() : new Set(list.map((r) => r.id)));
  const exitSel = () => {
    setSelMode(false);
    setSel(new Set());
  };
  const runBulk = (action, value?) => {
    const ids = [...sel];
    if (!ids.length) return;
    if (onBulk) onBulk(action, value, ids);
    setSel(new Set());
  };

  const title =
    cur === "all"
      ? "All Reminders"
      : SMART_STATES.includes(cur)
        ? (SMART.find((s) => s[0] === cur) || [, , ""])[2] ||
          cur[0].toUpperCase() + cur.slice(1)
        : (folders.find((f) => f.id === cur) || {}).name || "Reminders";

  const add = () => {
    const v = text.trim();
    if (!v) return;
    const folderId = cur === "all" || SMART_STATES.includes(cur) ? null : cur;
    onAdd({
      text: v,
      folderId,
      dueAt: cDate ? fromLocalInput(cDate) : null,
      priority: cPrio,
      // Structured rule is the source of truth; keep the legacy enum in sync.
      recurrence: cRule ? ruleToLegacy(cRule) : cRec,
      recurrenceRule: cRule,
      leadMinutes: cLead || null,
    });
    setText("");
    setCDate("");
    setCPrio("Medium");
    setCRec("none");
    setCLead(0);
    setCRule(null);
    setAdv(false);
  };
  // NL QUICK-ADD: hand the raw line to the server. On a confident parse it creates
  // the reminder; on an ambiguous parse it returns a draft we drop into the full
  // create row (pre-filled) so the user confirms. Falls back gracefully if the
  // quick endpoint isn't wired (older server) by opening the modal with the text.
  const quickAdd = async () => {
    const v = nlText.trim();
    if (!v || nlBusy) return;
    const folderId = cur === "all" || SMART_STATES.includes(cur) ? null : cur;
    setNlBusy(true);
    try {
      const res = onQuickAdd ? await onQuickAdd(v, folderId) : null;
      if (res && res.created) {
        setNlText("");
        setNlOpen(false);
      } else if (res && res.draft) {
        // Ambiguous — pre-fill the structured create row for confirmation.
        const d = res.draft;
        setText(d.text || v);
        if (d.dueAt) setCDate(toLocalInput(d.dueAt));
        if (d.recurrenceRule) setCRule(d.recurrenceRule);
        else if (d.recurrence) setCRec(d.recurrence);
        setAdv(true);
        setNlText("");
        setNlOpen(false);
      } else {
        // No structured result — just seed the plain add box with the text.
        setText(v);
        setNlText("");
        setNlOpen(false);
      }
    } finally {
      setNlBusy(false);
    }
  };
  const saveFolder = () => {
    onCreateFolder(fname.trim() || "New List", femoji);
    setFolderModal(false);
    setFname("");
    setFemoji("📁");
  };
  const detail = detailId
    ? reminders.find((r) => r.id === detailId) || null
    : null;

  const ViewRow = ({ id, ic, nm }) => (
    <div
      className={"folder-item" + (cur === id ? " active" : "")}
      onClick={() => setCur(id)}
    >
      <span className="fi-ic">{ic}</span>
      <span className="fi-nm">{nm}</span>
      {badge(id) ? <span className="fi-ct">{badge(id)}</span> : null}
    </div>
  );

  return (
    <div className="view active" id="vtodo">
      <div className="todo-layout">
        <div className="todo-side">
          <div className="todo-side-hd">
            Reminders
            <button data-tip="New list" onClick={() => setFolderModal(true)}>
              +
            </button>
          </div>
          <div id="folder-list">
            {SMART.map(([id, ic, nm]) => (
              <ViewRow key={id} id={id} ic={ic} nm={nm} />
            ))}
            <div className="todo-side-lbl">My Lists</div>
            {folders.map((f) =>
              renId === f.id ? (
                <div className="folder-item ren" key={f.id}>
                  <span className="fi-ic">{f.icon}</span>
                  <input
                    className="fi-ren"
                    autoFocus
                    value={renDraft}
                    onChange={(e) => setRenDraft(e.target.value)}
                    onBlur={() => {
                      const v = renDraft.trim();
                      if (v && v !== f.name) onRenameFolder(f.id, v, null);
                      setRenId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as any).blur();
                      if (e.key === "Escape") setRenId(null);
                    }}
                  />
                </div>
              ) : (
                <div
                  className={"folder-item" + (cur === f.id ? " active" : "")}
                  key={f.id}
                  onClick={() => setCur(f.id)}
                >
                  <span className="fi-ic">{f.icon}</span>
                  <span className="fi-nm">{f.name}</span>
                  {badge(f.id) ? (
                    <span className="fi-ct">{badge(f.id)}</span>
                  ) : null}
                  <button
                    className="fi-act"
                    data-tip="Rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenId(f.id);
                      setRenDraft(f.name);
                    }}
                  >
                    <IconPencil size={14} />
                  </button>
                  <button
                    className="fi-act"
                    data-tip="Delete list"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteFolder(f.id);
                      if (cur === f.id) setCur("all");
                    }}
                  >
                    <IconX size={14} />
                  </button>
                </div>
              ),
            )}
            <ViewRow id="archived" ic={<IconArchive size={16} />} nm="Archived" />
          </div>
        </div>
        <div className="todo-main">
          <div className="calls-hdr" style={{ justifyContent: "flex-end" }}>
            <div className="rm-hdr-right">
              {selMode ? (
                <>
                  <button className="rm-selbtn" onClick={selectAll}>
                    {allSel ? "Clear all" : "Select all"}
                  </button>
                  <button className="rm-selbtn on" onClick={exitSel}>
                    Done
                  </button>
                </>
              ) : (
                <button className="rm-selbtn" onClick={() => setSelMode(true)}>
                  Select
                </button>
              )}
            </div>
          </div>
          <div className="todo-wrap">
            {selMode ? (
              <div className="rm-bulk">
                <span className="rm-bulk-n">{sel.size} selected</span>
                <button
                  className="btn-c"
                  disabled={!sel.size}
                  onClick={() => runBulk(completedView ? "open" : "complete")}
                >
                  {completedView ? "Reopen" : "Complete"}
                </button>
                {cur !== "archived" ? (
                  <button
                    className="btn-c"
                    disabled={!sel.size}
                    onClick={() => runBulk("archive")}
                  >
                    Archive
                  </button>
                ) : null}
                <Select
                  className="rm-adv-field"
                  disabled={!sel.size}
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) runBulk("move", v === "__none" ? null : v);
                  }}
                  placeholder="Move to…"
                >
                  <option value="">Move to…</option>
                  <option value="__none">No list</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
                <Select
                  className="rm-adv-field"
                  disabled={!sel.size}
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v) runBulk("priority", v);
                  }}
                  placeholder="Priority…"
                >
                  <option value="">Priority…</option>
                  <option value="High">High</option>
                  <option value="Medium">Medium</option>
                  <option value="Low">Low</option>
                </Select>
                <button
                  className="btn-c rmd-del"
                  disabled={!sel.size}
                  onClick={() => runBulk("delete")}
                >
                  Delete
                </button>
              </div>
            ) : null}
            {cur !== "completed" && cur !== "archived" && !selMode ? (
              <div className="rm-add-block">
                <div className="todo-add">
                  <input
                    name="reminder-text"
                    autoComplete="off"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") add();
                    }}
                    placeholder="Add a reminder…"
                  />
                  {/* NL QUICK-ADD (#53): toggle a natural-language line ("call John
                      tomorrow 3pm", "every Monday 9am standup"). */}
                  {onQuickAdd ? (
                    <button
                      className={"rm-opt" + (nlOpen ? " on" : "")}
                      data-tip="Quick add"
                      onClick={() => setNlOpen((o) => !o)}
                      aria-label="Quick add"
                    >
                      <IconSparkles size={16} />
                    </button>
                  ) : null}
                  <button
                    className={"rm-opt" + (adv ? " on" : "")}
                    data-tip="Date, priority, repeat, notify"
                    onClick={() => {
                      if (!adv && !cDate) setCDate(defaultLocalInput());
                      setAdv(!adv);
                    }}
                  >
                    <IconMoreHorizontal size={16} />
                  </button>
                  <button className="btn-p" onClick={add}>
                    Add
                  </button>
                </div>
                {nlOpen ? (
                  <div className="rm-nl">
                    <input
                      className="rm-nl-input"
                      autoComplete="off"
                      value={nlText}
                      onChange={(e) => setNlText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") quickAdd();
                      }}
                      placeholder='Try "call John tomorrow at 3pm" or "every Monday 9am standup"'
                    />
                    <button className="btn-p" disabled={nlBusy} onClick={quickAdd}>
                      {nlBusy ? "…" : "Add"}
                    </button>
                  </div>
                ) : null}
                {adv ? (
                  <div className="rm-adv">
                    <input
                      type="datetime-local"
                      className="rm-adv-field"
                      value={cDate}
                      onChange={(e) => setCDate(e.target.value)}
                    />
                    <Select
                      className="rm-adv-field"
                      value={cPrio}
                      onChange={(e) => setCPrio(e.target.value)}
                    >
                      <option value="High">High priority</option>
                      <option value="Medium">Medium priority</option>
                      <option value="Low">Low priority</option>
                    </Select>
                    {/* CUSTOM LEAD TIME (#53). */}
                    <Select
                      className="rm-adv-field"
                      value={String(cLead)}
                      onChange={(e) => setCLead(Number(e.target.value))}
                      disabled={!cDate}
                      aria-label="Notify before"
                    >
                      {LEAD_OPTIONS.map(([m, lbl]) => (
                        <option key={m} value={m}>
                          {lbl}
                        </option>
                      ))}
                    </Select>
                    {/* STRUCTURED RECURRENCE (#53), reusing the meeting rule shape. */}
                    <div className="rm-adv-field rm-adv-recur">
                      <RecurrenceEditor
                        rule={cRule || (cRec !== "none" ? legacyToRule(cRec) : null)}
                        anchor={cDate ? fromLocalInput(cDate) : null}
                        onChange={(rule: any) => {
                          setCRule(rule);
                          setCRec(ruleToLegacy(rule));
                        }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div id="todo-list">
              {list.length ? (
                shown.map((r) => {
                  const overdue = r.state === "overdue";
                  const due = fmtDue(r.dueAt) || r.dueLabel;
                  return (
                    <div
                      className={
                        "todo-item rmi" +
                        (r.done ? " done" : "") +
                        (detailId === r.id ? " sel" : "") +
                        (flashId === r.id ? " rmi-flash" : "") +
                        (selMode && sel.has(r.id) ? " picked" : "")
                      }
                      key={r.id}
                    >
                      {selMode ? (
                        <div
                          className={"rm-sel" + (sel.has(r.id) ? " on" : "")}
                          onClick={() => toggleSel(r.id)}
                        >
                          {sel.has(r.id) ? <IconCheck size={13} /> : null}
                        </div>
                      ) : (
                        <div
                          className="todo-check"
                          onClick={() => onToggle(r.id)}
                        >
                          {r.done ? <IconCheck size={14} /> : null}
                        </div>
                      )}
                      <div
                        className="rmi-body"
                        onClick={() =>
                          selMode ? toggleSel(r.id) : setDetailId(r.id)
                        }
                      >
                        <div className="rmi-title">{r.text}</div>
                        <div className="rmi-meta">
                          {due ? (
                            <span
                              className={
                                "rmi-due" + (overdue ? " overdue" : "")
                              }
                            >
                              {due}
                            </span>
                          ) : null}
                          {r.priority && r.priority !== "Medium" ? (
                            <span
                              className="rmi-prio"
                              style={{ color: PRIO_COLOR[r.priority], display: "inline-flex", alignItems: "center", gap: 5 }}
                            >
                              <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "currentColor" }} />
                              {r.priority}
                            </span>
                          ) : null}
                          {r.recurrence && r.recurrence !== "none" ? (
                            <span
                              className="rmi-rec"
                              data-tip={REC_LABEL[r.recurrence]}
                              style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
                            >
                              <IconRepeat size={12} /> {r.recurrence}
                            </span>
                          ) : null}
                          {r.folderId &&
                          !SMART_STATES.includes(cur) &&
                          cur === "all" ? (
                            <span className="rmi-folder">
                              {(folders.find((f) => f.id === r.folderId) || {})
                                .name || ""}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {selMode ? null : (
                        <button
                          className="td-del"
                          data-tip="Delete"
                          onClick={() => onDelete(r.id)}
                        >
                          <IconX size={14} />
                        </button>
                      )}
                    </div>
                  );
                })
              ) : hasMore && !q.trim() && badge(cur) > 0 ? (
                // The loaded page (newest-first) holds no rows for THIS view yet,
                // but the server count says some exist on a later page — invite the
                // user to load more rather than falsely claiming the view is empty.
                <div className="rm-empty">
                  <p>{badge(cur)} more on the server — load them to view here.</p>
                  {onLoadMore ? (
                    <button
                      className="rm-more"
                      disabled={loadingMore}
                      onClick={() => onLoadMore()}
                    >
                      {loadingMore ? "Loading…" : "Load more reminders"}
                    </button>
                  ) : null}
                </div>
              ) : (
                <p className="rm-empty">
                  {cur === "completed"
                    ? "Nothing completed yet."
                    : cur === "overdue"
                      ? "Nothing overdue — you're on top of it."
                      : cur === "archived"
                        ? "No archived reminders."
                        : "No reminders here yet."}
                </p>
              )}
              {list.length > shown.length ? (
                <button
                  className="rm-more"
                  onClick={() => setLimit((n) => n + 80)}
                >
                  Show {list.length - shown.length} more
                </button>
              ) : hasMore && onLoadMore ? (
                // Server-side keyset "Load more": the client holds only a page, so
                // once the loaded set is fully shown for this view we fetch the
                // next page from the server. Badges already reflect the true
                // totals (server `counts`); this just reveals more rows.
                <button
                  className="rm-more"
                  disabled={loadingMore}
                  onClick={() => onLoadMore()}
                >
                  {loadingMore ? "Loading…" : "Load more reminders"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
        {detail ? (
          <ReminderDetail
            reminder={detail}
            folders={folders}
            onClose={() => setDetailId(null)}
            onPatch={onPatch}
            onSetStatus={onSetStatus}
            onSnooze={onSnooze}
            onDelete={onDelete}
          />
        ) : null}
      </div>

      {folderModal ? (
        <Modal
          title="New List"
          onClose={() => setFolderModal(false)}
          footer={
            <>
              <Btn onClick={() => setFolderModal(false)}>Cancel</Btn>
              <Btn primary onClick={saveFolder}>
                Create
              </Btn>
            </>
          }
        >
          <input
            name="list-name"
            autoComplete="off"
            value={fname}
            onChange={(e) => setFname(e.target.value)}
            placeholder="List name"
            style={inp}
            autoFocus
          />
          <div
            style={{ fontSize: 12, color: "var(--g500)", margin: "12px 0 6px" }}
          >
            Icon
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {EMOJIS.map((e) => (
              <span
                key={e}
                onClick={() => setFemoji(e)}
                style={{
                  width: 38,
                  height: 38,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  borderRadius: 8,
                  cursor: "pointer",
                  border:
                    "2px solid " + (femoji === e ? "var(--ac)" : "var(--g200)"),
                  background: femoji === e ? "var(--ac100)" : "transparent",
                }}
              >
                {e}
              </span>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
