"use client";

// Presenter Mode — LOCAL QA HARNESS (self-hosted, no new deps). Drives the REAL
// PresenterProcessor with your camera over synthetic (or real) screen content so
// the hardest-to-test parts can be validated SOLO, without a 2-user LiveKit call:
//   • segmentation polarity (person kept, NOT the background — no inverted cutout)
//   • edge quality + frame-to-frame stability (no flicker)
//   • all four layouts (Standard / Presenter / Side-by-Side / Spotlight)
//   • perf / auto-degrade level on this machine
// The cross-peer parts (sync, reconnect, recording, tile-hide) still need a real
// call. Route: /presenter-test — internal QA tool, no backend calls, camera only.

import React, { useEffect, useRef, useState } from "react";
import { PresenterProcessor } from "../../lib/presenter/PresenterProcessor";
import { PRESENTER_MODES, type PresenterMode } from "../../lib/presenter/types";

export default function PresenterTestPage() {
  const [mode, setMode] = useState<PresenterMode>("presenter");
  const [running, setRunning] = useState(false);
  const [degrade, setDegrade] = useState(0);
  const [status, setStatus] = useState(
    "Click Start — grant camera access. Then switch modes and check the composite.",
  );

  const outRef = useRef<HTMLVideoElement>(null);
  const procRef = useRef<PresenterProcessor | null>(null);
  const camTrackRef = useRef<MediaStreamTrack | null>(null);
  const contentRef = useRef<{ track: MediaStreamTrack; stop: () => void } | null>(
    null,
  );

  // A live "slide": grid + text + a moving block + a clock, so the content is
  // clearly animated (proves the composite is live and lets you judge smoothness).
  const makeSyntheticContent = () => {
    const c = document.createElement("canvas");
    c.width = 1280;
    c.height = 720;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    let t = 0;
    const draw = () => {
      t++;
      ctx.fillStyle = "#0e1826";
      ctx.fillRect(0, 0, 1280, 720);
      ctx.strokeStyle = "rgba(255,255,255,.06)";
      for (let x = 0; x <= 1280; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 720);
        ctx.stroke();
      }
      for (let y = 0; y <= 720; y += 64) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(1280, y);
        ctx.stroke();
      }
      ctx.fillStyle = "#e8eef5";
      ctx.font = "700 60px system-ui, sans-serif";
      ctx.fillText("Presenter Mode — test slide", 72, 130);
      ctx.font = "400 28px system-ui, sans-serif";
      ctx.fillStyle = "#9fb0c0";
      ctx.fillText(
        "Check: person kept (not inverted) · clean edges · no flicker · layout.",
        72,
        188,
      );
      const x = 72 + ((t * 6) % 1040);
      ctx.fillStyle = "#17a088";
      ctx.fillRect(x, 300, 120, 120);
      ctx.fillStyle = "#e8eef5";
      ctx.font = "500 40px ui-monospace, monospace";
      ctx.fillText(new Date().toLocaleTimeString(), 72, 632);
      raf = requestAnimationFrame(draw);
    };
    draw();
    const stream = (c as any).captureStream(30) as MediaStream;
    return { track: stream.getVideoTracks()[0], stop: () => cancelAnimationFrame(raf) };
  };

  const start = async () => {
    try {
      setStatus("Requesting camera…");
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: false,
      });
      camTrackRef.current = cam.getVideoTracks()[0];
      const content = makeSyntheticContent();
      contentRef.current = content;
      const proc = new PresenterProcessor({
        getCameraTrack: () => camTrackRef.current,
        mode,
        onDegrade: setDegrade,
      });
      procRef.current = proc;
      await proc.init({ track: content.track });
      if (outRef.current && proc.processedTrack) {
        outRef.current.srcObject = new MediaStream([proc.processedTrack]);
        await outRef.current.play().catch(() => {});
      }
      setRunning(true);
      setStatus(
        "Running. 'Presenter' loads the segmentation model on first use (~1s).",
      );
    } catch (e: any) {
      setStatus("Camera failed: " + (e?.message || String(e)));
    }
  };

  const stop = () => {
    procRef.current?.destroy();
    procRef.current = null;
    camTrackRef.current?.stop();
    camTrackRef.current = null;
    contentRef.current?.stop();
    contentRef.current = null;
    if (outRef.current) outRef.current.srcObject = null;
    setRunning(false);
    setDegrade(0);
    setStatus("Stopped.");
  };

  const pick = (m: PresenterMode) => {
    setMode(m);
    procRef.current?.setMode(m);
  };

  // Swap the synthetic slide for a real shared screen/window/tab.
  const useRealScreen = async () => {
    try {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = ds.getVideoTracks()[0];
      contentRef.current?.stop();
      contentRef.current = { track, stop: () => track.stop() };
      await procRef.current?.restart({ track });
      setStatus("Compositing over your shared screen.");
    } catch {
      /* user cancelled the picker */
    }
  };

  useEffect(() => {
    return () => {
      procRef.current?.destroy();
      camTrackRef.current?.stop();
      contentRef.current?.stop();
    };
  }, []);

  const btn = (active: boolean): React.CSSProperties => ({
    padding: "8px 14px",
    borderRadius: 9,
    border: "1px solid " + (active ? "#17a088" : "rgba(255,255,255,.16)"),
    background: active ? "rgba(15,118,110,.9)" : "rgba(255,255,255,.06)",
    color: "#fff",
    font: "600 13px system-ui, sans-serif",
    cursor: "pointer",
  });

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0b0f14",
        color: "#e8eef5",
        font: "14px/1.5 system-ui, sans-serif",
        padding: 24,
        boxSizing: "border-box",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h1 style={{ fontSize: 22, margin: 0, letterSpacing: "-.01em" }}>
            Presenter Mode — Test Harness
          </h1>
          <span style={{ color: "#8a929b", fontSize: 12 }}>
            internal QA tool · camera only · no backend
          </span>
        </div>

        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "center",
            margin: "18px 0",
          }}
        >
          {!running ? (
            <button style={btn(true)} onClick={start}>
              Start (grant camera)
            </button>
          ) : (
            <button style={btn(false)} onClick={stop}>
              Stop
            </button>
          )}
          <button style={btn(false)} onClick={useRealScreen} disabled={!running}>
            Use a real screen
          </button>
          <span style={{ width: 1, height: 24, background: "rgba(255,255,255,.12)" }} />
          {PRESENTER_MODES.map((m) => (
            <button
              key={m.id}
              style={btn(mode === m.id)}
              onClick={() => pick(m.id)}
              disabled={!running}
              title={m.hint}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div
          style={{
            position: "relative",
            aspectRatio: "16 / 9",
            background: "#000",
            borderRadius: 14,
            overflow: "hidden",
            border: "1px solid rgba(255,255,255,.1)",
          }}
        >
          <video
            ref={outRef}
            autoPlay
            muted
            playsInline
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
          {running && (
            <div
              style={{
                position: "absolute",
                top: 10,
                right: 12,
                font: "600 11px ui-monospace, monospace",
                color: degrade === 0 ? "#17a088" : degrade === 1 ? "#d9a441" : "#e5679a",
                background: "rgba(0,0,0,.55)",
                padding: "4px 9px",
                borderRadius: 6,
              }}
            >
              degrade {degrade}
            </div>
          )}
        </div>

        <p style={{ color: "#9fb0c0", marginTop: 14 }}>{status}</p>
        <ul style={{ color: "#8a929b", fontSize: 13, lineHeight: 1.7 }}>
          <li>
            <b>Presenter</b> — background removed, you composited over the slide.
            The <i>person</i> must be kept (not the background). No halo/flicker.
          </li>
          <li>
            <b>Side-by-Side / Spotlight</b> — no segmentation; framed camera panel.
          </li>
          <li>
            <b>degrade</b> — 0 full quality · 1–2 = this machine is reducing
            segmentation cadence under load.
          </li>
        </ul>
      </div>
    </div>
  );
}
