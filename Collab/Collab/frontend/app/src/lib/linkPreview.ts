import { api } from "./api";

// Extract the first http(s) URL from a message's rich HTML. Prefers an <a href>
// (how TipTap stores links); falls back to a bare URL in the text.
export function firstUrl(html: string | null | undefined): string | null {
  if (!html) return null;
  const s = String(html);
  const a = /<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)["']/i.exec(s);
  if (a) return a[1];
  const text = s.replace(/<[^>]+>/g, " ");
  const m = /https?:\/\/[^\s<>"']+/i.exec(text);
  return m ? m[0].replace(/[).,;!?]+$/, "") : null; // trim trailing punctuation
}

// Client-side cache so a URL is fetched once per session (server caches too).
const cache = new Map<string, any>();
export async function getLinkPreview(token: string, url: string) {
  if (cache.has(url)) return cache.get(url);
  try {
    const data = await api.getLinkPreview(token, url);
    cache.set(url, data || null);
    return data || null;
  } catch {
    cache.set(url, null);
    return null;
  }
}
