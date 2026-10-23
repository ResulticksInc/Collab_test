"use client";
import { useEffect } from "react";

// Brand mark: inline SVG component (no network asset), so the error boundary stays
// self-contained. Same icon as the sign-in card / rail.
import { CollabIcon } from "../components/brand/Logo";

/**
 * Page-level error boundary (Next App Router). Catches render/runtime errors
 * thrown anywhere in the app tree so a single bad render shows a recoverable
 * fallback instead of a blank white screen. "Try again" re-renders the subtree;
 * "Reload" does a full refresh as a last resort.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface for diagnostics; the message itself is never shown to the user.
    console.error("[app error boundary]", error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 24,
        textAlign: "center",
        background: "var(--bg, #f7f8fa)",
        color: "var(--g900, #0D2144)",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      }}
    >
      <CollabIcon title="Collab" style={{ width: 56, height: 56 }} />
      <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Something went wrong</h2>
      <p style={{ color: "var(--g500, #6b7280)", maxWidth: 380, margin: 0, lineHeight: 1.5 }}>
        Collab hit an unexpected error. Your data is safe — try again, and reload if it keeps happening.
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button
          onClick={() => reset()}
          style={{
            padding: "10px 20px",
            borderRadius: 10,
            border: "none",
            background: "var(--ac, #2563EB)",
            color: "#fff",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
        <button
          onClick={() => { if (typeof window !== "undefined") window.location.reload(); }}
          style={{
            padding: "10px 20px",
            borderRadius: 10,
            border: "1px solid var(--g300, #d1d5db)",
            background: "transparent",
            color: "var(--g700, #374151)",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
