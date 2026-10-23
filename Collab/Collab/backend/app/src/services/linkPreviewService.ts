// Link unfurl / preview (Teams/WhatsApp-style cards). Fetches a URL server-side,
// extracts Open Graph / Twitter / <title> metadata, and caches it.
//
// SECURITY (SSRF) — CRITICAL on an internal corporate network: a user can paste
// ANY URL, so the server must NEVER fetch internal/loopback/link-local/cloud-
// metadata addresses. We validate the scheme, reject credentials, resolve the
// host, and block private IP ranges — re-validating on EVERY redirect hop.
import dns from "dns/promises";
import net from "net";
import { config } from "../platform";

interface Preview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

const cache = new Map<string, { at: number; data: Preview | null }>();
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 500;
const MAX_BYTES = 512 * 1024; // only need the <head>
const TIMEOUT_MS = 6000;

// Shared cross-instance cache (review finding #5): back the per-process Map with
// Redis when REDIS_URL is set, so a preview fetched by ONE replica is reused by
// all — instead of every pod re-fetching the same URL. Reuses the huddleStore
// graceful-fallback pattern EXACTLY (lazy client, fail-fast connect, in-process
// Map otherwise), so the single-instance dev path is byte-identical to today. A
// stale link preview is harmless, so this cache is safe to share aggressively.
let redisClient: any = null; // null=uninit, false=unavailable (Map only), else client
const RKEY = (k: string) => "linkprev:" + k;
async function redisInit() {
  if (redisClient !== null) return;
  if (!config.redis?.url) {
    redisClient = false;
    return;
  }
  try {
    const redis = await import("redis");
    const client = redis.createClient({
      url: config.redis.url,
      socket: { reconnectStrategy: false, connectTimeout: 3000 },
    });
    client.on("error", () => {});
    await Promise.race([
      client.connect(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("redis connect timeout")), 3500),
      ),
    ]);
    redisClient = client;
  } catch {
    redisClient = false;
  }
}

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("::ffff:");
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const u = new URL(raw); // throws on invalid
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("unsupported scheme");
  if (u.username || u.password) throw new Error("credentials not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host.toLowerCase() === "localhost") throw new Error("blocked host");
  const ips = net.isIP(host)
    ? [host]
    : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(isBlockedIp)) throw new Error("blocked address");
  return u;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x?[0-9a-f]+;/gi, " ").trim();
}

function metaContent(html: string, prop: string): string | null {
  // matches <meta property="og:x" content="..."> in either attribute order
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, "i");
  const m = re1.exec(html) || re2.exec(html);
  return m && m[1] ? decodeEntities(m[1]) : null;
}

function parse(html: string, finalUrl: URL): Preview {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  let image =
    metaContent(html, "og:image") || metaContent(html, "og:image:url") || metaContent(html, "twitter:image");
  if (image) {
    try { image = new URL(image, finalUrl).href; } catch { image = null; }
    if (image) { try { if (isBlockedIp(new URL(image).hostname)) image = null; } catch { /* keep */ } }
  }
  return {
    url: finalUrl.href,
    title: metaContent(html, "og:title") || metaContent(html, "twitter:title") || (titleTag ? decodeEntities(titleTag[1]) : null),
    description: metaContent(html, "og:description") || metaContent(html, "twitter:description") || metaContent(html, "description"),
    image,
    siteName: metaContent(html, "og:site_name") || finalUrl.hostname.replace(/^www\./, ""),
  };
}

export async function getPreview(rawUrl: string): Promise<Preview | null> {
  const key = (rawUrl || "").slice(0, 2048);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  // L2: shared Redis cache (a peer replica may have already fetched this URL).
  await redisInit();
  if (redisClient) {
    try {
      const raw = await redisClient.get(RKEY(key));
      if (raw !== null && raw !== undefined) {
        const data = JSON.parse(raw) as Preview | null;
        cache.set(key, { at: Date.now(), data }); // warm L1 so repeat hits skip Redis
        return data;
      }
    } catch {
      /* Redis hiccup → fall through to a live fetch (never blocks the unfurl) */
    }
  }

  const fetchFn: any = (globalThis as any).fetch;
  let data: Preview | null = null;
  try {
    // Manual redirect following with per-hop SSRF re-validation (≤4 hops).
    let current = await assertPublicUrl(rawUrl);
    let html: string | null = null;
    for (let hop = 0; hop < 4; hop++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      let res: any;
      try {
        res = await fetchFn(current.href, {
          method: "GET",
          redirect: "manual",
          signal: ctrl.signal,
          headers: { "User-Agent": "Collab-LinkPreview/1.0", Accept: "text/html,*/*;q=0.8" },
        });
      } finally {
        clearTimeout(t);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = await assertPublicUrl(new URL(res.headers.get("location"), current).href);
        continue;
      }
      if (!res.ok) break;
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("text/html") && !ct.includes("application/xhtml")) break;
      // Read at most MAX_BYTES (the <head> is all we need).
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (reader) {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
          if (total >= MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } break; }
        }
        html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
      } else {
        html = (await res.text()).slice(0, MAX_BYTES);
      }
      break;
    }
    if (html) {
      const p = parse(html, current);
      // Only cache/return if we got something useful.
      if (p.title || p.description || p.image) data = p;
    }
  } catch {
    data = null; // blocked / unreachable / parse failure → no preview (silent)
  }

  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), data });
  // Write-through to the shared cache (best-effort; the Map already holds it, and
  // a negative result — data===null — is cached too, exactly like the Map).
  if (redisClient) {
    try {
      await redisClient.set(RKEY(key), JSON.stringify(data), { PX: TTL_MS });
    } catch {
      /* best-effort; Redis being down never fails the preview */
    }
  }
  return data;
}
