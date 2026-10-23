"use client";
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  IconReply,
  IconForward,
  IconCopy,
  IconDownload,
  IconBookmark,
  IconPin,
  IconAlertTriangle,
  IconTrash,
} from "../../lib/icons";
import { type Rect } from "../EmojiPicker";

export interface MoreMenuProps {
  anchorRect: Rect;
  canEdit: boolean;
  canDelete: boolean;
  isOwn: boolean;
  hasText: boolean;
  hasFile: boolean;
  isPinned?: boolean;
  isBookmarked?: boolean;
  isImportant?: boolean;
  onAction: (action: string) => void;
  onClose: () => void;
}

function safePosition(
  anchorRect: Rect,
  popWidth: number,
  popHeight: number,
  preferTop = true,
  alignRight = false,
) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const margin = 8;

  let top: number;
  if (preferTop) {
    top = anchorRect.top - popHeight - margin;
    if (top < margin) top = anchorRect.top + anchorRect.height + margin;
  } else {
    top = anchorRect.top + anchorRect.height + margin;
    if (top + popHeight > vh - margin) top = anchorRect.top - popHeight - margin;
  }
  top = Math.max(margin, Math.min(top, vh - popHeight - margin));

  let left: number;
  if (alignRight) {
    left = anchorRect.left + anchorRect.width - popWidth;
  } else {
    left = anchorRect.left;
  }
  left = Math.max(margin, Math.min(left, vw - popWidth - margin));

  return { top, left };
}

const MORE_MENU_ITEMS = [
  { id: "reply", label: "Reply", icon: <IconReply size={16} />, requiresOwn: true },
  { id: "forward", label: "Forward", icon: <IconForward size={16} /> },
  { id: "copy", label: "Copy text", icon: <IconCopy size={16} />, requiresText: true },
  { id: "download", label: "Download", icon: <IconDownload size={16} />, requiresFile: true },
  {
    id: "bookmark",
    label: "Bookmark",
    icon: <IconBookmark size={16} />,
    requiresUnbookmarked: true,
  },
  {
    id: "bookmark",
    label: "Remove bookmark",
    icon: <IconBookmark size={16} fill="currentColor" />,
    requiresBookmarked: true,
  },
  {
    id: "delete",
    label: "Delete message",
    icon: <IconTrash size={16} />,
  },
  {
    id: "pin",
    label: "Pin message",
    icon: <IconPin size={16} />,
    requiresUnpinned: true,
  },
  {
    id: "unpin",
    label: "Unpin message",
    icon: <IconPin size={16} />,
    requiresPinned: true,
  },
  {
    id: "important",
    label: "Mark as important",
    icon: <IconAlertTriangle size={16} />,
    requiresOwnMsg: true,
    requiresNotImportant: true,
  },
  {
    id: "unimportant",
    label: "Remove importance",
    icon: <IconAlertTriangle size={16} />,
    requiresOwnMsg: true,
    requiresImportant: true,
  },
];

export default function MoreMenu({
  anchorRect,
  canEdit,
  canDelete,
  isOwn,
  hasText,
  hasFile,
  isPinned,
  isBookmarked,
  isImportant,
  onAction,
  onClose,
}: MoreMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [focused, setFocused] = useState(0);

  useEffect(() => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos(
      safePosition(anchorRect, r.width || 200, r.height || 200, false, true),
    );
    ref.current.focus();
  }, [anchorRect]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const visibleItems = MORE_MENU_ITEMS.filter((item: any) => {
    if (item.requiresText && !hasText) return false;
    if (item.requiresFile && !hasFile) return false;
    if (item.requiresOwn && !canEdit) return false;
    if (item.id === "delete" && !canDelete) return false;
    if (item.requiresPinned && !isPinned) return false;
    if (item.requiresUnpinned && isPinned) return false;
    if (item.requiresBookmarked && !isBookmarked) return false;
    if (item.requiresUnbookmarked && isBookmarked) return false;
    if (item.requiresOwnMsg && !isOwn) return false;
    if (item.requiresImportant && !isImportant) return false;
    if (item.requiresNotImportant && isImportant) return false;
    return true;
  });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused((f) => Math.min(f + 1, visibleItems.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((f) => Math.max(f - 1, 0));
    }
    if (e.key === "Enter") {
      e.preventDefault();
      onAction(visibleItems[focused].id);
      onClose();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Message actions"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{
        position: "fixed",
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        zIndex: 9999,
        background: "var(--sb, #fff)",
        border: "1px solid var(--g200, #e5e7eb)",
        borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        padding: "4px 0",
        minWidth: 200,
        opacity: pos ? 1 : 0,
        transition: "opacity 0.12s ease",
        outline: "none",
      }}
    >
      {visibleItems.map((item, i) => (
        <React.Fragment key={item.id}>
          <button
            role="menuitem"
            tabIndex={i === focused ? 0 : -1}
            onClick={() => {
              onAction(item.id);
              onClose();
            }}
            onMouseEnter={() => setFocused(i)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "9px 14px",
              border: "none",
              background:
                i === focused ? "var(--g100, #f3f4f6)" : "transparent",
              cursor: "pointer",
              textAlign: "left",
              color: "var(--g900, #111)",
              fontSize: 13,
              fontWeight: 500,
              transition: "background 0.1s",
            }}
          >
            <span style={{ width: 18, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              {item.icon}
            </span>
            {item.id === "delete" && !isOwn ? "Delete for me" : item.label}
          </button>
        </React.Fragment>
      ))}
    </div>,
    document.body,
  );
}
