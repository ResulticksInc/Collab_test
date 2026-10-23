// Background blur / replace for the CAMERA track.
//
// A LiveKit video Track.Processor: it takes the camera track in, composites each
// frame onto a canvas — background blurred (or swapped for an image) with the
// person drawn sharp on top — and publishes the canvas capture stream. Remote
// peers therefore receive an already-processed track and need no client support.
//
// Deliberately built on the EXISTING segmentation stack (lib/presenter/
// segmentation), not a second one:
//   • The MediaPipe runtime and selfie model are already vendored under
//     /public/mediapipe and served locally — no CDN, so this keeps working
//     offline in Electron, under the frontend CSP, and in an AIR-GAPPED
//     deployment, which is the whole point of self-hosting CoLab.
//   • That segmenter already solves the hard parts (GPU with a CPU fallback,
//     temporal smoothing to stop boundary flicker, edge feathering).
//   • Adding @livekit/track-processors would have pulled a SECOND copy of
//     MediaPipe whose defaults fetch WASM from jsdelivr and the model from
//     Google — exactly the dependency this deployment model cannot have.
//
// Structurally mirrors PresenterProcessor (name/init/restart/destroy/
// processedTrack) so both are driven identically by LocalVideoTrack.setProcessor.

import { createSegmenter, type Segmenter } from "../presenter/segmentation";
import { PRESENTER_ASSET_BASE } from "../presenter/types";

export type BackgroundMode = "none" | "blur" | "image";

export interface BackgroundProcessorOpts {
  mode: BackgroundMode;
  /** Blur strength in px at output resolution. Ignored unless mode === "blur". */
  blurRadius?: number;
  /** Same-origin image URL for mode === "image". */
  imageUrl?: string | null;
  assetBase?: string;
  /** Reports quality degradation (0 = full, 1..2 = reduced) when it changes. */
  onDegrade?: (level: number) => void;
}

interface ProcInitOpts {
  track: MediaStreamTrack;
  element?: HTMLMediaElement;
}

const FPS = 24;
const FRAME_INTERVAL = 1000 / FPS;

function makeVideo(track: MediaStreamTrack): HTMLVideoElement {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  (v as any).srcObject = new MediaStream([track]);
  v.play().catch(() => {});
  return v;
}

export class BackgroundProcessor {
  name = "collab-background";
  processedTrack?: MediaStreamTrack;

  private mode: BackgroundMode;
  private blurRadius: number;
  private imageUrl: string | null;
  private readonly assetBase: string;
  private readonly onDegrade?: (level: number) => void;

  private srcEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  // Background is composited on its own layer so the blur filter never touches
  // the sharp person pass — applying ctx.filter across both is what produces the
  // classic halo around the cutout.
  private bg: HTMLCanvasElement | null = null;
  private bgCtx: CanvasRenderingContext2D | null = null;
  private person: HTMLCanvasElement | null = null;
  private personCtx: CanvasRenderingContext2D | null = null;
  private bgImage: HTMLImageElement | null = null;

  private raf = 0;
  private running = false;
  private lastDraw = 0;
  private frame = 0;
  private avgMs = 0;
  // Segment every Nth frame when the device can't keep up; the mask is reused in
  // between. Blur survives a stale mask far better than it survives a stutter.
  private segEvery = 1;
  private degradeLevel = 0;

  private seg: Segmenter | null = null;
  private segLoading = false;

  constructor(opts: BackgroundProcessorOpts) {
    this.mode = opts.mode;
    this.blurRadius = opts.blurRadius ?? 12;
    this.imageUrl = opts.imageUrl ?? null;
    this.assetBase = opts.assetBase || PRESENTER_ASSET_BASE;
    this.onDegrade = opts.onDegrade;
  }

  /** Change blur/image without tearing down the track (no camera flicker). */
  setMode(mode: BackgroundMode, opts: { blurRadius?: number; imageUrl?: string | null } = {}) {
    this.mode = mode;
    if (opts.blurRadius != null) this.blurRadius = opts.blurRadius;
    if (opts.imageUrl !== undefined) {
      this.imageUrl = opts.imageUrl;
      this.bgImage = null; // reloaded lazily on the next frame
    }
  }

  async init(opts: ProcInitOpts): Promise<void> {
    this.srcEl = makeVideo(opts.track);
    const settings = opts.track.getSettings();
    const w = settings.width || 1280;
    const h = settings.height || 720;

    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true });

    for (const key of ["bg", "person"] as const) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      (this as any)[key] = c;
      (this as any)[key + "Ctx"] = c.getContext("2d");
    }

    const stream = (this.canvas as any).captureStream(FPS) as MediaStream;
    this.processedTrack = stream.getVideoTracks()[0];

    this.running = true;
    void this.ensureSegmenter();
    this.loop();
  }

  // LiveKit calls this when the input camera is replaced (device switch).
  async restart(opts: ProcInitOpts): Promise<void> {
    if (this.srcEl) {
      (this.srcEl as any).srcObject = new MediaStream([opts.track]);
      this.srcEl.play().catch(() => {});
    } else {
      this.srcEl = makeVideo(opts.track);
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
    if (this.srcEl) {
      (this.srcEl as any).srcObject = null;
      this.srcEl = null;
    }
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.canvas = this.bg = this.person = null;
    this.ctx = this.bgCtx = this.personCtx = null;
    this.bgImage = null;
  }

  private async ensureSegmenter() {
    if (this.seg || this.segLoading) return;
    this.segLoading = true;
    try {
      this.seg = await createSegmenter(this.assetBase);
    } catch (e) {
      // No segmenter → the loop below passes the camera through untouched. A
      // failed model load must never black out someone's video.
      console.warn("[background] segmentation unavailable — passing through:", e);
    } finally {
      this.segLoading = false;
    }
  }

  private loadImage() {
    if (this.bgImage || !this.imageUrl) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = this.imageUrl;
    img.onload = () => {
      this.bgImage = img;
    };
    img.onerror = () => {
      // Fall back to blur rather than showing a broken background.
      console.warn("[background] image failed to load — falling back to blur");
      this.mode = "blur";
    };
  }

  private loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (now - this.lastDraw < FRAME_INTERVAL) return;
    this.lastDraw = now;
    const t0 = performance.now();
    try {
      this.draw(now);
    } catch {
      /* a dropped frame is never worth throwing out of a rAF loop */
    }
    // Adaptive quality: if frames get expensive, segment less often before
    // letting the video stutter.
    const ms = performance.now() - t0;
    this.avgMs = this.avgMs ? this.avgMs * 0.9 + ms * 0.1 : ms;
    if (++this.frame % 60 === 0) {
      const next = this.avgMs > 28 ? 3 : this.avgMs > 18 ? 2 : 1;
      if (next !== this.segEvery) {
        this.segEvery = next;
        const level = next === 1 ? 0 : next === 2 ? 1 : 2;
        if (level !== this.degradeLevel) {
          this.degradeLevel = level;
          this.onDegrade?.(level);
        }
      }
    }
  };

  private draw(now: number) {
    const ctx = this.ctx;
    const src = this.srcEl;
    if (!ctx || !src || !this.canvas) return;
    if (src.readyState < 2 || !src.videoWidth) return;

    const W = this.canvas.width;
    const H = this.canvas.height;

    // No effect, or the segmenter never loaded → straight passthrough.
    if (this.mode === "none" || !this.seg || !this.seg.ready) {
      ctx.drawImage(src, 0, 0, W, H);
      return;
    }

    if (this.frame % this.segEvery === 0) this.seg.updateMask(src, now);

    // 1. Background layer: the frame, blurred or replaced.
    const bgCtx = this.bgCtx!;
    bgCtx.save();
    bgCtx.filter = "none";
    if (this.mode === "image") {
      this.loadImage();
      if (this.bgImage) {
        // Cover-fit so a portrait image never letterboxes a landscape frame.
        const ir = this.bgImage.width / this.bgImage.height;
        const cr = W / H;
        let dw = W;
        let dh = H;
        if (ir > cr) dw = H * ir;
        else dh = W / ir;
        bgCtx.drawImage(this.bgImage, (W - dw) / 2, (H - dh) / 2, dw, dh);
      } else {
        bgCtx.filter = `blur(${this.blurRadius}px)`;
        bgCtx.drawImage(src, 0, 0, W, H);
      }
    } else {
      bgCtx.filter = `blur(${this.blurRadius}px)`;
      bgCtx.drawImage(src, 0, 0, W, H);
    }
    bgCtx.restore();

    // 2. Person layer: the sharp frame, masked to the person.
    const pCtx = this.personCtx!;
    pCtx.save();
    pCtx.clearRect(0, 0, W, H);
    pCtx.filter = "none";
    pCtx.drawImage(src, 0, 0, W, H);
    // destination-in keeps only where the mask is opaque. The mask is already
    // feathered and temporally smoothed by the shared segmenter.
    pCtx.globalCompositeOperation = "destination-in";
    pCtx.drawImage(this.seg.maskCanvas, 0, 0, W, H);
    pCtx.restore();

    // 3. Composite: background, then the person over it.
    ctx.filter = "none";
    ctx.drawImage(this.bg!, 0, 0, W, H);
    ctx.drawImage(this.person!, 0, 0, W, H);
  }
}
