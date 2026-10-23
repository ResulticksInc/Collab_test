import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { shared, ok, db } from "../platform";
import authMiddleware from "../middleware/auth";
import { get, update } from "../services/settingsService";
import { pubUser } from "../serialize";
const { EVENTS } = shared;

router.use(authMiddleware);
router.get("/", async (req, res) => res.json(ok(await get(req.user.userId))));
router.put("/", async (req, res) => {
  const result = await update(req.user.userId, req.body || {});
  // Mirror the manual status (Active/Away/DND) onto the user row and broadcast
  // USER_UPDATED so everyone's view of this person's presence dot updates live.
  // (Kept here, not in settingsService, because `io` is only available on req.)
  if (
    Object.prototype.hasOwnProperty.call(req.body || {}, "manualPresence") &&
    db.users.setManualPresence
  ) {
    try {
      const u = await db.users.setManualPresence(req.user.userId, req.body.manualPresence);
      const io = req.app.get("io");
      if (io && u) io.emit(EVENTS.USER_UPDATED, pubUser(u));
    } catch (_) {}
  }
  res.json(ok(result));
});
export default router;
