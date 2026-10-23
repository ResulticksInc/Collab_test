import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, fail, db, config } from "../platform";
import authMiddleware from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import { PERMISSIONS, PERMISSION_CATALOG, can } from "../services/rbacService";
import * as orgService from "../services/orgService";
import * as externalApi from "../services/externalApiService";
import * as notifService from "../services/notificationService";
import * as broadcastService from "../services/orgBroadcastService";
import { pushNotif } from "../realtime/notify";
import { record } from "../services/auditService";
import { disconnectSession, disconnectOtherSessions, evictFromOrg } from "../realtime/socket";

// Organizations product API (#70). All routes are authed. Admin routes operate on the
// caller's ACTIVE org (req.org.id, set by auth.ts from the session) and are gated by
// an RBAC permission (requirePermission) — so you switch INTO an org to administer it,
// exactly like Slack/Teams. Data invariants (valid role, >=1 owner) live in orgService.
router.use(authMiddleware);

// The active org id, or a 403 (helper for the admin routes below).
function activeOrg(req: any, res: any): string | null {
  const id = req.org?.id || null;
  if (!id) {
    res.status(403).json(fail("NO_ACTIVE_ORG", "No active organization for this session."));
    return null;
  }
  return id;
}

// Fire an org-membership activity notification (best-effort, AFTER the response is
// sent). `build` returns the notification; we resolve the org name, the actor's name,
// and a role-key→label mapper for it, then socket + web-push it to the recipient so it
// lands in their Activity feed. Never affects the mutation's own result.
async function orgActivity(
  req: any,
  orgId: string,
  build: (org: any, actorName: string, roleName: (k: string) => string) => Promise<any>,
  // The user the notification is FOR. When the actor acted on THEMSELVES
  // (self-removal, changing their own role), telling them what they just did —
  // "You were removed from X. Removed by <their own name>." — is noise, so the
  // notification is skipped. Pass the affected user's id to enable the guard;
  // omitted → old behaviour (always notify).
  affectedUserId?: string,
): Promise<void> {
  try {
    if (affectedUserId && affectedUserId === req.user.userId) return;
    const io = req.app.get("io");
    const [org, actor, roles] = await Promise.all([
      db.orgs.getById(orgId),
      db.users.getById(req.user.userId),
      db.orgs.roleCatalog(orgId),
    ]);
    const roleName = (k: string) => (roles || []).find((r: any) => r.key === k)?.name || k;
    const n = await build(org, actor?.name || "Someone", roleName);
    if (n && io) pushNotif(io, n);
  } catch (_) {
    /* best-effort */
  }
}

// Orgs the caller belongs to (backs the switcher).
router.get("/", async (req, res) =>
  res.json(ok(await db.orgs.listForUser(req.user.userId))),
);

// Provision a new org (caller becomes its first owner) and switch into it.
router.post("/", async (req, res) => {
  const org = await orgService.provision({
    userId: req.user.userId,
    name: (req.body || {}).name,
  });
  if (req.user.jti)
    await db.sessions.setActiveOrg(req.user.jti, req.user.userId, org.id);
  res.json(ok({ org, activeOrgId: org.id }));
});

// Switch the caller's active org (verifies membership; updates the session row).
router.post("/switch", async (req, res) => {
  const out = await orgService.switchOrg({
    userId: req.user.userId,
    sessionId: req.user.jti || null,
    orgId: (req.body || {}).orgId,
  });
  res.json(ok(out));
});

// Active-org context bundle: the org + the caller's role + their permissions.
router.get("/current", async (req, res) => {
  const orgId = req.org?.id || null;
  if (!orgId) return res.json(ok(null));
  res.json(ok(await orgService.currentContext({ userId: req.user.userId, orgId })));
});

// Update org settings (name). [org:manage]
router.patch("/current", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const name = (req.body || {}).name;
  res.json(ok(await db.orgs.updateSettings(orgId, { name })));
  await record({
    actorId: req.user.userId,
    action: "org.settings.update",
    targetType: "org",
    targetId: orgId,
    detail: { name },
  });
});

// ── Session policy (Session Mgmt Phase 4) ────────────────────────────────────
// Read/update the org's per-tenant session policy: max concurrent devices per
// member (sessionLimit; 0 = unlimited, null = inherit the env default) and idle
// timeout (idleTimeoutMin; stored here, enforced by the Phase 5 GC sweep).
router.get("/current/session-policy", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const policy = await db.orgs.getPolicy(orgId);
  // Surface the global default too so the UI can show what "inherit" resolves to.
  const envDefault = Math.max(0, Number(process.env.AUTH_MAX_SESSIONS ?? 5));
  res.json(ok({ ...policy, envDefaultLimit: envDefault }));
});
router.patch("/current/session-policy", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const b = req.body || {};
  // Only forward keys the caller actually sent (undefined = leave unchanged;
  // null = clear back to inherit). Bound to sane ranges to avoid foot-guns.
  const patch: any = {};
  if (b.sessionLimit !== undefined)
    patch.sessionLimit = b.sessionLimit === null ? null : Math.min(1000, Math.max(0, Math.floor(Number(b.sessionLimit) || 0)));
  if (b.idleTimeoutMin !== undefined)
    patch.idleTimeoutMin = b.idleTimeoutMin === null ? null : Math.min(43200, Math.max(0, Math.floor(Number(b.idleTimeoutMin) || 0)));
  const policy = await db.orgs.setPolicy(orgId, patch);
  await record({
    actorId: req.user.userId,
    action: "org.session_policy.update",
    targetType: "org",
    targetId: orgId,
    detail: patch,
  });
  res.json(ok(policy));
});

// ── Media settings: org GIF-search API key (GIF search enablement) ───────────
// Lets a tenant admin paste a free GIPHY key so GIF/sticker SEARCH turns on for
// their org with no redeploy. The GET never echoes the secret — only whether a
// key is set (org-level, or via the env fallback). [org:manage].
async function mediaSettingsState(orgId: string) {
  const cfg = await db.orgs.getGifConfig(orgId);
  return {
    provider: cfg.provider || null,
    gifConfigured: !!cfg.key,
    envFallback: !!config.media.giphyKey,
  };
}
router.get("/current/media-settings", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  res.json(ok(await mediaSettingsState(orgId)));
});
router.patch("/current/media-settings", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const b = req.body || {};
  let touched = false;
  // null / "" clears a key (revert to env default / off). Secrets are never
  // written to the audit detail — only whether they were set or cleared.
  if (b.apiKey !== undefined) {
    const raw = b.apiKey === null ? "" : String(b.apiKey).trim();
    const provider = b.provider === "giphy" ? "giphy" : "giphy"; // only giphy today
    const saved = await db.orgs.setGifConfig(orgId, provider, raw);
    await record({ actorId: req.user.userId, action: "org.media_settings.update", targetType: "org", targetId: orgId, detail: { provider: saved.provider || null, apiKey: saved.key ? "set" : "cleared" } });
    touched = true;
  }
  if (!touched) return res.status(400).json(fail("BAD_REQUEST", "Nothing to update."));
  res.json(ok(await mediaSettingsState(orgId)));
});

// ── Admin: a member's login sessions (Session Mgmt Phase 4) ──────────────────
// View + force-logout any member's devices. [members:manage]. The target MUST be
// an active member of the CALLER's active org (cross-org access is a 404), so an
// admin can only ever administer their own tenant's members. Revokes reuse the
// live force-disconnect (Phase 3) so a booted device drops immediately.
router.get("/current/members/:userId/sessions", requirePermission(PERMISSIONS.MEMBERS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const targetId = String(req.params.userId || "");
  const m = await db.orgs.membership(targetId, orgId);
  if (!m || m.status !== "active")
    return res.status(404).json(fail("NOT_A_MEMBER", "That user is not a member of this organization."));
  const rows = await db.sessions.listForUser(targetId);
  const sessions = (rows || []).map((s: any) => ({
    id: s.id,
    deviceLabel: s.deviceLabel,
    deviceType: s.deviceType || null,
    browser: s.browser || null,
    os: s.os || null,
    platform: s.platform,
    city: s.city || null,
    country: s.country || null,
    location: [s.city, s.country].filter(Boolean).join(", ") || null,
    status: s.status || (s.revoked ? "revoked" : "active"),
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    expiresAt: s.expiresAt,
    revoked: s.revoked,
  }));
  res.json(ok({ sessions }));
});
// Force-logout ONE of a member's sessions. [members:manage]
router.delete("/current/members/:userId/sessions/:sid", requirePermission(PERMISSIONS.MEMBERS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const targetId = String(req.params.userId || "");
  const sid = String(req.params.sid || "");
  const m = await db.orgs.membership(targetId, orgId);
  if (!m || m.status !== "active")
    return res.status(404).json(fail("NOT_A_MEMBER", "That user is not a member of this organization."));
  const revoked = await db.sessions.revoke(targetId, sid);
  if (revoked) {
    void disconnectSession(req.app.get("io"), sid, "revoked");
    await record({
      actorId: req.user.userId,
      action: "admin.session.revoke",
      targetType: "session",
      targetId: sid,
      detail: { orgId, targetUserId: targetId },
    });
  }
  res.json(ok({ revoked }));
});
// Force-logout ALL of a member's sessions (every device). [members:manage]
router.post("/current/members/:userId/sessions/revoke-all", requirePermission(PERMISSIONS.MEMBERS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const targetId = String(req.params.userId || "");
  const m = await db.orgs.membership(targetId, orgId);
  if (!m || m.status !== "active")
    return res.status(404).json(fail("NOT_A_MEMBER", "That user is not a member of this organization."));
  const out = await db.sessions.revokeAllForUser(targetId);
  // Mobile push K4: all sessions gone → all phone registrations gone.
  try { await db.pushDevices.removeForUser(targetId); } catch (_) {}
  // keepJti "" keeps nothing → disconnect every one of the member's devices.
  void disconnectOtherSessions(req.app.get("io"), targetId, "");
  await record({
    actorId: req.user.userId,
    action: "admin.session.revoke_all",
    targetType: "user",
    targetId: targetId,
    detail: { orgId, count: (out && out.revoked) || 0 },
  });
  res.json(ok(out));
});

// Member roster. Any active member may view it, but EMAIL (PII) is redacted for
// callers without members:manage, so a member/guest can't harvest the org's email
// directory. Managers/Admins/Owners get the full roster for administration.
router.get("/current/members", async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const roster = await db.orgs.members(orgId);
  const canManage = await can(req.user.userId, orgId, PERMISSIONS.MEMBERS_MANAGE);
  const safe = canManage
    ? roster
    : roster.map(({ email, ...rest }: any) => rest);
  res.json(ok(safe));
});

// Add an existing Collab user by email. [members:invite]
router.post("/current/members", requirePermission(PERMISSIONS.MEMBERS_INVITE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const b = req.body || {};
  const result = await orgService.addMemberByEmail({ orgId, actorId: req.user.userId, email: b.email, role: b.role || "member" });
  res.json(ok(result));
  await record({
    actorId: req.user.userId,
    action: "org.member.add",
    targetType: "user",
    targetId: result.userId,
    detail: { role: result.role },
  });
  await orgActivity(req, orgId, (org, actorName, roleName) =>
    notifService.notifyOrgMemberAdded({
      userId: result.userId,
      actorName,
      orgName: org?.name || "an organization",
      roleName: roleName(result.role),
      orgId,
    }),
  );
});

// ── Enterprise onboarding: discovery + join requests ─────────────────────────
// These are for users who belong to NO org yet (or want to join another), so the
// user-facing ones are NOT gated by an active-org permission — they operate across
// orgs, not within the caller's active tenant.

// NOTE: org DISCOVERY by name was intentionally removed — the tenant list is
// sensitive (it would let any authed user enumerate every organization). You join
// only with a code (slug) or an invite link you were given, resolved server-side
// in the join-request handler below. Do not re-add a "list/search orgs" endpoint.

// Request to join an org (by id OR slug/"org code"). Creates a PENDING request —
// never a membership. Notifies the target org's owners/admins.
router.post("/join-requests", async (req, res) => {
  const b = req.body || {};
  const out = await orgService.requestJoin({
    userId: req.user.userId, orgId: b.orgId, slug: b.slug, message: b.message,
  });
  res.json(ok(out));
  // Best-effort, after the response: ping everyone who can ACT on the request.
  try {
    const io = req.app.get("io");
    const [roster, requester, roles] = await Promise.all([
      db.orgs.members(out.org.id),
      db.users.getById(req.user.userId),
      db.orgs.roleCatalog(out.org.id),
    ]);
    // Recipients = holders of members:manage — the permission the approve/
    // reject routes gate on — not a hard-coded owner/admin list. A custom role
    // granted members:manage (say, "Director") could already approve requests
    // but was never told one arrived, so requests sat unseen unless an owner
    // or admin happened to look. One rule for both sides now: if you can
    // decide it, you hear about it. Owner/admin stay as a fallback should the
    // role catalog be unavailable.
    const managerRoles = new Set(
      (roles || [])
        .filter((r: any) => (r.permissions || []).includes(PERMISSIONS.MEMBERS_MANAGE))
        .map((r: any) => r.key),
    );
    managerRoles.add("owner");
    managerRoles.add("admin");
    for (const a of (roster || []).filter(
      (m: any) => managerRoles.has(m.role) && m.status === "active",
    )) {
      const n = await notifService.notifyJoinRequestReceived({
        userId: a.userId, requesterName: requester?.name || "Someone",
        orgName: out.org.name, orgId: out.org.id,
      });
      if (n && io) pushNotif(io, n);
    }
  } catch (_) {
    /* best-effort */
  }
});

// The caller's own requests (onboarding "Request Sent" state). Any authed user.
router.get("/my-join-requests", async (req, res) =>
  res.json(ok(await orgService.myJoinRequests({ userId: req.user.userId }))),
);

// Admin: list the active org's PENDING join requests. [members:manage]
router.get("/current/join-requests", requirePermission(PERMISSIONS.MEMBERS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  res.json(ok(await orgService.listJoinRequests({ orgId })));
});

// Admin: approve a request → adds the user as 'member' + notifies them. [members:manage]
// First-action-wins (BA #2): the service claims the pending row atomically — a
// second admin acting on the same request gets a 409 REQUEST_DECIDED.
router.post("/current/join-requests/:id/approve", requirePermission(PERMISSIONS.MEMBERS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const out = await orgService.decideJoinRequest({ requestId: req.params.id, orgId, actorId: req.user.userId, approve: true });
  res.json(ok(out));
  await record({
    actorId: req.user.userId,
    action: "org.join_request.approve",
    targetType: "user",
    targetId: out.userId,
    detail: { requestId: req.params.id },
  });
  await orgActivity(req, orgId, (org, actorName) =>
    notifService.notifyJoinRequestDecided({ userId: out.userId, approved: true, orgName: org?.name || "the organization", orgId, actorName }),
  );
});

// Admin: reject a request → notifies the requester, with the admin's optional
// reason (BA #1) echoed into the notification + audit. [members:manage]
router.post("/current/join-requests/:id/reject", requirePermission(PERMISSIONS.MEMBERS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const reason = String((req.body || {}).reason || "").trim().slice(0, 500) || null;
  const out = await orgService.decideJoinRequest({ requestId: req.params.id, orgId, actorId: req.user.userId, approve: false, reason });
  res.json(ok(out));
  await record({
    actorId: req.user.userId,
    action: "org.join_request.reject",
    targetType: "user",
    targetId: out.userId,
    detail: { requestId: req.params.id, reason },
  });
  await orgActivity(req, orgId, (org, actorName) =>
    notifService.notifyJoinRequestDecided({ userId: out.userId, approved: false, orgName: org?.name || "the organization", orgId, actorName, reason }),
  );
});

// Provision a NEW local (username/password) account AND add it to this org in one
// step. [members:manage] — the enterprise alternative to public self-service
// sign-up (which is disabled): the internal team creates accounts here, then hands
// the credentials to the user (who can also sign in via SSO later).
router.post("/current/members/provision", requirePermission(PERMISSIONS.MEMBERS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const b = req.body || {};
  const result = await orgService.provisionUser({ orgId, actorId: req.user.userId, email: b.email, name: b.name, password: b.password, role: b.role || "member" });
  res.json(ok(result));
  await record({
    actorId: req.user.userId,
    action: "org.member.provision",
    targetType: "user",
    targetId: result.userId,
    detail: { role: b.role || "member" },
  });
  await orgActivity(req, orgId, (org, actorName, roleName) =>
    notifService.notifyOrgMemberAdded({
      userId: result.userId,
      actorName,
      orgName: org?.name || "an organization",
      roleName: roleName(result.role),
      orgId,
    }),
  );
});

// Reset a member's password (forgotten-password recovery). The admin sets a new
// password and hands it to the user — the secure alternative to storing passwords
// reversibly. Passwords stay one-way scrypt hashes. [members:manage]
router.post("/current/members/:userId/reset-password", requirePermission(PERMISSIONS.MEMBERS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  res.json(
    ok(
      await orgService.resetMemberPassword({
        orgId,
        actorId: req.user.userId,
        userId: req.params.userId,
        password: (req.body || {}).password,
      }),
    ),
  );
});

// Change a member's role (guards the >=1-owner invariant). [members:manage]
router.patch("/current/members/:userId", requirePermission(PERMISSIONS.MEMBERS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const role = (req.body || {}).role;
  const result = await orgService.setMemberRole({ orgId, actorId: req.user.userId, userId: req.params.userId, role });
  res.json(ok(result));
  await record({
    actorId: req.user.userId,
    action: "org.member.role_change",
    targetType: "user",
    targetId: req.params.userId,
    detail: { role },
  });
  await orgActivity(
    req,
    orgId,
    (org, actorName, roleName) =>
      notifService.notifyOrgRoleChanged({
        userId: req.params.userId,
        actorName,
        orgName: org?.name || "your organization",
        roleName: roleName(role),
        orgId,
      }),
    // Skip when an admin re-ranks THEMSELF — they don't need telling.
    req.params.userId,
  );
});

// Remove a member (guards the >=1-owner invariant). Accepts an optional reason
// (BA #1) in the body — audited + echoed to the removed user. [members:manage]
router.delete("/current/members/:userId", requirePermission(PERMISSIONS.MEMBERS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const reason = String((req.body || {}).reason || "").trim().slice(0, 500) || null;
  const out = await orgService.removeMember({ orgId, userId: req.params.userId, actorId: req.user.userId, reason });
  // conversationIds is internal plumbing for the socket eviction below — the
  // admin caller only needs the removal outcome.
  const { conversationIds = [], ...pub } = out as any;
  res.json(ok(pub));
  if (out.removed) {
    // TOTAL ACCESS CLEANUP: eject the removed member's live sockets from every
    // org conversation room and tell their devices membership ended.
    void evictFromOrg(req.app.get("io"), req.params.userId, orgId, conversationIds);
    await record({
      actorId: req.user.userId,
      action: "org.member.remove",
      targetType: "user",
      targetId: req.params.userId,
      detail: { reason },
    });
    await orgActivity(
      req,
      orgId,
      (org, actorName) =>
        notifService.notifyOrgMemberRemoved({
          userId: req.params.userId,
          actorName,
          orgName: org?.name || "the organization",
          orgId,
          reason,
        }),
      // Self-removal (leaving the org) must not toast the leaver with
      // "You were removed by <their own name>".
      req.params.userId,
    );
  }
});

// Leave the organization YOURSELF (self-serve — auth only, deliberately NOT
// members:manage: leaving is a personal action, not member administration). The
// >=1-owner invariant still applies — a sole owner gets 409 LAST_OWNER ("Transfer
// ownership before leaving...") instead. On success the session is pivoted to
// another org (nextOrgId), so the caller lands somewhere valid; null = none left.
router.post("/current/leave", async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const out = await orgService.leaveOrg({
    orgId,
    userId: req.user.userId,
    sessionId: req.user.jti || null,
  });
  const { conversationIds = [], ...pub } = out as any;
  res.json(ok(pub)); // { removed, reason, orgName, nextOrgId }
  if (out.removed) {
    // TOTAL ACCESS CLEANUP: eject the leaver's live sockets from every org
    // conversation room and tell their other devices membership ended (they pivot too).
    void evictFromOrg(req.app.get("io"), req.user.userId, orgId, conversationIds);
    await record({
      actorId: req.user.userId,
      action: "org.member.leave",
      targetType: "org",
      targetId: orgId,
      detail: { orgName: out.orgName },
    });
    // Tell the remaining owners/admins (members:manage holders) that a member left.
    void notifyManagersMemberLeft(req, orgId, req.user.userId);
  }
});

// Fan out a "member left" notification to everyone who can manage members
// (owner/admin + any custom role granted members:manage) — mirrors the
// join-request-received fan-out. Best-effort, after the response. The leaver is
// already soft-deleted, so they're naturally excluded from the roster.
async function notifyManagersMemberLeft(req: any, orgId: string, leaverId: string) {
  try {
    const io = req.app.get("io");
    const [roster, leaver, org, roles] = await Promise.all([
      db.orgs.members(orgId),
      db.users.getById(leaverId),
      db.orgs.getById(orgId),
      db.orgs.roleCatalog(orgId),
    ]);
    const managerRoles = new Set(
      (roles || [])
        .filter((r: any) => (r.permissions || []).includes(PERMISSIONS.MEMBERS_MANAGE))
        .map((r: any) => r.key),
    );
    managerRoles.add("owner");
    managerRoles.add("admin");
    for (const a of (roster || []).filter(
      (mm: any) => managerRoles.has(mm.role) && mm.status === "active" && mm.userId !== leaverId,
    )) {
      const n = await notifService.notifyOrgMemberLeft({
        userId: a.userId,
        memberName: leaver?.name || "A member",
        orgName: org?.name || "the organization",
        orgId,
      });
      if (n && io) pushNotif(io, n);
    }
  } catch (_) {
    /* best-effort */
  }
}

// Teams in the org + the role catalog (for the admin pickers).
router.get("/current/teams", async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  res.json(ok(await db.orgs.teams(orgId)));
});
router.get("/current/roles", async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  res.json(ok(await db.orgs.roleCatalog(orgId)));
});

// The grantable permission catalog — powers the custom-role editor. Also read by
// the member-facing "What can each role do?" info panel (BA #3), so any active
// member may fetch it (it's static, non-sensitive descriptive text).
router.get("/current/permissions", (_req, res) => {
  res.json(ok(PERMISSION_CATALOG));
});

// ── Org activity feed (BA #4) ────────────────────────────────────────────────
// The org's audit trail — who approved/rejected whom, role changes, removals,
// settings updates. [audit:view] (owner + admin by default; grantable).
router.get("/current/audit", requirePermission(PERMISSIONS.AUDIT_VIEW), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  res.json(ok(await db.audit.listForOrg(orgId, Number(req.query.limit) || 100)));
});

// ── Org-wide broadcasts (BA #6) ──────────────────────────────────────────────
// Owners/admins (org:manage) post an announcement to EVERY member; delivery
// rides the notifications pipeline (socket + web push + OS). Any active member
// may LIST them (read-only view in the org panel, BA #3).
router.post("/current/broadcasts", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const b = req.body || {};
  const title = String(b.title || "").trim().slice(0, 255);
  const body = String(b.body || "").trim().slice(0, 4000);
  if (!title) return res.status(400).json(fail("TITLE_REQUIRED", "Give the broadcast a title."));
  // Optional SCHEDULED send: a future sendAt parks the broadcast for the poller
  // instead of delivering now. A past/'now' time is treated as immediate rather
  // than rejected — the composer clamps, and a second of clock skew shouldn't
  // 400 an announcement.
  let sendAt: string | null = null;
  if (b.sendAt) {
    const when = new Date(b.sendAt);
    if (Number.isNaN(when.getTime()))
      return res.status(400).json(fail("BAD_TIME", "Pick a valid date and time."));
    if (when.getTime() > Date.now() + 5000) sendAt = when.toISOString();
  }
  const created = await db.orgs.createBroadcast(orgId, req.user.userId, title, body || null, {
    sendAt,
    fileId: b.fileId || null,
  });
  res.status(201).json(ok(created));
  await record({
    actorId: req.user.userId,
    action: sendAt ? "org.broadcast.schedule" : "org.broadcast.send",
    targetType: "org",
    targetId: orgId,
    detail: { broadcastId: created?.id, title, sendAt },
  });
  // Scheduled → the poller delivers it at send time. Immediate → fan out now,
  // AFTER the response (best-effort). Both go through the same service routine,
  // so a queued announcement is identical to an instant one.
  if (sendAt) return;
  try {
    const io = req.app.get("io");
    const { notifications } = await broadcastService.deliver(created);
    for (const n of notifications) if (io) pushNotif(io, n);
  } catch (_) {
    /* best-effort */
  }
});
// Delete a broadcast FOR EVERYONE — a queued one (also cancelling it) or an
// already-sent one (it leaves every member's list). [org:manage]
router.delete("/current/broadcasts/:id", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const out = await db.orgs.deleteBroadcast(req.params.id, orgId);
  if (out.deleted)
    await record({
      actorId: req.user.userId,
      action: "org.broadcast.delete",
      targetType: "org",
      targetId: orgId,
      detail: { broadcastId: req.params.id },
    });
  res.json(ok(out));
});
// Edit a broadcast FOR EVERYONE. Editing a QUEUED one changes what gets
// delivered; editing a SENT one updates the announcement in the org page but
// does NOT re-notify (that notification already went out). [org:manage]
router.patch("/current/broadcasts/:id", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const b = req.body || {};
  const patch: any = {};
  if (b.title !== undefined) {
    const t = String(b.title || "").trim();
    if (!t) return res.status(400).json(fail("TITLE_REQUIRED", "Give the broadcast a title."));
    patch.title = t;
  }
  if (b.body !== undefined) patch.body = String(b.body || "").trim();
  if (b.sendAt !== undefined) {
    if (b.sendAt === null) patch.sendAt = null;
    else {
      const when = new Date(b.sendAt);
      if (Number.isNaN(when.getTime()))
        return res.status(400).json(fail("BAD_TIME", "Pick a valid date and time."));
      patch.sendAt = when.toISOString();
    }
  }
  const updated = await db.orgs.updateBroadcast(req.params.id, orgId, patch);
  if (!updated) return res.status(404).json(fail("NOT_FOUND", "That broadcast couldn't be found."));
  res.json(ok(updated));
  await record({
    actorId: req.user.userId,
    action: "org.broadcast.edit",
    targetType: "org",
    targetId: orgId,
    detail: { broadcastId: req.params.id, title: updated.title },
  });
});
router.get("/current/broadcasts", async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  // Only managers see what is still QUEUED — a scheduled announcement must not
  // leak to the org before its send time.
  const canManage = await can(req.user.userId, orgId, PERMISSIONS.ORG_MANAGE);
  res.json(ok(await db.orgs.listBroadcasts(orgId, Number(req.query.limit) || 50, canManage)));
});

// Create / edit / delete CUSTOM roles (roles:manage). Built-in roles are immutable;
// the service clamps rank + permissions to the actor's own ceiling.
router.post("/current/roles", requirePermission(PERMISSIONS.ROLES_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const b = req.body || {};
  res.json(ok(await orgService.createRole({ orgId, actorId: req.user.userId, name: b.name, rank: b.rank, permissions: b.permissions })));
});
router.patch("/current/roles/:roleId", requirePermission(PERMISSIONS.ROLES_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const b = req.body || {};
  res.json(ok(await orgService.updateRole({ orgId, actorId: req.user.userId, roleId: req.params.roleId, name: b.name, permissions: b.permissions })));
});
router.delete("/current/roles/:roleId", requirePermission(PERMISSIONS.ROLES_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  res.json(ok(await orgService.deleteRole({ orgId, roleId: req.params.roleId })));
});

// Self-serve department pick — a member sets their OWN primary team.
router.post("/current/my-team", async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  res.json(
    ok(await orgService.setMyTeam({ orgId, userId: req.user.userId, teamId: (req.body || {}).teamId || null })),
  );
});

// Create a team / sub-team (teams:manage). Optional parentTeamId nests it.
router.post("/current/teams", requirePermission(PERMISSIONS.TEAMS_MANAGE), async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  const body = req.body || {};
  res.json(ok(await orgService.createTeam({ orgId, name: body.name, parentTeamId: body.parentTeamId || null })));
});

// Multi-team self-serve join/leave — a member toggles their OWN membership in a team.
router.post("/current/teams/:teamId/membership", async (req, res) => {
  const orgId = activeOrg(req, res);
  if (!orgId) return;
  res.json(
    ok(
      await orgService.setTeamMembership({
        orgId,
        userId: req.user.userId,
        teamId: req.params.teamId,
        join: !!(req.body || {}).join,
      }),
    ),
  );
});

// ── External Data API keys (org-scoped) ─────────────────────────────────────
// An org admin mints keys that other platforms use to READ this organization's
// data through /api/external/v1 (docs/EXTERNAL_DATA_API.html). The key is
// returned ONCE from create/rotate and stored only as a hash. Everything here
// is pinned to the session's active org — a key can never be minted for, or
// managed from, another tenant.
function apiKeyError(res, e) {
  if (e && e.status && e.status < 500) return res.status(e.status).json(fail(e.code || "BAD_REQUEST", e.message));
  throw e;
}
router.get("/current/api-keys", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  try {
    res.json(ok(await externalApi.listKeys({ orgId: req.org.id })));
  } catch (e) {
    return apiKeyError(res, e);
  }
});
router.post("/current/api-keys", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const { name, scopes, expiresAt, userId } = req.body || {};
  let out;
  try {
    out = await externalApi.createKey({ orgId: req.org.id, name, scopes, expiresAt, userId: userId || null, createdBy: req.user.userId });
  } catch (e) {
    return apiKeyError(res, e);
  }
  await record({
    actorId: req.user.userId,
    action: "org.api_key.create",
    targetType: "api_key",
    targetId: out.apiKey.id,
    detail: { name: out.apiKey.name, scopes: out.apiKey.scopes, expiresAt: out.apiKey.expiresAt, userId: out.apiKey.userId },
  });
  res.status(201).json(ok(out));
});
router.post("/current/api-keys/:id/rotate", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  let out;
  try {
    out = await externalApi.rotateKey(req.params.id, { orgId: req.org.id });
  } catch (e) {
    return apiKeyError(res, e);
  }
  await record({ actorId: req.user.userId, action: "org.api_key.rotate", targetType: "api_key", targetId: out.apiKey.id });
  res.json(ok(out));
});
router.delete("/current/api-keys/:id", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  let apiKey;
  try {
    apiKey = await externalApi.revokeKey(req.params.id, { orgId: req.org.id, by: req.user.userId });
  } catch (e) {
    return apiKeyError(res, e);
  }
  await record({ actorId: req.user.userId, action: "org.api_key.revoke", targetType: "api_key", targetId: apiKey.id });
  res.json(ok(apiKey));
});

export default router;
