import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok } from "../platform";
import authMiddleware from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { getPreview } from "../services/linkPreviewService";

router.use(authMiddleware);

// Link unfurling makes an OUTBOUND fetch, so cap it per client.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: "Too many link previews. Please slow down.",
});

// GET /api/link-preview?url=<url> → { url, title, description, image, siteName } | null
router.get("/", limiter, async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  if (!url) return res.json(ok(null));
  res.json(ok(await getPreview(url)));
});

export default router;
