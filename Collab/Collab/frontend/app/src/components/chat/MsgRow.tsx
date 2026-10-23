// MsgRow.tsx — ChatView module-scope message row (lines 930-2472).
// Mechanical extraction from ChatView.tsx. Do not hand-edit beyond imports.

import React, { useState, useEffect, useRef, useCallback } from "react";
import { IconAlertTriangle, IconBan, IconBold, IconStar, IconCheck, IconCheckCheck, IconCircle, IconCode, IconForward, IconItalic, IconLink, IconList, IconListOrdered, IconPhone, IconPhoneMissed, IconPin, IconQuote, IconSmile, IconStrikethrough, IconUnderline, IconVideo, IconX } from "../../lib/icons";
import VoicePlayer from "../VoicePlayer";
import Avatar from "../Avatar";
import RichTextEditor, { RichTextEditorHandle } from "../RichTextEditor";
import { messageRowPreview, firstLineHtml } from "../../lib/messageText";
import { api } from "../../lib/api";
import { localTime } from "../../lib/time";
import { promptDialog } from "../../lib/dialog";
import { mimeOf, dragOutProps } from "../../lib/desktopFiles";
import { downloadAttachment } from "../../lib/downloadAttachment";
import { E2EE_PENDING_TEXT } from "../../lib/e2ee/manager";
import LinkPreview from "../LinkPreview";
import { firstUrl } from "../../lib/linkPreview";
import { sanitizeMessageHtml as sanitizeHtml } from "../../lib/sanitizeHtml";
import MessageHoverToolbar from "./MessageHoverToolbar";
import ActionSheet from "./ActionSheet";
import FileAttachment, { voiceMimeToExt } from "./FileAttachment";
import ReactionPills from "./ReactionPills";
import { TaskCard, MeetingInviteCard } from "./RichCards";
import { EncryptedPendingRow } from "./E2EEBanners";
import { MeetingEndedRow } from "./MeetingAttendance";
import { copyMessageText, fmtTime, renderBody } from "./helpers";
import { Portal, Rect, safePosition, EmojiPicker } from "./EmojiPicker";

// ─── MsgRow ──────────────────────────────────────────────────────────────────

export interface MsgRowProps {
  m: any;
  first: boolean;
  onReact: (msg: any, emoji: string) => void;
  onBookmark: (msg: any) => void;
  onForward: (msg: any) => void;
  onEdit: (msg: any, text: string) => void;
  onDelete: (msg: any, forMe: boolean) => void;
  onReplyTo: (msg: any) => void;
  onJumpTo: (id: string) => void;
  byId: Record<string, any>;
  linkPreview: boolean;
  timeFormat?: string;
  token: string;
  isMobile: boolean;
  activeId: string | null;
  onActivate: (id: string, rect: Rect) => void;
  onDeactivate: () => void;
  onJoinMeeting?: (id: string) => void;
  onRejectMeeting?: (id: string) => void;
  onOpenTask?: (id: string) => void;
  meId?: string | null;
  // Teams-style avatar interactions (DMs, groups and channels): hover the author's
  // avatar for a profile card, click it to open the DM. No-op for your own
  // messages / self.
  myIds?: Set<string>;
  onAvatarEnter?: (info: any, el: HTMLElement) => void;
  onAvatarLeave?: () => void;
  onAvatarClick?: (info: any) => void;
  // B3 — force-refetch + re-decrypt this conversation (wired to
  // loadMessages(active.id, true) in CoLabV1). The pending-row "Try again" uses
  // it so a restored backup / healed sibling is picked up immediately instead of
  // looping the sibling sync forever.
  onRetryLoad?: () => void;
}



// Skype-style seen-by for groups/channels (BA batch 2026-07-18): the ✓✓ tick
// plus a live count of members who have seen this message; hovering shows their
// names (ReactionPills-style tooltip). `seen` = { receipts, others, names },
// derived in ChatView from the SAME per-member read cursors as the tick — a
// member has seen M when their cursor >= M.createdAt. Blue when everyone has
// (identical to the old min-cursor rule). Rendered only for own messages.
export function SeenByTick({
  m,
  seen,
  timeFormat,
}: {
  m: any;
  seen: any;
  timeFormat?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const created = m.createdAt ? Date.parse(m.createdAt) : 0;
  const seers: string[] = created
    ? seen.others.filter(
      (uid: string) => (Number(seen.receipts[uid]) || 0) >= created,
    )
    : [];
  const all = seen.others.length > 0 && seers.length === seen.others.length;
  // Click-to-view read status → close on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // The popover is portaled to <body> (below), so a click inside it is NOT a
      // descendant of wrapRef — check the portal node too or it closes on its own
      // scrollbar/content.
      const t = e.target as Node;
      if (
        wrapRef.current &&
        !wrapRef.current.contains(t) &&
        !(tipRef.current && tipRef.current.contains(t))
      )
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Fixed-positioned portal doesn't track the tick as the message list scrolls,
    // so close it on any scroll rather than let it float detached.
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);
  // Position the portaled popover above the tick, clamped inside the viewport
  // (measured after render so the read-list height is known; kept off-screen at
  // opacity 0 until placed to avoid a first-frame flash).
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const a = wrapRef.current?.getBoundingClientRect();
    const t = tipRef.current?.getBoundingClientRect();
    if (!a) return;
    setPos(
      safePosition(
        { top: a.top, left: a.left, width: a.width, height: a.height },
        t?.width || 200,
        t?.height || 120,
        true,
        true,
      ),
    );
  }, [open]);
  const rows = seers
    .map((uid: string) => ({
      name: seen.names[uid] || "Someone",
      at: Number(seen.receipts[uid]) || 0,
    }))
    .sort((a, b) => a.at - b.at);
  return (
    <span
      ref={wrapRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 3 }}
    >
      <button
        type="button"
        className="msg-ack-btn"
        title="View Read Status"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className={"msg-ack " + (all || seers.length > 0 ? "read" : "delivered")}>
          <IconCheckCheck size={14} />
        </span>
        {seen.others.length > 1 && seers.length ? (
          <span className="msg-seen-count">{seers.length}</span>
        ) : null}
      </button>
      {open ? (
        <Portal>
          <span
            ref={tipRef}
            style={{
              // Portaled to <body> + position:fixed so the .msgs scroll box
              // (overflow-x:hidden / overflow-y:auto) can't clip it. Off-screen at
              // opacity 0 until safePosition places it (measured after render).
              position: "fixed",
              top: pos ? pos.top : -9999,
              left: pos ? pos.left : -9999,
              opacity: pos ? 1 : 0,
              zIndex: 4000,
              // Theme-stable dark surface: --g900 INVERTS by theme (near-black in
              // light, white in dark), which would make this white-on-white in dark
              // mode. A fixed slate keeps it readable in every theme.
              background: "#1f2937",
              color: "#fff",
              fontSize: 11.5,
              lineHeight: 1.5,
              padding: "6px 10px",
              borderRadius: 8,
              whiteSpace: "nowrap",
              boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
              textAlign: "left",
              maxHeight: 220,
              overflowY: "auto",
            }}
          >
            {rows.length ? (
              <>
                <span style={{ opacity: 0.6, display: "block", marginBottom: 3 }}>
                  Read By
                </span>
                {rows.map((r) => (
                  <span key={r.name + r.at} style={{ display: "block" }}>
                    {r.name}
                    {r.at
                      ? " · " + fmtTime(new Date(r.at).toISOString(), timeFormat || "12h")
                      : ""}
                  </span>
                ))}
              </>
            ) : (
              "No One Has Read This Yet."
            )}
          </span>
        </Portal>
      ) : null}
    </span>
  );
}

// A message this device cannot decrypt yet — either its envelope predates this
// device (no key), the forward-secret one-time key is gone, or a raw encrypted
// copy slipped into state without decrypting. Replaces the old dead-end
// "Encrypted message" lock ("Turn encryption on to read it") with a LIVE,
// actionable recovery row:
//   - While E2EE is fully enabled, fire the sibling-device heal on mount
//     (ask the user's OTHER devices to re-push this conversation's history over
//     the sync socket), show progress, and after a short wait surface an honest
//     terminal state with an explicit "Try again" instead of a permanent wall.
//   - "Try again" BOTH re-fires the sibling heal AND force-refetches +
//     re-decrypts this conversation (onRetryLoad → loadMessages(id, true)) so a
//     backup restored via the password prompt / Settings, or a healed sibling,
//     is picked up on the next attempt instead of looping forever.
//   - The terminal state is honest about recovery odds: if the account has NO
//     server-side backup AND NO other signed-in device, there is no recovery
//     path and the row says exactly that.
//   - When this build has E2EE disabled (NEXT_PUBLIC_E2EE_ENABLED off), no heal
//     can ever succeed — show an accurate note instead of the misleading lock.


export function MsgRowImpl({
  m,
  meId,
  embedded,
  readAt,
  seen,
  isLastAck,
  first,
  convTemporary,
  onReact,
  onBookmark,
  onForward,
  onEdit,
  onDelete,
  onReplyTo,
  onJumpTo,
  byId,
  linkPreview,
  timeFormat,
  token,
  isMobile,
  activeId,
  onActivate,
  onDeactivate,
  scrollingRef,
  popoverOpenRef,
  onPopoverChange,
  onRetry,
  onCancelUpload,
  onPin,
  onUnpin,
  onMarkImportant,
  onJoinMeeting,
  onRejectMeeting,
  onOpenTask,
  myIds,
  onAvatarEnter,
  onAvatarLeave,
  onAvatarClick,
  onRetryLoad,
}: MsgRowProps & {
  embedded?: boolean;
  readAt?: number;
  // Skype-style seen-by bundle ({ receipts, others, names }).
  seen?: any;
  // True only for the last of MY messages — the single row that shows a ✓✓.
  isLastAck?: boolean;
  // Conversation is an auto-created temporary group (hide the stray
  // "X created the group" system line).
  convTemporary?: boolean;
  scrollingRef?: any;
  popoverOpenRef?: any;
  onPopoverChange?: (open: boolean) => void;
  onRetry?: (m: any) => void;
  onCancelUpload?: (m: any) => void;
  onPin?: (m: any) => void;
  onUnpin?: (m: any) => void;
  onMarkImportant?: (m: any, important: boolean) => void;
}) {
  const av = {
    kind: "user",
    initials: m.sender.initials,
    color: m.sender.color,
    avatarUrl: m.sender.avatarUrl,
  };
  // Identity bundle for the Teams-style hover card + click-to-DM. ChatView
  // enriches it with presence/role from the member roster before showing the card.
  const senderInfo = {
    id: m.sender.id,
    name: m.sender.name,
    initials: m.sender.initials,
    color: m.sender.color,
    avatarUrl: m.sender.avatarUrl,
  };
  // The author avatar is interactive on OTHER people's messages in DMs, groups AND
  // channels (first row of each grouped run only). Self is excluded by BOTH the
  // `m.me` flag AND the id set (m.me can be wrong for a self message). Disabled in
  // the embedded in-call chat (handlers unwired). The card shows everywhere; only
  // its "Chat" action is hidden in DMs (it would reopen the same DM) — see the
  // showChat prop passed to <PersonCard>.
  const avatarInteractive = !!(
    !embedded &&
    !m.me &&
    first &&
    m.sender &&
    m.sender.id &&
    !(myIds && myIds.has(m.sender.id))
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text || "");
  // Edit-message editor gets its own rich-text ref + a Teams-style formatting/
  // emoji toolbar (the inline edit used to be a bare textarea with no options).
  const editEditorRef = useRef<RichTextEditorHandle>(null);
  const editEmojiBtnRef = useRef<HTMLButtonElement>(null);
  const [editEmojiOpen, setEditEmojiOpen] = useState(false);
  const [showActionSheet, setShowActionSheet] = useState(false);
  const [showMobileEmojiPicker, setShowMobileEmojiPicker] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchMoved = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // This row's toolbar is open when the parent's active message id matches.
  const isActive = activeId === m.id;
  // Latest active state for delayed callbacks: a leave timer from a previously
  // hovered row must not close the toolbar that has since opened on another row.
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  // Hover-to-show toolbar. Suppressed while the list is scrolling (so reviewing
  // history never spawns reaction popups). Short enter delay = snappy reveal.
  const handleMouseEnter = useCallback(() => {
    if (isMobile || m.deleted || editing) return;
    if (scrollingRef && scrollingRef.current) return; // no popups mid-scroll
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      if (scrollingRef && scrollingRef.current) return;
      const rect = (
        rowRef.current?.querySelector(".mb-body") ||
        rowRef.current?.querySelector(".mb")
      )?.getBoundingClientRect();
      if (rect)
        onActivate(m.id, {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        });
    }, 110);
  }, [isMobile, m.deleted, m.id, editing, onActivate, scrollingRef]);

  // Generous leave grace so travelling bubble→toolbar never closes it; and
  // NEVER close while a popover (emoji / more actions) is open.
  const handleMouseLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      if (popoverOpenRef && popoverOpenRef.current) return;
      if (!isActiveRef.current) return;
      onDeactivate();
    }, 450);
  }, [onDeactivate, popoverOpenRef]);

  useEffect(() => {
    return () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };
  }, []);

  // The edit emoji picker's state lives on the (persistent) row, but its UI only
  // renders inside the `editing` branch — reset it when an edit ends so a
  // stale-open emoji picker never reappears on the next edit.
  useEffect(() => {
    if (!editing) {
      setEditEmojiOpen(false);
    }
  }, [editing]);

  const isVoice = m.type === "voice";
  // Stickers/GIFs render bubble-less and are NOT treated as image attachments
  // (no download corner, no zoom, no album coalescing). Older stickers sent
  // before this feature carry type "text" + an image mime, so they keep the
  // legacy inline-image rendering — acceptable, no regression.
  const isSticker = m.type === "sticker";
  const isGif = m.type === "gif";
  const isImage = !!m.file && mimeOf(m.file).startsWith("image/") && !isSticker && !isGif;
  const isGenericFile = m.file && !isVoice && !isImage && !isSticker && !isGif;
  // Video is a "generic file" for routing, but a CAPTIONED video must use the media
  // bubble (flush media + caption strip) like an image — not the file-row bubble,
  // which mis-aligned the caption under a video.
  const isVideo = !!m.file && mimeOf(m.file).startsWith("video/");
  const parent = m.parentMessageId && byId ? byId[m.parentMessageId] : null;
  // Quoted parent card. For a plain text message it renders INSIDE the bubble
  // (reference: a light card with a grey bar, "name  dd/mm/yy time", the quoted
  // line, then the reply text); media/voice/deleted bubbles keep it above.
  const isTextBubble =
    !m.deleted && !(m._status === "uploading" && m.file) && !isVoice && !(isImage || isGenericFile);
  const parentWhen = parent && parent.createdAt
    ? new Date(parent.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "2-digit" }) +
    " " + localTime(parent.createdAt)
    : "";
  const replyQuoteEl = parent ? (
    <button
      type="button"
      className="reply-quote"
      onClick={() => onJumpTo(parent.id)}
      title="View replied message"
    >
      <span className="reply-quote-bar" />
      <span className="reply-quote-c">
        <span className="reply-quote-meta">
          <span className="reply-quote-name">
            {(parent.sender && parent.sender.name) ? parent.sender.name : ""}
          </span>
          {parentWhen ? <span className="reply-quote-time">{parentWhen}</span> : null}
        </span>
        {parent.text ? (
          <span
            className="reply-quote-text msg-prev-1"
            dangerouslySetInnerHTML={{
              __html: sanitizeHtml(firstLineHtml(parent.text)),
            }}
          />
        ) : (
          <span className="reply-quote-text">{messageRowPreview(parent)}</span>
        )}
      </span>
    </button>
  ) : null;
  const voiceFileId =
    (m.voice && (m.voice.fileId || m.voice.id)) ||
    (m.file && m.file.id) ||
    null;
  const voiceSrc =
    (m.file && m.file.url) ||
    (voiceFileId
      ? api.fileLinkUrl(`/api/files/${voiceFileId}/download`)
      : null);
  // Desktop drag-out for a voice note: reuse the SAME dragOutProps source
  // resolution as every other attachment. Prefer the real uploaded `m.file`
  // (carries id/name/mime + the E2EE/collabLink flags the guard needs); only
  // synthesize a file-like object from `m.voice`/voiceFileId when there's no
  // `m.file` (older voice messages stored only the voice envelope). The OS-side
  // sanitizeDragName guarantees the right extension from the mime/filename.
  const voiceDragFile = (() => {
    if (m.file) return m.file; // real attachment metadata → guards + name work
    if (!voiceFileId) return null; // nothing fetchable (blob-only) → no drag
    const vmime =
      (m.voice && (m.voice.mimeType || m.voice.mime || m.voice.type)) || "audio/mp4";
    const vext = voiceMimeToExt(vmime);
    return {
      id: voiceFileId,
      name: `voice-message-${voiceFileId}.${vext}`,
      mime: vmime,
      type: vmime,
    };
  })();


  const measureRect = useCallback((): Rect | null => {
    // Anchor to the bubble body (.mb-body hugs the reply+bubble), NOT the full
    // message column (.mb, which spans the name header) — so the toolbar pins
    // exactly above the bubble. Fallback to .mb defensively.
    const bubble =
      rowRef.current?.querySelector(".mb-body") ||
      rowRef.current?.querySelector(".mb");
    if (!bubble) return null;
    const r = bubble.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }, []);

  // Tap (click) the bubble to toggle this message's toolbar. Clicking the same
  // message again closes it; clicking a different message moves the toolbar.
  const isAttachment = isVoice || isImage || isGenericFile;
  // Text selection guard: a drag-to-select ends with a mouseup INSIDE the bubble,
  // which the browser reports as a click. Without this the toolbar toggled on
  // every selection (and the cursor said "pointer", so users didn't even try to
  // select). Track the press point so a drag of any length — even one that
  // ended with a collapsed selection — never counts as a tap.
  const pressPt = useRef<{ x: number; y: number } | null>(null);
  // Right-click: did the user already have text selected inside THIS bubble?
  // (Chrome keeps a selection you right-click inside and otherwise replaces it
  // with the single word under the pointer — so the answer has to be read on
  // mousedown, before that happens.)
  const rightPressHadSel = useRef(false);
  const handleBubbleMouseDown = (e: React.MouseEvent) => {
    pressPt.current = { x: e.clientX, y: e.clientY };
    if (e.button === 2) {
      const sel = typeof window !== "undefined" ? window.getSelection() : null;
      const body = (e.currentTarget as HTMLElement).querySelector(".msg-body");
      rightPressHadSel.current =
        !!sel && !sel.isCollapsed && !!sel.toString().trim() && !!body &&
        sel.rangeCount > 0 && body.contains(sel.getRangeAt(0).commonAncestorContainer);
    }
  };
  // Right-click on a text message with nothing selected in it selects the whole
  // message text, so the native menu's "Copy" (browser, Mac and Windows desktop
  // app alike) copies the message instead of one stray word — or, in the desktop
  // app, nothing at all. Links, media and an existing selection are left alone.
  const handleBubbleContextMenu = (e: React.MouseEvent) => {
    if (isMobile || m.deleted || editing || isAttachment) return;
    if (rightPressHadSel.current) return;
    const t = e.target as HTMLElement;
    if (t.closest("a, button, input, textarea, video, audio, img, .reaction-pill")) return;
    const body = (e.currentTarget as HTMLElement).querySelector(".msg-body");
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!body || !sel || !(body.textContent || "").trim()) return;
    const range = document.createRange();
    range.selectNodeContents(body);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const wasDragOrSelection = (e: React.MouseEvent): boolean => {
    const p = pressPt.current;
    pressPt.current = null;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) return true;
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return false;
    // Only a selection that touches THIS row counts (a stale selection elsewhere
    // shouldn't swallow a genuine tap on another message).
    const row = rowRef.current;
    return !!row && sel.rangeCount > 0 && row.contains(sel.getRangeAt(0).commonAncestorContainer);
  };
  const handleBubbleClick = (e: React.MouseEvent) => {
    if (isMobile || m.deleted || editing) return;
    if (wasDragOrSelection(e)) return;
    const t = e.target as HTMLElement;
    if (isAttachment) {
      if (t.closest("button, input, [role='slider']")) return;
      if (isVoice && t.closest("audio, video")) return;
    } else {
      if (t.closest("a, button, textarea, input, video, audio, .reaction-pill"))
        return;
    }
    if (isActive) onDeactivate();
    else {
      const rect = measureRect();
      if (rect) onActivate(m.id, rect);
    }
  };

  // Reposition the open toolbar on window RESIZE only. Scroll is handled at the
  // list level (ChatView dismisses the toolbar when scrolling starts), so we no
  // longer re-pin on every scroll event — that was the source of the flicker.
  // Never reposition/close while a popover is open.
  useEffect(() => {
    if (!isActive) return;
    const update = () => {
      if (popoverOpenRef && popoverOpenRef.current) return;
      const bubble = (rowRef.current?.querySelector(".mb-body") ||
        rowRef.current?.querySelector(".mb")) as HTMLElement | null;
      if (!bubble) return;
      const r = bubble.getBoundingClientRect();
      onActivate(m.id, {
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
      });
    };
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isActive, m.id, onActivate, popoverOpenRef]);

  // Long press for mobile
  const handleTouchStart = () => {
    touchMoved.current = false;
    longPressTimer.current = setTimeout(() => {
      // No context-menu long-press while editing — the edit workspace owns the row.
      if (!touchMoved.current && !m.deleted && !editing) {
        navigator.vibrate?.(30);
        setShowActionSheet(true);
      }
    }, 500);
  };
  const handleTouchMove = () => {
    touchMoved.current = true;
  };
  const handleTouchEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  const handleAction = (action: string) => {
    if (action.startsWith("react:")) {
      const emoji = action.slice(6);
      if (emoji === "picker") {
        setShowActionSheet(false);
        setShowMobileEmojiPicker(true);
      } else {
        onReact(m, emoji);
      }
      return;
    }
    switch (action) {
      case "reply":
        onReplyTo(m);
        break;
      case "bookmark":
        onBookmark(m);
        break;
      case "forward":
        onForward(m);
        break;
      case "copy":
        copyMessageText(m.text);
        break;
      case "download": {
        const f = m.file;
        if (!f) break;
        // Same path as the bubble's download icon. The old inline version
        // skipped E2EE decryption, so a recipient's "Download" on an encrypted
        // attachment saved unreadable ciphertext — and swallowed every error.
        void downloadAttachment(f, token, { url: f.url || null }).catch(() => {});
        break;
      }
      case "edit":
        setDraft(m.text || "");
        setEditing(true);
        onDeactivate();
        break;
      case "delete":
        // Dismiss the hover toolbar FIRST. It is portalled at z-index 9000 —
        // above every app dialog — so leaving it up left the reaction bar
        // floating over the delete modal. `edit` already did this; `delete`
        // never did.
        onDeactivate();
        // A message you RECEIVED has exactly one possible scope: your own view.
        // With nothing to choose there is nothing to confirm, and it is
        // reversible for you only in the sense that it affects nobody else — so
        // act immediately instead of putting a dialog in the way. Your OWN
        // messages still ask, because "Delete for everyone" is destructive for
        // other people and cannot be undone.
        if (!m.me) {
          onDelete(m, true);
          break;
        }
        setDeleting(true);
        break;
      case "pin":
        onPin && onPin(m);
        break;
      case "unpin":
        onUnpin && onUnpin(m);
        break;
      case "important":
        onMarkImportant && onMarkImportant(m, true);
        break;
      case "unimportant":
        onMarkImportant && onMarkImportant(m, false);
        break;
    }
  };

  const saveEdit = () => {
    const v = draft.trim();
    if (v && v !== m.text) onEdit(m, v);
    setEditing(false);
  };

  // Actionable meeting invitation card (sent on schedule or from Share
  // invitation). Join/Reject are masked until 10 min before the start.
  if (m.type === "meeting_invite") {
    return (
      <div className="msg-system" role="listitem" id={"msg-" + m.id}>
        <MeetingInviteCard
          m={m}
          onJoin={onJoinMeeting}
          onReject={onRejectMeeting}
        />
      </div>
    );
  }

  // Task card (/task from this chat) — deep-opens the task in the Tasks module.
  if (m.type === "task_card") {
    return (
      <div className="msg-system" role="listitem" id={"msg-" + m.id}>
        <TaskCard m={m} onOpenTask={onOpenTask} />
      </div>
    );
  }

  // Per-session divider (spec D) inside a shared temp group: "Call · 23 Jul 2026"
  // / "Meeting · 23 Jul 2026", separating each call/meeting session that lands in
  // the same group. The body carries a hidden "§sd:<sessionKey>§" marker used
  // ONLY server-side to place exactly one divider per session — strip it here and
  // render just the human label as a centered pill.
  if (m.type === "session_divider") {
    const raw = String(m.text || "");
    const label = raw.includes("§")
      ? raw.slice(raw.lastIndexOf("§") + 1).trim()
      : raw.trim();
    if (!label) return null;
    return (
      <div className="date-div session-div" role="listitem" id={"msg-" + m.id}>
        <span>{label}</span>
      </div>
    );
  }

  // Centered, non-interactive system lines in the timeline (WhatsApp/Teams
  // parity): call-lifecycle logs (type "call") AND membership/group events
  // (type "system" — "Alice added Bob", "Carol left", "X created the group").
  // End of a meeting: "Meeting ended: 16s" + the Attendance card (host/co-host).
  if (m.type === "meeting_attendance" && m.attendance)
    return <MeetingEndedRow m={m} meId={meId} token={token} timeFormat={timeFormat} />;
  if (m.type === "call" || m.type === "meeting_attendance" || m.type === "system") {
    // The persisted "Temporary group … automatically deleted in N days" notice
    // duplicates the pinned header banner (which live-counts the days, unlike
    // this static copy). New groups no longer post it (conversationService);
    // this hides the rows older builds already stored.
    if (
      m.type === "system" &&
      /^Temporary group from your call\/meeting chat/.test(String(m.text || ""))
    )
      return null;
    // Auto-created temporary groups (from a call/meeting chat) never had a real
    // "creation" — the "X created the group/channel" line just reads as stray
    // centered noise. New temp groups no longer post it (conversationService);
    // this also hides the rows older builds already stored.
    if (
      m.type === "system" &&
      convTemporary &&
      /created the (group|channel)$/.test(String(m.text || ""))
    )
      return null;
    // Premium call log: split the backend label ("📞 Call ended · 3:14") into
    // the status line and a muted meta line that carries the time of day and,
    // when present, the call duration — so every call trace reads "Call ended ·
    // 5:30 PM · 3:14" rather than burying the duration in the title.
    let label = m.text || (m.type === "call" ? "Call" : "");
    let durationPart = "";
    let CallIcon: ((p: any) => JSX.Element) | null = null;
    if (m.type === "call") {
      const sep = label.indexOf(" · ");
      if (sep !== -1) {
        durationPart = label.slice(sep + 3).trim();
        label = label.slice(0, sep).trim();
      }
      // Pick a crisp (Lucide-style) icon by call kind, then strip the leading emoji
      // the backend baked into the label — the OS emoji renders clunky/inconsistent.
      CallIcon = /video/i.test(label)
        ? IconVideo
        : /miss|no answer|declin|unanswer|not answer/i.test(label)
          ? IconPhoneMissed
          : IconPhone;
      label = label.replace(/^\s*[\p{Extended_Pictographic}️‍]+\s*/u, "").trim();
    }
    const callTime =
      m.type === "call" && m.createdAt
        ? fmtTime(m.createdAt, timeFormat || "12h")
        : "";
    if (m.type === "call") {
      // BA/CEO #32: two-line call log (per image 5) — a muted "who, time"
      // heading above the bold status line, centred (no pill). For an incoming
      // call the caller's name leads ("Ragul, 1:05 PM"); for your OWN call there
      // is no "You" (that read wrong) — just the time.
      const who = m.me ? "" : (m.sender && m.sender.name) || "";
      const heading = [who, callTime].filter(Boolean).join(", ");
      return (
        <div className="msg-system" role="listitem" id={"msg-" + m.id}>
          <div className="msg-call-log">
            {heading ? <span className="msg-call-head">{heading}</span> : null}
            <span className="msg-call-status">
              {CallIcon ? (
                <CallIcon size={15} style={{ marginRight: 6, verticalAlign: "-2.5px", flexShrink: 0 }} />
              ) : null}
              {label}
              {durationPart ? (
                <span className="msg-call-dur"> · {durationPart}</span>
              ) : null}
            </span>
          </div>
        </div>
      );
    }
    return (
      <div className="msg-system" role="listitem" id={"msg-" + m.id}>
        <span className="msg-system-pill">{label}</span>
      </div>
    );
  }

  // Issue 17: the delivered/read ✓✓ now renders on the LAST of MY messages only
  // (WhatsApp/Teams behaviour), not on every own bubble. In-flight statuses keep
  // their own per-message indicator — the failed one is a Retry button and must
  // stay on its own row. ○ sending, grey ✓ sent, ⚠ failed (click to retry), then
  // the ✓✓ (delivered/read, click to see who read it and when) on the last row.
  const ackEl =
    m.me && !m.deleted
      ? m._status === "sending"
        ? (
          <span className="msg-ack sending" title="Sending">
            <IconCircle size={12} />
          </span>
        )
        : m._status === "sent"
          ? (
            <span className="msg-ack sent" title="Sent">
              <IconCheck size={13} />
            </span>
          )
          : m._status === "failed"
            ? (
              <button
                type="button"
                className="msg-ack failed"
                title="Failed — click to retry"
                onClick={(e) => {
                  e.stopPropagation();
                  onRetry && onRetry(m);
                }}
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <IconAlertTriangle size={12} /> Retry
              </button>
            )
            : !isLastAck
              ? null
              : seen
                ? (
                  // DM / group / channel with receipts on: tick + (for groups)
                  // a seen count, click to see who read it and when. Colour rule
                  // is unchanged (blue = seen by everyone).
                  <SeenByTick m={m} seen={seen} timeFormat={timeFormat} />
                )
                : (() => {
                  const isRead =
                    !!readAt && m.createdAt && Date.parse(m.createdAt) <= readAt;
                  return (
                    <span
                      className={"msg-ack " + (isRead ? "read" : "delivered")}
                      title={isRead ? "Read" : "Delivered"}
                    >
                      <IconCheckCheck size={14} />
                    </span>
                  );
                })()
      : null;

  // BA/CEO #29: per-message time — shown on the bubble's own row (bottom-right),
  // not up in the sender/user header. Every message carries its own time.
  const timeStr = m.createdAt
    ? fmtTime(m.createdAt, timeFormat || "12h")
    : m.time || "";

  // Teams-style row emphasis when this message @mentions you. Never on your own
  // messages — the sent bubble is already an accent fill. Matching on the
  // composer-written data-user-id is exact (two people sharing a first name
  // cannot collide) and works in E2EE conversations, where m.text is the locally
  // decrypted body and the server never sees it.
  const mentionsMe =
    !m.me &&
    !!meId &&
    typeof m.text === "string" &&
    (m.text.includes('data-user-id="' + meId + '"') ||
      m.text.includes('data-user-id="__channel__"') ||
      m.text.includes('data-user-id="__here__"'));

  return (
    <>
      <div
        id={"msg-" + m.id}
        ref={rowRef}
        role="listitem"
        className={
          "mw " +
          (first ? "gstart" : "gcont") +
          (m.me ? " me" : "") +
          (mentionsMe ? " mentions-me" : "") +
          (m.bookmarked ? " bkd" : "") +
          (m.important && !m.deleted ? " important" : "") +
          (editing ? " editing" : "") +
          (isActive ? " active" : "")
        }
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{ position: "relative" }}
      >
        <div
          className={"mav" + (avatarInteractive ? " mav-clickable" : "")}
          // Keyboard: focusable button semantics — Enter/Space open the DM (the
          // primary action). The hover PROFILE CARD is a pointer enhancement (it is
          // portaled outside the tab order, so it isn't keyboard-reachable and we
          // don't fake it with focus/blur). No native `title` — the custom card is
          // the tooltip (a title here would double up with it).
          role={avatarInteractive ? "button" : undefined}
          tabIndex={avatarInteractive ? 0 : undefined}
          aria-label={
            avatarInteractive ? "Open chat with " + m.sender.name : undefined
          }
          onMouseEnter={
            avatarInteractive && onAvatarEnter
              ? (e) =>
                onAvatarEnter(senderInfo, e.currentTarget as HTMLElement)
              : undefined
          }
          onMouseLeave={
            avatarInteractive && onAvatarLeave ? onAvatarLeave : undefined
          }
          onClick={
            avatarInteractive && onAvatarClick
              ? (e) => {
                e.stopPropagation();
                onAvatarClick(senderInfo);
              }
              : undefined
          }
          onKeyDown={
            avatarInteractive && onAvatarClick
              ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onAvatarClick(senderInfo);
                }
              }
              : undefined
          }
        >
          {first ? <Avatar avatar={av} size={28} /> : null}
        </div>

        {/* Hover trigger lives on the BUBBLE, not the full-width row, so the
            reaction toolbar only appears when the cursor is actually over the
            message — not anywhere in the empty space beside it. Works for any
            bubble size. Travelling bubble→toolbar is kept open by the toolbar's
            own onToolbarEnter (clears the close timer). */}
        <div className={"mb" + (m.deleted ? " deleted" : "")}>
          {first && ((!m.me && m.sender?.name && m.sender.name !== "You") || (m.edited && !editing) || (m.pinned && !editing)) ? (
            <div className="mm">
              {!m.me && m.sender?.name && m.sender.name !== "You" ? (
                <span className="msnd">{m.sender.name}</span>
              ) : null}
              {m.edited && !editing ? (
                <span className="mtm" style={{ fontStyle: "italic" }}>
                  edited
                </span>
              ) : null}
              {m.pinned && !editing ? (
                <span className="msg-pin-badge" title="Pinned">
                  <IconPin size={12} />
                </span>
              ) : null}
            </div>
          ) : null}
          {/* WhatsApp-style forwarded indicator — shown on every forwarded
              message; "many times" once the forward chain reaches 4+. */}
          {m.forwarded && !m.deleted && !editing ? (
            <div
              className={
                "msg-fwd" + ((Number(m.forwardCount) || 0) >= 4 ? " many" : "")
              }
            >
              <IconForward size={12} />
              {(Number(m.forwardCount) || 0) >= 4
                ? "Forwarded many times"
                : "Forwarded"}
            </div>
          ) : null}

          {/* Bubble body — the reaction toolbar's hover trigger + tap target live
              HERE (reply preview + bubble), not the full-width column, so the bar
              only appears over the actual message and pins exactly above it. The
              name/time header, forwarded label, reaction pills and receipt stay
              OUTSIDE this hit area (Teams-style). */}
          <div
            className="mb-body"
            style={{
              // Attachments open on click (pointer); text bubbles are selectable
              // text (I-beam), the toolbar already appears on hover.
              cursor:
                !isMobile && !m.deleted && !editing
                  ? isAttachment
                    ? "pointer"
                    : "text"
                  : undefined,
            }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onMouseDown={handleBubbleMouseDown}
            onContextMenu={handleBubbleContextMenu}
            onClick={handleBubbleClick}
          >
            {/* Time rendered beside the bubble (no tooltip): to the RIGHT of a received
                message, to the LEFT of a sent one. Positioned by .msg-side-time. */}
            {!isMobile && !m.deleted && !editing && timeStr ? (
              <span className="msg-side-time">{timeStr}</span>
            ) : null}
            {/* Teams-style importance — a plain red "!" beside the message (no body tint).
              Hidden while editing so the edit workspace stays clean (the Important
              toggle in the edit toolbar owns the flag during editing). */}
            {m.important && !m.deleted && !editing ? (
              <span className="msg-important" title="Important" aria-label="Important">!</span>
            ) : null}
            {!isTextBubble ? replyQuoteEl : null}

            {m.deleted ? (
              <div
                className="bub"
                style={{
                  fontStyle: "italic",
                  // Own (accent-filled) bubbles are dark blue → the muted grey
                  // tombstone was near-black on them. Use a translucent white on
                  // sent bubbles, keep the muted grey on received (light) bubbles.
                  color: m.me ? "rgba(255,255,255,0.85)" : "var(--g500)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <IconBan size={14} />
                This message was deleted
              </div>
            ) : m._status === "uploading" && m.file ? (
              // ISSUE #1: optimistic attachment bubble shown INSTANTLY on send, with
              // upload progress — before/while the file streams to storage. Swapped
              // for the real message on the MESSAGE_NEW echo. Self-contained: no
              // normal file renderer runs here (the file has no server id yet).
              <div
                className="bub"
                style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 190 }}
              >
                {m.file.url && (m.file.mime || "").startsWith("image/") ? (
                  <img
                    src={m.file.url}
                    alt={m.file.name}
                    style={{ maxWidth: 220, maxHeight: 220, borderRadius: 8, objectFit: "cover", opacity: 0.85 }}
                  />
                ) : null}
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 220,
                  }}
                >
                  {m.file.name}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    // The optimistic upload bubble is always the sender's own (accent/
                    // purple) bubble — grey text was near-invisible on it. Use light.
                    color: "rgba(255,255,255,0.9)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span>
                    Uploading…{" "}
                    {typeof m._uploadPct === "number" ? Math.round(m._uploadPct) + "%" : ""}
                  </span>
                  {/* Only offer Cancel while bytes are still in flight (<100%). Once
                    the upload completes the file is committed server-side and the
                    message is being sent — cancelling then can't unsend it, so the
                    control is removed to avoid a misleading "cancel". */}
                  {onCancelUpload &&
                    (m._uploadPct == null || m._uploadPct < 100) ? (
                    <button
                      type="button"
                      className="upl-cancel"
                      aria-label="Cancel upload"
                      title="Cancel upload"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancelUpload(m);
                      }}
                    >
                      <IconX size={13} />
                    </button>
                  ) : null}
                </div>
                <div style={{ height: 3, borderRadius: 3, background: "rgba(255,255,255,0.25)", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width:
                        (typeof m._uploadPct === "number"
                          ? Math.max(4, Math.min(100, m._uploadPct))
                          : 6) + "%",
                      // White fill — the accent fill was purple on the purple bubble.
                      background: "#fff",
                      transition: "width 0.2s ease",
                    }}
                  />
                </div>
              </div>
            ) : isVoice ? (
              <div className="bub" {...dragOutProps(voiceDragFile, token)}>
                {/* `file` carries the E2EE wrapped key/iv that decryptMessageList
                  attaches — without it an encrypted voice note downloads as
                  ciphertext and refuses to play. */}
                <VoicePlayer src={voiceSrc} voice={m.voice} token={token} file={m.file} />
              </div>
            ) : (isSticker || isGif) && m.file ? (
              // Bubble-less, transparent, larger — a sticker/GIF, not a photo.
              <div className={"msg-sticker" + (isGif ? " is-gif" : "")}>
                <img
                  src={m.file.url || (m.file.id ? api.fileLinkUrl(`/api/files/${m.file.id}/download`) : "")}
                  alt={isGif ? "GIF" : "Sticker"}
                  loading="lazy"
                  draggable={false}
                />
              </div>
            ) : isImage || isGenericFile ? (
              // A message can carry BOTH a file and a typed caption (send text +
              // attachment together). WhatsApp/Skype-style, the caption belongs IN a
              // bubble WITH the attachment as ONE unit — never floating bare beneath:
              //   • image → ONE unified bubble, photo flush to the top edge and the
              //             caption padded below it (see `.bub-media`).
              //   • file  → ONE unified bubble too (`.bub-file`): the file row flattens
              //             into the bubble (its card chrome is dropped) with the
              //             caption below, so it reads as "a message with an attachment".
              // A caption-less attachment stays the clean standalone framed card.
              (() => {
                const att = (
                  <FileAttachment file={m.file} token={token} convId={m.conversationId} />
                );
                // Prefer the DEDICATED caption field (set by applyFileEnvelope on decrypt)
                // — it is NEVER the raw envelope JSON. Only fall back to m.text for legacy
                // / plaintext rows. Detecting off m.text alone was fragile: on the cache-
                // first path (or before the envelope unwrapped) m.text could still be the
                // {"type":"file","key"…} JSON, so hasCaption went false and the whole
                // attachment fell out of the media bubble — a video then rendered as a bare,
                // uncapped element with its caption dropped (images degraded more gracefully
                // because their bare form keeps a css class). Keep the envelope-JSON guard
                // as a belt for the legacy m.text fallback.
                const cap = (
                  (m.file && typeof m.file.caption === "string" ? m.file.caption : "") ||
                  (typeof m.text === "string" ? m.text : "")
                ).trim();
                const hasCaption =
                  !!cap && !(cap.startsWith("{") && /"(key|iv|type)"\s*:/.test(cap));
                if (!hasCaption) return att;
                return (
                  <div className={"bub " + (isImage || isVideo ? "bub-media" : "bub-file")}>
                    {att}
                    <div className="msg-body msg-caption">{renderBody(cap, meId)}</div>
                  </div>
                );
              })()
            ) : editing ? (
              /* Teams-style inline edit: the message becomes a clean neutral
                 composer IN PLACE — not the accent-filled bubble — with small
                 cancel/confirm icons at the bottom-right. Enter saves, Esc cancels.
                 The rich editor preserves the message's formatting so raw
                 <p>/<ul> tags are never shown. */
              <div
                className="msg-edit"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    // The emoji picker owns Escape (it closes itself). Don't ALSO
                    // cancel the edit + discard the draft: the picker is portaled to
                    // <body> but React re-dispatches its keydown up THIS react-tree
                    // parent, so a single Escape would otherwise hit both.
                    if (editEmojiOpen) return;
                    e.preventDefault();
                    setEditing(false);
                  }
                }}
              >
                <div className="msg-edit-box">
                  <RichTextEditor
                    ref={editEditorRef}
                    value={draft}
                    onChange={setDraft}
                    onSend={saveEdit}
                    enterToSend={true}
                    placeholder="Edit Type a message"
                  />
                  {/* Teams-style action row BELOW the editor: the full formatting
                    toolbar sits on the LEFT and the Cancel / Save toggle is pushed
                    to the far right (margin-left:auto on .msg-edit-actions). One
                    hairline separates this row from the editor above. */}
                  <div className="msg-edit-foot">
                    <div className="msg-edit-tools">
                      <button
                        ref={editEmojiBtnRef}
                        className={"cb" + (editEmojiOpen ? " active" : "")}
                        title="Emoji"
                        aria-label="Emoji"
                        // Keep this mousedown from reaching the picker's document-level
                        // outside-click handler, or it would close the picker a beat
                        // before this button's onClick re-toggles it back open.
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => setEditEmojiOpen((v) => !v)}
                      >
                        <IconSmile />
                      </button>
                      <div className="ci-sep" />
                      <button
                        className="cb"
                        title="Bold (Ctrl+B)"
                        aria-label="Bold"
                        onClick={() => editEditorRef.current?.toggleBold()}
                      >
                        <IconBold />
                      </button>
                      <button
                        className="cb"
                        title="Italic (Ctrl+I)"
                        aria-label="Italic"
                        onClick={() => editEditorRef.current?.toggleItalic()}
                      >
                        <IconItalic />
                      </button>
                      <button
                        className="cb"
                        title="Underline (Ctrl+U)"
                        aria-label="Underline"
                        onClick={() => editEditorRef.current?.toggleUnderline()}
                      >
                        <IconUnderline />
                      </button>
                      <button
                        className="cb"
                        title="Strikethrough"
                        aria-label="Strikethrough"
                        onClick={() => editEditorRef.current?.toggleStrike()}
                      >
                        <IconStrikethrough />
                      </button>
                      <div className="ci-sep" />
                      <button
                        className="cb"
                        title="Bullet list"
                        aria-label="Bullet list"
                        onClick={() => editEditorRef.current?.toggleBulletList()}
                      >
                        <IconList />
                      </button>
                      <button
                        className="cb"
                        title="Numbered list"
                        aria-label="Numbered list"
                        onClick={() => editEditorRef.current?.toggleOrderedList()}
                      >
                        <IconListOrdered />
                      </button>
                      <button
                        className="cb"
                        title="Blockquote"
                        aria-label="Blockquote"
                        onClick={() => editEditorRef.current?.toggleBlockquote()}
                      >
                        <IconQuote />
                      </button>
                      <div className="ci-sep" />
                      <button
                        className="cb"
                        title="Insert link"
                        aria-label="Insert link"
                        onClick={() => {
                          promptDialog("Enter URL", "", {
                            title: "Insert link",
                            placeholder: "https://example.com",
                            confirmText: "Insert",
                          }).then((url) => {
                            if (url) editEditorRef.current?.setLink(url);
                          });
                        }}
                      >
                        <IconLink />
                      </button>
                      <button
                        className="cb"
                        title="Inline code"
                        aria-label="Inline code"
                        onClick={() => editEditorRef.current?.toggleCode()}
                      >
                        <IconCode />
                      </button>
                    </div>
                    {/* Priority actions — Mark-as-Important then Cancel / Save — pinned
                      to the right on the SAME row as the formatting tools (never a
                      second row). Important sits before ✕/✓ per the toolbar order. */}
                    <div className="msg-edit-actions">
                      {onMarkImportant ? (
                        <button
                          type="button"
                          className={"msg-edit-btn important" + (m.important ? " active" : "")}
                          title={m.important ? "Remove importance" : "Mark as important"}
                          aria-label={m.important ? "Remove importance" : "Mark as important"}
                          onClick={() => onMarkImportant(m, !m.important)}
                        >
                          <IconAlertTriangle size={16} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="msg-edit-btn cancel"
                        title="Cancel"
                        aria-label="Cancel edit"
                        onClick={() => setEditing(false)}
                      >
                        <IconX size={17} />
                      </button>
                      <button
                        type="button"
                        className="msg-edit-btn save"
                        title="Save"
                        aria-label="Save changes"
                        onClick={saveEdit}
                      >
                        <IconCheck size={17} />
                      </button>
                    </div>
                  </div>
                </div>
                {editEmojiOpen ? (
                  <EmojiPicker
                    anchorRect={(() => {
                      const r = editEmojiBtnRef.current?.getBoundingClientRect();
                      return r
                        ? { top: r.top, left: r.left, width: r.width, height: r.height }
                        : {
                          top: window.innerHeight / 2,
                          left: window.innerWidth / 2,
                          width: 0,
                          height: 0,
                        };
                    })()}
                    onSelect={(ch: string) => {
                      editEditorRef.current?.insertText(ch);
                      setEditEmojiOpen(false);
                    }}
                    onClose={() => setEditEmojiOpen(false)}
                  />
                ) : null}
              </div>
            ) : (
              (() => {
                const msgText = m.text || "";
                // A message this device can't decrypt: the decrypt path flags
                // `_pendingRecovery` / E2EE_PENDING_TEXT, and a raw encrypted copy
                // (no text) can reach the renderer via paths that skip decrypt.
                // All three render the LIVE restore row — never the dead-end lock.
                const pendingE2EE =
                  m._pendingRecovery === true ||
                  msgText.trim() === E2EE_PENDING_TEXT ||
                  (m.encrypted && !msgText.trim());
                return (
                  <div className="bub">
                    {replyQuoteEl}
                    <div className="msg-body">
                      {msgText.trim() && !pendingE2EE ? (
                        renderBody(msgText, meId)
                      ) : pendingE2EE ? (
                        <EncryptedPendingRow m={m} isMobile={isMobile} onRetryLoad={onRetryLoad} />
                      ) : (
                        <span style={{ opacity: 0.45, fontStyle: "italic" }}>
                          [no content]
                        </span>
                      )}
                    </div>
                    {/* A message that was not end-to-end encrypted (plaintext
                      body, stripped envelope, or plaintext supplied by the app's
                      fallback) renders its text with a quiet marker — never a
                      warning inside the text itself. */}
                    {m.notEncrypted && msgText.trim() && !pendingE2EE ? (
                      <span
                        className="msg-not-encrypted"
                        title="This message was not end-to-end encrypted"
                        style={{ display: "block", fontSize: 11, opacity: 0.55, marginTop: 2 }}
                      >
                        Not encrypted
                      </span>
                    ) : null}
                    {/* Link preview card (Teams/WhatsApp-style) — rendered INSIDE
                      the bubble so it reads as part of the message, not a
                      detached box below it. Client-fetches OG metadata for the
                      first URL (cached, SSRF-guarded server side); renders
                      nothing without a useful preview. Skipped for file/voice. */}
                    {linkPreview && !m.file && m.type !== "voice"
                      ? (() => {
                        const u = firstUrl(m.text);
                        return u ? <LinkPreview url={u} token={token} /> : null;
                      })()
                      : null}
                  </div>
                );
              })()
            )}
          </div>

          {/* Teams-style reaction pills — hidden while editing this message. */}
          {m.reactions && m.reactions.length && !editing ? (
            <ReactionPills
              reactions={m.reactions}
              onReact={(emoji) => onReact(m, emoji)}
            />
          ) : null}

          {/* Delivered/read tick + timestamp on the message's own row, right-aligned
              (own messages only). Time shows on hover beside the tick. */}
          {!m.deleted && !editing && (ackEl || m.bookmarked) ? (
            <div className={"msg-receipt" + (m.bookmarked && !m.me ? " bkmk-incoming" : "")}>
              {m.bookmarked ? (
                <span className="msg-bkmk" title="Bookmarked" aria-label="Bookmarked">
                  <IconStar size={13} fill="currentColor" />
                </span>
              ) : null}
              {ackEl}
            </div>
          ) : null}
        </div>
      </div>

      {/* Hover-activated toolbar — desktop only, not deleted, not editing */}
      {!isMobile && !m.deleted && !editing && (
        <MessageHoverToolbar
          message={m}
          messageRect={isActive ? measureRect() : null}
          visible={isActive}
          isMine={!!m.me}
          onReact={(emoji) => onReact(m, emoji)}
          onReply={() => {
            onReplyTo(m);
            onDeactivate();
          }}
          onAction={handleAction}
          onRequestClose={onDeactivate}
          onToolbarEnter={() => {
            if (hoverTimer.current) clearTimeout(hoverTimer.current);
          }}
          onToolbarLeave={handleMouseLeave}
          onPopoverChange={onPopoverChange}
          embedded={embedded}
        />
      )}

      {/* Mobile action sheet */}
      {showActionSheet && (
        <ActionSheet
          message={m}
          onAction={handleAction}
          onClose={() => setShowActionSheet(false)}
        />
      )}

      {/* Mobile emoji picker fallback */}
      {showMobileEmojiPicker && (
        <EmojiPicker
          anchorRect={{
            top: window.innerHeight / 2,
            left: window.innerWidth / 2,
            width: 0,
            height: 0,
          }}
          onSelect={(emoji) => {
            onReact(m, emoji);
            setShowMobileEmojiPicker(false);
          }}
          onClose={() => setShowMobileEmojiPicker(false)}
        />
      )}

      {/* Delete confirmation dialog */}
      {deleting && (
        <Portal>
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.4)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 4300,
            }}
            onClick={() => setDeleting(false)}
          >
            <div className="msg-del-dlg" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="msg-del-close"
                onClick={() => setDeleting(false)}
                aria-label="Close"
                title="Close"
              >
                <IconX size={16} />
              </button>
              <h3 className="msg-del-title">Delete this message?</h3>
              {/* Only own messages reach this dialog — a received message has a
                  single possible scope and is deleted straight from the menu. */}
              {/* <p className="msg-del-text">
                {m.me
                  ? "Remove it from your view, or withdraw it for everyone."
                  : "Remove this message from your view."}
              </p> */}
              {/* Two columns: [Delete for me] [Delete for everyone]; a received
                  message has one option, full width. Close is the ✕ above. */}
              <div className="msg-del-actions">
                {m.me ? (
                  <>
                    <button
                      type="button"
                      className="msg-del-btn"
                      onClick={() => {
                        onDelete(m, true);
                        setDeleting(false);
                      }}
                    >
                      Delete for me
                    </button>
                    <button
                      type="button"
                      className="msg-del-btn danger"
                      onClick={() => {
                        onDelete(m, false);
                        setDeleting(false);
                      }}
                    >
                      Delete for everyone
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="msg-del-btn danger span"
                      onClick={() => {
                        onDelete(m, true);
                        setDeleting(false);
                      }}
                    >
                      Delete for me
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

// React.memo wrapper — by far the highest-impact perf win for the chat list.
// Without it, every MsgRow re-renders on every state change in ChatView (each
// keystroke, scroll, presence/typing event), which is the dominant jank source.
// The comparator does a shallow compare for callbacks/refs (they're stable from
// CoLabV1's useCallbacks) plus a targeted compare on volatile fields. activeId
// only re-renders rows whose active-state actually flipped.
export const MsgRow: any = React.memo(MsgRowImpl as any, (prev: any, next: any) => {
  if (prev.m !== next.m) return false;
  if (prev.readAt !== next.readAt) return false; // read-tick must update live
  if (prev.seen !== next.seen) return false; // seen-by count/names must update live
  if (prev.isLastAck !== next.isLastAck) return false; // ✓✓ moves to the newest own message
  if (prev.first !== next.first) return false;
  if (prev.activeId !== next.activeId) {
    const wasActive = prev.activeId === prev.m.id;
    const isActive = next.activeId === next.m.id;
    if (wasActive !== isActive) return false;
  }
  if (prev.linkPreview !== next.linkPreview) return false;
  if (prev.timeFormat !== next.timeFormat) return false;
  if (prev.isMobile !== next.isMobile) return false;
  if (prev.token !== next.token) return false;
  if (prev.meId !== next.meId) return false; // account switch repaints mention highlights
  if (prev.byId !== next.byId) return false;
  if (
    prev.onReact !== next.onReact ||
    prev.onBookmark !== next.onBookmark ||
    prev.onForward !== next.onForward ||
    prev.onEdit !== next.onEdit ||
    prev.onDelete !== next.onDelete ||
    prev.onReplyTo !== next.onReplyTo ||
    prev.onJumpTo !== next.onJumpTo ||
    prev.onActivate !== next.onActivate ||
    prev.onDeactivate !== next.onDeactivate ||
    prev.onRetry !== next.onRetry ||
    prev.onCancelUpload !== next.onCancelUpload ||
    prev.onPin !== next.onPin ||
    prev.onUnpin !== next.onUnpin
  )
    return false;
  return true;
});

// ─── Welcome screen ──────────────────────────────────────────────────────────
