import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { db } from "../platform";

// Public (no-auth) avatar serving. Avatars are stored as compact data URLs on
// the user/conversation row; this streams them as image bytes so they render in
// <img> everywhere (no Bearer header possible) and are cacheable. Referenced by
// a small URL — the data URL itself is never embedded in API payloads.
// Allowed content-types for avatar/conversation images. Restricting to raster
// formats blocks the stored-XSS vector where a data:text/html URL would be
// served verbatim to the browser, enabling script execution on this origin.
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
]);

function serveAvatar(res, dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl) return res.status(404).end();
  // Legacy/non-data URLs (e.g. an external image): redirect to them.
  if (!dataUrl.startsWith("data:")) return res.redirect(302, dataUrl);
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return res.status(404).end();
  const mime = (m[1] || "").toLowerCase().split(";")[0].trim();
  // SECURITY: allowlist — reject anything that is not a safe raster image type
  // (e.g. data:text/html, data:image/svg+xml) to prevent stored XSS.
  if (!ALLOWED_IMAGE_TYPES.has(mime)) return res.status(404).end();
  const buf = Buffer.from(m[2], "base64");
  res.setHeader("Content-Type", mime);
  res.setHeader("Cache-Control", "public, max-age=604800"); // 7d; URL is versioned
  // Prevent MIME-sniffing and script execution even if type is somehow unexpected.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox");
  return res.end(buf);
}

router.get("/users/:id/avatar", async (req, res) => {
  const u = await db.users.getById(req.params.id);
  return serveAvatar(res, u && u.avatarUrl);
});

router.get("/conversations/:id/avatar", async (req, res) => {
  const c = await db.conversations.getById(req.params.id);
  return serveAvatar(res, c && c.avatarUrl);
});

export default router;
