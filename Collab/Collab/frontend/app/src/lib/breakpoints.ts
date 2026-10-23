/**
 * Responsive breakpoints — the JS mirror of the reference in styles/tokens.css.
 * v1.css currently uses ~20 ad-hoc max-width values; new and redesigned code
 * should use these three so Web / Desktop / Mobile collapse at the same points.
 */
export const BP = {
  /** Phone: single pane (list OR detail), call dock collapses to icons. */
  sm: 640,
  /** Tablet: meeting dock collapses, side panels overlay instead of docking. */
  md: 980,
  /** Small desktop: optional side panels may collapse. */
  lg: 1180,
} as const;

export const mqMaxSm = `(max-width: ${BP.sm}px)`;
export const mqMaxMd = `(max-width: ${BP.md}px)`;
export const mqMaxLg = `(max-width: ${BP.lg}px)`;

export function matches(query: string): boolean {
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches;
}

/** True on touch-first devices (no hover). */
export function isCoarsePointer(): boolean {
  return matches("(pointer: coarse)");
}
