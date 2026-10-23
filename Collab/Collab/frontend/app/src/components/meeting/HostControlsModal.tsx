import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  IconX,
  IconSearch,
  IconMic,
  IconMicOff,
  IconVideo,
  IconVideoOff,
  IconMonitor,
  IconPencil,
  IconSettings,
} from "../../lib/icons";
import { initialsOf, colorOf } from "../../lib/meeting/identity";

// Host Settings — the meeting creator's control panel.
//
// Lists everyone in the room and lets the host: mute one or all, remove people,
// and switch camera / screen sharing / whiteboard on or off — for the whole
// meeting or for one person. Opened from the Settings button in the control bar,
// which only the creator is shown.
//
// This component owns only the camera / screen share / whiteboard state (it
// fetches it on open and writes it through the host-only routes). Mute and remove
// reuse the stage's existing handlers, passed in, so there is still exactly one
// code path for each — including its "SFU unreachable / already left" feedback.
//
// Every control here takes effect at once: the server rewrites the person's
// LiveKit permission, stops whatever they were publishing, and tells their client.

export interface HostControlsParticipant {
  sid: string;
  userId: string;
  name: string;
  isLocal?: boolean;
  micOn?: boolean;
  camOn?: boolean;
  avatarUrl?: string | null;
}

interface Props {
  token: string;
  meetingId: string;
  participants: HostControlsParticipant[];
  hostId?: string | null;
  coHostIds?: Set<string> | null;
  onMute: (userId: string) => void | Promise<void>;
  onMuteAll: () => void | Promise<void>;
  onRemove: (userId: string) => void | Promise<void>;
  onToast?: (m: string) => void;
  onClose: () => void;
}

interface UserFlags {
  cameraBlocked?: boolean;
  screenShareBlocked?: boolean;
  whiteboardBlocked?: boolean;
}

interface Controls {
  allowCamera: boolean;
  allowScreenShare: boolean;
  allowWhiteboard: boolean;
  whiteboardLockedByAdmin: boolean;
  users: Record<string, UserFlags>;
}

type Kind = "camera" | "screenShare" | "whiteboard";
const FLAG: Record<Kind, keyof UserFlags> = {
  camera: "cameraBlocked",
  screenShare: "screenShareBlocked",
  whiteboard: "whiteboardBlocked",
};
const WIDE: Record<Kind, "allowCamera" | "allowScreenShare" | "allowWhiteboard"> = {
  camera: "allowCamera",
  screenShare: "allowScreenShare",
  whiteboard: "allowWhiteboard",
};
const LABEL: Record<Kind, string> = {
  camera: "Camera",
  screenShare: "Screen sharing",
  whiteboard: "Whiteboard",
};

const SHORT: Record<Kind, string> = { camera: "Camera", screenShare: "Screen", whiteboard: "Board" };

function Switch({
  on,
  disabled,
  label,
  title,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  title?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={"ms-hc-switch" + (on ? " on" : "")}
      onClick={() => onChange(!on)}
    >
      <span className="ms-hc-switch-knob" />
    </button>
  );
}

export default function HostControlsModal({
  token,
  meetingId,
  participants,
  hostId,
  coHostIds,
  onMute,
  onMuteAll,
  onRemove,
  onToast,
  onClose,
}: Props) {
  const [ctl, setCtl] = useState<Controls | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [query, setQuery] = useState("");
  // Keys currently being saved ("wide:camera", "u1:screenShare") — a control is
  // disabled while its own request is in flight so it can't be double-fired.
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r: any = await api.getMeetingHostControls(token, meetingId);
      const d = r?.data ?? r;
      setCtl({
        allowCamera: d.allowCamera !== false,
        allowScreenShare: d.allowScreenShare !== false,
        allowWhiteboard: d.allowWhiteboard !== false,
        whiteboardLockedByAdmin: !!d.whiteboardLockedByAdmin,
        users: d.users || {},
      });
      setLoadErr("");
    } catch (e: any) {
      setLoadErr(e?.message || "Couldn't load the meeting controls.");
    }
  }, [token, meetingId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mark = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  // Meeting-wide switch. Optimistic, reverted if the server refuses.
  const setWide = async (kind: Kind, allowed: boolean) => {
    if (!ctl) return;
    const key = "wide:" + kind;
    const before = ctl[WIDE[kind]];
    setCtl({ ...ctl, [WIDE[kind]]: allowed });
    mark(key, true);
    try {
      await api.setMeetingHostSettings(token, meetingId, { [WIDE[kind]]: allowed });
      onToast &&
        onToast(
          `${LABEL[kind]} ${allowed ? "turned on" : "turned off"} for everyone but you and co-hosts`,
        );
    } catch (e: any) {
      setCtl((c) => (c ? { ...c, [WIDE[kind]]: before } : c));
      onToast && onToast(e?.message || `Couldn't change ${LABEL[kind].toLowerCase()}`);
    } finally {
      mark(key, false);
    }
  };

  // Per-person switch. `allowed` = the new state of the permission.
  const setUser = async (userId: string, name: string, kind: Kind, allowed: boolean) => {
    if (!ctl) return;
    const key = userId + ":" + kind;
    const prev = ctl.users[userId] || {};
    setCtl({ ...ctl, users: { ...ctl.users, [userId]: { ...prev, [FLAG[kind]]: !allowed } } });
    mark(key, true);
    try {
      await api.setMeetingParticipantPermissions(token, meetingId, userId, {
        [kind]: allowed,
      });
      onToast &&
        onToast(`${LABEL[kind]} ${allowed ? "allowed" : "turned off"} for ${name}`);
    } catch (e: any) {
      setCtl((c) => (c ? { ...c, users: { ...c.users, [userId]: prev } } : c));
      onToast && onToast(e?.message || `Couldn't change ${LABEL[kind].toLowerCase()} for ${name}`);
    } finally {
      mark(key, false);
    }
  };

  const others = participants.filter((p) => !p.isLocal && p.userId !== hostId);
  const q = query.trim().toLowerCase();
  const shown = q ? others.filter((p) => String(p.name || "").toLowerCase().includes(q)) : others;

  const wideRow = (kind: Kind, icon: JSX.Element, hint: string) => {
    const locked = kind === "whiteboard" && !!ctl?.whiteboardLockedByAdmin;
    const on = !!ctl && ctl[WIDE[kind]] && !locked;
    return (
      <div className="ms-hc-wide-row" key={kind}>
        <span className="ms-hc-wide-icon">{icon}</span>
        <span className="ms-hc-wide-text">
          <span className="ms-hc-wide-label">{LABEL[kind]}</span>
          <span className="ms-hc-wide-hint">
            {locked ? "Turned off by an administrator" : hint}
          </span>
        </span>
        <Switch
          on={on}
          disabled={!ctl || locked || busy.has("wide:" + kind)}
          label={`${LABEL[kind]} for participants`}
          onChange={(next) => setWide(kind, next)}
        />
      </div>
    );
  };

  const personSwitch = (p: HostControlsParticipant, kind: Kind) => {
    const wideOn = !!ctl && ctl[WIDE[kind]] && !(kind === "whiteboard" && ctl.whiteboardLockedByAdmin);
    const blocked = !!ctl?.users[p.userId]?.[FLAG[kind]];
    const on = wideOn && !blocked;
    return (
      <span className="ms-hc-cell">
        {/* Column headers carry the meaning on desktop; on a phone the grid
            wraps and they are gone, so each switch brings its own label. */}
        <span className="ms-hc-cell-label">{SHORT[kind]}</span>
        <Switch
          on={on}
          // Off for everyone means off for everyone: a per-person switch can't
          // grant what the meeting-wide one has taken away.
          disabled={!ctl || !wideOn || busy.has(p.userId + ":" + kind)}
          label={`${LABEL[kind]} for ${p.name}`}
          title={wideOn ? undefined : `${LABEL[kind]} is turned off for everyone`}
          onChange={(next) => setUser(p.userId, p.name, kind, next)}
        />
      </span>
    );
  };

  return (
    <div
      className="ms-hc-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ms-hc-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ms-hc-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="ms-hc-head">
          <span className="ms-hc-title" id="ms-hc-title">
            <IconSettings size={16} /> Host settings
          </span>
          <button className="ms-hc-close" onClick={onClose} aria-label="Close host settings">
            <IconX size={15} />
          </button>
        </div>

        <div className="ms-hc-body">
          {loadErr && (
            <div className="ms-hc-error" role="alert">
              {loadErr}{" "}
              <button className="ms-hc-link" onClick={load}>
                Try again
              </button>
            </div>
          )}

          <section className="ms-hc-section">
            <div className="ms-hc-section-title">For all participants</div>
            {wideRow("camera", <IconVideo size={17} />, "Participants can turn on their camera")}
            {wideRow("screenShare", <IconMonitor size={17} />, "Participants can share their screen")}
            {wideRow("whiteboard", <IconPencil size={17} />, "Anyone can use the whiteboard")}
            <div className="ms-hc-note">
              Camera and screen sharing never apply to you or your co-hosts. Turning the
              whiteboard off closes it for everyone, including you.
            </div>
            <button className="ms-hc-mute-all" onClick={() => onMuteAll()}>
              <IconMicOff size={14} /> Mute everyone
            </button>
          </section>

          <section className="ms-hc-section">
            <div className="ms-hc-section-title">
              Participants <span className="ms-hc-count">{others.length}</span>
            </div>
            <div className="ms-hc-search">
              <IconSearch size={13} />
              <input
                placeholder="Search participants…"
                aria-label="Search participants"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {others.length === 0 ? (
              <div className="ms-hc-empty">No one else has joined yet.</div>
            ) : shown.length === 0 ? (
              <div className="ms-hc-empty">No one matches “{query}”.</div>
            ) : (
              <>
                <div className="ms-hc-cols" aria-hidden="true">
                  <span />
                  <span title="Camera">Cam</span>
                  <span title="Screen sharing">Screen</span>
                  <span title="Whiteboard">Board</span>
                  <span />
                </div>
                {shown.map((p) => {
                  const isCoHost = !!(coHostIds && coHostIds.has && coHostIds.has(p.userId));
                  return (
                    <div className="ms-hc-person" key={p.sid}>
                      <div className="ms-hc-who">
                        <span
                          className="ms-hc-avatar"
                          style={{ background: colorOf(p.userId || p.name) }}
                        >
                          {initialsOf(p.name)}
                          {p.avatarUrl ? (
                            <img
                              src={p.avatarUrl}
                              alt=""
                              onError={(e) => {
                                e.currentTarget.style.display = "none";
                              }}
                            />
                          ) : null}
                        </span>
                        <span className="ms-hc-name">
                          <span className="ms-hc-name-text">{p.name}</span>
                          <span className="ms-hc-role">
                            {isCoHost ? "Co-host" : "Participant"}
                            <span
                              className={"ms-hc-state" + (p.micOn === false ? " off" : "")}
                              title={p.micOn === false ? "Microphone off" : "Microphone on"}
                            >
                              {p.micOn === false ? <IconMicOff size={12} /> : <IconMic size={12} />}
                            </span>
                            <span
                              className={"ms-hc-state" + (p.camOn === false ? " off" : "")}
                              title={p.camOn === false ? "Camera off" : "Camera on"}
                            >
                              {p.camOn === false ? <IconVideoOff size={12} /> : <IconVideo size={12} />}
                            </span>
                          </span>
                        </span>
                      </div>

                      {isCoHost ? (
                        <span className="ms-hc-exempt">Co-hosts are never restricted</span>
                      ) : (
                        <>
                          {personSwitch(p, "camera")}
                          {personSwitch(p, "screenShare")}
                          {personSwitch(p, "whiteboard")}
                        </>
                      )}

                      <div className="ms-hc-actions">
                        {confirmRemove === p.userId ? (
                          <>
                            <button
                              className="ms-hc-btn danger"
                              onClick={() => {
                                setConfirmRemove(null);
                                onRemove(p.userId);
                              }}
                            >
                              Remove
                            </button>
                            <button className="ms-hc-btn" onClick={() => setConfirmRemove(null)}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="ms-hc-btn"
                              onClick={() => onMute(p.userId)}
                              disabled={p.micOn === false}
                              title={p.micOn === false ? "Already muted" : "Mute"}
                              aria-label={`Mute ${p.name}`}
                            >
                              <IconMicOff size={13} /> Mute
                            </button>
                            <button
                              className="ms-hc-btn danger-ghost"
                              onClick={() => setConfirmRemove(p.userId)}
                              aria-label={`Remove ${p.name} from the meeting`}
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
            <div className="ms-hc-note">
              Muting is one-way — people can unmute themselves. Removed people can't rejoin.
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
