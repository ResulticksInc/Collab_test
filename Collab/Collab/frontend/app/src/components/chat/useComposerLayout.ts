// useComposerLayout — Teams-style adaptive composer row.
//
// Default is the compact single-line layout: editor and action icons share one
// row. As soon as the typed text wraps to a second line, or a single line grows
// long enough that it would run into the icon cluster, the row switches to the
// "stacked" layout (editor on top, icons anchored on their own bottom row).
// Deleting text so it fits on one line again returns the row to single-line.
//
// The same predicate is used in both layouts so the row can't oscillate: a
// one-liner only counts as fitting when its measured width is narrower than the
// space left beside the icons, which is exactly the width it gets once inline.
import { useEffect, useState, type RefObject } from "react";

// Extra room (px) kept between the end of the text and the icon cluster before
// the row is considered "reached".
const ICON_SLACK = 16;

export function useComposerLayout(
  rowRef: RefObject<HTMLElement | null>,
  text: string,
  deps: unknown[] = [],
): boolean {
  const [stacked, setStacked] = useState(false);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    const measure = () => {
      const ed = row.querySelector<HTMLElement>(".tiptap-editor");
      const bar = row.querySelector<HTMLElement>(".ci-row-actions");
      if (!ed || !bar) {
        setStacked(false);
        return;
      }
      const cs = getComputedStyle(ed);
      const padY =
        (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const lineH =
        parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.5;
      const contentH = ed.scrollHeight - padY;
      // An EMPTY editor never needs the stacked layout. Its placeholder can wrap
      // when the row is narrow (e.g. the details panel is open), which used to flip
      // stacked on/off forever (the row changes width each time) — a visible glitch.
      const hasText = (ed.textContent || "").trim().length > 0;
      if (!hasText) {
        setStacked(false);
        return;
      }
      const multiLine = contentH > lineH * 1.5;

      // Width of the rendered text on that single line. Measure the CONTENTS of
      // each block (paragraph) rather than the block itself: a block's own rect
      // is always the full editor width, the inline contents give the real
      // extent of the text.
      let textW = 0;
      if (!multiLine && (ed.textContent || "").length) {
        const blocks = ed.children.length ? Array.from(ed.children) : [ed];
        for (const b of blocks) {
          const range = document.createRange();
          range.selectNodeContents(b);
          textW = Math.max(textW, range.getBoundingClientRect().width);
        }
      }

      const rcs = getComputedStyle(row);
      const rowInner =
        row.clientWidth -
        (parseFloat(rcs.paddingLeft) || 0) -
        (parseFloat(rcs.paddingRight) || 0);
      const available = rowInner - bar.offsetWidth - ICON_SLACK;

      setStacked(multiLine || textW > available);
    };

    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(row);
    const ed = row.querySelector<HTMLElement>(".tiptap-editor");
    if (ed) ro.observe(ed);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowRef, text, ...deps]);

  return stacked;
}
