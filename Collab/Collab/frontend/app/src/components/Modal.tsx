import React, { useEffect, useRef } from "react";
import { useDraggableResizable } from "../lib/useDraggableResizable";
import { IconX } from "../lib/icons";
const inp: React.CSSProperties = {
  width: "100%",
  padding: "11px 13px",
  borderRadius: 10,
  border: "1px solid var(--g200)",
  fontSize: 13,
  background: "var(--sb)",
  color: "var(--g900)",
  outline: "none",
  boxSizing: "border-box",
};
export { inp };
export function Btn({
  children,
  primary,
  danger,
  onClick,
  disabled,
}: {
  children?: React.ReactNode;
  primary?: boolean;
  danger?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "8px 14px",
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        border: primary || danger ? "none" : "1px solid var(--g200)",
        // Primary CTAs use the Collab BRAND purple gradient (not the indigo --bm),
        // per the design system — standardizes every modal's primary button.
        background: danger ? "#dc2626" : primary ? "var(--brand-cta-gradient)" : "var(--sb)",
        color: primary || danger ? "#fff" : "var(--g700)",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}
export default function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  width,
  draggable = true,
  zIndex = 2100,
  bodyStyle,
}: {
  title?: React.ReactNode;
  onClose?: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
  /** Explicit dialog width in px. Overrides `wide` — for dialogs like the
   *  scheduler that need more room than the shared 560 without widening every
   *  other Modal in the app. */
  width?: number;
  draggable?: boolean;
  /** Extra styles for the scrolling body (e.g. `{ padding: 0 }` for dialogs
   *  that lay out their own columns edge to edge, like the scheduler). */
  bodyStyle?: React.CSSProperties;
  // Overlay stacking. Defaults to the shared Modal band (2100). Callers that open
  // a Modal from ABOVE that band (e.g. the app-wide DialogHost launched from the
  // OrgAdmin panel at 4000) pass a higher value so the dialog isn't buried behind
  // the surface that spawned it.
  zIndex?: number;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const dr = useDraggableResizable({
    defaultW: width || (wide ? 560 : 430),
    defaultH: 480,
    minW: 320,
    minH: 200,
    persist: false,
    disabled:
      !draggable ||
      (typeof window !== "undefined" &&
        (window.matchMedia("(max-width: 640px)").matches ||
          window.matchMedia("(pointer: coarse)").matches)),
  });
  // Tracks whether the current press BEGAN on the backdrop itself. Backdrop
  // dismissal only fires when the press both started and ended on the overlay —
  // so a drag/selection that started inside the dialog and ended out here, or a
  // click on an item that unmounts mid-press (whose click then resolves to the
  // overlay), never closes the modal. Fixes the "modal closes unexpectedly when
  // picking invitees" defect — app-wide, for every Modal.
  const backdropDown = useRef(false);
  // Keep the latest onClose in a ref so the focus/scroll/key setup below can run
  // ONCE on mount (not on every onClose identity change). Previously the effect
  // depended on [onClose]; since callers pass an inline `close`, it re-ran on
  // every parent re-render and re-focused the first element (the × button) —
  // which stole focus out of inputs on every keystroke. (Fixes ALL modals.)
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const prevActive = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // R10: lock background scroll
    const dlg = dialogRef.current;
    const focusables = () =>
      dlg
        ? Array.from(
            dlg.querySelectorAll<HTMLElement>(
              'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          ).filter((el) => el.offsetParent !== null)
        : [];
    // Focus the first real FIELD (the × close button is first in DOM but a poor
    // focus target). This also avoids fighting an input's own autoFocus.
    const _f = focusables();
    (_f.find((el) => el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") || _f[0] || dlg)?.focus(); // R18
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Claim Escape so the app's global window handler can't ALSO fire a
        // "Back" navigation on the same keypress (S2 double-fire fix).
        e.stopPropagation();
        onCloseRef.current && onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && dlg) {
        // R10: trap Tab focus within the dialog.
        const f = focusables();
        if (!f.length) return;
        const lo = f[0];
        const hi = f[f.length - 1];
        if (e.shiftKey && document.activeElement === lo) { e.preventDefault(); hi.focus(); }
        else if (!e.shiftKey && document.activeElement === hi) { e.preventDefault(); lo.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow; // restore scroll
      if (prevActive && typeof prevActive.focus === "function") prevActive.focus(); // R18: restore focus
    };
  }, []); // run ONCE on mount — re-running on onClose change stole input focus
  return (
    <div
      className="ov"
      onMouseDown={(e) => {
        // Record whether the press began on the backdrop itself (not bubbled up
        // from inside the dialog).
        backdropDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Only dismiss when the press both started AND ended on the backdrop.
        if (e.target === e.currentTarget && backdropDown.current && onClose)
          onClose();
        backdropDown.current = false;
      }}
      style={{
        position: "fixed",
        inset: 0,
        // Modal band 2100: a focused dialog MUST outrank an active call/meeting
        // (.call-dock 2000) — e.g. the "?" shortcuts modal or a confirm opened
        // during a call — while staying below the titlebar (3000) + toasts (4000).
        // Overridable (see the zIndex prop) for dialogs launched from a HIGHER band.
        zIndex,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(2,6,23,.45)",
      }}
    >
      <div
        className="m"
        ref={(el) => {
          (dialogRef as any).current = el;
          (dr.rootRef as any).current = el;
        }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Dialog"}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: width || (wide ? 560 : 430),
          maxWidth: "94vw",
          maxHeight: "88vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--sb)",
          border: "1px solid var(--sbb)",
          boxShadow: "var(--shl)",
          borderRadius: 14,
          ...(dr.started
            ? {
                position: "fixed",
                left: dr.pos?.left,
                top: dr.pos?.top,
                margin: 0,
                width: dr.size.w,
                height: dr.size.h,
                maxHeight: "none",
                maxWidth: "none",
              }
            : {}),
        }}
      >
        {draggable ? (
          <div
            {...dr.resizeHandlers}
            className="dr-se"
            aria-hidden
            title="Drag to resize"
          />
        ) : null}
        <div
          {...dr.dragHandlers}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "15px 18px",
            borderBottom: "1px solid var(--g200)",
            userSelect: "none",
            ...dr.dragHandlers.style,
          }}
        >
          <h3 style={{ fontSize: 15, fontWeight: 600 }}>{title}</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              border: "none",
              background: "transparent",
              lineHeight: 1,
              cursor: "pointer",
              color: "var(--g500)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <IconX size={18} />
          </button>
        </div>
        <div
          style={{
            padding: "16px 18px",
            overflowY: "auto",
            flex: 1,
            minHeight: 0,
            ...(bodyStyle || {}),
          }}
        >
          {children}
        </div>
        {footer ? (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              padding: "12px 18px",
              borderTop: "1px solid var(--g200)",
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
