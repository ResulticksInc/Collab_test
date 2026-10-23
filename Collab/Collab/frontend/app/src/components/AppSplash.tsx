"use client";
import React from "react";
import { CollabWordmark, CollabLoadingMark } from "./brand/Logo";

/**
 * Full-viewport branded splash shown ONLY while a persisted session token is
 * being validated on a hard refresh (see the auth bootstrap in CoLabV1). It
 * prevents the login screen from flashing and bouncing back once auth resolves
 * — a logged-in user who refreshes sees this brief loader, never the login form.
 * Theme-aware via the app's CSS vars, with safe fallbacks for first paint.
 */
export default function AppSplash() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading Collab"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 26,
        background: "var(--boot-bg, #e8ddff)",
        color: "var(--ink, #e8eef7)",
        zIndex: 4900,
      }}
    >
      {/* "Collab" wordmark as the brand SVG (not HTML text); gradient on light,
          white on dark, handled by the component. */}
      <CollabWordmark className="app-splash-wm" />

      {/* The brand loading mark sits static and centered while the ring spins. */}
      <div className="app-splash-loader" aria-hidden="true">
        <div className="app-splash-ring" />
        <CollabLoadingMark className="app-splash-mark" />
      </div>

      <style>{`
        /* "Collab" wordmark SVG — theme-aware via the component (gradient on light, white on dark). */
        .app-splash-wm { height: 42px; width: auto; display: block; }
        .app-splash-loader {
          position: relative;
          width: 76px;
          height: 76px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        /* Spinning arc painted with the button gradient (#8b29be → #381354): a
           conic gradient masked into a thin ring. */
        .app-splash-ring {
          position: absolute;
          inset: 0;
          border-radius: 50%;
          background: conic-gradient(from 0deg, rgba(139, 41, 190, 0) 0%, #8b29be 62%, #381354 100%);
          -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 4px));
          mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 calc(100% - 4px));
          animation: app-splash-spin 0.8s linear infinite;
        }
        /* The loading mark sits centered and static while the ring spins. */
        .app-splash-mark {
          position: relative;
          /* the glyph fills ~56% of its 100x100 box; 70px puts it ~40px inside the ring */
          width: 70px;
          height: 70px;
          display: block;
        }
        @keyframes app-splash-spin {
          to { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .app-splash-ring { animation-duration: 1.6s; }
        }
      `}</style>
    </div>
  );
}
