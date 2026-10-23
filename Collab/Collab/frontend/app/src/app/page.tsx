"use client";
import dynamic from "next/dynamic";
import SingleTabGuard from "../components/SingleTabGuard";

// Render the app CLIENT-ONLY (no SSR). CoLabV1 is one large client component whose
// FIRST render legitimately depends on browser-only state that doesn't exist on
// the server — the saved session token, the saved theme, and locale/timezone-
// formatted times. SSR-ing it produced "Text content does not match server-
// rendered HTML" hydration errors (React #418/#422/#425), which forced React to
// throw away the server HTML and re-render the whole tree on the client (the
// "Switched to client rendering" warning). Skipping SSR removes that mismatch
// surface entirely — correct for an authenticated SPA with no SEO surface — and
// drops the wasted double-render. A themed placeholder bridges the brief chunk
// load (CoLabV1 shows its own <AppSplash> immediately after).
const CoLabV1 = dynamic(() => import("../components/CoLabV1"), {
  ssr: false,
  loading: () => (
    <div style={{ minHeight: "100vh", background: "var(--boot-bg, #e8ddff)" }} />
  ),
});

export default function Page() {
  // One active Collab tab at a time (BroadcastChannel handshake) — see lib/singleTab.ts.
  return (
    <SingleTabGuard>
      <CoLabV1 />
    </SingleTabGuard>
  );
}
