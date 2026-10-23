"use client";
import React, { useEffect, useState } from "react";
import Modal from "../Modal";
import Avatar from "../Avatar";
import { api } from "../../lib/api";
import { IconVideo, IconDownload } from "../../lib/icons";

// End-of-meeting line + Attendance card (message type "meeting_attendance"), and
// the report it opens. The card itself only carries the session summary; the
// per-person table is fetched on click from the host-gated endpoint, so it is
// offered only to the people who may open it (host + co-hosts).

// "16s" · "52m 32s" · "1h 04m 09s"
export function fmtSpan(totalSec: number): string {
  const s = Math.max(0, Math.round(Number(totalSec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m ${String(r).padStart(2, "0")}s`;
  if (m) return `${m}m ${r}s`;
  return `${r}s`;
}

const clock = (v: any, hour12: boolean) => {
  const d = new Date(v);
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12 })
    : "—";
};

export function MeetingEndedRow({
  m,
  meId,
  token,
  timeFormat,
}: {
  m: any;
  meId?: string;
  token?: string;
  timeFormat?: string;
}) {
  const [open, setOpen] = useState(false);
  const a = m.attendance || {};
  const hour12 = (timeFormat || "12h") !== "24h";
  const when = m.createdAt ? new Date(m.createdAt) : null;
  const stamp =
    when && Number.isFinite(when.getTime())
      ? `${when.getMonth() + 1}/${when.getDate()} ${clock(when, hour12)}`
      : "";
  const canView =
    !!token && !!a.meetingId && Array.isArray(a.viewerIds) && !!meId && a.viewerIds.includes(meId);
  return (
    <div className="msg-system" role="listitem" id={"msg-" + m.id}>
      <div className="mtg-end">
        <div className="mtg-end-line">
          <IconVideo size={16} aria-hidden="true" />
          {stamp ? <span className="mtg-end-time">{stamp}</span> : null}
          <span>
            Meeting ended: <strong>{fmtSpan(a.durationSec)}</strong>
          </span>
        </div>
        {canView ? (
          <button type="button" className="mtg-att-card" onClick={() => setOpen(true)}>
            <span className="mtg-att-ico" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="3" width="12" height="18" rx="2" />
                <path d="M13 8h5M13 12h5M13 16h5" />
                <circle cx="5.5" cy="10" r="2.2" />
                <path d="M2 18c0-2.2 1.6-3.6 3.5-3.6S9 15.8 9 18" />
              </svg>
            </span>
            <span className="mtg-att-t">Attendance</span>
          </button>
        ) : null}
      </div>
      {open ? (
        <AttendanceReportModal
          token={token as string}
          card={a}
          hour12={hour12}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function AttendanceReportModal({
  token,
  card,
  hour12,
  onClose,
}: {
  token: string;
  card: any;
  hour12: boolean;
  onClose: () => void;
}) {
  const [report, setReport] = useState<any>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .getMeetingAttendance(token, card.meetingId, card.startedAt)
      .then((r: any) => alive && setReport(r))
      .catch((e: any) =>
        alive && setErr((e && e.message) || "Couldn't load the attendance report."),
      );
    return () => {
      alive = false;
    };
  }, [token, card.meetingId, card.startedAt]);

  // Header figures: the live report wins; the card's snapshot fills in while loading.
  const s = (report && report.summary) || card;
  const start = s.startedAt ? new Date(s.startedAt) : null;
  const rows: any[] = (report && report.rows) || [];
  const dateLabel =
    start && Number.isFinite(start.getTime())
      ? `${start.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })} ${clock(s.startedAt, hour12)} - ${clock(s.endedAt, hour12)}`
      : "";

  const download = () => {
    const esc = (v: any) => {
      const t = v == null ? "" : String(v);
      return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const iso = (v: any) => {
      const d = new Date(v);
      return Number.isFinite(d.getTime()) ? d.toISOString() : "";
    };
    const lines = [
      ["Meeting", card.title || ""],
      ["Attended", s.attendedCount ?? rows.length],
      ["Start time", iso(s.startedAt)],
      ["End time", iso(s.endedAt)],
      ["Meeting duration", fmtSpan(s.durationSec)],
      ["Average attendance time", fmtSpan(s.avgSeconds)],
      [],
      ["Name", "Email", "First join", "Last leave", "In-meeting duration", "Role"],
      ...rows.map((r) => [r.name, r.email || "", iso(r.firstJoined), iso(r.lastLeft), fmtSpan(r.seconds), r.role || ""]),
    ];
    const blob = new Blob([String.fromCharCode(0xfeff) + lines.map((l) => l.map(esc).join(",")).join("\r\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const el = document.createElement("a");
    el.href = url;
    el.download = `attendance-${(card.title || "meeting").replace(/[^\w-]+/g, "_")}.csv`;
    document.body.appendChild(el);
    el.click();
    el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const tile = (big: React.ReactNode, label: string) => (
    <div className="att-tile">
      <div className="att-tile-big">{big}</div>
      <div className="att-tile-lbl">{label}</div>
    </div>
  );

  return (
    <Modal wide width={920} title={card.title ? `Attendance · ${card.title}` : "Attendance"} onClose={onClose}>
      <div className="att-bar">
        <span className="att-date">{dateLabel}</span>
        <button type="button" className="att-dl" onClick={download} disabled={!report}>
          <IconDownload size={15} aria-hidden="true" /> Download
        </button>
      </div>
      <div className="att-tiles">
        {tile(s.attendedCount ?? "—", "Attended")}
        {tile(
          <>
            {clock(s.startedAt, hour12)} - {clock(s.endedAt, hour12)}
          </>,
          "Start and end time",
        )}
        {tile(fmtSpan(s.durationSec), "Meeting duration")}
        {tile(s.avgSeconds != null ? fmtSpan(s.avgSeconds) : "—", "Average attendance time")}
      </div>
      <div className="att-h">Participants</div>
      {err ? (
        <div className="att-empty">{err}</div>
      ) : !report ? (
        <div className="att-empty">Loading…</div>
      ) : (
        <div className="att-table-wrap">
          <table className="att-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>First join</th>
                <th>Last leave</th>
                <th>In-meeting duration</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId}>
                  <td>
                    <div className="att-who">
                      <Avatar avatar={r.avatar || { initials: (r.name || "?").slice(0, 2).toUpperCase() }} size={36} />
                      <div className="att-who-t">
                        <div className="att-name">{r.name}</div>
                        {r.email ? <div className="att-mail">{r.email}</div> : null}
                      </div>
                    </div>
                  </td>
                  <td>{clock(r.firstJoined, hour12)}</td>
                  <td>{r.stillPresent ? "In meeting" : clock(r.lastLeft, hour12)}</td>
                  <td>{fmtSpan(r.seconds)}</td>
                  <td>{r.role || "Attendee"}</td>
                </tr>
              ))}
              {(report.absent || []).map((u: any) => (
                <tr key={"abs-" + u.userId} className="att-absent">
                  <td>
                    <div className="att-who">
                      <Avatar avatar={{ initials: (u.name || "?").slice(0, 2).toUpperCase() }} size={36} />
                      <div className="att-who-t">
                        <div className="att-name">{u.name}</div>
                        {u.email ? <div className="att-mail">{u.email}</div> : null}
                      </div>
                    </div>
                  </td>
                  <td colSpan={4}>Did not attend</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
