"use client";
import { useEffect, useRef, useState } from "react";
import { IconX } from "../lib/icons";
import { mediaBlockedReason } from "../lib/mediaSupport";

// Settings → Audio & Video → Test Camera. Opens the camera as soon as the modal
// mounts and releases it on close. The <video> exists from the first render, so
// the stream can be attached the moment getUserMedia resolves.
export default function CameraTestModal({
  deviceId,
  onClose,
  onReady,
}: {
  deviceId?: string;
  onClose: () => void;
  /** Fired once access is granted — device labels only populate after that. */
  onReady?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<"starting" | "live" | "error">("starting");
  const [error, setError] = useState("");

  // Close on global ESC (the app-wide Escape behaviour); claim the event.
  useEffect(() => {
    const onEsc = (e: Event) => { onClose(); e.preventDefault(); };
    window.addEventListener("colab:esc", onEsc as any);
    return () => window.removeEventListener("colab:esc", onEsc as any);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    setState("starting");
    (async () => {
      const blocked = mediaBlockedReason();
      if (blocked) {
        setError(blocked);
        setState("error");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          v.play().catch(() => {});
        }
        setState("live");
        onReady && onReady();
      } catch (e: any) {
        if (cancelled) return;
        const n = e && e.name;
        setError(
          n === "NotAllowedError"
            ? "Camera blocked — allow camera access in your browser's site settings, then try again."
            : n === "NotFoundError" || n === "OverconstrainedError"
              ? "No camera found. Connect one or pick a different camera in Settings."
              : n === "NotReadableError"
                ? "Your camera is in use by another app. Close it and try again."
                : (e && e.message) || "Couldn't open the camera.",
        );
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  return (
    <div className="mm-overlay" onClick={onClose}>
      <div className="cc-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Test camera">
        <div className="cc-head">
          <span>Test camera</span>
          <button className="cc-x" onClick={onClose} aria-label="Close"><IconX size={15} /></button>
        </div>
        <p className="cc-sub">
          {state === "error" ? error : "This is how you'll appear to others in calls and meetings."}
        </p>
        <div
          style={{
            width: "100%",
            aspectRatio: "16 / 9",
            background: "#0a0f1e",
            borderRadius: 12,
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#9ca3af",
            fontSize: 13,
          }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: "scaleX(-1)",
              display: state === "live" ? "block" : "none",
            }}
          />
          {state === "starting" ? "Opening camera…" : null}
          {state === "error" ? "Camera unavailable" : null}
        </div>
        <div className="cc-actions">
          <button className="btn-p" onClick={onClose}>
            {state === "live" ? "Stop camera" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
