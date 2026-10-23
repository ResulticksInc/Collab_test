// Remote Control — protocol + state machine over the existing LiveKit
// DataChannel. Transport-agnostic, reused by 1:1/group calls (CoLabV1) and
// meetings (MeetingStage). See docs/REMOTE_CONTROL_ARCHITECTURE.md.
//
// HARD CONSTRAINT: a browser cannot inject OS input — only the Electron desktop
// app (window.collabDesktop.remoteInput) can be CONTROLLED. A browser user is
// always a valid CONTROLLER; it just can't be controlled. We degrade gracefully.
//
// Wire format: every message is JSON `{ t:"rc", a, from, to, ... }` published
// with publishData. We filter on `to === localSid` so it's effectively targeted
// without depending on identity↔sid mapping. The existing reaction/raise-hand
// DataReceived handler ignores `t==="rc"`, and we ignore everything else — no
// collision.

import { useCallback, useEffect, useRef, useState } from "react";

export type RCPhase =
  | "idle"
  | "requesting" // controller: request sent, awaiting allow/deny
  | "prompted" // controlled: a request arrived, user deciding
  | "controlling" // controller: session live
  | "being-controlled"; // controlled: session live

export type RCButton = "left" | "right" | "middle";

export interface RCInput {
  k: "move" | "down" | "up" | "click" | "dblclick" | "wheel" | "key";
  x?: number; // normalized 0..1 over the shared surface
  y?: number;
  button?: RCButton;
  dx?: number; // wheel deltas (pixels)
  dy?: number;
  key?: string; // KeyboardEvent.key
  code?: string; // KeyboardEvent.code
  down?: boolean; // key down (true) / up (false)
  mods?: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };
}

export interface RCState {
  phase: RCPhase;
  peerSid: string | null;
  peerName: string | null;
  latencyMs: number | null;
  /** controlled side: number of controllers waiting in the queue */
  queueLen: number;
  /** controlled side: the waiting controllers (for out-of-order grant) */
  queue: { sid: string; name: string }[];
  /** controller side: our request is queued behind an active session */
  queued: boolean;
  /** controller side: a transient human-readable notice (e.g. the peer is on the
   *  web and can't be controlled). Cleared on a new request or manual dismiss. */
  notice: string | null;
}

interface RCMsg {
  t: "rc";
  a:
    | "req"
    | "allow"
    | "deny"
    | "stop" // controller ends
    | "revoke" // controlled ends / takes back
    | "input"
    | "cursor"
    | "ping"
    | "pong"
    | "queued"
    | "avail" // controlled-capable (desktop) side advertises it can be controlled
    | "probe"; // controller asks "who can be controlled?" → controllables reply avail
  from: string;
  to: string;
  name?: string;
  sess?: string; // session id minted by the controlled side on allow
  ev?: RCInput;
  x?: number;
  y?: number;
  ts?: number;
  reason?: string; // deny reason (e.g. "no-desktop")
}

const REQUEST_TIMEOUT_MS = 30000;

export interface UseRemoteControlOpts {
  room: any | null; // LiveKit Room
  localSid: string | null;
  localName: string;
  // window.collabDesktop present → this client CAN be controlled (inject input).
  canBeControlled: boolean;
  // True while THIS client is actively sharing a screen. If it drops mid-session
  // while we're being controlled, the session auto-revokes (security).
  isSharingScreen: boolean;
  onLog?: (action: string, peerSid: string | null) => void;
}

export interface RemoteControlApi {
  state: RCState;
  /** controller → ask a sharer for control */
  requestControl: (peerSid: string, peerName: string) => void;
  /** controlled → approve the pending request */
  allow: () => void;
  /** controlled → reject the pending request */
  deny: () => void;
  /** controller → end the session */
  stop: () => void;
  /** controller → dismiss the transient "can't be controlled" notice */
  dismissNotice: () => void;
  /** controlled → revoke / take back control */
  revoke: () => void;
  /** controlled → grant control to a SPECIFIC queued controller (out of order) */
  grantTo: (sid: string) => void;
  /** controller → forward an input event to the controlled machine */
  sendInput: (ev: RCInput) => void;
  /** controller → publish cursor position (throttled, unreliable) */
  sendCursor: (x: number, y: number) => void;
  /** controlled side: the controller's live cursor over the shared surface */
  remoteCursor: { x: number; y: number; name: string } | null;
  /** controller side: sids of peers that advertised they CAN be controlled
   *  (running the desktop app). "Start Live Collaboration" is offered only for a
   *  sharer in this set — a web sharer can't inject OS input, so an all-web room
   *  never enables the feature. */
  controllableSids: Set<string>;
  /** controller → ask sharers to (re)announce controllability (recovery). */
  probeAvailability: () => void;
}

function decode(payload: Uint8Array): RCMsg | null {
  try {
    const m = JSON.parse(new TextDecoder().decode(payload));
    return m && m.t === "rc" ? (m as RCMsg) : null;
  } catch {
    return null;
  }
}

export function useRemoteControl(opts: UseRemoteControlOpts): RemoteControlApi {
  const { room, localSid, localName, canBeControlled, isSharingScreen, onLog } =
    opts;

  const [state, setState] = useState<RCState>({
    phase: "idle",
    peerSid: null,
    peerName: null,
    latencyMs: null,
    queueLen: 0,
    queue: [],
    queued: false,
    notice: null,
  });
  const [remoteCursor, setRemoteCursor] = useState<{
    x: number;
    y: number;
    name: string;
  } | null>(null);
  // Controller side: peers that advertised they can be controlled (desktop app).
  const [controllableSids, setControllableSids] = useState<Set<string>>(
    () => new Set(),
  );

  // Refs mirror state for use inside the stable DataReceived closure.
  const phaseRef = useRef<RCPhase>("idle");
  const peerRef = useRef<string | null>(null);
  const sessRef = useRef<string | null>(null);
  // Controlled side: FIFO queue of controllers who requested while busy.
  const queueRef = useRef<{ sid: string; name: string }[]>([]);
  const reqTimer = useRef<any>(null);
  const pingTimer = useRef<any>(null);
  const lastPingAt = useRef<number>(0);
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;

  const apply = useCallback(
    (next: Partial<RCState> & { phase: RCPhase }) => {
      phaseRef.current = next.phase;
      if (next.peerSid !== undefined) peerRef.current = next.peerSid as any;
      setState((s) => ({ ...s, ...next }));
    },
    [],
  );

  const publish = useCallback(
    (m: Omit<RCMsg, "t" | "from">) => {
      try {
        const r = room;
        if (!r || !r.localParticipant || !localSid) return;
        const full: RCMsg = { t: "rc", from: localSid, ...m } as RCMsg;
        r.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify(full)),
          // input + cursor are high-rate; cursor tolerates loss (lossy),
          // everything else must arrive (reliable).
          { reliable: m.a !== "cursor" },
        );
      } catch {
        /* ignore */
      }
    },
    [room, localSid],
  );

  const reset = useCallback(
    (reason: string, notifyPeer?: "stop" | "revoke") => {
      if (reqTimer.current) clearTimeout(reqTimer.current);
      if (pingTimer.current) clearInterval(pingTimer.current);
      reqTimer.current = null;
      pingTimer.current = null;
      const peer = peerRef.current;
      if (notifyPeer && peer)
        publish({ a: notifyPeer, to: peer, sess: sessRef.current || undefined });
      if (phaseRef.current !== "idle" && peer)
        onLogRef.current?.(reason, peer);
      sessRef.current = null;
      try {
        (window as any).collabDesktop?.remoteArm?.(false);
      } catch {
        /* ignore */
      }
      setRemoteCursor(null);
      apply({
        phase: "idle",
        peerSid: null,
        peerName: null,
        latencyMs: null,
        queued: false,
      });
    },
    [apply, publish],
  );

  // ── Controller actions ──────────────────────────────────────────────────
  const requestControl = useCallback(
    (peerSid: string, peerName: string) => {
      if (phaseRef.current !== "idle") return;
      peerRef.current = peerSid;
      apply({ phase: "requesting", peerSid, peerName, queued: false, notice: null });
      onLogRef.current?.("request", peerSid);
      publish({ a: "req", to: peerSid, name: localName });
      if (reqTimer.current) clearTimeout(reqTimer.current);
      reqTimer.current = setTimeout(() => {
        if (phaseRef.current === "requesting") reset("request-timeout");
      }, REQUEST_TIMEOUT_MS);
    },
    [apply, publish, localName],
  );

  const stop = useCallback(() => reset("stop", "stop"), [reset]);

  const dismissNotice = useCallback(
    () => setState((s) => ({ ...s, notice: null })),
    [],
  );

  const sendInput = useCallback(
    (ev: RCInput) => {
      if (phaseRef.current !== "controlling" || !peerRef.current) return;
      publish({
        a: "input",
        to: peerRef.current,
        sess: sessRef.current || undefined,
        ev,
      });
    },
    [publish],
  );

  const cursorThrottle = useRef(0);
  const sendCursor = useCallback(
    (x: number, y: number) => {
      if (phaseRef.current !== "controlling" || !peerRef.current) return;
      const now = Date.now();
      if (now - cursorThrottle.current < 16) return; // ~60Hz cap
      cursorThrottle.current = now;
      publish({ a: "cursor", to: peerRef.current, x, y });
    },
    [publish],
  );

  // ── Controlled actions ──────────────────────────────────────────────────
  const allow = useCallback(() => {
    if (phaseRef.current !== "prompted" || !peerRef.current) return;
    const sess =
      Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    sessRef.current = sess;
    apply({ phase: "being-controlled" });
    try {
      (window as any).collabDesktop?.remoteArm?.(true);
    } catch {
      /* ignore */
    }
    onLogRef.current?.("grant", peerRef.current);
    publish({ a: "allow", to: peerRef.current, sess });
  }, [apply, publish]);

  const deny = useCallback(() => {
    if (phaseRef.current !== "prompted" || !peerRef.current) return;
    onLogRef.current?.("deny", peerRef.current);
    publish({ a: "deny", to: peerRef.current });
    apply({ phase: "idle", peerSid: null, peerName: null });
    peerRef.current = null;
  }, [apply, publish]);

  const revoke = useCallback(() => reset("revoke", "revoke"), [reset]);

  // Out-of-order: hand control to a SPECIFIC queued controller — move them to
  // the front, then end the current session so the auto-prompt serves them next.
  const grantTo = useCallback(
    (sid: string) => {
      const i = queueRef.current.findIndex((q) => q.sid === sid);
      if (i < 0) return;
      const [pick] = queueRef.current.splice(i, 1);
      queueRef.current.unshift(pick);
      setState((s) => ({
        ...s,
        queue: [...queueRef.current],
        queueLen: queueRef.current.length,
      }));
      if (phaseRef.current === "being-controlled") revoke();
    },
    [revoke],
  );

  // ── Inbound message handling ────────────────────────────────────────────
  useEffect(() => {
    if (!room || !localSid) return;
    const RoomEventModule = (room.constructor && room) as any;
    const onData = (payload: Uint8Array, participant: any) => {
      const m = decode(payload);
      // Only the discovery messages (avail / probe) may be broadcast (to:"*");
      // every control action stays targeted at us by sid, so a stray broadcast
      // req/ping/etc. can't fan out to every peer.
      if (
        !m ||
        (m.to !== localSid &&
          !(m.to === "*" && (m.a === "avail" || m.a === "probe")))
      )
        return;
      const fromSid = (participant && participant.sid) || m.from;

      switch (m.a) {
        case "avail": {
          // A peer announced it CAN be controlled (running the desktop app).
          // Remember it so the controller offers "Start Live Collaboration" only
          // for a controllable sharer. (LiveKit never loops our own data back.)
          if (fromSid === localSid) break;
          setControllableSids((prev) => {
            if (prev.has(fromSid)) return prev;
            const next = new Set(prev);
            next.add(fromSid);
            return next;
          });
          break;
        }
        case "probe": {
          // A controller is asking who can be controlled. If we're the desktop
          // app, (re)announce — this heals a controller that lost its set (e.g.
          // its layer remounted on a PiP toggle) or missed our mount broadcast.
          if (canBeControlled && fromSid !== localSid)
            publish({ a: "avail", to: "*" });
          break;
        }
        case "req": {
          // Someone wants to control THIS machine. Only the desktop app can be
          // controlled; a browser auto-denies (graceful degradation).
          if (!canBeControlled) {
            // A browser can't inject OS input. Tell the controller WHY (so it can
            // show "they need the desktop app") instead of a silent denial.
            publish({ a: "deny", to: fromSid, reason: "no-desktop" });
            return;
          }
          if (phaseRef.current === "idle") {
            peerRef.current = fromSid;
            apply({
              phase: "prompted",
              peerSid: fromSid,
              peerName: m.name || "Someone",
            });
          } else if (
            fromSid !== peerRef.current &&
            !queueRef.current.some((q) => q.sid === fromSid)
          ) {
            // Busy (prompting / being controlled) → QUEUE instead of denying so
            // the host can serve them next (FIFO). Tell the requester they're
            // queued so their UI waits instead of timing out.
            queueRef.current.push({ sid: fromSid, name: m.name || "Someone" });
            setState((s) => ({
        ...s,
        queue: [...queueRef.current],
        queueLen: queueRef.current.length,
      }));
            publish({ a: "queued", to: fromSid });
          }
          break;
        }
        case "allow": {
          if (phaseRef.current !== "requesting" || fromSid !== peerRef.current)
            return;
          if (reqTimer.current) clearTimeout(reqTimer.current);
          sessRef.current = m.sess || null;
          onLogRef.current?.("grant", fromSid);
          apply({ phase: "controlling" });
          // start a latency ping while controlling
          if (pingTimer.current) clearInterval(pingTimer.current);
          pingTimer.current = setInterval(() => {
            lastPingAt.current = Date.now();
            publish({ a: "ping", to: fromSid, ts: lastPingAt.current });
          }, 2000);
          break;
        }
        case "deny": {
          if (phaseRef.current === "requesting" && fromSid === peerRef.current) {
            const noDesktop = m.reason === "no-desktop";
            reset("denied");
            if (noDesktop)
              setState((s) => ({
                ...s,
                notice:
                  "This person is using Collab in a web browser. Giving control of a shared screen needs the Collab desktop app on their side.",
              }));
          }
          break;
        }
        case "stop": {
          // controller ended → we (controlled) return to idle
          if (fromSid === peerRef.current) reset("stopped-by-controller");
          break;
        }
        case "revoke": {
          // controlled ended/took back → we (controller) return to idle
          if (fromSid === peerRef.current) reset("revoked-by-host");
          break;
        }
        case "input": {
          if (
            phaseRef.current !== "being-controlled" ||
            fromSid !== peerRef.current ||
            (m.sess && m.sess !== sessRef.current) ||
            !m.ev
          )
            return;
          // Hand off to the Electron main process for OS injection.
          try {
            const cd: any =
              typeof window !== "undefined"
                ? (window as any).collabDesktop
                : null;
            cd && cd.remoteInput && cd.remoteInput(m.ev);
          } catch {
            /* ignore */
          }
          break;
        }
        case "cursor": {
          if (
            phaseRef.current === "being-controlled" &&
            fromSid === peerRef.current &&
            typeof m.x === "number" &&
            typeof m.y === "number"
          ) {
            setRemoteCursor({ x: m.x, y: m.y, name: state.peerName || "" });
          }
          break;
        }
        case "ping": {
          publish({ a: "pong", to: fromSid, ts: m.ts });
          break;
        }
        case "pong": {
          if (typeof m.ts === "number")
            setState((s) => ({ ...s, latencyMs: Date.now() - m.ts! }));
          break;
        }
        case "queued": {
          // We (controller) are queued behind an active session — stop the
          // request timeout and show "queued" until the host serves us.
          if (phaseRef.current === "requesting" && fromSid === peerRef.current) {
            if (reqTimer.current) clearTimeout(reqTimer.current);
            reqTimer.current = null;
            setState((s) => ({ ...s, queued: true }));
          }
          break;
        }
      }
    };

    // RoomEvent.DataReceived === "dataReceived" string; use it directly so we
    // don't need the enum import (matches CoLabV1's LK usage).
    room.on("dataReceived", onData);
    return () => {
      try {
        room.off("dataReceived", onData);
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, localSid, canBeControlled, publish, apply, reset]);

  // Capability discovery. On mount every client PROBES ("who can be
  // controlled?") — this heals a remount that cleared our set (e.g. a PiP toggle
  // unmounts the layer) or a missed advertisement. A controllable (desktop)
  // client also ADVERTISES on mount and re-announces on each new participant
  // join. A web client never advertises → an all-web room never enables the
  // feature. (Controllables answer probes too — see the "probe" case above.)
  useEffect(() => {
    if (!room || !localSid) return;
    const probe = () => publish({ a: "probe", to: "*" });
    const advertise = () => {
      if (canBeControlled) publish({ a: "avail", to: "*" });
    };
    probe();
    advertise();
    const onJoin = () => advertise();
    try {
      room.on("participantConnected", onJoin);
    } catch {
      /* ignore */
    }
    return () => {
      try {
        room.off("participantConnected", onJoin);
      } catch {
        /* ignore */
      }
    };
  }, [room, localSid, canBeControlled, publish]);

  // Controller: re-probe when a new sharer appears we don't yet know is
  // controllable, so a desktop sharer's button surfaces even if its earlier
  // advertisement was missed. Once per sharer (keyed on sid) → no loop; a web
  // sharer simply never replies, so it stays hidden.
  const probeAvailability = useCallback(() => {
    if (room && localSid) publish({ a: "probe", to: "*" });
  }, [room, localSid, publish]);

  // Controlled side: returning to idle with a non-empty queue prompts the NEXT
  // waiting controller (FIFO). This is also how "transfer to next" works — a
  // revoke/stop drops to idle, which auto-prompts the next in line.
  useEffect(() => {
    if (state.phase !== "idle" || queueRef.current.length === 0) return;
    const next = queueRef.current.shift();
    if (!next) return;
    peerRef.current = next.sid;
    setState((s) => ({ ...s, queueLen: queueRef.current.length }));
    apply({ phase: "prompted", peerSid: next.sid, peerName: next.name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // ── Auto-revoke: network / participant / share lifecycle ─────────────────
  useEffect(() => {
    if (!room) return;
    const onDisc = () => reset("auto:disconnect");
    const onReconnecting = () => reset("auto:reconnecting");
    const onPartLeft = (p: any) => {
      if (!p || !p.sid) return;
      // A departed peer is no longer controllable.
      setControllableSids((prev) => {
        if (!prev.has(p.sid)) return prev;
        const n = new Set(prev);
        n.delete(p.sid);
        return n;
      });
      // Drop a leaver from the queue too, so we never prompt a ghost.
      if (queueRef.current.some((q) => q.sid === p.sid)) {
        queueRef.current = queueRef.current.filter((q) => q.sid !== p.sid);
        setState((s) => ({
        ...s,
        queue: [...queueRef.current],
        queueLen: queueRef.current.length,
      }));
      }
      if (p.sid === peerRef.current) reset("auto:peer-left");
    };
    room.on("disconnected", onDisc);
    room.on("reconnecting", onReconnecting);
    room.on("participantDisconnected", onPartLeft);
    return () => {
      try {
        room.off("disconnected", onDisc);
        room.off("reconnecting", onReconnecting);
        room.off("participantDisconnected", onPartLeft);
      } catch {
        /* ignore */
      }
    };
  }, [room, reset]);

  // Being-controlled but our screen share stopped → revoke (security).
  useEffect(() => {
    if (phaseRef.current === "being-controlled" && !isSharingScreen)
      reset("auto:share-stopped", "revoke");
  }, [isSharingScreen, reset]);

  // Component teardown (call/meeting end, app/window close) → clean stop.
  useEffect(() => {
    return () => {
      if (phaseRef.current !== "idle")
        reset(
          "auto:teardown",
          phaseRef.current === "being-controlled" ? "revoke" : "stop",
        );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    requestControl,
    allow,
    deny,
    stop,
    revoke,
    grantTo,
    sendInput,
    sendCursor,
    dismissNotice,
    remoteCursor,
    controllableSids,
    probeAvailability,
  };
}
