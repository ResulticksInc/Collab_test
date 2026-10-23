// Presenter Mode — the composition engine. A LiveKit video Track.Processor that
// takes the SCREEN track as input, holds the CAMERA as a side input, and each
// frame draws the content (letterboxed) with the presenter composited over it
// per the active layout. Its `processedTrack` (a canvas capture stream) is what
// LiveKit publishes — so remote peers receive one already-composited ScreenShare.
//
// Structurally implements LiveKit's TrackProcessor<Video> (name/init/restart/
// destroy/processedTrack); passed to LocalVideoTrack.setProcessor() via the hook.

import { createSegmenter, type Segmenter } from "./segmentation";
import { layoutFor, type NRect } from "./layouts";
import {
  PRESENTER_OUT_W,
  PRESENTER_OUT_H,
  PRESENTER_FPS,
  PRESENTER_ASSET_BASE,
  type PresenterMode,
} from "./types";

export interface PresenterProcessorOpts {
  /** Current published camera MediaStreamTrack, or null when the camera is off. */
  getCameraTrack: () => MediaStreamTrack | null;
  mode: PresenterMode;
  assetBase?: string;
  /** Reports the degrade level (0 = full quality, 1..2 = reduced) when it changes. */
  onDegrade?: (level: number) => void;
}

interface ProcInitOpts {
  track: MediaStreamTrack;
  element?: HTMLMediaElement;
}

const FRAME_INTERVAL = 1000 / PRESENTER_FPS;

function makeVideo(track: MediaStreamTrack): HTMLVideoElement {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  (v as any).srcObject = new MediaStream([track]);
  v.play().catch(() => {});
  return v;
}

function px(r: NRect, w: number, h: number) {
  return { x: r.x * w, y: r.y * h, w: r.w * w, h: r.h * h };
}

// Fit the whole source inside the rect (letterbox) — used for shared content so a
// deck is never cropped.
function drawContain(
  ctx: CanvasRenderingContext2D,
  src: HTMLVideoElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const sw = src.videoWidth;
  const sh = src.videoHeight;
  if (!sw || !sh) return;
  const s = Math.min(w / sw, h / sh);
  const dw = sw * s;
  const dh = sh * s;
  ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Cover the rect with the source (crop overflow), optionally rounded-clipped.
function drawCover(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  x: number,
  y: number,
  w: number,
  h: number,
  radius = 0,
) {
  if (!sw || !sh) return;
  const s = Math.max(w / sw, h / sh);
  const dw = sw * s;
  const dh = sh * s;
  ctx.save();
  if (radius > 0) {
    roundRectPath(ctx, x, y, w, h, radius);
    ctx.clip();
  } else {
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
  }
  ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

export class PresenterProcessor {
  name = "collab-presenter";
  processedTrack?: MediaStreamTrack;

  private mode: PresenterMode;
  private readonly getCameraTrack: () => MediaStreamTrack | null;
  private readonly assetBase: string;
  private readonly onDegrade?: (level: number) => void;

  private screenEl: HTMLVideoElement | null = null;
  private camEl: HTMLVideoElement | null = null;
  private camTrackId = "";
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private camScratch: HTMLCanvasElement | null = null;
  private camScratchCtx: CanvasRenderingContext2D | null = null;

  private raf = 0;
  private running = false;
  private lastDraw = 0;
  private frame = 0;
  private avgMs = 0;
  private segEvery = 1;
  private degradeLevel = 0;

  private seg: Segmenter | null = null;
  private segLoading = false;

  constructor(opts: PresenterProcessorOpts) {
    this.mode = opts.mode;
    this.getCameraTrack = opts.getCameraTrack;
    this.assetBase = opts.assetBase || PRESENTER_ASSET_BASE;
    this.onDegrade = opts.onDegrade;
  }

  async init(opts: ProcInitOpts): Promise<void> {
    this.screenEl = makeVideo(opts.track);
    this.canvas = document.createElement("canvas");
    this.canvas.width = PRESENTER_OUT_W;
    this.canvas.height = PRESENTER_OUT_H;
    this.ctx = this.canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    this.camScratch = document.createElement("canvas");
    this.camScratchCtx = this.camScratch.getContext("2d");

    const stream = (this.canvas as any).captureStream(
      PRESENTER_FPS,
    ) as MediaStream;
    this.processedTrack = stream.getVideoTracks()[0];

    this.running = true;
    void this.ensureSegmenter();
    this.loop();
  }

  // Called by LiveKit when the input (screen) track is replaced.
  async restart(opts: ProcInitOpts): Promise<void> {
    if (this.screenEl) {
      (this.screenEl as any).srcObject = new MediaStream([opts.track]);
      this.screenEl.play().catch(() => {});
    } else {
      this.screenEl = makeVideo(opts.track);
    }
  }

  async destroy(): Promise<void> {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.seg) {
      this.seg.close();
      this.seg = null;
    }
    for (const el of [this.screenEl, this.camEl]) {
      if (el) {
        try {
          el.pause();
          (el as any).srcObject = null;
          el.remove();
        } catch {
          /* noop */
        }
      }
    }
    this.screenEl = this.camEl = null;
    try {
      this.processedTrack?.stop();
    } catch {
      /* noop */
    }
  }

  setMode(mode: PresenterMode) {
    this.mode = mode;
    void this.ensureSegmenter();
  }

  private async ensureSegmenter() {
    const spec = layoutFor(this.mode);
    if (!spec?.segmented) return; // this mode doesn't need the model
    if (this.seg || this.segLoading) return;
    this.segLoading = true;
    try {
      this.seg = await createSegmenter(this.assetBase);
    } catch {
      this.seg = null; // model/GPU unavailable → falls back to raw camera
    } finally {
      this.segLoading = false;
    }
  }

  private syncCamera() {
    const track = this.getCameraTrack();
    if (track && track.id !== this.camTrackId) {
      if (!this.camEl) this.camEl = makeVideo(track);
      else {
        (this.camEl as any).srcObject = new MediaStream([track]);
        this.camEl.play().catch(() => {});
      }
      this.camTrackId = track.id;
    } else if (!track && this.camTrackId) {
      if (this.camEl) {
        try {
          this.camEl.pause();
          (this.camEl as any).srcObject = null;
          this.camEl.remove();
        } catch {}
        this.camEl = null;
      }
      this.camTrackId = "";
    }
  }

  private camReady() {
    return !!this.camEl && this.camEl.readyState >= 2 && !!this.camEl.videoWidth;
  }

  private loop = () => {
    if (!this.running) return;
    const now = performance.now();
    const isHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const interval = isHidden ? 500 : FRAME_INTERVAL;
    if (now - this.lastDraw >= interval - 1) {
      this.lastDraw = now;
      const t0 = now;
      this.draw(now);
      const cost = performance.now() - t0;
      this.avgMs = this.avgMs ? this.avgMs * 0.9 + cost * 0.1 : cost;
      this.adaptQuality();
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  // Scale segmentation cadence to the measured per-frame cost so weak hardware
  // keeps a steady frame rate instead of dropping frames.
  private adaptQuality() {
    const prev = this.degradeLevel;
    if (this.avgMs > 45) {
      this.segEvery = 3;
      this.degradeLevel = 2;
    } else if (this.avgMs > 30) {
      this.segEvery = 2;
      this.degradeLevel = 1;
    } else if (this.avgMs < 24) {
      this.segEvery = 1;
      this.degradeLevel = 0;
    }
    if (this.degradeLevel !== prev) this.onDegrade?.(this.degradeLevel);
  }

  private draw(now: number) {
    const ctx = this.ctx;
    const cv = this.canvas;
    if (!ctx || !cv) return;
    this.syncCamera();
    this.frame++;

    const spec = layoutFor(this.mode);
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, cv.width, cv.height);

    // Content — always letterboxed so the shared deck/app is never cropped.
    const contentRect = spec ? spec.content : { x: 0, y: 0, w: 1, h: 1 };
    const c = px(contentRect, cv.width, cv.height);
    if (this.screenEl) drawContain(ctx, this.screenEl, c.x, c.y, c.w, c.h);

    if (!spec || !this.camReady()) return; // standard, or camera off → content only

    const r = px(spec.camera, cv.width, cv.height);
    if (spec.segmented && this.seg) {
      this.drawSegmentedCamera(now, r);
    } else {
      this.drawFramedCamera(r, spec.cameraRadius);
    }
  }

  private drawFramedCamera(
    r: { x: number; y: number; w: number; h: number },
    radius: number,
  ) {
    const cam = this.camEl!;
    // Subtle frame so the camera reads as a distinct element over the content.
    if (radius > 0) {
      this.ctx!.save();
      roundRectPath(this.ctx!, r.x - 2, r.y - 2, r.w + 4, r.h + 4, radius + 2);
      this.ctx!.fillStyle = "rgba(8,12,18,.85)";
      this.ctx!.fill();
      this.ctx!.restore();
    }
    drawCover(
      this.ctx!,
      cam,
      cam.videoWidth,
      cam.videoHeight,
      r.x,
      r.y,
      r.w,
      r.h,
      radius,
    );
  }

  private drawSegmentedCamera(
    now: number,
    r: { x: number; y: number; w: number; h: number },
  ) {
    const cam = this.camEl!;
    const scratch = this.camScratch!;
    const sctx = this.camScratchCtx!;
    const vw = cam.videoWidth;
    const vh = cam.videoHeight;

    // Refresh the mask at the adaptive cadence; reuse the last mask otherwise.
    if (this.seg && this.frame % this.segEvery === 0) {
      this.seg.updateMask(cam, now);
    }

    if (scratch.width !== vw || scratch.height !== vh) {
      scratch.width = vw;
      scratch.height = vh;
    }
    // Full camera frame → keep only the person (destination-in with the mask).
    sctx.clearRect(0, 0, vw, vh);
    sctx.globalCompositeOperation = "source-over";
    sctx.drawImage(cam, 0, 0, vw, vh);
    const mask = this.seg?.maskCanvas;
    if (mask && mask.width) {
      // destination-in keeps the camera only where the matte is opaque (the
      // person). Deliberately NO ctx.filter here: a filter combined with a
      // non-source-over composite op leaks the matte's white into the output —
      // that was the "white fog" over the presenter. Edge softness comes from
      // the matte's own EMA smoothing + the bilinear upscale below.
      sctx.globalCompositeOperation = "destination-in";
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(mask, 0, 0, mask.width, mask.height, 0, 0, vw, vh);
      sctx.globalCompositeOperation = "source-over";
    }
    // Cover the camera region with the person cutout; transparent bg shows
    // content. A subtle contact shadow behind the cutout adds depth AND masks
    // residual edge raggedness (the shadow's blur softens the person↔content
    // transition) — the biggest perceived-quality win short of a WebGL matte.
    const ctx = this.ctx!;
    ctx.save();
    // Contact shadow for depth + to mask residual edge raggedness. shadowBlur is a
    // per-frame gaussian over the whole camera region and its cost is ~quadratic in
    // the radius, so we keep the radius tight: ~0.018·w (was 0.03·w) drops the blur
    // cost to roughly a third while the shadow still reads as soft. A slightly
    // deeper alpha compensates for the smaller spread so the depth cue is preserved.
    ctx.shadowColor = "rgba(0, 0, 0, 0.34)";
    ctx.shadowBlur = Math.max(6, Math.round(r.w * 0.018));
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.max(2, Math.round(r.h * 0.01));
    drawCover(ctx, scratch, vw, vh, r.x, r.y, r.w, r.h, 0);
    ctx.restore();
  }
}
