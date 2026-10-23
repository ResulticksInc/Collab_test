"use client";
import { useState, useCallback, useEffect } from "react";
import * as LK from "livekit-client";
import { api } from "../lib/api";
import { IconCheck, IconX } from "../lib/icons";

type Status = "pending" | "running" | "pass" | "warn" | "fail";
interface Result { status: Status; detail: string; }

const DEFAULT: Record<string, Result> = {
  browser: { status: "pending", detail: "" },
  secure: { status: "pending", detail: "" },
  backend: { status: "pending", detail: "" },
  mic: { status: "pending", detail: "" },
  camera: { status: "pending", detail: "" },
  media: { status: "pending", detail: "" },
};

const LABELS: Array<[string, string]> = [
  ["browser", "Browser support (WebRTC)"],
  ["secure", "Secure context (HTTPS)"],
  ["backend", "Server reachable"],
  ["mic", "Microphone access"],
  ["camera", "Camera access"],
  ["media", "Media server (calls & meetings)"],
];

// One-click pre-flight diagnostic. Verifies the full path a call/meeting needs —
// browser capability, permissions, backend, and a REAL LiveKit connect to a
// private probe room (this is the cross-network/TURN check that matters).
export default function ConnectionCheck({ token, onClose }: { token: string; onClose: () => void }) {
  const [res, setRes] = useState<Record<string, Result>>(DEFAULT);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  // Close on global ESC (the app-wide Escape behaviour); claim the event.
  useEffect(() => {
    const onEsc = (e: Event) => { onClose(); e.preventDefault(); };
    window.addEventListener("colab:esc", onEsc as any);
    return () => window.removeEventListener("colab:esc", onEsc as any);
  }, [onClose]);

  const set = (k: string, r: Result) => setRes((p) => ({ ...p, [k]: r }));

  const run = useCallback(async () => {
    setRunning(true);
    setDone(false);
    setRes(DEFAULT);

    // 1. Browser WebRTC capability
    set("browser", { status: "running", detail: "" });
    const hasRTC = typeof window !== "undefined" && !!(window as any).RTCPeerConnection;
    const hasGUM = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    set("browser", hasRTC && hasGUM
      ? { status: "pass", detail: "WebRTC & media APIs available." }
      : { status: "fail", detail: "This browser can't run calls. Use the latest Chrome, Edge, Firefox, or Safari." });

    // 2. Secure context (getUserMedia requires HTTPS or localhost)
    const secure = typeof window !== "undefined" && (window.isSecureContext || location.hostname === "localhost");
    set("secure", secure
      ? { status: "pass", detail: "Served over a secure context." }
      : { status: "fail", detail: "Calls need HTTPS. Open the app over https://." });

    // 3. Backend reachable (also mints the probe token used in step 6)
    set("backend", { status: "running", detail: "" });
    let diag: any = null;
    try {
      diag = await api.getDiagToken(token);
      set("backend", { status: "pass", detail: "Connected to the Collab server." });
    } catch (e: any) {
      set("backend", { status: "fail", detail: (e && e.message) || "Can't reach the server. Check your network." });
    }

    // 4 & 5. Mic + camera permission
    set("mic", { status: "running", detail: "" });
    let micStream: MediaStream | null = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      set("mic", { status: "pass", detail: "Microphone ready." });
    } catch (e: any) {
      set("mic", { status: e && e.name === "NotAllowedError" ? "fail" : "warn", detail: e && e.name === "NotAllowedError" ? "Microphone blocked — allow access in the browser." : "No microphone detected." });
    } finally {
      if (micStream) micStream.getTracks().forEach((t) => t.stop());
    }
    set("camera", { status: "running", detail: "" });
    let camStream: MediaStream | null = null;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      set("camera", { status: "pass", detail: "Camera ready." });
    } catch (e: any) {
      set("camera", { status: "warn", detail: e && e.name === "NotAllowedError" ? "Camera blocked — fine for audio-only calls." : "No camera detected — audio-only calls still work." });
    } finally {
      if (camStream) camStream.getTracks().forEach((t) => t.stop());
    }

    // 6. Real media-server connect — the cross-network / TURN check
    set("media", { status: "running", detail: "Connecting to media server…" });
    if (!diag || !diag.token || !diag.wsUrl) {
      set("media", { status: "fail", detail: "Couldn't get a media token from the server." });
    } else {
      // CRITICAL: pass the SAME iceServers (TURN) the real call uses.
      // Without this, the pre-call diagnostic reports "pass" on a clean LAN
      // (no TURN ever attempted) and "fail" for everyone on VPN/Docker/Hyper-V
      // virtual adapters — exactly the cohort that DOES need TURN. With them,
      // the diagnostic actually exercises the relay path and the result
      // matches the real call's behavior.
      const _ice = ((diag as any) && (diag as any).iceServers) || [];
      // The LiveKit Room ctor accepts an rtcConfig override but the TS type
      // doesn't expose it; matches the cast pattern in CoLabV1/MeetingStage.
      const room = new LK.Room(
        (_ice.length ? { rtcConfig: { iceServers: _ice } } : {}) as any,
      );
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { room.disconnect(); } catch (_) {}
        set("media", { status: "fail", detail: "Media server unreachable from this network — usually a firewall/TURN issue. Try another network or check TURN (TURNS:443)." });
      }, 18000);
      try {
        await room.connect(diag.wsUrl, diag.token);
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          // Best-effort: detect whether a relay (TURN) candidate is in play.
          let relay = false;
          try {
            const pc: RTCPeerConnection | undefined =
              (room as any).engine?.pcManager?.publisher?.pc ||
              (room as any).engine?.pcManager?.subscriber?.pc;
            if (pc) {
              const stats = await pc.getStats();
              stats.forEach((s: any) => {
                if (s.type === "candidate-pair" && s.state === "succeeded") {
                  const local = stats.get(s.localCandidateId);
                  if (local && local.candidateType === "relay") relay = true;
                }
              });
            }
          } catch (_) { /* introspection is best-effort */ }
          set("media", {
            status: "pass",
            detail: relay
              ? "Connected via TURN relay — works through strict firewalls. ✓"
              : "Connected to the media server from this network. ✓",
          });
        }
        try { room.disconnect(); } catch (_) {}
      } catch (e: any) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          set("media", { status: "fail", detail: "Couldn't connect to the media server — likely a firewall/network/TURN issue." });
        }
      }
    }

    setRunning(false);
    setDone(true);
  }, [token]);

  const icon = (s: Status) => {
    if (s === "pass") return <span className="cc-dot cc-pass"><IconCheck size={12} /></span>;
    if (s === "warn") return <span className="cc-dot cc-warn">!</span>;
    if (s === "fail") return <span className="cc-dot cc-fail"><IconX size={12} /></span>;
    if (s === "running") return <span className="cc-dot cc-run" />;
    return <span className="cc-dot cc-idle" />;
  };

  const anyFail = Object.values(res).some((r) => r.status === "fail");
  const allRun = done;

  return (
    <div className="mm-overlay" onClick={onClose}>
      <div className="cc-card" onClick={(e) => e.stopPropagation()}>
        <div className="cc-head">
          <span>Connection check</span>
          <button className="cc-x" onClick={onClose} aria-label="Close"><IconX size={15} /></button>
        </div>
        <p className="cc-sub">Verifies that calls and meetings will work on this device & network.</p>
        <div className="cc-list">
          {LABELS.map(([k, label]) => (
            <div className="cc-row" key={k}>
              {icon(res[k].status)}
              <div className="cc-row-body">
                <span className="cc-row-label">{label}</span>
                {res[k].detail ? <span className="cc-row-detail">{res[k].detail}</span> : null}
              </div>
            </div>
          ))}
        </div>
        {allRun ? (
          <div className={"cc-summary " + (anyFail ? "fail" : "pass")}>
            {anyFail
              ? "Some checks failed — calls may not connect on this network. See details above."
              : "All set — you're ready for calls and meetings. 🎉"}
          </div>
        ) : null}
        <div className="cc-actions">
          <button className="btn-p" onClick={run} disabled={running}>
            {running ? "Running…" : done ? "Run again" : "Run check"}
          </button>
        </div>
      </div>
    </div>
  );
}
