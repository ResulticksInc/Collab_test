import React, { useState, useEffect, useRef } from "react";
import Avatar from "./Avatar";
import Modal, { Btn, inp } from "./Modal";
import Select from "./ui/Select";
import { api } from "../lib/api";
import { useAutoGrow } from "../lib/autoGrow";
import { IconX, IconCheck, IconRepeat, IconChevronDown, IconPaperclip, IconEye } from "../lib/icons";

const COLS: [string, string][] = [
  ["backlog", "Backlog"],
  ["todo", "To do"],
  ["inprogress", "In progress"],
  ["review", "In review"],
  ["blocked", "Blocked"],
  ["done", "Done"],
];
const ALL_STATUSES: [string, string][] = [...COLS, ["archived", "Archived"]];
// Recurrence options (feature #52a) — MIRRORS the server allow-list
// (taskService.TASK_RECURRENCES) and the Reminders recurrence UI.
const RECURRENCES: [string, string][] = [
  ["none", "Does not repeat"],
  ["daily", "Repeats daily"],
  ["weekly", "Repeats weekly"],
  ["monthly", "Repeats monthly"],
];
const RECUR_LABEL: Record<string, string> = {
  none: "Does not repeat",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};
const TABS: [string, string][] = [
  ["mine", "My tasks"],
  ["all", "All tasks"],
  ["assigned", "Assigned to me"],
  ["created", "Created by me"],
];
const prioColor = (p: string): [string, string] =>
  p === "High"
    ? ["var(--red-bg)", "var(--red)"]
    : p === "Medium"
      ? ["var(--amb-bg)", "var(--amb)"]
      : ["var(--g100)", "var(--g500)"];

// The full assignee set for a task: the multi-assignee `assignees[]` array, with
// a graceful fallback to the legacy single `assignee` so a pre-migration payload
// still renders. Returns an array of pubUser-shaped objects.
const assigneesOf = (t: any): any[] => {
  if (Array.isArray(t?.assignees) && t.assignees.length) return t.assignees;
  return t?.assignee ? [t.assignee] : [];
};
const isAssigneeOf = (t: any, uid: any): boolean =>
  !!uid && assigneesOf(t).some((a: any) => a && a.id === uid);

// A small overlapping avatar stack (up to `max`, then "+N"). Used in the board /
// list rows to show multiple assignees compactly.
function AvatarStack({ people, size = 20, max = 3 }: any) {
  const list = (people || []).filter(Boolean);
  if (!list.length) return null;
  const shown = list.slice(0, max);
  const extra = list.length - shown.length;
  return (
    <span className="tk-av-stack" title={list.map((p: any) => p.name).join(", ")}>
      {shown.map((p: any, i: number) => (
        <span
          className="tk-av-stack-i"
          key={p.id || i}
          style={{ marginLeft: i === 0 ? 0 : -6, zIndex: shown.length - i }}
        >
          <Avatar
            avatar={{
              kind: "user",
              initials: p.initials,
              color: p.color,
              avatarUrl: p.avatarUrl,
            }}
            size={size}
          />
        </span>
      ))}
      {extra > 0 ? <span className="tk-av-stack-more">+{extra}</span> : null}
    </span>
  );
}

// Subtask progress (feature #52a): a compact "done/total" pill + a thin bar. Only
// rendered when a task actually has subtasks (subtaskCount > 0).
function TaskProgress({ done, total, compact = false }: any) {
  const t = Number(total) || 0;
  if (t <= 0) return null;
  const d = Math.min(Number(done) || 0, t);
  const pct = Math.round((d / t) * 100);
  return (
    <span
      className={"tk-progress" + (compact ? " compact" : "")}
      title={`${d} of ${t} subtasks done`}
    >
      <span className="tk-progress-bar">
        <span className="tk-progress-fill" style={{ width: pct + "%" }} />
      </span>
      <span className="tk-progress-n">
        {d}/{t}
      </span>
    </span>
  );
}

export default function TasksView({
  tasks,
  users,
  onCreate,
  onMove,
  onUpdate,
  onDelete,
  onBulk,
  onSetAssignees,
  onWatch,
  meId,
  token,
  tick,
  openTaskId,
  onOpenedTask,
  externalSearch,
  // Server-side pagination: `totalCount` is the authoritative total; `hasMore`
  // means the server holds tasks not yet loaded; `onLoadMore` fetches the next
  // keyset page; `loadingMore` guards the control. Without these (legacy/demo)
  // the view degrades to client-only paging over the loaded set.
  totalCount,
  hasMore,
  loadingMore,
  onLoadMore,
  // 409 conflict signal for the open detail panel (concurrent edit).
  conflict,
  onClearConflict,
  // Toast surface (reused for upload/attachment feedback). Optional.
  onToast,
  // PROJECTS-AS-ENTITIES + SAVED VIEWS (#52b).
  // `projects` = the user's projects (filter/group + create picker); `views` =
  // saved board views. `projectFilter` is the active SERVER-SIDE filter ("" all /
  // "none" unfiled / id); `onProjectFilter` re-queries the server for that scope.
  projects = [],
  views = [],
  projectFilter = "",
  onProjectFilter,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onSaveView,
  onUpdateView,
  onDeleteView,
}) {
  const [add, setAdd] = useState(false);
  const [detailId, setDetailId] = useState<any>(null);
  // Distinguish a board-card DRAG from a CLICK so clicking a card opens the detail
  // (the draggable card could otherwise swallow the title click in Kanban).
  const draggedRef = useRef(false);
  // Deep-link from a task notification: open that task's detail panel, then clear
  // the request so re-renders don't force it back open after the user closes it.
  // onOpenedTask is read via a ref so the effect depends ONLY on openTaskId (the
  // parent passes a fresh arrow each render; a direct dep would re-fire the open).
  const onOpenedTaskRef = useRef(onOpenedTask);
  onOpenedTaskRef.current = onOpenedTask;
  useEffect(() => {
    if (openTaskId) {
      setDetailId(openTaskId);
      onOpenedTaskRef.current?.();
    }
  }, [openTaskId]);
  const [dragId, setDragId] = useState<any>(null);
  const [dragOver, setDragOver] = useState<any>(null);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("Medium");
  // Multi-assignee create: a set of selected user ids (defaults to me).
  const [assigneeIds, setAssigneeIds] = useState<string[]>(meId ? [meId] : []);
  // Assignee picker filter — the chip list is the whole org, unusable unfiltered.
  const [asnQ, setAsnQ] = useState("");
  // Richer create modal (feature #51): description, due date, initial blockers.
  const [cDesc, setCDesc] = useState("");
  const cDescRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoGrow(cDescRef, cDesc, { min: 64, max: 220 });
  const [cDue, setCDue] = useState("");
  const [cDeps, setCDeps] = useState<string[]>([]);
  // Recurring tasks (feature #52a): the recurrence the new task repeats on.
  const [cRecur, setCRecur] = useState("none");
  // PROJECTS-AS-ENTITIES (#52b): the project the new task is filed into ("" = none).
  const [cProject, setCProject] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    setQ(externalSearch || "");
  }, [externalSearch]);
  const [tab, setTab] = useState("mine");
  const [view, setView] = useState("board");
  const [fStatus, setFStatus] = useState("");
  const [fPriority, setFPriority] = useState("");
  const [fAssignee, setFAssignee] = useState("");
  const [fDue, setFDue] = useState("");
  // SWIMLANES (#52b): the client-side group-by field over the loaded page.
  // none = the normal status board; assignee/priority/project/status = swimlanes.
  const [groupBy, setGroupBy] = useState("none");
  // SAVED VIEWS (#52b): the Views dropdown + the "Save current view" modal.
  const [viewsOpen, setViewsOpen] = useState(false);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [saveViewName, setSaveViewName] = useState("");
  // PROJECTS (#52b): the small "Manage projects" modal (create/rename/delete).
  const [projOpen, setProjOpen] = useState(false);
  const [newProjName, setNewProjName] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [colLim, setColLim] = useState<Record<string, number>>({});
  const [listLim, setListLim] = useState(100);
  // Delete confirmation (feature #51) — reuse the FilesView confirm pattern: a
  // small modal asks before the (soft) delete; an undo toast offers a quick
  // restore window. `pendingDelete` holds the task awaiting confirmation.
  const [pendingDelete, setPendingDelete] = useState<any>(null);
  const requestDelete = (t: any) => setPendingDelete(t);
  // CSV export (feature #52a): fetch the server-built CSV (authz-scoped +
  // injection-safe) and trigger a browser download. Mirrors the attachment
  // download flow (blob → object URL → click → revoke).
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    if (!token || exporting) return;
    setExporting(true);
    try {
      const blob = await api.exportTasksCsv(token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tasks-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      if (onToast) onToast(e?.message || "Export failed");
    } finally {
      setExporting(false);
    }
  };
  const confirmDelete = () => {
    const t = pendingDelete;
    setPendingDelete(null);
    if (t) onDelete(t.id);
  };

  const reset = () => {
    setTitle("");
    setPriority("Medium");
    setAssigneeIds(meId ? [meId] : []);
    setAsnQ("");
    setCDesc("");
    setCDue("");
    setCDeps([]);
    setCRecur("none");
    // Default the new task's project to the active project filter (a real project
    // id), so creating from inside a project files it there; "" / "none" → unfiled.
    setCProject(projectFilter && projectFilter !== "none" ? projectFilter : "");
  };
  const toggleCreateAssignee = (uid: string) =>
    setAssigneeIds((prev) =>
      prev.includes(uid) ? prev.filter((x) => x !== uid) : [...prev, uid],
    );
  // Assignee picker list. `users` arrives frequency-ranked from the parent
  // (most-interacted first — DMs + calls). With an empty search box we show only
  // the top ASN_CAP so the chip list isn't the whole org; selected people are
  // always pinned in. Typing searches the full directory by name/email.
  const ASN_CAP = 10;
  const asnTrim = asnQ.trim().toLowerCase();
  const asnMatches = (users || []).filter((u) => {
    if (assigneeIds.includes(u.id)) return true; // selected always visible
    if (!asnTrim) return true;
    return (
      (u.name || "").toLowerCase().includes(asnTrim) ||
      (u.email || "").toLowerCase().includes(asnTrim)
    );
  });
  const asnVisible = asnTrim
    ? asnMatches
    : (() => {
        // Empty query: selected first, then fill to the cap with the top-ranked.
        const sel = asnMatches.filter((u) => assigneeIds.includes(u.id));
        const rest = asnMatches
          .filter((u) => !assigneeIds.includes(u.id))
          .slice(0, Math.max(0, ASN_CAP - sel.length));
        return [...sel, ...rest];
      })();
  const asnHidden = (users || []).length - asnVisible.length;
  const openCreate = () => {
    reset();
    setAdd(true);
  };
  const close = () => {
    setAdd(false);
    reset();
  };
  const submit = () => {
    if (!title.trim()) return;
    // Primary assignee = the first selected (server keeps assignee_id = primary);
    // the full set is applied right after create via onSetAssignees when >1. The
    // richer fields (description / due date / initial blockers) are validated
    // server-side; deps are linked after create (cycle-checked) by onCreate.
    onCreate({
      title: title.trim(),
      status: "todo",
      priority,
      assigneeId: assigneeIds[0] || null,
      assigneeIds,
      description: cDesc.trim() || null,
      dueAt: cDue ? new Date(cDue).toISOString() : null,
      recurrence: cRecur,
      // PROJECTS-AS-ENTITIES (#52b): file the new task into the chosen project.
      projectId: cProject || null,
      depIds: cDeps,
    });
    close();
  };
  const toggleCreateDep = (id: string) =>
    setCDeps((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const match = (t) =>
    !q.trim() || (t.title || "").toLowerCase().includes(q.toLowerCase());
  // Subtasks (feature #52a) are managed inside their parent's detail panel, so the
  // top-level board/list shows only TOP-LEVEL tasks (parentTaskId == null). A
  // subtask still surfaces via its parent's progress bar + the detail Subtasks
  // section; this just keeps the board from listing children alongside parents.
  const isTopLevel = (t) => !t.parentTaskId;
  const tabMatch = (t) => {
    // "Mine"/"Assigned to me" now match ANY assignee (multi-assignee), not just
    // the primary.
    const isAssignee = isAssigneeOf(t, meId);
    const isCreator = t.creator && t.creator.id === meId;
    if (tab === "all") return true;
    if (tab === "assigned") return isAssignee;
    if (tab === "created") return isCreator;
    return isAssignee || isCreator; // "mine"
  };
  const dueMatch = (t) => {
    if (!fDue) return true;
    const due = t.dueAt ? Date.parse(t.dueAt) : null;
    if (fDue === "none") return !due;
    if (due == null) return false;
    const nowMs = Date.now();
    if (fDue === "overdue") return due < nowMs && t.status !== "done";
    if (fDue === "today")
      return new Date(due).toDateString() === new Date().toDateString();
    if (fDue === "week") return due >= nowMs && due <= nowMs + 7 * 86400e3;
    return true;
  };
  const passesCommon = (t) =>
    (!fPriority || t.priority === fPriority) &&
    (!fAssignee || isAssigneeOf(t, fAssignee)) &&
    dueMatch(t);
  const listTasks = (tasks || []).filter(
    (t) =>
      isTopLevel(t) &&
      tabMatch(t) &&
      match(t) &&
      passesCommon(t) &&
      (fStatus ? t.status === fStatus : t.status !== "archived"),
  );
  const shownTasks = listTasks.slice(0, listLim);
  const allSelected =
    listTasks.length > 0 && listTasks.every((t) => sel.has(t.id));
  const toggleSel = (id) =>
    setSel((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () =>
    setSel(allSelected ? new Set() : new Set(listTasks.map((t) => t.id)));
  const clearSel = () => setSel(new Set());
  const runBulk = async (action, value?) => {
    const ids = [...sel];
    if (!ids.length) return;
    clearSel();
    if (onBulk) await onBulk(action, value, ids);
  };
  const filtersOn = !!(fStatus || fPriority || fAssignee || fDue);
  const modalOpen = add;
  const detail = detailId ? (tasks || []).find((t) => t.id === detailId) : null;

  // PROJECTS (#52b): only non-archived projects are pickable; a fast id→project map.
  const activeProjects = (projects || []).filter((p) => !p.archived);
  const projectById = new Map((projects || []).map((p: any) => [p.id, p]));

  // SWIMLANES (#52b): group the loaded board rows by the chosen field. The SERVER
  // filter (project) still scopes WHICH tasks are loaded; this is a CLIENT-side
  // re-grouping over that page (acceptable for swimlanes per the spec). Returns an
  // ordered [laneKey, label, tasks[]] list. `none` → no swimlanes (status board).
  const laneLabel = (field: string, key: string): string => {
    if (field === "assignee")
      return key === "__none__"
        ? "Unassigned"
        : (users || []).find((u: any) => u.id === key)?.name || "Unknown";
    if (field === "priority") return key;
    if (field === "project")
      return key === "__none__" ? "No project" : projectById.get(key)?.name || "Project";
    if (field === "status")
      return ALL_STATUSES.find(([s]) => s === key)?.[1] || key;
    return key;
  };
  const laneKeysOf = (t: any, field: string): string[] => {
    if (field === "assignee") {
      const ids = assigneesOf(t).map((a: any) => a && a.id).filter(Boolean);
      return ids.length ? ids : ["__none__"];
    }
    if (field === "priority") return [t.priority || "Medium"];
    if (field === "project") return [t.projectId || "__none__"];
    if (field === "status") return [t.status || "todo"];
    return ["__all__"];
  };
  // Deterministic lane ORDER per field (priority High→Low, status board order, …).
  const laneOrder = (field: string, keys: string[]): string[] => {
    if (field === "priority") {
      const rank: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
      return [...keys].sort((a, b) => (rank[a] ?? 9) - (rank[b] ?? 9));
    }
    if (field === "status") {
      const order = ALL_STATUSES.map(([s]) => s);
      return [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    }
    // assignee / project: real keys first (by label), the "__none__" bucket last.
    return [...keys].sort((a, b) => {
      if (a === "__none__") return 1;
      if (b === "__none__") return -1;
      return laneLabel(field, a).localeCompare(laneLabel(field, b));
    });
  };
  const swimlanes = (rows: any[]): [string, string, any[]][] => {
    if (groupBy === "none") return [];
    const buckets = new Map<string, any[]>();
    for (const t of rows)
      for (const key of laneKeysOf(t, groupBy)) {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(t);
      }
    return laneOrder(groupBy, [...buckets.keys()]).map((k) => [
      k,
      laneLabel(groupBy, k),
      buckets.get(k) || [],
    ]);
  };

  // SAVED VIEWS (#52b): capture the CURRENT filter set as a view payload (the
  // server validates it field-by-field), and apply a saved view back onto the
  // controls. `project` in a saved view drives the SERVER query via onProjectFilter
  // so it is not just a page-local filter; the rest are the client filter selects.
  const currentFilter = () => {
    const f: any = {};
    if (fStatus) f.status = fStatus;
    if (fPriority) f.priority = fPriority;
    if (fAssignee) f.assignee = fAssignee;
    if (fDue) f.due = fDue;
    if (q.trim()) f.search = q.trim();
    if (projectFilter && projectFilter !== "none") f.project = projectFilter;
    else if (projectFilter === "none") f.project = "none";
    return f;
  };
  const saveCurrentView = () => {
    const name = saveViewName.trim();
    if (!name || !onSaveView) return;
    onSaveView({ name, filter: currentFilter(), groupBy, sort: "created" });
    setSaveViewName("");
    setSaveViewOpen(false);
  };
  const applyView = (v: any) => {
    const f = v.filter || {};
    setFStatus(f.status || "");
    setFPriority(f.priority || "");
    setFAssignee(f.assignee || "");
    setFDue(f.due || "");
    setQ(f.search || "");
    setGroupBy(v.groupBy || "none");
    // The project filter is SERVER-side — re-query for the view's project scope.
    if (onProjectFilter) onProjectFilter(f.project || "");
    setViewsOpen(false);
  };

  // A single board COLUMN, scoped to `laneTasks` (the swimlane's rows, or the full
  // set when not grouped). Extracted so the flat board and the swimlane layout
  // share ONE renderer (no drift). `keySuffix` keeps React keys unique per lane.
  const renderColumn = (
    status: string,
    label: string,
    laneTasks: any[],
    keySuffix = "",
  ) => {
    const full = laneTasks.filter((t) => t.status === status);
    const limKey = status + keySuffix;
    const lim = colLim[limKey] || 80;
    const list = full.slice(0, lim);
    return (
      <div
        className={"tk-group" + (dragOver === limKey ? " drag-over" : "")}
        key={limKey}
        onDragOver={(e) => {
          e.preventDefault();
          if (dragOver !== limKey) setDragOver(limKey);
        }}
        onDragLeave={() => setDragOver((d) => (d === limKey ? null : d))}
        onDrop={(e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData("text/plain") || dragId;
          setDragOver(null);
          setDragId(null);
          if (id) onMove(id, status);
        }}
      >
        <div className="tk-group-hd">
          <span>{label}</span>
          <span className="tk-group-n">{full.length}</span>
        </div>
        {list.length ? (
          list.map((t) => {
            const pc = prioColor(t.priority);
            const done = t.status === "done";
            const proj = t.projectObj || projectById.get(t.projectId);
            return (
              <div
                className={"tk-row" + (dragId === t.id ? " dragging" : "")}
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", t.id);
                  e.dataTransfer.effectAllowed = "move";
                  draggedRef.current = true;
                  setDragId(t.id);
                }}
                onDragEnd={() => {
                  draggedRef.current = false;
                  setDragId(null);
                  setDragOver(null);
                }}
                onClick={(e) => {
                  // Whole card opens the detail (Kanban) — but not after a drag, and
                  // not when clicking the card's own controls (check / move / delete /
                  // title button, which handle themselves).
                  if (draggedRef.current) return;
                  if ((e.target as HTMLElement).closest("button, select, input, a"))
                    return;
                  setDetailId(t.id);
                }}
              >
                <button
                  className={"tk-check" + (done ? " done" : "")}
                  onClick={() => onMove(t.id, done ? "todo" : "done")}
                  aria-label={done ? "Mark not done" : "Mark done"}
                >
                  <IconCheck />
                </button>
                <button className="tk-row-main" onClick={() => setDetailId(t.id)}>
                  <span className={"tk-row-title" + (done ? " done" : "")}>
                    {t.title}
                  </span>
                </button>
                <div className="tk-row-meta">
                  {proj ? (
                    <span
                      className="tk-proj-tag"
                      style={{
                        background: (proj.color || "#64748b") + "22",
                        color: proj.color || "#64748b",
                      }}
                      title={"Project: " + proj.name}
                    >
                      {proj.name}
                    </span>
                  ) : null}
                  {t.subtaskCount > 0 ? (
                    <TaskProgress
                      done={t.doneSubtaskCount}
                      total={t.subtaskCount}
                      compact
                    />
                  ) : null}
                  {t.recurrence && t.recurrence !== "none" ? (
                    <span
                      className="tk-recur"
                      title={
                        "Repeats " +
                        (RECUR_LABEL[t.recurrence] || t.recurrence).toLowerCase()
                      }
                      aria-label="Recurring task"
                    >
                      <IconRepeat size={12} />
                    </span>
                  ) : null}
                  {t.dueAt ? (
                    <span className="tk-due">{fmtDue(t.dueAt)}</span>
                  ) : t.dueLabel ? (
                    <span className="tk-due">{t.dueLabel}</span>
                  ) : null}
                  <span
                    className="tk-prio"
                    style={{ background: pc[0], color: pc[1] }}
                  >
                    {t.priority}
                  </span>
                  <AvatarStack people={assigneesOf(t)} size={20} />
                  <Select
                    className="td-move"
                    title="Move"
                    value={t.status}
                    onChange={(e) => onMove(t.id, e.target.value)}
                  >
                    {ALL_STATUSES.map(([s, l]) => (
                      <option key={s} value={s}>
                        {l}
                      </option>
                    ))}
                  </Select>
                  <button
                    className="td-del"
                    data-tip="Delete"
                    onClick={() => requestDelete(t)}
                  >
                    <IconX size={14} />
                  </button>
                </div>
              </div>
            );
          })
        ) : (
          <div className="tk-group-empty">No tasks</div>
        )}
        {full.length > list.length ? (
          <button
            className="tk-more"
            onClick={() =>
              setColLim((p) => ({ ...p, [limKey]: (p[limKey] || 80) + 80 }))
            }
          >
            Show {full.length - list.length} more
          </button>
        ) : null}
      </div>
    );
  };

  // The board-eligible top-level tasks for the loaded page (the same predicate the
  // columns used, minus the per-status split). Swimlanes group THESE.
  const boardTasks = (tasks || []).filter(
    (t) => isTopLevel(t) && tabMatch(t) && match(t) && passesCommon(t),
  );

  return (
    <div className="view active" id="vtasks">
      <div className="calls-hdr tk-hd">
        <div className="tk-tabs">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              className={"tk-tab" + (tab === id ? " active" : "")}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="tk-hd-right">
          {token ? (
            <button
              className="btn-c tk-export"
              onClick={exportCsv}
              disabled={exporting}
              title="Export your tasks as a CSV file"
            >
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
          ) : null}
          <button className="btn-p tk-new" onClick={openCreate}>
            + New task
          </button>
        </div>
      </div>
      <div className="tk-filters">
        <div className="tk-view-toggle">
          <button
            className={view === "board" ? "on" : ""}
            onClick={() => setView("board")}
          >
            Board
          </button>
          <button
            className={view === "list" ? "on" : ""}
            onClick={() => setView("list")}
          >
            List
          </button>
        </div>
        <Select
          value={fStatus}
          onChange={(e) => setFStatus(e.target.value)}
          className="tk-filter-sel"
        >
          <option value="">All statuses</option>
          {ALL_STATUSES.map(([sv, l]) => (
            <option key={sv} value={sv}>
              {l}
            </option>
          ))}
        </Select>
        <Select
          value={fPriority}
          onChange={(e) => setFPriority(e.target.value)}
          className="tk-filter-sel"
        >
          <option value="">All priorities</option>
          {PRIOS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
        <Select
          value={fAssignee}
          onChange={(e) => setFAssignee(e.target.value)}
          className="tk-filter-sel"
        >
          <option value="">Any assignee</option>
          {(users || []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <Select
          value={fDue}
          onChange={(e) => setFDue(e.target.value)}
          className="tk-filter-sel"
        >
          <option value="">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="week">Next 7 days</option>
          <option value="none">No due date</option>
        </Select>
        {/* PROJECTS-AS-ENTITIES (#52b): SERVER-SIDE project filter — re-queries the
            server so paging + counts are for the filtered set. */}
        <Select
          value={projectFilter}
          onChange={(e) => onProjectFilter && onProjectFilter(e.target.value)}
          className="tk-filter-sel"
          title="Filter by project"
        >
          <option value="">All projects</option>
          <option value="none">No project</option>
          {activeProjects.map((p: any) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        {/* SWIMLANES (#52b): client-side group-by over the loaded page. */}
        <Select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
          className="tk-filter-sel"
          title="Group board into swimlanes"
        >
          <option value="none">No swimlanes</option>
          <option value="assignee">By assignee</option>
          <option value="priority">By priority</option>
          <option value="project">By project</option>
          <option value="status">By status</option>
        </Select>
        {/* SAVED VIEWS (#52b): apply / save / delete named views. */}
        <div className="tk-views">
          <button
            className="tk-filter-sel tk-views-btn"
            onClick={() => setViewsOpen((o) => !o)}
            title="Saved views"
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            Views <IconChevronDown size={13} />
          </button>
          {viewsOpen ? (
            <div className="tk-views-menu" style={{ left: "auto", right: 0 }} onMouseLeave={() => setViewsOpen(false)}>
              {(views || []).length ? (
                (views || []).map((v: any) => (
                  <div className="tk-views-item" key={v.id}>
                    <button className="tk-views-apply" onClick={() => applyView(v)}>
                      {v.name}
                    </button>
                    {onDeleteView ? (
                      <button
                        className="tk-views-del"
                        title="Delete view"
                        onClick={() => onDeleteView(v.id)}
                      >
                        <IconX size={13} />
                      </button>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="tk-views-empty">No saved views</div>
              )}
              {onSaveView ? (
                <button
                  className="tk-views-save"
                  onClick={() => {
                    setViewsOpen(false);
                    setSaveViewOpen(true);
                  }}
                >
                  + Save current view
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {onCreateProject ? (
          <button
            className="tk-filter-sel tk-proj-manage"
            onClick={() => setProjOpen(true)}
            title="Manage projects"
          >
            Projects…
          </button>
        ) : null}
        {filtersOn ? (
          <button
            className="tk-clear"
            onClick={() => {
              setFStatus("");
              setFPriority("");
              setFAssignee("");
              setFDue("");
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>
      {view === "board" ? (
        groupBy !== "none" ? (
          // SWIMLANES (#52b): one horizontal lane per group value, each lane being
          // a full status board scoped to that lane's tasks. Client-side grouping
          // over the loaded page (the SERVER project filter already scoped WHICH
          // tasks are loaded). The lane header carries the group label + count.
          <div className="tk-swimlanes" id="tasks-list">
            {swimlanes(boardTasks).map(([laneKey, laneName, laneTasks]) => (
              <div className="tk-swimlane" key={laneKey}>
                <div className="tk-swimlane-hd">
                  <span className="tk-swimlane-name">{laneName}</span>
                  <span className="tk-swimlane-n">{laneTasks.length}</span>
                </div>
                <div className="tk-board">
                  {COLS.map(([status, label]) =>
                    renderColumn(status, label, laneTasks, "::" + laneKey),
                  )}
                </div>
              </div>
            ))}
            {swimlanes(boardTasks).length === 0 ? (
              <div className="tk-group-empty">No tasks match.</div>
            ) : null}
            {hasMore && onLoadMore ? (
              <div className="tk-board-more">
                <button
                  className="tk-more"
                  disabled={loadingMore}
                  onClick={() => onLoadMore()}
                >
                  {loadingMore ? "Loading…" : "Load more tasks"}
                </button>
                {typeof totalCount === "number" ? (
                  <span className="tk-count-note">
                    Showing {(tasks || []).length} of {totalCount}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
        <div className="tk-board" id="tasks-list">
          {COLS.map(([status, label]) => renderColumn(status, label, boardTasks))}
          {hasMore && onLoadMore ? (
            // Board-level server pager: the columns only hold the loaded pages,
            // so pull the next page to reveal tasks beyond the first page.
            <div className="tk-board-more">
              <button
                className="tk-more"
                disabled={loadingMore}
                onClick={() => onLoadMore()}
              >
                {loadingMore ? "Loading…" : "Load more tasks"}
              </button>
              {typeof totalCount === "number" ? (
                <span className="tk-count-note">
                  Showing {(tasks || []).length} of {totalCount}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        )
      ) : (
        <div className="tk-listview-wrap">
          {sel.size ? (
            <div className="tk-bulk">
              <span className="tk-bulk-n">{sel.size} selected</span>
              <Select
                className="tk-filter-sel"
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) runBulk("move", v);
                }}
                placeholder="Move to…"
              >
                <option value="">Move to…</option>
                {COLS.map(([sv, l]) => (
                  <option key={sv} value={sv}>
                    {l}
                  </option>
                ))}
              </Select>
              <Select
                className="tk-filter-sel"
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) runBulk("assign", v);
                }}
                placeholder="Assign to…"
              >
                <option value="">Assign to…</option>
                {(users || []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
              <button className="btn-c" onClick={() => runBulk("complete")}>
                Complete
              </button>
              <button className="btn-c" onClick={() => runBulk("archive")}>
                Archive
              </button>
              <button
                className="btn-c tkd-del"
                onClick={() => runBulk("delete")}
              >
                Delete
              </button>
              <button className="btn-c" onClick={clearSel}>
                Clear
              </button>
            </div>
          ) : null}
          <div className="tk-listview">
            <div className="tk-lv-row tk-lv-head">
              <button
                className={"tk-check sm" + (allSelected ? " done" : "")}
                onClick={toggleAll}
                aria-label="Select all"
              >
                <IconCheck />
              </button>
              <span className="tk-lv-title-h">Task</span>
              <span className="tk-lv-c">Status</span>
              <span className="tk-lv-c">Priority</span>
              <span className="tk-lv-c">Assignee</span>
              <span className="tk-lv-c">Due</span>
            </div>
            {listTasks.length ? (
              shownTasks.map((t) => {
                const pc = prioColor(t.priority);
                return (
                  <div
                    className={"tk-lv-row" + (sel.has(t.id) ? " sel" : "")}
                    key={t.id}
                  >
                    <button
                      className={"tk-check sm" + (sel.has(t.id) ? " done" : "")}
                      onClick={() => toggleSel(t.id)}
                      aria-label="Select task"
                    >
                      <IconCheck />
                    </button>
                    <button
                      className="tk-lv-title"
                      onClick={() => setDetailId(t.id)}
                    >
                      {t.title}
                    </button>
                    <span className="tk-lv-c">
                      <span className={"tk-st-badge st-" + t.status}>
                        {STATUS_LABEL[t.status] || t.status}
                      </span>
                    </span>
                    <span className="tk-lv-c">
                      <span
                        className="tk-prio"
                        style={{ background: pc[0], color: pc[1] }}
                      >
                        {t.priority}
                      </span>
                    </span>
                    <span className="tk-lv-c">
                      {assigneesOf(t).length ? (
                        <AvatarStack people={assigneesOf(t)} size={22} />
                      ) : (
                        <span className="tk-lv-dash">—</span>
                      )}
                    </span>
                    <span className="tk-lv-c tk-lv-due">
                      {t.dueAt ? fmtDue(t.dueAt) : t.dueLabel || "—"}
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="tk-group-empty">No tasks match.</div>
            )}
            {listTasks.length > shownTasks.length ? (
              <button
                className="tk-more"
                onClick={() => setListLim((n) => n + 100)}
              >
                Show {listTasks.length - shownTasks.length} more
              </button>
            ) : hasMore && onLoadMore ? (
              // The loaded set is exhausted but the server has more pages — pull
              // the next keyset page so tasks past the first page aren't hidden.
              <button
                className="tk-more"
                disabled={loadingMore}
                onClick={() => onLoadMore()}
              >
                {loadingMore ? "Loading…" : "Load more tasks"}
              </button>
            ) : null}
          </div>
          {typeof totalCount === "number" ? (
            <div className="tk-count-note">
              Showing {listTasks.length} of {totalCount}
            </div>
          ) : null}
        </div>
      )}

      {modalOpen ? (
        <Modal
          title="New Task"
          onClose={close}
          footer={
            <>
              <Btn onClick={close}>Cancel</Btn>
              <Btn primary disabled={!title.trim()} onClick={submit}>
                Create
              </Btn>
            </>
          }
        >
          <input
            name="task-title"
            autoComplete="off"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            style={inp}
            autoFocus
          />
          <div style={{ marginTop: 8 }}>
            <textarea
              ref={cDescRef}
              value={cDesc}
              onChange={(e) => setCDesc(e.target.value)}
              placeholder="Description (optional)"
              style={{ ...inp, width: "100%", minHeight: 64, resize: "none", overflow: "hidden" }}
            />
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              style={{ ...inp, flex: 1 }}
            >
              <option value="High">High priority</option>
              <option value="Medium">Medium priority</option>
              <option value="Low">Low priority</option>
            </Select>
            <input
              type="date"
              value={cDue}
              onChange={(e) => setCDue(e.target.value)}
              title="Due date"
              style={{ ...inp, flex: 1 }}
            />
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <Select
              value={cRecur}
              onChange={(e) => setCRecur(e.target.value)}
              title="Repeat"
              style={{ ...inp, flex: 1 }}
            >
              {RECURRENCES.map(([rv, l]) => (
                <option key={rv} value={rv}>
                  {l}
                </option>
              ))}
            </Select>
            {/* PROJECTS-AS-ENTITIES (#52b): file the new task into a project. */}
            <Select
              value={cProject}
              onChange={(e) => setCProject(e.target.value)}
              title="Project"
              style={{ ...inp, flex: 1 }}
            >
              <option value="">No project</option>
              {activeProjects.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div style={{ marginTop: 8 }}>
            <div className="tk-asn-label">Assignees</div>
            {/* Empty box shows the top ~10 most-interacted people (not the whole
                org); type to search everyone by name/email. SELECTED people are
                always pinned in so you never lose sight of who's picked. */}
            <input
              type="text"
              value={asnQ}
              onChange={(e) => setAsnQ(e.target.value)}
              placeholder="Search people…"
              aria-label="Search assignees"
              style={{ ...inp, width: "100%", marginBottom: 8 }}
            />
            <div className="tk-asn-pick">
              {asnVisible.map((u) => {
                  const on = assigneeIds.includes(u.id);
                  return (
                    <button
                      type="button"
                      key={u.id}
                      className={"tk-asn-chip" + (on ? " on" : "")}
                      onClick={() => toggleCreateAssignee(u.id)}
                    >
                      <Avatar
                        avatar={{
                          kind: "user",
                          initials: u.initials,
                          color: u.color,
                          avatarUrl: u.avatarUrl,
                        }}
                        size={18}
                      />
                      <span>{u.name}</span>
                      {on ? <span className="tk-asn-x"><IconCheck size={13} /></span> : null}
                    </button>
                  );
                })}
            </div>
            {!asnTrim && asnHidden > 0 ? (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--g500)",
                  margin: "6px 2px 0",
                }}
              >
                Showing top {asnVisible.length}
              </div>
            ) : null}
          </div>
          {(tasks || []).length ? (
            <div style={{ marginTop: 8 }}>
              <div className="tk-asn-label">Blocked by (optional)</div>
              <div className="tk-asn-pick">
                {(tasks || [])
                  .filter((t) => t.status !== "archived")
                  .slice(0, 60)
                  .map((t) => {
                    const on = cDeps.includes(t.id);
                    return (
                      <button
                        type="button"
                        key={t.id}
                        className={"tk-asn-chip" + (on ? " on" : "")}
                        onClick={() => toggleCreateDep(t.id)}
                        title={t.title}
                      >
                        <span className={"tkd-dep-st st-" + t.status} />
                        <span className="tk-dep-pick-t">{t.title}</span>
                        {on ? <span className="tk-asn-x"><IconCheck size={13} /></span> : null}
                      </button>
                    );
                  })}
              </div>
            </div>
          ) : null}
        </Modal>
      ) : null}
      {/* SAVED VIEWS (#52b): name + persist the current filter set as a view. */}
      {saveViewOpen ? (
        <Modal
          title="Save view"
          onClose={() => setSaveViewOpen(false)}
          footer={
            <>
              <Btn onClick={() => setSaveViewOpen(false)}>Cancel</Btn>
              <Btn primary disabled={!saveViewName.trim()} onClick={saveCurrentView}>
                Save
              </Btn>
            </>
          }
        >
          <input
            name="view-name"
            autoComplete="off"
            value={saveViewName}
            onChange={(e) => setSaveViewName(e.target.value)}
            placeholder="View name (e.g. My high-priority)"
            style={inp}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") saveCurrentView();
            }}
          />
          <div className="tk-view-summary">
            Saves the current filters
            {groupBy !== "none" ? ` + swimlanes by ${groupBy}` : ""}.
          </div>
        </Modal>
      ) : null}
      {/* PROJECTS-AS-ENTITIES (#52b): create / rename / recolor / archive / delete. */}
      {projOpen ? (
        <Modal
          title="Projects"
          onClose={() => setProjOpen(false)}
          footer={<Btn onClick={() => setProjOpen(false)}>Done</Btn>}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input
              name="new-project"
              autoComplete="off"
              value={newProjName}
              onChange={(e) => setNewProjName(e.target.value)}
              placeholder="New project name"
              style={{ ...inp, flex: 1 }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newProjName.trim() && onCreateProject) {
                  onCreateProject({ name: newProjName.trim() });
                  setNewProjName("");
                }
              }}
            />
            <Btn
              primary
              disabled={!newProjName.trim()}
              onClick={() => {
                if (onCreateProject) onCreateProject({ name: newProjName.trim() });
                setNewProjName("");
              }}
            >
              Add
            </Btn>
          </div>
          <div className="tk-proj-list">
            {(projects || []).length ? (
              (projects || []).map((p: any) => (
                <div className="tk-proj-row" key={p.id}>
                  <span
                    className="tk-proj-dot"
                    style={{ background: p.color || "#64748b" }}
                  />
                  <input
                    className="tk-proj-name-inp"
                    defaultValue={p.name}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== p.name && onUpdateProject)
                        onUpdateProject(p.id, { name: v });
                    }}
                  />
                  <input
                    type="color"
                    className="tk-proj-color"
                    defaultValue={p.color || "#64748b"}
                    title="Project color"
                    onChange={(e) =>
                      onUpdateProject && onUpdateProject(p.id, { color: e.target.value })
                    }
                  />
                  <button
                    className="tk-proj-arch"
                    title={p.archived ? "Unarchive" : "Archive"}
                    onClick={() =>
                      onUpdateProject &&
                      onUpdateProject(p.id, { archived: !p.archived })
                    }
                  >
                    {p.archived ? "Unarchive" : "Archive"}
                  </button>
                  <button
                    className="tk-proj-del"
                    title="Delete project (tasks are kept, just un-filed)"
                    onClick={() => onDeleteProject && onDeleteProject(p.id)}
                  >
                    <IconX size={13} />
                  </button>
                </div>
              ))
            ) : (
              <div className="tk-group-empty">No projects yet.</div>
            )}
          </div>
        </Modal>
      ) : null}
      {detail ? (
        <TaskDetail
          task={detail}
          users={users}
          token={token}
          meId={meId}
          allTasks={tasks}
          tick={tick}
          onUpdate={onUpdate}
          onSetAssignees={onSetAssignees}
          onWatch={onWatch}
          conflict={conflict && conflict.id === detail.id ? conflict : null}
          onClearConflict={onClearConflict}
          projects={projects}
          onClose={() => {
            if (onClearConflict) onClearConflict();
            setDetailId(null);
          }}
          onToast={onToast}
          onDelete={(id) => {
            // Route through the shared confirm modal (don't delete on first click);
            // close the panel so the confirm is the only surface in focus.
            const t = (tasks || []).find((x) => x.id === id) || { id };
            setDetailId(null);
            requestDelete(t);
          }}
        />
      ) : null}
      {pendingDelete ? (
        <Modal
          title="Delete task?"
          onClose={() => setPendingDelete(null)}
          footer={
            <>
              <Btn onClick={() => setPendingDelete(null)}>Cancel</Btn>
              <Btn primary onClick={confirmDelete}>
                Delete
              </Btn>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            Delete “{pendingDelete.title || "this task"}”? This moves it out of
            your board. This can’t be undone from here.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

function fmtDue(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const today = new Date();
  const tom = new Date();
  tom.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tom.toDateString()) return "Tomorrow";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function fmtWhen(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return (
    d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  );
}
function fmtBytes(n: number) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + " MB";
  return (b / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}
const PRIOS = ["High", "Medium", "Low"];
const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  inprogress: "In progress",
  review: "In review",
  blocked: "Blocked",
  done: "Done",
  archived: "Archived",
};

function TaskDetail({
  task,
  users,
  token,
  allTasks,
  tick,
  onUpdate,
  onSetAssignees,
  onWatch,
  onClose,
  onDelete,
  onToast,
  meId,
  conflict,
  onClearConflict,
  // PROJECTS-AS-ENTITIES (#52b): pickable projects for the detail project select.
  projects = [],
}) {
  const [ttl, setTtl] = useState(task.title);
  const [desc, setDesc] = useState(task.description || "");
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoGrow(descRef, desc);
  const [labelInput, setLabelInput] = useState("");
  const [depPick, setDepPick] = useState("");
  const [activity, setActivity] = useState<any[]>([]);
  const [deps, setDeps] = useState<any>({ blockedBy: [], blocking: [] });
  const [comments, setComments] = useState<any[]>([]);
  const [cInput, setCInput] = useState("");
  // Attachments (feature #51): the live list (seeded from the serialized task,
  // refreshed after each link/unlink), an upload-in-progress flag + % for the
  // reused Files upload flow, and the inline delete-confirm id for a remove.
  const [attachments, setAttachments] = useState<any[]>(task.attachments || []);
  const [upBusy, setUpBusy] = useState(false);
  const [upPct, setUpPct] = useState(0);
  const [attConfirmId, setAttConfirmId] = useState<string | null>(null);
  // Subtasks (feature #52a): the live child list (loaded from the server), the
  // new-subtask input, and a busy flag while adding.
  const [subtasks, setSubtasks] = useState<any[]>([]);
  const [subInput, setSubInput] = useState("");
  const [subBusy, setSubBusy] = useState(false);
  const attInputRef = React.useRef<HTMLInputElement | null>(null);
  // LIVE-MERGE without clobbering in-progress typing: track the last server
  // baseline for the title/description. When a remote change arrives (the `task`
  // prop updates), adopt the new server value into the input ONLY IF the user
  // hasn't diverged from the previous baseline (i.e. the field isn't dirty). If
  // it IS dirty, keep the user's text and let the conflict banner offer a
  // non-destructive way to load the latest. Seeded fresh on task switch.
  const baseTtlRef = React.useRef(task.title);
  const baseDescRef = React.useRef(task.description || "");
  useEffect(() => {
    setTtl(task.title);
    setDesc(task.description || "");
    baseTtlRef.current = task.title;
    baseDescRef.current = task.description || "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);
  useEffect(() => {
    // Remote title change (same task): merge in if the local field is clean.
    if (task.title !== baseTtlRef.current) {
      setTtl((cur) => (cur === baseTtlRef.current ? task.title : cur));
      baseTtlRef.current = task.title;
    }
    const remoteDesc = task.description || "";
    if (remoteDesc !== baseDescRef.current) {
      setDesc((cur) => (cur === baseDescRef.current ? remoteDesc : cur));
      baseDescRef.current = remoteDesc;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.title, task.description]);
  const titleDirty = ttl !== (task.title || "");
  const descDirty = desc !== (task.description || "");
  const loadAux = React.useCallback(() => {
    void tick; // `tick` is a deliberate reload TRIGGER (bumped to force a refetch);
    // referencing it here makes it a legitimate dep instead of an "unnecessary" one.
    if (!token) return;
    api
      .getTaskActivity(token, task.id)
      .then(setActivity)
      .catch(() => {});
    api
      .getTaskDeps(token, task.id)
      .then(setDeps)
      .catch(() => {});
    api
      .getTaskComments(token, task.id)
      .then(setComments)
      .catch(() => {});
    api
      .listTaskAttachments(token, task.id)
      .then((r) => setAttachments(Array.isArray(r) ? r : []))
      .catch(() => {});
    api
      .listSubtasks(token, task.id)
      .then((r) => setSubtasks(Array.isArray(r) ? r : []))
      .catch(() => {});
  }, [token, task.id, tick]);
  useEffect(() => {
    loadAux();
  }, [loadAux]);
  // Re-seed attachments from the serialized task when it (or the task id) changes
  // — a live TASK_CHANGED refetch carries the current attachments[].
  useEffect(() => {
    setAttachments(task.attachments || []);
  }, [task.id, task.attachments]);

  const save = (patch) => onUpdate(task.id, patch);
  const labels = task.labels || [];
  const addLabel = () => {
    const v = labelInput.trim();
    setLabelInput("");
    if (!v || labels.includes(v)) return;
    save({ labels: [...labels, v] });
  };
  const removeLabel = (l) => save({ labels: labels.filter((x) => x !== l) });
  const addDep = async () => {
    if (!token || !depPick) return;
    await api.addTaskDep(token, task.id, depPick).catch(() => {});
    setDepPick("");
    loadAux();
  };
  const removeDep = async (depId) => {
    if (!token) return;
    await api.removeTaskDep(token, task.id, depId).catch(() => {});
    loadAux();
  };
  // ── Attachments ─────────────────────────────────────────────────────────────
  // Upload reuses the EXISTING Files pipeline (api.uploadFile streams the blob to
  // S3 and creates a `files` row), THEN links the resulting file id to the task.
  // No new uploader. onProgress drives the inline progress bar.
  const uploadAttachment = async (file: File) => {
    if (!token || !file) return;
    setUpBusy(true);
    setUpPct(0);
    try {
      const uploaded = await api.uploadFile(
        token,
        file,
        undefined,
        (pct: number) => setUpPct(pct),
      );
      if (uploaded && uploaded.id) {
        const list = await api.attachTaskFile(token, task.id, uploaded.id);
        if (Array.isArray(list)) setAttachments(list);
        onUpdate && onUpdate(task.id, {}); // nudge a board refetch (no field change)
      }
    } catch (e: any) {
      onToast && onToast(e?.message || "Upload failed");
    } finally {
      setUpBusy(false);
      setUpPct(0);
    }
  };
  const removeAttachment = async (fileId: string) => {
    setAttConfirmId(null);
    if (!token) return;
    try {
      const list = await api.detachTaskFile(token, task.id, fileId);
      if (Array.isArray(list)) setAttachments(list);
      onUpdate && onUpdate(task.id, {});
    } catch (e: any) {
      onToast && onToast(e?.message || "Couldn't remove the attachment");
    }
  };
  const downloadAttachment = async (att: any) => {
    if (!token) return;
    try {
      const blob = await api.downloadFile(token, att.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = att.name || "file";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      onToast && onToast(e?.message || "Download failed");
    }
  };
  // ── Subtasks ─────────────────────────────────────────────────────────────
  const addSubtask = async () => {
    const v = subInput.trim();
    if (!v || !token || subBusy) return;
    setSubBusy(true);
    try {
      const created = await api.createSubtask(token, task.id, { title: v });
      setSubInput("");
      if (created) setSubtasks((prev) => [...prev, created]);
      // Nudge the board so the parent's progress (subtaskCount) refreshes.
      onUpdate && onUpdate(task.id, {});
    } catch (e: any) {
      onToast && onToast(e?.message || "Couldn't add the subtask");
    } finally {
      setSubBusy(false);
    }
  };
  // Toggle a subtask done/undone. A subtask is an ordinary task, so we reuse
  // onUpdate (status patch) — the server gates access + clears the due stamp. The
  // local list is optimistically flipped, then the board is nudged so the parent
  // progress reflects it.
  const toggleSubtask = async (st: any) => {
    if (!token) return;
    const next = st.status === "done" ? "todo" : "done";
    setSubtasks((prev) =>
      prev.map((s) => (s.id === st.id ? { ...s, status: next } : s)),
    );
    try {
      await api.updateTask(token, st.id, { status: next });
      onUpdate && onUpdate(task.id, {});
    } catch (e: any) {
      // Roll back on failure (e.g. blocked-by-dependency) + surface the reason.
      setSubtasks((prev) =>
        prev.map((s) => (s.id === st.id ? { ...s, status: st.status } : s)),
      );
      onToast && onToast(e?.message || "Couldn't update the subtask");
    }
  };
  const subDone = subtasks.filter((s) => s.status === "done").length;

  const postComment = async () => {
    const v = cInput.trim();
    if (!v || !token) return;
    setCInput("");
    const updated = await api
      .addTaskComment(token, task.id, v)
      .catch(() => null);
    if (updated) setComments(updated);
  };
  const deleteComment = async (cid) => {
    if (!token) return;
    const updated = await api
      .removeTaskComment(token, task.id, cid)
      .catch(() => null);
    if (updated) setComments(updated);
  };
  const userName = (id) => {
    const u = (users || []).find((x) => x.id === id);
    return u ? u.name : "someone";
  };
  const describe = (a) => {
    const d = a.detail || {};
    switch (a.kind) {
      case "created":
        return "created this task";
      case "status_changed":
        return `moved ${STATUS_LABEL[d.from] || d.from || "?"} → ${
          STATUS_LABEL[d.to] || d.to || "?"
        }`;
      case "assigned":
        return d.to ? `assigned to ${userName(d.to)}` : "unassigned this task";
      case "assignee_added":
        return `added ${userName(d.user)} as an assignee`;
      case "assignee_removed":
        return `removed ${userName(d.user)} as an assignee`;
      case "assignees_set": {
        const parts: string[] = [];
        if ((d.added || []).length)
          parts.push("added " + d.added.map(userName).join(", "));
        if ((d.removed || []).length)
          parts.push("removed " + d.removed.map(userName).join(", "));
        return parts.length ? parts.join("; ") : "updated assignees";
      }
      case "updated":
        return `updated ${(d.fields || []).join(", ")}`;
      case "dependency_added":
        return "added a dependency";
      case "attachment_added":
        return "attached a file";
      case "attachment_removed":
        return "removed an attachment";
      case "subtask_added":
        return d.title ? `added a subtask “${d.title}”` : "added a subtask";
      case "parent_changed":
        return d.parentId ? "moved under a parent task" : "made this a top-level task";
      case "recurrence_spawned":
        return "created the next recurring occurrence";
      case "commented":
        return "commented";
      default:
        return a.kind;
    }
  };
  const dueValue = task.dueAt
    ? new Date(task.dueAt).toISOString().slice(0, 10)
    : "";
  const depCandidates = (allTasks || []).filter(
    (t) => t.id !== task.id && !deps.blockedBy.some((b) => b.id === t.id),
  );
  // DEPENDENCY ENFORCEMENT (feature #51): the blockers that are still OPEN (not
  // done/archived). While any remain, marking this task Done is rejected
  // server-side — so the UI disables the Done option + explains why (the server
  // is still the authority; this is only an affordance). Mirrors the server's
  // RESOLVED_STATUSES set.
  const RESOLVED = new Set(["done", "archived"]);
  const openBlockers = (deps.blockedBy || []).filter(
    (b: any) => !RESOLVED.has(b.status),
  );
  const blockedFromDone = openBlockers.length > 0 && task.status !== "done";

  // --- Multiple assignees ---------------------------------------------------
  const taskAssignees = assigneesOf(task);
  const assigneeIdSet = new Set(taskAssignees.map((a: any) => a.id));
  const [asnOpen, setAsnOpen] = useState(false);
  const toggleAssignee = (uid: string) => {
    if (!onSetAssignees) return;
    const next = new Set(assigneeIdSet);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    onSetAssignees(task.id, [...next]);
  };

  // --- Watchers -------------------------------------------------------------
  // Resolve watcher ids (the server sends id strings) to user objects for avatars.
  const watcherIds: string[] = Array.isArray(task.watchers) ? task.watchers : [];
  const watcherUsers = watcherIds
    .map((id) => (users || []).find((u: any) => u.id === id))
    .filter(Boolean);
  const iAmWatching = watcherIds.includes(meId);

  return (
    <div className="tkd-panel">
      <div className="tkd-head">
        <input
          className="tkd-title"
          value={ttl}
          onChange={(e) => setTtl(e.target.value)}
          onBlur={() => {
            const v = ttl.trim();
            if (v && v !== task.title) save({ title: v });
            else setTtl(task.title);
          }}
        />
        {onWatch ? (
          <button
            className={"tkd-watch-btn" + (iAmWatching ? " on" : "")}
            onClick={() => onWatch(task.id, !iAmWatching)}
            title={iAmWatching ? "Stop watching this task" : "Watch this task"}
          >
            <IconEye size={16} />
            {iAmWatching ? "Watching" : "Watch"}
          </button>
        ) : null}
        <button className="thread-close" onClick={onClose} aria-label="Close">
          <IconX />
        </button>
      </div>
      {conflict ? (
        <div className="tkd-conflict" role="status">
          <span className="tkd-conflict-msg">
            This task was changed by someone else. Your edits weren’t saved.
          </span>
          <div className="tkd-conflict-acts">
            {titleDirty || descDirty ? (
              <button
                className="btn-c"
                onClick={() => {
                  // Re-apply the user's local edits on top of the now-current
                  // version (onUpdate reads the freshest version from state, so
                  // this no longer conflicts). Non-destructive: keeps their text.
                  const patch: any = {};
                  if (titleDirty && ttl.trim()) patch.title = ttl.trim();
                  if (descDirty) patch.description = desc;
                  if (Object.keys(patch).length) save(patch);
                  if (onClearConflict) onClearConflict();
                }}
              >
                Keep my changes
              </button>
            ) : null}
            <button
              className="btn-c"
              onClick={() => {
                // Discard local edits and adopt the latest server values.
                setTtl(task.title);
                setDesc(task.description || "");
                baseTtlRef.current = task.title;
                baseDescRef.current = task.description || "";
                if (onClearConflict) onClearConflict();
              }}
            >
              Use latest
            </button>
          </div>
        </div>
      ) : null}
      <div className="tkd-body">
        <div className="tkd-grid">
          <label className="tkd-field">
            <span>Status</span>
            <Select
              value={task.status}
              onChange={(e) => save({ status: e.target.value })}
            >
              {Object.keys(STATUS_LABEL).map((sk) => (
                <option
                  key={sk}
                  value={sk}
                  // Can't mark Done while blockers are open (server enforces it
                  // too; this disables the option so it's clear up-front).
                  disabled={sk === "done" && blockedFromDone}
                >
                  {STATUS_LABEL[sk]}
                  {sk === "done" && blockedFromDone ? " (blocked)" : ""}
                </option>
              ))}
            </Select>
          </label>
          <label className="tkd-field">
            <span>Priority</span>
            <Select
              value={task.priority}
              onChange={(e) => save({ priority: e.target.value })}
            >
              {PRIOS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </label>
          <div className="tkd-field tkd-field-assignees">
            <span>Assignees</span>
            {onSetAssignees ? (
              <div className="tkd-asn">
                <div className="tkd-asn-current">
                  {taskAssignees.length ? (
                    taskAssignees.map((a: any) => (
                      <span className="tkd-asn-tag" key={a.id}>
                        <Avatar
                          avatar={{
                            kind: "user",
                            initials: a.initials,
                            color: a.color,
                            avatarUrl: a.avatarUrl,
                          }}
                          size={18}
                        />
                        <span className="tkd-asn-name">{a.name}</span>
                        <button
                          type="button"
                          aria-label={"Remove " + a.name}
                          onClick={() => toggleAssignee(a.id)}
                        >
                          <IconX size={12} />
                        </button>
                      </span>
                    ))
                  ) : (
                    <span className="tk-lv-dash">Unassigned</span>
                  )}
                  <button
                    type="button"
                    className="tkd-asn-add"
                    onClick={() => setAsnOpen((o) => !o)}
                  >
                    + Add
                  </button>
                </div>
                {asnOpen ? (
                  <div className="tkd-asn-menu">
                    {(users || []).map((u: any) => {
                      const on = assigneeIdSet.has(u.id);
                      return (
                        <button
                          type="button"
                          key={u.id}
                          className={"tkd-asn-opt" + (on ? " on" : "")}
                          onClick={() => toggleAssignee(u.id)}
                        >
                          <Avatar
                            avatar={{
                              kind: "user",
                              initials: u.initials,
                              color: u.color,
                              avatarUrl: u.avatarUrl,
                            }}
                            size={18}
                          />
                          <span>{u.name}</span>
                          {on ? <span className="tkd-asn-check"><IconCheck size={13} /></span> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : (
              // Fallback (no multi-assignee handler wired): legacy single select.
              <Select
                value={(task.assignee && task.assignee.id) || ""}
                onChange={(e) => save({ assigneeId: e.target.value || null })}
              >
                <option value="">Unassigned</option>
                {(users || []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <label className="tkd-field">
            <span>Due date</span>
            <input
              type="date"
              value={dueValue}
              onChange={(e) =>
                save({
                  dueAt: e.target.value
                    ? new Date(e.target.value).toISOString()
                    : null,
                })
              }
            />
          </label>
          <label className="tkd-field">
            <span>Repeat</span>
            <Select
              value={task.recurrence || "none"}
              onChange={(e) => save({ recurrence: e.target.value })}
            >
              {RECURRENCES.map(([rv, l]) => (
                <option key={rv} value={rv}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
          {/* PROJECTS-AS-ENTITIES (#52b): repoint the task's project (server
              re-files + keeps the legacy text in sync; IDOR-guarded server-side). */}
          <label className="tkd-field">
            <span>Project</span>
            <Select
              value={task.projectId || ""}
              onChange={(e) => save({ projectId: e.target.value || null })}
            >
              <option value="">No project</option>
              {(projects || [])
                .filter((p: any) => !p.archived || p.id === task.projectId)
                .map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </label>
        </div>

        <div className="tkd-sec">
          <div className="tkd-sec-h">Description</div>
          <textarea
            ref={descRef}
            className="tkd-desc"
            value={desc}
            placeholder="Add a description…"
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => {
              if (desc !== (task.description || ""))
                save({ description: desc });
            }}
          />
        </div>

        <div className="tkd-sec">
          <div className="tkd-sec-h">
            Subtasks
            {subtasks.length ? (
              <span className="tkd-sec-h-aside">
                <TaskProgress done={subDone} total={subtasks.length} />
              </span>
            ) : null}
          </div>
          <div className="tkd-subtasks">
            {subtasks.length ? (
              subtasks.map((st) => {
                const done = st.status === "done";
                return (
                  <div className="tkd-subtask" key={st.id}>
                    <button
                      className={"tk-check sm" + (done ? " done" : "")}
                      onClick={() => toggleSubtask(st)}
                      aria-label={done ? "Mark not done" : "Mark done"}
                    >
                      <IconCheck />
                    </button>
                    <span className={"tkd-subtask-t" + (done ? " done" : "")}>
                      {st.title}
                    </span>
                    {assigneesOf(st).length ? (
                      <AvatarStack people={assigneesOf(st)} size={18} max={2} />
                    ) : null}
                  </div>
                );
              })
            ) : (
              <div className="tkd-act-empty">No subtasks yet.</div>
            )}
          </div>
          {token ? (
            <div className="tkd-subtask-add">
              <input
                value={subInput}
                placeholder="Add a subtask…"
                onChange={(e) => setSubInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addSubtask();
                  }
                }}
              />
              <button
                className="btn-c"
                disabled={!subInput.trim() || subBusy}
                onClick={addSubtask}
              >
                {subBusy ? "Adding…" : "Add"}
              </button>
            </div>
          ) : null}
        </div>

        <div className="tkd-sec">
          <div className="tkd-sec-h">Labels</div>
          <div className="tkd-labels">
            {labels.map((l) => (
              <span className="tkd-label" key={l}>
                {l}
                <button
                  onClick={() => removeLabel(l)}
                  aria-label={"Remove " + l}
                >
                  <IconX size={12} />
                </button>
              </span>
            ))}
            <input
              className="tkd-label-in"
              value={labelInput}
              placeholder="Add label…"
              onChange={(e) => setLabelInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addLabel();
                }
              }}
            />
          </div>
        </div>

        <div className="tkd-sec">
          <div className="tkd-sec-h">Watchers</div>
          <div className="tkd-watchers">
            {watcherUsers.length ? (
              watcherUsers.map((w: any) => (
                <span className="tkd-watcher" key={w.id} title={w.name}>
                  <Avatar
                    avatar={{
                      kind: "user",
                      initials: w.initials,
                      color: w.color,
                      avatarUrl: w.avatarUrl,
                    }}
                    size={22}
                  />
                  <span className="tkd-watcher-n">{w.name}</span>
                </span>
              ))
            ) : (
              <span className="tk-lv-dash">No watchers yet.</span>
            )}
          </div>
          {onWatch ? (
            <button
              className={"btn-c tkd-watch-toggle" + (iAmWatching ? " on" : "")}
              onClick={() => onWatch(task.id, !iAmWatching)}
            >
              {iAmWatching ? "Stop watching" : "Watch this task"}
            </button>
          ) : null}
        </div>

        <div className="tkd-sec">
          <div className="tkd-sec-h">Dependencies</div>
          {blockedFromDone ? (
            <div className="tkd-dep-block" role="status">
              Blocked: finish {openBlockers.length} unfinished{" "}
              {openBlockers.length === 1 ? "blocker" : "blockers"} before this can
              be marked done.
            </div>
          ) : null}
          {deps.blockedBy.length ? (
            <div className="tkd-deps">
              <div className="tkd-deps-l">Blocked by</div>
              {deps.blockedBy.map((d) => (
                <div className="tkd-dep" key={d.id}>
                  <span className={"tkd-dep-st st-" + d.status} />
                  <span className="tkd-dep-t">{d.title}</span>
                  <button
                    onClick={() => removeDep(d.id)}
                    aria-label="Remove dependency"
                  >
                    <IconX size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {deps.blocking.length ? (
            <div className="tkd-deps">
              <div className="tkd-deps-l">Blocking</div>
              {deps.blocking.map((d) => (
                <div className="tkd-dep" key={d.id}>
                  <span className={"tkd-dep-st st-" + d.status} />
                  <span className="tkd-dep-t">{d.title}</span>
                </div>
              ))}
            </div>
          ) : null}
          {token ? (
            <div className="tkd-dep-add">
              <Select
                value={depPick}
                onChange={(e) => setDepPick(e.target.value)}
              >
                <option value="">Add “blocked by”…</option>
                {depCandidates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </Select>
              <button className="btn-c" disabled={!depPick} onClick={addDep}>
                Add
              </button>
            </div>
          ) : null}
        </div>

        <div className="tkd-sec">
          <div className="tkd-sec-h">Attachments</div>
          <div className="tkd-attachments">
            {attachments.length ? (
              attachments.map((att) => (
                <div className="tkd-att" key={att.id}>
                  <span className="tkd-att-ico" aria-hidden>
                    <IconPaperclip size={14} />
                  </span>
                  <button
                    type="button"
                    className="tkd-att-name"
                    title={att.name}
                    onClick={() => downloadAttachment(att)}
                  >
                    {att.name}
                  </button>
                  <span className="tkd-att-size">{fmtBytes(att.size)}</span>
                  {attConfirmId === att.id ? (
                    <span className="tkd-att-confirm">
                      <button
                        type="button"
                        className="tkd-att-yes"
                        onClick={() => removeAttachment(att.id)}
                      >
                        Remove?
                      </button>
                      <button
                        type="button"
                        className="tkd-att-no"
                        onClick={() => setAttConfirmId(null)}
                      >
                        <IconX size={12} />
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="tkd-att-del"
                      title="Remove attachment"
                      onClick={() => setAttConfirmId(att.id)}
                    >
                      <IconX size={12} />
                    </button>
                  )}
                </div>
              ))
            ) : (
              <div className="tkd-act-empty">No attachments yet.</div>
            )}
          </div>
          {token ? (
            <div className="tkd-att-add">
              <input
                ref={attInputRef}
                type="file"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  if (f) uploadAttachment(f);
                  e.target.value = "";
                }}
              />
              {upBusy ? (
                <span className="tkd-att-progress">Uploading… {upPct}%</span>
              ) : (
                <button
                  type="button"
                  className="btn-c"
                  onClick={() =>
                    attInputRef.current && attInputRef.current.click()
                  }
                >
                  + Attach a file
                </button>
              )}
            </div>
          ) : null}
        </div>

        <div className="tkd-sec">
          <div className="tkd-sec-h">Comments</div>
          <div className="tkd-comments">
            {comments.length ? (
              comments.map((c) => (
                <div className="tkd-cmt" key={c.id}>
                  <Avatar
                    avatar={{
                      kind: "user",
                      initials: (c.author && c.author.initials) || "?",
                      color: (c.author && c.author.color) || "#94A3B8",
                      avatarUrl: c.author && c.author.avatarUrl,
                    }}
                    size={24}
                  />
                  <div className="tkd-cmt-b">
                    <div className="tkd-cmt-h">
                      <span className="tkd-cmt-who">
                        {c.author ? c.author.name : "Someone"}
                      </span>
                      <span className="tkd-cmt-when">
                        {fmtWhen(c.createdAt)}
                      </span>
                      {c.author && c.author.id === meId ? (
                        <button
                          className="tkd-cmt-del"
                          title="Delete comment"
                          onClick={() => deleteComment(c.id)}
                        >
                          <IconX size={12} />
                        </button>
                      ) : null}
                    </div>
                    <div className="tkd-cmt-t">{c.body}</div>
                  </div>
                </div>
              ))
            ) : (
              <div className="tkd-act-empty">No comments yet.</div>
            )}
          </div>
          {token ? (
            <div className="tkd-cmt-add">
              <input
                value={cInput}
                placeholder="Write a comment…"
                onChange={(e) => setCInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    postComment();
                  }
                }}
              />
              <button
                className="btn-c"
                disabled={!cInput.trim()}
                onClick={postComment}
              >
                Comment
              </button>
            </div>
          ) : null}
        </div>

        <div className="tkd-sec">
          <div className="tkd-sec-h">Activity</div>
          <div className="tkd-activity">
            {activity.length ? (
              activity.map((a) => (
                <div className="tkd-act" key={a.id}>
                  <span className="tkd-act-who">
                    {a.actor ? a.actor.name : "System"}
                  </span>
                  <span className="tkd-act-what">{describe(a)}</span>
                  <span className="tkd-act-when">{fmtWhen(a.createdAt)}</span>
                </div>
              ))
            ) : (
              <div className="tkd-act-empty">No activity yet.</div>
            )}
          </div>
        </div>
      </div>
      <div className="tkd-foot">
        <button className="btn-c tkd-del" onClick={() => onDelete(task.id)}>
          Delete task
        </button>
      </div>
    </div>
  );
}
