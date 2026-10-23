// Presenter Mode — the "Presentation mode" selector shown while screen sharing.
// Shared by calls + meetings. Pure presentational: it renders the four registry
// modes and reports the pick; all lifecycle lives in usePresenterMode().

import React, { useState } from "react";
import {
  PRESENTER_MODES,
  modeDef,
  type PresenterMode,
} from "../lib/presenter/types";

// Compact layout glyph so each option reads at a glance (content = grey blocks,
// camera = teal).
function ModeGlyph({ mode }: { mode: PresenterMode }) {
  const F = "#0f766e";
  return (
    <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true">
      <rect x="0.5" y="0.5" width="25" height="17" rx="2.5" fill="#2b333d" />
      {mode === "standard" && (
        <rect x="3" y="3" width="20" height="12" rx="1.5" fill="#4b545f" />
      )}
      {mode === "presenter" && (
        <>
          <rect x="3" y="3" width="20" height="12" rx="1.5" fill="#4b545f" />
          <path d="M15 15c0-3 1.6-4.4 3.4-4.4S21.8 12 21.8 15z" fill={F} />
          <circle cx="18.4" cy="8.4" r="1.9" fill={F} />
        </>
      )}
      {mode === "sidebyside" && (
        <>
          <rect x="3" y="3" width="12" height="12" rx="1.5" fill="#4b545f" />
          <rect x="16.5" y="3" width="6.5" height="12" rx="1.5" fill={F} />
        </>
      )}
      {mode === "spotlight" && (
        <>
          <rect x="3" y="3" width="20" height="12" rx="1.5" fill="#4b545f" />
          <rect x="4.5" y="9.5" width="6" height="4.2" rx="1.2" fill={F} />
        </>
      )}
    </svg>
  );
}

export default function PresentationModeMenu({
  mode,
  onPick,
  cameraOn,
  variant = "button",
  sharing = true,
}: {
  mode: PresenterMode;
  onPick: (m: PresenterMode) => void;
  cameraOn: boolean;
  // "button" = the standalone labelled selector (legacy call site). "chevron" =
  // the split-button caret that lives inside the Share dock control, matching the
  // mic/camera device chevrons.
  variant?: "button" | "chevron";
  // Presentation layouts only apply to a LIVE screen share (they composite your
  // camera over/beside the shared screen). When you're not sharing yet, the menu
  // still opens for discoverability but the options are disabled with a hint —
  // picking one otherwise would wrongly flip you into "presenting".
  sharing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = mode !== "standard";

  return (
    <div className={"pmode-wrap" + (variant === "chevron" ? " pmode-chevron-wrap" : "")}>
      {variant === "chevron" ? (
        <button
          type="button"
          className="ms-dock-chevron"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Screen share modes"
          aria-label="Screen share modes"
        >
          <svg viewBox="0 0 24 24" width={9} height={9} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
        </button>
      ) : (
        <button
          type="button"
          className={"pmode-btn" + (active ? " on" : "")}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Presentation mode"
        >
          <svg
            className="pmode-btn-icon"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <line x1="13.5" y1="5" x2="13.5" y2="19" />
          </svg>
          <span className="pmode-btn-label">{modeDef(mode).label}</span>
        </button>
      )}

      {open && (
        <>
          <div className="pmode-scrim" onClick={() => setOpen(false)} />
          <div className="pmode-pop" role="menu">
            <div className="pmode-head">Presentation mode</div>
            {PRESENTER_MODES.map((m) => {
              const needsShare = !sharing;
              const needsCam = m.needsCamera && !cameraOn;
              const disabled = needsShare || needsCam;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === m.id}
                  className={
                    "pmode-item" +
                    (mode === m.id ? " sel" : "") +
                    (disabled ? " dis" : "")
                  }
                  disabled={disabled}
                  onClick={() => {
                    onPick(m.id);
                    setOpen(false);
                  }}
                >
                  <span className="pmode-item-glyph">
                    <ModeGlyph mode={m.id} />
                  </span>
                  <span className="pmode-item-txt">
                    <b>{m.label}</b>
                    <small>
                      {needsShare
                        ? "Start sharing your screen to use this."
                        : needsCam
                          ? "Turn your camera on to use this."
                          : m.hint}
                    </small>
                  </span>
                  <span className="pmode-radio" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
