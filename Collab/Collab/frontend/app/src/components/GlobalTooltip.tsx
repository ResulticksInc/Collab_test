"use client";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Portaled, viewport-aware replacement for the CSS `[data-tip]::after` tooltip.
// The CSS pseudo-element could never escape an overflow:hidden/auto ancestor —
// the recurring "clipped tooltip" bug (e.g. the Reminders "…" tip). This renders
// the tip to <body> with position:fixed, shows it on hover AND keyboard focus
// (a11y), flips above/below by available room, and clamps horizontally by its
// measured width so it can never leave the viewport. Mounted once, app-wide.
type Tip = { text: string; x: number; y: number; place: "top" | "bottom" | "right" };

export default function GlobalTooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    let cur: Element | null = null;

    const tipEl = (n: EventTarget | null): Element | null => {
      const el = n as Element | null;
      return el && (el as any).closest ? el.closest("[data-tip]") : null;
    };
    const showFor = (el: Element) => {
      const text = el.getAttribute("data-tip");
      if (!text) { setTip(null); return; }
      const r = el.getBoundingClientRect();
      // Left rail/sidebar: a vertical icon strip where an above/below tip would
      // cover the neighbouring button. Place the tip to the RIGHT of the button,
      // vertically centred on it, so it never overlaps its neighbours.
      const railEl = (el as any).closest ? el.closest("#rail") : null;
      if (railEl) {
        // Start the tip exactly at the rail's RIGHT EDGE — the layering/divider
        // line — instead of a fixed offset from the icon, so it reads as attached
        // to the divider rather than floating in the rail's padding.
        const railRight = railEl.getBoundingClientRect().right;
        // EXCEPT the collapse/expand handle, which STRADDLES the divider: anchoring
        // it at railRight would start the tip over the button's own right half
        // (the "Collapse" tip overlapping the toggle). Anchor it just past the
        // button's own right edge so it sits cleanly beside the handle instead.
        const isHandle = (el as any).matches && (el as any).matches(".rl-collapse");
        const x = isHandle ? r.right + 8 : railRight;
        setTip({ text, x, y: r.top + r.height / 2, place: "right" });
        return;
      }
      const place: "top" | "bottom" = r.top < 48 ? "bottom" : "top";
      setTip({
        text,
        x: r.left + r.width / 2,
        y: place === "bottom" ? r.bottom + 6 : r.top - 6,
        place,
      });
    };
    const clear = () => { cur = null; setTip(null); };

    const onOver = (e: Event) => {
      const el = tipEl(e.target);
      if (el && el !== cur) { cur = el; showFor(el); }
    };
    const onOut = (e: Event) => {
      if (!tipEl((e as MouseEvent).relatedTarget)) clear();
    };
    const onFocusIn = (e: Event) => {
      const el = tipEl(e.target);
      if (el) { cur = el; showFor(el); } else clear();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") clear(); };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", clear);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", clear);
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // Clamp horizontally by measured width so the centered tooltip never clips.
  // The right-placed (rail) tip is anchored by its LEFT edge to the button's right
  // side — it isn't centered, so skip the centering clamp and keep its left as-is.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    if (tip.place === "right") { el.style.left = tip.x + "px"; return; }
    const half = el.offsetWidth / 2;
    const m = 8;
    let x = tip.x;
    if (x - half < m) x = m + half;
    else if (x + half > window.innerWidth - m) x = window.innerWidth - m - half;
    el.style.left = x + "px";
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      className={"gtt gtt-" + tip.place}
      role="tooltip"
      style={{ position: "fixed", left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
