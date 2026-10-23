import React from "react";
import type { MediaGuidance } from "../lib/mediaErrors";

// A single, calm, persistent inline banner shown inside a call/meeting when a
// device (camera / mic / screen) couldn't be opened. Deliberately NOT a toast or
// popup — one quiet, dismissible strip that stays until the user fixes it or
// closes it, so users are AWARE without being bombarded, and never left staring
// at a blank tile wondering what happened. The copy (from classifyMediaError)
// owns the failure on the product's behalf and spells out the exact checkpoints.
export default function MediaHelpBanner({
  guidance,
  onRetry,
  onDismiss,
}: {
  guidance: MediaGuidance | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  if (!guidance || guidance.silent) return null;
  return (
    <div className="media-help-banner" role="status" aria-live="polite">
      <span className="mhb-icon" aria-hidden="true">
        {guidance.what === "camera" ? "📷" : guidance.what === "screen" ? "🖥️" : "🎙️"}
      </span>
      <div className="mhb-body">
        <div className="mhb-title">{guidance.title}</div>
        {guidance.steps.length ? (
          <ol className="mhb-steps">
            {guidance.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        ) : null}
      </div>
      <div className="mhb-actions">
        {onRetry ? (
          <button type="button" className="mhb-retry" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            className="mhb-dismiss"
            onClick={onDismiss}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  );
}
