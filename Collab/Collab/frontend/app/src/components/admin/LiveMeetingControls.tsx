import React, { useCallback, useEffect, useRef, useState } from "react";
import { adminApi } from "../../lib/adminApi";

// Admin "Live controls" for ONE meeting: who is in the call right now, with
// one-click icon actions per person (mute, stop screen share, remove), a
// single-click "Mute everyone", and the whiteboard on/off switch.
//
// Rules mirror the host's in-call controls: mute is one-way (a mic is never
// switched back on for someone), and stopping a screen share only ends the
// CURRENT share — the person may share again.

const POLL_MS = 4000;

const ico = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const IconMic = () => (
  <svg {...ico}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
  </svg>
);
const IconMicOff = () => (
  <svg {...ico}>
    <line x1="2" y1="2" x2="22" y2="22" />
    <path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.8" />
    <path d="M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v4" />
  </svg>
);
const IconScreen = () => (
  <svg {...ico}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);
const IconScreenOff = () => (
  <svg {...ico}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
    <line x1="3" y1="3" x2="21" y2="17" />
  </svg>
);
const IconRemove = () => (
  <svg {...ico}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <line x1="17" y1="8" x2="22" y2="13" />
    <line x1="22" y1="8" x2="17" y2="13" />
  </svg>
);
const IconBoard = () => (
  <svg {...ico}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const IconCam = () => (
  <svg {...ico}>
    <path d="M23 7l-7 5 7 5V7Z" />
    <rect x="1" y="5" width="15" height="14" rx="2" />
  </svg>
);
const IconCamOff = () => (
  <svg {...ico}>
    <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);
const IconBoardOff = () => (
  <svg {...ico}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    <line x1="2" y1="2" x2="22" y2="22" />
  </svg>
);

type Person = {
  userId: string;
  name: string;
  email: string | null;
  isHost: boolean;
  micOn: boolean;
  cameraOn: boolean;
  screenSharing: boolean;
  whiteboardBlocked: boolean;
};

export default function LiveMeetingControls({
  meetingId,
  onToast,
}: {
  meetingId: string;
  onToast: (msg: string, type?: "success" | "error") => void;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [allowWhiteboard, setAllowWhiteboard] = useState(true);
  const [sfuReachable, setSfuReachable] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Person | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const res = await adminApi.getLiveMeeting(meetingId);
    if (!alive.current) return;
    if (res.ok && res.data) {
      setPeople(res.data.participants || []);
      setAllowWhiteboard(res.data.allowWhiteboard !== false);
      setSfuReachable(res.data.sfuReachable !== false);
    }
    setLoaded(true);
  }, [meetingId]);

  useEffect(() => {
    alive.current = true;
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  // One wrapper for every action: disable the control while it runs, toast the
  // outcome, then re-read the room so the icons reflect reality.
  const run = async (key: string, fn: () => Promise<any>, okMsg: string) => {
    setBusy(key);
    const res = await fn();
    if (res.ok) onToast(okMsg, "success");
    else onToast(res.error || "Action failed", "error");
    setBusy(null);
    refresh();
  };

  const unmuted = people.filter((p) => p.micOn).length;
  const sharing = people.filter((p) => p.screenSharing);

  return (
    <div className="adm-panel adm-live" style={{ marginBottom: 20 }}>
      <div className="adm-panel-header" style={{ flexWrap: "wrap", gap: 10 }}>
        <h3 className="adm-panel-title">
          <span className="adm-live-dot" />
          Live Controls ({people.length} in call)
        </h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="adm-btn adm-btn-secondary adm-btn-sm adm-live-btn"
            disabled={busy !== null || unmuted === 0}
            onClick={() => run("mute-all", () => adminApi.liveMuteAll(meetingId), "Everyone muted")}
            title="Mute every microphone in the call"
          >
            <IconMicOff /> Mute everyone
          </button>
          <button
            className="adm-btn adm-btn-secondary adm-btn-sm adm-live-btn"
            disabled={busy !== null || !people.some((p) => p.cameraOn)}
            onClick={() => run("cams-off", () => adminApi.liveCamerasOff(meetingId), "All cameras turned off")}
            title="Turn off every camera in the call"
          >
            <IconCamOff /> Cameras off
          </button>
          <button
            className={"adm-btn adm-btn-sm adm-live-btn " + (allowWhiteboard ? "adm-btn-secondary" : "adm-btn-danger")}
            disabled={busy !== null}
            onClick={() =>
              run(
                "board",
                () => adminApi.liveSetWhiteboard(meetingId, !allowWhiteboard),
                allowWhiteboard ? "Whiteboard disabled for this meeting" : "Whiteboard enabled",
              )
            }
            title={allowWhiteboard ? "Disable the whiteboard for everyone" : "Whiteboard is disabled — click to enable"}
          >
            <IconBoard /> Whiteboard: {allowWhiteboard ? "On" : "Off"}
          </button>
        </div>
      </div>

      {sharing.length > 0 && (
        <div className="adm-live-banner">
          <IconScreen /> Screen sharing now: {sharing.map((p) => p.name).join(", ")}
        </div>
      )}
      {!sfuReachable && (
        <div className="adm-live-banner adm-live-banner-warn">
          The media server did not answer — the list below may be out of date.
        </div>
      )}

      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr>
              <th>In call</th>
              <th style={{ width: 60, textAlign: "center" }}>Mic</th>
              <th style={{ width: 60, textAlign: "center" }}>Camera</th>
              <th style={{ width: 80, textAlign: "center" }}>Screen</th>
              <th style={{ width: 220 }}>Controls</th>
            </tr>
          </thead>
          <tbody>
            {people.length ? (
              people.map((p) => (
                <tr key={p.userId}>
                  <td>
                    <div style={{ fontWeight: 600, color: "#fff", display: "flex", alignItems: "center", gap: 6 }}>
                      {p.name}
                      {p.isHost && <span className="adm-badge adm-badge-warning" style={{ fontSize: 10 }}>Host</span>}
                    </div>
                    {p.email && <div style={{ fontSize: 11.5, color: "var(--adm-text-subtle)" }}>{p.email}</div>}
                  </td>
                  <td style={{ textAlign: "center" }} className={p.micOn ? "adm-live-on" : "adm-live-off"}>
                    {p.micOn ? <IconMic /> : <IconMicOff />}
                  </td>
                  <td style={{ textAlign: "center" }} className={p.cameraOn ? "adm-live-on" : "adm-live-off"}>
                    <IconCam />
                  </td>
                  <td style={{ textAlign: "center" }} className={p.screenSharing ? "adm-live-share" : "adm-live-off"}>
                    <IconScreen />
                  </td>
                  <td>
                    <div className="adm-live-actions">
                      <button
                        className="adm-live-icon"
                        title={p.micOn ? "Mute microphone" : "Microphone already muted"}
                        aria-label={`Mute ${p.name}`}
                        disabled={busy !== null || !p.micOn}
                        onClick={() => run("m" + p.userId, () => adminApi.liveMute(meetingId, p.userId), `Muted ${p.name}`)}
                      >
                        <IconMicOff />
                      </button>
                      <button
                        className="adm-live-icon"
                        title={p.cameraOn ? "Turn off camera" : "Camera already off"}
                        aria-label={`Turn off ${p.name}'s camera`}
                        disabled={busy !== null || !p.cameraOn}
                        onClick={() =>
                          run("c" + p.userId, () => adminApi.liveCameraOff(meetingId, p.userId), `Turned off ${p.name}'s camera`)
                        }
                      >
                        <IconCamOff />
                      </button>
                      <button
                        className="adm-live-icon"
                        title={p.screenSharing ? "Stop screen share" : "Not sharing a screen"}
                        aria-label={`Stop ${p.name}'s screen share`}
                        disabled={busy !== null || !p.screenSharing}
                        onClick={() =>
                          run(
                            "s" + p.userId,
                            () => adminApi.liveStopScreenShare(meetingId, p.userId),
                            `Stopped ${p.name}'s screen share`,
                          )
                        }
                      >
                        <IconScreenOff />
                      </button>
                      <button
                        className={"adm-live-icon" + (p.whiteboardBlocked ? " adm-live-icon-active" : "")}
                        title={
                          !allowWhiteboard
                            ? "Whiteboard is off for the whole meeting"
                            : p.whiteboardBlocked
                              ? "Whiteboard blocked for this person — click to allow"
                              : "Block whiteboard for this person"
                        }
                        aria-label={`${p.whiteboardBlocked ? "Allow" : "Block"} whiteboard for ${p.name}`}
                        disabled={busy !== null || !allowWhiteboard}
                        onClick={() =>
                          run(
                            "w" + p.userId,
                            () => adminApi.liveSetUserWhiteboard(meetingId, p.userId, !!p.whiteboardBlocked),
                            p.whiteboardBlocked
                              ? `Whiteboard allowed for ${p.name}`
                              : `Whiteboard blocked for ${p.name}`,
                          )
                        }
                      >
                        {p.whiteboardBlocked || !allowWhiteboard ? <IconBoardOff /> : <IconBoard />}
                      </button>
                      <button
                        className="adm-live-icon adm-live-icon-danger"
                        title={p.isHost ? "The organizer cannot be removed" : "Remove from the call"}
                        aria-label={`Remove ${p.name} from the call`}
                        disabled={busy !== null || p.isHost}
                        onClick={() => setConfirmRemove(p)}
                      >
                        <IconRemove />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: 28, color: "var(--adm-text-subtle)" }}>
                  {loaded ? "Nobody is in the call right now." : "Loading live room…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {confirmRemove && (
        <div className="adm-modal-backdrop" onClick={() => setConfirmRemove(null)}>
          <div className="adm-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
            <div className="adm-modal-header">
              <h3 className="adm-modal-title">Remove from call</h3>
            </div>
            <div className="adm-modal-body">
              Remove <strong>{confirmRemove.name}</strong> from the live call? They will be disconnected and
              cannot rejoin unless readmitted.
            </div>
            <div className="adm-modal-footer" style={{ display: "flex", gap: 10, justifyContent: "flex-end", padding: "0 20px 20px" }}>
              <button className="adm-btn adm-btn-secondary" onClick={() => setConfirmRemove(null)}>
                Cancel
              </button>
              <button
                className="adm-btn adm-btn-danger"
                onClick={() => {
                  const t = confirmRemove;
                  setConfirmRemove(null);
                  run("r" + t.userId, () => adminApi.liveRemove(meetingId, t.userId), `Removed ${t.name} from the call`);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
