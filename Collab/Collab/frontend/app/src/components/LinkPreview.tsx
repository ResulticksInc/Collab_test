import React, { useEffect, useState } from "react";
import { getLinkPreview } from "../lib/linkPreview";

// Teams/WhatsApp-style link unfurl card. Fetches OG metadata for `url` (cached,
// SSRF-guarded server-side) and renders the existing `.link-card` markup; renders
// nothing if there's no useful preview.
export default function LinkPreview({ url, token }: { url: string; token: string }) {
  const [p, setP] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    setP(null);
    if (url && token) getLinkPreview(token, url).then((d) => { if (alive) setP(d); });
    return () => { alive = false; };
  }, [url, token]);

  if (!p || (!p.title && !p.description && !p.image)) return null;
  let host = "";
  try { host = new URL(p.url || url).hostname.replace(/^www\./, ""); } catch { /* ignore */ }

  return (
    <a
      className="link-card"
      href={p.url || url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
    >
      {p.image ? <img className="lc-img" src={p.image} alt="" loading="lazy" /> : null}
      <span className="lc-domain">{p.siteName || host}</span>
      {p.title ? <span className="lc-title">{p.title}</span> : null}
      {p.description ? <span className="lc-desc">{p.description}</span> : null}
    </a>
  );
}
