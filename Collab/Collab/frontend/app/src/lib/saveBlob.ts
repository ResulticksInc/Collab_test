// Save a Blob straight into the browser's download location (the "Downloads"
// section / folder the user configured) — no Save-As dialog.
//
// Product decision (7 Oct 2026): a download should behave like every other
// website's download. The File System Access picker (`showSaveFilePicker`)
// was tried before this and is deliberately NOT used any more: it pops a
// native dialog on every click, it is gesture-gated so a slow fetch made the
// click do nothing, and it exists only in Chromium.
//
// `saveBlobAs` accepts a ready Blob or an async PRODUCER (fetch + decrypt
// happen inside it), so every caller shares one download path. It resolves
// true once the bytes were handed to the browser's download manager (or, on a
// browser without the anchor `download` attribute, opened in a new tab).
export type BlobSource = Blob | (() => Promise<Blob>);

async function produce(src: BlobSource): Promise<Blob> {
  return typeof src === "function" ? await src() : src;
}

// Some browsers (older Safari, iOS in-app webviews, some Android webviews)
// ignore the anchor `download` attribute and would NAVIGATE the app away to the
// blob instead. Opening in a new tab keeps the chat intact and lets the
// browser's own viewer/share sheet take over.
function anchorDownloadSupported(): boolean {
  try {
    return typeof document !== "undefined" && "download" in document.createElement("a");
  } catch {
    return false;
  }
}

function anchorDownload(blob: Blob, name: string): boolean {
  const url = URL.createObjectURL(blob);
  try {
    if (anchorDownloadSupported()) {
      const a = document.createElement("a");
      a.href = url;
      a.download = name || "file";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      const w = window.open(url, "_blank", "noopener");
      if (!w) {
        // Popup blocked: last resort is a same-tab navigation (the browser's
        // viewer opens the file; Back returns to the app).
        window.location.assign(url);
      }
    }
    return true;
  } finally {
    // Long enough for the download manager / new tab to grab the bytes.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export async function saveBlobAs(
  source: BlobSource,
  suggestedName: string,
): Promise<boolean> {
  const blob = await produce(source);
  return anchorDownload(blob, suggestedName || "file");
}
