"use client";

import React, { useEffect, useRef, useState } from "react";
import Avatar from "../Avatar";
import { api } from "../../lib/api";
import { sidebarTime } from "../../lib/time";
import { isMyTask } from "./helpers";
import { captureSearchBarFlip } from "../../lib/searchFlip";
import {
  IconSearch,
  IconArrowRight,
  IconCalendarDays,
  IconVideo,
  IconClock,
  IconPhone,
  IconBell,
  IconMessageCircle,
  IconFile,
  IconPlus,
  IconX,
} from "../../lib/icons";

// Dashboard — "Collab Dashboard" design: status bar → greeting → next-meeting
// card → search → (unread + today's schedule | quick actions + team pulse).
// Everything is driven by the same session state the previous dashboard used.

export interface DashboardViewProps {
  conversations: any[];
  meetings: any[];
  calls: any[];
  users: any[];
  frequentUsers?: any[];
  pendingRequests?: number;
  callsSeenAt?: number;
  /** Unread notification count shown on the bell. */
  notifCount?: number;
  tasks?: any[];
  onMode: (mode: string) => void;
  onNewCall: (type: string) => void;
  onNewMessage: () => void;
  onScheduleMeeting?: () => void;
  onOpenSearch: (query: string) => void;
  onOpenConversation?: (convId: string) => void;
  onOpenUnread?: () => void;
  onOpenMissedCalls?: () => void;
  onSelectPerson?: (userId: string) => void;
  /** Opens the pre-join screen for a meeting (same handler the calendar uses). */
  onJoinMeeting?: (meetingId: string) => void;
  /** Seeds a conversation's composer with `text` and opens it. */
  onQuickReply?: (convId: string, text: string) => void;
  /** Quick action "Share file": hands the picked file to the shell, which asks
   *  which conversation(s) to send it to. */
  onShareFile?: (file: File) => void;
  meId?: string | null;
  token?: string;
}

const DAY = 86400000;

const ts = (v: any) => {
  const t = v ? new Date(v).getTime() : 0;
  return isNaN(t) ? 0 : t;
};

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const fmt24 = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const durLabel = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return (h ? h + "h" : "") + (h && m ? " " : "") + (m || !h ? m + "m" : "");
};

const userAvatar = (u: any, fallback: any = {}) => ({
  kind: "user",
  initials: (u && u.initials) || fallback.initials,
  color: (u && u.color) || fallback.color,
  avatarUrl: (u && u.avatarUrl) || fallback.avatarUrl,
});

function DashboardView({
  conversations,
  meetings,
  users,
  calls,
  callsSeenAt = 0,
  notifCount = 0,
  tasks,
  onMode,
  onNewCall,
  onNewMessage,
  onScheduleMeeting,
  onOpenSearch,
  onJoinMeeting,
  onOpenConversation,
  onOpenUnread,
  onShareFile,
  meId,
  token,
}: DashboardViewProps) {
  const [q, setQ] = useState("");
  const shareInputRef = useRef<HTMLInputElement | null>(null);
  const [searchFocus, setSearchFocus] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  const [online, setOnline] = useState(true);
  const [readIds, setReadIds] = useState<Record<string, boolean>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiOut, setAiOut] = useState<{ ok: boolean; items: { name: string; text: string }[] } | null>(null);

  // Live clock (status bar + "In 32m" tags) — refresh every 30s.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const submitSearch = () => {
    // Navigate to the Search page (SearchView); snapshot this bar first so the
    // Search page can morph its own bar out of it (GSAP Flip).
    captureSearchBarFlip(searchBoxRef.current);
    const v = q.trim();
    onOpenSearch(v);
    setQ("");
  };

  const meUser = (users || []).find((u) => u.id === meId);
  const firstName =
    meUser && meUser.name ? String(meUser.name).split(/\s+/)[0] : "";
  const hr = new Date().getHours();
  const greetingLead =
    "Good " + (hr < 5 ? "evening" : hr < 12 ? "morning" : hr < 16 ? "afternoon" : "evening");

  const now = Date.now();
  void tick;
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const active = (conversations || []).filter((c) => !c.hidden);
  const unreadConvs = active
    .filter((c) => (c.unread || 0) > 0 && !readIds[c.id])
    .sort((a, b) => ts(b.lastMessageAt) - ts(a.lastMessageAt));
  const unread = unreadConvs.reduce((n, c) => n + (c.unread || 0), 0);
  const missedCalls = (calls || []).filter(
    (c) =>
      (c.status === "missed" || c.direction === "missed") &&
      ts(c.startedAt || c.at || c.createdAt) > callsSeenAt,
  ).length;
  const tasksDueToday = (tasks || []).filter((t) => {
    if (!isMyTask(t, meId) || t.status === "done") return false;
    const due = ts(t.dueAt || t.due || t.dueDate);
    return due && due <= endOfDay.getTime();
  }).length;

  // ── Meetings ──
  const endMs = (m: any) => ts(m.startsAt) + (m.durationMin || 30) * 60000;
  const liveMeetings = (meetings || []).filter(
    (m) => m && ts(m.startsAt) > 0 && m.status !== "cancelled" && m.status !== "completed",
  );
  const upcoming = liveMeetings
    .filter((m) => endMs(m) > now)
    .sort((a, b) => ts(a.startsAt) - ts(b.startsAt));
  const nextUp = upcoming[0];
  const nextStart = nextUp ? ts(nextUp.startsAt) : 0;
  const nextIsLive = !!nextUp && nextStart <= now;
  const minsToNext = nextUp ? Math.max(0, Math.round((nextStart - now) / 60000)) : 0;

  const whenLabel = (() => {
    if (!nextUp) return "";
    if (nextIsLive) return "Happening now";
    if (minsToNext <= 60)
      return "Call in " + minsToNext + " minute" + (minsToNext === 1 ? "" : "s");
    const d = new Date(nextStart);
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    if (sameDay(d, today)) return "Today at " + fmtTime(nextStart);
    if (sameDay(d, tomorrow)) return "Tomorrow at " + fmtTime(nextStart);
    return (
      d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) +
      " at " +
      fmtTime(nextStart)
    );
  })();

  const attendees: any[] = nextUp
    ? (nextUp.attendees || []).filter((a: any) => a && a.id && a.id !== meId)
    : [];
  const attendeeAvatars = attendees.slice(0, 3).map((a: any) => {
    const u = (users || []).find((x) => x.id === a.id) || a;
    return { id: a.id, name: u.name || a.name || "", avatar: userAvatar(u, a) };
  });
  const attendeeMore = Math.max(0, attendees.length - attendeeAvatars.length);
  const hostedByMe = !!nextUp && (nextUp.hostId === meId || nextUp.createdBy === meId);

  const joinNext = () => {
    if (!nextUp) return;
    if (onJoinMeeting) onJoinMeeting(nextUp.id);
    else onMode("calendar");
  };

  // Jump-to-meeting shortcut (⌘J / Ctrl+J), only while this screen is mounted.
  const joinRef = useRef(joinNext);
  joinRef.current = joinNext;
  const hasNextRef = useRef(false);
  hasNextRef.current = !!nextUp;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        if (!hasNextRef.current) return;
        e.preventDefault();
        joinRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Today's schedule ──
  const today = new Date();
  const todays = liveMeetings
    .filter((m) => sameDay(new Date(ts(m.startsAt)), today))
    .sort((a, b) => ts(a.startsAt) - ts(b.startsAt));
  const todayMins = todays.reduce((n, m) => n + (m.durationMin || 30), 0);
  const nextTodayId = todays.find((m) => endMs(m) > now)?.id;
  const tagFor = (m: any) => {
    const s = ts(m.startsAt);
    const e = endMs(m);
    if (s <= now && e > now) return { text: "Now", state: "live" };
    if (e <= now) return { text: "Done", state: "done" };
    const mins = Math.max(1, Math.round((s - now) / 60000));
    if (mins < 60) return { text: "In " + mins + "m", state: "next" };
    const h = Math.floor(mins / 60);
    return { text: "In " + h + "h" + (mins % 60 ? " " + (mins % 60) + "m" : ""), state: "later" };
  };

  // ── Team pulse: activity over the last 7 days vs the 7 before ──
  const startToday = new Date();
  startToday.setHours(0, 0, 0, 0);
  const buckets: number[] = Array(14).fill(0);
  const bump = (t: number) => {
    if (!t) return;
    const idx = Math.floor((startToday.getTime() + DAY - t) / DAY);
    if (idx >= 0 && idx < 14) buckets[idx]++;
  };
  (conversations || []).forEach((c) => bump(ts(c.lastMessageAt)));
  (calls || []).forEach((c) => bump(ts(c.startedAt || c.at || c.createdAt)));
  (meetings || []).forEach((m) => bump(ts(m.startsAt)));
  const thisWeek = buckets.slice(0, 7).reverse();
  const weekTotal = thisWeek.reduce((a, b) => a + b, 0);
  const prevTotal = buckets.slice(7).reduce((a, b) => a + b, 0);
  const maxBar = Math.max(1, ...thisWeek);
  const pulseDelta = prevTotal > 0 ? Math.round(((weekTotal - prevTotal) / prevTotal) * 100) : null;

  // ── Headline pill ──
  const insight = (() => {
    if (nextUp && nextIsLive)
      return (nextUp.title || "A meeting") + " is happening now.";
    if (nextUp && minsToNext <= 60)
      return (nextUp.title || "A meeting") + " begins in " + minsToNext + " minute" + (minsToNext === 1 ? "" : "s") + ".";
    if (unread > 0)
      return unread + " unread message" + (unread === 1 ? "" : "s") + " across active conversations";
    if (tasksDueToday > 0)
      return tasksDueToday + " task" + (tasksDueToday === 1 ? "" : "s") + " require attention before end of day.";
    if (missedCalls > 0)
      return missedCalls + " missed call" + (missedCalls === 1 ? "" : "s") + " await follow-up.";
    if (upcoming.length > 0)
      return upcoming.length + " upcoming meeting" + (upcoming.length === 1 ? "" : "s") + " scheduled.";
    return "No outstanding actions right now.";
  })();
  const pillCount = unread > 0 ? unread : null;

  const markAllRead = () => {
    const ids = unreadConvs.map((c) => c.id);
    if (!ids.length) return;
    setReadIds((m) => {
      const n = { ...m };
      ids.forEach((id) => (n[id] = true));
      return n;
    });
    if (token) ids.forEach((id) => api.setRead(token, id, true).catch(() => {}));
  };

  const runSummary = async () => {
    if (aiBusy || !token) return;
    const targets = unreadConvs.slice(0, 3);
    if (!targets.length) return;
    setAiBusy(true);
    setAiOut(null);
    try {
      const items: { name: string; text: string }[] = [];
      for (const c of targets) {
        const r: any = await api.summarizeConversation(token, c.id);
        items.push({ name: c.name || "Conversation", text: (r && r.summary) || "No summary available." });
      }
      setAiOut({ ok: true, items });
    } catch (_) {
      setAiOut({
        ok: false,
        items: [{ name: "", text: "Couldn't generate a summary — Collab AI may be unavailable." }],
      });
    } finally {
      setAiBusy(false);
    }
  };

  const meAvatar = userAvatar(meUser);
  const dateLabel =
    new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) +
    " • " +
    new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" });

  return (
    <div className="view active" id="vdash">
      <div className="dash-dragbar" aria-hidden />
      <div className="dx">
        {/* ── Status bar ── */}
        <div className="dx-status">
          <div className="dx-status-l">
            <span className={"dx-dot" + (online ? "" : " off")} aria-hidden />
            <span>{online ? "All systems operational" : "You're offline"}</span>
            <span className="dx-sep">•</span>
            <span>{dateLabel}</span>
          </div>
          <div className="dx-status-r">
            <button
              className="dx-round"
              onClick={() => onMode("activity")}
              aria-label="Notifications"
              data-tip={notifCount > 0 ? notifCount + " unread notification" + (notifCount === 1 ? "" : "s") : "Notifications"}
            >
              <IconBell size={18} />
              {notifCount > 0 ? (
                <span className="dx-bell-badge" aria-label={notifCount + " unread"}>
                  {notifCount > 99 ? "99+" : notifCount}
                </span>
              ) : null}
            </button>
            {/* <span className="dx-me" aria-hidden>
              <Avatar avatar={meAvatar} size={36} />
            </span> */}
          </div>
        </div>

        <div className="dx-col">
          {/* ── Greeting ── */}
          <div className="dx-head">
            <h1 className="dx-greet">
              {greetingLead}
              {firstName ? (
                <>
                  {", "}
                  <span className="dx-name">{firstName}</span>
                </>
              ) : null}
            </h1>
            <div className="dx-pills">
              <button
                className="dx-pill"
                onClick={unread > 0 ? onOpenUnread || (() => onMode("chats")) : undefined}
                disabled={unread === 0}
              >
                {pillCount ? <span className="dx-pill-n">{pillCount}</span> : null}
                <span className="dx-pill-t">{insight}</span>
              </button>
            </div>
          </div>

          {/* ── Next meeting ── */}
          {nextUp ? (
            <section className="dx-card dx-next" aria-label="Next call">
              <span className="dx-card-edge" aria-hidden />
              <div className="dx-next-top">
                <div className="dx-next-when">
                  <span className="dx-chip-ic">
                    <IconCalendarDays size={16} />
                  </span>
                  <span className="dx-next-when-t">{whenLabel}</span>
                  {hostedByMe ? (
                    <>
                      <span className="dx-sep">•</span>
                      <span className="dx-muted">Scheduled by you</span>
                    </>
                  ) : null}
                </div>
                <button
                  className="dx-round dx-round-sm"
                  onClick={joinNext}
                  aria-label="Join with video"
                  data-tip="Join with video"
                >
                  <IconVideo size={16} />
                </button>
              </div>
              <div className="dx-next-mid">
                <span className="dx-next-bar" aria-hidden />
                <div className="dx-next-info">
                  <h2 className="dx-next-title" title={nextUp.title || "Meeting"}>
                    {nextUp.title || "Meeting"}
                  </h2>
                  <p className="dx-next-loc">
                    <IconVideo size={14} />
                    {nextUp.location || "Video meeting"}
                  </p>
                  {attendeeAvatars.length ? (
                    <div className="dx-avs">
                      <span className="dx-avstack">
                        {attendeeAvatars.map((a) => (
                          <span key={a.id} title={a.name} className="dx-av">
                            <Avatar avatar={a.avatar} size={28} />
                          </span>
                        ))}
                      </span>
                      {attendeeMore > 0 ? <span className="dx-more">+{attendeeMore}</span> : null}
                      <span className="dx-muted">attending</span>
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="dx-next-foot">
                <span className="dx-timepill">
                  <IconClock size={15} />
                  {fmtTime(nextStart)} – {fmtTime(endMs(nextUp))}
                  <span className="dx-muted dx-dur">• {nextUp.durationMin || 30} min</span>
                </span>
                <button className="dx-join" onClick={joinNext}>
                  <span>{nextIsLive ? "Join now" : "Join Meeting"}</span>
                  <IconArrowRight size={18} />
                </button>
              </div>
            </section>
          ) : (
            <section className="dx-card dx-next dx-next--empty" aria-label="No upcoming calls">
              <span className="dx-card-edge" aria-hidden />
              <div className="dx-next-top">
                <div className="dx-next-when">
                  <span className="dx-chip-ic">
                    <IconCalendarDays size={16} />
                  </span>
                  <span className="dx-next-when-t">No upcoming calls</span>
                </div>
              </div>
              <div className="dx-next-mid">
                <span className="dx-next-bar" aria-hidden />
                <div className="dx-next-info">
                  <h2 className="dx-next-title">Your calendar is clear</h2>
                  <p className="dx-next-loc">Start a call or schedule a meeting when you&apos;re ready.</p>
                </div>
              </div>
              <div className="dx-next-foot">
                <button className="dx-timepill dx-timepill--btn" onClick={() => onNewCall("both")}>
                  <IconPhone size={15} />
                  Start a call
                </button>
                <button className="dx-join" onClick={onScheduleMeeting || (() => onMode("calendar"))}>
                  <span>Schedule meeting</span>
                  <IconArrowRight size={18} />
                </button>
              </div>
            </section>
          )}

          {/* ── Search ── */}
          <div className={"dx-search" + (searchFocus ? " focus" : "")} ref={searchBoxRef}>
            <span className="dx-search-ic">
              <IconSearch size={18} />
            </span>
            <input
              name="dash-search"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              // Focusing the bar jumps straight to the full Search page (this is
              // an entry point into Search, not an inline mini-search).
              onFocus={() => {
                setSearchFocus(true);
                submitSearch();
              }}
              onBlur={() => setSearchFocus(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitSearch();
                }
              }}
              placeholder="Search messages, people, files and meetings..."
            />
            <button className="dx-search-go" onClick={submitSearch} aria-label="Search">
              <IconArrowRight size={18} />
            </button>
          </div>

          {/* ── Two columns ── */}
          <div className="dx-grid">
            <div className="dx-stack">
              {/* Unread */}
              <section className="dx-card dx-unread" aria-label="Unread">
                <div className="dx-sec-head">
                  <h3 className="dx-eyebrow">Unread{unread > 0 ? " • " + unread : ""}</h3>
                  {unreadConvs.length ? (
                    <button className="dx-link" onClick={markAllRead}>
                      Mark all read
                    </button>
                  ) : null}
                </div>
                {unreadConvs.length ? (
                  <div className="dx-unread-list">
                    {unreadConvs.slice(0, 3).map((c) => {
                      const prev = String(c.preview || "").replace(/\s+/g, " ").trim();
                      return (
                        <div
                          key={c.id}
                          className="dx-urow"
                          role="button"
                          tabIndex={0}
                          onClick={() => (onOpenConversation ? onOpenConversation(c.id) : onMode("chats"))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onOpenConversation ? onOpenConversation(c.id) : onMode("chats");
                            }
                          }}
                        >
                          <span className="dx-urow-av">
                            <Avatar avatar={c.avatar} size={44} />
                          </span>
                          <div className="dx-urow-body">
                            <div className="dx-urow-top">
                              <span className="dx-urow-name">{c.name}</span>
                              <span className="dx-urow-dot" aria-hidden />
                              {c.lastMessageAt ? (
                                <span className="dx-muted dx-urow-time">{sidebarTime(c.lastMessageAt)}</span>
                              ) : null}
                              {(c.unread || 0) > 1 ? <span className="dx-urow-n">{c.unread}</span> : null}
                            </div>
                            <p className="dx-urow-prev">{prev || "New messages"}</p>
                          </div>
                          <span className="dx-urow-go" aria-hidden>
                            <IconArrowRight size={16} />
                          </span>
                        </div>
                      );
                    })}
                    {unreadConvs.length > 3 ? (
                      <button className="dx-more-link" onClick={onOpenUnread || (() => onMode("chats"))}>
                        View {unreadConvs.length - 3} more unread conversation{unreadConvs.length - 3 === 1 ? "" : "s"}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p className="dx-empty">You&apos;re all caught up — no unread messages.</p>
                )}
              </section>

              {/* Today's schedule */}
              <section className="dx-card dx-sched" aria-label="Today's schedule">
                <div className="dx-sec-head">
                  <h3 className="dx-h3">Today&apos;s schedule</h3>
                  <span className="dx-badge">
                    {todays.length} event{todays.length === 1 ? "" : "s"}
                    {todays.length ? " • " + durLabel(todayMins) : ""}
                  </span>
                </div>
                {todays.length ? (
                  <div className="dx-tl">
                    <span className="dx-tl-line" aria-hidden />
                    {todays.slice(0, 5).map((m) => {
                      const tag = tagFor(m);
                      const isNext = m.id === nextTodayId;
                      return (
                        <div key={m.id} className={"dx-tl-row " + tag.state + (isNext ? " is-next" : "")}>
                          <span className="dx-tl-dot" aria-hidden />
                          <div className="dx-tl-time">
                            <span className="dx-tl-t">{fmt24(ts(m.startsAt))}</span>
                            <span className={"dx-tl-tag " + tag.state}>{tag.text}</span>
                          </div>
                          <button
                            className={"dx-tl-card" + (isNext ? " active" : "")}
                            onClick={() => (onJoinMeeting && tag.state !== "done" ? onJoinMeeting(m.id) : onMode("calendar"))}
                          >
                            <span className="dx-tl-title">{m.title || "Meeting"}</span>
                            <span className="dx-tl-desc">
                              {(m.location || "Video meeting") +
                                " • " +
                                (m.attendees && m.attendees.length ? m.attendees.length + " attending" : (m.durationMin || 30) + " min")}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="dx-empty">
                    Nothing scheduled today.{" "}
                    <button className="dx-link" onClick={onScheduleMeeting || (() => onMode("calendar"))}>
                      Schedule a meeting
                    </button>
                  </p>
                )}
              </section>
            </div>

            <div className="dx-stack">
              {/* Quick actions */}
              <section className="dx-dark" aria-label="Quick actions">
                <span className="dx-dark-glow" aria-hidden />
                <div className="dx-dark-in">
                  <h3 className="dx-dark-h">Quick actions</h3>
                  <p className="dx-dark-sub">Start something new in one click</p>
                  <div className="dx-qa">
                    <button className="dx-qa-btn" onClick={onNewMessage}>
                      <span className="dx-qa-ic brand">
                        <IconMessageCircle size={17} />
                      </span>
                      <span className="dx-qa-t">
                        <b>New message</b>
                        <i>DM or channel</i>
                      </span>
                      <IconPlus size={16} />
                    </button>
                    <button className="dx-qa-btn" onClick={onScheduleMeeting || (() => onMode("calendar"))}>
                      <span className="dx-qa-ic">
                        <IconVideo size={17} />
                      </span>
                      <span className="dx-qa-t">
                        <b>New meeting</b>
                        <i>Instant or schedule</i>
                      </span>
                      <IconPlus size={16} />
                    </button>
                    <input
                      ref={shareInputRef}
                      type="file"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files && e.target.files[0];
                        e.target.value = "";
                        if (f && onShareFile) onShareFile(f);
                      }}
                    />
                    <button className="dx-qa-btn" onClick={() => shareInputRef.current?.click()}>
                      <span className="dx-qa-ic">
                        <IconFile size={17} />
                      </span>
                      <span className="dx-qa-t">
                        <b>Share file</b>
                        <i>Docs, images, links</i>
                      </span>
                      <IconPlus size={16} />
                    </button>
                  </div>
                </div>
              </section>

              {/* Team pulse */}
              <section className="dx-card dx-pulse" aria-label="Team pulse">
                <div className="dx-sec-head">
                  <h3 className="dx-h3 sm">Team pulse</h3>
                  <span className="dx-live" aria-hidden />
                </div>
                <div className="dx-bars" role="img" aria-label="Activity over the last 7 days">
                  {thisWeek.map((v, i) => (
                    <span
                      key={i}
                      className="dx-bar"
                      title={v + " event" + (v === 1 ? "" : "s")}
                      style={{
                        height: Math.max(14, Math.round((v / maxBar) * 100)) + "%",
                        opacity: 0.35 + i * 0.09,
                      }}
                    />
                  ))}
                </div>
                <div className="dx-pulse-foot">
                  <span className="dx-muted">Last 7 days</span>
                  <b>
                    {pulseDelta === null
                      ? weekTotal + " event" + (weekTotal === 1 ? "" : "s")
                      : (pulseDelta > 0 ? "+" : "") + pulseDelta + "% vs last week"}
                  </b>
                </div>
              </section>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

export default React.memo(DashboardView);
