"use client";
import React, { useEffect, useRef, useState } from "react";
import { CALL_LAYOUTS, callLayoutLabel, type CallLayout } from "../lib/stageView";

// Dock "Layout" picker — IDENTICAL in calls (CallModal) and meetings
// (MeetingStage): Speaker (default) · Speaker bottom strip · Gallery · Focus.
// Per-viewer, switchable mid-session; the owner persists the choice. Only the
// stage's tile POSITIONS change on a switch — nothing is re-mounted, so
// audio/video are never interrupted (VIEW-28). Announces the active layout to
// assistive tech (VIEW-11).
export function layoutIcon(id: string): React.ReactNode {
  switch (id) {
    case "speaker":
      return (
        <>
          <rect x="3" y="4" width="12" height="16" rx="1.5" />
          <rect x="17" y="4" width="4" height="4.5" rx="1" />
          <rect x="17" y="10" width="4" height="4.5" rx="1" />
          <rect x="17" y="16" width="4" height="4" rx="1" />
        </>
      );
    case "speaker-bottom":
      return (
        <>
          <rect x="3" y="3" width="18" height="11" rx="1.5" />
          <rect x="3" y="16" width="5" height="5" rx="1" />
          <rect x="9.5" y="16" width="5" height="5" rx="1" />
          <rect x="16" y="16" width="5" height="5" rx="1" />
        </>
      );
    case "focus":
      return <rect x="3" y="4" width="18" height="16" rx="2" />;
    default:
      return (
        <>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </>
      );
  }
}

export default function LayoutPicker({
  value,
  onChange,
  variant = "dock",
}: {
  value: CallLayout;
  onChange: (next: CallLayout) => void;
  /** "dock": stacked icon + "Layout" label (call dock). "topbar": the compact
   *  horizontal "▦ View" control in the meeting header. */
  variant?: "dock" | "topbar";
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Close on Esc and on any pointer-down OUTSIDE the picker. A document-level
  // listener (capture phase) is used instead of a full-screen backdrop: the
  // stage/dock create their own stacking contexts, so a fixed backdrop rendered
  // inside the dock sat BELOW the stage and outside clicks never reached it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      const w = wrapRef.current;
      if (w && !w.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);
  const label = callLayoutLabel(value);
  return (
    <div ref={wrapRef} className={"ms-more-wrap ms-layout-wrap" + (variant === "topbar" ? " ms-layout-wrap-top" : "")} style={{ position: "relative" }}>
      {variant === "topbar" ? (
        <button
          type="button"
          className={"ms-view-btn" + (open ? " on" : "")}
          onClick={() => setOpen((v) => !v)}
          aria-label="Change view layout"
          aria-haspopup="menu"
          aria-expanded={open}
          title={"View: " + label}
        >
          <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {layoutIcon("gallery")}
          </svg>
          <span>View</span>
        </button>
      ) : (
      <button
        type="button"
        className={"ms-dock-btn" + (open ? " on" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-label="Change view layout"
        aria-haspopup="menu"
        aria-expanded={open}
        title={"Layout: " + label}
      >
        <span className="ms-dock-icon">
          <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {layoutIcon(value)}
          </svg>
        </span>
        <span className="ms-dock-label">Layout</span>
      </button>
      )}
      {open && (
        <>
          <div className="ms-more-menu cv-layout-menu" role="menu" aria-label="View layout" style={{ zIndex: 200 }}>
            <div className="view-menu-head">{variant === "topbar" ? "View" : "Layout"}</div>
            {CALL_LAYOUTS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={"ms-more-item" + (value === l.id ? " on" : "")}
                role="menuitemradio"
                aria-checked={value === l.id}
                title={l.hint}
                onClick={() => {
                  onChange(l.id);
                  setOpen(false);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {layoutIcon(l.id)}
                </svg>
                {l.label}
                <span className="view-menu-check" aria-hidden="true">
                  {value === l.id ? "✓" : ""}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      <span role="status" aria-live="polite" className="cv-sr-only">
        {label}
      </span>
    </div>
  );
}
