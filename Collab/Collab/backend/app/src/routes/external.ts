// External Data API — GET /api/external/v1/*
//
// Read-only access to CoLab's MySQL data for OTHER platforms (CRM, BI,
// reporting, partner systems), authenticated with an API key rather than a
// person's session. See docs/EXTERNAL_DATA_API.html for the integrator guide.
//
// Posture:
//   • every route is GET and every reader is tenant-scoped from the KEY;
//   • scopes are checked per route (requireScope);
//   • a per-key throttle sits on top of the global API limiter;
//   • /openapi.json and /health are public so a client can discover the API.
import { asyncRouter } from "../asyncRouter";
import { ok, fail, config } from "../platform";
import apiKeyAuth, { requireScope, presentedKey } from "../middleware/apiKeyAuth";
import { rateLimit, clientIp } from "../middleware/rateLimit";
import * as svc from "../services/externalApiService";
import { createHash } from "crypto";
import { db, shared, orgContext } from "../platform";
import { send as sendMessage, sanitizeClientType } from "../services/messageService";
import { create as createConversation } from "../services/conversationService";
import * as webhooks from "../services/webhookService";
import * as callService from "../services/callService";
import { roomToken } from "../services/livekitService";
import { create as createMeeting, enterRoom as meetingEnterRoom } from "../services/meetingService";
import * as meetingPolicy from "../services/meetingPolicy";
import { broadcast, requestDirectCall, hangupDirectCall, acceptDirectCall, declineDirectCall, pushPreview } from "../realtime/socket";
import { publicWsUrl } from "./calls";
import { postMeetingInvites, postInviteCardTo } from "./meetings";
import { sendToUsers, isReady as pushReady } from "../services/webPushService";
import { suppressWebPush } from "../realtime/notify";
import { userAvatarUrl } from "../serialize";

const { EVENTS } = shared;

const router = asyncRouter();
const p = config.constants.api.prefix;
const BASE = `${p}/external/v1`;

// ── Public discovery ────────────────────────────────────────────────────────
router.get("/health", (_req: any, res: any) =>
  res.json(ok({ service: "colab-external-api", version: "v1", enabled: !!config.externalApi.enabled })),
);
router.get("/openapi.json", (_req: any, res: any) => res.json(openapi()));

// ── Auth + per-key throttle for everything below ────────────────────────────
router.use(
  rateLimit({
    windowMs: 60_000,
    max: Number(config.externalApi.rateMax) || 300,
    message: "API key rate limit exceeded. Slow down and retry after the Retry-After seconds.",
    key: (req: any) => {
      const k = presentedKey(req);
      return k ? "k:" + createHash("sha256").update(k).digest("hex").slice(0, 32) : "ip:" + clientIp(req);
    },
  }),
);
router.use(apiKeyAuth);
// Run the rest of the request inside the key's tenant context, exactly as a
// signed-in session does (middleware/auth.ts): every repository write — a DM
// opened for a message, a meeting, a webhook row — is then stamped with the
// organization, so the same key can read it back. A platform key with no
// X-Org-Id writes tenant-less rows (visible to platform keys only).
router.use((req: any, _res: any, next: any) => orgContext.run({ orgId: req.tenant.orgId }, () => next()));

// ── Identity ────────────────────────────────────────────────────────────────
router.get("/ping", async (req: any, res: any) => {
  const org = await svc.orgSummary(req.tenant.orgId);
  res.json(
    ok({
      keyId: req.apiKey.id,
      keyName: req.apiKey.name,
      platform: req.apiKey.platform,
      organization: org,
      scopes: req.apiKey.scopes,
      serverTime: new Date().toISOString(),
    }),
  );
});

// ── Users ───────────────────────────────────────────────────────────────────
router.get("/users", requireScope("users:read"), async (req: any, res: any) => {
  const r = await svc.listUsers(req.tenant, req.query);
  res.json(ok(r.items, r.meta));
});
router.get("/users/:id", requireScope("users:read"), async (req: any, res: any) =>
  res.json(ok(await svc.getUser(req.tenant, req.params.id))),
);

// ── Conversations + messages ────────────────────────────────────────────────
router.get("/conversations", requireScope("conversations:read"), async (req: any, res: any) => {
  const r = await svc.listConversations(req.tenant, req.query);
  res.json(ok(r.items, r.meta));
});
router.get("/conversations/:id", requireScope("conversations:read"), async (req: any, res: any) =>
  res.json(ok(await svc.getConversation(req.tenant, req.params.id))),
);
router.get("/conversations/:id/members", requireScope("conversations:read"), async (req: any, res: any) =>
  res.json(ok(await svc.listConversationMembers(req.tenant, req.params.id))),
);
router.get("/conversations/:id/messages", requireScope("messages:read"), async (req: any, res: any) => {
  const r = await svc.listMessages(req.tenant, req.query, req.params.id);
  res.json(ok(r.items, r.meta));
});
// Organization-wide message stream (for sync jobs): ?since=…&order=asc
router.get("/messages", requireScope("messages:read"), async (req: any, res: any) => {
  const r = await svc.listMessages(req.tenant, req.query);
  res.json(ok(r.items, r.meta));
});

// ── Meetings ────────────────────────────────────────────────────────────────
router.get("/meetings", requireScope("meetings:read"), async (req: any, res: any) => {
  const r = await svc.listMeetings(req.tenant, req.query);
  res.json(ok(r.items, r.meta));
});
router.get("/meetings/:id", requireScope("meetings:read"), async (req: any, res: any) =>
  res.json(ok(await svc.getMeeting(req.tenant, req.params.id))),
);

// ── Tasks ───────────────────────────────────────────────────────────────────
router.get("/tasks", requireScope("tasks:read"), async (req: any, res: any) => {
  const r = await svc.listTasks(req.tenant, req.query);
  res.json(ok(r.items, r.meta));
});
router.get("/tasks/:id", requireScope("tasks:read"), async (req: any, res: any) =>
  res.json(ok(await svc.getTask(req.tenant, req.params.id))),
);

// ── Files (metadata) ────────────────────────────────────────────────────────
router.get("/files", requireScope("files:read"), async (req: any, res: any) => {
  const r = await svc.listFiles(req.tenant, req.query);
  res.json(ok(r.items, r.meta));
});
router.get("/files/:id", requireScope("files:read"), async (req: any, res: any) =>
  res.json(ok(await svc.getFile(req.tenant, req.params.id))),
);

// ── Generic allow-listed tables ─────────────────────────────────────────────
router.get("/tables", requireScope("tables:read"), (req: any, res: any) => res.json(ok(svc.listTables(req.tenant))));
router.get("/tables/:name", requireScope("tables:read"), async (req: any, res: any) => {
  const r = await svc.queryTable(req.tenant, req.params.name, req.query);
  res.json(ok(r.items, { ...r.meta, table: r.table, columns: r.columns }));
});

// ═══════════════════════════════════════════════════════════════════════════
// WRITE SIDE — every route below acts AS a user (the key's actor, or
// asUserId / asUserEmail in the body), through the same services the app
// itself uses, so realtime fan-out, push, notifications, outgoing webhooks and
// connector bridges all fire exactly as for an in-app action.
// ═══════════════════════════════════════════════════════════════════════════

// Fan a freshly-sent message out the way POST /conversations/:id/messages does:
// the conversation room + every member's user room over Socket.IO, and a
// closed-tab web/mobile push to every non-muted member (quiet-hours gated).
async function fanOutMessage(req: any, msg: any, conversationId: string, senderId: string, text: string) {
  const io = req.app.get("io");
  let mems: any[] = [];
  try {
    mems = (await db.conversations.members(conversationId)) || [];
  } catch (_) {}
  const memberIds = mems.map((m: any) => m.userId || m.id).filter(Boolean);
  if (io) io.to([broadcast.room(conversationId), ...memberIds.map((id: string) => broadcast.userRoom(id))]).emit(EVENTS.MESSAGE_NEW, msg);
  if (pushReady()) {
    void (async () => {
      try {
        const targets = mems.filter((m: any) => (m.userId || m.id) !== senderId && !m.muted).map((m: any) => m.userId || m.id);
        const allowed = (await Promise.all(targets.map(async (t: string) => ((await suppressWebPush(t)) ? null : t)))).filter(Boolean) as string[];
        if (!allowed.length) return;
        let conv: any = null;
        try {
          conv = await db.conversations.getById(conversationId);
        } catch (_) {}
        const senderName = (msg.sender && msg.sender.name) || "New message";
        await sendToUsers(allowed, {
          title: senderName,
          body: pushPreview({ text, type: msg.type }),
          tag: `colab-msg-${msg.id}`,
          type: "message",
          conversationId,
          targetType: "message",
          targetId: msg.id,
          messageId: msg.id,
          senderId,
          senderName,
          senderAvatar: (msg.sender && msg.sender.avatarUrl) || undefined,
          conversationKind: conv?.kind || undefined,
          conversationTitle: conv?.title || undefined,
        });
      } catch (_) {}
    })();
  }
}

// Find-or-create the DM between the actor and a peer. conversationService.create
// is the app's own path (one DM per pair, race-proof on dm_key).
async function dmWith(actorId: string, peerId: string): Promise<string> {
  if (peerId === actorId) throw new svc.ApiError(400, "BAD_REQUEST", "Cannot message / call yourself");
  const r: any = await createConversation({ kind: shared.CONVERSATION.DM, memberIds: [actorId, peerId], creatorId: actorId });
  const id = r && r.conversation && r.conversation.id;
  if (!id) throw new svc.ApiError(500, "INTERNAL", "Could not open a direct message");
  return id;
}

// Shared body → send. `target` is a conversation id already checked for scope.
async function postMessage(req: any, res: any, conversationId: string) {
  const body = req.body || {};
  const actor = await svc.resolveActor(req.apiKey, req.tenant, body);
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim() && !body.file) throw new svc.ApiError(400, "BAD_REQUEST", "text is required");
  if (text.length > 20_000) throw new svc.ApiError(400, "BAD_REQUEST", "text must be at most 20000 characters");
  const type = sanitizeClientType(body.type);
  const msg = await sendMessage({
    conversationId,
    senderId: actor.id,
    text,
    file: body.file && typeof body.file === "object" ? body.file : null,
    type,
    parentMessageId: body.parentMessageId ? String(body.parentMessageId) : null,
    important: !!body.important,
  } as any);
  await fanOutMessage(req, msg, conversationId, actor.id, text);
  res.status(201).json(ok({ posted: true, messageId: msg.id, conversationId, senderId: actor.id, message: msg }));
}

// ── Send a message ──────────────────────────────────────────────────────────
// POST /conversations/:id/messages  { text, parentMessageId?, important?, asUserId?/asUserEmail? }
router.post("/conversations/:id/messages", requireScope("messages:write"), async (req: any, res: any) => {
  await svc.assertConversationInScope(req.tenant, req.params.id);
  await postMessage(req, res, req.params.id);
});
// POST /messages  { conversationId | userId | email, text, ... } — a person
// target opens (or reuses) the actor's DM with them.
router.post("/messages", requireScope("messages:write"), async (req: any, res: any) => {
  const body = req.body || {};
  let conversationId: string | null = body.conversationId ? String(body.conversationId) : null;
  if (conversationId) await svc.assertConversationInScope(req.tenant, conversationId);
  else {
    const peerId = await svc.resolvePeer(req.tenant, body);
    if (!peerId) throw new svc.ApiError(400, "BAD_REQUEST", "Provide conversationId, userId or email");
    const actor = await svc.resolveActor(req.apiKey, req.tenant, body);
    await svc.assertActorAllowed(req.tenant, peerId); // peer must be in the same tenant
    conversationId = await dmWith(actor.id, peerId);
  }
  await postMessage(req, res, conversationId);
});

// ── Receive messages: outgoing webhook subscriptions ────────────────────────
// A subscription POSTs every matching event (message.created / updated /
// deleted) in one conversation — or the actor's DM with one person — to your
// URL, HMAC-signed with the secret returned once here. Delivery, retries and
// signature verification: docs/CHAT_WEBHOOKS.html.
router.get("/webhooks", requireScope("webhooks:write"), async (req: any, res: any) => {
  const actor = await svc.resolveActor(req.apiKey, req.tenant, req.query);
  const all = await webhooks.listMine(actor.id);
  res.json(ok(all.filter((w: any) => w.direction === "out")));
});
router.post("/webhooks", requireScope("webhooks:write"), async (req: any, res: any) => {
  const body = req.body || {};
  const actor = await svc.resolveActor(req.apiKey, req.tenant, body);
  let conversationId: string | undefined = body.conversationId ? String(body.conversationId) : undefined;
  if (conversationId) await svc.assertConversationInScope(req.tenant, conversationId);
  let userId: string | undefined;
  if (!conversationId) {
    const peerId = await svc.resolvePeer(req.tenant, body);
    if (!peerId) throw new svc.ApiError(400, "BAD_REQUEST", "Provide conversationId, userId or email");
    await svc.assertActorAllowed(req.tenant, peerId);
    conversationId = await dmWith(actor.id, peerId);
    userId = undefined;
  }
  if (!body.targetUrl) throw new svc.ApiError(400, "BAD_REQUEST", "targetUrl is required");
  const out = await webhooks.create({
    ownerId: actor.id,
    direction: "out",
    name: body.name,
    conversationId,
    userId,
    targetUrl: String(body.targetUrl),
    events: body.events,
  });
  res.status(201).json(ok(out));
});
router.post("/webhooks/:id/test", requireScope("webhooks:write"), async (req: any, res: any) => {
  const actor = await svc.resolveActor(req.apiKey, req.tenant, req.body);
  res.json(ok(await webhooks.test(req.params.id, actor.id)));
});
router.get("/webhooks/:id/deliveries", requireScope("webhooks:write"), async (req: any, res: any) => {
  const actor = await svc.resolveActor(req.apiKey, req.tenant, req.query);
  res.json(ok(await webhooks.deliveries(req.params.id, actor.id, Math.min(Number(req.query.limit) || 25, 100))));
});
router.delete("/webhooks/:id", requireScope("webhooks:write"), async (req: any, res: any) => {
  const actor = await svc.resolveActor(req.apiKey, req.tenant, req.body);
  await webhooks.remove(req.params.id, actor.id);
  res.json(ok({ deleted: true }));
});

// ── Calls ───────────────────────────────────────────────────────────────────
// Media runs on LiveKit; CoLab's own clients connect with the SAME kind of
// token this returns, so an external platform can join a call with the LiveKit
// client SDK (wsUrl + token). Ringing / accept / decline / hangup are the app's
// real signalling: the callee's CoLab app rings exactly as for an in-app call.
const callShape = (c: any) => ({
  id: c.id,
  kind: c.kind,
  status: c.status,
  initiatorId: c.initiatorId,
  peerId: c.peerId,
  conversationId: c.conversationId || null,
  durationSec: Number(c.durationSec) || 0,
  startedAt: c.startedAt || null,
  room: "call_" + c.id,
});
async function callInScope(req: any, callId: string) {
  const call = await callService.getById(String(callId));
  if (!call) throw new svc.ApiError(404, "NOT_FOUND", "Call not found");
  if (req.tenant.orgId) {
    // Both parties must belong to the key's organization.
    for (const uid of [call.initiatorId, call.peerId].filter(Boolean)) {
      try {
        await svc.assertActorAllowed(req.tenant, uid);
      } catch {
        throw new svc.ApiError(404, "NOT_FOUND", "Call not found");
      }
    }
  }
  return call;
}
async function joinToken(req: any, userId: string, room: string, role = "participant", grant: any = {}) {
  const u = await db.users.getById(userId).catch(() => null);
  return roomToken({ userId, name: (u && u.name) || userId, avatarUrl: userAvatarUrl(u), room, role, wsUrl: publicWsUrl(req), ...grant });
}
// POST /calls  { userId | email | peerId, kind?: audio|video, conversationId?, asUserId?/asUserEmail? }
router.post("/calls", requireScope("calls:write"), async (req: any, res: any) => {
  const body = req.body || {};
  const actor = await svc.resolveActor(req.apiKey, req.tenant, body);
  const peerId = body.peerId ? String(body.peerId) : await svc.resolvePeer(req.tenant, body);
  if (!peerId) throw new svc.ApiError(400, "BAD_REQUEST", "Provide the person to call: userId, email or peerId");
  await svc.assertActorAllowed(req.tenant, peerId);
  const kind = body.kind === "video" ? "video" : "audio";
  let conversationId: string | null = body.conversationId ? String(body.conversationId) : null;
  if (conversationId) await svc.assertConversationInScope(req.tenant, conversationId);
  // A 1:1 call requires an existing DM between the two people — open one so a
  // first-contact call from another platform just works.
  else await dmWith(actor.id, peerId);
  const call = await requestDirectCall(req.app.get("io"), { initiatorId: actor.id, peerId, kind, conversationId });
  const out: any = { call: callShape(call), ringing: call.status === "ringing" };
  if (call.status === "ringing") out.join = await joinToken(req, actor.id, "call_" + call.id, "host");
  res.status(call.status === "busy" ? 409 : 201).json(call.status === "busy" ? fail("BUSY", "That person is on another call", out) : ok(out));
});
router.get("/calls", requireScope("calls:write"), async (req: any, res: any) => {
  // Call history is per person: list the actor's (or asUserId's) recent calls.
  const actor = await svc.resolveActor(req.apiKey, req.tenant, req.query);
  res.json(ok(await callService.history(actor.id, { limit: Math.min(Number(req.query.limit) || 50, 200) })));
});
router.get("/calls/:id", requireScope("calls:write"), async (req: any, res: any) => {
  res.json(ok(callShape(await callInScope(req, req.params.id))));
});
router.post("/calls/:id/accept", requireScope("calls:write"), async (req: any, res: any) => {
  const call = await callInScope(req, req.params.id);
  const actor = await svc.resolveActor(req.apiKey, req.tenant, { ...(req.body || {}), asUserId: (req.body || {}).asUserId || call.peerId });
  const accepted = await acceptDirectCall(req.app.get("io"), { callId: call.id, userId: actor.id });
  res.json(ok({ call: callShape(accepted), join: await joinToken(req, actor.id, "call_" + call.id) }));
});
router.post("/calls/:id/decline", requireScope("calls:write"), async (req: any, res: any) => {
  const call = await callInScope(req, req.params.id);
  const actor = await svc.resolveActor(req.apiKey, req.tenant, { ...(req.body || {}), asUserId: (req.body || {}).asUserId || call.peerId });
  const declined = await declineDirectCall(req.app.get("io"), { callId: call.id, userId: actor.id, reason: (req.body || {}).reason });
  res.json(ok({ call: callShape(declined) }));
});
router.post("/calls/:id/hangup", requireScope("calls:write"), async (req: any, res: any) => {
  const call = await callInScope(req, req.params.id);
  const actor = await svc.resolveActor(req.apiKey, req.tenant, { ...(req.body || {}), asUserId: (req.body || {}).asUserId || call.initiatorId });
  const ended = await hangupDirectCall(req.app.get("io"), { callId: call.id, userId: actor.id, durationSec: Number((req.body || {}).durationSec) || 0 });
  res.json(ok({ call: callShape(ended) }));
});
// Re-mint a join token for either party of a live call (e.g. the external
// platform's own media client reconnecting).
router.post("/calls/:id/token", requireScope("calls:write"), async (req: any, res: any) => {
  const call = await callInScope(req, req.params.id);
  const actor = await svc.resolveActor(req.apiKey, req.tenant, req.body);
  if (actor.id !== call.initiatorId && actor.id !== call.peerId) throw new svc.ApiError(403, "FORBIDDEN", "Not a participant in this call");
  if (["ended", "declined", "cancelled", "missed", "failed", "busy"].includes(String(call.status)))
    throw new svc.ApiError(403, "CALL_ENDED", "This call has ended");
  res.json(ok({ call: callShape(call), join: await joinToken(req, actor.id, "call_" + call.id, actor.id === call.initiatorId ? "host" : "participant") }));
});
// Group call room of a conversation (the app's huddle room, conv_<id>).
router.post("/conversations/:id/call-token", requireScope("calls:write"), async (req: any, res: any) => {
  await svc.assertConversationInScope(req.tenant, req.params.id);
  const actor = await svc.resolveActor(req.apiKey, req.tenant, req.body);
  if (!(await db.conversations.isMember(req.params.id, actor.id)))
    throw new svc.ApiError(403, "FORBIDDEN", "The actor is not a member of this conversation");
  res.json(ok({ room: "conv_" + req.params.id, join: await joinToken(req, actor.id, "conv_" + req.params.id) }));
});

// ── Meetings ────────────────────────────────────────────────────────────────
// POST /meetings { title, startsAt, durationMin?, attendees: [userId|email…], conversationId?, description?, location?, asUserId? }
router.post("/meetings", requireScope("meetings:write"), async (req: any, res: any) => {
  const body = req.body || {};
  const actor = await svc.resolveActor(req.apiKey, req.tenant, body);
  const raw: any[] = Array.isArray(body.attendees) ? body.attendees : [];
  const attendees: string[] = [];
  for (const a of raw) {
    const v = String(a || "").trim();
    if (!v) continue;
    const id = v.includes("@") ? await svc.userIdByEmail(req.tenant, v) : v;
    await svc.assertActorAllowed(req.tenant, id);
    if (id !== actor.id && !attendees.includes(id)) attendees.push(id);
  }
  if (!attendees.length) throw new svc.ApiError(400, "BAD_REQUEST", "attendees must name at least one other person (user id or email)");
  if (body.conversationId) await svc.assertConversationInScope(req.tenant, String(body.conversationId));
  let timezone = typeof body.timeZone === "string" && body.timeZone ? body.timeZone : null;
  if (!timezone) {
    const u = await db.users.getById(actor.id).catch(() => null);
    if (u && (u as any).timezone) timezone = (u as any).timezone;
  }
  const mt: any = await createMeeting({
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "Meeting",
    startsAt: body.startsAt,
    durationMin: body.durationMin,
    attendees,
    conversationId: body.conversationId ? String(body.conversationId) : undefined,
    recurrence: body.recurrence || "none",
    recurrenceRule: body.recurrenceRule || null,
    reminderLeadMin: body.reminderLeadMin ?? null,
    timezone,
    description: typeof body.description === "string" ? body.description.slice(0, 8000) : null,
    location: typeof body.location === "string" ? body.location.slice(0, 255) : null,
    creatorId: actor.id,
  });
  const io = req.app.get("io");
  if (io) {
    for (const a of attendees) io.to(broadcast.userRoom(a)).emit(EVENTS.MEETING_NEW, { meetingId: mt.id });
    const grp = mt.meetingGroup;
    if (grp && grp.id)
      for (const uid of grp.memberIds || []) {
        io.in(broadcast.userRoom(uid)).socketsJoin(broadcast.room(grp.id));
        io.to(broadcast.userRoom(uid)).emit(EVENTS.CONVERSATION_NEW, { conversationId: grp.id });
      }
  }
  await postMeetingInvites(req, mt, attendees, actor.id);
  if (body.conversationId)
    try {
      await postInviteCardTo(req, mt, String(body.conversationId), actor.id);
    } catch (_) {}
  res.status(201).json(ok({ meeting: mt, room: "meeting_" + mt.id, join: await joinToken(req, actor.id, "meeting_" + mt.id, "host") }));
});
// Join token for a meeting room — goes through the app's real admission gate
// (eject / lock / lobby), so an uninvited actor waits for the host like anyone.
router.post("/meetings/:id/token", requireScope("meetings:write"), async (req: any, res: any) => {
  const meetingId = String(req.params.id).split("__occ_")[0];
  const m: any = await db.meetings.getById(meetingId);
  if (!m) throw new svc.ApiError(404, "NOT_FOUND", "Meeting not found");
  if (req.tenant.orgId && m.organizationId && m.organizationId !== req.tenant.orgId) throw new svc.ApiError(404, "NOT_FOUND", "Meeting not found");
  const actor = await svc.resolveActor(req.apiKey, req.tenant, req.body);
  const entry: any = await meetingEnterRoom({ meetingId, userId: actor.id });
  if (!entry || !entry.meeting) {
    if (entry && entry.closed) throw new svc.ApiError(403, "MEETING_ENDED", "This meeting has ended");
    if (entry && entry.ejected) throw new svc.ApiError(403, "MEETING_EJECTED", "The actor was removed from this meeting by the host");
    if (entry && entry.locked) throw new svc.ApiError(403, "MEETING_LOCKED", "This meeting is locked");
    throw new svc.ApiError(403, "MEETING_LOBBY", "The actor has not been admitted to this meeting yet (lobby)");
  }
  let role = "participant";
  let attendeeRole: string | null = null;
  if (m.createdBy === actor.id) role = "host";
  else {
    try {
      attendeeRole = await db.meetings.getAttendeeRole(meetingId, actor.id);
      if (attendeeRole) role = attendeeRole;
    } catch (_) {}
  }
  const grant = meetingPolicy.grantForUser(m, actor.id, { isHost: role === "host", isCoHost: attendeeRole === "co-host" });
  res.json(ok({ meetingId, room: "meeting_" + meetingId, role, join: await joinToken(req, actor.id, "meeting_" + meetingId, role, grant) }));
});

// Service errors carry a status + stable code → standard envelope. Anything
// else (a real failure) falls through to the app's error ledger + 500.
router.use((err: any, _req: any, res: any, next: any) => {
  if (err && err.status && err.status < 500) return res.status(err.status).json(fail(err.code || "BAD_REQUEST", err.message));
  return next(err);
});

// ── OpenAPI 3 description (public) ─────────────────────────────────────────
function openapi() {
  const pageParams = [
    { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: Number(config.externalApi.maxPageSize) || 500 }, description: `Page size (default ${config.externalApi.pageSize}).` },
    { name: "offset", in: "query", schema: { type: "integer", minimum: 0 }, description: "Rows to skip. Use meta.nextOffset from the previous page." },
  ];
  const dt = (name: string, d: string) => ({ name, in: "query", schema: { type: "string", format: "date-time" }, description: d });
  const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
  const envelope = (items = true) => ({
    description: "OK",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean", enum: [true] },
            data: items ? { type: "array", items: { type: "object" } } : { type: "object" },
            meta: items ? { $ref: "#/components/schemas/PageMeta" } : undefined,
          },
        },
      },
    },
  });
  const errors = {
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/ForbiddenScope" },
    "404": { $ref: "#/components/responses/NotFound" },
    "429": { $ref: "#/components/responses/RateLimited" },
  };
  const op = (summary: string, scope: string, params: any[] = [], list = true) => ({
    summary,
    description: `Requires scope \`${scope}\`.`,
    parameters: params,
    security: [{ ApiKeyHeader: [] }, { ApiKeyAuthorization: [] }],
    responses: { "200": envelope(list), ...errors },
  });
  // Write operations: JSON body; `asUserId` / `asUserEmail` pick the actor
  // when the key has no default one.
  const wop = (summary: string, scope: string, path: string, fields: string[]) => ({
    summary,
    description: `Requires scope \`${scope}\`. POST ${path}. Body fields: ${fields.join(", ")}, plus optional asUserId / asUserEmail (the user this acts as).`,
    requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
    security: [{ ApiKeyHeader: [] }, { ApiKeyAuthorization: [] }],
    responses: { "201": envelope(false), "400": { $ref: "#/components/responses/BadRequest" }, ...errors },
  });
  const base = config.backend.publicUrl ? String(config.backend.publicUrl).replace(/\/$/, "") + BASE : BASE;
  return {
    openapi: "3.0.3",
    info: {
      title: "CoLab External Data API",
      version: "1.0.0",
      description:
        "Read-only access to a CoLab organization's data for other platforms. Authenticate with an API key minted by an organization admin (Settings → Organization → API keys) or the admin portal. Full guide: docs/EXTERNAL_DATA_API.html.",
    },
    servers: [{ url: base }],
    components: {
      securitySchemes: {
        ApiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key" },
        ApiKeyAuthorization: { type: "http", scheme: "ApiKey", description: "Authorization: ApiKey colab_…" },
      },
      schemas: {
        PageMeta: {
          type: "object",
          properties: {
            limit: { type: "integer" },
            offset: { type: "integer" },
            count: { type: "integer" },
            hasMore: { type: "boolean" },
            nextOffset: { type: "integer", nullable: true },
          },
        },
        Error: {
          type: "object",
          properties: {
            ok: { type: "boolean", enum: [false] },
            error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } } },
          },
        },
      },
      responses: {
        BadRequest: { description: "Malformed body / filter, or no actor (ACTOR_REQUIRED).", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        Unauthorized: { description: "Missing, invalid, revoked or expired API key.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        ForbiddenScope: { description: "The key lacks the required scope.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        NotFound: { description: "No such row in this key's organization.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        RateLimited: { description: "Per-key limit exceeded; honour Retry-After.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
    paths: {
      "/health": { get: { summary: "Liveness, no auth.", responses: { "200": envelope(false) } } },
      "/ping": { get: op("Who am I: key, organization, scopes.", "(any)", [], false) },
      "/users": { get: op("List organization members.", "users:read", [...pageParams, { name: "q", in: "query", schema: { type: "string" }, description: "Name/email contains." }, dt("since", "created_at ≥")]) },
      "/users/{id}": { get: op("One user.", "users:read", [id], false) },
      "/conversations": { get: op("List conversations (DMs, groups, channels).", "conversations:read", [...pageParams, { name: "kind", in: "query", schema: { type: "string" } }, dt("since", "created_at ≥")]) },
      "/conversations/{id}": { get: op("One conversation.", "conversations:read", [id], false) },
      "/conversations/{id}/members": { get: op("Members of a conversation.", "conversations:read", [id]) },
      "/conversations/{id}/messages": { get: op("Messages in a conversation (oldest first).", "messages:read", [id, ...pageParams, dt("since", "created_at ≥"), dt("until", "created_at ≤"), { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"] } }]) },
      "/messages": { get: op("Organization-wide message stream for sync jobs.", "messages:read", [...pageParams, { name: "conversationId", in: "query", schema: { type: "string" } }, { name: "senderId", in: "query", schema: { type: "string" } }, dt("since", "created_at ≥"), dt("until", "created_at ≤"), { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"] } }]) },
      "/meetings": { get: op("List meetings by start time.", "meetings:read", [...pageParams, dt("from", "starts_at ≥"), dt("to", "starts_at ≤"), { name: "status", in: "query", schema: { type: "string" } }]) },
      "/meetings/{id}": { get: op("One meeting with attendees.", "meetings:read", [id], false) },
      "/tasks": { get: op("List tasks (most recently updated first).", "tasks:read", [...pageParams, ...["status", "priority", "assigneeId", "reporterId", "projectId", "parentTaskId"].map((n) => ({ name: n, in: "query", schema: { type: "string" } })), dt("updatedSince", "updated_at ≥"), dt("dueBefore", "due_at ≤")]) },
      "/tasks/{id}": { get: op("One task with assignees and comments.", "tasks:read", [id], false) },
      "/files": { get: op("File metadata (never bytes).", "files:read", [...pageParams, { name: "conversationId", in: "query", schema: { type: "string" } }, { name: "uploaderId", in: "query", schema: { type: "string" } }, dt("since", "created_at ≥")]) },
      "/files/{id}": { get: op("One file's metadata.", "files:read", [id], false) },
      "/tables": { get: op("The allow-listed tables and their readable columns.", "tables:read") },
      "/messages#send": { post: wop("Send a message to a conversation, or to a person (DM opened for you).", "messages:write", "/messages", ["conversationId | userId | email", "text", "parentMessageId?", "important?"]) },
      "/conversations/{id}/messages#send": { post: wop("Send a message into a conversation.", "messages:write", "/conversations/{id}/messages", ["text", "parentMessageId?", "important?"]) },
      "/webhooks": { get: op("List the actor's outgoing webhook subscriptions.", "webhooks:write"), post: wop("Subscribe a URL to a conversation's (or a person's DM) message events; returns the signing secret once.", "webhooks:write", "/webhooks", ["conversationId | userId | email", "targetUrl", "events?", "name?"]) },
      "/webhooks/{id}": { delete: op("Remove a subscription.", "webhooks:write", [id], false) },
      "/webhooks/{id}/test": { post: op("Send a test delivery.", "webhooks:write", [id], false) },
      "/webhooks/{id}/deliveries": { get: op("Recent delivery log.", "webhooks:write", [id]) },
      "/calls": { get: op("The actor's call history.", "calls:write"), post: wop("Place a 1:1 audio/video call; the callee's CoLab app rings. Returns the call + a LiveKit join token for the caller.", "calls:write", "/calls", ["userId | email | peerId", "kind? (audio|video)", "conversationId?"]) },
      "/calls/{id}": { get: op("Call status.", "calls:write", [id], false) },
      "/calls/{id}/accept": { post: op("Answer as the callee; returns a join token.", "calls:write", [id], false) },
      "/calls/{id}/decline": { post: op("Decline as the callee.", "calls:write", [id], false) },
      "/calls/{id}/hangup": { post: op("End / cancel the call.", "calls:write", [id], false) },
      "/calls/{id}/token": { post: op("Re-mint a join token for a participant of a live call.", "calls:write", [id], false) },
      "/conversations/{id}/call-token": { post: op("Join token for a conversation's group call room.", "calls:write", [id], false) },
      "/meetings#create": { post: wop("Schedule a meeting and invite people; returns the meeting + a host join token.", "meetings:write", "/meetings", ["title", "startsAt", "durationMin?", "attendees[] (user ids or emails)", "conversationId?", "description?", "location?"]) },
      "/meetings/{id}/token": { post: op("Join token for a meeting room (admission rules apply).", "meetings:write", [id], false) },
      "/tables/{name}": { get: op("Read rows from one allow-listed table.", "tables:read", [{ name: "name", in: "path", required: true, schema: { type: "string", enum: Object.keys(svc.TABLES) } }, ...pageParams, { name: "columns", in: "query", schema: { type: "string" }, description: "Comma list, subset of the table's readable columns." }, { name: "filter[column]", in: "query", schema: { type: "string" }, description: "Equality filter; `null` matches IS NULL. Repeatable." }, dt("since", "time column ≥"), dt("until", "time column ≤"), { name: "orderBy", in: "query", schema: { type: "string" } }, { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"] } }]) },
    },
  };
}

export default router;
