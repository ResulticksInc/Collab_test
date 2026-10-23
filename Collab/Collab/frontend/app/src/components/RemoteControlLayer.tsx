// Remote Control — UI + input capture layer. Mounted by both CallModal
// (CoLabV1) and MeetingStage; works for 1:1/group/meeting identically.
// See docs/REMOTE_CONTROL_ARCHITECTURE.md §5.
//
// - Controller side: a transparent capture overlay sits over the remote screen-
//   share video, normalizes mouse/key events (0..1) and sends them.
// - Controlled side: a colored border + "X is controlling your computer" badge;
//   OS input is injected by the Electron main process (the real cursor moves).
// - Both: a toolbar with status / latency / Stop. A request prompt (Allow/Deny).

import { useEffect, useRef } from "react";
import { useRemoteControl, RCInput } from "../lib/remoteControl";

export interface RemoteControlLayerProps {
  room: any | null;
  localSid: string | null;
  localName: string;
  /** Are WE currently sharing a screen (eligible to be controlled). */
  isSharingScreen: boolean;
  /** The remote participant presenting a screen we could request control of. */
  remoteSharer: { sid: string; name: string } | null;
  /** On-screen rect of the remote share <video> (for coord mapping + overlay). */
  getShareRect: () => DOMRect | null;
  /** window.collabDesktop present → this client can be controlled. */
  isDesktop: boolean;
  /** audit hook */
  onLog?: (action: string, peerSid: string | null) => void;
}

function mods(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }) {
  return { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

export default function RemoteControlLayer(props: RemoteControlLayerProps) {
  const {
    room,
    localSid,
    localName,
    isSharingScreen,
    remoteSharer,
    getShareRect,
    isDesktop,
    onLog,
  } = props;

  const rc = useRemoteControl({
    room,
    localSid,
    localName,
    canBeControlled: isDesktop,
    isSharingScreen,
    onLog,
  });
  const { state, controllableSids } = rc;
  const controlling = state.phase === "controlling";
  // Live Collaboration needs the SHARER (controlled side) on the desktop app —
  // a browser can't have OS input injected. Only offer it for a sharer that
  // advertised controllability; hide it entirely in an all-web room.
  const canControlSharer = !!remoteSharer && controllableSids.has(remoteSharer.sid);

  // When a new sharer appears, nudge them to (re)announce controllability — heals
  // a missed advertisement or a set cleared by a remount. Once per sharer sid; a
  // web sharer never replies, so the button stays hidden.
  const sharerSid = remoteSharer ? remoteSharer.sid : null;
  useEffect(() => {
    if (sharerSid) rc.probeAvailability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharerSid]);

  // ── Controller: capture mouse/keyboard while controlling ──────────────────
  const overlayRef = useRef<HTMLDivElement | null>(null);

  // Normalize a client point against the share video rect (null if outside).
  const norm = (cx: number, cy: number): { x: number; y: number } | null => {
    const r = getShareRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    const x = (cx - r.left) / r.width;
    const y = (cy - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  useEffect(() => {
    if (!controlling) return;
    const el = overlayRef.current;
    if (!el) return;

    const send = (ev: RCInput) => rc.sendInput(ev);

    const onMove = (e: PointerEvent) => {
      const p = norm(e.clientX, e.clientY);
      if (!p) return;
      rc.sendCursor(p.x, p.y);
      send({ k: "move", x: p.x, y: p.y });
    };
    const btn = (b: number): RCInput["button"] =>
      b === 2 ? "right" : b === 1 ? "middle" : "left";
    const onDown = (e: PointerEvent) => {
      const p = norm(e.clientX, e.clientY);
      if (!p) return;
      send({ k: "down", x: p.x, y: p.y, button: btn(e.button) });
    };
    const onUp = (e: PointerEvent) => {
      const p = norm(e.clientX, e.clientY);
      if (!p) return;
      send({ k: "up", x: p.x, y: p.y, button: btn(e.button) });
    };
    const onDbl = (e: MouseEvent) => {
      const p = norm(e.clientX, e.clientY);
      if (!p) return;
      send({ k: "dblclick", x: p.x, y: p.y, button: btn(e.button) });
    };
    const onCtx = (e: MouseEvent) => e.preventDefault(); // right-click → remote
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      send({ k: "wheel", dx: e.deltaX, dy: e.deltaY });
    };
    // Keyboard is captured at the window while controlling so shortcuts/F-keys
    // reach the remote. We swallow them locally so they don't act on our app.
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      // Let the user escape control with Escape held with no remote intent? No —
      // Escape is forwarded; Stop is via the toolbar button. Only intercept here.
      send({
        k: "key",
        key: e.key,
        code: e.code,
        down,
        mods: mods(e),
      });
      e.preventDefault();
      e.stopPropagation();
    };
    const kd = onKey(true);
    const ku = onKey(false);

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("dblclick", onDbl);
    el.addEventListener("contextmenu", onCtx);
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", kd, true);
    window.addEventListener("keyup", ku, true);
    // Best-effort: lock keyboard so the browser passes through reserved keys.
    try {
      (navigator as any).keyboard?.lock?.();
    } catch {
      /* ignore */
    }
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("dblclick", onDbl);
      el.removeEventListener("contextmenu", onCtx);
      el.removeEventListener("wheel", onWheel as any);
      window.removeEventListener("keydown", kd, true);
      window.removeEventListener("keyup", ku, true);
      try {
        (navigator as any).keyboard?.unlock?.();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlling]);

  // Position the capture overlay over the share video (rAF, layout can shift).
  useEffect(() => {
    if (!controlling) return;
    let raf = 0;
    const tick = () => {
      const el = overlayRef.current;
      const r = getShareRect();
      if (el && r) {
        el.style.left = r.left + "px";
        el.style.top = r.top + "px";
        el.style.width = r.width + "px";
        el.style.height = r.height + "px";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlling]);

  const lat =
    state.latencyMs != null ? `${Math.round(state.latencyMs)} ms` : "—";

  return (
    <>
      {/* Floating "Request control" — idle + a remote is presenting a screen we
          can actually control (their side is the desktop app). */}
      {state.phase === "idle" && remoteSharer && canControlSharer ? (
        <button
          type="button"
          className="rc-request-btn"
          onClick={() => rc.requestControl(remoteSharer.sid, remoteSharer.name)}
          title={`Start a Live Collaboration session on ${remoteSharer.name}'s screen`}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3l7 17 2-7 7-2z" />
          </svg>
          Start Live Collaboration
        </button>
      ) : null}

      {/* Controller is waiting for approval. */}
      {state.phase === "requesting" ? (
        <div className="rc-toolbar rc-pending">
          <span className="rc-dot rc-amber" />
          {state.queued
            ? `In queue — waiting for ${state.peerName}…`
            : `Waiting for ${state.peerName} to start collaborating…`}
          <button className="rc-btn rc-ghost" onClick={rc.stop}>
            Cancel
          </button>
        </div>
      ) : null}

      {/* Controller: transient notice — e.g. the peer is on the web and can't be
          controlled (they need the desktop app), instead of a silent denial. */}
      {state.notice ? (
        <div className="rc-toolbar rc-notice">
          <span className="rc-dot rc-amber" />
          <span className="rc-notice-text">{state.notice}</span>
          <button className="rc-btn rc-ghost" onClick={rc.dismissNotice}>
            Got it
          </button>
        </div>
      ) : null}

      {/* Controlled side: an incoming request → Allow / Deny. */}
      {state.phase === "prompted" ? (
        <div className="rc-prompt-scrim">
          <div className="rc-prompt">
            <div className="rc-prompt-title">Start Live Collaboration?</div>
            <div className="rc-prompt-sub">
              <b>{state.peerName}</b> wants to collaborate live on your screen —
              they&apos;ll be able to move your pointer and type with you. You stay
              in control and can end it at any time.
            </div>
            <div className="rc-prompt-actions">
              <button className="rc-btn rc-ghost" onClick={rc.deny}>
                Deny
              </button>
              <button className="rc-btn rc-primary" onClick={rc.allow}>
                Allow
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Controller: transparent capture surface over the shared video. */}
      {controlling ? (
        <div ref={overlayRef} className="rc-capture" tabIndex={0} />
      ) : null}

      {/* Active-session toolbar (both roles). */}
      {controlling || state.phase === "being-controlled" ? (
        <div
          className={
            "rc-toolbar " +
            (controlling ? "rc-controlling" : "rc-being-controlled")
          }
        >
          <span className="rc-dot rc-green" />
          {controlling ? (
            <>Live Collaboration · controlling {state.peerName}&apos;s screen</>
          ) : (
            <>{state.peerName} is collaborating on your screen</>
          )}
          {controlling ? (
            <span className="rc-metric" title="Round-trip latency">
              {lat}
            </span>
          ) : null}
          {!controlling && state.queueLen > 0 ? (
            <span className="rc-metric" title="Controllers waiting">
              {state.queueLen} waiting
            </span>
          ) : null}
          <button
            className="rc-btn rc-stop"
            onClick={controlling ? rc.stop : rc.revoke}
            title={
              !controlling && state.queueLen > 0
                ? "End and hand control to the next person waiting"
                : undefined
            }
          >
            {controlling
              ? "End session"
              : state.queueLen > 0
                ? "Next"
                : "Take back control"}
          </button>
        </div>
      ) : null}

      {/* Host: out-of-order queue — grant control to a specific waiting person. */}
      {state.phase === "being-controlled" && state.queue.length > 0 ? (
        <div className="rc-queue">
          <div className="rc-queue-title">
            Waiting to control ({state.queue.length})
          </div>
          {state.queue.map((q) => (
            <div key={q.sid} className="rc-queue-row">
              <span className="rc-queue-name">{q.name}</span>
              <button
                className="rc-btn rc-primary"
                onClick={() => rc.grantTo(q.sid)}
              >
                Grant
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Colored privacy border while a session is live. */}
      {controlling || state.phase === "being-controlled" ? (
        <div
          className={
            "rc-border " + (controlling ? "rc-border-out" : "rc-border-in")
          }
          aria-hidden="true"
        />
      ) : null}

      {/* Controlled side: labeled remote cursor (the controller's pointer). */}
      {state.phase === "being-controlled" && rc.remoteCursor ? (
        <RemoteCursor cursor={rc.remoteCursor} />
      ) : null}
    </>
  );
}

function RemoteCursor({
  cursor,
}: {
  cursor: { x: number; y: number; name: string };
}) {
  // Position relative to the viewport (the controlled user sees their own
  // screen; this labels where the controller is pointing). Interpolated for
  // smoothness in the lib's throttle, rendered here.
  const left = cursor.x * window.innerWidth;
  const top = cursor.y * window.innerHeight;
  return (
    <div className="rc-cursor" style={{ left, top }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path
          d="M5 3l14 7-6 1.5L11 19z"
          fill="#fff"
          stroke="#111"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <span className="rc-cursor-name">{cursor.name}</span>
    </div>
  );
}
