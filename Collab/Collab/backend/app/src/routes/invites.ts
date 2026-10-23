import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, shared } from "../platform";
import authMiddleware from "../middleware/auth";
import {
  send,
  accept,
  decline,
  block,
  cancel,
  listForUser,
  serialize,
} from "../services/inviteService";
import { sendToUser, isReady as pushReady } from "../services/webPushService";

const { EVENTS } = shared;
const userRoom = (uid) => `user:${uid}`;

router.use(authMiddleware);

router.get("/", async (req, res) =>
  res.json(ok(await listForUser(req.user.userId))),
);

// Send a connection invite. Recipient is notified in realtime; NO membership yet.
router.post("/", async (req, res) => {
  const { invite, conversationId } = await send({
    fromUserId: req.user.userId,
    toUserId: (req.body || {}).toUserId,
  });
  const io = req.app.get("io");
  // Emit the recipient's serialized view so the realtime toast can name the
  // sender (the raw DB row has no from/to/direction).
  const view = await serialize(invite, invite.toUserId);
  if (io) {
    io.to(userRoom(invite.toUserId)).emit(EVENTS.INVITE_NEW, { invite: view });
    // Teams-model: the pending DM was created at Connect time. Join the SENDER's
    // live sockets to its room and tell them about it so their composer opens
    // immediately and their first text isn't missed. The recipient stays a HIDDEN
    // member — NO join / NO CONVERSATION_NEW — keeping the incoming-request UX
    // until they accept (accept's route then joins + notifies both).
    if (conversationId) {
      io.in(userRoom(invite.fromUserId)).socketsJoin(`conv:${conversationId}`);
      io.to(userRoom(invite.fromUserId)).emit(EVENTS.CONVERSATION_NEW, {
        conversationId,
      });
    }
  }
  // Web push so the request lands with Accept/Decline actions even when the
  // recipient has no CoLab tab open. Tag matches the client INVITE_NEW path
  // (colab-invite-<id>) so an open tab dedups instead of double-notifying.
  if (pushReady()) {
    const fromName = (view && view.from && view.from.name) || "Someone";
    sendToUser(invite.toUserId, {
      title: `${fromName} sent you a connection request`,
      body: "Open Collab to accept or decline.",
      tag: `colab-invite-${invite.id}`,
      type: "invite",
      targetId: invite.id,
    }).catch(() => { });
  }
  // Return the pending DM's id so the client can navigate the sender into it
  // (invite.conversationId itself stays null until accept links it).
  res.status(201).json(ok({ ...invite, conversationId }));
});

router.post("/:id/accept", async (req, res) => {
  const result = await accept({
    inviteId: req.params.id,
    userId: req.user.userId,
  });
  const io = req.app.get("io");
  // The acceptance is already durably committed above. The realtime fan-out below
  // is BEST-EFFORT presentation — a failure in it (e.g. serialize hitting an odd
  // row) must never turn a successful accept into a 500 that leaves the client
  // stuck retrying. Both clients reconcile on their next fetch/reconnect anyway.
  if (io) {
    try {
      // Both parties learn the invite resolved (serialized per-viewer so each
      // side's direction/from/to is correct).
      await Promise.all(
        [result.fromUserId, result.toUserId].map(async (uid) =>
          io
            .to(userRoom(uid))
            .emit(EVENTS.INVITE_UPDATED, { invite: await serialize(result.invite, uid) }),
        ),
      );
      // ...and both gain access to the freshly created DM. Join their connected
      // sockets to the DM's room server-side FIRST — the connect-time join-all
      // predates this conversation, and waiting for the client to react to
      // CONVERSATION_NEW leaves a window where the very first message beats the
      // join and is missed (stale "No messages yet" until the second message).
      [result.fromUserId, result.toUserId].forEach((uid) => {
        io.in(userRoom(uid)).socketsJoin(`conv:${result.conversationId}`);
        io.to(userRoom(uid)).emit(EVENTS.CONVERSATION_NEW, {
          conversationId: result.conversationId,
        });
      });
    } catch (e) {
      console.error("[invites] accept realtime fan-out failed (accept committed)", e);
    }
  }
  res.json(ok(result.invite));
});

function resolver(fn) {
  return async (req, res) => {
    const result = await fn({
      inviteId: req.params.id,
      userId: req.user.userId,
    });
    const io = req.app.get("io");
    if (io)
      await Promise.all(
        [result.fromUserId, result.toUserId].map(async (uid) =>
          io
            .to(userRoom(uid))
            .emit(EVENTS.INVITE_UPDATED, { invite: await serialize(result.invite, uid) }),
        ),
      );
    res.json(ok(result.invite));
  };
}
router.post("/:id/decline", resolver(decline));
router.post("/:id/block", resolver(block));
// Sender withdraws their own pending request. resolver() emits INVITE_UPDATED to
// BOTH parties, so the recipient's pending request disappears (Request tab /
// dashboard / Contacts) and the sender's "Requested" reverts to "Connect".
router.post("/:id/cancel", resolver(cancel));

export default router;
