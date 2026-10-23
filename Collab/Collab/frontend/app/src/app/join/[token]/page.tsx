"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// Public meeting link (/join/<token>) — the guest entry point. Client-only like
// the main app: it needs camera/mic, the socket and sessionStorage. Deliberately
// NOT wrapped in SingleTabGuard (that guard exists for the signed-in app; a guest
// may legitimately open the link next to another Collab tab) and it never reads
// or writes the signed-in app's token.
const GuestMeeting = dynamic(() => import("../../../components/GuestMeeting"), {
  ssr: false,
  loading: () => <div style={{ minHeight: "100vh", background: "var(--boot-bg, #e8ddff)" }} />,
});

// On the static Cloudflare export every /join/<token> is served from the one
// pre-rendered page (/join/_, see layout.tsx), so `params.token` is the build-time
// placeholder there. The browser URL is the source of truth on every host.
function tokenFromLocation(fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const m = /^\/join\/([^/?#]+)/.exec(window.location.pathname);
  if (!m) return fallback;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export default function JoinPage({ params }: { params: { token: string } }) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    setToken(tokenFromLocation(params.token));
  }, [params.token]);
  if (!token) {
    return <div style={{ minHeight: "100vh", background: "var(--boot-bg, #e8ddff)" }} />;
  }
  return <GuestMeeting linkToken={token} />;
}
