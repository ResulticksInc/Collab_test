import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok } from "../platform";
import authMiddleware from "../middleware/auth";
import { listBookmarks } from "../services/messageService";
router.use(authMiddleware);
router.get("/", async (req, res) =>
  res.json(ok(await listBookmarks(req.user.userId))),
);
export default router;
