import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EMOJI_CATEGORIES, searchEmojis } from "../lib/emojiData";
import { useEsc } from "../lib/escStack";

// Shared full-library emoji picker (BA/CEO #6). Extracted from ChatView so the
// in-meeting chat composer gets the exact same searchable, categorised picker
// as the main chat instead of a tiny hardcoded palette. Self-contained: its own
// portal + viewport-safe positioning, drawing the emoji set from lib/emojiData
// (the single source of truth, so the two surfaces never drift).

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function Portal({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body);
}

// Prefer above the anchor, flip below when there isn't room; centre + clamp
// horizontally to the viewport.
function safePosition(
  anchorRect: Rect,
  contentWidth: number,
  contentHeight: number,
  margin = 8,
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = anchorRect.top - contentHeight - margin;
  if (top < margin) top = anchorRect.top + anchorRect.height + margin;
  if (top + contentHeight > vh - margin)
    top = Math.max(margin, vh - contentHeight - margin);
  let left = anchorRect.left + anchorRect.width / 2 - contentWidth / 2;
  left = Math.max(margin, Math.min(left, vw - contentWidth - margin));
  return { top, left };
}

interface EmojiPickerProps {
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
    setPos(safePosition(anchorRect, r.width || 320, r.height || 360));
  }, [anchorRect]);

  // Esc closes the picker via the app-wide LIFO stack so it consumes the keypress
  // (no module "Back" fires on the same Esc) and, if the picker is opened over
  // another overlay, only the picker closes first.
  useEsc(true, onClose);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => {
      document.removeEventListener("mousedown", handler);
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

export default EmojiPicker;
