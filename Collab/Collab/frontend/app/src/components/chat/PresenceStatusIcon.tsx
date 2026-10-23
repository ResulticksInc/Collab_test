"use client";
// PresenceStatusIcon — Teams-style status glyph: a solid coloured circle with a white
// symbol (Available ✓ green · Away/BRB clock amber · Busy/DND – red · Offline × gray).
import React from "react";
import { presenceDotClass } from "../../lib/presence";

const COLORS: Record<string, string> = {
  "s-on": "#16a34a",
  "s-aw": "#d97706",
  "s-bs": "#dc2626",
  "s-off": "#9ca3af",
};

export default function PresenceStatusIcon({ presence, size = 20 }: { presence?: string | null; size?: number }) {
  const kind = presenceDotClass(presence);
  const glyph =
    kind === "s-on" ? (
      <path d="M6.2 10.4l2.6 2.6 5-5.4" />
    ) : kind === "s-aw" ? (
      <>
        <path d="M10 5.8V10l2.8 1.8" />
      </>
    ) : kind === "s-bs" ? (
      <path d="M6.2 10h7.6" />
    ) : (
      <path d="M7 7l6 6M13 7l-6 6" />
    );
  return (
    <svg
      className="pstatus-ico"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="10" cy="10" r="10" fill={COLORS[kind] || COLORS["s-off"]} />
      <g fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {glyph}
      </g>
    </svg>
  );
}
