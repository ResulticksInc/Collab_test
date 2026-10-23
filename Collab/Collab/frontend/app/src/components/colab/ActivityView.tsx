"use client";

import React, { useState, useEffect, useMemo } from "react";
import Avatar from "../Avatar";
import { sidebarTime } from "../../lib/time";
import { isHiddenModule } from "../../lib/hiddenModules";
import { notifTargetModule } from "./helpers";
import {
  IconCheck,
  IconCalendarDays,
  IconAtSign,
  IconReply,
  IconHeart,
  IconPhoneMissed,
  IconVideo,
  IconFileText,
  IconSquareCheck,
  IconBell,
  IconX,
} from "../../lib/icons";

function notifIcon(type?: string) {
  switch (type) {
    case "mention":
      return <IconAtSign size={16} />;
    case "reply":
      return <IconReply size={16} />;
    case "reaction":
      return <IconHeart size={16} />;
    case "call_missed":
      return <IconPhoneMissed size={16} />;
    case "meeting_invite":
      return <IconVideo size={16} />;
    case "file_shared":
      return <IconFileText size={16} />;
    case "task_assigned":
    case "task_due":
      return <IconSquareCheck size={16} />;
    default:
      return <IconBell size={16} />;
  }
}

function messagePreview(str?: string): string {
  if (!str) return "";
  const cleaned = String(str)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 80 ? cleaned.slice(0, 80) + "…" : cleaned;
}

export interface ActivityViewProps {
  conversations: any[];
  calls: any[];
  voicemails: any[];
  onOpenCalls?: () => void;
  meetings: any[];
  meId?: string | null;
  onMarkRead: () => void;
  onSetRead: (convId: string) => void;
  onOpenConversation: (convId: string, msgId?: string) => void;
  onOpenPerson: (userId: string) => void;
  onOpenTask?: (taskId: string) => void;
  onOpenReminder?: (reminderId: string) => void;
  onOpenFile?: (fileId: string) => void;
  onJoin: (meetingId: string) => void;
  onToast: (msg: string) => void;
  invites?: any[];
  onAcceptInvite?: (invId: string) => void;
  onDeclineInvite?: (invId: string) => void;
  notifications?: any[];
  notifUnread?: number;
  onMarkNotifRead?: (notifId: string) => void;
  onMarkAllNotifsRead?: () => void;
  onDeleteNotif?: (notifId: string) => void;
  externalSearch?: string;
}

export default function ActivityView({
  conversations,
  calls,
  voicemails,
  onOpenCalls,
  meetings,
  meId,
  onMarkRead,
  onSetRead,
  onOpenConversation,
  onOpenPerson,
  onOpenTask,
  onOpenReminder,
  onOpenFile,
  onJoin,
  onToast,
  invites = [],
  onAcceptInvite,
  onDeclineInvite,
  notifications = [],
  notifUnread = 0,
  onMarkNotifRead,
  onMarkAllNotifsRead,
  onDeleteNotif,
  externalSearch,
}: ActivityViewProps) {
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");

  const NOTIF_PAGE = 20;
  const [notifShown, setNotifShown] = useState(NOTIF_PAGE);

  const visibleNotifs = useMemo(
    () => (notifications || []).filter((n: any) => !isHiddenModule(notifTargetModule(n))),
    [notifications],
  );

  useEffect(() => {
    setNotifShown(NOTIF_PAGE);
  }, [cat]);

  useEffect(() => {
    setQ(externalSearch || "");
  }, [externalSearch]);

  const [selMode, setSelMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const now = Date.now();

  const mEnd = (m: any) =>
    new Date(m.startsAt).getTime() + (m.durationMin || 30) * 60000;

  const isMeetingOver = (m: any) =>
    !!m &&
    (m.status === "ended" ||
      m.status === "cancelled" ||
      now >= mEnd(m));

  const items: any[] = [];
  const mtSorted = (meetings || [])
    .filter((m) => {
      if (!m.startsAt) return false;
      const t = new Date(m.startsAt).getTime();
      return (
        t >= now - 5 * 60000 &&
        t <= now + 24 * 3600000 &&
        (m.mine || (m.attendees || []).some((a: any) => a.id === meId))
      );
    })
    .sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
    );

  for (const m of mtSorted) {
    const soon = new Date(m.startsAt).getTime() - now <= 30 * 60000;
    items.push({
      id: "mt_" + m.id,
      category: "meeting",
      priority: soon ? 95 : 60,
      kind: "meeting",
      meeting: m,
    });
  }

  for (const c of conversations || []) {
    if (!c || c.kind === "self") continue;
    if (c.hidden) continue;
    if ((c.unread || 0) <= 0) continue;
    const isDm = c.kind === "dm";
    items.push({
      id: "cv_" + c.id,
      category: isDm ? "dm" : "group",
      priority: isDm ? 75 : 50,
      kind: "conversation",
      conv: c,
    });
  }

  for (const c of calls || []) {
    if (c.direction !== "missed") continue;
    items.push({
      id: "cl_" + c.id,
      category: "call",
      priority: 80,
      kind: "call",
      call: c,
    });
  }

  for (const vm of voicemails || []) {
    if (vm.listened) continue;
    items.push({
      id: "vm_" + vm.id,
      category: "voicemail",
      priority: 85,
      kind: "voicemail",
      vm,
    });
  }

  for (const inv of invites || []) {
    if (inv.direction !== "incoming" || inv.status !== "pending" || !inv.from)
      continue;
    items.push({
      id: "req_" + inv.id,
      category: "request",
      priority: 88,
      kind: "request",
      invite: inv,
    });
  }

  const ranked = items
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => b.it.priority - a.it.priority || a.idx - b.idx)
    .map((x) => x.it);

  const catMatch = (it: any) =>
    cat === "all"
      ? true
      : cat === "messages"
        ? it.category === "dm" || it.category === "group"
        : cat === "calls"
          ? it.category === "call" || it.category === "voicemail"
          : cat === "requests"
            ? it.category === "request"
            : it.category === "meeting";

  const textOf = (it: any) =>
    it.kind === "conversation"
      ? (it.conv.name || "") + " " + (it.conv.preview || "")
      : it.kind === "call"
        ? (it.call.peer && it.call.peer.name) || ""
        : it.kind === "voicemail"
          ? (it.vm.from && it.vm.from.name) || ""
          : it.kind === "request"
            ? (it.invite.from && it.invite.from.name) || ""
            : it.meeting.title || "";

  const searchMatch = (it: any) =>
    !q.trim() || textOf(it).toLowerCase().includes(q.toLowerCase());

  const list = ranked.filter((it) => catMatch(it) && searchMatch(it));

  const totalUnread = (conversations || [])
    .filter((c) => c && c.kind !== "self" && !c.hidden)
    .reduce((n, c) => n + (c.unread || 0), 0);

  const has = {
    requests: ranked.some((it) => it.category === "request"),
    messages: ranked.some(
      (it) => it.category === "dm" || it.category === "group",
    ),
    calls: ranked.some(
      (it) => it.category === "call" || it.category === "voicemail",
    ),
    meetings: ranked.some((it) => it.category === "meeting"),
  };

  const reqCount = ranked.filter((it) => it.category === "request").length;
  const chips: [string, string][] = [["all", "All"]];
  if (has.requests) chips.push(["requests", "Requests"]);
  if (has.messages) chips.push(["messages", "Messages"]);
  if (has.calls) chips.push(["calls", "Calls"]);
  if (has.meetings) chips.push(["meetings", "Meetings"]);
  chips.push(["notifications", "Notifications"]);

  const selectable = list.filter((it) => it.kind === "conversation");

  const toggleSel = (id: string) =>
    setSel((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const exitSel = () => {
    setSelMode(false);
    setSel(new Set());
  };

  const bulkRead = () => {
    [...sel]
      .map((sid) => ranked.find((it) => it.id === sid))
      .filter((it) => it && it.kind === "conversation")
      .forEach((it) => onSetRead(it.conv.id));
    exitSel();
  };

  const callLabel = (c: any) =>
    c.direction === "missed"
      ? "Missed call"
      : c.direction === "in"
        ? "Incoming call"
        : "Outgoing call";

  const meetLabel = (m: any) => {
    if (isMeetingOver(m)) return m.status === "cancelled" ? "Cancelled" : "Ended";
    const diff = new Date(m.startsAt).getTime() - now;
    if (diff <= 0 && now < mEnd(m)) return "Live now";
    if (diff <= 30 * 60000)
      return "In " + Math.max(1, Math.round(diff / 60000)) + " min";
    return new Date(m.startsAt).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <div className="view active" id="vact">
      <div className="ibx-tabs">
        {chips.map(([k, lbl]) => (
          <button
            key={k}
            className={"ibx-tab" + (cat === k ? " active" : "")}
            aria-pressed={cat === k}
            onClick={() => setCat(k)}
          >
            {lbl}
            {k === "all" && totalUnread > 0 ? (
              <span className="ibx-tab-c">{totalUnread}</span>
            ) : k === "requests" && reqCount > 0 ? (
              <span className="ibx-tab-c">{reqCount}</span>
            ) : k === "notifications" && notifUnread > 0 ? (
              <span className="ibx-tab-c">{notifUnread}</span>
            ) : null}
          </button>
        ))}
        <div className="ibx-tabs-actions">
          {selMode ? (
            <>
              <button
                className="ibx-mark"
                disabled={!sel.size}
                onClick={bulkRead}
              >
                Mark read ({sel.size})
              </button>
              <button className="ibx-mark" onClick={exitSel}>
                Done
              </button>
            </>
          ) : (
            <>
              {selectable.length ? (
                <button className="ibx-mark" onClick={() => setSelMode(true)}>
                  Select
                </button>
              ) : null}
              <button
                className="ibx-mark"
                onClick={() => {
                  onMarkRead();
                  onMarkAllNotifsRead && onMarkAllNotifsRead();
                }}
              >
                Mark all read
              </button>
            </>
          )}
        </div>
      </div>
      <div className="ibx-body">
        {(cat === "notifications" || cat === "all") &&
        visibleNotifs.length > 0 ? (
          <>
            {visibleNotifs.slice(0, notifShown).map((n) => (
              <div
                key={n.id}
                className={"ibx-row" + (n.isRead ? "" : " unread")}
                style={{ cursor: "pointer", position: "relative" }}
                onClick={() => {
                  if (!n.isRead && onMarkNotifRead) onMarkNotifRead(n.id);
                  const t = n.type || "";
                  if (
                    (t === "meeting_invite" || n.targetType === "meeting") &&
                    n.targetId &&
                    onJoin
                  ) {
                    const mtg = (meetings || []).find(
                      (mm: any) => mm.id === n.targetId,
                    );
                    if (mtg && isMeetingOver(mtg)) {
                      if (onToast) onToast("This meeting has ended.");
                      return;
                    }
                    onJoin(n.targetId);
                    return;
                  }
                  if (
                    (t === "task_assigned" || t === "task_due" || n.targetType === "task") &&
                    n.targetId &&
                    onOpenTask
                  ) {
                    onOpenTask(n.targetId);
                    return;
                  }
                  if (
                    (t === "reminder" || n.targetType === "reminder") &&
                    n.targetId &&
                    onOpenReminder
                  ) {
                    onOpenReminder(n.targetId);
                    return;
                  }
                  if (
                    (t === "file_shared" || n.targetType === "file") &&
                    n.targetId &&
                    onOpenFile
                  ) {
                    onOpenFile(n.targetId);
                    return;
                  }
                  if (
                    n.targetType === "message" &&
                    n.conversationId &&
                    n.targetId
                  ) {
                    onOpenConversation(n.conversationId, n.targetId);
                    return;
                  }
                  if (t === "call_missed" || n.targetType === "call") {
                    if (onOpenCalls) onOpenCalls();
                    return;
                  }
                  if (n.conversationId) {
                    onOpenConversation(n.conversationId);
                    return;
                  }
                }}
              >
                <span
                  className={"ibx-notif-icon notif-" + (n.type || "default")}
                >
                  {notifIcon(n.type)}
                </span>
                <span className="ibx-row-body">
                  <span className="ibx-row-top">
                    <span className="ibx-row-name">{n.title || (n.body ? "" : "Notification")}</span>
                    <span className="ibx-row-time">
                      {n.createdAt
                        ? new Date(n.createdAt).toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                          })
                        : ""}
                    </span>
                  </span>
                  {n.body ? (
                    <span className="ibx-row-prev">
                      {messagePreview(n.body)}
                    </span>
                  ) : null}
                </span>
                {onDeleteNotif ? (
                  <button
                    className="ibx-notif-del"
                    title="Dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteNotif(n.id);
                    }}
                  >
                    <IconX size={13} />
                  </button>
                ) : null}
              </div>
            ))}
            {visibleNotifs.length > notifShown ? (
              <button
                type="button"
                className="ibx-showmore"
                onClick={() => setNotifShown((n) => n + NOTIF_PAGE)}
              >
                Show more ({visibleNotifs.length - notifShown})
              </button>
            ) : null}
          </>
        ) : null}

        {cat === "notifications" ? (
          notifications.length === 0 ? (
            <div className="ibx-empty">No notifications yet.</div>
          ) : null
        ) : list.length === 0 ? (
          cat === "all" && notifications.length > 0 ? null : (
            <div className="ibx-empty">
              {q.trim() ? "No matching items." : "You're all caught up."}
            </div>
          )
        ) : (
          list.map((it) => {
            if (it.kind === "request") {
              const inv = it.invite;
              const from = inv.from || {};
              return (
                <div key={it.id} className="ibx-row unread">
                  <button
                    className="ibx-row-main"
                    onClick={() => from.id && onOpenPerson(from.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      flex: 1,
                      background: "none",
                      border: 0,
                      textAlign: "left",
                      cursor: "pointer",
                      minWidth: 0,
                    }}
                  >
                    <Avatar
                      avatar={{
                        kind: "user",
                        initials: from.initials,
                        color: from.color,
                        avatarUrl: from.avatarUrl,
                      }}
                      size={40}
                    />
                    <span className="ibx-row-body">
                      <span className="ibx-row-top">
                        <span className="ibx-row-name">
                          {from.name || "Someone"}
                          <span className="ibx-cat cat-request">Request</span>
                        </span>
                        <span className="ibx-row-time">
                          {inv.createdAt ? sidebarTime(inv.createdAt) : ""}
                        </span>
                      </span>
                      <span className="ibx-row-prev">
                        Wants to connect with you
                      </span>
                    </span>
                  </button>
                  <span className="req-actions">
                    <button
                      className="req-accept"
                      onClick={() => onAcceptInvite && onAcceptInvite(inv.id)}
                    >
                      Accept
                    </button>
                    <button
                      className="req-decline"
                      onClick={() => onDeclineInvite && onDeclineInvite(inv.id)}
                    >
                      Decline
                    </button>
                  </span>
                </div>
              );
            }
            if (it.kind === "conversation") {
              const c = it.conv;
              const picked = selMode && sel.has(it.id);
              return (
                <button
                  key={it.id}
                  className={"ibx-row unread" + (picked ? " picked" : "")}
                  onClick={() =>
                    selMode ? toggleSel(it.id) : onOpenConversation(c.id)
                  }
                >
                  {selMode ? (
                    <span className={"ibx-check" + (picked ? " on" : "")}>
                      {picked ? <IconCheck size={14} /> : null}
                    </span>
                  ) : null}
                  <Avatar avatar={c.avatar} size={40} />
                  <span className="ibx-row-body">
                    <span className="ibx-row-top">
                      <span className="ibx-row-name">
                        {c.name}
                        <span className={"ibx-cat cat-" + it.category}>
                          {it.category === "dm" ? "Direct" : "Group"}
                        </span>
                      </span>
                      <span className="ibx-row-time">
                        {c.lastMessageAt ? sidebarTime(c.lastMessageAt) : c.time}
                      </span>
                    </span>
                    <span className="ibx-row-prev">{c.preview}</span>
                  </span>
                  {(c.unread || 0) > 0 ? (
                    <span className="ibx-badge">{c.unread}</span>
                  ) : null}
                </button>
              );
            }
            if (it.kind === "call") {
              const c = it.call;
              return (
                <button
                  key={it.id}
                  className="ibx-row"
                  onClick={() => c.peer && c.peer.id && onOpenPerson(c.peer.id)}
                >
                  <Avatar
                    avatar={{
                      kind: "user",
                      initials: c.peer && c.peer.initials,
                      color: c.peer && c.peer.color,
                      avatarUrl: c.peer && c.peer.avatarUrl,
                    }}
                    size={40}
                  />
                  <span className="ibx-row-body">
                    <span className="ibx-row-top">
                      <span className="ibx-row-name">
                        {(c.peer && c.peer.name) || "Unknown"}
                        <span className="ibx-cat cat-call">Call</span>
                      </span>
                      <span className="ibx-row-time">
                        {c.startedAt ? sidebarTime(c.startedAt) : c.time}
                      </span>
                    </span>
                    <span className="ibx-row-prev miss">
                      {callLabel(c)}
                      {c.video ? " · Video" : ""}
                    </span>
                  </span>
                </button>
              );
            }
            if (it.kind === "voicemail") {
              const v = it.vm;
              return (
                <button
                  key={it.id}
                  className="ibx-row"
                  onClick={() => onOpenCalls && onOpenCalls()}
                >
                  <Avatar
                    avatar={{
                      kind: "user",
                      initials: v.from && v.from.initials,
                      color: v.from && v.from.color,
                      avatarUrl: v.from && v.from.avatarUrl,
                    }}
                    size={40}
                  />
                  <span className="ibx-row-body">
                    <span className="ibx-row-top">
                      <span className="ibx-row-name">
                        {(v.from && v.from.name) || "Unknown"}
                        <span className="ibx-cat cat-call">Voicemail</span>
                      </span>
                      <span className="ibx-row-time">
                        {v.createdAt ? sidebarTime(v.createdAt) : v.time}
                      </span>
                    </span>
                    <span className="ibx-row-prev">
                      Voicemail
                      {v.durationSec ? " · " + v.durationSec + "s" : ""}
                    </span>
                  </span>
                </button>
              );
            }
            const m = it.meeting;
            const over = isMeetingOver(m);
            const live =
              !over && now >= new Date(m.startsAt).getTime() && now < mEnd(m);
            return (
              <div key={it.id} className="ibx-row ibx-meet">
                <span className="ibx-mt-ic"><IconCalendarDays size={18} /></span>
                <span className="ibx-row-body">
                  <span className="ibx-row-top">
                    <span className="ibx-row-name">
                      {m.title}
                      <span className="ibx-cat cat-meeting">Meeting</span>
                    </span>
                    <span
                      className={
                        "ibx-row-time" + (it.priority >= 95 ? " soon" : "")
                      }
                    >
                      {meetLabel(m)}
                    </span>
                  </span>
                  <span className="ibx-row-prev">
                    {(m.attendees || []).length} attendee
                    {(m.attendees || []).length === 1 ? "" : "s"}
                  </span>
                </span>
                {over ? (
                  <span className="ibx-ended">
                    {m.status === "cancelled" ? "Meeting cancelled" : "Meeting ended"}
                  </span>
                ) : (
                  <button
                    className={"ibx-join" + (live ? " live" : "")}
                    onClick={() => {
                      onJoin(m.id);
                      onToast("Joining " + m.title + "...");
                    }}
                  >
                    {live ? "Join now" : "Join"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
