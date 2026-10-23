// Presenter Mode — background segmentation via MediaPipe Tasks Vision. This is
// the same engine LiveKit's own @livekit/track-processors ships, so it is
// production-proven inside this exact stack. The runtime + model are loaded
// lazily (code-split) and served locally from /public/mediapipe — no CDN, which
// keeps it working under the frontend CSP and offline in Electron.
//
// The public surface is intentionally tiny: `updateMask()` runs the segmenter
// and leaves a feathered, temporally-smoothed alpha mask on `maskCanvas`. The
// processor composites with it via `globalCompositeOperation = "destination-in"`.

import type { ImageSegmenter as MPImageSegmenter } from "@mediapipe/tasks-vision";
import { PRESENTER_ASSET_BASE } from "./types";

export interface Segmenter {
  /** Run segmentation for the current camera frame (best-effort; no-op until ready). */
  updateMask: (video: HTMLVideoElement, timestampMs: number) => void;
  /** Alpha-encoded person mask at model resolution (white where person, feathered). */
  readonly maskCanvas: HTMLCanvasElement;
  readonly ready: boolean;
  close: () => void;
}

// Temporal smoothing: blend each new mask with the previous frame to kill the
// boundary jitter that otherwise reads as flicker. Lowered from 0.5 → 0.35: at
// 0.5 a fast-moving hand left a visible ghost trail (the old mask lingered);
// 0.35 tracks motion much more closely while the edge feather below keeps the
// stationary boundary smooth. 0 = no smoothing, →1 = sticky.
const EMA = 0.35;
// Edge feather radius (px, at model resolution) applied as a SEPARATE blur pass
// on the finished matte — softens the cutout boundary (hair/shoulders) without
// the white-fog artifact (that bug was ctx.filter DURING destination-in; a
// plain source-over blur of a black-RGB matte is safe). Bumped 1.1 → 2.6 for a
// softer, more gradual blend into the shared screen (the matte stays crisp-black
// so a wider blur only feathers the alpha edge — no colour halo re-appears).
const FEATHER_PX = 2.6;

export async function createSegmenter(
  assetBase: string = PRESENTER_ASSET_BASE,
): Promise<Segmenter> {
  const { FilesetResolver, ImageSegmenter } = await import(
    "@mediapipe/tasks-vision"
  );
  const fileset = await FilesetResolver.forVisionTasks(`${assetBase}/wasm`);

  const build = (delegate: "GPU" | "CPU") =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: `${assetBase}/selfie_segmenter.tflite`,
        delegate,
      },
      runningMode: "VIDEO",
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });

  let segmenter: MPImageSegmenter;
  try {
    segmenter = await build("GPU");
  } catch {
    // Blocklisted GPU / no WebGL — fall back to the WASM-SIMD CPU path.
    segmenter = await build("CPU");
  }

  const maskCanvas = document.createElement("canvas");
  const mctx = maskCanvas.getContext("2d")!;
  // The crisp matte is built here, then feathered into maskCanvas.
  const rawCanvas = document.createElement("canvas");
  const rctx = rawCanvas.getContext("2d")!;
  let smooth: Float32Array | null = null; // persisted EMA buffer
  let orientScore = 0; // persisted mask-polarity estimate (see auto-orient below)
  let cachedImg: ImageData | null = null; // reused matte buffer (see below)
  let ready = true;

  const updateMask = (video: HTMLVideoElement, timestampMs: number) => {
    if (!ready || video.readyState < 2 || !video.videoWidth) return;
    try {
      segmenter.segmentForVideo(video, timestampMs, (result) => {
        const mask = result.confidenceMasks && result.confidenceMasks[0];
        if (!mask) return;
        const w = mask.width;
        const h = mask.height;
        // Copy out — MediaPipe frees the mask after this callback returns.
        const cur = mask.getAsFloat32Array();
        if (!smooth || smooth.length !== cur.length) {
          smooth = new Float32Array(cur); // seed on first frame / size change
        } else {
          const sm = smooth;
          for (let i = 0; i < cur.length; i++) {
            sm[i] = sm[i] * EMA + cur[i] * (1 - EMA);
          }
        }
        // Auto-orient the mask polarity. MediaPipe's selfie variants disagree on
        // whether the confidence mask marks the PERSON or the BACKGROUND as
        // "high" (the square model's confidenceMasks[0] is background-weighted),
        // so a hard-coded index silently inverts the cutout on some models.
        // Detect it instead: a webcam subject sits centre-bottom while the
        // background fills the corners — whichever scores higher there defines
        // "high". EMA-smoothed so the decision can't flip frame-to-frame.
        let cSum = 0,
          cN = 0,
          kSum = 0,
          kN = 0;
        const cx0 = (w * 0.35) | 0,
          cx1 = (w * 0.65) | 0;
        const cy0 = (h * 0.5) | 0,
          cy1 = (h * 0.9) | 0;
        for (let y = cy0; y < cy1; y += 4)
          for (let x = cx0; x < cx1; x += 4) {
            cSum += cur[y * w + x];
            cN++;
          }
        const kw = Math.max(2, (w * 0.12) | 0);
        const kh = Math.max(2, (h * 0.12) | 0);
        const corners = [
          [0, 0],
          [w - kw, 0],
          [0, h - kh],
          [w - kw, h - kh],
        ];
        for (const [bx, by] of corners)
          for (let y = by; y < by + kh; y += 4)
            for (let x = bx; x < bx + kw; x += 4) {
              kSum += cur[y * w + x];
              kN++;
            }
        orientScore =
          orientScore * 0.9 +
          ((cN ? cSum / cN : 0) - (kN ? kSum / kN : 0)) * 0.1;
        const personIsHigh = orientScore >= 0;

        if (maskCanvas.width !== w || maskCanvas.height !== h) {
          maskCanvas.width = w;
          maskCanvas.height = h;
          rawCanvas.width = w;
          rawCanvas.height = h;
        }
        // Reuse the matte buffer across frames — every pixel's RGBA is fully
        // overwritten by the loop below, so there's no stale data. Allocating a
        // fresh ImageData every frame churned ~0.5MB/frame (≈18MB/s at 30fps),
        // whose GC pauses showed up as periodic composite hitches.
        if (!cachedImg || cachedImg.width !== w || cachedImg.height !== h) {
          cachedImg = rctx.createImageData(w, h);
        }
        const img = cachedImg;
        const d = img.data;
        const s = smooth;
        for (let i = 0, p = 0; i < s.length; i++, p += 4) {
          let v = personIsHigh ? s[i] : 1 - s[i];
          // Crisp the matte: push ambiguous mid-confidence toward fully-in or
          // fully-out (smoothstep over a narrow band) so the person is solid and
          // the background is gone — this removes the foggy semi-transparent halo
          // around the head/hair that otherwise ghosts over the content.
          v = v <= 0.4 ? 0 : v >= 0.62 ? 1 : (v - 0.4) / 0.22;
          const a = v * v * (3 - 2 * v);
          // RGB is irrelevant for destination-in (result takes the camera's RGB),
          // but keep it black so any partial-alpha edge pixel that ever leaks is
          // invisible over content rather than a white halo.
          d[p] = 0;
          d[p + 1] = 0;
          d[p + 2] = 0;
          d[p + 3] = (a * 255) | 0;
        }
        rctx.putImageData(img, 0, 0);
        // Feather the boundary: a plain source-over blur of the crisp matte.
        // Safe (unlike the old filter-during-destination-in) because the matte
        // is black-RGB — only its alpha edge is softened, no colour to leak.
        mctx.clearRect(0, 0, w, h);
        (mctx as any).filter = `blur(${FEATHER_PX}px)`;
        mctx.drawImage(rawCanvas, 0, 0);
        (mctx as any).filter = "none";
      });
    } catch {
      // A transient segmentation failure must never break the composite loop —
      // the processor falls back to the last mask (or raw camera).
    }
  };

  return {
    updateMask,
    maskCanvas,
    get ready() {
      return ready;
    },
    close() {
      ready = false;
      try {
        segmenter.close();
      } catch {
        /* already closed */
      }
    },
  };
}
