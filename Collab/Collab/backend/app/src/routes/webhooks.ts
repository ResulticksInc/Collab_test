// Chat webhooks — management API (authenticated) + the incoming ingest endpoint
// (deliberately unauthenticated; the token in the URL is the credential).
//
// Two routers are exported because they have OPPOSITE auth postures, and
// app.ts mounts the public one on a more specific path FIRST so Express never
// lets an ingest request fall into the authenticated router.
import { asyncRouter } from "../asyncRouter";
import { ok, fail, shared, db, config } from "../platform";
import authMiddleware from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { broadcast } from "../realtime/socket";
import { send as sendMessage } from "../services/messageService";
import * as webhooks from "../services/webhookService";

const { EVENTS } = shared;

// ── Incoming ingest: POST /api/webhooks/in/:token ───────────────────────────
// No auth middleware, by design. Defence is: an unguessable 24-byte token
// (stored only as a hash), the owner's live conversation membership re-checked
// on every post, a per-webhook per-minute budget in the service, and this
// per-IP limiter on top.
const ingestRouter = asyncRouter();
ingestRouter.use(
  rateLimit({
    windowMs: 60_000,
    max: Number(process.env.WEBHOOKS_INGEST_IP_RATE_MAX) || 120,
    message: "Too many webhook posts. Please slow down.",
  }),
);

ingestRouter.post("/:token", async (req: any, res: any) => {
  const { webhook, text } = await webhooks.resolveIngest(
    req.params.token,
    req.body,
  );
  const msg = await sendMessage({
    conversationId: webhook.conversationId,
    senderId: webhook.ownerId,
    text,
    file: null,
    // Loop guard: this message must not be re-emitted to the conversation's
    // OUTGOING webhooks. See webhookService.dispatch.
    viaWebhookId: webhook.id,
  } as any);
  await webhooks.noteIngest(webhook.id);
  // Same fan-out as POST /conversations/:id/messages — the conversation room
  // plus every member's user room, so the message appears live for people whose
  // room join hasn't settled (and for a DM neither party currently has open).
  const io = req.app.get("io");
  if (io) {
    let rooms: string[] = [broadcast.room(webhook.conversationId)];
    try {
      const mems = await db.conversations.members(webhook.conversationId);
      rooms = rooms.concat(
        (mems || [])
          .map((m: any) => broadcast.userRoom(m.userId || m.id))
          .filter(Boolean),
      );
    } catch (_) {
      /* room-only fan-out is still correct, just less forgiving of a slow join */
    }
    io.to(rooms).emit(EVENTS.MESSAGE_NEW, msg);
  }
  res.json(
    ok({
      posted: true,
      messageId: msg.id,
      conversationId: webhook.conversationId,
    }),
  );
});

// ── Management: /api/webhooks ───────────────────────────────────────────────
const router = asyncRouter();
router.use(authMiddleware);

// GET /api/webhooks                      → every webhook I own (that I can still see)
// GET /api/webhooks?conversationId=…     → every webhook on that conversation
// GET /api/webhooks?userId=…             → every webhook on my DM with that person
router.get("/", async (req: any, res: any) => {
  const { conversationId, userId } = req.query || {};
  if (!conversationId && !userId)
    return res.json(ok(await webhooks.listMine(req.user.userId)));
  const scope = await webhooks.resolveScope(req.user.userId, {
    conversationId: conversationId as string,
    userId: userId as string,
  });
  res.json(ok(await webhooks.listForConversation(scope.id, req.user.userId)));
});

// Supported event names, so a client can build the subscription UI without
// hard-coding a list that drifts from the server's.
router.get("/events", (req: any, res: any) =>
  res.json(
    ok({ events: webhooks.EVENTS_SUPPORTED, enabled: config.webhooks.enabled }),
  ),
);

// POST /api/webhooks
//   { direction:"in"|"out", conversationId | userId, name?, targetUrl?, events? }
// The response is the ONLY time the credential exists in plaintext.
router.post("/", async (req: any, res: any) => {
  const { direction, conversationId, userId, name, targetUrl, events } =
    req.body || {};
  const out = await webhooks.create({
    ownerId: req.user.userId,
    direction,
    conversationId,
    userId,
    name,
    targetUrl,
    events,
  });
  res.status(201).json(ok(out));
});

router.patch("/:id", async (req: any, res: any) => {
  const { name, enabled, events } = req.body || {};
  const w = await webhooks.update(req.params.id, req.user.userId, {
    name,
    enabled,
    events,
  });
  if (!w) return res.status(404).json(fail("NOT_FOUND", "Webhook not found."));
  res.json(ok(w));
});

// Re-key in place. The previous token/secret stops working immediately.
router.post("/:id/rotate", async (req: any, res: any) =>
  res.json(ok(await webhooks.rotate(req.params.id, req.user.userId))),
);

// Queue a synthetic delivery so the consumer can verify their endpoint and
// their signature check before real traffic depends on it.
router.post("/:id/test", async (req: any, res: any) =>
  res.json(ok(await webhooks.test(req.params.id, req.user.userId))),
);

router.get("/:id/deliveries", async (req: any, res: any) =>
  res.json(
    ok(
      await webhooks.deliveries(
        req.params.id,
        req.user.userId,
        Number(req.query.limit) || 25,
      ),
    ),
  ),
);

router.delete("/:id", async (req: any, res: any) =>
  res.json(ok(await webhooks.remove(req.params.id, req.user.userId))),
);

export { ingestRouter };
export default router;
