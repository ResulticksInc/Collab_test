"use client";
import React from "react";
import type { StageViewPrefs } from "../lib/stageView";

// The "View" block of the More (⋯) menu — identical in meetings and calls, so
// the two can't offer different options or word them differently. Toggles only;
// the layout reacts to the preference change.
export default function ViewMenuSection({
  prefs,
  onChange,
}: {
  prefs: StageViewPrefs;
  onChange: (patch: Partial<StageViewPrefs>) => void;
}) {
  const item = (
    label: string,
    hint: string,
    on: boolean,
    toggle: () => void,
    icon: React.ReactNode,
  ) => (
    <button
      type="button"
      className="ms-more-item"
      role="menuitemcheckbox"
      aria-checked={on}
      title={hint}
      onClick={toggle}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {icon}
      </svg>
      {label}
      <span className="view-menu-check" aria-hidden="true">{on ? "✓" : ""}</span>
    </button>
  );
  return (
    <>
      <div className="view-menu-head">View</div>
      {item(
        "Focus on content",
        "Show only the main tile — hide the thumbnail rail",
        prefs.focusContent,
        () => onChange({ focusContent: !prefs.focusContent }),
        <>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </>,
      )}
      {item(
        "Hide participants without video",
        "Only show people whose camera is on (everyone stays in People)",
        prefs.hideNoVideo,
        () => onChange({ hideNoVideo: !prefs.hideNoVideo }),
        <>
          <path d="M16 16v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5 0h3a2 2 0 0 1 2 2v3l5-3v10" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </>,
      )}
      {item(
        "Hide self view",
        "Hide your own camera preview — others still see you",
        prefs.hideSelf,
        () => onChange({ hideSelf: !prefs.hideSelf }),
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
          <line x1="3" y1="3" x2="21" y2="21" />
        </>,
      )}
    </>
  );
}
