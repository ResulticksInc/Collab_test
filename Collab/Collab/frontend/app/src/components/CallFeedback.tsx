import React, { useMemo, useState } from "react";
import Modal, { Btn } from "./Modal";
import { getClientEnv } from "../lib/platform";
import { IconThumbsUp, IconThumbsDown, IconCheck } from "../lib/icons";

// ─────────────────────────────────────────────────────────────────────────────
// POST-CALL / POST-MEETING FEEDBACK (#67)
//
// ONE shared dialog for EVERY surface — 1:1 audio, 1:1 video, group audio, group
// video, and meetings — rendered at the CoLabV1 level so both the call and the
// meeting leave paths funnel into it. It is platform-agnostic (identical on web +
// Electron); no browser/desktop-specific code lives here. It reuses Modal.tsx
// (focus trap, ESC-to-close, scroll-lock, backdrop dismiss) and the design-system
// tokens, so it inherits the app's theme automatically.
//
// The parent owns the DECISION of whether to show this (media connected + normal
// end + settings.callFeedback + duration + throttle); this component owns the
// EXPERIENCE + the submit. On submit it POSTs and closes; it never blocks the UI.
// ─────────────────────────────────────────────────────────────────────────────

export type FeedbackKind = "call" | "meeting";

export interface CallFeedbackMeta {
  kind: FeedbackKind;
  callId?: string | null;
  meetingId?: string | null;
  durationSec?: number;
  networkQuality?: string | null;
}

export interface CallFeedbackPayload extends CallFeedbackMeta {
  feedbackType: "good" | "issues";
  categories: Record<string, string[]>;
  comment: string;
  platform: string;
  os: string;
  browser: string;
  appVersion?: string;
  buildNumber?: string;
  // Session Replay Lite: true when the user left "Attach technical diagnostics"
  // checked on an "issues" rating. The PARENT resolves the actual report text
  // (getLastCallReport) and includes it in the POST — this component never
  // touches the diagnostics itself.
  attachDiagnostics?: boolean;
}

// NOTE: the ISSUE_GROUPS checklist (5 groups, 26 options) that used to live here
// was removed with the matrix it fed. The payload still carries a `categories`
// field — now always empty — because the backend contract and its sanitizer are
// unchanged, so this stays a pure UI simplification.

export default function CallFeedback({
  meta,
  onClose,
  onSubmit,
  onDontShowAgain,
  diagnosticsAvailable = false,
}: {
  meta: CallFeedbackMeta;
  onClose: () => void;
  // Fire-and-forget: the parent POSTs + toasts. Never awaited by the UI.
  onSubmit: (payload: CallFeedbackPayload) => void;
  // Flips settings.callFeedback=false (the ONE source of truth) and shows the
  // "you can re-enable it from Settings" info — only when the box is checked.
  onDontShowAgain: () => void;
  // Session Replay Lite: parent says whether a fresh diagnostics report exists
  // for this session; when true, "Had issues" offers an attach checkbox.
  diagnosticsAvailable?: boolean;
}) {
  const isMeeting = meta.kind === "meeting";
  const [type, setType] = useState<"good" | "issues" | null>(null);
  const [comment, setComment] = useState("");
  const [dontShow, setDontShow] = useState(false);
  // Default ON: diagnostics are what lets support act on the report without a
  // reproduce loop. Transparent + one-click opt-out (enterprise consent bar).
  const [attachDiag, setAttachDiag] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const title = isMeeting
    ? "How was your meeting experience?"
    : "How was your call experience?";

  // Submit is enabled as soon as a rating is chosen — the note is optional on
  // both paths.
  const canSubmit = type !== null && !submitting;

  const doSubmit = () => {
    if (type === null || submitting) return;
    setSubmitting(true);
    // Always empty now that the issue matrix is gone. Kept on the payload so the
    // API contract and the backend's sanitizer are untouched.
    const categories: Record<string, string[]> = {};
    const env = getClientEnv();
    const payload: CallFeedbackPayload = {
      kind: meta.kind,
      callId: meta.callId ?? null,
      meetingId: meta.meetingId ?? null,
      durationSec: meta.durationSec,
      networkQuality: meta.networkQuality ?? null,
      feedbackType: type,
      categories,
      comment: comment.trim().slice(0, 1000),
      platform: env.platform,
      os: env.os,
      browser: env.browser,
      appVersion: env.appVersion,
      buildNumber: env.buildNumber,
      attachDiagnostics:
        type === "issues" && diagnosticsAvailable && attachDiag,
    };
    // "Don't show again" is the ONE source of truth — same setting the
    // Accessibility toggle controls. Flip it FIRST so it persists even if the
    // POST is slow, then submit + close.
    if (dontShow) onDontShowAgain();
    onSubmit(payload);
    onClose();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          <label className="cf-dsa" title="Stop showing this after calls">
            <input
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
            />
            <span>Don&apos;t show this again</span>
          </label>
          <div style={{ flex: 1 }} />
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn primary onClick={doSubmit} disabled={!canSubmit}>
            Submit Feedback
          </Btn>
        </>
      }
    >
      <div className="cf-body">
        <p className="cf-sub">
          Your feedback helps us improve {isMeeting ? "meeting" : "call"} quality.
        </p>

        {/* Two large, consistent SVG choices — thumbs up / thumbs down. */}
        <div
          className="cf-choices"
          role="radiogroup"
          aria-label="Rate your experience"
        >
          <button
            type="button"
            role="radio"
            aria-checked={type === "good"}
            className={"cf-choice cf-good" + (type === "good" ? " on" : "")}
            onClick={() => setType("good")}
          >
            <span className="cf-choice-ic">
              <IconThumbsUp size={26} />
            </span>
            <span className="cf-choice-lab">Good</span>
            <span className="cf-choice-sub">Everything worked well</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={type === "issues"}
            className={"cf-choice cf-bad" + (type === "issues" ? " on" : "")}
            onClick={() => setType("issues")}
          >
            <span className="cf-choice-ic">
              <IconThumbsDown size={26} />
            </span>
            <span className="cf-choice-lab">Had issues</span>
            <span className="cf-choice-sub">Something didn&apos;t work</span>
          </button>
        </div>

        {/* The 26-checkbox issue matrix that used to sit here was removed: after
            a call that already went badly, asking someone to classify their own
            problem across five categories is work, and most people abandoned it
            or picked nothing. Either choice now leads to the same optional
            free-text box below — "Good" and "Had issues" both just take an
            additional note. The structured `categories` field stays on the
            payload as an empty object; the backend already sanitizes and
            tolerates that, so nothing downstream breaks. */}

        {/* Session Replay Lite — offer the diagnostics attach on "Had issues"
            when a fresh report exists for this session. Checked by default;
            plain-language description of exactly what is (and isn't) sent. */}
        {type === "issues" && diagnosticsAvailable && (
          <label className="cf-dsa" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={attachDiag}
              onChange={(e) => setAttachDiag(e.target.checked)}
            />
            <span>
              Attach technical diagnostics (connection timeline — no audio,
              video or message content)
            </span>
          </label>
        )}

        {/* Optional free-text — shown for both ratings once one is chosen. */}
        {type !== null && (
          <div className="cf-comment">
            <textarea
              className="cf-textarea"
              placeholder="Tell us more (optional)..."
              maxLength={1000}
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 1000))}
              // Cmd/Ctrl+Enter submits from the textarea (Enter alone = newline).
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  doSubmit();
                }
              }}
            />
            <div className="cf-count">{comment.length}/1000</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
