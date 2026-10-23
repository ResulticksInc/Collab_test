// Unified Connector Engine — payload normalization.
//
// Each ecosystem has its own text decoration dialect. The engine keeps ONE
// canonical form — CoLab's markdown subset — and converts at the edge:
//
//   canonical   **bold**  _italic_  ~~strike~~  `code`  ```fence```  [text](url)  > quote
//   Slack       *bold*    _italic_  ~strike~    `code`  ```fence```  <url|text>     > quote
//   Teams/Graph <b>       <i>       <s>         <code>  <pre>        <a href>       <blockquote>
//   WhatsApp    *bold*    _italic_  ~strike~    ```code```  ```fence```  text (url)  > quote
//   Google Chat *bold*    _italic_  ~strike~    `code`  ```fence```  <url|text>     quote
//
// PURE: no db, no config, no I/O — unit-tested directly
// (backend/app/test/connectors-transform.test.ts).

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const decodeHtml = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

// Protect code spans/fences from the inline substitutions, then put them back.
function withCodeProtected(text: string, fn: (s: string) => string, renderCode: (code: string, fenced: boolean) => string) {
  const slots: string[] = [];
  const stash = (code: string, fenced: boolean) => {
    slots.push(renderCode(code, fenced));
    return `\u0000${slots.length - 1}\u0000`;
  };
  let out = text.replace(/```([\s\S]*?)```/g, (_m, c) => stash(c, true));
  out = out.replace(/`([^`\n]+)`/g, (_m, c) => stash(c, false));
  out = fn(out);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => slots[Number(i)]);
}

const CANON_BOLD = /\*\*([^*\n][^*]*?)\*\*/g;
const CANON_ITALIC = /(^|[^\w*_])_([^_\n]+?)_(?![\w_])/g;
const CANON_STRIKE = /~~([^~\n]+?)~~/g;
const CANON_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

// ── Canonical → platform ────────────────────────────────────────────────────

export function toSlack(text: string): string {
  return withCodeProtected(
    text,
    (s) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        // "> quote" lines were just escaped to "&gt; quote" — restore the marker.
        .replace(/^&gt; /gm, "> ")
        .replace(CANON_LINK, "<$2|$1>")
        .replace(CANON_BOLD, "*$1*")
        .replace(CANON_STRIKE, "~$1~"),
    (code, fenced) => (fenced ? "```" + code + "```" : "`" + code + "`"),
  );
}

export function toGoogleChat(text: string): string {
  // Google Chat's text markup is Slack-like, but it does not HTML-escape and
  // has no blockquote marker.
  return withCodeProtected(
    text,
    (s) => s.replace(CANON_LINK, "<$2|$1>").replace(CANON_BOLD, "*$1*").replace(CANON_STRIKE, "~$1~"),
    (code, fenced) => (fenced ? "```" + code + "```" : "`" + code + "`"),
  );
}

export function toWhatsApp(text: string): string {
  return withCodeProtected(
    text,
    (s) =>
      s
        .replace(CANON_LINK, "$1 ($2)")
        .replace(CANON_BOLD, "*$1*")
        .replace(CANON_STRIKE, "~$1~"),
    (code) => "```" + code + "```",
  );
}

// Microsoft Graph channel/chat messages take HTML.
export function toTeamsHtml(text: string): string {
  const body = withCodeProtected(
    text,
    (s) => {
      let out = escapeHtml(s);
      out = out.replace(/^&gt; ?(.*)$/gm, "<blockquote>$1</blockquote>");
      out = out.replace(CANON_LINK, '<a href="$2">$1</a>');
      out = out.replace(CANON_BOLD, "<b>$1</b>");
      out = out.replace(CANON_ITALIC, "$1<i>$2</i>");
      out = out.replace(CANON_STRIKE, "<s>$1</s>");
      return out.replace(/\n/g, "<br>");
    },
    (code, fenced) =>
      fenced ? "<pre>" + escapeHtml(code.replace(/^\n/, "")) + "</pre>" : "<code>" + escapeHtml(code) + "</code>",
  );
  return `<div>${body}</div>`;
}

// Bot Framework activities render Markdown natively; the canonical form is
// already valid there apart from strike-through, which Teams does not render.
export function toTeamsMarkdown(text: string): string {
  return text.replace(CANON_STRIKE, "$1");
}

// ── Platform → canonical ────────────────────────────────────────────────────

export function fromSlack(text: string): string {
  return withCodeProtected(
    String(text || ""),
    (s) =>
      s
        // <https://x|label>, <https://x>, <#C123|channel>, <@U123>, <!here>
        .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
        .replace(/<(https?:\/\/[^>]+)>/g, "$1")
        .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
        .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id, name) => "@" + (name || id))
        .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
        .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1")
        .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1**$2**")
        .replace(/(^|[^~\w])~([^~\n]+?)~(?!\w)/g, "$1~~$2~~")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    (code, fenced) => (fenced ? "```" + code + "```" : "`" + code + "`"),
  );
}

export function fromGoogleChat(text: string): string {
  return fromSlack(text);
}

export function fromWhatsApp(text: string): string {
  return withCodeProtected(
    String(text || ""),
    (s) =>
      s
        .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, "$1**$2**")
        .replace(/(^|[^~\w])~([^~\n]+?)~(?!\w)/g, "$1~~$2~~"),
    (code) => "`" + code.replace(/^\n|\n$/g, "") + "`",
  );
}

// Teams message bodies arrive as HTML (Graph) or Markdown-ish text (Bot
// Framework). This handles the HTML case; plain text passes through.
export function fromTeamsHtml(html: string): string {
  let s = String(html || "");
  if (!/<[a-z!/][^>]*>/i.test(s)) return s.trim();
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, c) => "```\n" + decodeHtml(c.replace(/<[^>]+>/g, "")) + "\n```");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => "`" + decodeHtml(c.replace(/<[^>]+>/g, "")) + "`");
  s = s.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
    const t = decodeHtml(label.replace(/<[^>]+>/g, "")).trim();
    const u = decodeHtml(href);
    return t && t !== u ? `[${t}](${u})` : u;
  });
  s = s.replace(/<at[^>]*>([\s\S]*?)<\/at>/gi, (_m, n) => "@" + decodeHtml(n.replace(/<[^>]+>/g, "")));
  s = s.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, "_$2_");
  s = s.replace(/<(s|strike|del)>([\s\S]*?)<\/\1>/gi, "~~$2~~");
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, c) => "> " + c.replace(/<[^>]+>/g, "").trim());
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6])>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "• ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeHtml(s);
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

// ── Spec-compatible helper ──────────────────────────────────────────────────
// The architecture spec expresses a message as text + a list of phrases to
// bold. Build the canonical form from that shape, then go through the normal
// converters — so a caller written against the spec still gets every target.
interface SpecNormalizedMessage {
  text: string;
  boldPhrases: string[];
}
export function fromSpecShape(m: SpecNormalizedMessage): string {
  let out = String(m.text || "");
  for (const phrase of m.boldPhrases || []) {
    if (!phrase) continue;
    out = out.split(phrase).join(`**${phrase}**`);
  }
  return out;
}

type TargetFormat = "slack" | "teams_html" | "teams_markdown" | "whatsapp" | "google_chat" | "colab";
export function toPlatformFormat(canonical: string, target: TargetFormat): string {
  switch (target) {
    case "slack":
      return toSlack(canonical);
    case "teams_html":
      return toTeamsHtml(canonical);
    case "teams_markdown":
      return toTeamsMarkdown(canonical);
    case "whatsapp":
      return toWhatsApp(canonical);
    case "google_chat":
      return toGoogleChat(canonical);
    default:
      return canonical;
  }
}

// Bridged messages are posted by the mapping OWNER on the CoLab side (a message
// needs a sender), so the ORIGINAL author is carried in the text itself.
export function attribute(canonicalText: string, authorName: string | null | undefined, sourceLabel: string): string {
  const who = (authorName || "").trim();
  const head = who ? `**${who}** _(via ${sourceLabel})_` : `_(via ${sourceLabel})_`;
  return `${head}\n${canonicalText}`;
}

export const PLATFORM_LABEL: Record<string, string> = {
  slack: "Slack",
  teams: "Teams",
  google_chat: "Google Chat",
  whatsapp: "WhatsApp",
  colab: "CoLab",
};
