import React, { useRef, useEffect, useState, useCallback, isValidElement } from "react";
import { createPortal } from "react-dom";
import { calculatePosition, type Placement, type PositionOptions } from "../lib/positioning";
import { useEsc } from "../lib/escStack";

interface MenuItem {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  // Soft-disabled: looks disabled (greyed, not-allowed, no hover) but STILL fires
  // onClick — so the handler can explain WHY the action is unavailable (e.g. "no
  // messages to mark as unread") instead of the control silently doing nothing.
  muted?: boolean;
  shortcut?: string;
}

interface FloatingMenuProps {
  trigger: React.ReactElement<HTMLButtonElement>;
  items: MenuItem[];
  placement?: Placement;
  offset?: number;
  onClose?: () => void;
  className?: string;
}

export default function FloatingMenu({
  trigger,
  items,
  placement = "bottom-start",
  offset = 8,
  onClose,
  className = "",
}: FloatingMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  const updatePosition = useCallback(() => {
    if (!triggerElementRef.current || !menuRef.current) return;
    const triggerRect = triggerElementRef.current.getBoundingClientRect();
    const contentRect = menuRef.current.getBoundingClientRect();
    const result = calculatePosition({
      triggerRect,
      contentRect,
      placement,
      offset,
      flip: true,
      shift: true,
      padding: 8,
    });
    setPosition({ top: result.top, left: result.left });
  }, [placement, offset]);

  // Esc closes the menu via the app-wide LIFO stack (user-action based) so it
  // consumes the keypress — only the topmost overlay closes and module Back never
  // fires on the same Esc. Registered only while open.
  useEsc(isOpen, () => {
    setIsOpen(false);
    onClose?.();
  });

  useEffect(() => {
    if (isOpen) {
      updatePosition();
      window.addEventListener("resize", updatePosition);
      window.addEventListener("scroll", updatePosition, { capture: true, passive: true });
      document.addEventListener("click", handleOutsideClick);
    }
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("click", handleOutsideClick);
    };
  }, [isOpen, updatePosition]);

  const handleOutsideClick = (e: MouseEvent) => {
    if (triggerElementRef.current?.contains(e.target as Node)) return;
    if (menuRef.current?.contains(e.target as Node)) return;
    setIsOpen(false);
    onClose?.();
  };

  const handleTriggerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen((prev) => !prev);
  };

  const handleItemClick = (e: React.MouseEvent, item: MenuItem) => {
    // CRITICAL: the menu is rendered through a body portal (createPortal below),
    // but React synthetic events bubble through the COMPONENT tree, not the DOM.
    // Without this, a click on a menu item also bubbles to the element the menu
    // was opened from (e.g. a conversation row's onClick→onSelect), which then
    // undoes the action — this is what made "Mark as unread" silently re-mark
    // the row as read. Stop it so a menu item only ever runs its own action.
    e.stopPropagation();
    if (item.disabled) return;
    item.onClick();
    setIsOpen(false);
    onClose?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setIsOpen(false);
      onClose?.();
    }
  };

  // WAI-ARIA menu keyboard pattern: arrow/Home/End move a roving focus between
  // items; Escape closes and returns focus to the trigger.
  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const btns = menuRef.current
      ? (Array.from(menuRef.current.querySelectorAll(".fm-item:not([disabled])")) as HTMLElement[])
      : [];
    if (!btns.length) return;
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); btns[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); btns[btns.length - 1].focus(); }
    else if (e.key === "Escape") { e.preventDefault(); setIsOpen(false); onClose?.(); triggerElementRef.current?.focus(); }
  };

  // Move focus into the menu (first enabled item) once it opens + is positioned.
  useEffect(() => {
    if (!isOpen || !position) return;
    const first = menuRef.current?.querySelector(".fm-item:not([disabled])") as HTMLElement | null;
    first?.focus();
  }, [isOpen, position]);

  const triggerElement = trigger as React.ReactElement<HTMLButtonElement>;
  const triggerProps = { ...triggerElement.props } as unknown as React.ButtonHTMLAttributes<HTMLButtonElement>;
  const triggerElementRefProp = (triggerElement as any).ref as React.Ref<HTMLButtonElement> | undefined;
  const wrappedTrigger = React.createElement(
    "button",
    {
      ...triggerProps,
      ref: (el: HTMLButtonElement | null) => {
        triggerElementRef.current = el;
        if (triggerElementRefProp) {
          if (typeof triggerElementRefProp === "function") {
            triggerElementRefProp(el);
          } else if (typeof triggerElementRefProp === "object") {
            (triggerElementRefProp as React.MutableRefObject<HTMLButtonElement | null>).current = el;
          }
        }
      },
      onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
        handleTriggerClick(e);
        triggerProps.onClick?.(e);
      },
      onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
        handleKeyDown(e);
        triggerProps.onKeyDown?.(e);
      },
      "aria-haspopup": "menu",
      "aria-expanded": isOpen,
    }
  );

  // The menu renders into a body portal so it can never be clipped by an
  // ancestor's overflow/transform and is always positioned against the viewport.
  const menu = isOpen ? (
        <div
          ref={menuRef}
          className={`fm-menu ${className}`}
          style={{
            position: "fixed",
            top: position ? position.top : -9999,
            left: position ? position.left : -9999,
            visibility: position ? "visible" : "hidden",
            zIndex: 1000,
            background: "var(--sb)",
            border: "1px solid var(--g200)",
            borderRadius: "var(--rsm)",
            boxShadow: "var(--shl)",
            minWidth: 180,
            maxWidth: 280,
            overflow: "hidden",
            animation: "fm-slide-in 0.12s ease-out",
          }}
          role="menu"
          onKeyDown={handleMenuKeyDown}
        >
          <style jsx>{`
            @keyframes fm-slide-in {
              from { opacity: 0; transform: translateY(-4px); }
              to { opacity: 1; transform: translateY(0); }
            }
          `}</style>
          {items.map((item, index) => (
            <button
              key={index}
              className="fm-item"
              onClick={(e) => handleItemClick(e, item)}
              disabled={item.disabled}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                border: "none",
                background: "transparent",
                color: item.danger ? "var(--red)" : "var(--g700)",
                fontSize: 13,
                fontWeight: item.disabled || item.muted ? 400 : 500,
                cursor: item.disabled || item.muted ? "not-allowed" : "pointer",
                textAlign: "left",
                transition: "background 0.1s, color 0.1s",
                opacity: item.disabled || item.muted ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (!item.disabled && !item.muted) e.currentTarget.style.background = "var(--g100)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
              role="menuitem"
            >
              {item.icon && <span style={{ display: "flex", width: 18, height: 18 }}>{item.icon}</span>}
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.shortcut && (
                <span style={{ fontSize: 11, color: "var(--g400)", fontFamily: "monospace" }}>{item.shortcut}</span>
              )}
            </button>
          ))}
        </div>
  ) : null;

  return (
    <>
      {wrappedTrigger}
      {menu && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
    </>
  );
}