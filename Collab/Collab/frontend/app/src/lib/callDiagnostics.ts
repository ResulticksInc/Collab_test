// WebRTC call/meeting diagnostics — an ADDITIVE observability layer.
//
// It does NOT change signaling, token generation, or the LiveKit connect flow.
// It only (a) listens to existing RoomEvents, (b) reads the peer connection's
// getStats(), and (c) logs a structured, grep-able lifecycle trail so that when
// a call fails we can see WHERE it failed (ICE / TURN / no relay candidate)
// instead of a blind "media server error".
//
// Used by both the 1:1/group call path (CoLabV1) and meetings (MeetingStage),
// and surfaced live via <CallDebugPanel/> in dev/staging.

import { log as appLog } from "./logger";

export type DiagEvent = {
  t: number;
  iso: string;
  event: string;
  data?: Record<string, any>;
};

export type DiagSnapshot = {
  label: string;
  signalState: string;
  connectionState: string;
  iceState: string;
  selectedLocalType: string; // host | srflx | prflx | relay | ""
  selectedRemoteType: string;
  selectedProtocol: string; // udp | tcp | ""
  turnUsed: boolean; // the SELECTED candidate pair is a TURN relay
  turnAdvertised: boolean; // the token returned a turn:/turns: server at all
  rttMs: number | null;
  packetLossPct: number | null;
  outKbps: number | null;
  inKbps: number | null;
  updatedAt: number;
  events: DiagEvent[];
};

type Listener = (s: DiagSnapshot) => void;

export interface CallDiagnostics {
  log(event: string, data?: Record<string, any>): void;
  attach(room: any, LK: any): void;
  snapshot(): DiagSnapshot;
  subscribe(cb: Listener): () => void;
  /** A plain-text dump of the snapshot + event trail, for IT to paste. */
  copyText(): string;
  stop(): void;
}

const MAX_EVENTS = 250;

// ── Session-replay stash ─────────────────────────────────────────────────────
// The most recent session's full diagnostics report, captured when the session's
// diagnostics stop() (call/meeting teardown). The post-call feedback dialog
// offers to attach it ("Session Replay Lite") — support sees the connection
// timeline without asking the user to reproduce. Module-level on purpose: the
// diagnostics object dies with the call surface, but feedback opens after.
let lastReport: { text: string; at: number } | null = null;
/** The last ended session's diagnostics report, or null if too stale. */
export function getLastCallReport(maxAgeMs = 15 * 60 * 1000) {
  if (!lastReport || Date.now() - lastReport.at > maxAgeMs) return null;
  return lastReport;
}

/** Did the backend advertise a usable TURN relay in the ICE server list? */
export function turnAdvertisedIn(iceServers: any[]): boolean {
  if (!Array.isArray(iceServers)) return false;
  return iceServers.some((s) => {
    const urls = s && (Array.isArray(s.urls) ? s.urls : [s.urls]);
    return (urls || []).some(
      (u: string) => typeof u === "string" && /^turns?:/i.test(u),
    );
  });
}

/** Panel visibility: dev always; staging/prod opt-in via flag (no rebuild). */
export function isCallDebugEnabled(): boolean {
  try {
    if (
      typeof process !== "undefined" &&
      process.env &&
      process.env.NODE_ENV !== "production"
    )
      return true;
    if (typeof window === "undefined") return false;
    if (
      window.localStorage &&
      window.localStorage.getItem("colab_call_debug") === "1"
    )
      return true;
    if (/[?&]calldebug=1/.test(window.location.search)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function createCallDiagnostics(
  label: string,
  opts?: { turnAdvertised?: boolean; pollMs?: number },
): CallDiagnostics {
  const snap: DiagSnapshot = {
    label,
    signalState: "—",
    connectionState: "—",
    iceState: "—",
    selectedLocalType: "",
    selectedRemoteType: "",
    selectedProtocol: "",
    turnUsed: false,
    turnAdvertised: !!(opts && opts.turnAdvertised),
    rttMs: null,
    packetLossPct: null,
    outKbps: null,
    inKbps: null,
    updatedAt: Date.now(),
    events: [],
  };
  const listeners = new Set<Listener>();
  let pollTimer: any = null;
  let stopped = false;
  let lastIce = "";
  let everRelay = false;
  let lastBytes: { out: number; in: number; ts: number } = {
    out: 0,
    in: 0,
    ts: 0,
  };

  const emit = () => {
    snap.updatedAt = Date.now();
    listeners.forEach((l) => {
      try {
        l(snap);
      } catch {
        /* ignore */
      }
    });
  };

  const log = (event: string, data?: Record<string, any>) => {
    const e: DiagEvent = {
      t: Date.now(),
      iso: new Date().toISOString(),
      event,
      data,
    };
    snap.events.push(e);
    if (snap.events.length > MAX_EVENTS) snap.events.shift();
    // Bridge the HEADLINE call/media events into the unified diagnostics log so
    // the app-level panel reflects call health (the deep WebRTC trail stays here).
    if (event === "ICE Connected" || event === "Room Joined")
      appLog.success(
        "media",
        data && data.turnUsed
          ? "Call media connected (via TURN relay)"
          : "Call media connected",
      );
    else if (event === "ICE Failed" || event === "Media Error")
      appLog.error("media", `Call media problem: ${event}`, {
        hint:
          (data && data.hint) ||
          (event === "Media Error"
            ? "Camera/mic issue — check permissions and that no other app is using the device."
            : "Could not establish the media path."),
      });
    else if (event === "Room Disconnected")
      appLog.warn("call", "Call disconnected", {
        hint: "The call dropped — reconnecting automatically.",
      });
    const kv = data
      ? " " +
        Object.entries(data)
          .map(
            ([k, v]) =>
              `${k}=${v && typeof v === "object" ? JSON.stringify(v) : v}`,
          )
          .join(" ")
      : "";
    // Single grep-able line per lifecycle event. Filter the console with "CALLDIAG".
    // eslint-disable-next-line no-console
    console.warn(`[CALLDIAG ${label}] ${event}${kv}`);
    emit();
  };

  // Defensive peer-connection lookup across livekit-client internal shapes.
  const findPC = (room: any): RTCPeerConnection | null => {
    const eng = room && room.engine;
    if (!eng) return null;
    const pm = eng.pcManager || eng;
    const transports = [
      pm.subscriber,
      pm.publisher,
      eng.subscriber,
      eng.publisher,
    ];
    for (const tr of transports) {
      if (!tr) continue;
      const pc = tr.pc || tr._pc || tr;
      if (pc && typeof pc.getStats === "function")
        return pc as RTCPeerConnection;
    }
    return null;
  };

  const readStats = async (pc: RTCPeerConnection) => {
    const report: any = await pc.getStats();
    let pair: any = null;
    let transportSel: string | null = null;
    report.forEach((s: any) => {
      if (
        s.type === "candidate-pair" &&
        s.state === "succeeded" &&
        (s.nominated || s.selected)
      )
        pair = s;
      if (s.type === "transport" && s.selectedCandidatePairId)
        transportSel = s.selectedCandidatePairId;
    });
    if (!pair && transportSel) pair = report.get(transportSel) || null;
    if (!pair)
      report.forEach((s: any) => {
        if (!pair && s.type === "candidate-pair" && s.state === "succeeded")
          pair = s;
      });

    if (pair) {
      const local = report.get(pair.localCandidateId);
      const remote = report.get(pair.remoteCandidateId);
      if (local) {
        snap.selectedLocalType = local.candidateType || "";
        snap.selectedProtocol = local.protocol || "";
      }
      if (remote) snap.selectedRemoteType = remote.candidateType || "";
      snap.turnUsed =
        (local && local.candidateType === "relay") ||
        (remote && remote.candidateType === "relay") ||
        false;
      if (snap.turnUsed) everRelay = true;
      if (typeof pair.currentRoundTripTime === "number")
        snap.rttMs = Math.round(pair.currentRoundTripTime * 1000);
      const ts = pair.timestamp || Date.now();
      if (lastBytes.ts) {
        const dt = (ts - lastBytes.ts) / 1000;
        if (dt > 0) {
          snap.outKbps = Math.max(
            0,
            Math.round(((pair.bytesSent - lastBytes.out) * 8) / dt / 1000),
          );
          snap.inKbps = Math.max(
            0,
            Math.round(((pair.bytesReceived - lastBytes.in) * 8) / dt / 1000),
          );
        }
      }
      lastBytes = { out: pair.bytesSent || 0, in: pair.bytesReceived || 0, ts };
    }

    let lost = 0;
    let recv = 0;
    report.forEach((s: any) => {
      if (s.type === "inbound-rtp" && s.kind === "video") {
        lost += s.packetsLost || 0;
        recv += s.packetsReceived || 0;
      }
    });
    if (recv + lost > 0)
      snap.packetLossPct = Math.round((lost / (lost + recv)) * 1000) / 10;
  };

  const pollOnce = async (room: any) => {
    if (stopped) return;
    const pc = findPC(room);
    if (!pc) return;
    const ice = (pc as any).iceConnectionState || "";
    if (ice && ice !== lastIce) {
      if (ice === "connected" || ice === "completed")
        log("ICE Connected", {
          iceState: ice,
          turnUsed: snap.turnUsed,
          localType: snap.selectedLocalType,
        });
      else if (ice === "failed")
        log("ICE Failed", {
          iceState: ice,
          relaySeen: everRelay,
          turnAdvertised: snap.turnAdvertised,
          hint: everRelay
            ? "relay path failed — TURN reachable but media still blocked"
            : snap.turnAdvertised
              ? "no relay candidate succeeded — TURN advertised but not reachable (check 3478/5349/443)"
              : "no relay candidate — NO TURN advertised by token (cross-network calls will fail)",
        });
      else if (ice === "disconnected")
        log("ICE Disconnected", { iceState: ice });
      else if (ice === "checking") log("ICE Checking", { iceState: ice });
      lastIce = ice;
    }
    snap.iceState = ice;
    snap.connectionState = (pc as any).connectionState || snap.connectionState;
    try {
      await readStats(pc);
    } catch {
      /* getStats can throw mid-renegotiation; ignore */
    }
    emit();
  };

  const reasonName = (LK: any, r: any) =>
    (LK && LK.DisconnectReason && LK.DisconnectReason[r]) ||
    (r == null ? "—" : String(r));

  const attach = (room: any, LK: any) => {
    if (!room || !LK) return;
    const RE = LK.RoomEvent || {};
    const on = (ev: string, fn: any) => {
      if (ev)
        try {
          room.on(ev, fn);
        } catch {
          /* ignore */
        }
    };
    on(RE.SignalConnected, () => {
      snap.signalState = "connected";
      log("Signal Connected");
    });
    on(RE.ConnectionStateChanged, (s: any) => {
      snap.connectionState = String(s);
      log("Connection State", { state: String(s) });
    });
    on(RE.Reconnecting, () => log("Reconnecting"));
    on(RE.Reconnected, () => log("Reconnected"));
    on(RE.Disconnected, (r: any) =>
      log("Room Disconnected", { reason: reasonName(LK, r) }),
    );
    on(RE.LocalTrackPublished, (pub: any) =>
      log("Track Published", {
        kind: pub && pub.kind,
        source: pub && pub.source,
        who: "local",
      }),
    );
    on(RE.TrackPublished, (pub: any, p: any) =>
      log("Track Published", {
        kind: pub && pub.kind,
        source: pub && pub.source,
        who: p && p.identity,
      }),
    );
    on(RE.TrackSubscribed, (t: any, _pub: any, p: any) =>
      log("Track Subscribed", { kind: t && t.kind, who: p && p.identity }),
    );
    on(RE.ParticipantConnected, (p: any) =>
      log("Participant Connected", { who: p && p.identity }),
    );
    on(RE.ParticipantDisconnected, (p: any) =>
      log("Participant Disconnected", { who: p && p.identity }),
    );
    on(RE.MediaDevicesError, (e: any) =>
      log("Media Error", { err: (e && e.message) || String(e) }),
    );

    // attach() runs only AFTER room.connect() resolves, so the signalling socket
    // is already up — the live SignalConnected event fired before we attached and
    // we'd otherwise miss it (panel stuck showing signal="—"). Seed it from the
    // room's current state, and let the listeners above update it on reconnect.
    snap.signalState = "connected";
    try {
      if (room.state) snap.connectionState = String(room.state);
    } catch {
      /* ignore */
    }
    emit();

    const pollMs = (opts && opts.pollMs) || 1500;
    pollTimer = setInterval(() => pollOnce(room), pollMs);
    pollOnce(room);
  };

  const subscribe = (cb: Listener) => {
    listeners.add(cb);
    try {
      cb(snap);
    } catch {
      /* ignore */
    }
    return () => listeners.delete(cb);
  };

  const copyText = () => {
    const head =
      `Collab call diagnostics — ${snap.label}\n` +
      `signal=${snap.signalState} conn=${snap.connectionState} ice=${snap.iceState}\n` +
      `path: local=${snap.selectedLocalType || "?"}/${snap.selectedProtocol || "?"} remote=${snap.selectedRemoteType || "?"} ` +
      `turnUsed=${snap.turnUsed} turnAdvertised=${snap.turnAdvertised}\n` +
      `rtt=${snap.rttMs ?? "?"}ms loss=${snap.packetLossPct ?? "?"}% in=${snap.inKbps ?? "?"}kbps out=${snap.outKbps ?? "?"}kbps\n` +
      `------ events ------\n`;
    const body = snap.events
      .map(
        (e) =>
          `${e.iso}  ${e.event}${e.data ? "  " + JSON.stringify(e.data) : ""}`,
      )
      .join("\n");
    return head + body;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    // Stash the final report for the post-call feedback dialog (see
    // getLastCallReport). Best-effort — never let it break teardown.
    try {
      lastReport = { text: copyText(), at: Date.now() };
    } catch {
      /* ignore */
    }
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    listeners.clear();
  };

  return { log, attach, snapshot: () => snap, subscribe, copyText, stop };
}
