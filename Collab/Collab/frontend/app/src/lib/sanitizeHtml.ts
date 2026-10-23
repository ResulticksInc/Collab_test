// Shared HTML sanitizer for rendering message bodies (and their compact
// previews) safely. Same allowlist the chat bubble uses — anything else
// (script, iframe, event handlers, javascript: URLs) is stripped by DOMPurify,
// so reply/bookmark/pin/sidebar previews can render REAL formatting (bold,
// lists, etc.) without opening a stored-XSS hole.
import DOMPurify from "dompurify";

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    "p", "br", "strong", "b", "em", "i", "u", "s", "strike", "del", "a",
    "ul", "ol", "li", "blockquote", "pre", "code", "h1", "h2", "h3", "h4",
    "h5", "h6", "span", "table", "thead", "tbody", "tr", "td", "th", "img",
    "hr", "mark",
  ],
  ALLOWED_ATTR: ["href", "target", "rel", "class", "src", "alt", "title", "colspan", "rowspan", "data-user-id", "data-type", "style"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|data):|[/#])/i,
  ADD_ATTR: ["target"],
};

export const HTML_TAG_RE =
  /<(?:p|div|span|a|br|ul|ol|li|strong|em|b|i|u|s|strike|del|h[1-6]|blockquote|pre|code|table|thead|tbody|tr|td|th|img|hr|mark)[\s>/]/i;

if (typeof window !== "undefined") {
  DOMPurify.addHook("afterSanitizeAttributes", (node: any) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

export function sanitizeMessageHtml(html: string | null | undefined): string {
  if (html == null) return "";
  if (typeof window === "undefined") return String(html).replace(/<[^>]+>/g, " ");
  return String(DOMPurify.sanitize(String(html), SANITIZE_CONFIG as any));
}

