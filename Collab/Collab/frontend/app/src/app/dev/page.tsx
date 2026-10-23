"use client";
import dynamic from "next/dynamic";

// Engineering Operations Portal ("/dev") — internal developer Mission Control.
// Rendered CLIENT-ONLY (no SSR) for the same reason as the main app: its first
// render legitimately depends on browser-only state (the saved session token) and
// polls live telemetry, so there is no meaningful server HTML to pre-render and
// SSR would only introduce a hydration-mismatch surface. A dark placeholder
// bridges the brief chunk load; DevPortal renders its own shell immediately after.
const DevPortal = dynamic(() => import("../../components/dev/DevPortal"), {
  ssr: false,
  loading: () => <div style={{ position: "fixed", inset: 0, background: "#070b14" }} />,
});

export default function DevPage() {
  return <DevPortal />;
}
