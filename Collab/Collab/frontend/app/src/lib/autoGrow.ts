import { useEffect, RefObject } from "react";

// Auto-grow a <textarea> so a description / notes box ENLARGES as you type
// instead of staying a fixed-height scroller — the premium "it grows with your
// text" feel. Capped so it never dominates the panel (scrolls past the cap).
// Controlled-textarea friendly: pass the current value so it re-measures on
// every change, including programmatic resets (switching records, clearing).
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  opts: { min?: number; max?: number } = {},
) {
  const min = opts.min ?? 64;
  const max = opts.max ?? 360;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto"; // reset so scrollHeight reflects content, not the prior height
    const next = Math.min(Math.max(el.scrollHeight, min), max);
    el.style.height = next + "px";
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [ref, value, min, max]);
}
