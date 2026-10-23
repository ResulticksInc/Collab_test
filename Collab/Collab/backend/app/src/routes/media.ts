import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, fail, db } from "../platform";
import authMiddleware from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import * as storage from "../services/storageService";
import { resolveGifConfig } from "../services/gifProvider";
import { randomUUID } from "crypto";

// ── Chat media: GIPHY GIFs/stickers and custom stickers — COST-FREE
// The GIPHY API key stays SERVER-SIDE (never shipped to the browser); the client
// calls these proxy endpoints. With no key configured the GIF endpoints return
// { configured:false } so the picker shows a friendly setup hint instead of
// erroring. Custom stickers (WhatsApp-style) are self-hosted in object storage.

// PUBLIC custom-sticker image serve (NO auth — declared BEFORE the auth gate).
// Stickers are inherently shareable and addressed by a random opaque id, so any
// recipient's <img> can load one without a token (same posture as public avatars /
// file links). Streams the bytes straight from object storage; long-cached since a
// sticker id is immutable.
router.get("/stickers/:id/img", async (req, res) => {
  const id = String(req.params.id || "");
  const s = await db.stickers.get(id).catch(() => null);
  if (!s) return res.status(404).json(fail("NOT_FOUND", "Sticker not found."));
  try {
    const buf = await storage.download(s.storageKey);
    res.setHeader("Content-Type", s.mime || "image/png");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Disposition", "inline");
    // Prevent MIME-sniffing and script execution for any stickers already in storage.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");
    return res.end(buf);
  } catch (_) {
    return res.status(404).json(fail("NOT_FOUND", "Sticker not found."));
  }
});

// PUBLIC GIPHY image proxy (NO auth — declared BEFORE the auth gate, like the
// sticker serve). GIF/sticker thumbnails and sent GIFs are loaded by <img> tags,
// which can't attach a bearer token. Proxying them through OUR origin also fixes
// the web client, where browser tracking-protection / ad-blockers silently block
// direct requests to giphy.com — the desktop app has no such blocking, which is
// why GIFs "load fine" there but appear broken in the browser. Host-allowlisted to
// *.giphy.com so this can't be abused as an open SSRF/relay proxy; short timeout,
// size cap, and a long immutable cache (a GIPHY asset URL is content-addressed).
const gifImgLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, message: "Slow down a moment." });
router.get("/gifs/img", gifImgLimiter, async (req, res) => {
  let u: URL;
  try {
    u = new URL(String(req.query.u || ""));
  } catch {
    return res.status(400).end();
  }
  const host = u.hostname.toLowerCase();
  const allowed = u.protocol === "https:" && (host === "giphy.com" || host.endsWith(".giphy.com"));
  if (!allowed) return res.status(400).end(); // SSRF guard: GIPHY CDN only
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(u.toString(), { signal: ctrl.signal, headers: { Accept: "image/*" } });
    clearTimeout(timer);
    const ct = r.headers.get("content-type") || "image/gif";
    if (!r.ok || !/^image\//i.test(ct)) return res.status(502).end();
    const len = Number(r.headers.get("content-length") || 0);
    if (len && len > 25 * 1024 * 1024) return res.status(413).end(); // sane ceiling
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    return res.end(buf);
  } catch (_) {
    return res.status(502).end();
  }
});

router.use(authMiddleware);

// Light per-user rate limits — these hit third-party free tiers, so protect the
// shared quota from a hot client without affecting normal use.
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 90, message: "Slow down a moment." });

const GIPHY = "https://api.giphy.com/v1";

// Route a GIPHY CDN URL through our own same-origin image proxy (see /gifs/img).
function giphyProxy(u: string): string {
  return u ? "/api/media/gifs/img?u=" + encodeURIComponent(u) : "";
}

// Normalize a GIPHY result to the compact client shape, with both the send asset
// and the grid thumbnail proxied same-origin. For SEND we prefer a right-sized
// asset (downsized ≤~2MB / fixed_height) over the full `original`, which can be
// 5-8MB — sending the original is what made GIFs "take an eternity to render".
// GIPHY sticker results are transparent GIFs, so the same mapping works for both.
function mapGiphy(r: any) {
  const im = (r && r.images) || {};
  const full = im.downsized || im.fixed_height || im.original || {};
  const thumb = im.fixed_width || im.fixed_width_downsampled || im.downsized || full;
  return {
    id: String(r.id || ""),
    url: giphyProxy(full.url || ""),
    preview: giphyProxy(thumb.url || full.url || ""),
    width: Number(full.width) || 0,
    height: Number(full.height) || 0,
    desc: r.title || "",
  };
}

// GET /api/media/gifs?q=&type=gif|sticker&pos=  — search, or trending when q is empty.
// pos is an opaque pagination cursor (GIPHY offset, stringified).
router.get("/gifs", searchLimiter, async (req, res) => {
  // An org admin-set key takes precedence over the deployment-wide env key.
  const { provider, key } = await resolveGifConfig((req as any).org?.id);
  if (!key || !provider)
    // Not an error — the picker shows the keyless built-in sticker pack + the
    // "create your own" studio. An admin can add a free GIPHY key to enable search.
    return res.json(ok({ configured: false, provider: "", results: [], next: "" }));
  const q = String(req.query.q || "").trim().slice(0, 50); // GIPHY caps q at 50
  const isSticker = String(req.query.type || "gif") === "sticker";
  const offset = Math.min(4999, Math.max(0, parseInt(String(req.query.pos || "0"), 10) || 0));
  const params = new URLSearchParams({
    api_key: key,
    limit: "24",
    rating: "g", // workplace-safe (family-friendly)
    bundle: "messaging_non_clips",
  });
  if (q) params.set("q", q);
  if (offset) params.set("offset", String(offset));
  const kind = isSticker ? "stickers" : "gifs";
  const endpoint = q ? "search" : "trending";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`${GIPHY}/${kind}/${endpoint}?${params.toString()}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return res.json(ok({ configured: true, provider, results: [], next: "" }));
    const j: any = await r.json().catch(() => null);
    const results = ((j && j.data) || []).map(mapGiphy).filter((x: any) => x.url);
    const pg = (j && j.pagination) || {};
    const nextOff = Number(pg.offset || offset) + Number(pg.count || results.length);
    const more = pg.total_count ? nextOff < Number(pg.total_count) : results.length >= 24;
    return res.json(ok({ configured: true, provider, results, next: more ? String(nextOff) : "" }));
  } catch (_) {
    return res.json(ok({ configured: true, provider, results: [], next: "" }));
  }
});

// ── Custom stickers / GIFs (WhatsApp-style personal tray) ────────────────────
const MAX_STICKER_BYTES = 16 * 1024 * 1024; // 16 MB — plenty for a still or short GIF
const stickerUploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, message: "Slow down a moment." });

// GET /api/media/stickers — the caller's own sticker tray (newest first).
router.get("/stickers", async (req, res) => {
  const rows = await db.stickers.listForUser(req.user.userId, 200);
  const stickers = (rows || []).map((s: any) => ({
    id: s.id,
    url: `/api/media/stickers/${s.id}/img`,
    mime: s.mime,
    name: s.name,
    kind: s.kind,
    width: s.width,
    height: s.height,
  }));
  res.json(ok({ stickers }));
});

// POST /api/media/stickers?name=&mime=&kind=  — raw image body (like file upload).
// Streams the bytes into object storage under a stickers/ key and records the tray
// row. Returns { id, url } — the client builds the absolute URL from its API base
// and sends it as an inline media message.
router.post("/stickers", stickerUploadLimiter, async (req, res) => {
  const mime = String(req.query.mime || req.headers["content-type"] || "image/png");
  // SECURITY: allowlist raster formats only. image/svg+xml is rejected because
  // SVG served inline on this origin executes arbitrary scripts (XSS vector).
  const STICKER_SAFE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
  if (!STICKER_SAFE_TYPES.includes(mime.toLowerCase().split(";")[0].trim()))
    return res.status(400).json(fail("BAD_TYPE", "Stickers must be a safe raster image (PNG/GIF/WebP/JPEG). SVG is not permitted."));
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && declared > MAX_STICKER_BYTES)
    return res.status(413).json(fail("TOO_LARGE", "Sticker is too large (16 MB max)."));
  const name = String(req.query.name || "sticker").slice(0, 120);
  const kind = String(req.query.kind || "sticker") === "gif" ? "gif" : "sticker";
  const width = Number(req.query.width) || null;
  const height = Number(req.query.height) || null;
  // Collect the raw body (bounded). express.json() ignores an image content-type,
  // so the request stream is intact here.
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const c of req as any) {
      total += (c as Buffer).length;
      if (total > MAX_STICKER_BYTES)
        return res.status(413).json(fail("TOO_LARGE", "Sticker is too large (16 MB max)."));
      chunks.push(c as Buffer);
    }
  } catch (_) {
    return res.status(400).json(fail("BAD_REQUEST", "Upload failed."));
  }
  const buf = Buffer.concat(chunks);
  if (!buf.length) return res.status(400).json(fail("BAD_REQUEST", "Empty sticker."));
  const id = randomUUID();
  const key = `stickers/${id}`;
  try {
    await storage.upload(key, buf, mime);
  } catch (_) {
    return res.status(502).json(fail("STORE_FAILED", "Couldn't save the sticker."));
  }
  await db.stickers.create({
    id,
    ownerId: req.user.userId,
    orgId: (req as any).org?.id || null,
    storageKey: key,
    mime,
    name,
    kind,
    width,
    height,
  });
  res.status(201).json(ok({ id, url: `/api/media/stickers/${id}/img`, mime, name, kind, width, height }));
});

// DELETE /api/media/stickers/:id — remove one of the caller's own stickers (tray only;
// already-sent messages keep rendering from the immutable public URL).
router.delete("/stickers/:id", async (req, res) => {
  const removed = await db.stickers.softDelete(String(req.params.id || ""), req.user.userId);
  res.json(ok({ removed }));
});

export default router;
