import { asyncRouter } from "../asyncRouter";
import { ok, fail, db } from "../platform";
import authMiddleware from "../middleware/auth";
import { randomUUID } from "crypto";

const router = asyncRouter();
router.use(authMiddleware);

// Audit log for the Remote Control feature — records every control session so a
// security review can answer "who controlled whom, and when". The actor is taken
// from the authenticated token (req.user.userId), NEVER from the request body, so
// it cannot be spoofed. Writes go straight to the shared pool with parameterized
// SQL (same convention the driver/tests use via db.pool.query).
router.post("/log", async (req, res) => {
  const { action, peer, session } = req.body || {};
  if (typeof action !== "string" || !action.trim())
    return res.status(400).json(fail("BAD_REQUEST", "action is required."));
  await db.pool.query(
    `INSERT INTO remote_control_log (id, user_id, action, peer_sid, session_id)
     VALUES (?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      req.user.userId,
      action.trim(),
      typeof peer === "string" ? peer : "",
      typeof session === "string" && session ? session : null,
    ],
  );
  res.json(ok({ ok: true }));
});

export default router;
