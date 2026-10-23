// ─────────────────────────────────────────────────────────────────────────────
// Deep linking (colab://) — DESKTOP ONLY.
//
// The Electron main process registers `colab:` as a custom URL scheme. When a
// colab://… link is opened (from a notification, a browser, or the OS) it is
// normalised in the main process to a compact "kind/rest" path and forwarded to
// the renderer via window.collabDesktop.onDeepLink. This module parses that path
// into a typed action; CoLabV1 maps the action onto its EXISTING navigation /
// jump functions (onSelect, setMode, setJumpMsgId, onJoinMeeting) — this file
// never navigates the page or touches the DOM itself.
//
// SECURITY: only the colab: scheme is ever handled (the main process rejects
// everything else before it reaches here); this parser additionally whitelists
// the kind, so an unknown/garbage link is a no-op (never throws). Ids are taken
// verbatim as opaque tokens and passed to the existing handlers, which already
// validate them server-side.
// ─────────────────────────────────────────────────────────────────────────────

export type DeepLinkAction =
  | { kind: "new" }
  | { kind: "chat"; conversationId: string }
  | { kind: "message"; conversationId: string; messageId: string }
  | { kind: "meeting"; meetingId: string }
  | { kind: "call"; conversationId: string }
  | {
      kind: "presence";
      state: "available" | "away" | "busy" | "dnd" | "brb" | "offline";
    };

/**
 * Parse a colab:// deep link (or the already-normalised "kind/rest" path the
 * Electron preload forwards) into a typed action.
 *
 * Grammar (path after the scheme):
 *   new                                  → open the new-message composer
 *   chat/<conversationId>                → open that conversation
 *   message/<conversationId>/<messageId> → open + jump to the message
 *   meeting/<meetingId>                  → open the meeting join flow
 *   call/<conversationId>                → open the conversation (start = user action)
 *   presence/<available|away|busy|dnd|brb|offline> → quick-set the user's status
 *
 * Returns null for any unknown kind, missing segment, or malformed input.
 */
export function parseDeepLink(input: string): DeepLinkAction | null {
  if (typeof input !== "string") return null;
  let path = input.trim();
  if (!path) return null;

  // Accept both the raw "colab://chat/123" and the normalised "chat/123".
  path = path.replace(/^colab:\/\//i, "");
  // Drop any fragment and a trailing slash, and any leading slashes.
  path = path.replace(/#.*$/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!path) return null;

  // Segments are decoded so a percent-encoded id round-trips to the raw token.
  const segments = path.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const [kind, a, b] = segments;
  if (!kind) return null;

  switch (kind.toLowerCase()) {
    case "new":
      return { kind: "new" };
    case "chat":
      return a ? { kind: "chat", conversationId: a } : null;
    case "message":
      return a && b ? { kind: "message", conversationId: a, messageId: b } : null;
    case "meeting":
      return a ? { kind: "meeting", meetingId: a } : null;
    case "call":
      return a ? { kind: "call", conversationId: a } : null;
    case "presence": {
      const s = (a || "").toLowerCase();
      // Full Teams manual-presence set (available maps to "auto" downstream).
      return (
        s === "available" ||
        s === "away" ||
        s === "busy" ||
        s === "dnd" ||
        s === "brb" ||
        s === "offline"
      )
        ? { kind: "presence", state: s }
        : null;
    }
    default:
      return null; // unknown kind → ignore
  }
}

/**
 * Subscribe to colab:// deep links from the Electron shell and route each parsed
 * action through `onAction`. No-op (returns a noop cleanup) in the browser,
 * where window.collabDesktop is undefined. Calls deepLinkReady() once subscribed
 * so a link captured during a cold launch is flushed by the main process.
 *
 * @returns an unsubscribe function.
 */
export function subscribeDeepLinks(
  onAction: (action: DeepLinkAction) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const cd = (window as unknown as { collabDesktop?: any }).collabDesktop;
  if (!cd || typeof cd.onDeepLink !== "function") return () => {};

  let off: (() => void) | undefined;
  try {
    off = cd.onDeepLink((url: string) => {
      const action = parseDeepLink(url);
      if (action) {
        try {
          onAction(action);
        } catch {
          /* never let a routing error escape into Electron IPC */
        }
      }
    });
    // Tell the main process we're ready so queued cold-launch links are flushed.
    if (typeof cd.deepLinkReady === "function") cd.deepLinkReady();
  } catch {
    return () => {};
  }
  return typeof off === "function" ? off : () => {};
}
