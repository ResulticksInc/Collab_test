import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok } from "../platform";
import authMiddleware from "../middleware/auth";
import { search } from "../services/searchService";
router.use(authMiddleware);
router.get("/", async (req, res) =>
  res.json(
    ok(
      await search(
        req.user.userId,
        req.query.q || "",
        (req as any).org?.id || null,
      ),
    ),
  ),
);
export default router;
