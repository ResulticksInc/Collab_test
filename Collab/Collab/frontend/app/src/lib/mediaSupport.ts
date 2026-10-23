// Browser media-capability + LiveKit URL helpers shared by the call and meeting
// paths.
//
// WHY THIS EXISTS: browsers expose `navigator.mediaDevices` (getUserMedia,
// enumerateDevices, setSinkId…) ONLY in a *secure context* — HTTPS, or the
// loopback origins http://localhost / http://127.0.0.1. When CoLab is served
// over plain HTTP from a LAN IP (e.g. http://10.205.11.8:3002),
// `navigator.mediaDevices` is `undefined`, so the very first call/meeting media
// step throws the cryptic "Cannot read properties of undefined (reading
// 'getUserMedia')" and the user only sees "Unable to connect to media server".
// This is a browser security rule — no client code can bypass it; the app must
// be reached over HTTPS (or localhost on the server). These helpers detect the
// situation up front and explain it, instead of crashing.

/** True when the browser will actually let us open the mic/camera. */
export function hasMediaDevices(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

/**
 * True when the browser can capture the screen (getDisplayMedia). This is a
 * SEPARATE capability from getUserMedia: notably iOS/iPadOS Safari supports mic/
 * camera but has NO getDisplayMedia at all, so screen share is impossible there.
 * Gate the "Share screen" control on this so it's honestly disabled instead of
 * throwing a generic error when tapped on an iPhone/iPad. (macOS Safari 13+ has
 * it and works — system-audio is silently dropped, which is fine.)
 */
export function canScreenShare(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof (navigator.mediaDevices as any).getDisplayMedia === "function"
  );
}

/**
 * Returns a clear, user-facing reason why calls/meetings can't use the
 * microphone/camera here, or `null` if media is available. Call this before
 * connecting to LiveKit so we fail fast with guidance rather than a stack trace.
 */
export function mediaBlockedReason(): string | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  if (hasMediaDevices()) return null;

  // mediaDevices missing → almost always an insecure (non-HTTPS, non-localhost)
  // origin. window.isSecureContext is the authoritative signal.
  const insecure = (window as any).isSecureContext === false;
  if (insecure) {
    const host = window.location && window.location.host ? window.location.host : "this address";
    return (
      "Calls and meetings need a secure connection. You're using Collab over an " +
      "insecure address (http://" + host + "), and your browser blocks microphone " +
      "and camera access there. Open Collab over HTTPS — or http://localhost on the " +
      "server itself — to start or join a call."
    );
  }
  return (
    "This browser can't access the microphone or camera. Use an up-to-date " +
    "Chrome, Edge, Firefox, or Safari, served over HTTPS."
  );
}

/**
 * Upgrades a `ws://` LiveKit signalling URL to `wss://` when the page itself is
 * served over HTTPS. A secure page may not open an insecure WebSocket — the
 * browser blocks it as mixed content — so if the backend hands back a stale
 * `ws://` URL we make it match the page's scheme. No-op on http pages or when
 * the URL is already wss://.
 */
export function preferSecureWsUrl(wsUrl: string): string {
  try {
    if (
      typeof window !== "undefined" &&
      window.location &&
      window.location.protocol === "https:" &&
      /^ws:\/\//i.test(wsUrl)
    ) {
      return wsUrl.replace(/^ws:\/\//i, "wss://");
    }
  } catch (_) {
    /* ignore — fall through to the original URL */
  }
  return wsUrl;
}

/**
 * The video codec to PUBLISH with — NEVER hardcoded. Reads this browser's real
 * SENDER capabilities (RTCRtpSender.getCapabilities) and returns the best codec
 * it can actually ENCODE, chosen only from codecs that EVERY modern browser can
 * DECODE — so each participant sends in whatever it supports and everyone can
 * still receive it:
 *   • Chrome / Edge / Firefox  → VP9  (they can encode it; all browsers decode it,
 *                                       Safari included — Apple's VP9 is decode-only)
 *   • Safari / WebKit (macOS)  → H.264 (VP9 is absent from Safari's SENDER caps, so
 *                                       it is never chosen there — the old hardcoded
 *                                       VP9 was exactly why Safari-mac couldn't send)
 *   • anything else            → VP8  (universally encodable + decodable)
 * Returns `undefined` when capabilities can't be read → let livekit-client pick
 * its own default. AV1 is deliberately not selected (decode/HW support is uneven).
 */
export function preferredVideoCodec(): string | undefined {
  try {
    const RtpSender: any =
      typeof window !== "undefined" ? (window as any).RTCRtpSender : null;
    const caps =
      RtpSender && typeof RtpSender.getCapabilities === "function"
        ? RtpSender.getCapabilities("video")
        : null;
    const codecs = caps && Array.isArray(caps.codecs) ? caps.codecs : null;
    if (!codecs) return undefined; // unknown → let LiveKit negotiate its default
    const canEncode = (name: string) =>
      codecs.some(
        (c: any) => String(c.mimeType || "").toLowerCase() === "video/" + name,
      );
    if (canEncode("vp9")) return "vp9";
    if (canEncode("h264")) return "h264";
    if (canEncode("vp8")) return "vp8";
    return undefined;
  } catch (_) {
    return undefined;
  }
}
