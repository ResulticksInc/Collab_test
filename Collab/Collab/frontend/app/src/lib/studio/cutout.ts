// One-shot background removal for the sticker studio ("make sticker from photo",
// WhatsApp/Instagram-style). Reuses the SAME locally-served MediaPipe assets as
// Presenter Mode (/public/mediapipe — no CDN, works offline in Electron), but in
// IMAGE running-mode against a single still frame instead of a live video track.
//
// Public surface is one function: cutoutPerson(source) -> a new canvas the size
// of the source with the person kept and the background made transparent. The
// model + wasm load lazily on first use and the segmenter is cached process-wide.

import { PRESENTER_ASSET_BASE } from "../presenter/types";

let segmenterPromise: Promise<any> | null = null;

async function getSegmenter(): Promise<any> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import(
        "@mediapipe/tasks-vision"
      );
      const fileset = await FilesetResolver.forVisionTasks(
        `${PRESENTER_ASSET_BASE}/wasm`,
      );
      const build = (delegate: "GPU" | "CPU") =>
        ImageSegmenter.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: `${PRESENTER_ASSET_BASE}/selfie_segmenter.tflite`,
            delegate,
          },
          runningMode: "IMAGE",
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      try {
        return await build("GPU");
      } catch {
        // Blocklisted GPU / no WebGL — fall back to the WASM-SIMD CPU path.
        return await build("CPU");
      }
    })();
    // If loading fails, clear the cache so a later attempt can retry.
    segmenterPromise.catch(() => {
      segmenterPromise = null;
    });
  }
  return segmenterPromise;
}

// Decide whether the confidence mask marks the PERSON or the BACKGROUND as
// "high". MediaPipe's selfie variants disagree, so we detect it: a photographed
// subject sits centre-frame while the background fills the corners — whichever
// scores higher there defines "person". (Same heuristic Presenter Mode uses.)
function personIsHigh(mask: Float32Array, w: number, h: number): boolean {
  let cSum = 0,
    cN = 0,
    kSum = 0,
    kN = 0;
  const cx0 = (w * 0.3) | 0,
    cx1 = (w * 0.7) | 0;
  const cy0 = (h * 0.25) | 0,
    cy1 = (h * 0.85) | 0;
  for (let y = cy0; y < cy1; y += 3)
    for (let x = cx0; x < cx1; x += 3) {
      cSum += mask[y * w + x];
      cN++;
    }
  const kw = Math.max(2, (w * 0.14) | 0);
  const kh = Math.max(2, (h * 0.14) | 0);
  const corners = [
    [0, 0],
    [w - kw, 0],
    [0, h - kh],
    [w - kw, h - kh],
  ];
  for (const [bx, by] of corners)
    for (let y = by; y < by + kh; y += 3)
      for (let x = bx; x < bx + kw; x += 3) {
        kSum += mask[y * w + x];
        kN++;
      }
  return (cN ? cSum / cN : 0) >= (kN ? kSum / kN : 0);
}

export type CutoutSource =
  | HTMLCanvasElement
  | HTMLImageElement
  | ImageBitmap;

// Returns a NEW canvas (same pixel size as the source) with the detected person
// kept and everything else transparent. Rejects if the model can't load or no
// mask is produced — callers should fall back to the un-cut image.
export async function cutoutPerson(
  source: CutoutSource,
): Promise<HTMLCanvasElement> {
  const seg = await getSegmenter();
  const w =
    (source as HTMLImageElement).naturalWidth ||
    (source as HTMLCanvasElement).width ||
    (source as ImageBitmap).width;
  const h =
    (source as HTMLImageElement).naturalHeight ||
    (source as HTMLCanvasElement).height ||
    (source as ImageBitmap).height;
  if (!w || !h) throw new Error("cutoutPerson: source has no dimensions");

  const result: any = await new Promise((resolve, reject) => {
    try {
      // IMAGE-mode segment() delivers the result through a callback and frees it
      // once the callback returns, so we copy what we need synchronously.
      seg.segment(source as any, (res: any) => {
        try {
          const mask = res?.confidenceMasks && res.confidenceMasks[0];
          if (!mask) {
            reject(new Error("cutoutPerson: no mask"));
            return;
          }
          const mw = mask.width;
          const mh = mask.height;
          const cur = mask.getAsFloat32Array();
          const flip = !personIsHigh(cur, mw, mh);
          // Build an alpha matte at model resolution: crisp the mid-confidence
          // band so hair/edges are solid-in or gone (no foggy halo).
          const matte = document.createElement("canvas");
          matte.width = mw;
          matte.height = mh;
          const mctx = matte.getContext("2d")!;
          const img = mctx.createImageData(mw, mh);
          const d = img.data;
          for (let i = 0, p = 0; i < cur.length; i++, p += 4) {
            let v = flip ? 1 - cur[i] : cur[i];
            v = v <= 0.4 ? 0 : v >= 0.62 ? 1 : (v - 0.4) / 0.22;
            const a = v * v * (3 - 2 * v); // smoothstep
            d[p] = 0;
            d[p + 1] = 0;
            d[p + 2] = 0;
            d[p + 3] = (a * 255) | 0;
          }
          mctx.putImageData(img, 0, 0);
          resolve(matte);
        } catch (e) {
          reject(e as Error);
        }
      });
    } catch (e) {
      reject(e as Error);
    }
  });

  // Composite: draw the source, then keep only where the (upscaled) matte is
  // opaque via destination-in. A light feather blur on the upscale softens the
  // boundary without re-introducing a colour halo (matte RGB is black).
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d")!;
  octx.drawImage(source as any, 0, 0, w, h);
  octx.globalCompositeOperation = "destination-in";
  octx.imageSmoothingEnabled = true;
  (octx as any).filter = "blur(0.6px)";
  octx.drawImage(result, 0, 0, result.width, result.height, 0, 0, w, h);
  (octx as any).filter = "none";
  octx.globalCompositeOperation = "source-over";
  return out;
}
