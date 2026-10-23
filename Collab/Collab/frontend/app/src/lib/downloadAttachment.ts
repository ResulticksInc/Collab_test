// ONE download path for every chat attachment entry point — the bubble's
// download corner, the album lightbox, the message "Download" menu action.
//
// They used to each re-implement it: one skipped E2EE decryption (so a
// recipient's "Download" saved unreadable ciphertext), two swallowed every
// error (nothing happened and nothing said why), and all three fetched BEFORE
// opening the Save-As picker, which loses the click gesture on a slow fetch.
//
// Also owns the "already downloaded" mark: once a file has been saved on this
// device the bubble hides its download icon (messaging-app convention — the
// icon means "not on this device yet"). Persisted per browser in localStorage,
// bounded, best-effort.
import { useEffect, useState } from "react";
import { api } from "./api";
import { saveBlobAs } from "./saveBlob";
import { mimeOf, maybeNativeSaveAs } from "./desktopFiles";
import { decryptBlob, decryptChunkedToBlob } from "./e2ee/media";

// ── Downloaded-on-this-device registry ──────────────────────────────────────
const LS_KEY = "colab.downloaded.v1";
const LS_MAX = 500;
const EVT = "colab:downloaded";
let _set: Set<string> | null = null;

function load(): Set<string> {
  if (_set) return _set;
  _set = new Set();
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(LS_KEY) : null;
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) for (const id of arr) if (typeof id === "string") _set.add(id);
  } catch {
    /* private mode / blocked storage → in-memory only */
  }
  return _set;
}

export function isDownloaded(fileId: any): boolean {
  if (!fileId) return false;
  return load().has(String(fileId));
}

export function markDownloaded(fileId: any): void {
  if (!fileId) return;
  const s = load();
  const id = String(fileId);
  s.delete(id);
  s.add(id);
  while (s.size > LS_MAX) {
    const oldest = s.values().next().value as string | undefined;
    if (oldest === undefined) break;
    s.delete(oldest);
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...s]));
  } catch {
    /* best-effort */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVT, { detail: id }));
  } catch {
    /* no window */
  }
}

/** Live "has this file been saved on this device" flag for a bubble. */
export function useDownloaded(fileId: any): boolean {
  const [done, setDone] = useState(() => isDownloaded(fileId));
  useEffect(() => {
    setDone(isDownloaded(fileId));
    const on = (e: Event) => {
      if (String((e as CustomEvent).detail) === String(fileId)) setDone(true);
    };
    window.addEventListener(EVT, on as EventListener);
    return () => window.removeEventListener(EVT, on as EventListener);
  }, [fileId]);
  return done;
}

// ── Download ─────────────────────────────────────────────────────────────────
function toast(msg: string) {
  try {
    window.dispatchEvent(new CustomEvent("colab:toast", { detail: msg }));
  } catch {
    /* no window */
  }
}

/** Why a download failed, in words the user can act on. */
export function downloadErrorLabel(status: number): string {
  if (status === 401 || status === 403) return "You don't have access to this file";
  if (status === 404) return "This file is no longer available";
  if (status === 503 || status === 502 || status === 504) return "Storage is temporarily unavailable — try again shortly";
  if (status === -1) return "Couldn't decrypt this file on this device";
  return "Download failed — please try again";
}

async function fetchAttachmentBlob(
  file: any,
  token: string,
  onProgress?: (pct: number) => void,
): Promise<Blob> {
  const r = await fetch(
    api.fileLinkUrl(`/api/files/${file.id}/download`),
    token ? { headers: { Authorization: "Bearer " + token } } : {},
  );
  if (!r.ok) {
    const err: any = new Error("HTTP " + r.status);
    err.status = r.status;
    throw err;
  }
  const type = mimeOf(file) || r.headers.get("Content-Type") || "";
  const total = Number(r.headers.get("Content-Length") || 0);
  let blob: Blob;
  if (r.body && r.body.getReader && total > 0 && onProgress) {
    const reader = r.body.getReader();
    const chunks: BlobPart[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        onProgress(Math.min(99, Math.round((loaded / total) * 100)));
      }
    }
    blob = new Blob(chunks, { type });
  } else {
    blob = await r.blob();
  }
  if (file._e2eeKey && (file._e2eeStream || file._e2eeIv)) {
    try {
      blob = file._e2eeStream
        ? await decryptChunkedToBlob(blob, file._e2eeKey, file._e2eeStream, type)
        : await decryptBlob(blob, file._e2eeKey, file._e2eeIv, type);
    } catch (e: any) {
      const err: any = new Error("decrypt failed");
      err.status = -1;
      throw err;
    }
  }
  return blob;
}

export type DownloadOptions = {
  /** An object/blob URL already holding the DECRYPTED bytes (bubble cache). */
  url?: string | null;
  onProgress?: (pct: number) => void;
  /** Show a toast on failure (default true). */
  notify?: boolean;
};

/**
 * Download one attachment the way the user expects on THIS device:
 *   desktop app → native Save dialog; oversized file → streamed ticket link;
 *   otherwise fetch (+ decrypt) and Save-As / browser download.
 * Resolves true when the file was saved; false when the user cancelled;
 * rejects with `{ status }` on failure (after toasting it, unless notify=false).
 * On success the file is marked downloaded on this device.
 */
export async function downloadAttachment(
  file: any,
  token: string,
  opts: DownloadOptions = {},
): Promise<boolean> {
  if (!file) return false;
  const name = file.name || "file";
  const notify = opts.notify !== false;
  try {
    if (await maybeNativeSaveAs(file, token)) {
      markDownloaded(file.id);
      return true;
    }
    // Oversized attachment: never pull it into a Blob — navigate to the signed,
    // same-origin streaming URL (the backend proxies MinIO; no OOM in the tab).
    if (file.largeFile || file.collabLink) {
      let href: string | null = file.collabLink
        ? api.fileLinkUrl(file.linkPath || "/api/files/link/" + file.linkToken)
        : null;
      if (!href && file.id) {
        const res: any = await api.fileDownloadTicket(token, file.id);
        const rel = res && (res.url || res.data?.url);
        if (rel) href = api.fileLinkUrl(rel);
      }
      if (!href) throw Object.assign(new Error("no link"), { status: 404 });
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      markDownloaded(file.id);
      return true;
    }
    let saved: boolean;
    if (opts.url) {
      const u = opts.url;
      saved = await saveBlobAs(async () => await (await fetch(u)).blob(), name);
    } else {
      if (!file.id) throw Object.assign(new Error("no id"), { status: 404 });
      saved = await saveBlobAs(() => fetchAttachmentBlob(file, token, opts.onProgress), name);
    }
    if (saved) markDownloaded(file.id);
    return saved;
  } catch (e: any) {
    const status = Number(e?.status) || 0;
    if (notify) toast(downloadErrorLabel(status));
    throw e;
  }
}
