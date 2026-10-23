import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok } from "../platform";
import authMiddleware from "../middleware/auth";
import { listForActor } from "../services/auditService";

router.use(authMiddleware);

// A person's own activity log (self-scoped).
router.get("/", async (req, res) =>
  res.json(ok(await listForActor(req.user.userId, 50))),
);

export default router;
