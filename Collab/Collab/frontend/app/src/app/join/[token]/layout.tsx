import type { ReactNode } from "react";

// The URL carries a credential (the meeting's public token): keep it out of
// search indexes and never send it onward in a Referer header.
export const metadata = {
  title: "Join meeting",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

// Cloudflare build (CF_STATIC=1, `output: export`): a static export cannot
// pre-render an arbitrary token, so export ONE placeholder page (/join/_). The
// Worker serves that page for every /join/<token> (cloudflare/src/index.ts) and
// page.tsx reads the real token from the browser URL. The Docker / `next start`
// build pre-renders nothing here and keeps resolving the token on the server.
export function generateStaticParams(): { token: string }[] {
  return process.env.CF_STATIC === "1" ? [{ token: "_" }] : [];
}

export default function JoinLayout({ children }: { children: ReactNode }) {
  return children;
}
