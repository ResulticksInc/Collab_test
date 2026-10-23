// ─────────────────────────────────────────────────────────────────────────────
// Shared DESKTOP file helpers — drag-out / native Save-as / reveal-in-folder.
//
// These were first written inline in ChatView for chat attachments. The Files
// module needs the SAME behaviour on its rows, and the instruction is explicit:
// REUSE the existing IPC, never duplicate it. So the three helpers now live here
// and BOTH ChatView and FilesView import them — one source, one code path.
//
// Every helper is a no-op in the browser (returns {} / false): the desktop IPC
// only exists when the Electron preload injects `window.collabDesktop`. They are
// therefore SAFE in the shared bundle — web rows keep their normal download.
// Gated on `isDesktopApp` (lib/platform.ts) per the shared-layer rule.
//
// Source resolution + the E2EE guard are IDENTICAL across drag-out and save-as:
//   • E2EE/locked files (e2ee && no plain url) → skipped (never leak ciphertext).
//   • collabLink (oversized cloud link) → the link's authed download URL.
//   • a file with an id → /api/files/<id>/download (same authed endpoint as the
//     download button; the MAIN process fetches it to a temp file).
//   • a renderer-local objectURL / inline blob with no id → skipped (main can't
//     fetch a blob:).
// The url is resolved to an ABSOLUTE http(s) URL (against the page origin when
// the API base is same-origin/empty) because the main process downloads it.
// ─────────────────────────────────────────────────────────────────────────────
import { api } from "./api";
import { isDesktopApp } from "./platform";

// Extension → MIME fallback for files whose row carries no explicit type. Kept
// minimal (the common attachment kinds) — the OS only needs a hint so a dragged-
// out / saved file lands with the right extension and opens in the right app.
const EXT_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
  heic: "image/heic", heif: "image/heif", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4",
  mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
  pdf: "application/pdf",
};

/** Best-effort MIME for a file row: explicit type/mime, else extension lookup. */
export function mimeOf(file: any): string {
  const m = (file?.type || file?.mime || "").toLowerCase();
  if (m) return m;
  const name = (file?.name || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  return EXT_MIME[ext] || "";
}

// Resolve the authed download path for a file row, or null when there's no
// server-fetchable source (renderer-local blob with no id). Shared by both
// helpers so the source rules can never drift apart.
function downloadPathFor(file: any): string | null {
  if (file.collabLink) return file.linkPath || "/api/files/link/" + file.linkToken;
  if (file.id) return `/api/files/${file.id}/download`;
  return null;
}

function absUrl(path: string): string {
  let abs = api.fileLinkUrl(path);
  if (!/^https?:\/\//i.test(abs) && typeof window !== "undefined") {
    abs = new URL(abs, window.location.origin).toString();
  }
  return abs;
}

/**
 * Props to spread onto an attachment/file container so the user can drag it OUT
 * of the window and drop a REAL file copy on the desktop / a folder. Returns {}
 * in the browser (or for a file with no fetchable server URL) — so the element
 * behaves EXACTLY as before and the in-app drag/upload/download are untouched.
 */
export function dragOutProps(
  file: any,
  token: string,
): { draggable?: boolean; onDragStart?: (e: React.DragEvent) => void } {
  if (!isDesktopApp || !file) return {};
  // Never drag out an encrypted file that isn't decrypted on this device.
  if (file.e2ee && !file.url) return {};
  const path = downloadPathFor(file);
  if (!path) return {};
  const cd =
    typeof window !== "undefined" ? (window as any).collabDesktop : undefined;
  if (!cd || typeof cd.startDrag !== "function") return {};
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      // Take over the drag for a native OS drag-out. preventDefault stops the
      // browser's own (useless) image/url drag; the native drag is fire-and-forget.
      try {
        e.preventDefault();
        e.stopPropagation();
        cd.startDrag({
          url: absUrl(path),
          filename: file.name || "file",
          mime: mimeOf(file),
          token: token || "",
        });
      } catch {
        // Any failure → no native drag (and we already preventDefault'd, so the
        // browser won't start a competing drag either). Never throws.
      }
    },
  };
}

/**
 * Desktop "Save as…": native Save dialog + reveal-in-folder. Returns true if the
 * desktop app HANDLED the save (so the caller skips the web blob download), false
 * to fall through to the browser path. Routes through collabDesktop.saveFile,
 * which on the main side reuses the SAME authed download drag-out uses (no
 * duplicate download). On success it pops a toast (with the path, via the shared
 * `colab:toast` CustomEvent) and reveals the file in the OS file manager. No-op
 * (returns false) in the browser.
 */
export async function maybeNativeSaveAs(file: any, token: string): Promise<boolean> {
  if (!isDesktopApp || !file) return false;
  // Never save the ciphertext of an encrypted file that isn't decrypted here.
  if (file.e2ee && !file.url) return false;
  const path = downloadPathFor(file);
  if (!path) return false;
  const cd =
    typeof window !== "undefined" ? (window as any).collabDesktop : undefined;
  if (!cd || typeof cd.saveFile !== "function") return false;
  try {
    const saved: string | null = await cd.saveFile({
      url: absUrl(path),
      filename: file.name || "file",
      mime: mimeOf(file),
      token: token || "",
    });
    if (saved) {
      try {
        window.dispatchEvent(
          new CustomEvent("colab:toast", { detail: "Saved to " + saved }),
        );
      } catch {}
      try {
        if (typeof cd.revealInFolder === "function") cd.revealInFolder(saved);
      } catch {}
    }
    // We OWN the save once the desktop path is viable (saveFile invoked): a null
    // result means the user cancelled the dialog (or it failed) — either way we
    // do NOT also trigger the browser download, which would be surprising.
    return true;
  } catch {
    return false; // unexpected error → let the web blob path try
  }
}
