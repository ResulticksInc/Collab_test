import config from "./config";

// Resolve a media URL for use in <img src>. Absolute/data/blob URLs pass
// through; a root-relative API path (e.g. /api/public/users/:id/avatar) is
// prefixed with the API origin so it resolves to the backend, not the frontend.
export function resolveMediaUrl(url?: string | null): string {
  if (!url) return "";
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  if (url.startsWith("/")) return config.apiBaseUrl + url;
  return url;
}

// Downscale an image File to a compact JPEG data URL. Used for avatars and
// chat wallpaper so the image renders directly in <img>/background-image with
// no auth header, no presigned URL, and no expiry — works on every browser.
export function downscaleToDataURL(
  file: File,
  maxEdge = 256,
  quality = 0.82,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode failed"));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("no canvas ctx"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
