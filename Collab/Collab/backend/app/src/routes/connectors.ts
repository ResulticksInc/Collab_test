// Unified Connector Engine — HTTP surface.
//
// Two routers with OPPOSITE auth postures, so app.ts mounts the public one on
// the more specific prefix FIRST and an inbound platform webhook can never fall
// through into the authenticated router:
//
//   /api/connectors/in/:platform/:accountId   PUBLIC  — the platform's webhook
//        (verified cryptographically per platform; raw body preserved by app.ts)
//   /api/connectors/…                         AUTH    — accounts (org admins),
//        mappings (conversation members, chat-webhook rules), jobs, catalog
import { asyncRouter } from "../asyncRouter";
import { ok, fail, shared, db, config } from "../platform";
import authMiddleware from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { broadcast } from "../realtime/socket";
import { can, PERMISSIONS } from "../services/rbacService";
import * as connectors from "../services/connectorService";
import { handleInbound } from "../services/connectorIngestService";
import { ALL_PLATFORMS, PLATFORM_CATALOG } from "../services/connectors/types";

const { EVENTS } = shared;

// ── Inbound: /api/connectors/in/:platform/:accountId ────────────────────────
const inboundRouter = asyncRouter();
inboundRouter.use(
  rateLimit({
    windowMs: 60_000,
    max: Number(process.env.CONNECTORS_INBOUND_IP_RATE_MAX) || 600,
    message: "Too many connector events. Please slow down.",
  }),
);

function parseBody(raw: any, contentType: string): any {
  if (!raw || !raw.length) return {};
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    // Slack slash-commands / interactivity post form bodies with a `payload` field.
    const params = new URLSearchParams(text);
    const o: any = {};
    for (const [k, v] of params) o[k] = v;
    if (typeof o.payload === "string") {
      try {
        return JSON.parse(o.payload);
      } catch {
        return o;
      }
    }
    return o;
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function inbound(req: any, res: any) {
  const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : "", "utf8");
  const r = await handleInbound(String(req.params.platform), String(req.params.accountId), {
    headers: req.headers,
    query: req.query || {},
    rawBody: raw,
    body: parseBody(raw, String(req.headers["content-type"] || "")),
    method: req.method,
  });
  // Live fan-out for whatever landed: the conversation room plus every
  // member's user room (same shape as POST /conversations/:id/messages and the
  // chat-webhook ingest), so a bridged message appears instantly.
  const io = req.app.get("io");
  if (io && r.posted.length) {
    for (const p of r.posted) {
      let rooms: string[] = [broadcast.room(p.conversationId)];
      if (p.kind === "created") {
        try {
          const mems = await db.conversations.members(p.conversationId);
          rooms = rooms.concat((mems || []).map((m: any) => broadcast.userRoom(m.userId || m.id)).filter(Boolean));
        } catch (_) {
          /* room-only fan-out is still correct */
        }
        io.to(rooms).emit(EVENTS.MESSAGE_NEW, p.message);
      } else {
        io.to(rooms).emit(EVENTS.MESSAGE_UPDATED, p.message);
      }
    }
  }
  if (r.contentType) {
    res.status(r.status).type(r.contentType).send(typeof r.body === "string" ? r.body : String(r.body ?? ""));
    return;
  }
  res.status(r.status).json(r.body);
}
inboundRouter.post("/:platform/:accountId", inbound);
inboundRouter.get("/:platform/:accountId", inbound); // WhatsApp verification handshake

// ── Management: /api/connectors ─────────────────────────────────────────────
const router = asyncRouter();
router.use(authMiddleware);

const orgOf = (req: any): string | null => req.org?.id || null;

// Accounts hold platform credentials for the whole tenant, so they are an
// org-admin concern (org:manage). A deployment that never created an org has
// no RBAC catalog to consult; there the platform-level admin role decides.
async function requireAccountAdmin(req: any, res: any, next: any) {
  const userId = req.user?.userId;
  if (!userId) return res.status(401).json(fail("UNAUTHORIZED", "Missing user"));
  const orgId = orgOf(req);
  let allowed = false;
  try {
    if (orgId) allowed = await can(userId, orgId, PERMISSIONS.ORG_MANAGE);
    else {
      const u = await db.users.getById(userId);
      allowed = !!u && ["admin", "owner"].includes(String(u.role || ""));
    }
  } catch {
    allowed = false;
  }
  if (!allowed) return res.status(403).json(fail("FORBIDDEN", "Only an organization admin can manage connector accounts."));
  return next();
}

router.get("/platforms", (req: any, res: any) =>
  res.json(
    ok({
      enabled: config.connectors.enabled,
      events: connectors.EVENTS_SUPPORTED,
      platforms: ALL_PLATFORMS.map((p) => ({ platform: p, ...PLATFORM_CATALOG[p] })),
    }),
  ),
);

// ── Accounts ────────────────────────────────────────────────────────────────
router.get("/accounts", requireAccountAdmin, async (req: any, res: any) => res.json(ok(await connectors.listAccounts(orgOf(req)))));

// POST { platform, name?, credentials:{…}, settings?, externalWorkspaceId?, botIds? }
// Credentials are write-only: this is the only time they travel in plaintext.
router.post("/accounts", requireAccountAdmin, async (req: any, res: any) => {
  const { platform, name, credentials, settings, externalWorkspaceId, botIds } = req.body || {};
  const out = await connectors.createAccount({
    platform,
    name,
    credentials,
    settings,
    externalWorkspaceId,
    botIds,
    createdBy: req.user.userId,
    organizationId: orgOf(req),
  });
  res.status(201).json(ok(out));
});

router.get("/accounts/:id", requireAccountAdmin, async (req: any, res: any) => res.json(ok(await connectors.getAccount(req.params.id, orgOf(req)))));

router.patch("/accounts/:id", requireAccountAdmin, async (req: any, res: any) => {
  const { name, enabled, settings, externalWorkspaceId, botIds, credentials } = req.body || {};
  res.json(ok(await connectors.updateAccount(req.params.id, orgOf(req), { name, enabled, settings, externalWorkspaceId, botIds, credentials })));
});

router.delete("/accounts/:id", requireAccountAdmin, async (req: any, res: any) => res.json(ok(await connectors.removeAccount(req.params.id, orgOf(req)))));

// Live credential check against the platform (also learns bot ids / workspace id).
router.post("/accounts/:id/test", requireAccountAdmin, async (req: any, res: any) => res.json(ok(await connectors.testAccount(req.params.id, orgOf(req)))));

router.get("/accounts/:id/mappings", requireAccountAdmin, async (req: any, res: any) =>
  res.json(ok(await connectors.listMappingsForAccount(req.params.id, orgOf(req)))),
);

router.get("/accounts/:id/jobs", requireAccountAdmin, async (req: any, res: any) =>
  res.json(ok(await connectors.listJobs(req.params.id, orgOf(req), { status: req.query.status as string, limit: Number(req.query.limit) || 50 }))),
);

// Calendar accounts: pull the platform's delta now instead of at the next tick.
router.post("/accounts/:id/pull", requireAccountAdmin, async (req: any, res: any) =>
  res.json(ok({ queued: await connectors.enqueueCalendarPulls(req.params.id, orgOf(req)) })),
);

router.post("/jobs/:id/retry", requireAccountAdmin, async (req: any, res: any) => res.json(ok(await connectors.retryJob(req.params.id, orgOf(req)))));

// ── Mappings (conversation members; same rules as chat webhooks) ────────────
// GET /mappings                    → every mapping I own (that I can still see)
// GET /mappings?conversationId=…   → every mapping on that conversation
// GET /mappings?userId=…           → every mapping on my DM with that person
router.get("/mappings", async (req: any, res: any) => {
  const { conversationId, userId } = req.query || {};
  if (!conversationId && !userId) return res.json(ok(await connectors.listMappingsMine(req.user.userId)));
  let convId = conversationId as string;
  if (!convId && userId) {
    const dm = await db.conversations.findDmBetween(req.user.userId, String(userId));
    if (!dm) return res.status(404).json(fail("NOT_FOUND", "You don't have a direct message with that person yet."));
    convId = dm;
  }
  res.json(ok(await connectors.listMappingsForConversation(convId, req.user.userId)));
});

// POST { accountId, conversationId | userId, externalChannelId, externalChannelName?, externalMeta?, direction? }
router.post("/mappings", async (req: any, res: any) => {
  const { accountId, conversationId, userId, externalChannelId, externalChannelName, externalMeta, direction } = req.body || {};
  const out = await connectors.createMapping({
    ownerId: req.user.userId,
    organizationId: orgOf(req),
    accountId,
    conversationId,
    userId,
    externalChannelId,
    externalChannelName,
    externalMeta,
    direction,
  });
  res.status(201).json(ok(out));
});

router.patch("/mappings/:id", async (req: any, res: any) => {
  const { externalChannelName, externalMeta, direction, enabled } = req.body || {};
  const m = await connectors.updateMapping(req.params.id, req.user.userId, { externalChannelName, externalMeta, direction, enabled });
  if (!m) return res.status(404).json(fail("NOT_FOUND", "Mapping not found."));
  res.json(ok(m));
});

router.post("/mappings/:id/test", async (req: any, res: any) => res.json(ok(await connectors.testMapping(req.params.id, req.user.userId))));

router.delete("/mappings/:id", async (req: any, res: any) => res.json(ok(await connectors.removeMapping(req.params.id, req.user.userId))));

// ── Meetings: where did this meeting land on external calendars? ────────────
router.get("/meetings/:meetingId/mappings", async (req: any, res: any) =>
  res.json(ok(await connectors.listMeetingMappings(req.params.meetingId, req.user.userId))),
);

export { inboundRouter };
export default router;
