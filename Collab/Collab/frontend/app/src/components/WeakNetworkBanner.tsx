"use client";
import React, { useEffect, useRef, useState } from "react";

// Weak-network advice for meetings AND calls (one component, one behaviour).
//
// LiveKit reports the LOCAL connection quality (excellent / good / poor / lost).
// A bare "Weak network" pill tells people something is wrong but not what to do
// about it. Video is by far the biggest consumer of a thin uplink, and turning
// it off is the single action that reliably rescues the audio — so when the
// network is weak AND the camera is on, say so and offer it as one click. With
// the camera already off there is nothing to recommend switching off, so the
// banner only explains what is happening.
//
//   • Debounced: "poor" must hold for SHOW_AFTER_MS before anything appears, so
//     a one-second dip doesn't flash a banner; it clears after the link has been
//     healthy for HIDE_AFTER_MS (no flicker on a link hovering at the edge).
//   • Dismissible: hidden until the network recovers and degrades AGAIN.
//   • "lost" is NOT handled here — the "Reconnecting…" state owns that.
const SHOW_AFTER_MS = 4000;
const HIDE_AFTER_MS = 6000;

export default function WeakNetworkBanner({
  quality,
  camOn,
  onTurnOffVideo,
  style,
}: {
  quality: string;
  camOn: boolean;
  onTurnOffVideo: () => void;
  style?: React.CSSProperties;
}) {
  const [weak, setWeak] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (quality === "poor") {
      if (!weak) timer.current = setTimeout(() => setWeak(true), SHOW_AFTER_MS);
    } else if (quality === "excellent" || quality === "good") {
      if (weak || dismissed)
        timer.current = setTimeout(() => {
          setWeak(false);
          setDismissed(false); // a NEW weak spell may advise again
        }, HIDE_AFTER_MS);
    }
    // "unknown" / "lost": hold the current state — neither is evidence of recovery.
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [quality, weak, dismissed]);

  if (!weak || dismissed || quality === "lost") return null;

  return (
    <div className="weak-net-banner" role="status" aria-live="polite" style={style}>
      <span className="weak-net-dot" aria-hidden="true" />
      <div className="weak-net-text">
        <strong>Your network is weak.</strong>{" "}
        {camOn
          ? "We recommend turning off your video to keep the audio clear."
          : "Audio and video quality may drop until the connection improves."}
      </div>
      {camOn ? (
        <button
          type="button"
          className="weak-net-btn"
          onClick={() => {
            onTurnOffVideo();
            setDismissed(true);
          }}
        >
          Turn off video
        </button>
      ) : null}
      <button
        type="button"
        className="weak-net-x"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => setDismissed(true)}
      >
        ×
      </button>
    </div>
  );
}
