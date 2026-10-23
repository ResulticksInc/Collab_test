import React, { useEffect, useRef, useState } from "react";
import { IconChevronDown, IconPhone } from "../lib/icons";
import { confirmDialog } from "../lib/dialog";

// The ONE leave control for the bottom dock, shared by calls (CoLabV1) and
// meetings (MeetingStage) so the two can never drift — same rule as the tile
// grid. It renders the existing `.ms-dock-leave` red pill, so nothing about the
// dock's look changes; what changes is the SHAPE for people who can end the
// session for everyone.
//
//   • Ordinary participants  → one plain "Leave" pill. There is nothing to
//     choose, so there is no toggle and no menu: one click leaves.
//   • Host / co-host         → the same pill SPLIT in two, sharing one outline.
//     The left half is a real button that leaves immediately (it does NOT just
//     open a menu, which is what the old single button did — clicking "Leave"
//     used to leave you still in the meeting, staring at a dropdown). The right
//     half is the toggle, holding the two END actions.
//
// Text colour is inherited (`currentColor` on the pill), so both halves follow
// the dock's theme tokens rather than hard-coding light/dark values.
export default function LeaveControl({
  canEndForAll,
  onLeave,
  onEnd,
  onEndForAll,
  leaveLabel = "Leave",
  ariaLabel = "Leave",
  sessionNoun = "meeting",
}: {
  // Host or co-host — the only roles that may end the session for everyone.
  canEndForAll: boolean;
  // "meeting" or "call" — only used to phrase the confirmation prompt.
  sessionNoun?: string;
  onLeave: () => void;
  // "End" — ends the session for YOU (disconnects), leaving it running for the
  // others. Falls back to onLeave when a caller has no separate path.
  onEnd?: () => void;
  onEndForAll?: () => void;
  leaveLabel?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Confirm-before-exit (all three exit paths). A single guard prevents a
  // second click from stacking a second dialog / racing the action while the
  // first prompt is open. Runs the action only on an explicit confirm.
  const confirmingRef = useRef(false);
  const confirmThen = async (
    action: (() => void) | undefined,
    title: string,
    message: string,
    confirmText: string,
  ) => {
    if (!action || confirmingRef.current) return;
    confirmingRef.current = true;
    try {
      if (await confirmDialog(message, { title, confirmText, cancelText: "Stay", danger: true }))
        action();
    } finally {
      confirmingRef.current = false;
    }
  };
  const noun = sessionNoun;
  const askLeave = (action?: () => void) =>
    confirmThen(action, `Leave this ${noun}?`, `You'll be disconnected from this ${noun}.`, "Leave");

  // Dismiss on outside click / Escape. Scoped to the whole split wrapper, not
  // the menu, so clicking the toggle again closes rather than re-opening.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    // CAPTURE phase + stopPropagation: the app's global Escape handling would
    // otherwise treat this as "close the call/meeting" and leave the session
    // out from under a menu the user was only trying to dismiss. Escape here
    // closes the menu and nothing else — same convention the meeting dock's
    // other popups already use.
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    };
    const id = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onEsc, true);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc, true);
    };
  }, [open]);

  if (!canEndForAll)
    return (
      <button
        className="ms-dock-btn ms-dock-leave"
        onClick={() => askLeave(onLeave)}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="ms-dock-icon">
          <IconPhone size={18} />
        </span>
        <span className="ms-dock-label">{leaveLabel}</span>
      </button>
    );

  return (
    <div className="ms-leave-wrap ms-leave-split" ref={wrapRef}>
      <button
        className="ms-dock-btn ms-dock-leave ms-leave-main"
        onClick={() => {
          setOpen(false);
          askLeave(onLeave);
        }}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="ms-dock-icon">
          <IconPhone size={18} />
        </span>
        <span className="ms-dock-label">{leaveLabel}</span>
      </button>
      <button
        className="ms-dock-btn ms-dock-leave ms-leave-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-label="End options"
        title="End options"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div className="ms-leave-menu" role="menu">
          <button
            className="ms-leave-option"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              askLeave(onEnd || onLeave);
            }}
          >
            End
          </button>
          <button
            className="ms-leave-option ms-leave-end"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              confirmThen(
                onEndForAll,
                `End this ${noun} for everyone?`,
                `This ends the ${noun} for all participants — everyone will be disconnected.`,
                "End for everyone",
              );
            }}
          >
            End for everyone
          </button>
        </div>
      )}
    </div>
  );
}
