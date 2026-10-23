import { db } from "../platform";
import { invalidatePermissions, invalidateAllPermissions, permissionsFor, GRANTABLE_PERMISSIONS } from "./rbacService";
import { createLocalUser, setUserPassword } from "./authService";
import { invalidateMembership } from "../middleware/auth";

// Organizations product service (#70) — provisioning, org switching, member + role
// administration, teams, settings. The ROUTE layer gates each mutation behind an
// RBAC permission (requirePermission); this layer enforces the DATA invariants that
// can't be a permission check: valid role keys, and the ">= 1 active owner" rule
// (an org must never be left ownerless). All operations are org-scoped by the
// caller's ACTIVE org (req.org.id).

// Role seniority FALLBACK for the built-in roles (owner=100 … guest=20) plus the exec
// tier from migration 0075. orgRoleRanks() overlays the LIVE role catalog on top, so
// org-CUSTOM roles (and any re-ranked role) resolve correctly. Keeping the fallback
// means the built-in roles still work even if the RBAC catalog hasn't been seeded yet
// (fail-safe for the system roles, rather than blocking all member management).
const ROLE_RANK: Record<string, number> = {
  owner: 100,
  admin: 80,
  member: 40,
  guest: 20,
};

// The org's role → rank map: the system fallback overlaid with the live catalog
// (which includes org-custom roles). A role is VALID iff it's present in this map.
async function orgRoleRanks(orgId: string): Promise<Map<string, number>> {
  const ranks = new Map<string, number>(Object.entries(ROLE_RANK));
  try {
    for (const r of (await db.orgs.roleCatalog(orgId)) || []) ranks.set(r.key, Number(r.rank) || 0);
  } catch {
    /* keep the fallback if the catalog can't be read */
  }
  return ranks;
}

// A member's rank via a pre-resolved rank map (0 if not an active member).
async function memberRank(orgId: string, userId: string, ranks: Map<string, number>): Promise<number> {
  if (!userId) return 0;
  const m = await db.orgs.membership(userId, orgId);
  return m && m.status === "active" ? (ranks.get(m.role) || 0) : 0;
}

// Max orgs a single user may create/own via self-serve provisioning. Generous
// enough never to block real use; caps unbounded org-spam from one account.
const MAX_OWNED_ORGS = Number(process.env.MAX_OWNED_ORGS || 25) || 25;

function httpErr(status: number, code: string, message: string) {
  const e: any = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// The actor's rank in the org (0 if not an active member). The invariant enforced
// everywhere below: you may never grant, nor act on, a role ABOVE your own rank.
async function actorRank(orgId: string, actorId: string): Promise<number> {
  return memberRank(orgId, actorId, await orgRoleRanks(orgId));
}
// Rank of a role from the org catalog (system fallback overlaid). -1 = unknown role.
async function roleRank(orgId: string, role: string): Promise<number> {
  const r = (await orgRoleRanks(orgId)).get(role);
  return r === undefined ? -1 : r;
}
// Is `role` a real role in this org (system or org-custom)?
async function validRole(orgId: string, role: string): Promise<boolean> {
  return (await orgRoleRanks(orgId)).has(role);
}

// A URL-safe, lowercase slug from a name; uniquified against existing orgs.
async function uniqueSlug(name: string): Promise<string> {
  const base =
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "org";
  let slug = base;
  for (let i = 2; i < 1000; i++) {
    const clash = await db.orgs.getBySlug(slug);
    if (!clash) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

// Provision a NEW org with the caller as its first owner. Returns the org.
export async function provision({ userId, name }: { userId: string; name: string }) {
  const clean = String(name || "").trim();
  if (clean.length < 2) throw httpErr(400, "ORG_NAME_INVALID", "Organization name is too short.");
  if (clean.length > 120) throw httpErr(400, "ORG_NAME_INVALID", "Organization name is too long.");
  // Anti-abuse quota: cap how many orgs one account can create/own. Provisioning
  // is otherwise open to any authenticated user, so without a ceiling a single
  // account could spawn unlimited tenants.
  const owned = (await db.orgs.listForUser(userId)).filter((o: any) => o.role === "owner").length;
  if (owned >= MAX_OWNED_ORGS)
    throw httpErr(429, "ORG_QUOTA", "You've reached the maximum number of organizations you can create.");
  const slug = await uniqueSlug(clean);
  return db.orgs.create({ name: clean, slug, kind: "team", ownerId: userId });
}

// Switch the caller's active org. Fails CLOSED if they aren't an active member of the
// target (you can't assert a tenant you don't belong to). Updates the session row.
export async function switchOrg({
  userId,
  sessionId,
  orgId,
}: {
  userId: string;
  sessionId: string | null;
  orgId: string;
}) {
  if (!sessionId)
    throw httpErr(400, "NO_SESSION", "This token has no session to switch (please re-login).");
  const m = await db.orgs.membership(userId, orgId);
  if (!m || m.status !== "active")
    throw httpErr(403, "NOT_A_MEMBER", "You are not a member of that organization.");
  await db.sessions.setActiveOrg(sessionId, userId, orgId);
  return { activeOrgId: orgId, role: m.role };
}

// ── Enterprise onboarding: organization join requests ────────────────────────
// A platform user who belongs to no org (or wants another) REQUESTS to join by
// its CODE (slug) or an invite link; owners/admins approve. Approval is the only
// path here that creates a membership (invitations still add directly — see
// addMemberByEmail). Discovery-by-NAME was intentionally removed: the tenant list
// is sensitive, so there is no "search/list all orgs" capability — you must already
// know the code or link.

// Resolve a join target by id OR slug — slug is the shareable "organization code".
async function resolveJoinTarget(orgId?: string, slug?: string) {
  let org: any = null;
  if (orgId) org = await db.orgs.getById(orgId);
  if (!org && slug) org = await db.orgs.getBySlug(String(slug).trim().toLowerCase());
  return org;
}

// Create (or re-open) a pending join request. Fails fast if the org is gone/personal
// or the caller is already a member. Idempotent: a live pending request is returned.
export async function requestJoin({
  userId, orgId, slug, message,
}: { userId: string; orgId?: string; slug?: string; message?: string }) {
  const org = await resolveJoinTarget(orgId, slug);
  if (!org || org.status !== "active" || org.kind === "personal")
    throw httpErr(404, "ORG_NOT_FOUND", "That organization couldn't be found.");
  const existing = await db.orgs.membership(userId, org.id);
  if (existing && existing.status === "active")
    throw httpErr(409, "ALREADY_MEMBER", "You're already a member of that organization.");
  const req = await db.orgs.createJoinRequest(org.id, userId, message || null);
  return { request: req, org: { id: org.id, name: org.name, slug: org.slug } };
}

// The caller's own requests — powers the onboarding "Request Sent" state.
export async function myJoinRequests({ userId }: { userId: string }) {
  return db.orgs.joinRequestsForUser(userId);
}

// Admin: the active org's pending requests.
export async function listJoinRequests({ orgId }: { orgId: string }) {
  return db.orgs.listJoinRequests(orgId, "pending");
}

// Admin: approve or reject a request. Approve → add the user as a plain 'member'
// (the enterprise default role) and stamp the request approved; reject → mark it
// rejected. Returns the decided request + affected userId so the route can notify.
export async function decideJoinRequest({
  requestId, orgId, actorId, approve, reason = null,
}: { requestId: string; orgId: string; actorId: string; approve: boolean; reason?: string | null }) {
  const req = await db.orgs.joinRequest(requestId);
  if (!req || req.organizationId !== orgId)
    throw httpErr(404, "REQUEST_NOT_FOUND", "That request couldn't be found.");
  if (req.status !== "pending")
    throw httpErr(409, "REQUEST_DECIDED", "That request has already been handled.");
  // ATOMIC first-action-wins (BA #2): claim the pending row BEFORE any side
  // effect. The conditional UPDATE (…WHERE status='pending') lands for exactly
  // one of two racing admins; the loser 409s here and never runs addMember —
  // so a reject can't be followed by a stale approve (or vice versa).
  const { claimed, request: updated } = await db.orgs.setJoinRequestStatus(
    requestId,
    approve ? "approved" : "rejected",
    actorId,
    reason,
  );
  if (!claimed)
    throw httpErr(409, "REQUEST_DECIDED", "That request has already been handled.");
  if (approve) {
    // Only add as 'member' if they aren't ALREADY an active member — otherwise a
    // stale request approved after an admin directly added them (e.g. as admin)
    // would silently DOWNGRADE their role via addMember's role-overwrite upsert.
    const existing = await db.orgs.membership(req.userId, orgId);
    if (!existing || existing.status !== "active") {
      await db.orgs.addMember(orgId, req.userId, "member");
      invalidatePermissions(req.userId, orgId);
      // A returning ex-member must not ride a stale cached "not a member"
      // decision into 403s — mirror the invalidation done on removal.
      invalidateMembership(req.userId, orgId);
    }
  }
  return { request: updated, userId: req.userId, approved: approve, reason: reason || null };
}

// Add an EXISTING Collab user to the org by email (internal roster mapping). Email
// invites for users who don't yet have an account are a follow-up; here we require
// the account to exist so we never create a shell user from an unverified email.
export async function addMemberByEmail({
  orgId,
  actorId,
  email,
  role = "member",
}: {
  orgId: string;
  actorId: string;
  email: string;
  role?: string;
}) {
  const mail = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail))
    throw httpErr(400, "EMAIL_INVALID", "Enter a valid email address.");
  if (!(await validRole(orgId, role))) throw httpErr(400, "ROLE_INVALID", "Unknown role.");
  // Rank ceiling: you can't invite someone at a role above your own (a Manager
  // must not be able to add an Owner).
  if ((await roleRank(orgId, role)) > (await actorRank(orgId, actorId)))
    throw httpErr(403, "ROLE_TOO_HIGH", "You can't assign a role higher than your own.");
  const user = await db.users.getByEmail(mail);
  if (!user)
    throw httpErr(
      404,
      "USER_NOT_FOUND",
      // AUDIT P3 (#49): point admins to the action they CAN take instead of a dead end.
      "No Collab account has that email yet. Use “Create a new user” to provision one (or have them sign in via SSO once), then they’ll be added automatically.",
    );
  // AUDIT P0: db.orgs.addMember uses ON DUPLICATE KEY UPDATE role=…, so re-adding an
  // EXISTING member silently OVERWRITES their role — a back-door around the guarded
  // role-change path. If the target is already an active member, enforce the same
  // invariants setMemberRole does: you can't change someone who outranks you, and you
  // can't demote the last owner (which would brick the tenant with zero owners).
  const existing = await db.orgs.membership(user.id, orgId);
  if (existing && existing.status === "active") {
    const arank = await actorRank(orgId, actorId);
    if ((await roleRank(orgId, existing.role)) > arank)
      throw httpErr(403, "ROLE_TOO_HIGH", "You can't change a member who outranks you.");
    if (existing.role === "owner" && role !== "owner") {
      const owners = await db.orgs.ownerCount(orgId);
      if (owners <= 1)
        throw httpErr(
          409,
          "LAST_OWNER",
          "This is the only owner. Promote another member to owner first.",
        );
    }
  }
  const m = await db.orgs.addMember(orgId, user.id, role);
  invalidatePermissions(user.id, orgId);
  // Symmetric to removal: a RE-ADDED member may still ride a cached "not a
  // member" decision in the auth gate for up to 30s and get 403'd despite the
  // fresh row. Drop it so access is immediate in both directions.
  invalidateMembership(user.id, orgId);
  return { userId: user.id, ...m };
}

// Admin PROVISIONING — the enterprise counterpart to (disabled) public sign-up:
// create a brand-new local username/password account AND add it to the caller's
// active org in one step. Gated by members:manage at the route; here it enforces
// the same rank ceiling as role assignment (you can't provision someone above your
// own rank) and the server-side credential policy (via createLocalUser). If the
// email already has an account, the caller should use addMemberByEmail instead.
export async function provisionUser({
  orgId,
  actorId,
  email,
  name,
  password,
  role = "member",
}: {
  orgId: string;
  actorId: string;
  email: string;
  name?: string;
  password: string;
  role?: string;
}) {
  if (!(await validRole(orgId, role))) throw httpErr(400, "ROLE_INVALID", "Unknown role.");
  if ((await roleRank(orgId, role)) > (await actorRank(orgId, actorId)))
    throw httpErr(403, "ROLE_TOO_HIGH", "You can't provision a member at a role higher than your own.");
  const mail = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail))
    throw httpErr(400, "EMAIL_INVALID", "Enter a valid email address.");
  if (await db.users.getByEmail(mail))
    throw httpErr(
      409,
      "USER_EXISTS",
      "An account with that email already exists — use “Add member” to add them to this organization.",
    );
  // Enforces email + password-strength policy; throws 400 on a weak/invalid input.
  const user = await createLocalUser({ email: mail, name, password });
  const m = await db.orgs.addMember(orgId, user.id, role);
  invalidatePermissions(user.id, orgId);
  return { userId: user.id, email: user.email, name: user.name, ...m };
}

// Change a member's role, guarding the >=1-active-owner invariant (never demote the
// last owner). Idempotent; invalidates the member's cached permissions.
export async function setMemberRole({
  orgId,
  actorId,
  userId,
  role,
}: {
  orgId: string;
  actorId: string;
  userId: string;
  role: string;
}) {
  if (!(await validRole(orgId, role))) throw httpErr(400, "ROLE_INVALID", "Unknown role.");
  const current = await db.orgs.membership(userId, orgId);
  if (!current || current.status !== "active")
    throw httpErr(404, "NOT_A_MEMBER", "That user is not a member of this organization.");
  // Rank ceiling (closes admin→owner self-promotion): you can neither grant a role
  // above your own rank, nor change a member who already outranks you.
  const arank = await actorRank(orgId, actorId);
  if ((await roleRank(orgId, role)) > arank)
    throw httpErr(403, "ROLE_TOO_HIGH", "You can't assign a role higher than your own.");
  if ((await roleRank(orgId, current.role)) > arank)
    throw httpErr(403, "ROLE_TOO_HIGH", "You can't change a member who outranks you.");
  if (current.role === "owner" && role !== "owner") {
    const owners = await db.orgs.ownerCount(orgId);
    if (owners <= 1)
      throw httpErr(
        409,
        "LAST_OWNER",
        "This is the only owner. Promote another member to owner first.",
      );
  }
  const m = await db.orgs.setMemberRole(orgId, userId, role);
  invalidatePermissions(userId, orgId);
  return m;
}

// Admin-initiated password reset for a member (forgotten-password recovery). This
// is the secure alternative to reversible/decryptable password storage: hashes are
// one-way, so recovery means the admin sets a NEW password and hands it over. The
// route gates this behind [members:manage]; here we enforce the DATA invariants:
//   • the target is an active member of THIS org (no cross-org resets), and
//   • rank ceiling — you can't reset a member who outranks you (an admin can't seize
//     an owner's account), mirroring setMemberRole.
// The password is validated + scrypt-hashed by authService.setUserPassword.
export async function resetMemberPassword({
  orgId,
  actorId,
  userId,
  password,
}: {
  orgId: string;
  actorId: string;
  userId: string;
  password: string;
}) {
  const current = await db.orgs.membership(userId, orgId);
  if (!current || current.status !== "active")
    throw httpErr(404, "NOT_A_MEMBER", "That user is not a member of this organization.");
  if ((await roleRank(orgId, current.role)) > (await actorRank(orgId, actorId)))
    throw httpErr(403, "ROLE_TOO_HIGH", "You can't reset the password of a member who outranks you.");
  const result = await setUserPassword(userId, password);
  return { userId: result.userId, email: result.email, name: result.name };
}

// Remove a member, guarding the >=1-active-owner invariant.
export async function removeMember({
  orgId,
  userId,
  actorId,
  reason = null,
}: {
  orgId: string;
  userId: string;
  actorId: string;
  reason?: string | null;
}) {
  const current = await db.orgs.membership(userId, orgId);
  if (!current || current.status !== "active") return { removed: false };
  // Rank ceiling: you can't remove a member who outranks you (an Admin must not
  // be able to remove an Owner). Self-removal is allowed (equal rank).
  if (userId !== actorId && (await roleRank(orgId, current.role)) > (await actorRank(orgId, actorId)))
    throw httpErr(403, "ROLE_TOO_HIGH", "You can't remove a member who outranks you.");
  if (current.role === "owner") {
    const owners = await db.orgs.ownerCount(orgId);
    if (owners <= 1)
      throw httpErr(
        409,
        "LAST_OWNER",
        "You can't remove the only owner. Transfer ownership first.",
      );
  }
  const out = await db.orgs.removeMember(orgId, userId, actorId, reason);
  // TOTAL ACCESS CLEANUP (enterprise parity): revoke every org-scoped
  // conversation membership + meeting invite in the same stroke, and drop the
  // cached "is a member" decisions so the very next request re-checks and is
  // rejected. The route follows up by ejecting their live sockets. Purge
  // failure is logged loudly but doesn't 500 the request — the membership row
  // is already gone, so the REST gate holds regardless.
  let conversationIds: string[] = [];
  if (out.removed) {
    try {
      conversationIds = (await db.orgs.purgeMemberAccess(orgId, userId, actorId)).conversationIds || [];
    } catch (e: any) {
      console.error("[org] member-removal access purge FAILED org=%s user=%s: %s", orgId, userId, e?.message || e);
    }
  }
  invalidatePermissions(userId, orgId);
  invalidateMembership(userId, orgId);
  return { ...out, reason: reason || null, conversationIds };
}

// Leave the organization YOURSELF (self-serve — the ROUTE is auth-only, NOT
// members:manage). A member self-removes; this reuses removeMember (which skips
// the rank ceiling for a self-action and re-checks the >=1-owner invariant), then
// pivots this session to another org the user still belongs to so they aren't
// stranded on a membership they no longer hold.
//
// Governance: the LAST owner cannot leave and orphan the tenant — they must hand
// ownership over first (409 LAST_OWNER → "Transfer ownership before leaving..."),
// exactly as an admin can't remove the sole owner.
export async function leaveOrg({
  orgId,
  userId,
  sessionId = null,
}: {
  orgId: string;
  userId: string;
  sessionId?: string | null;
}) {
  const m = await db.orgs.membership(userId, orgId);
  if (!m || m.status !== "active")
    throw httpErr(404, "NOT_A_MEMBER", "You are not a member of this organization.");
  const org = await db.orgs.getById(orgId);
  if (!org || org.status !== "active")
    throw httpErr(404, "ORG_NOT_FOUND", "That organization no longer exists.");
  // A personal workspace is your own single-tenant space — there is nothing to leave.
  if (org.kind === "personal")
    throw httpErr(400, "PERSONAL_ORG", "You can't leave your personal workspace.");
  if (m.role === "owner") {
    const owners = await db.orgs.ownerCount(orgId);
    if (owners <= 1)
      throw httpErr(409, "LAST_OWNER", "Transfer ownership before leaving this organization.");
  }
  const out = await removeMember({ orgId, userId, actorId: userId, reason: "Left the organization" });
  // Pivot the session to the next org (switcher's default precedence: owner, then
  // admin, then oldest membership). null → no orgs remain, and the client routes
  // to the organization selection / onboarding experience.
  let nextOrgId: string | null = null;
  if (out.removed) {
    try {
      nextOrgId = await db.orgs.primaryForUser(userId);
      if (nextOrgId && sessionId) await db.sessions.setActiveOrg(sessionId, userId, nextOrgId);
    } catch (e: any) {
      console.error("[org] leave: next-org pivot failed user=%s: %s", userId, e?.message || e);
    }
  }
  return { ...out, orgName: org.name, nextOrgId };
}

// Self-serve department pick — a member sets their OWN primary team.
export async function setMyTeam({
  orgId,
  userId,
  teamId,
}: {
  orgId: string;
  userId: string;
  teamId: string | null;
}) {
  if (teamId) {
    const ok = await db.orgs.teamInOrg(orgId, teamId);
    if (!ok) throw httpErr(404, "TEAM_NOT_FOUND", "That team isn't in this organization.");
  }
  return db.orgs.setMemberTeam(orgId, userId, teamId || null);
}

// Multi-team self-serve join/leave — a member toggles their OWN membership in a team.
// A member can belong to several teams at once (e.g. a CEO in Executive AND Product).
export async function setTeamMembership({
  orgId,
  userId,
  teamId,
  join,
}: {
  orgId: string;
  userId: string;
  teamId: string;
  join: boolean;
}) {
  if (!teamId) throw httpErr(400, "TEAM_REQUIRED", "Missing team.");
  const ok = await db.orgs.teamInOrg(orgId, teamId);
  if (!ok) throw httpErr(404, "TEAM_NOT_FOUND", "That team isn't in this organization.");
  return db.orgs.setTeamMembership(orgId, userId, teamId, !!join);
}

// Create a team, optionally nested under a parent (sub-department). Gated by
// teams:manage at the route. Maps the driver's structured error to an HTTP error.
export async function createTeam({
  orgId,
  name,
  parentTeamId,
}: {
  orgId: string;
  name: string;
  parentTeamId?: string | null;
}) {
  const r = await db.orgs.createTeam(orgId, name, parentTeamId || null);
  if (r.error === "NAME_REQUIRED") throw httpErr(400, "NAME_REQUIRED", "Team name is required.");
  if (r.error === "PARENT_NOT_FOUND") throw httpErr(404, "PARENT_NOT_FOUND", "That parent team isn't in this organization.");
  if (r.error === "TOO_DEEP") throw httpErr(400, "TOO_DEEP", "Teams can nest up to 5 levels deep.");
  if (r.error === "DUPLICATE") throw httpErr(409, "DUPLICATE", "A team with that name already exists here.");
  return r.team;
}

// Filter requested permissions to those the actor may actually grant: grantable
// (org:delete is excluded) AND held by the actor themselves — so a roles:manage user
// can't escalate by minting a role with a permission they don't have.
async function grantablePerms(orgId: string, actorId: string, requested: string[]): Promise<string[]> {
  const mine = await permissionsFor(actorId, orgId);
  return [...new Set((requested || []).map(String))].filter((p) => GRANTABLE_PERMISSIONS.has(p) && mine.has(p));
}

// Create an org-CUSTOM role (Zoho-style custom profile). Two ceilings: its rank is
// clamped strictly BELOW the actor's (can't mint a role that outranks you), and its
// permissions are limited to ones the actor holds. Gated by roles:manage at the route.
export async function createRole({
  orgId,
  actorId,
  name,
  rank,
  permissions,
}: {
  orgId: string;
  actorId: string;
  name: string;
  rank?: number;
  permissions?: string[];
}) {
  const aRank = await actorRank(orgId, actorId);
  const safeRank = Math.max(1, Math.min(Number(rank) || 40, aRank - 1));
  const perms = await grantablePerms(orgId, actorId, permissions || []);
  const r = await db.orgs.createRole(orgId, name, safeRank, perms);
  if (r.error === "NAME_REQUIRED") throw httpErr(400, "NAME_REQUIRED", "Role name is required.");
  if (r.error === "DUPLICATE") throw httpErr(409, "DUPLICATE", "A role with that name already exists.");
  invalidateAllPermissions();
  return r.role;
}

// Edit a custom role — rename and/or replace permissions (same permission ceiling).
export async function updateRole({
  orgId,
  actorId,
  roleId,
  name,
  permissions,
}: {
  orgId: string;
  actorId: string;
  roleId: string;
  name?: string;
  permissions?: string[];
}) {
  const patch: { name?: string; permissions?: string[] } = {};
  if (typeof name === "string") patch.name = name;
  if (Array.isArray(permissions)) patch.permissions = await grantablePerms(orgId, actorId, permissions);
  const r = await db.orgs.updateRole(orgId, roleId, patch);
  if (r.error === "NOT_FOUND") throw httpErr(404, "NOT_FOUND", "Role not found.");
  if (r.error === "SYSTEM_ROLE") throw httpErr(400, "SYSTEM_ROLE", "Built-in roles can't be edited.");
  invalidateAllPermissions();
  return { ok: true };
}

// Delete a custom role — never a built-in, never one still assigned to a member.
export async function deleteRole({ orgId, roleId }: { orgId: string; roleId: string }) {
  const r = await db.orgs.deleteRole(orgId, roleId);
  if (r.error === "NOT_FOUND") throw httpErr(404, "NOT_FOUND", "Role not found.");
  if (r.error === "SYSTEM_ROLE") throw httpErr(400, "SYSTEM_ROLE", "Built-in roles can't be deleted.");
  if (r.error === "IN_USE") throw httpErr(409, "IN_USE", "Reassign members off this role before deleting it.");
  invalidateAllPermissions();
  return { ok: true };
}

// The active-org context bundle the client needs to render org UI: the org, the
// caller's role, the teams they belong to, and their resolved permissions.
export async function currentContext({ userId, orgId }: { userId: string; orgId: string }) {
  const [org, m, perms, teamIds, policy] = await Promise.all([
    db.orgs.getById(orgId),
    db.orgs.membership(userId, orgId),
    permissionsFor(userId, orgId),
    db.orgs.memberTeamIds(orgId, userId),
    // AUDIT #17: surface the idle-timeout policy to EVERY member (not just admins,
    // who read it via the ORG_MANAGE-gated session-policy route) so the client can
    // self-enforce idle sign-out. The server GC only reclaims fully-disconnected
    // sessions; a user who walks away with the app open (a live socket) is spared
    // by the "don't evict a connected session" guard, so without a client timer
    // the org's mandatory idle-lockout is silently unenforceable for them.
    db.orgs.getPolicy(orgId).catch(() => null),
  ]);
  if (!org) return null;
  return {
    org,
    role: m?.role || null,
    teamId: m?.teamId || null,
    teamIds: teamIds || [],
    permissions: Array.from(perms),
    // Minutes of inactivity after which the client should sign the user out.
    // null / 0 → no idle timeout for this tenant.
    idleTimeoutMin:
      policy && policy.idleTimeoutMin != null ? Number(policy.idleTimeoutMin) : null,
  };
}
