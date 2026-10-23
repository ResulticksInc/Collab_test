// Animated-GIF encoding for the sticker/GIF creation studio. Pure-JS, offline,
// zero network — wraps `gifenc` (MIT, ~15KB). The browser's MediaRecorder can
// only emit WebM video, never a real .gif, so this is how the studio produces a
// universal autoplaying <img src="…gif"> that every recipient renders inline.
//
// Transparency note: GIF alpha is 1-bit — a pixel is either fully opaque or the
// single "transparent" palette index. Soft cutout edges are therefore hard-
// thresholded here (via gifenc's oneBitAlpha). Still stickers keep smooth alpha
// by exporting WebP/PNG instead (see MediaStudio); GIF is only for animation.

import { GIFEncoder, quantize, applyPalette } from "gifenc";

export type GifFrame = {
  // RGBA bytes, length = width*height*4 (an ImageData.data is exactly this).
  data: Uint8ClampedArray | Uint8Array;
  // How long this frame is shown, in milliseconds.
  delayMs: number;
};

export type EncodeGifOpts = {
  // Keep background transparent (for cutout stickers). Default false (opaque).
  transparent?: boolean;
  // Palette size per frame, 2..256. Fewer colours = smaller file. Default 256.
  maxColors?: number;
};

// Encode a sequence of same-sized RGBA frames into a looping animated GIF Blob.
// Runs synchronously on the main thread; a few dozen sticker-sized frames encode
// in well under a frame budget, so no worker is needed.
export function encodeGif(
  frames: GifFrame[],
  width: number,
  height: number,
  opts: EncodeGifOpts = {},
): Blob {
  if (!frames.length) throw new Error("encodeGif: no frames");
  const transparent = opts.transparent ?? false;
  const maxColors = Math.min(256, Math.max(2, opts.maxColors ?? 256));
  // rgba4444 keeps an alpha channel so oneBitAlpha can pick a transparent index;
  // rgb565 is a tighter palette for fully-opaque animation.
  const format: "rgba4444" | "rgb565" = transparent ? "rgba4444" : "rgb565";

  const gif = GIFEncoder();
  frames.forEach((f, i) => {
    const palette = quantize(f.data, maxColors, {
      format,
      oneBitAlpha: transparent,
    });
    const index = applyPalette(f.data, palette, format);
    gif.writeFrame(index, width, height, {
      palette,
      delay: Math.max(20, Math.round(f.delayMs)),
      transparent,
      // Restore-to-background between transparent frames so moving cutouts don't
      // leave a smeared trail; plain over-paint is fine for opaque animation.
      dispose: transparent ? 2 : 0,
      // Netscape loop-forever marker is written from the first frame only.
      repeat: i === 0 ? 0 : undefined,
    });
  });
  gif.finish();
  // gif.bytes() returns a Uint8Array view; copy into the Blob.
  return new Blob([gif.bytes()], { type: "image/gif" });
}

// Convenience: pull RGBA out of a canvas as one GIF frame.
export function frameFromCanvas(canvas: HTMLCanvasElement, delayMs: number): GifFrame {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("frameFromCanvas: no 2d context");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: img.data, delayMs };
}
