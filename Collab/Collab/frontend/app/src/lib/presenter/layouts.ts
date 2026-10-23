// Presenter Mode — layout registry. Each mode is a pure placement spec in
// normalized [0..1] canvas coordinates; the processor scales these to pixels and
// draws content (letterboxed, never cropped) and the camera (cover-cropped, or a
// segmented cutout). New layouts drop in here without touching the pipeline.

import type { PresenterMode } from "./types";

export interface NRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutSpec {
  /** Remove the camera background (person cutout) instead of a framed rectangle. */
  segmented: boolean;
  /** Content region — the shared screen / window / tab / whiteboard. */
  content: NRect;
  /** Camera region. */
  camera: NRect;
  /** Corner radius (px at output scale) for framed (non-segmented) cameras. */
  cameraRadius: number;
}

// Returns null for "standard" — there is no composite; the processor is detached
// and the raw screen track is published as-is.
export function layoutFor(mode: PresenterMode): LayoutSpec | null {
  switch (mode) {
    case "presenter":
      // Content full-bleed; the segmented presenter stands bottom-right, tall
      // enough to read as a person without covering the middle of the content.
      return {
        segmented: true,
        content: { x: 0, y: 0, w: 1, h: 1 },
        camera: { x: 0.6, y: 0.28, w: 0.4, h: 0.72 },
        cameraRadius: 0,
      };
    case "sidebyside":
      // Content left, a full camera panel right. Balanced for teaching.
      return {
        segmented: false,
        content: { x: 0.012, y: 0.06, w: 0.63, h: 0.88 },
        camera: { x: 0.66, y: 0.06, w: 0.328, h: 0.88 },
        cameraRadius: 20,
      };
    case "spotlight":
      // Content primary; a small framed camera floats bottom-left.
      return {
        segmented: false,
        content: { x: 0, y: 0, w: 1, h: 1 },
        camera: { x: 0.024, y: 0.64, w: 0.2, h: 0.32 },
        cameraRadius: 18,
      };
    case "standard":
    default:
      return null;
  }
}
