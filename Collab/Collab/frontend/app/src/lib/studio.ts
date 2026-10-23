// Sticker/GIF creation studio — open/close plumbing. Mirrors lib/dialog.ts: a
// tiny module-level singleton so any call site (the GifPicker composer, a future
// slash-command, etc.) can `await openStudio()` and get back the created media,
// while a single <MediaStudioHost/> mounted once at the CoLabV1 root owns the
// actual editor surface (portaled to <body> at the studio z-layer). Decoupling
// the trigger from the host is what lets the studio out-rank the comms sidebar /
// call stage in every context without threading props through ChatView.

import type { PickedMedia } from "../components/GifPicker";

export interface StudioRequest {
  id: number;
  // Which tab the editor opens on. "sticker" → still transparent sticker,
  // "gif" → animated. The user can switch inside the editor.
  mode?: "sticker" | "gif";
  resolve: (media: PickedMedia | null) => void;
}

let seq = 0;
let current: StudioRequest | null = null;
let listener: ((r: StudioRequest | null) => void) | null = null;

function notify() {
  if (listener) listener(current);
}

// Subscribed by <MediaStudioHost/>. Returns an unsubscribe fn; a later subscribe
// replaces the earlier listener (only one host is expected).
export function subscribeStudio(
  fn: (r: StudioRequest | null) => void,
): () => void {
  listener = fn;
  notify();
  return () => {
    if (listener === fn) listener = null;
  };
}

// Open the studio. Resolves with the created PickedMedia when the user sends it,
// or null when they only saved it to their tray / cancelled. Awaiting never
// hangs where there's no host (SSR / pre-hydration).
export function openStudio(opts?: {
  mode?: "sticker" | "gif";
}): Promise<PickedMedia | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    current = { id: ++seq, mode: opts?.mode, resolve };
    notify();
  });
}

// Called by the host when the editor closes. `media` non-null → send it; null →
// dismissed / saved-only.
export function closeStudio(id: number, media: PickedMedia | null) {
  if (!current || current.id !== id) return;
  const r = current;
  current = null;
  r.resolve(media);
  notify();
}
