"use client";
import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  IconReply,
  IconCopy,
  IconPin,
  IconBookmark,
  IconForward,
  IconPencil,
  IconTrash,
  IconPlus,
} from "../../lib/icons";

interface ActionSheetProps {
  message: any;
  onAction: (action: string) => void;
  onClose: () => void;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export default function ActionSheet({ message, onAction, onClose }: ActionSheetProps) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  return createPortal(
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 9998,
          background: "rgba(0,0,0,0.4)",
          animation: "fade-in 0.15s ease",
        }}
      />
      <div
        role="dialog"
        aria-label="Message actions"
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          background: "var(--sb, #fff)",
          borderRadius: "16px 16px 0 0",
          padding: "12px 0 max(16px, env(safe-area-inset-bottom))",
          boxShadow: "0 -4px 24px rgba(0,0,0,0.15)",
          animation: "slide-up 0.2s ease",
        }}
      >
        {/* Quick reactions row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-around",
            padding: "8px 16px 16px",
            borderBottom: "1px solid var(--g100)",
          }}
        >
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => {
                onAction(`react:${emoji}`);
                onClose();
              }}
              style={{
                fontSize: 28,
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 4,
                borderRadius: 8,
                transition: "transform 0.1s",
              }}
            >
              {emoji}
            </button>
          ))}
          <button
            onClick={() => {
              onAction("picker");
              onClose();
            }}
            style={{
              fontSize: 20,
              background: "var(--g100)",
              border: "none",
              borderRadius: "50%",
              width: 40,
              height: 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <IconPlus size={20} />
          </button>
        </div>

        {/* Action items */}
        <div style={{ paddingTop: 8 }}>
          <button
            className="sheet-item"
            onClick={() => {
              onAction("reply");
              onClose();
            }}
          >
            <IconReply size={18} /> Reply
          </button>
          <button
            className="sheet-item"
            onClick={() => {
              onAction("copy");
              onClose();
            }}
          >
            <IconCopy size={18} /> Copy Text
          </button>
          <button
            className="sheet-item"
            onClick={() => {
              onAction("pin");
              onClose();
            }}
          >
            <IconPin size={18} /> {message.pinned ? "Unpin Message" : "Pin Message"}
          </button>
          <button
            className="sheet-item"
            onClick={() => {
              onAction("bookmark");
              onClose();
            }}
          >
            <IconBookmark size={18} /> {message.bookmarked ? "Remove Bookmark" : "Bookmark Message"}
          </button>
          <button
            className="sheet-item"
            onClick={() => {
              onAction("forward");
              onClose();
            }}
          >
            <IconForward size={18} /> Forward Message
          </button>

          {message.mine && (
            <>
              <button
                className="sheet-item"
                onClick={() => {
                  onAction("edit");
                  onClose();
                }}
              >
                <IconPencil size={18} /> Edit Message
              </button>
              <button
                className="sheet-item danger"
                onClick={() => {
                  onAction("delete");
                  onClose();
                }}
                style={{ color: "#dc2626" }}
              >
                <IconTrash size={18} /> Delete Message
              </button>
            </>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
