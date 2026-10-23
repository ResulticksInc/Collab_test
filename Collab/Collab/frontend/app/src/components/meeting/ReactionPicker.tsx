import type React from "react";
import { createPortal } from "react-dom";
// Emoji reaction picker (Phase 0 decomposition — extracted from MeetingStage).
//
// Presentational: the parent owns whether it is open and what happens on pick.
// The emoji set lives here because it is the only thing that renders it — one
// place to change if the palette is ever revisited.

export const REACTION_EMOJIS: Array<{ emoji: string; label: string }> = [
  { emoji: "\u{1F44D}", label: "Like" },
  { emoji: "❤️", label: "Love" },
  { emoji: "\u{1F602}", label: "Laugh" },
  { emoji: "\u{1F62E}", label: "Surprised" },
  { emoji: "\u{1F622}", label: "Sad" },
  { emoji: "\u{1F389}", label: "Celebrate" },
];

export default function ReactionPicker({
  open,
  onPick,
  style,
}: {
  open: boolean;
  onPick: (emoji: string) => void;
  /** Anchors the popover to its trigger button (computed from the button's
   *  own rect) instead of the default CSS centring — position/left/bottom
   *  here override the class. */
  style?: React.CSSProperties;
}) {
  if (!open) return null;
  // Portaled to <body>: the meeting stage's video wrapper can carry the same
  // `contain: layout` / transform quirk as the call view's (see the matching
  // note in MutedSpeakingPrompt.tsx) — position:fixed here must escape it to
  // land relative to the real viewport, not that box.
  return createPortal(
    <div className="ms-reaction-group" style={style}>
      <div className="ms-reaction-picker-v2">
        {REACTION_EMOJIS.map((r) => (
          <button
            key={r.emoji}
            className="ms-reaction-btn-v2"
            onClick={() => onPick(r.emoji)}
            title={r.label}
          >
            {r.emoji}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
