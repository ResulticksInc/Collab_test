import { asyncRouter } from "../asyncRouter";
import { ok, fail, shared } from "../platform";
import authMiddleware from "../middleware/auth";
import {
  listForUser,
  unreadCount,
  markRead,
  markAllRead,
  remove,
} from "../services/notificationService";
import { broadcast } from "../realtime/socket";

const { EVENTS } = shared;
const router = asyncRouter();
router.use(authMiddleware);

router.get("/", async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const beforeId = req.query.beforeId ? String(req.query.beforeId) : undefined;
  res.json(ok(await listForUser(req.user.userId, { limit, beforeId })));
});

router.get("/unread-count", async (req, res) => {
  res.json(ok({ count: await unreadCount(req.user.userId) }));
});

router.post("/:id/read", async (req, res) => {
  await markRead(req.user.userId, req.params.id);
  // Push read state + the authoritative unread count so every open session of
  // this user (other tabs/devices) updates the Activity badge live, not on reload.
  const io = req.app.get("io");
  if (io) {
    io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.NOTIFICATION_READ, {
      notificationId: req.params.id,
    });
    io.to(broadcast.userRoom(req.user.userId)).emit(
      EVENTS.NOTIFICATION_COUNT,
      await unreadCount(req.user.userId),
    );
  }
  res.json(ok({ id: req.params.id, read: true }));
});

router.post("/read-all", async (req, res) => {
  await markAllRead(req.user.userId);
  const io = req.app.get("io");
  if (io) {
    io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.NOTIFICATION_READ, { all: true });
    io.to(broadcast.userRoom(req.user.userId)).emit(EVENTS.NOTIFICATION_COUNT, 0);
  }
  res.json(ok({ readAll: true }));
});

router.delete("/:id", async (req, res) => {
  res.json(ok(await remove(req.user.userId, req.params.id)));
});

export default router;
