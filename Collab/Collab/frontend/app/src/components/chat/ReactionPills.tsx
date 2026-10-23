"use client";
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { IconSmile, IconUndo } from "../../lib/icons";
import { EmojiPicker, type Rect } from "../EmojiPicker";

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

export default function ReactionPills({
  reactions,
  onReact,
}: {
  reactions: any[];
  onReact: (emoji: string) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [tipPos, setTipPos] = useState<{ top: number; left: number } | null>(null);
  const [addAnchor, setAddAnchor] = useState<any>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const rlen = (reactions || []).length;

  useEffect(() => {
    const row = rowRef.current;
    if (!row || !rlen) {
      setCollapsed(false);
      return;
    }
    const measure = () => {
      const bubble = row.previousElementSibling as HTMLElement | null;
      const bubbleW = bubble ? bubble.getBoundingClientRect().width : 0;
      let est = 30;
      for (const r of reactions || []) {
        est += 34;
        if (r && r.count > 1) est += 4 + String(r.count).length * 7;
        est += 5;
      }
      setCollapsed(rlen > 1 && bubbleW > 0 && est > bubbleW + 4);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [reactions, rlen]);

  useEffect(() => {
    if (!panelPos) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rowRef.current && rowRef.current.contains(t)) return;
      if (panelRef.current && panelRef.current.contains(t)) return;
      setPanelPos(null);
    };
    const id = setTimeout(() => document.addEventListener("mousedown", h), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", h);
    };
  }, [panelPos]);

  if (!reactions || !reactions.length) return null;

  const ordered = reactions
    .map((r: any, i: number) => ({ r, i }))
    .sort((a, b) => (b.r.mine ? 1 : 0) - (a.r.mine ? 1 : 0) || a.i - b.i)
    .map((x) => x.r);

  const PILL_H = 22;
  const pillBase: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    height: PILL_H,
    padding: "0 8px",
    borderRadius: PILL_H / 2,
    boxSizing: "border-box",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
    lineHeight: 1,
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.06)",
    transition: "all 0.1s",
  };

  const namesOf = (r: any): string[] =>
    (r.reactors || []).map((u: any) => u.name).filter(Boolean);
  const labelOf = (who: string[]) =>
    who.slice(0, 12).join(", ") + (who.length > 12 ? ` +${who.length - 12}` : "");

  const showTip = (i: number, el: HTMLElement, who: string[]) => {
    try {
      const r = el.getBoundingClientRect();
      const w = Math.min(240, labelOf(who).length * 7 + 24);
      setTipPos(
        safePosition({ top: r.top, left: r.left, width: r.width, height: r.height }, w, 28, true, false),
      );
    } catch {
      setTipPos(null);
    }
    setOpen(i);
  };

  const addToggle = (
    <button
      className="reaction-pill reaction-add"
      title="Add reaction"
      aria-label="Add reaction"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setAddAnchor({ top: r.top, left: r.left, width: r.width, height: r.height });
      }}
      style={{ ...pillBase, border: "1px solid var(--g200, #e5e7eb)", background: "var(--sb, #fff)" }}
    >
      <span style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
        <IconSmile size={14} style={{ stroke: "var(--g600, #4b5563)" }} />
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: -4,
            bottom: -3,
            minWidth: 10,
            height: 10,
            padding: "0 1px",
            borderRadius: 6,
            background: "var(--sb, #fff)",
            color: "var(--g700, #374151)",
            fontSize: 9,
            fontWeight: 800,
            lineHeight: "10px",
            textAlign: "center",
            boxSizing: "border-box",
          }}
        >
          +
        </span>
      </span>
    </button>
  );

  const picker = addAnchor ? (
    <EmojiPicker
      anchorRect={addAnchor}
      onSelect={(emoji: string) => {
        onReact(emoji);
        setAddAnchor(null);
      }}
      onClose={() => setAddAnchor(null)}
    />
  ) : null;

  const rowStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 4,
    marginTop: 3,
  };

  if (collapsed) {
    const distinct: string[] = [];
    for (const r of ordered) if (r && !distinct.includes(r.emoji)) distinct.push(r.emoji);
    const totalCount = ordered.reduce((n: number, r: any) => n + (r.count || 0), 0);
    const rows: { emoji: string; name: string }[] = [];
    for (const r of ordered) for (const u of r.reactors || []) if (u && u.name) rows.push({ emoji: r.emoji, name: u.name });
    return (
      <div ref={rowRef} style={rowStyle} role="group" aria-label="Reactions">
        <button
          className="reaction-pill"
          aria-haspopup="true"
          aria-expanded={!!panelPos}
          title="See who reacted"
          onClick={(e) => {
            if (panelPos) {
              setPanelPos(null);
              return;
            }
            try {
              const el = e.currentTarget as HTMLElement;
              const rect = el.getBoundingClientRect();
              const estH = Math.min(
                340,
                26 + rows.length * 28 + (ordered.some((r) => r.mine) ? 44 : 0) + 14,
              );
              const pos = safePosition(
                { top: rect.top, left: rect.left, width: rect.width, height: estH },
                240,
                estH,
                true,
                false,
              );
              const scroller = el.closest(".msgs") as HTMLElement | null;
              const minLeft = (scroller ? scroller.getBoundingClientRect().left : 0) + 10;
              if (pos && pos.left < minLeft) pos.left = minLeft;
              setPanelPos(pos);
            } catch {
              setPanelPos(null);
            }
          }}
          style={{ ...pillBase, gap: 0, padding: "0 9px", border: "1px solid var(--g200, #e5e7eb)", background: "var(--sb, #fff)", color: "var(--g700, #374151)" }}
        >
          {distinct.slice(0, 3).map((em, i) => (
            <span key={i} style={{ fontSize: 13, marginLeft: i ? -2 : 0 }}>{em}</span>
          ))}
          <span style={{ marginLeft: 5 }}>{totalCount}</span>
        </button>
        {addToggle}
        {picker}
        {panelPos ? (
          createPortal(
            <div
              ref={panelRef}
              role="menu"
              className="rx-reactor-panel"
              style={{
                position: "fixed",
                top: panelPos.top,
                left: panelPos.left,
                zIndex: 4000,
                minWidth: 180,
                maxWidth: 260,
                maxHeight: 300,
                overflowY: "auto",
                background: "var(--card, #fff)",
                border: "1px solid var(--g200, #e5e7eb)",
                borderRadius: 10,
                padding: 6,
                boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
              }}
            >
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--g500, #6b7280)", padding: "2px 6px 4px" }}>
                Reactions
              </div>
              {rows.map((rr, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 6px", borderRadius: 6 }}>
                  <span style={{ fontSize: 15, flexShrink: 0 }}>{rr.emoji}</span>
                  <span style={{ fontSize: 12.5, color: "var(--g800, #1f2937)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{rr.name}</span>
                </div>
              ))}
              {ordered.some((r) => r.mine) ? (
                <>
                  <div style={{ height: 1, background: "var(--g150, var(--g200, #eef0f3))", margin: "5px 4px" }} />
                  <button
                    onClick={() => {
                      const mine = ordered.find((r) => r.mine);
                      if (mine) onReact(mine.emoji);
                      setPanelPos(null);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      width: "100%",
                      padding: "6px",
                      border: "none",
                      background: "none",
                      borderRadius: 6,
                      cursor: "pointer",
                      fontSize: 12.5,
                      fontWeight: 500,
                      color: "var(--red, #dc2626)",
                      textAlign: "left",
                    }}
                  >
                    <IconUndo size={15} />
                    Remove my reaction
                  </button>
                </>
              ) : null}
            </div>,
            document.body,
          )
        ) : null}
      </div>
    );
  }

  return (
    <div ref={rowRef} style={rowStyle} role="group" aria-label="Reactions">
      {ordered.map((r: any, i: number) => {
        const who = namesOf(r);
        return (
          <div
            key={i}
            style={{ position: "relative" }}
            onMouseEnter={(e) => who.length && showTip(i, e.currentTarget as HTMLElement, who)}
            onMouseLeave={() => setOpen((o) => (o === i ? null : o))}
          >
            <button
              className="reaction-pill"
              onClick={() => onReact(r.emoji)}
              aria-pressed={!!r.mine}
              aria-label={`${r.emoji} reacted by ${who.length ? who.join(", ") : r.count}`}
              style={{
                ...pillBase,
                border: `1px solid ${r.mine ? "color-mix(in srgb, var(--ac, #6366F1) 30%, var(--g200, #e5e7eb))" : "var(--g200, #e5e7eb)"}`,
                background: r.mine ? "var(--ac-light, #eff6ff)" : "var(--sb, #fff)",
                color: r.mine ? "var(--ac, #3b82f6)" : "var(--g700, #374151)",
              }}
            >
              <span style={{ fontSize: 13 }}>{r.emoji}</span>
              {r.count > 1 ? <span>{r.count}</span> : null}
            </button>
          </div>
        );
      })}
      {addToggle}
      {picker}
      {open != null && tipPos && ordered[open] && namesOf(ordered[open]).length ? (
        createPortal(
          <div
            role="tooltip"
            style={{
              position: "fixed",
              top: tipPos.top,
              left: tipPos.left,
              zIndex: 4000,
              background: "var(--g900, #111827)",
              color: "#fff",
              padding: "6px 10px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 500,
              whiteSpace: "nowrap",
              maxWidth: 240,
              overflow: "hidden",
              textOverflow: "ellipsis",
              boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
              pointerEvents: "none",
            }}
          >
            {labelOf(namesOf(ordered[open]))}
          </div>,
          document.body,
        )
      ) : null}
    </div>
  );
}
