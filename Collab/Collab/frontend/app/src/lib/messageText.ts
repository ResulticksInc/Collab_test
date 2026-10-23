// Single source of truth for turning a stored message body (rich HTML from the
// TipTap composer, e.g. "<ul><li><p>hi</p></li><li><p>hi</p></li></ul>") into a
// clean plain-text preview for every non-bubble surface: reply quotes, pins,
// bookmarks, the forward dialog, search results, sidebar/dashboard previews,
// notifications, etc.
//
// Why a shared helper: these previews were each doing (or NOT doing) their own
// ad-hoc strip, so raw "<p>"/"<li>" tags leaked into the UI in several places.
// Previews are COMPACT — only the first line/block is shown (WhatsApp-style), so
// a multi-line message or a list doesn't get flattened onto one long row.

const ENTITY: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

function decodeEntities(s: string): string {
  return s.replace(/&[a-z]+;|&#\d+;/gi, (m) => {
    if (ENTITY[m.toLowerCase()] != null) return ENTITY[m.toLowerCase()];
    const num = /^&#(\d+);$/.exec(m);
    if (num) {
      try { return String.fromCodePoint(parseInt(num[1], 10)); } catch (_) { /* ignore */ }
    }
    return m;
  });
}

/**
 * Compact one-line preview of message HTML: returns ONLY the first non-empty
 * line/block, tags stripped and entities decoded. So "<ul><li>hi</li>
 * <li>hi</li></ul>" -> "hi", and a multi-paragraph message -> its first
 * paragraph. Safe on plain strings and on null/undefined (returns "").
 */
export function messagePreview(html: string | null | undefined): string {
  if (html == null) return "";
  let s = String(html);
  // Mark every block/line boundary with a newline, then keep only the FIRST
  // non-empty line.
  s = s.replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr|pre)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Drop every remaining tag.
  s = s.replace(/<[^>]+>/g, "");
  const firstLine = decodeEntities(s)
    .split("\n")
    .map((t) => t.replace(/\s+/g, " ").trim())
    .find((t) => t.length > 0);
  return firstLine || "";
}

/**
 * The FIRST line of a message as a single-line HTML snippet that KEEPS inline
 * formatting (bold/italic/links/mentions/code) — for compact formatted previews.
 * A list previews as "• hi", a bold paragraph keeps its <strong>, etc. Block
 * structure (the <ul>/<p> wrappers, extra items) is dropped so it stays one line.
 * Returns a small HTML string (caller must sanitize before rendering).
 */
export function firstLineHtml(html: string | null | undefined): string {
  if (html == null) return "";
  const s = String(html);
  // Grab the first block element's inner content (li / p / heading / quote / …).
  const m = /<(li|blockquote|pre|div|h[1-6]|p)[^>]*>([\s\S]*?)<\/\1>/i.exec(s);
  let inner: string;
  let bullet = false;
  if (m) {
    inner = m[2];
    bullet = /^li$/i.test(m[1]);
  } else {
    inner = s.split(/<br\s*\/?>/i)[0];
  }
  // Drop any nested BLOCK structure so it renders on one line; keep inline marks.
  inner = inner
    .replace(/<\/?(?:ul|ol|li|p|div|h[1-6]|blockquote|pre|table|thead|tbody|tr|td|th|hr)[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (bullet ? "• " : "") + inner;
}

// Full flattened plain text (all lines joined by spaces) — for the rare case
// where the entire body is wanted as one string rather than just the first line.
export function messagePlain(html: string | null | undefined): string {
  if (html == null) return "";
  let s = String(html);
  s = s.replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr|td|th|pre)>/gi, " ").replace(/<br\s*\/?>/gi, " ");
  s = s.replace(/<[^>]+>/g, "");
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

/**
 * Pull the RESOLVED @mention targets out of composed message HTML.
 *
 * The composer writes each accepted mention as
 *   <span class="mention" data-user-id="<id>">@Full Name</span>
 * so the picked person's identity is already unambiguous at send time. Reading
 * the ids here lets the sender ship them as metadata, which is the only way
 * mentions can work at all in an end-to-end-encrypted conversation (the server
 * never sees the text) and the only way to distinguish two people who share a
 * first name (the server's fallback resolves "@Ravi" by first name alone).
 *
 * `broadcast` reports an @channel / @here token, which addresses the whole
 * conversation rather than specific ids and so can't be expressed as a list.
 * Regex rather than DOM parsing: this runs on the send path, and the markup is
 * produced by our own editor, not arbitrary input.
 */
export function extractMentionMeta(html: string | null | undefined): {
  userIds: string[];
  broadcast: "channel" | "here" | null;
} {
  const s = String(html || "");
  const ids = new Set<string>();
  const re = /data-user-id="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const id = (m[1] || "").trim();
    // The picker uses these sentinels for the broadcast rows; they are not users.
    if (id && id !== "__channel__" && id !== "__here__") ids.add(id);
  }
  const plain = messagePlain(s);
  const broadcast = /(^|\s)@channel\b/i.test(plain)
    ? "channel"
    : /(^|\s)@(?:here|everyone|all)\b/i.test(plain)
      ? "here"
      : null;
  return { userIds: [...ids], broadcast };
}

/**
 * Compact preview for any message-like object (text, voice note, or file
 * attachment), used by quote/reply/pin/bookmark/forward rows. `emptyLabel` is
 * returned when there's nothing renderable (default "Message").
 */
export function messageRowPreview(
  m: { text?: string | null; type?: string | null; file?: { name?: string } | null } | null | undefined,
  emptyLabel = "Message",
): string {
  if (!m) return emptyLabel;
  const plain = messagePreview(m.text);
  if (plain) return plain;
  if (m.type === "voice") return "🎙 Voice message";
  if (m.type === "sticker") return "🖼️ Sticker";
  if (m.type === "gif") return "🎞️ GIF";
  if (m.file) return "📎 " + (m.file.name || "Attachment");
  return emptyLabel;
}
