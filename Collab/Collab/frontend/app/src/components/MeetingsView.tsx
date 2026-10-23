import React, { useState, useEffect } from "react";
import Avatar from "./Avatar";
import { IconX, IconCheck, IconCalendarDays } from "../lib/icons";
import Modal, { Btn, inp } from "./Modal";
import Select from "./ui/Select";
import { api } from "../lib/api";
import { copyText } from "../lib/clipboard";

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ts = (v: any) => {
  const t = v ? new Date(v).getTime() : 0;
  return isNaN(t) ? 0 : t;
};

export default function MeetingsView({
  meetings,
  people,
  meId,
  onCreate,
  onJoin,
  onUpdate,
  onDelete,
  onLeave,
  onCancel,
  onComplete,
  onRsvp,
  onToast,
  token,
}) {
  const [tab, setTab] = useState("upcoming");
  const [selId, setSelId] = useState<any>(null);
  const [sched, setSched] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [sel, setSel] = useState<any[]>([]);
  const [recurrence, setRecurrence] = useState("none");
  const [err, setErr] = useState("");

  const now = Date.now();
  const sorted = (meetings || [])
    .slice()
    .sort((a, b) => ts(a.startsAt) - ts(b.startsAt));
  // A meeting is "upcoming" until 30 min after its scheduled end so long-running
  // meetings don't vanish from the list while people are still in the room.
  const scheduledEnd = (m: any) =>
    ts(m.startsAt) + (m.durationMin || 60) * 60 * 1000 + 30 * 60 * 1000;
  // Explicitly ended (completed/cancelled) meetings belong in PAST even if their
  // scheduled window hasn't elapsed — otherwise a meeting you already ended keeps
  // sitting in "Upcoming" ABOVE the live one (the reported bug).
  // "completed" = the host ended the live SESSION. The meeting link stays
  // joinable until the scheduled time is exceeded, so inside the window a
  // completed meeting still reads as scheduled.
  const windowEnd = (m: any) => ts(m.startsAt) + (m.durationMin || 30) * 60000;
  const stState = (m: any) => {
    const st = m.state || m.status || "scheduled";
    return st === "completed" && now <= windowEnd(m) ? "scheduled" : st;
  };
  const isEnded = (m: any) => {
    const st = stState(m);
    return st === "completed" || st === "cancelled";
  };
  // Live/starting meetings float to the TOP of Upcoming so the joinable one is
  // never buried under earlier-but-not-yet-expired entries.
  const liveRank = (m: any) => {
    const st = stState(m);
    return st === "active" || st === "starting" ? 0 : 1;
  };
  const upcoming = sorted
    .filter((m) => !isEnded(m) && scheduledEnd(m) >= now)
    .sort((a, b) => liveRank(a) - liveRank(b) || ts(a.startsAt) - ts(b.startsAt));
  const past = sorted
    .filter((m) => isEnded(m) || scheduledEnd(m) < now)
    .reverse();
  const list =
    tab === "upcoming"
      ? upcoming
      : tab === "past"
        ? past
        : tab === "recordings"
          ? sorted
          : [];
  const selected =
    (meetings || []).find((m) => m.id === selId) || list[0] || null;

  const fmtDate = (v) =>
    new Date(ts(v)).toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  const fmtTime = (v) =>
    new Date(ts(v)).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  const isToday = (v) =>
    new Date(ts(v)).toDateString() === new Date().toDateString();
  const STATE_LABEL = {
    scheduled: "Scheduled",
    starting: "Starting soon",
    active: "Active",
    completed: "Completed",
    expired: "Ended",
    cancelled: "Cancelled",
  };
  const stateOf = stState;
  // "expired" = past scheduled end but NOT explicitly cancelled/completed.
  // The backend enterRoom still allows joining if the room has live participants,
  // or to start a late session. Frontend should not block what the backend permits.
  const canJoin = (st) =>
    st === "starting" || st === "active" || st === "scheduled" || st === "expired";
  const joinLabel = (st) => (st === "active" ? "Join now" : "Join");
  const RSVP_OPTS = [
    ["accepted", "Going"],
    ["tentative", "Maybe"],
    ["declined", "Decline"],
  ];

  const defaultTime = () => {
    // #2: default to current local time + 5 minutes (not rounded to :15).
    const d = new Date(Date.now() + 5 * 60000);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const openCreate = () => {
    setEditing(null);
    setTitle("");
    setDate(keyOf(new Date(Date.now() + 5 * 60000)));
    setTime(defaultTime());
    setSel([]);
    setRecurrence("none");
    setErr("");
    setSched(true);
  };
  const openEdit = (m) => {
    const d = new Date(ts(m.startsAt));
    setEditing(m);
    setTitle(m.title || "");
    setDate(keyOf(d));
    setTime(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
    setSel(
      (m.attendees || []).map((a) => a.id).filter((id) => id && id !== meId),
    );
    setRecurrence(m.recurrence || "none");
    setErr("");
    setSched(true);
  };
  const close = () => {
    setSched(false);
    setEditing(null);
  };
  const submit = () => {
    if (!title.trim() || !date || !time) return;
    if (!sel.length) {
      setErr("Add at least one person to the meeting.");
      return;
    }
    const startMs = new Date(`${date}T${time}`).getTime();
    if (!Number.isFinite(startMs) || startMs <= Date.now()) {
      setErr("Meeting start time must be in the future.");
      return;
    }
    setErr("");
    const payload = {
      title: title.trim(),
      startsAt: new Date(`${date}T${time}`).toISOString(),
      durationMin: editing ? editing.durationMin || 120 : 120,
      attendees: sel,
      recurrence,
    };
    if (editing) onUpdate(editing.id, payload);
    else onCreate(payload);
    close();
  };
  const copyLink = (m) => {
    const origin = (typeof window !== "undefined" && window.location && window.location.origin) || "";
    // The app handles /?meeting=<id> (CalendarView + MeetingStage use the same
    // shape); /meet/<id> has no route/rewrite and 404s, so never emit it.
    const url = `${origin}/?meeting=${m.id}`;
    try {
      copyText(url);
      onToast("Meeting link copied");
    } catch (_) {
      onToast(url);
    }
  };
  const toggleSel = (id) =>
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const calIcon = <IconCalendarDays size={17} />;

  const GROUPS = ["Today", "Tomorrow", "This week", "Later"];
  const sod = (ms) => {
    const x = new Date(ms);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const bucketOf = (ms) => {
    const t0 = sod(Date.now());
    if (ms < t0 + 864e5) return "Today";
    if (ms < t0 + 2 * 864e5) return "Tomorrow";
    if (ms < t0 + 7 * 864e5) return "This week";
    return "Later";
  };
  const [visibleCount, setVisibleCount] = useState(50);
  const [joinId, setJoinId] = useState("");
  const [recordings, setRecordings] = useState<any[]>([]);
  useEffect(() => setVisibleCount(50), [tab]);
  const selId2 = selected && selected.id;
  useEffect(() => {
    if (!token || !selId2) {
      setRecordings([]);
      return;
    }
    let live = true;
    api
      .getRecordings(token, selId2)
      .then((r) => live && setRecordings(r || []))
      .catch(() => live && setRecordings([]));
    return () => {
      live = false;
    };
  }, [token, selId2]);
  const refreshRecordings = async () => {
    if (!token || !selId2) return;
    const r = await api.getRecordings(token, selId2).catch(() => []);
    setRecordings(r || []);
  };
  const renderRow = (m) => (
    <button
      key={m.id}
      className={
        "meet-row" + (selected && selected.id === m.id ? " active" : "")
      }
      onClick={() => setSelId(m.id)}
    >
      <span className="meet-row-ic">{calIcon}</span>
      <span className="meet-row-body">
        <span className="meet-row-title">{m.title || "Meeting"}</span>
        <span className="meet-row-time">
          {isToday(m.startsAt) ? "Today" : fmtDate(m.startsAt)} ·{" "}
          {fmtTime(m.startsAt)}
        </span>
      </span>
      {(() => {
        const st = stateOf(m);
        if (canJoin(st))
          return (
            <span
              className="meet-row-join"
              onClick={(e) => {
                e.stopPropagation();
                onJoin(m.id);
                onToast(`Joining ${m.title || "meeting"}…`);
              }}
            >
              {joinLabel(st)}
            </span>
          );
        return (
          <span className={"meet-row-state st-" + st}>
            {STATE_LABEL[st] || st}
          </span>
        );
      })()}
    </button>
  );

  return (
    <div className="view active" id="vmeet">
      <div className="meet-layout">
        <div className="meet-list-pane">
          <div className="meet-tabs">
            {[
              ["upcoming", "Upcoming"],
              ["past", "Past"],
              ["recordings", "Recordings"],
            ].map(([id, l]) => (
              <button
                key={id}
                className={"meet-tab" + (tab === id ? " active" : "")}
                onClick={() => setTab(id)}
              >
                {l}
              </button>
            ))}
            <button className="btn-p meet-new" onClick={openCreate}>
              + New meeting
            </button>
          </div>
          <div className="meet-joinby">
            <input
              value={joinId}
              placeholder="Join by meeting ID or link…"
              onChange={(e) => setJoinId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && joinId.trim()) {
                  const id = joinId.trim().split("/").pop() || joinId.trim();
                  onJoin(id);
                  onToast("Joining meeting…");
                  setJoinId("");
                }
              }}
            />
          </div>
          <div className="meet-list">
            {list.length === 0 ? (
              <div className="meet-empty">
                {tab === "upcoming"
                  ? "No upcoming meetings"
                  : tab === "recordings"
                    ? "No meetings yet"
                    : "No past meetings"}
              </div>
            ) : (
              (() => {
                const shown = list.slice(0, visibleCount);
                const rows =
                  tab === "upcoming"
                    ? GROUPS.flatMap((g) => {
                        const items = shown.filter(
                          (m) => bucketOf(ts(m.startsAt)) === g,
                        );
                        return items.length
                          ? [
                              <div className="meet-group-h" key={"h-" + g}>
                                {g}
                                <span className="meet-group-n">
                                  {items.length}
                                </span>
                              </div>,
                              ...items.map((m) => renderRow(m)),
                            ]
                          : [];
                      })
                    : shown.map((m) => renderRow(m));
                return (
                  <>
                    {rows}
                    {list.length > visibleCount ? (
                      <button
                        className="meet-more"
                        onClick={() => setVisibleCount((n) => n + 50)}
                      >
                        Show {Math.min(50, list.length - visibleCount)} more ·{" "}
                        {list.length - visibleCount} remaining
                      </button>
                    ) : null}
                  </>
                );
              })()
            )}
          </div>
        </div>
        <div className="meet-detail">
          {selected ? (
            <>
              <div className="meet-d-title">
                {selected.title || "Meeting"}
                <span className={"meet-badge st-" + stateOf(selected)}>
                  {STATE_LABEL[stateOf(selected)] || stateOf(selected)}
                </span>
              </div>
              <div className="meet-d-time">
                {isToday(selected.startsAt)
                  ? "Today"
                  : fmtDate(selected.startsAt)}{" "}
                · {fmtTime(selected.startsAt)}
                {selected.recurrence && selected.recurrence !== "none" ? (
                  <span style={{ marginLeft: 8, opacity: 0.8 }}>
                    · {{ daily: "Repeats daily", weekly: "Repeats weekly", biweekly: "Repeats every 2 weeks", monthly: "Repeats monthly" }[selected.recurrence] || "Recurring"}
                  </span>
                ) : null}
              </div>
              <div className="meet-d-actions">
                {canJoin(stateOf(selected)) ? (
                  <button
                    className="btn-p"
                    onClick={() => {
                      onJoin(selected.id);
                      onToast(`Joining ${selected.title || "meeting"}…`);
                    }}
                  >
                    {joinLabel(stateOf(selected))}
                  </button>
                ) : (
                  <span className="meet-ended-note">
                    {stateOf(selected) === "cancelled"
                      ? "This meeting was cancelled."
                      : "This meeting has ended."}
                  </span>
                )}
                <button className="btn-c" onClick={() => copyLink(selected)}>
                  Copy link
                </button>
              </div>
              {selected.myStatus &&
              selected.myStatus !== "host" &&
              canJoin(stateOf(selected)) ? (
                <div className="meet-d-field">
                  <div className="meet-d-lbl">Your response</div>
                  <div className="meet-rsvp">
                    {RSVP_OPTS.map(([val, lbl]) => (
                      <button
                        key={val}
                        className={
                          "meet-rsvp-b" +
                          (selected.myStatus === val ? " on " + val : "")
                        }
                        onClick={() => onRsvp(selected.id, val)}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="meet-d-field">
                <div className="meet-d-lbl">Meeting ID</div>
                <div className="meet-d-id">{selected.id}</div>
              </div>
              <div className="meet-d-field">
                <div className="meet-d-lbl">Meeting Link</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, color: "var(--g500)", wordBreak: "break-all" }}>
                    {(typeof window !== "undefined" && window.location && window.location.host) || ""}/?meeting={selected.id}
                  </span>
                  <button className="btn-c" style={{ fontSize: 11, padding: "3px 10px", height: 24, flexShrink: 0 }} onClick={() => copyLink(selected)}>Copy</button>
                </div>
              </div>
              <div className="meet-d-field">
                <div className="meet-d-lbl">
                  Participants
                  {(() => {
                    const c = selected.statusCounts || {};
                    const parts = [];
                    if (c.accepted) parts.push(c.accepted + " going");
                    if (c.tentative) parts.push(c.tentative + " maybe");
                    if (c.declined) parts.push(c.declined + " declined");
                    if (c.invited) parts.push(c.invited + " invited");
                    return parts.length ? (
                      <span className="meet-d-counts">
                        {" · " + parts.join(" · ")}
                      </span>
                    ) : null;
                  })()}
                </div>
                <div className="meet-d-avs">
                  {(selected.attendees || []).length === 0 ? (
                    <span className="meet-d-none">No participants yet</span>
                  ) : (
                    (selected.attendees || []).map((p, i) => (
                      <span
                        key={p.id || i}
                        className={"meet-av rsvp-" + (p.status || "invited")}
                        title={(p.name || "") + " · " + (p.status || "invited")}
                      >
                        <Avatar
                          avatar={{
                            kind: "user",
                            initials: p.initials,
                            color: p.color,
                            avatarUrl: p.avatarUrl,
                          }}
                          size={28}
                        />
                      </span>
                    ))
                  )}
                </div>
              </div>
              {token ? (
                <div className="meet-d-field">
                  <div className="meet-d-lbl">Recordings</div>
                  {recordings.length === 0 ? (
                    <div className="meet-d-none">No recordings.</div>
                  ) : (
                    <div className="meet-recs">
                      {recordings.map((rec) => (
                        <div key={rec.id} className="meet-rec">
                          <span className={"meet-rec-st st-" + rec.status}>
                            {rec.status}
                          </span>
                          {rec.status === "ready" && rec.playbackUrl ? (
                            <a
                              className="meet-rec-play"
                              href={rec.playbackUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Play / Download
                            </a>
                          ) : (
                            <span className="meet-rec-meta">
                              {rec.status === "recording"
                                ? "Recording…"
                                : rec.status === "processing"
                                  ? "Processing…"
                                  : "Unavailable"}
                            </span>
                          )}
                          <span className="meet-rec-when">
                            {fmtDate(rec.createdAt)}
                          </span>
                          {selected.mine ? (
                            <button
                              className="meet-rec-del"
                              title="Delete recording"
                              onClick={async () => {
                                await api
                                  .deleteRecording(token, selected.id, rec.id)
                                  .catch(() => {});
                                await refreshRecordings();
                                onToast("Recording deleted");
                              }}
                            >
                              <IconX size={14} />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
              <div className="meet-d-foot">
                {stateOf(selected) !== "completed" &&
                selected.status !== "cancelled" ? (
                  <button className="btn-c" onClick={() => openEdit(selected)}>
                    Edit
                  </button>
                ) : null}
                {(selected.attendees || []).some((a) => a.id === meId) &&
                stateOf(selected) !== "completed" &&
                selected.status !== "cancelled" ? (
                  <button
                    className="btn-c"
                    onClick={() => {
                      onLeave(selected.id);
                      onToast(`Left ${selected.title || "meeting"}`);
                    }}
                  >
                    Leave
                  </button>
                ) : null}
                {selected.mine &&
                stateOf(selected) !== "completed" &&
                selected.status !== "cancelled" ? (
                  <>
                    <button
                      className="btn-c"
                      onClick={() => {
                        onComplete(selected.id);
                        onToast(`Ended ${selected.title || "meeting"}`);
                      }}
                    >
                      End meeting
                    </button>
                    <button
                      className="btn-c"
                      onClick={() => {
                        onCancel(selected.id);
                        onToast(`Cancelled ${selected.title || "meeting"}`);
                      }}
                    >
                      Cancel meeting
                    </button>
                  </>
                ) : null}
                {stateOf(selected) === "completed" ||
                selected.status === "cancelled" ? (
                  <button
                    className="btn-c meet-del"
                    onClick={() => {
                      onDelete(selected.id);
                      setSelId(null);
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <div className="meet-empty">Select a meeting to see details</div>
          )}
        </div>
      </div>
      {sched ? (
        <Modal
          title={editing ? "Edit meeting" : "New meeting"}
          onClose={close}
          footer={
            <>
              <Btn onClick={close}>Cancel</Btn>
              <Btn
                primary
                disabled={!title.trim() || !date || !time || !sel.length}
                onClick={submit}
              >
                {editing ? "Save" : "Create"}
              </Btn>
            </>
          }
        >
          <input
            name="meet-title"
            autoComplete="off"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Meeting title"
            maxLength={80}
            style={inp}
            autoFocus
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ ...inp, flex: 1 }}
            />
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              style={{ ...inp, flex: 1 }}
            />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--g500)", minWidth: 64 }}>Repeats</span>
            <Select
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value)}
              style={{ ...inp, flex: 1 }}
              aria-label="Recurrence"
            >
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every 2 weeks</option>
              <option value="monthly">Monthly</option>
            </Select>
          </div>
          {err ? <div className="meet-err">{err}</div> : null}
          <div className="meet-pick">
            <div className="meet-pick-lbl">Participants</div>
            <div className="meet-pick-list">
              {(people || [])
                .filter((u) => u.id !== meId)
                .map((u) => (
                  <button
                    key={u.id}
                    className={
                      "meet-pick-row" + (sel.includes(u.id) ? " on" : "")
                    }
                    onClick={() => toggleSel(u.id)}
                  >
                    <Avatar
                      avatar={{
                        kind: "user",
                        initials: u.initials,
                        color: u.color,
                        avatarUrl: u.avatarUrl,
                      }}
                      size={24}
                    />
                    <span>{u.name}</span>
                    {sel.includes(u.id) ? (
                      <span className="meet-pick-ck"><IconCheck size={13} /></span>
                    ) : null}
                  </button>
                ))}
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
