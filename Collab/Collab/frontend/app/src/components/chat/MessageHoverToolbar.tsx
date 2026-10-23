"use client";
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconSmile, IconPencil, IconReply } from "../../lib/icons";
import { EmojiPicker, type Rect } from "../EmojiPicker";
import MoreMenu from "./MoreMenu";

const TOOLBAR_HEIGHT = 46;
const TOOLBAR_MARGIN = 6;
// Four quick reactions + the "more reactions" (+) button.
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮"];
const normReactionEmoji = (e: any): string =>
  String(e || "").replace(/[\uFE00-\uFE0F]/g, "");

interface HoverToolbarProps {
  message: any;
  messageRect: Rect | null;
  visible: boolean;
  isMine: boolean;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onAction: (action: string) => void;
  onRequestClose: () => void;
  onToolbarEnter?: () => void;
  onToolbarLeave?: () => void;
  onPopoverChange?: (open: boolean) => void;
  embedded?: boolean;
}

const REACTION_NAMES: Record<string, string> = {
  "👍": "Like",
  "❤️": "Heart",
  "😂": "Laugh",
  "😮": "Surprised",
};

export default function MessageHoverToolbar({
  message,
  messageRect,
  visible,
  isMine,
  onReact,
  onReply,
  onAction,
  onRequestClose,
  onToolbarEnter,
  onToolbarLeave,
  onPopoverChange,
  embedded,
}: HoverToolbarProps) {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const interactionActive = visible || showEmojiPicker || showMoreMenu;

  // Keep the last known rect + stay mounted briefly so the close animation can
  // play after the parent stops passing a rect (mouse leave).
  const lastRect = useRef<Rect | null>(null);
  if (messageRect) lastRect.current = messageRect;
  const rect = messageRect ?? lastRect.current;
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (interactionActive) {
      setGone(false);
      return;
    }
    const t = setTimeout(() => setGone(true), 220);
    return () => clearTimeout(t);
  }, [interactionActive]);

  useEffect(() => {
    onPopoverChange && onPopoverChange(showEmojiPicker || showMoreMenu);
    return () => {
      onPopoverChange && onPopoverChange(false);
    };
  }, [showEmojiPicker, showMoreMenu, onPopoverChange]);

  const [emojiAnchor, setEmojiAnchor] = useState<Rect | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<Rect | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!rect || !toolbarRef.current) return;
    const tw = toolbarRef.current.offsetWidth || 260;
    const th = TOOLBAR_HEIGHT;
    const vw = window.innerWidth;
    const margin = 8;
    let top = rect.top - th - TOOLBAR_MARGIN;
    if (top < margin)
      top = rect.top + rect.height + TOOLBAR_MARGIN;
    if (top + th > window.innerHeight - margin)
      top = Math.max(margin, window.innerHeight - th - margin);

    let left: number;
    if (isMine) {
      left = rect.left + rect.width - tw;
    } else {
      left = rect.left;
    }
    left = Math.max(margin, Math.min(left, vw - tw - margin));
    setPos({ top, left });
  }, [rect, isMine]);

  useEffect(() => {
    if (!visible) return;
    const onDocPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (toolbarRef.current && toolbarRef.current.contains(target)) return;
      if (showEmojiPicker || showMoreMenu) return;
      const bubble = (target as HTMLElement)?.closest?.(".mb");
      if (bubble) return;
      onRequestClose();
    };
    const id = setTimeout(
      () => document.addEventListener("mousedown", onDocPointer),
      0,
    );
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onDocPointer);
    };
  }, [visible, showEmojiPicker, showMoreMenu, onRequestClose]);

  useEffect(() => {
    if (!interactionActive) return;
    const onEsc = (e: Event) => {
      if (showEmojiPicker) {
        setShowEmojiPicker(false);
        e.preventDefault();
        return;
      }
      if (showMoreMenu) {
        setShowMoreMenu(false);
        e.preventDefault();
        return;
      }
      onRequestClose();
      e.preventDefault();
    };
    window.addEventListener("colab:esc", onEsc);
    return () => window.removeEventListener("colab:esc", onEsc);
  }, [interactionActive, showEmojiPicker, showMoreMenu, onRequestClose]);

  if (!rect || (gone && !interactionActive)) return null;

  return (
    <>
      {createPortal(
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label="Message actions"
          className={interactionActive ? "msg-actions-pop" : "msg-actions-out"}
          onMouseEnter={onToolbarEnter}
          onMouseLeave={onToolbarLeave}
          style={{
            position: "fixed",
            top: pos ? pos.top : -9999,
            left: pos ? pos.left : -9999,
            zIndex: 9000,
            display: "flex",
            alignItems: "center",
            gap: 0,
            background: "var(--sb, #fff)",
            color: "var(--g600, #4b5563)",
            border: "1px solid var(--g200, #e5e7eb)",
            borderRadius: 10,
            boxShadow: "0 4px 18px rgba(0,0,0,0.14)",
            padding: "0 4px",
            height: TOOLBAR_HEIGHT,
            opacity: interactionActive ? 1 : 0,
            pointerEvents: interactionActive ? "auto" : "none",
            // Smooth open: fade + slight rise/scale, easing out.
            transform: interactionActive ? "translateY(0)" : "translateY(14px)",
            transformOrigin: "bottom center",
            transition: "opacity 0.28s ease, transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)",
            userSelect: "none",
          }}
        >
          {QUICK_REACTIONS.map((emoji) => {
            const reacted = message.reactions?.find(
              (r: any) => normReactionEmoji(r.emoji) === normReactionEmoji(emoji) && r.mine,
            );
            return (
              <button
                key={emoji}
                aria-label={`React with ${emoji}`}
                data-mtip={REACTION_NAMES[emoji] || undefined}
                aria-pressed={!!reacted}
                onClick={() => onReact(emoji)}
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 8,
                  border: "none",
                  background: reacted
                    ? "var(--ac-light, #eff6ff)"
                    : "transparent",
                  fontSize: 23,
                  cursor: "pointer",
                  transition: "background 0.1s, transform 0.1s",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onMouseEnter={(e) => {
                  if (!reacted)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "var(--g100, #f3f4f6)";
                }}
                onMouseLeave={(e) => {
                  if (!reacted)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "transparent";
                }}
              >
                {emoji}
              </button>
            );
          })}

          <button
            data-mtip="More reactions"
            aria-label="More reactions"
            onClick={(e) => {
              const r = (
                e.currentTarget as HTMLButtonElement
              ).getBoundingClientRect();
              setEmojiAnchor({
                top: r.top,
                left: r.left,
                width: r.width,
                height: r.height,
              });
              setShowEmojiPicker((v) => !v);
            }}
            style={{
              width: 30,
              height: 34,
              borderRadius: 8,
              border: "none",
              background: "transparent",
              fontSize: 14,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--g100, #f3f4f6)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "transparent";
            }}
          >
            <span style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              <IconSmile size={20} style={{ stroke: "var(--g600, #4b5563)" }} />
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  right: -4,
                  bottom: -3,
                  minWidth: 11,
                  height: 11,
                  padding: "0 1px",
                  borderRadius: 6,
                  background: "var(--sb, #fff)",
                  color: "var(--g700, #374151)",
                  fontSize: 10,
                  fontWeight: 800,
                  lineHeight: "11px",
                  textAlign: "center",
                  boxSizing: "border-box",
                }}
              >
                +
              </span>
            </span>
          </button>

          <div
            style={{
              width: 1,
              height: 22,
              background: "var(--g200, #e5e7eb)",
              margin: "0 6px",
            }}
          />

          {!!message.me && !message.file ? (
            <button
              data-mtip="Edit"
              aria-label="Edit message"
              onClick={() => onAction("edit")}
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "var(--g100, #f3f4f6)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "transparent";
              }}
            >
              <IconPencil size={18} style={{ stroke: "var(--g600, #4b5563)" }} />
            </button>
          ) : (
            <button
              data-mtip="Reply"
              aria-label="Reply"
              onClick={onReply}
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "var(--g100, #f3f4f6)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "transparent";
              }}
            >
              <IconReply size={18} style={{ stroke: "var(--g600, #4b5563)" }} />
            </button>
          )}

          {!embedded && (
            <button
              data-mtip="More actions"
              aria-label="More actions"
              onClick={(e) => {
                const r = (
                  e.currentTarget as HTMLButtonElement
                ).getBoundingClientRect();
                setMoreAnchor({
                  top: r.top,
                  left: r.left,
                  width: r.width,
                  height: r.height,
                });
                setShowMoreMenu(true);
              }}
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "var(--g100, #f3f4f6)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "transparent";
              }}
            >
              <svg
                viewBox="0 0 24 24"
                style={{
                  width: 18,
                  height: 18,
                  stroke: "var(--g600, #4b5563)",
                  fill: "none",
                  strokeWidth: 2,
                }}
              >
                <circle cx="12" cy="5" r="1" fill="currentColor" />
                <circle cx="12" cy="12" r="1" fill="currentColor" />
                <circle cx="12" cy="19" r="1" fill="currentColor" />
              </svg>
            </button>
          )}
        </div>,
        document.body,
      )}

      {showEmojiPicker && emojiAnchor && (
        <EmojiPicker
          anchorRect={emojiAnchor}
          onSelect={(emoji) => {
            onReact(emoji);
            setShowEmojiPicker(false);
          }}
          onClose={() => setShowEmojiPicker(false)}
        />
      )}

      {showMoreMenu && moreAnchor && (
        <MoreMenu
          anchorRect={moreAnchor}
          canEdit={!!message.me && !message.file}
          canDelete={true}
          isOwn={!!message.me}
          hasText={!!message.text}
          hasFile={!!message.file}
          isPinned={!!message.pinned}
          isBookmarked={!!message.bookmarked}
          isImportant={!!message.important}
          onAction={onAction}
          onClose={() => setShowMoreMenu(false)}
        />
      )}
    </>
  );
}
