// helpers.tsx — ChatView module-scope pure helpers (extracted verbatim from ChatView.tsx lines 1-2811).
// Mechanical extraction from ChatView.tsx. Do not hand-edit beyond imports.

import React, { useEffect } from "react";
import { presenceDotClass } from "../../lib/presence";
import { messagePlain } from "../../lib/messageText";
import { useEsc } from "../../lib/escStack";
import { copyText } from "../../lib/clipboard";
import { sanitizeMessageHtml as sanitizeHtml, HTML_TAG_RE } from "../../lib/sanitizeHtml";
import { mimeOf } from "../../lib/desktopFiles";

// A rich-text value is "blank" when its PLAIN text (tags stripped) is only
// whitespace — e.g. "<p> </p>" or "<p>&nbsp;</p>". Trimming the HTML string
// alone would treat those as non-empty and send a blank message.
export const isBlankRich = (html: string) =>
  !messagePlain(html || "")
    .replace(/ /g, " ")
    .trim();

export const cleanUrl = (raw: string) =>
  (raw || "").split('"')[0].split("<")[0].split(">")[0].trim();

// ISSUE #12: build the Links panel CLIENT-side from the decrypted messages the
// client already holds. The server can't index links in an E2EE conversation
// (the stored body is ciphertext / NULL), so its /links endpoint is always empty
// there. This parses real <a href> anchors AND scans the visible text for
// http(s):// and scheme-less (www./bare-domain) URLs, normalises + dedupes, and
// returns { url, messageId, createdAt, sender } newest-first.
export function extractLinksFromMessages(messages: any[]): any[] {
  if (typeof window === "undefined" || !Array.isArray(messages)) return [];
  const urlRe = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
  const byUrl = new Map<string, any>();
  for (const m of messages) {
    if (!m || m.deleted || !m.text) continue;
    let candidates: string[] = [];
    try {
      const doc = new DOMParser().parseFromString(m.text, "text/html");
      doc.querySelectorAll("a[href]").forEach((a) => {
        const h = a.getAttribute("href");
        if (h) candidates.push(h);
      });
      const text = (doc.body && doc.body.textContent) || "";
      let mm: RegExpExecArray | null;
      urlRe.lastIndex = 0;
      while ((mm = urlRe.exec(text)) !== null) candidates.push(mm[1]);
    } catch {
      /* malformed HTML — skip this message */
    }
    for (let url of candidates) {
      url = url.replace(/[.,;:!?)\]]+$/, "").trim(); // strip trailing punctuation
      if (!url || url.length < 4) continue;
      if (!/^https?:\/\//i.test(url)) url = "https://" + url; // normalise www./bare
      // Keep the MOST RECENT occurrence of each distinct URL.
      const prev = byUrl.get(url);
      if (
        !prev ||
        (Date.parse(m.createdAt) || 0) > (Date.parse(prev.createdAt) || 0)
      )
        byUrl.set(url, {
          url,
          messageId: m.id,
          createdAt: m.createdAt,
          sender: m.sender,
        });
    }
  }
  return Array.from(byUrl.values()).sort(
    (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
  );
}

// ── Unified Action Bar — slash commands (CEO gap doc) ───────────────────────
// First-class "/" commands in the composer, wired to the IN-APP modules (tasks,
// reminders, meetings) — the self-hosted take on /jira-style action bars (no
// external SaaS credentials involved). ONLY these known commands are ever
// intercepted at send time; any other "/"-leading text (paths, /shrug, …) sends
// as a normal message, so no user message can be silently swallowed.
export const SLASH_COMMANDS: { cmd: string; usage: string; title: string; desc: string; example?: string }[] = [
  // ISSUE #15: /task and /remind removed from the slash menu while the Tasks &
  // Reminders modules are hidden (runSlash's task/remind branches stay as dead
  // code — restore the two entries here to re-enable). Removing them from this
  // array also stops submit() intercepting them, so they just send as chat text.
  {
    cmd: "meet",
    usage: "/meet [title]",
    title: "Start a meeting",
    desc: "Start a meeting right now — an invite card posts into this chat so anyone here can join in one click.",
    example: "/meet Q3 sync",
  },
  // /help removed per request. runSlash's "help" branch stays as harmless dead
  // code; without this entry, submit() no longer intercepts "/help" (it sends as
  // plain chat text) and it's gone from the command menu.
];


// ─── Popup Helpers ──────────────────────────────────────────────────────────
export function useOutsideClick(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onClose, enabled]);
}

export function useEscapeKey(onClose: () => void, enabled = true) {
  // Route Escape through the app-wide LIFO stack (lib/escStack) instead of a raw
  // window keydown. The global handler in CoLabV1 runs ONLY the topmost registered
  // overlay and — critically — does NOT also fire a module "Back" when an overlay
  // consumed Escape. A raw listener here closed the overlay AND let Back run on the
  // same keypress, so pressing Esc over an image/popup jumped to the previous
  // module. On the stack, Esc closes THIS overlay and stops there.
  useEsc(enabled, onClose);
}

export function usePopup(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
) {
  useOutsideClick(ref, onClose, enabled);
  useEscapeKey(onClose, enabled);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export const dotClass = presenceDotClass;

export function toLocalInput(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtSchedule(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const codeStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.9em",
  background: "var(--g100)",
  color: "var(--g900)",
  padding: "1px 5px",
  borderRadius: 5,
};

export function renderInline(t: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let key = 0;
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };
  const rules: { re: RegExp; make: (m: RegExpExecArray) => React.ReactNode }[] =
    [
      {
        re: /^`([^`]+)`/,
        make: (m) => (
          <code key={key++} style={codeStyle}>
            {m[1]}
          </code>
        ),
      },
      {
        re: /^\*\*([\s\S]+?)\*\*/,
        make: (m) => <strong key={key++}>{renderInline(m[1])}</strong>,
      },
      {
        re: /^~~([\s\S]+?)~~/,
        make: (m) => <s key={key++}>{renderInline(m[1])}</s>,
      },
      {
        re: /^\*([^*\n]+?)\*/,
        make: (m) => <em key={key++}>{renderInline(m[1])}</em>,
      },
      {
        re: /^_([^_\n]+?)_/,
        make: (m) => <em key={key++}>{renderInline(m[1])}</em>,
      },
      {
        re: /^(https?:\/\/[^\s]+)/,
        make: (m) => (
          <a
            key={key++}
            className="msg-link"
            href={m[1]}
            target="_blank"
            rel="noreferrer"
          >
            {m[1]}
          </a>
        ),
      },
      {
        re: /^@([A-Za-z0-9_]+)/,
        make: (m) => (
          <span key={key++} className="mention">
            @{m[1]}
          </span>
        ),
      },
    ];
  while (i < t.length) {
    const rest = t.slice(i);
    let hit: {
      m: RegExpExecArray;
      make: (m: RegExpExecArray) => React.ReactNode;
    } | null = null;
    for (const r of rules) {
      if (r.re.source.startsWith("^@") && i > 0 && !/\s/.test(t[i - 1]))
        continue;
      const m = r.re.exec(rest);
      if (m) {
        hit = { m, make: r.make };
        break;
      }
    }
    if (hit) {
      flush();
      out.push(hit.make(hit.m));
      i += hit.m[0].length;
    } else {
      buf += t[i];
      i++;
    }
  }
  flush();
  return out;
}

// Detect rich-text (Tiptap) HTML — broadened to every block/inline tag the
// composer can emit, so a table-only / blockquote-only / code-only message is
// recognised as HTML and rendered (previously these fell through to the
// plain-text path and rendered as broken raw markup).


// Convert a (rich-HTML) message body to clean plain text. Uses the DOM so
// entities/markup resolve exactly as displayed (e.g. <p>hi</p> -> "hi"), with a
// regex fallback for SSR.
export function htmlToPlain(html: string): string {
  if (typeof document !== "undefined") {
    const el = document.createElement("div");
    el.innerHTML = String(html || "");
    return (el.textContent || (el as any).innerText || "")
      .replace(/ /g, " ")
      .trim();
  }
  return String(html || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// Lightweight, self-contained toast for module-scope utilities that have no
// React context (e.g. the copy action fired from a message bubble). Non-intrusive,
// auto-dismissing, and coalesces rapid calls into one element.
export let _toastEl: HTMLDivElement | null = null;
export let _toastTimer: any = null;
export function flashToast(message: string): void {
  if (typeof document === "undefined") return;
  try {
    if (!_toastEl) {
      _toastEl = document.createElement("div");
      _toastEl.setAttribute("role", "status");
      _toastEl.setAttribute("aria-live", "polite");
      _toastEl.style.cssText =
        "position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(8px);" +
        "z-index:4000;padding:9px 16px;border-radius:999px;font:600 13px/1 system-ui,-apple-system,sans-serif;" +
        "color:#fff;background:rgba(20,24,34,0.94);box-shadow:0 12px 32px -10px rgba(0,0,0,0.6);" +
        "opacity:0;transition:opacity .18s ease,transform .18s ease;pointer-events:none;";
      document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = message;
    const el = _toastEl;
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateX(-50%) translateY(0)";
    });
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(-50%) translateY(8px)";
      setTimeout(() => {
        if (el.parentNode) el.parentNode.removeChild(el);
        if (_toastEl === el) _toastEl = null;
      }, 220);
    }, 1500);
  } catch (_) {
    /* ignore */
  }
}

// Chat history windowing: render a modest window initially and reveal older
// messages in small chunks, so scrolling back never renders a huge batch at
// once (keeps the message list light on DOM + memory). 25 per chunk per spec.
export const CHAT_WINDOW_INITIAL = 50;
export const CHAT_WINDOW_CHUNK = 25;
// The server's page size for history fetches. Mirrors the backend default: a
// thread holding fewer than this in total provably has nothing older, and a
// fetch returning fewer than this was the last page.
export const CHAT_PAGE_SIZE = 50;

// "Copy text" copies PLAIN TEXT ONLY. It used to also put a text/html flavour
// on the clipboard so rich editors kept bold/links — but pasting then dragged
// the message styling along (users saw bubble colours/fonts in Word, mail,
// etc.). Plain text pastes cleanly everywhere; a user who wants formatting can
// still forward the message in-app.
export function copyMessageText(raw: string): Promise<boolean> {
  return copyText(htmlToPlain(raw)).then((ok) => {
    // Say so when the browser refuses (locked-down webview, denied permission)
    // instead of failing silently — the user can still select the text by hand.
    flashToast(ok ? "Message copied" : "Couldn’t copy — select the text and press Ctrl+C");
    return ok;
  });
}

// Native copy (Cmd/Ctrl+C, right-click → Copy) of a selection inside the
// message list: strip the browser's text/html flavour so what pastes is the
// words only, not the bubble background/colour/font. Leaves the composer and
// the inline edit box alone (their own rich copy is expected there).
export function onMessageListCopy(e: React.ClipboardEvent<HTMLElement>): void {
  const t = e.target as HTMLElement | null;
  if (t && t.closest && t.closest("textarea, input, [contenteditable=\"true\"], .ProseMirror")) return;
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString();
  if (!text) return;
  try {
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  } catch (_) {
    /* let the browser do its default rich copy */
  }
}

// Format a timestamp honouring the user's 12h/24h preference at render time.
export function fmtTime(iso: string, fmt: string) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: fmt !== "24h",
  });
}

// A message whose text is ONLY emoji (ignoring whitespace / variation selectors).
export const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|️|‍|\s)+$/u;

// Teams-style @mention emphasis. Tag the mentions that address the CURRENT user
// (or the whole conversation via @channel / @here) with a `mention-me` class so
// CSS can render them as a tinted chip, while mentions of other people stay
// plain accent text. The markup is produced by our own composer (RichTextEditor's
// Mention renderHTML) and has already been through DOMPurify, so a regex on a
// known tag shape is sufficient and safe — this is not a parse of hostile input.
export function markSelfMentions(html: string, meId?: string | null): string {
  if (!meId) return html;
  return html.replace(
    /<span\b[^>]*\bclass="[^"]*\bmention\b[^"]*"[^>]*>/gi,
    (tag) => {
      const hit = /\bdata-user-id="([^"]*)"/i.exec(tag);
      const uid = hit ? hit[1].trim() : "";
      if (uid !== meId && uid !== "__channel__" && uid !== "__here__") return tag;
      return tag.replace(
        /\bclass="([^"]*)"/i,
        (_all, cls) => 'class="' + cls + ' mention-me"',
      );
    },
  );
}


// The message text node. Memoised on the HTML STRING on purpose: React rewrites
// an element's innerHTML on every re-render when it is handed a fresh
// `{ __html }` object, even if the string is identical. Any state change on the
// row (hover toolbar, read ticks, reactions, a new message arriving) therefore
// rebuilt the text and silently cleared whatever the user had selected — which
// is why drag-select / double-click / copy felt flaky. With the memo, identical
// HTML never touches the DOM, so a selection survives until the text changes.
const RichHtml = React.memo(function RichHtml({ html }: { html: string }) {
  return <span className="msg-rich" dangerouslySetInnerHTML={{ __html: html }} />;
});

export function renderBody(text: string, meId?: string | null) {
  const t = String(text || "");
  if (!t) return t;
  // Big-emoji: a message that is just 1–3 emoji renders jumbo (WhatsApp-style).
  // Bodies are stored as TipTap HTML, so unwrap a lone <p>…</p> first.
  const pm = /^<p>([\s\S]*?)<\/p>$/i.exec(t.trim());
  const inner = pm ? pm[1] : t;
  if (!HTML_TAG_RE.test(inner) && EMOJI_ONLY.test(inner.trim())) {
    try {
      const seg = (Intl as any).Segmenter
        ? Array.from(
          new (Intl as any).Segmenter(undefined, {
            granularity: "grapheme",
          }).segment(inner.trim()),
          (s: any) => s.segment,
        )
        : Array.from(inner.trim());
      const clusters = seg.filter((g: string) => g.trim());
      if (clusters.length >= 1 && clusters.length <= 3) {
        return (
          <span className={"big-emoji be-" + clusters.length}>
            {inner.trim()}
          </span>
        );
      }
    } catch (_) {
      /* fall through to normal rendering */
    }
  }
  if (HTML_TAG_RE.test(t)) {
    return <RichHtml html={markSelfMentions(sanitizeHtml(t), meId)} />;
  }
  const nodes = renderInline(t);
  return nodes.length ? nodes : t;
}


export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮"];
// Normalise emoji for reaction MATCHING (strip Unicode variation selectors) so a
// quick-bar "❤️" (carries U+FE0F) and an emoji-picker "❤" count as the SAME
// reaction — mirrors serialize.ts reactionKey() so the "you reacted" highlight
// agrees with the server-aggregated pill.
export const normReactionEmoji = (e: any): string =>
  String(e || "").replace(/[︎️]/g, "").trim();

export const TOOLBAR_HEIGHT = 40;
export const TOOLBAR_MARGIN = -2; // gap between toolbar and message top

// Teams-style profile card: how long the cursor must dwell on a group/channel
// avatar before the card appears — a deliberate hover, not an instant flash when
// the pointer merely passes over. ~0.6s reads as responsive (Teams is sub-second).
export const PERSON_CARD_DELAY = 600; // ms

// Presence value → human label for the profile card (colours come from
// presenceDotClass; this is the text beside the dot).
export function personPresenceLabel(p?: string | null): string {
  switch (String(p || "").toLowerCase()) {
    case "on":
    case "auto":
    case "active":
    case "online":
    case "available":
      return "Available";
    case "away":
    case "idle":
      return "Away";
    case "brb":
      return "Be right back";
    case "busy":
      return "Busy";
    case "dnd":
      return "Do not disturb";
    case "off":
    case "offline":
      return "Offline";
    default:
      return "";
  }
}


export const isMediaMsg = (m: any) => {
  if (!m || m.deleted || m.type === "voice" || m.type === "sticker" || m.type === "gif" || m.text) return false;
  // In-flight (uploading/sending) or failed optimistic messages render as
  // INDIVIDUAL bubbles (with their own progress bar + Cancel) — they coalesce into
  // the album grid only once settled. NOTE: exclude ONLY those transient states —
  // a live socket-delivered message carries _status:"delivered" (a SETTLED state),
  // so `!== "sent"` would wrongly keep every live album from coalescing until a
  // reload.
  if (m._status === "uploading" || m._status === "sending" || m._status === "failed")
    return false;
  // A captioned single media renders as its own .bub-media bubble (caption strip);
  // an album carries the caption at the album level instead, so the lead's caption
  // sits on m.file.caption with empty text — which still qualifies here as media.
  // Undecrypted E2EE image: keep it an individual bubble (which hits the locked
  // placeholder in FileAttachment) instead of coalescing it into the album grid.
  if (m.file && m.file.e2ee && !m.file.url) return false;
  if (
    (m.reactions && m.reactions.length) ||
    m.parentMessageId ||
    m.pinned ||
    m.bookmarked
  )
    return false;
  const mime = mimeOf(m.file);
  return !!m.file && (mime.startsWith("image/") || mime.startsWith("video/"));
};

// Coalesce runs of consecutive media-only messages from the same sender within
// the existing 5-minute grouping window into album groups. Pure render-layer:
// the underlying messages stay separate.
export function buildRenderItems(shown: any[], grouping: any) {
  const sk = (x: any) =>
    (x.sender && x.sender.id) ||
    (x.me ? "__me__" : (x.sender && x.sender.name) || "?");
  const sameRun = (a: any, b: any) => {
    if (!a || !b || sk(a) !== sk(b)) return false;
    const pa = Date.parse(a.createdAt),
      pb = Date.parse(b.createdAt);
    if (!Number.isFinite(pa) || !Number.isFinite(pb)) return false;
    return pb - pa < 5 * 60 * 1000;
  };
  const items: any[] = [];
  for (let i = 0; i < shown.length; i++) {
    const m = shown[i];
    if (grouping !== false && isMediaMsg(m)) {
      const run = [m];
      let j = i + 1;
      while (
        j < shown.length &&
        isMediaMsg(shown[j]) &&
        sameRun(run[run.length - 1], shown[j]) &&
        // A captioned media message is the LEAD of a NEW album (its own multi-send
        // with its own caption) — never absorb it into the current run, or two
        // distinct captioned sends would merge and the second caption be dropped.
        !(shown[j].file && shown[j].file.caption)
      ) {
        run.push(shown[j]);
        j++;
      }
      if (run.length >= 2) {
        items.push({ kind: "album", run });
        i = j - 1;
        continue;
      }
    }
    items.push({ kind: "msg", m });
  }
  return items;
}

// ─── MsgRow ──────────────────────────────────────────────────────────────────
