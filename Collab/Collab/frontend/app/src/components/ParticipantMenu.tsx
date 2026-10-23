import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { calculatePosition } from "../lib/positioning";
import { useEsc } from "../lib/escStack";
import {
  IconMicOff,
  IconUserPlus,
  IconUserMinus,
  IconUser,
  IconMessageSquare,
  IconX,
} from "../lib/icons";

/*
 * ParticipantMenu — the ONE per-participant overflow (⋮) menu shared by every
 * participant surface across Calls, Group Calls and Meetings (web + desktop).
 *
 * Why a controlled/imperative primitive (not FloatingMenu):
 *  - Meeting + call tiles are built as imperative DOM (document.createElement),
 *    so there is no React `trigger` element to wrap. This menu is opened by
 *    calling open(anchorEl, actions) from either a React handler OR raw DOM code.
 *  - It portals to <body> so a tile's `overflow:hidden` can never clip it, and it
 *    sits at --z-menu (above the full-screen call band, below modals) so it is
 *    always reachable — over the whiteboard, the dock, and the call stage alike.
 *
 * RBAC: callers pass ONLY the handlers + capability flags that apply, so
 * unavailable actions are HIDDEN (never rendered disabled) — see buildParticipantActions.
 */

export interface ParticipantAction {
  key: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

// Raw SVG for the ⋮ trigger so imperative (non-React) tile code can render the
// SAME glyph as the React surfaces via innerHTML — keeps calls/meetings identical.
export const PARTICIPANT_MENU_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
  'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>';

export interface BuildActionsCtx {
  /** The target tile is the local user (self). */
  isSelf: boolean;
  /** Viewer may mute/remove this participant (host / co-host / admin). */
  canManage: boolean;
  /** Viewer may promote/demote co-hosts (host/owner only). */
  canPromote: boolean;
  /** The target participant is already a co-host (→ offer Demote, not Promote). */
  targetIsCoHost?: boolean;
  onMute?: () => void;
  onRemove?: () => void;
  onPromote?: () => void;
  onDemote?: () => void;
  onViewProfile?: () => void;
  onMessage?: () => void;
  labels?: Partial<
    Record<
      "mute" | "remove" | "promote" | "demote" | "profile" | "message",
      string
    >
  >;
}

/*
 * Role-aware action list. HIDE actions the viewer can't use (never render them
 * disabled): callers pass only the handlers + capability flags that apply and
 * this returns exactly the visible set — identical rules for calls, group calls
 * and meetings. Order: view controls → moderation → social → destructive (last).
 */
export function buildParticipantActions(ctx: BuildActionsCtx): ParticipantAction[] {
  const out: ParticipantAction[] = [];
  const L = ctx.labels || {};

  // NB: Pin ("Pin for me") is intentionally NOT in this menu. Every participant
  // surface (video tiles + the People roster, on both calls and meetings) now
  // carries a DIRECT pin button, so listing it here too was a duplicate. The ⋮
  // menu is moderation/social only; callers HIDE it entirely when this returns
  // an empty list (e.g. a non-host viewer) rather than opening a dead menu.

  if (!ctx.isSelf) {
    if (ctx.canManage && ctx.onMute) {
      out.push({ key: "mute", label: L.mute || "Mute", icon: <IconMicOff size={16} />, onSelect: ctx.onMute });
    }
    if (ctx.canPromote && ctx.onDemote && ctx.targetIsCoHost) {
      out.push({ key: "demote", label: L.demote || "Remove co-host", icon: <IconUserMinus size={16} />, onSelect: ctx.onDemote });
    } else if (ctx.canPromote && ctx.onPromote && !ctx.targetIsCoHost) {
      out.push({ key: "promote", label: L.promote || "Make co-host", icon: <IconUserPlus size={16} />, onSelect: ctx.onPromote });
    }
    if (ctx.onViewProfile) {
      out.push({ key: "profile", label: L.profile || "View profile", icon: <IconUser size={16} />, onSelect: ctx.onViewProfile });
    }
    if (ctx.onMessage) {
      out.push({ key: "message", label: L.message || "Message privately", icon: <IconMessageSquare size={16} />, onSelect: ctx.onMessage });
    }
    if (ctx.canManage && ctx.onRemove) {
      out.push({ key: "remove", label: L.remove || "Remove", icon: <IconX size={16} />, danger: true, onSelect: ctx.onRemove });
    }
  } else if (ctx.onViewProfile) {
    out.push({ key: "profile", label: L.profile || "View profile", icon: <IconUser size={16} />, onSelect: ctx.onViewProfile });
  }

  return out;
}

interface MenuState {
  anchor: HTMLElement;
  actions: ParticipantAction[];
  title?: string;
}

/*
 * useParticipantMenu — render {menu} ONCE inside a stage, then open it from any
 * tile/panel ⋮ button via open(anchorEl, actions, title). Re-opening on the same
 * anchor toggles it closed. Both the meeting stage and the call stage use this.
 */
export function useParticipantMenu() {
  const [state, setState] = useState<MenuState | null>(null);

  const open = useCallback((anchor: HTMLElement, actions: ParticipantAction[], title?: string) => {
    if (!actions.length) return;
    setState((prev) => (prev && prev.anchor === anchor ? null : { anchor, actions, title }));
  }, []);

  const close = useCallback(() => setState(null), []);

  const menu = state ? (
    <ParticipantMenuPortal anchor={state.anchor} actions={state.actions} title={state.title} onClose={close} />
  ) : null;

  return { open, close, menu, isOpen: !!state };
}

function ParticipantMenuPortal({
  anchor,
  actions,
  title,
  onClose,
}: MenuState & { onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    if (!menuRef.current) return;
    // The tile the menu was opened from can unmount (participant leaves, layout
    // re-flows) — close rather than float a menu anchored to nothing.
    if (!anchor.isConnected) {
      onClose();
      return;
    }
    const r = calculatePosition({
      triggerRect: anchor.getBoundingClientRect(),
      contentRect: menuRef.current.getBoundingClientRect(),
      placement: "bottom-end",
      offset: 6,
      flip: true,
      shift: true,
      padding: 8,
    });
    setPos({ top: r.top, left: r.left });
  }, [anchor, onClose]);

  // Esc closes THIS menu via the app-wide LIFO stack (user-action based): the
  // topmost overlay consumes the keypress so a module "Back" never fires on the
  // same Esc, and focus returns to the ⋮ trigger it was opened from. (Was on the
  // legacy colab:esc bus WITHOUT consuming, so Esc also navigated the module back.)
  useEsc(true, () => {
    onClose();
    anchor.focus?.();
  });

  useEffect(() => {
    reposition();
    const onDocDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (anchor.contains(e.target as Node)) return; // the ⋮ trigger toggles itself
      onClose();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, { capture: true, passive: true });
    document.addEventListener("mousedown", onDocDown, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("mousedown", onDocDown, true);
    };
  }, [reposition, anchor, onClose]);

  // Roving focus into the menu once positioned (WAI-ARIA menu pattern).
  useEffect(() => {
    if (!pos) return;
    (menuRef.current?.querySelector(".pm-item") as HTMLElement | null)?.focus();
  }, [pos]);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const btns = menuRef.current
      ? (Array.from(menuRef.current.querySelectorAll(".pm-item")) as HTMLElement[])
      : [];
    if (!btns.length) return;
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      btns[i < 0 ? 0 : (i + 1) % btns.length].focus();
    } else if (e.key === "ArrowUp") {
      // From "no item focused" (i === -1), ArrowUp wraps to the LAST item — the
      // bare modulo would land on length-2 and skip it.
      e.preventDefault();
      btns[i < 0 ? btns.length - 1 : (i - 1 + btns.length) % btns.length].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      btns[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      btns[btns.length - 1].focus();
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      className="pm-menu"
      role="menu"
      aria-label={title || "Participant actions"}
      onKeyDown={onMenuKey}
      style={{
        position: "fixed",
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {title ? <div className="pm-title">{title}</div> : null}
      {actions.map((a) => (
        <button
          key={a.key}
          className={"pm-item" + (a.danger ? " danger" : "")}
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation();
            a.onSelect();
            onClose();
          }}
        >
          {a.icon ? <span className="pm-item-ic">{a.icon}</span> : null}
          <span className="pm-item-label">{a.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
