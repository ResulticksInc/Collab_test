// EmojiPicker.tsx — ChatView module-scope emoji picker + portal utilities (lines 603-854).
// Mechanical extraction from ChatView.tsx. Do not hand-edit beyond imports.

import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { EMOJI_CATEGORIES, searchEmojis } from "../../lib/emojiData";

// ─── Portal utility ─────────────────────────────────────────────────────────

export const Portal = ({ children }: { children: React.ReactNode }) => createPortal(children, document.body);

// ─── Viewport-safe position calculator ─────────────────────────────────────

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function safePosition(
  anchorRect: Rect,
  contentWidth: number,
  contentHeight: number,
  preferAbove = true,
  preferLeft = false,
  margin = 8,
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Vertical: prefer above, flip below if not enough room
  let top: number;
  if (preferAbove) {
    top = anchorRect.top - contentHeight - margin;
    if (top < margin) top = anchorRect.top + anchorRect.height + margin;
    if (top + contentHeight > vh - margin)
      top = Math.max(margin, vh - contentHeight - margin);
  } else {
    top = anchorRect.top + anchorRect.height + margin;
    if (top + contentHeight > vh - margin)
      top = anchorRect.top - contentHeight - margin;
    if (top < margin) top = margin;
  }

  // Horizontal: center on anchor, clamp to viewport
  let left: number;
  if (preferLeft) {
    left = anchorRect.left + anchorRect.width - contentWidth;
  } else {
    left = anchorRect.left + anchorRect.width / 2 - contentWidth / 2;
  }
  left = Math.max(margin, Math.min(left, vw - contentWidth - margin));

  return { top, left };
}

// ─── Emoji Picker (portal-rendered) ─────────────────────────────────────────

export interface EmojiPickerProps {
  anchorRect: Rect;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ anchorRect, onSelect, onClose }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos(
      safePosition(anchorRect, r.width || 320, r.height || 360, false, false),
    );
  }, [anchorRect]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    setTimeout(() => document.addEventListener("mousedown", handler), 0);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const emojiBtn = (char: string, key: React.Key) => (
    <button
      key={key}
      onClick={() => {
        onSelect(char);
        onClose();
      }}
      style={{
        width: 34,
        height: 34,
        borderRadius: 7,
        border: "none",
        background: "transparent",
        fontSize: 18,
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
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
      aria-label={char}
    >
      {char}
    </button>
  );
  const results = q.trim() ? searchEmojis(q) : null;

  return (
    <Portal>
      <div
        ref={ref}
        role="dialog"
        aria-label="Emoji picker"
        style={{
          position: "fixed",
          top: pos ? pos.top : -9999,
          left: pos ? pos.left : -9999,
          zIndex: 9999,
          width: 320,
          background: "var(--sb, #fff)",
          border: "1px solid var(--g200, #e5e7eb)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          padding: 8,
          opacity: pos ? 1 : 0,
          transition: "opacity 0.12s ease",
          outline: "none",
        }}
        tabIndex={-1}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search emoji…"
          aria-label="Search emoji"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "7px 10px",
            marginBottom: 6,
            border: "1.5px solid var(--g200, #e5e7eb)",
            borderRadius: 8,
            background: "var(--main, #fff)",
            color: "var(--g900)",
            fontSize: 13,
            outline: "none",
          }}
        />
        <div style={{ maxHeight: 300, overflowY: "auto" }}>
          {results ? (
            results.length ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, 34px)",
                  gap: 2,
                }}
              >
                {results.map((e, i) => emojiBtn(e.char, i))}
              </div>
            ) : (
              <div
                style={{
                  fontSize: 13,
                  color: "var(--g500)",
                  padding: "10px 4px",
                }}
              >
                No emoji found.
              </div>
            )
          ) : (
            EMOJI_CATEGORIES.map((cat) => (
              <div key={cat.id}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "var(--g500)",
                    padding: "6px 2px 2px",
                    position: "sticky",
                    top: 0,
                    background: "var(--sb, #fff)",
                  }}
                >
                  {cat.label}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(7, 34px)",
                    gap: 2,
                  }}
                >
                  {cat.emojis.map((e, i) => emojiBtn(e.char, cat.id + i))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Portal>
  );
}

// ─── More Menu (portal-rendered, Teams-style) ────────────────────────────────

// ─── File attachment ─────────────────────────────────────────────────────────

// Download card for an oversized (non-E2EE) attachment. Renders WITHOUT fetching
// the multi-GB body inline (no useFileBlob) — the download is streamed by the
// browser only when the user clicks.
//
// AUDIT #28: the download is AUTHENTICATED. For a `largeFile` attachment we mint
// a short-lived (1h), membership-checked presigned URL on click (GET
// /files/:id/presigned) — nothing is reachable without an authorized session,
// and the URL expires. Legacy `collabLink` messages carry a pre-existing public
// bearer link; those keep working (the link can't be un-minted) but no NEW
// public link is ever created.


// ─── Media album (WhatsApp-style grid for consecutive images/videos) ─────────

// A message that is purely an image/video with no caption and no per-message
// affordances (reactions/reply/pin/bookmark) — only these can be coalesced into
// an album so nothing interactive or anchored is ever hidden.
