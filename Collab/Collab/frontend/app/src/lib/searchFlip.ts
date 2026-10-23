"use client";
// Dashboard → Search "morph" hand-off (GSAP Flip: https://gsap.com/docs/v3/Plugins/Flip/).
//
// The dashboard's search pill and the Search page's search bar are two
// different DOM elements in two components that are NEVER mounted at the same
// time — CoLabShell swaps one view for the other. Flip only needs a captured
// rect+style SNAPSHOT to animate FROM, not the original element, so the
// dashboard captures its bar's state right before navigating away and stashes
// it here; the Search page's mount effect picks it up and Flip.from()s its
// own bar into place, reading as one continuous pill growing/moving into its
// new position rather than a hard cut between two screens. A single in-memory
// slot is enough — only one Search entrance is ever in flight at a time.
import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { useGSAP } from "@gsap/react";

gsap.registerPlugin(Flip, useGSAP);

let pending: Flip.FlipState | null = null;

export function captureSearchBarFlip(el: HTMLElement | null): void {
  if (!el) return;
  pending = Flip.getState(el, { props: "borderRadius" });
}

export function consumeSearchBarFlip(): Flip.FlipState | null {
  const state = pending;
  pending = null;
  return state;
}

export { Flip };
