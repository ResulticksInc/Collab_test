// ─────────────────────────────────────────────────────────────────────────────
// Central LIFO stack — the single source of truth for "who owns Escape right now".
//
// The app historically dispatched a broadcast `colab:esc` event: EVERY listener
// ran, so multiple open overlays all closed on one Esc (and if none consumed, the
// global Back navigated the user out of the module). This stack fixes that: an
// overlay pushes a close-handler when it OPENS and pops when it closes, so the
// stack order equals the visual open order. On Escape the global handler runs ONLY
// the top handler (the most-recently-opened overlay) and stops; Back fires only
// when the stack is empty AND no legacy `colab:esc` listener consumed.
//
// Registering on OPEN (not on mount) is what makes top-of-stack === topmost layer.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useRef } from "react";

type EscHandler = () => void;

const stack: EscHandler[] = [];

/** Push a close-handler; returns an unregister fn. Being on the stack means "I own Esc". */
export function pushEsc(handler: EscHandler): () => void {
  stack.push(handler);
  return () => {
    // lastIndexOf so the MOST-recent registration of this handler is removed
    // (correct even if the same identity registers twice across a fast re-open).
    const i = stack.lastIndexOf(handler);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Run the topmost handler. Returns true if one existed (Esc was consumed). */
export function runTopEsc(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top();
  return true;
}

/** Number of overlays currently claiming Esc. */
export function escStackDepth(): number {
  return stack.length;
}

/**
 * React hook: while `active`, this overlay is on the Esc stack and its `onEsc`
 * runs first when Escape is pressed. The handler is kept in a ref so a changing
 * closure identity doesn't churn the stack registration (which would reorder it).
 */
export function useEsc(active: boolean, onEsc: () => void): void {
  const cb = useRef(onEsc);
  cb.current = onEsc;
  useEffect(() => {
    if (!active) return;
    return pushEsc(() => cb.current());
  }, [active]);
}
