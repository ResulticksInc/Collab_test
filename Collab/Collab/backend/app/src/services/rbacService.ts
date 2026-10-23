import { db, config } from "../platform";

// Organizations RBAC (Phase 2) — the permission catalog + the can() gate.
//
// A member's permissions are resolved from their role via the DB role catalog
// (migration 0069: roles + role_permissions). This module is the SINGLE authority
// every route asks "may this user do X in this org?". Resolution is cached per
// (user, org) for a short TTL so a burst of checks in one request costs one query.
// Fail-CLOSED everywhere: an unknown user/org, a non-member, or a DB hiccup yields
// NO permissions (never an accidental grant).

// The canonical permission keys (mirror role_permissions.permission seeded in 0069).
export const PERMISSIONS = {
  ORG_MANAGE: "org:manage",        // edit org settings / name / branding
  ORG_DELETE: "org:delete",        // archive / delete the org (owner only)
  MEMBERS_INVITE: "members:invite",
  MEMBERS_MANAGE: "members:manage", // change roles, remove members
  TEAMS_MANAGE: "teams:manage",
  ROLES_MANAGE: "roles:manage",
  BILLING_MANAGE: "billing:manage",
  AUDIT_VIEW: "audit:view",
  CHANNELS_MANAGE: "channels:manage",
  MEETINGS_MANAGE: "meetings:manage",
} as const;
export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// Human-friendly catalog for the custom-role editor UI. org:delete is intentionally
// EXCLUDED — it stays reserved for the account Owner and is never grantable to a role.
export const PERMISSION_CATALOG: { key: string; label: string; description: string }[] = [
  { key: "org:manage", label: "Manage organization", description: "Edit org settings, name and branding." },
  { key: "members:invite", label: "Invite members", description: "Add people to the organization." },
  { key: "members:manage", label: "Manage members", description: "Change roles, reset passwords, remove members." },
  { key: "teams:manage", label: "Manage teams", description: "Create, rename and organize teams / departments." },
  { key: "roles:manage", label: "Manage roles", description: "Create and edit custom roles and their permissions." },
  { key: "billing:manage", label: "Manage billing", description: "View and change billing and plans." },
  { key: "audit:view", label: "View audit log", description: "See the organization's activity/audit trail." },
  { key: "channels:manage", label: "Manage channels", description: "Create and administer channels." },
  { key: "meetings:manage", label: "Manage meetings", description: "Administer org meetings and recordings." },
];
// Permissions a custom role may actually be granted (org:delete excluded on purpose).
export const GRANTABLE_PERMISSIONS = new Set(PERMISSION_CATALOG.map((p) => p.key));

// Hardcoded grants for the BUILT-IN roles — the SAFETY NET used only when the DB
// resolves NO permissions for a member (e.g. the RBAC seed migration 0069/0075 hasn't
// been applied on this DB yet). Mirrors those migrations exactly. member + guest
// intentionally get nothing. Custom (org_*) roles are DB-only and get no fallback.
const P = PERMISSIONS;
const FALLBACK_GRANTS: Record<string, string[]> = {
  owner: Object.values(P),
  admin: [P.ORG_MANAGE, P.MEMBERS_INVITE, P.MEMBERS_MANAGE, P.TEAMS_MANAGE, P.ROLES_MANAGE, P.BILLING_MANAGE, P.AUDIT_VIEW, P.CHANNELS_MANAGE, P.MEETINGS_MANAGE],
};

// Short-TTL cache of a member's resolved permission set so can() doesn't hit the DB
// on every check. Keyed "userId|orgId"; invalidated explicitly on a role change.
const TTL_MS = 30_000;
const cache = new Map<string, { perms: Set<string>; ts: number }>();

// ── Cross-pod invalidation (review finding #5) ───────────────────────────────
// The cache above is PER-PROCESS, so invalidatePermissions/All only cleared the
// CALLING replica — other pods kept serving a member's OLD permissions until the
// 30s TTL expired. Propagate every invalidation over Redis pub/sub so ALL pods
// drop the entry immediately. The READ path (permissionsFor) is deliberately
// UNCHANGED — still the fast in-process Map — so this adds no latency to the hot
// permission check. When REDIS_URL is unset or Redis is unreachable it degrades
// to EXACTLY today's local-only behavior, so it can only reduce staleness, never
// introduce a regression. Reuses the huddleStore graceful-fallback shape.
const INVALIDATE_CHANNEL = "rbac:invalidate";
let pub: any = null; // null=uninit, false=unavailable (local-only), else client
let sub: any = null;
async function ensureRedis(): Promise<void> {
  if (pub !== null) return;
  if (!config.redis?.url) {
    pub = false;
    return;
  }
  try {
    const redis = await import("redis");
    const mk = () =>
      redis.createClient({
        url: config.redis.url,
        socket: { reconnectStrategy: false, connectTimeout: 3000 },
      });
    const p = mk();
    p.on("error", () => {});
    await Promise.race([
      p.connect(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("redis connect timeout")), 3500),
      ),
    ]);
    // A subscriber needs its OWN connection (a subscribed client can't issue
    // other commands). Applying our own echoed message is idempotent (we already
    // mutated locally), so we don't filter self-published messages.
    const s = p.duplicate();
    s.on("error", () => {});
    await s.connect();
    await s.subscribe(INVALIDATE_CHANNEL, (message: string) => {
      try {
        const m = JSON.parse(message);
        if (m.all) cache.clear();
        else if (m.key) cache.delete(m.key);
      } catch {
        /* ignore malformed */
      }
    });
    pub = p;
    sub = s;
  } catch {
    pub = false; // fall back to local-only invalidation (today's behavior)
  }
}
// Bring the subscriber up at boot so a pod receives peers' invalidations even if
// it never invalidates locally itself. Fire-and-forget — never blocks module load.
void ensureRedis();
// Fire-and-forget publish; the LOCAL mutation already happened, so a publish
// failure only means peers wait out their TTL (i.e. exactly today's behavior).
function publishInvalidation(payload: { key?: string; all?: true }): void {
  void (async () => {
    try {
      await ensureRedis();
      if (pub) await pub.publish(INVALIDATE_CHANNEL, JSON.stringify(payload));
    } catch {
      /* best-effort */
    }
  })();
}

export async function permissionsFor(
  userId: string,
  orgId: string | null,
): Promise<Set<string>> {
  if (!userId || !orgId) return new Set();
  const key = `${userId}|${orgId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < TTL_MS) return hit.perms;
  let list: string[] = [];
  try {
    list = await db.orgs.permissionsForMember(userId, orgId);
  } catch {
    list = []; // fail-closed: a resolution error grants nothing
  }
  // SAFETY NET: an EMPTY result usually means the role_permissions seed isn't applied
  // on this DB. Fall back to the built-in role's hardcoded grants so system roles keep
  // working (a seeded DB returns a non-empty list and never reaches here). This is why
  // an Owner might otherwise see no admin controls on a freshly-migrated-but-unseeded
  // live DB.
  if (list.length === 0) {
    try {
      const m = await db.orgs.membership(userId, orgId);
      if (m && m.status === "active" && FALLBACK_GRANTS[m.role]) list = FALLBACK_GRANTS[m.role];
    } catch {
      /* keep empty */
    }
  }
  const set = new Set(list);
  cache.set(key, { perms: set, ts: now });
  return set;
}

// The gate. True iff the user holds `permission` in `orgId`.
export async function can(
  userId: string,
  orgId: string | null,
  permission: string,
): Promise<boolean> {
  const perms = await permissionsFor(userId, orgId);
  return perms.has(permission);
}

// Drop a member's cached permissions — call right after a role change / removal so
// the new posture takes effect immediately instead of waiting out the TTL.
export function invalidatePermissions(userId: string, orgId: string): void {
  const key = `${userId}|${orgId}`;
  cache.delete(key); // local, immediate
  publishInvalidation({ key }); // + tell every other replica to drop it too
}

// Coarse clear — call after a ROLE definition changes (perms added/removed, role
// deleted), which affects every member holding that role. Roles change rarely, so
// dropping the whole cache (each member re-resolves once) is simpler + safe.
export function invalidateAllPermissions(): void {
  cache.clear(); // local, immediate
  publishInvalidation({ all: true }); // + every other replica clears too
}
