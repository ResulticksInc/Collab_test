// Client side of E2EE video streaming. Registers the Service Worker (public/sw.js,
// which carries the decrypt-on-play fetch handler), hands it a video's per-file
// decryption creds over a MessageChannel, and returns a virtual URL the <video>
// element can stream from. The SW decrypts each requested byte-range locally, so
// the server only ever holds ciphertext.
//
// Resilience: the SW can be idle-killed (dropping its in-memory creds) and the app
// rotates its access token mid-playback. So we keep an in-page registry of active
// videos and answer the SW's re-request (E2EE_NEED_CREDS) and token-refresh
// (E2EE_NEED_TOKEN) messages with FRESH values — the SW then retries and playback
// keeps going. Keys/tokens are only ever held in memory.

import { api } from "./api";
import type { StreamManifest } from "./e2ee/media";

let swReady: Promise<boolean> | null = null;
// fileId -> the bits we need to rebuild creds on demand (key + manifest + mime).
const active = new Map<string, { key: string; manifest: StreamManifest; mime: string }>();

function readToken(): string {
  try {
    return (typeof localStorage !== "undefined" && localStorage.getItem("clb_token")) || "";
  } catch {
    return "";
  }
}

function buildCreds(fileId: string, entry: { key: string; manifest: StreamManifest; mime: string }) {
  return {
    key: entry.key,
    ivPrefix: entry.manifest.ivPrefix,
    chunkPlain: entry.manifest.chunkPlain,
    chunkCipher: entry.manifest.chunkCipher,
    count: entry.manifest.count,
    plainSize: entry.manifest.plainSize,
    mime: entry.mime || "video/mp4",
    token: readToken(), // always the FRESH token
    url: api.fileLinkUrl("/api/files/" + fileId + "/download"),
  };
}

function postToSW(msg: any, transfer?: Transferable[]) {
  const ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!ctrl) return;
  if (transfer) ctrl.postMessage(msg, transfer);
  else ctrl.postMessage(msg);
}

// Register the SW (idempotent with the push registration — same /sw.js URL) and
// wire the re-request replies. Resolves true once the SW controls this page.
export function ensureVideoSW(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return Promise.resolve(false);
  }
  if (!swReady) {
    navigator.serviceWorker.addEventListener("message", (e: any) => {
      const d = e && e.data;
      if (!d || !d.fileId) return;
      if (d.type === "E2EE_NEED_TOKEN") {
        // Answer with the CURRENT token (freshly read), NOT a stale snapshot.
        const t = readToken();
        if (t) postToSW({ type: "E2EE_VIDEO_TOKEN", fileId: d.fileId, token: t });
      } else if (d.type === "E2EE_NEED_CREDS") {
        // The SW was restarted and lost this video's creds — re-supply them (with a
        // fresh token) so it can resume serving ranges.
        const entry = active.get(d.fileId);
        if (entry) postToSW({ type: "E2EE_VIDEO", fileId: d.fileId, creds: buildCreds(d.fileId, entry) });
      }
    });
    swReady = navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then(() => true)
      .catch(() => false);
  }
  return swReady.then(() => !!navigator.serviceWorker.controller);
}

export function streamUrl(fileId: string): string {
  return "/__e2ee_stream__/" + encodeURIComponent(fileId);
}

// Hand the SW the creds for a streamed video, then return its virtual URL — or
// null if streaming isn't available (caller falls back to download-then-play).
export async function registerStreamVideo(
  fileId: string,
  manifest: StreamManifest,
  keyBase64: string,
  mime: string,
  _token?: string,
): Promise<string | null> {
  const controlling = await ensureVideoSW();
  const ctrl = typeof navigator !== "undefined" && navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!controlling || !ctrl) return null;
  if (!keyBase64 || !manifest || !manifest.count) return null;
  const entry = { key: keyBase64, manifest, mime: mime || "video/mp4" };
  active.set(fileId, entry);
  const creds = buildCreds(fileId, entry);
  if (!creds.token) {
    active.delete(fileId);
    return null;
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = fin;
      ctrl.postMessage({ type: "E2EE_VIDEO", fileId, creds }, [ch.port2]);
    } catch {
      fin();
    }
    setTimeout(fin, 1500); // never hang playback on a slow/absent ack
  });
  return streamUrl(fileId);
}

export function dropStreamVideo(fileId: string): void {
  active.delete(fileId);
  postToSW({ type: "E2EE_VIDEO_DROP", fileId });
}
