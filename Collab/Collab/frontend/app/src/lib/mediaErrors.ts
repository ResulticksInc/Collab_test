// Turns a getUserMedia / getDisplayMedia rejection into calm, product-owned,
// OS-specific guidance for calls and meetings. Principles (per product direction):
//  • The PRODUCT owns the failure — copy never blames the user ("Collab couldn't
//    reach your camera", not "You blocked the camera").
//  • Be EXACT about the fix, especially the macOS privacy checkpoints, because
//    every mac browser (Safari, Chrome, Brave) is gated by the OS Privacy layer
//    that Windows has no equivalent of — the #1 reason mac users see dead media.
//  • Surface ONCE, calmly (a single persistent inline banner) — never a barrage
//    of toasts/popups — but never stay blank/silent on a real failure either.

export type MediaErrorKind =
  | "permission"
  | "in-use"
  | "not-found"
  | "unavailable"
  | "insecure"
  | "dismissed"
  | "unknown";

export type MediaWhat = "camera" | "microphone" | "screen";

export interface MediaGuidance {
  kind: MediaErrorKind;
  what: MediaWhat;
  /** One short, product-owned sentence naming what we couldn't do. */
  title: string;
  /** Concrete, ordered steps to fix it. Empty when nothing to show (dismissed). */
  steps: string[];
  /** True for benign cases (the user cancelled the picker) — render nothing. */
  silent: boolean;
}

function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = (navigator.platform || "") + " " + (navigator.userAgent || "");
  // Exclude iOS/iPadOS — different guidance; here we care about desktop macOS.
  return /mac/i.test(p) && !/iphone|ipad|ipod/i.test(p);
}

function browserName(): string {
  if (typeof navigator === "undefined") return "your browser";
  const ua = navigator.userAgent || "";
  if ((navigator as any).brave) return "Brave";
  if (/edg\//i.test(ua)) return "Edge";
  if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) return "Chrome";
  if (/safari/i.test(ua) && !/chrome\//i.test(ua)) return "Safari";
  if (/firefox/i.test(ua)) return "Firefox";
  return "your browser";
}

const CAP = (w: MediaWhat) => (w === "camera" ? "Camera" : w === "microphone" ? "Microphone" : "Screen Recording");

/**
 * Classify a media-acquisition error into user-facing guidance.
 * `what` = which device we were trying to open.
 */
export function classifyMediaError(err: any, what: MediaWhat): MediaGuidance {
  const name = (err && (err.name || err.code || "")) + "";
  const mac = isMac();
  const b = browserName();
  const noun = what === "screen" ? "screen" : what;

  // Screen picker actively cancelled by the user → benign, say nothing.
  if (what === "screen" && (name === "AbortError" || name === "NotAllowedError" && /cancel/i.test(String(err?.message || "")))) {
    // NotAllowedError on screen is ambiguous (cancel vs OS-blocked); treat a
    // literal cancel message as benign, otherwise fall through to permission.
    if (name === "AbortError") return { kind: "dismissed", what, title: "", steps: [], silent: true };
  }

  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    if (what === "screen") {
      return {
        kind: "permission",
        what,
        title: "Collab couldn't start screen sharing — your system is blocking it.",
        steps: mac
          ? [
              "Open  System Settings → Privacy & Security → Screen Recording.",
              `Turn on ${b}.`,
              `Fully quit ${b} and reopen it (macOS only applies Screen Recording after a restart), then share again.`,
            ]
          : [`When ${b} asks, choose Allow and pick a screen or window to share.`],
        silent: false,
      };
    }
    return {
      kind: "permission",
      what,
      title: `Collab couldn't reach your ${noun} — access is turned off.`,
      steps: mac
        ? [
            `Open  System Settings → Privacy & Security → ${CAP(what)}.`,
            `Turn on ${b}.`,
            `Fully quit ${b} and reopen it, then rejoin the ${"call"}.`,
          ]
        : [
            `Click the lock / ${noun} icon in ${b}'s address bar, set ${noun} to Allow, then rejoin.`,
          ],
      silent: false,
    };
  }

  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return {
      kind: "in-use",
      what,
      title: `Your ${noun} is busy — another app is using it.`,
      steps: [
        `Close anything else that might hold the ${noun} (Zoom, Teams, Photo Booth, FaceTime, another Collab tab), then try again.`,
      ],
      silent: false,
    };
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return {
      kind: "not-found",
      what,
      title: `Collab couldn't find a working ${noun}.`,
      steps: [
        `Check a ${noun} is connected, then pick it under  Settings → Devices  and try again.`,
      ],
      silent: false,
    };
  }

  return {
    kind: "unknown",
    what,
    title: `Collab couldn't turn on your ${noun}.`,
    steps: [`Try again. If it keeps happening, refresh the page or restart ${b}.`],
    silent: false,
  };
}
