// Generate a small first-frame POSTER for a video, client-side, at SEND time.
//
// Why client-side: the server never sees plaintext (E2EE), so it can't run ffmpeg.
// We decode frame ~0 into a canvas and export a small JPEG data-URI that rides
// inside the message (the E2EE envelope for encrypted chats, or file.thumb for
// plaintext). The receiver shows it INSTANTLY as the video card's poster — no full
// download needed to see what the clip is — and it doubles as the <video poster>
// so playback shows the frame immediately instead of a black "loading" box.
//
// Kept small (≈320px wide, modest quality) so it adds only a few KB to the message.
// Fully best-effort: any failure resolves to null and the neutral card is used.

export async function makeVideoThumb(
  file: File,
  opts: { maxWidth?: number; quality?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const maxWidth = opts.maxWidth ?? 320;
  const quality = opts.quality ?? 0.55;
  const timeoutMs = opts.timeoutMs ?? 4000;
  if (typeof document === "undefined") return null;
  if (!file || !(file.type || "").startsWith("video/")) return null;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    let url: string | null = null;
    const video = document.createElement("video");

    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        /* ignore */
      }
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const capture = () => {
      try {
        const vw = video.videoWidth,
          vh = video.videoHeight;
        if (!vw || !vh) return finish(null);
        const scale = Math.min(1, maxWidth / vw);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(vw * scale));
        canvas.height = Math.max(1, Math.round(vh * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish(null);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        finish(dataUrl && dataUrl.length > 64 ? dataUrl : null);
      } catch {
        finish(null);
      }
    };

    try {
      video.muted = true;
      (video as any).playsInline = true;
      video.preload = "auto";
      video.onloadeddata = () => {
        // Seek slightly past 0 to avoid a black/blank first frame; capture on seek.
        try {
          const t = Math.min(0.1, (video.duration || 1) * 0.1);
          if (Number.isFinite(t) && Math.abs(video.currentTime - t) > 0.001) {
            video.currentTime = t;
          } else {
            capture();
          }
        } catch {
          capture();
        }
      };
      video.onseeked = () => capture();
      video.onerror = () => finish(null);
      url = URL.createObjectURL(file);
      video.src = url;
      video.load();
    } catch {
      finish(null);
    }
  });
}
