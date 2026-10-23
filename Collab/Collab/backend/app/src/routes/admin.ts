// ─────────────────────────────────────────────────────────────────────────────
// Collab Admin Portal — Controller & API Routes (/api/admin/*)
//
// Administrative control plane for the Collab project.
// Completely decoupled from regular user sessions.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { asyncRouter } from "../asyncRouter";
import { config, db, shared } from "../platform";
import { broadcast } from "../realtime/socket";
import * as livekit from "../services/livekitService";
import * as meetingPolicy from "../services/meetingPolicy";
import { isWhiteboardBlocked, setWhiteboardBlocked } from "../services/whiteboardAccess";
import { adminService } from "../services/adminService";
import * as externalApi from "../services/externalApiService";

const router = asyncRouter();

// ── Timing-safe string comparison ────────────────────────────────────────────
function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

// ── Public Auth Status ───────────────────────────────────────────────────────
router.get("/auth/status", (_req, res) => {
  const configured = !!String(config.admin?.password || "");
  res.json({
    ok: true,
    configured,
    defaultEmail: config.admin?.email || "admin@collab.local",
    env: config.env,
  });
});

// ── Admin Login ──────────────────────────────────────────────────────────────
router.post("/auth/login", async (req, res) => {
  const configuredEmail = String(config.admin?.email || "admin@collab.local").trim();
  const configuredPass = String(config.admin?.password || "");

  if (!configuredPass) {
    return res.status(503).json({
      ok: false,
      error: "Admin portal is disabled (ADMIN_PASSWORD is not configured in backend).",
    });
  }

  const gotEmail = String(req.body?.email || req.body?.username || "").trim();
  const gotPass = String(req.body?.password || "");

  const emailOk = timingSafeEqual(gotEmail.toLowerCase(), configuredEmail.toLowerCase());
  const passOk = !!gotPass && timingSafeEqual(gotPass, configuredPass);

  if (!emailOk || !passOk) {
    // Log failed attempt without sensitive values
    await adminService.recordAudit({
      actor: gotEmail || "unknown",
      action: "admin.login_failed",
      target: "admin_portal",
      meta: { ip: req.ip, userAgent: req.headers["user-agent"] },
    });
    return res.status(401).json({
      ok: false,
      error: "Incorrect admin email or password.",
    });
  }

  const tokenPayload = {
    scope: "admin",
    email: configuredEmail,
    role: "superadmin",
  };

  const token = jwt.sign(tokenPayload, config.auth.jwtSecret, {
    expiresIn: config.admin?.sessionTtl || "12h",
  });

  await adminService.recordAudit({
    actor: configuredEmail,
    action: "admin.login_success",
    target: "admin_portal",
    meta: { ip: req.ip, userAgent: req.headers["user-agent"] },
  });

  return res.json({
    ok: true,
    token,
    admin: {
      email: configuredEmail,
      role: "superadmin",
    },
  });
});

// ── Guard Middleware: requireAdmin ───────────────────────────────────────────
router.use((req: any, res, next) => {
  const h = String(req.headers.authorization || "");
  const token = h.startsWith("Bearer ")
    ? h.slice(7)
    : String(req.headers["x-admin-token"] || "");

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: "Admin authentication required.",
    });
  }

  try {
    const payload: any = jwt.verify(token, config.auth.jwtSecret);
    if (payload?.scope !== "admin") {
      return res.status(403).json({
        ok: false,
        error: "Access denied. Admin authorization token required.",
      });
    }
    req.admin = payload;
    return next();
  } catch (err: any) {
    return res.status(401).json({
      ok: false,
      error: "Admin session expired or invalid. Please sign in again.",
    });
  }
});

// ── Admin Identity & Logout ──────────────────────────────────────────────────
router.get("/auth/me", (req: any, res) => {
  res.json({
    ok: true,
    admin: req.admin,
  });
});

router.post("/auth/logout", async (req: any, res) => {
  await adminService.recordAudit({
    actor: req.admin?.email || "admin",
    action: "admin.logout",
    target: "admin_portal",
  });
  res.json({ ok: true });
});

// ── 1. Dashboard Metrics ─────────────────────────────────────────────────────
router.get("/dashboard", async (_req, res) => {
  const metrics = await adminService.getDashboardMetrics();
  res.json({ ok: true, data: metrics });
});

// ── 2. Organization Management ───────────────────────────────────────────────
router.get("/organizations", async (req, res) => {
  const queryParam = String(req.query.q || req.query.query || "");
  const status = String(req.query.status || "all");
  const limit = Number(req.query.limit) || 20;
  const offset = Number(req.query.offset) || 0;

  const result = await adminService.listOrganizations({
    query: queryParam,
    status,
    limit,
    offset,
  });
  res.json({ ok: true, data: result });
});

router.get("/organizations/:id", async (req, res) => {
  const org = await adminService.getOrganizationDetails(req.params.id);
  if (!org) {
    return res.status(404).json({ ok: false, error: "Organization not found." });
  }
  res.json({ ok: true, data: org });
});

router.get("/organizations/:id/members", async (req, res) => {
  const org = await adminService.getOrganizationDetails(req.params.id);
  if (!org) {
    return res.status(404).json({ ok: false, error: "Organization not found." });
  }
  res.json({ ok: true, data: org.members });
});

router.get("/organizations/:id/meetings", async (req, res) => {
  const org = await adminService.getOrganizationDetails(req.params.id);
  if (!org) {
    return res.status(404).json({ ok: false, error: "Organization not found." });
  }
  res.json({ ok: true, data: org.meetings });
});

// ── 3. Member Management ─────────────────────────────────────────────────────
router.get("/members", async (req, res) => {
  const queryParam = String(req.query.q || req.query.query || "");
  const organizationId = String(req.query.organizationId || req.query.orgId || "all");
  const presence = String(req.query.presence || "all");
  const status = String(req.query.status || "active");
  const limit = Number(req.query.limit) || 20;
  const offset = Number(req.query.offset) || 0;

  const result = await adminService.listMembers({
    query: queryParam,
    organizationId,
    presence,
    status,
    limit,
    offset,
  });
  res.json({ ok: true, data: result });
});

// ── 4. Online Users ──────────────────────────────────────────────────────────
router.get("/online-users", async (req, res) => {
  const queryParam = String(req.query.q || req.query.query || "");
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;

  const result = await adminService.getOnlineUsers({
    query: queryParam,
    limit,
    offset,
  });
  res.json({ ok: true, data: result });
});

// ── 5. Meetings Management ───────────────────────────────────────────────────
router.get("/meetings", async (req, res) => {
  const queryParam = String(req.query.q || req.query.query || "");
  const organizationId = String(req.query.organizationId || req.query.orgId || "all");
  const status = String(req.query.status || "all");
  const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : undefined;
  const dateTo = req.query.dateTo ? String(req.query.dateTo) : undefined;
  const organizerId = req.query.organizerId ? String(req.query.organizerId) : undefined;
  const upcomingOnly = req.query.upcomingOnly === "true";
  const completedOnly = req.query.completedOnly === "true";
  const limit = Number(req.query.limit) || 20;
  const offset = Number(req.query.offset) || 0;

  const result = await adminService.listMeetings({
    query: queryParam,
    organizationId,
    status,
    dateFrom,
    dateTo,
    organizerId,
    upcomingOnly,
    completedOnly,
    limit,
    offset,
  });
  res.json({ ok: true, data: result });
});

router.get("/meetings/:id", async (req, res) => {
  const meeting = await adminService.getMeetingDetails(req.params.id);
  if (!meeting) {
    return res.status(404).json({ ok: false, error: "Meeting not found." });
  }
  res.json({ ok: true, data: meeting });
});

router.post("/meetings/:id/members", async (req: any, res) => {
  const userIds = Array.isArray(req.body?.userIds)
    ? req.body.userIds
    : req.body?.userId
      ? [req.body.userId]
      : [];

  if (!userIds.length) {
    return res.status(400).json({ ok: false, error: "Please select at least one member to add." });
  }

  const result = await adminService.addMeetingMembers(req.params.id, userIds, {
    email: req.admin?.email || "admin",
  });

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.message });
  }

  res.json({ ok: true, data: result.details });
});

router.delete("/meetings/:id/members/:memberId", async (req: any, res) => {
  const result = await adminService.removeMeetingMember(
    req.params.id,
    req.params.memberId,
    { email: req.admin?.email || "admin" },
  );

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.message });
  }

  res.json({ ok: true, data: result.details });
});

// ── 5b. Live meeting controls ────────────────────────────────────────────────
// The administrator's counterpart to the host's in-meeting controls. Same
// building blocks (livekitService mute / remove / permissions), different
// authority: these routes are gated by the admin token above, not by being the
// meeting's host, and every action is written to the audit log.
//
// Rules carried over from the host controls:
//   • mute is ONE-WAY — an admin can mute people, never force a mic back on;
//   • stop-screen-share only stops the CURRENT share, the person may share again.
const { EVENTS } = shared;
const liveRoom = (meetingId: string) => "meeting_" + meetingId;

async function liveMeetingOr404(req: any, res: any) {
  const meeting = await db.meetings.getById(req.params.id);
  if (!meeting) {
    res.status(404).json({ ok: false, error: "Meeting not found." });
    return null;
  }
  return meeting;
}

async function auditLive(req: any, meeting: any, action: string, meta: any = {}) {
  await adminService.recordAudit({
    actor: req.admin?.email || "admin",
    action: "meeting.live." + action,
    target: `meeting:${meeting.id}`,
    meta: { meetingId: meeting.id, title: meeting.title, ...meta },
    organizationId: meeting.organizationId || null,
  });
}

router.get("/meetings/:id/live", async (req: any, res) => {
  const meeting = await liveMeetingOr404(req, res);
  if (!meeting) return;
  const roster = await livekit.listRoomParticipants(liveRoom(meeting.id));
  // Names: the room carries the display name when the token had one, but falls
  // back to the bare id — fill those from the users table.
  const missing = roster.participants
    .filter((p) => !p.name || p.name === p.userId)
    .map((p) => p.userId);
  const names = new Map<string, any>();
  if (missing.length && (db.users as any).getByIds) {
    for (const u of (await (db.users as any).getByIds(missing)) || []) names.set(u.id, u);
  }
  const options = meetingPolicy.optionsOf(meeting);
  res.json({
    ok: true,
    data: {
      meetingId: meeting.id,
      status: meeting.status,
      sfuReachable: roster.reachable,
      allowWhiteboard: options.allowWhiteboard,
      participants: roster.participants.map((p) => {
        const u = names.get(p.userId);
        return {
          userId: p.userId,
          name: (u && u.name) || p.name || p.userId,
          email: (u && u.email) || null,
          isHost: meeting.createdBy === p.userId,
          micOn: p.micOn,
          cameraOn: p.cameraOn,
          screenSharing: p.screenSharing,
          whiteboardBlocked: isWhiteboardBlocked(meeting.id, p.userId),
        };
      }),
    },
  });
});

router.post("/meetings/:id/live/mute-all", async (req: any, res) => {
  const meeting = await liveMeetingOr404(req, res);
  if (!meeting) return;
  // exceptUserId = null: an admin is not in the room, so nobody is spared.
  const result: any = await livekit.muteAllParticipants(liveRoom(meeting.id), null);
  const io = req.app.get("io");
  if (io) {
    for (const uid of result?.mutedUserIds || []) {
      io.to(broadcast.userRoom(uid)).emit(EVENTS.MEDIA_FORCE_MUTE, {
        scope: "meeting",
        id: meeting.id,
        by: "admin",
      });
    }
  }
  await auditLive(req, meeting, "mute_all", { mutedTracks: result?.mutedTracks });
  res.json({ ok: true, data: result });
});

router.post("/meetings/:id/live/participants/:userId/mute", async (req: any, res) => {
  const meeting = await liveMeetingOr404(req, res);
  if (!meeting) return;
  const result: any = await livekit.muteParticipant(liveRoom(meeting.id), req.params.userId, true);
  const io = req.app.get("io");
  if (io && result?.tracks > 0) {
    io.to(broadcast.userRoom(req.params.userId)).emit(EVENTS.MEDIA_FORCE_MUTE, {
      scope: "meeting",
      id: meeting.id,
      by: "admin",
    });
  }
  await auditLive(req, meeting, "mute", { userId: req.params.userId });
  res.json({ ok: true, data: result });
});

router.post("/meetings/:id/live/participants/:userId/stop-screen-share", async (req: any, res) => {
  const meeting = await liveMeetingOr404(req, res);
  if (!meeting) return;
  const result: any = await livekit.stopScreenShare(liveRoom(meeting.id), req.params.userId);
  const io = req.app.get("io");
  if (io && result?.inRoom) {
    io.to(broadcast.userRoom(req.params.userId)).emit(EVENTS.MEDIA_FORCE_STOP_SCREEN, {
      scope: "meeting",
      id: meeting.id,
      by: "admin",
    });
  }
  await auditLive(req, meeting, "stop_screen_share", { userId: req.params.userId });
  res.json({ ok: true, data: result });
});

// Camera off — one person, or everyone. One-way like mute: the person can
// switch their camera back on themselves.
router.post("/meetings/:id/live/participants/:userId/camera-off", async (req: any, res) => {
  const meeting = await liveMeetingOr404(req, res);
  if (!meeting) return;
  const result: any = await livekit.stopCamera(liveRoom(meeting.id), req.params.userId);
  const io = req.app.get("io");
  if (io) {
    for (const uid of result?.stoppedUserIds || []) {
      io.to(broadcast.userRoom(uid)).emit(EVENTS.MEDIA_FORCE_CAMERA_OFF, {
        scope: "meeting",
        id: meeting.id,
        by: "admin",
      });
    }
  }
  await auditLive(req, meeting, "camera_off", { userId: req.params.userId });
  res.json({ ok: true, data: result });
});

router.post("/meetings/:id/live/cameras-off", async (req: any, res) => {
  const meeting = await liveMeetingOr404(req, res);
  if (!meeting) return;
  const result: any = await livekit.stopCamera(liveRoom(meeting.id), null);
  const io = req.app.get("io");
  if (io) {
    for (const uid of result?.stoppedUserIds || []) {
      io.to(broadcast.userRoom(uid)).emit(EVENTS.MEDIA_FORCE_CAMERA_OFF, {
        scope: "meeting",
        id: meeting.id,
        by: "admin",
      });
    }
  }
  await auditLive(req, meeting, "cameras_off", { count: (result?.stoppedUserIds || []).length });
  res.json({ ok: true, data: result });
});

// Whiteboard for ONE person (the meeting-wide switch is PATCH .../whiteboard).
router.patch("/meetings/:id/live/participants/:userId/whiteboard", async (req: any, res) => {
  const meeting = await liveMeetingOr404(req, res);
  if (!meeting) return;
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "enabled must be true or false." });
  }
  const blockedNow = !req.body.enabled;
  setWhiteboardBlocked(meeting.id, req.params.userId, blockedNow);
  const io = req.app.get("io");
  if (io) {
    io.to(broadcast.userRoom(req.params.userId)).emit(EVENTS.MEETING_WHITEBOARD_ACCESS, {
      meetingId: meeting.id,
      blocked: blockedNow,
    });
  }
  await auditLive(req, meeting, blockedNow ? "whiteboard_block" : "whiteboard_unblock", {
    userId: req.params.userId,
  });
  res.json({ ok: true, data: { whiteboardBlocked: blockedNow } });
});

// Remove from the LIVE room. Persists the eject first (same order as the host
// control) so the person cannot re-mint a token and walk straight back in. This
// is separate from the roster removal above, which only edits the invite list.
router.delete("/meetings/:id/live/participants/:userId", async (req: any, res) => {
  const meeting = await liveMeetingOr404(req, res);
  if (!meeting) return;
  if (meeting.createdBy === req.params.userId) {
    return res.status(400).json({ ok: false, error: "The meeting organizer cannot be removed from the call." });
  }
  try {
    await (db.meetings as any).meetingEject(meeting.id, req.params.userId, "admin");
  } catch (_) {
    // best-effort — the SFU kick below still happens
  }
  const result = await livekit.removeParticipant(liveRoom(meeting.id), req.params.userId);
  await auditLive(req, meeting, "remove", { userId: req.params.userId });
  res.json({ ok: true, data: result });
});

router.post("/meetings/:id/live/participants/:userId/readmit", async (req: any, res) => {
  const meeting = await liveMeetingOr404(req, res);
  if (!meeting) return;
  try {
    await (db.meetings as any).meetingEjectClear(meeting.id, req.params.userId);
  } catch (_) {}
  await auditLive(req, meeting, "readmit", { userId: req.params.userId });
  res.json({ ok: true, data: { readmitted: true } });
});

// Whiteboard on/off for the whole meeting. Persisted (late joiners and the next
// session respect it) and pushed live so open boards close immediately.
router.patch("/meetings/:id/live/whiteboard", async (req: any, res) => {
  const meeting = await liveMeetingOr404(req, res);
  if (!meeting) return;
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "enabled must be true or false." });
  }
  const enabled: boolean = req.body.enabled;
  await db.meetings.setOptions(meeting.id, { allowWhiteboard: enabled });
  const after = await db.meetings.getById(meeting.id);
  const io = req.app.get("io");
  if (io) {
    io.to("meeting:" + meeting.id).emit(EVENTS.MEETING_OPTIONS, {
      meetingId: meeting.id,
      ...meetingPolicy.optionsOf(after),
    });
  }
  await auditLive(req, meeting, enabled ? "whiteboard_enable" : "whiteboard_disable");
  res.json({ ok: true, data: { allowWhiteboard: enabled } });
});

// ── 6. Analytics ─────────────────────────────────────────────────────────────
router.get("/analytics", async (req, res) => {
  const organizationId = req.query.organizationId ? String(req.query.organizationId) : undefined;
  const analytics = await adminService.getAnalytics(organizationId);
  res.json({ ok: true, data: analytics });
});

// ── 7. Audit Logs ────────────────────────────────────────────────────────────
router.get("/audit-logs", async (req, res) => {
  const queryParam = String(req.query.q || req.query.query || "");
  const action = req.query.action ? String(req.query.action) : undefined;
  const limit = Number(req.query.limit) || 50;
  const offset = Number(req.query.offset) || 0;

  const result = await adminService.listAuditLogs({
    query: queryParam,
    action,
    limit,
    offset,
  });
  res.json({ ok: true, data: result });
});

// ── 7b. Server Logs (platform failures recorded by the backend) ─────────────
router.get("/server-logs", async (req, res) => {
  const result = await adminService.listServerLogs({
    query: String(req.query.q || req.query.query || ""),
    level: req.query.level ? String(req.query.level) : undefined,
    source: req.query.source ? String(req.query.source) : undefined,
    status: req.query.status ? String(req.query.status) : undefined,
    range: req.query.range ? String(req.query.range) : undefined,
    limit: Number(req.query.limit) || 50,
    offset: Number(req.query.offset) || 0,
  });
  res.json({ ok: true, data: result });
});

// ── 8. Organization Broadcasts ──────────────────────────────────────────────
router.get("/broadcasts", async (req, res) => {
  const queryParam = String(req.query.q || req.query.query || "");
  const organizationId = String(req.query.organizationId || req.query.orgId || "all");
  const status = String(req.query.status || "all");
  const limit = Number(req.query.limit) || 20;
  const offset = Number(req.query.offset) || 0;

  const result = await adminService.listBroadcasts({
    query: queryParam,
    organizationId,
    status,
    limit,
    offset,
  });
  res.json({ ok: true, data: result });
});

router.post("/broadcasts", async (req: any, res) => {
  const { organizationId, title, body, sendAt, excludedUserIds } = req.body || {};

  const result = await adminService.createBroadcast(
    {
      organizationId,
      title,
      body,
      sendAt,
      excludedUserIds,
    },
    { email: req.admin?.email || "admin" },
  );

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.message });
  }

  res.json({ ok: true, data: result.details });
});

router.delete("/broadcasts/:id", async (req: any, res) => {
  const result = await adminService.deleteBroadcast(req.params.id, {
    email: req.admin?.email || "admin",
  });

  if (result.error) {
    return res.status(400).json({ ok: false, error: result.message });
  }

  res.json({ ok: true, data: result.details });
});

// ── External Data API keys (platform) ───────────────────────────────────────
// The admin portal can mint keys for ANY organization (pass organizationId) or
// PLATFORM keys (omit it) that see every organization and may narrow per
// request with X-Org-Id. The key is returned once. docs/EXTERNAL_DATA_API.html.
function apiKeyError(res, e) {
  if (e && e.status && e.status < 500) return res.status(e.status).json({ ok: false, error: { code: e.code || "BAD_REQUEST", message: e.message } });
  throw e;
}
router.get("/api-keys", async (req: any, res) => {
  const orgId = String(req.query.organizationId || "").trim();
  const platformOnly = String(req.query.platform || "") === "true";
  try {
    const keys = await externalApi.listKeys(orgId ? { orgId } : platformOnly ? { platformOnly: true } : { all: true });
    res.json({ ok: true, data: keys });
  } catch (e) {
    return apiKeyError(res, e);
  }
});
router.post("/api-keys", async (req: any, res) => {
  const { name, scopes, expiresAt, organizationId, userId } = req.body || {};
  try {
    const out = await externalApi.createKey({
      orgId: organizationId ? String(organizationId) : null,
      name,
      scopes,
      expiresAt,
      userId: userId ? String(userId) : null,
      createdBy: "admin:" + (req.admin?.email || "admin"),
    });
    res.status(201).json({ ok: true, data: out });
  } catch (e) {
    return apiKeyError(res, e);
  }
});
router.post("/api-keys/:id/rotate", async (req: any, res) => {
  try {
    res.json({ ok: true, data: await externalApi.rotateKey(req.params.id, { any: true }) });
  } catch (e) {
    return apiKeyError(res, e);
  }
});
router.delete("/api-keys/:id", async (req: any, res) => {
  try {
    res.json({
      ok: true,
      data: await externalApi.revokeKey(req.params.id, { any: true, by: "admin:" + (req.admin?.email || "admin") }),
    });
  } catch (e) {
    return apiKeyError(res, e);
  }
});

export default router;
