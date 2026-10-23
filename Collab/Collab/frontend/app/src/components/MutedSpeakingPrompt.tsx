import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Teams-style "You're muted" nudge: while the mic is MUTED during a call, watch
// the local mic level and, if the user talks for a sustained moment, surface a
// dismissible prompt to unmute. Fully self-contained — all the audio plumbing
// lives here so the call component stays untouched.
//
// Privacy/UX: it only opens a mic stream when permission is ALREADY granted
// (never triggers a permission prompt — important now that calls join muted),
// and tears the stream + AudioContext down the instant it's no longer active.

export default function MutedSpeakingPrompt({
  active,
  onUnmute,
}: {
  active: boolean; // in a call AND currently muted
  onUnmute: () => void;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!active) {
      setShow(false);
      return;
    }
    let alive = true;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let hideTimer: any = null;

    (async () => {
      try {
        // Don't ever prompt for the mic just to detect speech — only run when
        // access was already granted (i.e. the user has used the mic before).
        const perm = await (navigator as any).permissions
          ?.query?.({ name: "microphone" as PermissionName })
          .catch(() => null);
        if (!perm || perm.state !== "granted") return;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const Ctx =
          (window as any).AudioContext || (window as any).webkitAudioContext;
        ctx = new Ctx();
        const src = ctx!.createMediaStreamSource(stream);
        const analyser = ctx!.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        let level = 0;
        let over = 0; // ms of sustained voice above threshold
        let last = 0;
        let lastSample = 0;
        let lastFire = 0;
        const tick = (now: number) => {
          if (!alive) return;
          if (!last) last = now;
          const dt = Math.min(200, now - last);
          last = now;
          if (typeof document !== "undefined" && document.visibilityState === "hidden") {
            raf = requestAnimationFrame(tick);
            return;
          }
          if (!lastSample || now - lastSample >= 100) {
            lastSample = now;
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (let i = 0; i < data.length; i++) {
              const v = Math.abs(data[i] - 128) / 128;
              if (v > peak) peak = v;
            }
            level = level * 0.8 + peak * 0.2;
            if (level > 0.07) over += dt;
            else over = Math.max(0, over - dt * 2);
            // Sustained ~0.7s of talking, at most once per ~9s.
            if (over > 700 && now - lastFire > 9000) {
              lastFire = now;
              over = 0;
              setShow(true);
              clearTimeout(hideTimer);
              hideTimer = setTimeout(() => alive && setShow(false), 4200);
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch {
        /* mic unavailable → no prompt */
      }
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      clearTimeout(hideTimer);
      try {
        stream && stream.getTracks().forEach((t) => t.stop());
      } catch { }
      try {
        ctx && ctx.close();
      } catch { }
    };
  }, [active]);

  if (!active || !show) return null;

  // Portaled to <body>: the call view's video-stage wrapper sets
  // `contain: layout` (a flicker-perf fix, CallModal.tsx), which — same as a
  // `transform` — makes IT the containing block for any `position:fixed`
  // descendant instead of the real viewport. This toast (and any other truly
  // fixed overlay nested in there) was being positioned relative to THAT
  // box, off by however much its own box falls short of the viewport (here,
  // the dock's own height). Rendering to <body> sidesteps that entirely.
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        // Aligned with the LOCAL tile's own mic-status badge (call.css:
        // .ms-tile/.cv-tile > .ms-tile-mic/.cv-tile-mic — 34px, inset
        // right:14/bottom:14 from the tile, which itself is inset from the
        // viewport by --stage-rail-band on the right and the dock's 96px
        // height + the stage's 10px bottom gap on the bottom). Right edges
        // match (same 14px inset); a 12px gap sits ABOVE the badge instead of
        // this toast's old independent bottom offset, which let the two
        // overlap. 96 (dock) + 10 (stage gap) + 14 (badge inset) + 34 (badge
        // height) + 12 (gap) = 166.
        bottom: 166,
        right: "calc(14px + var(--stage-rail-band, 0px))",
        zIndex: 6001,
        display: "none",
        alignItems: "center",
        gap: 12,
        background: "var(--ink, #1f2430)",
        color: "#fff",
        padding: "10px 12px 10px 16px",
        borderRadius: 12,
        boxShadow: "var(--shm, 0 8px 24px rgba(0,0,0,.35))",
        fontSize: 13,
        fontWeight: 600,
        maxWidth: "calc(100vw - 32px)",

      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m2 2 20 20" />
          <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
          <path d="M5 10v2a7 7 0 0 0 12 5" />
          <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
        Your mic is muted
      </span>
      <button
        type="button"
        onClick={() => {
          onUnmute();
          setShow(false);
        }}
        style={{
          border: "none",
          borderRadius: 8,
          padding: "6px 12px",
          fontSize: 12.5,
          fontWeight: 700,
          cursor: "pointer",
          background: "var(--ac, #5e6ad2)",
          color: "#fff",
        }}
      >
        Unmute
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setShow(false)}
        style={{
          border: "none",
          background: "transparent",
          color: "rgba(255,255,255,0.7)",
          cursor: "pointer",
          fontSize: 16,
          lineHeight: 1,
          padding: "2px 4px",
        }}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
