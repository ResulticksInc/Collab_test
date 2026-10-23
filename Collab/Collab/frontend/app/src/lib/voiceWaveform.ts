// Real voice-message waveform (WhatsApp model): the SENDER decodes the clip it
// just recorded and ships a small array of normalized peaks inside the message's
// `voice` payload (voice_json round-trips it server-side untouched). Receivers
// then render the true shape of the audio without downloading or decoding
// anything — which also keeps E2EE voice notes cheap: the peaks ride the
// (encrypted) message envelope, not the blob.
//
// Best-effort by design: any decode failure returns null and the player falls
// back to its synthetic bars, so a waveform can never block or fail a send.

export const WAVEFORM_BUCKETS = 48;

// Decode `blob` and reduce it to `buckets` peak values, normalized to 1–100
// integers (0 is reserved visually for "no data"). Uses OfflineAudioContext-free
// decodeAudioData on a plain AudioContext, which Chromium (web + Electron),
// Firefox and Safari all support for the containers we record (webm/opus, mp4).
export async function computeWaveform(
  blob: Blob,
  buckets: number = WAVEFORM_BUCKETS,
): Promise<number[] | null> {
  try {
    const AC: any =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC || !blob || !blob.size) return null;
    const ctx = new AC();
    try {
      const buf = await blob.arrayBuffer();
      // Safari's callback-style decodeAudioData still resolves the promise form
      // in current versions; wrap defensively anyway.
      const audio: AudioBuffer = await new Promise((resolve, reject) => {
        const p = ctx.decodeAudioData(buf, resolve, reject);
        // Some implementations return a promise AND call the callbacks.
        if (p && typeof (p as any).then === "function")
          (p as Promise<AudioBuffer>).then(resolve, reject);
      });
      const data = audio.getChannelData(0); // mono view is plenty for a preview
      const n = Math.max(8, Math.min(200, buckets | 0));
      const per = Math.max(1, Math.floor(data.length / n));
      const peaks = new Array<number>(n).fill(0);
      for (let b = 0; b < n; b++) {
        const start = b * per;
        const end = b === n - 1 ? data.length : start + per;
        let max = 0;
        // Stride through the bucket (every 4th sample) — visually identical to a
        // full scan for a preview, ~4x cheaper on a 5-minute clip.
        for (let i = start; i < end; i += 4) {
          const v = Math.abs(data[i]);
          if (v > max) max = v;
        }
        peaks[b] = max;
      }
      // Normalize against the clip's own loudest moment so quiet recordings
      // still render a readable shape (matches WhatsApp's relative scaling).
      const loudest = Math.max(...peaks, 0.001);
      return peaks.map((p) => Math.max(1, Math.round((p / loudest) * 100)));
    } finally {
      try {
        void ctx.close();
      } catch (_) {}
    }
  } catch (_) {
    return null; // fall back to the synthetic bars — never block the send
  }
}

// Validate an incoming waveform from the payload before rendering: only accept
// a plausibly-sized array of finite numbers (defends against a malformed or
// hostile payload driving the renderer).
export function sanitizeWaveform(w: any): number[] | null {
  if (!Array.isArray(w) || w.length < 8 || w.length > 200) return null;
  const out: number[] = [];
  for (const v of w) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    out.push(Math.max(1, Math.min(100, Math.round(n))));
  }
  return out;
}
