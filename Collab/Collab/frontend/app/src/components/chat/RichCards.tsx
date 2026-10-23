"use client";
import React, { useState, useEffect, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import Avatar from "../Avatar";
import { presenceDotClass } from "../../lib/presence";
import PresenceStatusIcon from "./PresenceStatusIcon";
import { type Rect } from "../EmojiPicker";
import {
  IconMessageCircle,
  IconVideo,
  IconPhone,
  IconMail,
  IconCheck,
  IconCalendarDays,
} from "../../lib/icons";

export function PersonCard({
  info,
  rect,
  showChat = true,
  onMessage,
  onCall,
  onEnter,
  onLeave,
}: {
  info: any;
  rect: Rect;
  showChat?: boolean;
  onMessage: (id: string) => void;
  onCall?: (person: any, video: boolean) => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cw = el.offsetWidth || 280;
    const ch = el.offsetHeight || 220;
    const m = 8;
    let left = rect.left + rect.width + 8;
    if (left + cw > window.innerWidth - m) left = rect.left - cw - 8;
    if (left < m) left = m;
    let top = rect.top - 6;
    if (top + ch > window.innerHeight - m) top = window.innerHeight - ch - m;
    if (top < m) top = m;
    setPos({ left, top });
  }, [rect]);

  const presence = info.presence;
  const id = info.id;
  const hasContact = !!(info.email || info.phone);

  return createPortal(
    <div
      ref={ref}
      className="person-card"
      role="dialog"
      aria-label={info.name}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: "fixed",
        left: pos ? pos.left : rect.left + rect.width + 8,
        top: pos ? pos.top : rect.top,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className="person-card-head">
        <div className="ca-wrap">
          <Avatar
            avatar={{
              kind: "user",
              initials: info.initials,
              color: info.color,
              avatarUrl: info.avatarUrl,
            }}
            size={52}
          />
          {presence ? (
            <span className={"sd " + presenceDotClass(presence)} />
          ) : null}
        </div>
        <div className="person-card-id">
          <div className="person-card-name">{info.name}</div>
          {info.memberRole === "owner" ? (
            <div className="person-card-role">Owner</div>
          ) : null}
        </div>
      </div>
      {showChat || onCall ? (
        <div className="person-card-actions">
          {showChat ? (
            <button
              type="button"
              className="pc-iconbtn"
              title="Chat"
              aria-label={"Chat with " + info.name}
              onClick={() => onMessage(id)}
            >
              <IconMessageCircle size={18} />
            </button>
          ) : null}
          {onCall ? (
            <>
              <button
                type="button"
                className="pc-iconbtn"
                title="Video call"
                aria-label={"Video call " + info.name}
                onClick={() => onCall(info, true)}
              >
                <IconVideo size={18} />
              </button>
              <button
                type="button"
                className="pc-iconbtn"
                title="Audio call"
                aria-label={"Call " + info.name}
                onClick={() => onCall(info, false)}
              >
                <IconPhone size={18} />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {hasContact ? (
        <div className="person-card-contact">
          <div className="person-card-contact-label">Contact</div>
          {info.email ? (
            <a
              className="person-card-contact-row"
              href={"mailto:" + info.email}
            >
              <IconMail size={14} />
              <span className="pc-contact-val">{info.email}</span>
            </a>
          ) : null}
          {info.phone ? (
            <a className="person-card-contact-row" href={"tel:" + info.phone}>
              <IconPhone size={14} />
              <span className="pc-contact-val">{info.phone}</span>
            </a>
          ) : null}
        </div>
      ) : null}
      {info.statusText ? (
        <div className="person-card-status">
          <PresenceStatusIcon presence={presence} size={16} />
          <span>{info.statusText}</span>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

export function TaskCard({
  m,
  onOpenTask,
}: {
  m: any;
  onOpenTask?: (id: string) => void;
}) {
  const t = m.task || {};
  const by = m.me ? (m.sender?.name && m.sender.name !== "You" ? m.sender.name : "") : (m.sender && m.sender.name) || "Someone";
  const who =
    t.assigneeNames && t.assigneeNames.length
      ? t.assigneeNames.join(", ")
      : null;
  return (
    <div className="mi-card tkc-card">
      <div className="mi-ic tkc-ic" aria-hidden="true">
        <IconCheck />
      </div>
      <div className="mi-body">
        <div className="mi-title">{t.title || "Task"}</div>
        <div className="mi-meta">
          {by} created this task
          {who ? " · assigned to " + who : ""}
          {t.priority ? " · " + t.priority : ""}
        </div>
        <div className="mi-actions">
          <button
            className="mi-join"
            onClick={() => t.taskId && onOpenTask && onOpenTask(t.taskId)}
          >
            View task
          </button>
        </div>
      </div>
    </div>
  );
}

export function MeetingInviteCard({
  m,
  onJoin,
  onReject,
  isGroup,
}: {
  m: any;
  onJoin?: (id: string) => void;
  onReject?: (id: string) => void;
  isGroup?: boolean;
}) {
  const inv = m.meeting || {};
  const startMs = inv.startsAt ? Date.parse(inv.startsAt) : NaN;
  const hasStart = Number.isFinite(startMs);
  const endMs = hasStart ? startMs + (Number(inv.durationMin) || 30) * 60 * 1000 : NaN;
  const [now, setNow] = useState(() => Date.now());
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const cancelled = inv.status === "cancelled";
  const gone = inv.status === "ended";
  const expired = hasStart && now > endMs;
  const closed = cancelled || gone || expired;
  const unlocked = !closed && (!hasStart || now >= startMs - 10 * 60 * 1000);
  const live = !closed && hasStart && now >= startMs;
  const invitedBy = m.me ? (m.sender?.name && m.sender.name !== "You" ? m.sender.name : "") : (m.sender && m.sender.name) || "Someone";
  const whenLabel = hasStart
    ? new Date(startMs).toLocaleString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";

  if (closed) return null;

  return (
    <div className={"mi-card mi-headline" + (isGroup ? " is-group" : "")}>
      <div className="mi-ic" aria-hidden="true">
        <IconCalendarDays />
      </div>
      <div className="mi-body">
        <div className="mi-title">{inv.title || "Meeting"}</div>
        <div className="mi-meta">
          {invitedBy} invited you{whenLabel ? " · " + whenLabel : ""}
        </div>
      </div>
      <div className="mi-actions">
        {rejected ? (
          <span className="mi-declined">You declined</span>
        ) : unlocked ? (
          <>
            <button
              className="mi-join"
              onClick={() => inv.meetingId && onJoin && onJoin(inv.meetingId)}
            >
              {live ? "Join now" : "Join"}
            </button>
            <button
              className="mi-reject"
              onClick={() => {
                setRejected(true);
                if (inv.meetingId && onReject) onReject(inv.meetingId);
              }}
            >
              Reject
            </button>
          </>
        ) : (
          <span className="mi-locked">Upcoming</span>
        )}
      </div>
    </div>
  );
}
