// External Data API — the service behind /api/external/v1/*.
//
// Other platforms (a CRM, a BI tool, a reporting job, a partner system) read
// CoLab's MySQL data through this API. Two halves live here:
//
//   KEYS   Minting / listing / rotating / revoking API keys (table
//          external_api_keys, migration 0130). A key is shown ONCE at creation
//          and stored only as a sha256 hash. Every key carries the organization
//          it may see (NULL = platform-wide) and a scope list.
//
//   DATA   Read-only, paginated readers over the core tables (users,
//          conversations, messages, meetings, tasks, files) plus an
//          ALLOW-LISTED generic table reader. Every query is tenant-scoped from
//          the key, never from the request, and every column name is taken from
//          a constant in this file — request values only ever bind as `?`
//          parameters.
//
// This talks to the raw mysql2 pool (db.pool) rather than the repository layer:
// the repositories are shaped around a signed-in USER (membership, unread
// counts, E2EE envelopes), whereas an integration reads an ORGANIZATION. Under
// the JSON dev driver there is no pool and every call 503s with a clear reason.
import crypto from "crypto";
import { config, db } from "../platform";

// ── Errors ──────────────────────────────────────────────────────────────────
// Thrown with an HTTP status + stable code; routes/external.ts turns them into
// the standard { ok:false, error:{code,message} } envelope.
export class ApiError extends Error {
  status: number;
  code: string;
  expose = true;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (m: string, code = "BAD_REQUEST") => new ApiError(400, code, m);
const notFound = (m = "Not found") => new ApiError(404, "NOT_FOUND", m);

function pool(): any {
  const p = (db as any).pool;
  if (!p)
    throw new ApiError(
      503,
      "UNAVAILABLE",
      "The External Data API needs the MySQL driver (DATABASE_DRIVER=json has no pool).",
    );
  return p;
}
async function rows(sql: string, params: any[] = []): Promise<any[]> {
  const [res]: any = await pool().query(sql, params);
  return Array.isArray(res) ? res : [];
}
async function exec(sql: string, params: any[] = []): Promise<number> {
  const [res]: any = await pool().query(sql, params);
  return (res && res.affectedRows) || 0;
}

// ── Scopes ──────────────────────────────────────────────────────────────────
export const READ_SCOPES = [
  "users:read",
  "conversations:read",
  "messages:read",
  "meetings:read",
  "tasks:read",
  "files:read",
  "tables:read",
] as const;
// Write scopes act AS a user (the key's actor — see resolveActor): send a
// message, place / answer / end a call, schedule a meeting, subscribe a webhook.
export const WRITE_SCOPES = ["messages:write", "calls:write", "meetings:write", "webhooks:write"] as const;
export const SCOPES = [...READ_SCOPES, ...WRITE_SCOPES] as const;
export type Scope = (typeof SCOPES)[number];

// Shorthands: 'read' = every read scope (the default), 'write' = every write
// scope, 'all' = both. Unknown entries are rejected at mint.
export function normalizeScopes(input: any): string[] {
  const list: string[] = Array.isArray(input)
    ? input.map(String)
    : String(input || "read")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  const out = new Set<string>();
  for (const s of list.length ? list : ["read"]) {
    if (s === "read") READ_SCOPES.forEach((x) => out.add(x));
    else if (s === "write") WRITE_SCOPES.forEach((x) => out.add(x));
    else if (s === "all") SCOPES.forEach((x) => out.add(x));
    else if ((SCOPES as readonly string[]).includes(s)) out.add(s);
    else throw bad(`Unknown scope "${s}". Valid: read, write, all, ${SCOPES.join(", ")}`, "INVALID_SCOPE");
  }
  return Array.from(out);
}
export function hasScope(key: ResolvedKey, scope: Scope): boolean {
  return key.scopes.includes(scope);
}

// ── Keys ────────────────────────────────────────────────────────────────────
export type ResolvedKey = {
  id: string; // row id, or 'static' for an EXTERNAL_API_KEYS entry
  name: string;
  orgId: string | null; // the tenant the key is BOUND to (NULL = platform)
  scopes: string[];
  platform: boolean; // true = may see every organization
  userId: string | null; // default ACTOR for write scopes (NULL = must be named per request)
};

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const KEY_PREFIX = "colab_";
const mintRaw = () => KEY_PREFIX + crypto.randomBytes(24).toString("base64url");

function publicShape(r: any) {
  return {
    id: r.id,
    name: r.name,
    organizationId: r.organization_id || null,
    platform: !r.organization_id,
    userId: r.user_id || null,
    keyHint: r.key_hint,
    scopes: String(r.scopes || "").split(",").filter(Boolean),
    createdBy: r.created_by || null,
    createdAt: r.created_at,
    expiresAt: r.expires_at || null,
    lastUsedAt: r.last_used_at || null,
    useCount: Number(r.use_count) || 0,
    enabled: !!r.enabled && !r.revoked_at,
    revokedAt: r.revoked_at || null,
  };
}

function parseExpiry(v: any): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad("expiresAt must be an ISO-8601 date-time");
  if (d.getTime() <= Date.now()) throw bad("expiresAt must be in the future");
  return d;
}

// Mint a key. `orgId` null = platform key (admin portal only — the org-admin
// route always passes the session's org). The raw key is returned ONCE.
export async function createKey(opts: {
  orgId: string | null;
  name: string;
  scopes?: any;
  expiresAt?: any;
  createdBy?: string | null;
  // Default actor for write scopes. Must be a live user and, for an org key,
  // an active member of that organization.
  userId?: string | null;
}) {
  const name = String(opts.name || "").trim();
  if (!name) throw bad("name is required");
  if (name.length > 120) throw bad("name must be at most 120 characters");
  const scopes = normalizeScopes(opts.scopes);
  const expiresAt = parseExpiry(opts.expiresAt);
  const userId = opts.userId ? String(opts.userId) : null;
  if (userId) await assertActorAllowed({ orgId: opts.orgId || null }, userId);
  const raw = mintRaw();
  const id = crypto.randomUUID();
  await exec(
    `INSERT INTO external_api_keys
       (id, organization_id, name, key_hash, key_hint, scopes, created_by, expires_at, user_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, opts.orgId || null, name, sha256(raw), raw.slice(-6), scopes.join(","), opts.createdBy || null, expiresAt, userId],
  );
  const [row] = await rows("SELECT * FROM external_api_keys WHERE id=?", [id]);
  return { key: raw, apiKey: publicShape(row) };
}

// Org admins list their org's keys; the admin portal lists everything (or one
// org when `orgId` is given, or only platform keys with `platformOnly`).
export async function listKeys(opts: { orgId?: string | null; all?: boolean; platformOnly?: boolean } = {}) {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.platformOnly) where.push("organization_id IS NULL");
  else if (!opts.all) {
    where.push("organization_id = ?");
    params.push(opts.orgId || null);
  }
  const sql =
    "SELECT * FROM external_api_keys" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY created_at DESC, id DESC LIMIT 500";
  return (await rows(sql, params)).map(publicShape);
}

// A key can only be managed inside its own tenant (orgId) — or by the admin
// portal, which passes `any: true`.
async function ownedKey(id: string, scope: { orgId?: string | null; any?: boolean }) {
  const [row] = await rows("SELECT * FROM external_api_keys WHERE id=? LIMIT 1", [String(id || "")]);
  if (!row) throw notFound("API key not found");
  if (!scope.any && (row.organization_id || null) !== (scope.orgId || null)) throw notFound("API key not found");
  return row;
}

export async function revokeKey(id: string, scope: { orgId?: string | null; any?: boolean; by?: string | null }) {
  const row = await ownedKey(id, scope);
  await exec("UPDATE external_api_keys SET enabled=0, revoked_at=NOW(3), revoked_by=? WHERE id=?", [
    scope.by || null,
    row.id,
  ]);
  verifyCache.clear();
  const [fresh] = await rows("SELECT * FROM external_api_keys WHERE id=?", [row.id]);
  return publicShape(fresh);
}

// Re-key in place: same id/name/scopes/org, new secret. The old key stops
// working the moment this returns.
export async function rotateKey(id: string, scope: { orgId?: string | null; any?: boolean }) {
  const row = await ownedKey(id, scope);
  if (!row.enabled || row.revoked_at) throw bad("A revoked key cannot be rotated — create a new one", "KEY_REVOKED");
  const raw = mintRaw();
  await exec("UPDATE external_api_keys SET key_hash=?, key_hint=?, last_used_at=NULL, use_count=0 WHERE id=?", [
    sha256(raw),
    raw.slice(-6),
    row.id,
  ]);
  verifyCache.clear();
  const [fresh] = await rows("SELECT * FROM external_api_keys WHERE id=?", [row.id]);
  return { key: raw, apiKey: publicShape(fresh) };
}

// Resolve a presented key → ResolvedKey, or null when it is unknown / disabled /
// expired (the caller 401s; the three cases are deliberately indistinguishable
// so a probe learns nothing). Verified keys are cached briefly so the per-request
// cost is a hash + map lookup; a revoke/rotate clears the cache immediately in
// this process (other replicas lag by at most VERIFY_TTL_MS).
const VERIFY_TTL_MS = 30_000;
const verifyCache = new Map<string, { key: ResolvedKey | null; expiresAt: number | null; ts: number }>();
export async function verifyKey(raw: string): Promise<ResolvedKey | null> {
  const presented = String(raw || "").trim();
  if (!presented || presented.length > 256) return null;
  const hash = sha256(presented);
  // Static keys from the environment: platform-wide, every read scope.
  for (const k of config.externalApi.staticKeys || []) {
    const a = Buffer.from(sha256(String(k)), "hex");
    const b = Buffer.from(hash, "hex");
    if (a.length === b.length && crypto.timingSafeEqual(a, b))
      return { id: "static", name: "EXTERNAL_API_KEYS", orgId: null, scopes: [...SCOPES], platform: true, userId: null };
  }
  const now = Date.now();
  const hit = verifyCache.get(hash);
  if (hit && now - hit.ts < VERIFY_TTL_MS) {
    if (hit.key && hit.expiresAt && hit.expiresAt <= now) return null;
    if (hit.key) touch(hit.key.id);
    return hit.key;
  }
  const [row] = await rows(
    "SELECT id, organization_id, user_id, name, scopes, enabled, revoked_at, expires_at FROM external_api_keys WHERE key_hash=? LIMIT 1",
    [hash],
  );
  if (verifyCache.size > 5_000) verifyCache.clear(); // bound memory
  if (!row || !row.enabled || row.revoked_at) {
    verifyCache.set(hash, { key: null, expiresAt: null, ts: now });
    return null;
  }
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
  if (expiresAt && expiresAt <= now) {
    verifyCache.set(hash, { key: null, expiresAt, ts: now });
    return null;
  }
  const key: ResolvedKey = {
    id: row.id,
    name: row.name,
    orgId: row.organization_id || null,
    scopes: String(row.scopes || "").split(",").filter(Boolean),
    platform: !row.organization_id,
    userId: row.user_id || null,
  };
  verifyCache.set(hash, { key, expiresAt, ts: now });
  touch(key.id);
  return key;
}
// Usage stamp: fire-and-forget, one PK update, never blocks or fails a request.
function touch(id: string) {
  if (!id || id === "static") return;
  Promise.resolve(
    exec("UPDATE external_api_keys SET last_used_at=NOW(3), use_count=use_count+1 WHERE id=?", [id]),
  ).catch(() => {});
}

// ── Paging / parsing helpers ────────────────────────────────────────────────
export type Page = { limit: number; offset: number };
export function parsePage(q: any): Page {
  const def = Number(config.externalApi.pageSize) || 100;
  const max = Number(config.externalApi.maxPageSize) || 500;
  let limit = q && q.limit !== undefined ? Number(q.limit) : def;
  let offset = q && q.offset !== undefined ? Number(q.offset) : 0;
  if (!Number.isInteger(limit) || limit < 1) throw bad("limit must be a positive integer");
  if (!Number.isInteger(offset) || offset < 0) throw bad("offset must be a non-negative integer");
  if (limit > max) limit = max;
  return { limit, offset };
}
export function parseDate(v: any, field: string): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw bad(`${field} must be an ISO-8601 date-time (e.g. 2026-10-01T00:00:00Z)`);
  return d;
}
const str = (v: any, max = 255): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v);
  if (s.length > max) throw bad(`value too long (max ${max})`);
  return s;
};
// Fetch limit+1 rows so the page can say whether another page exists without a
// COUNT(*) over a large table.
function page<T>(list: T[], p: Page) {
  const hasMore = list.length > p.limit;
  const items = hasMore ? list.slice(0, p.limit) : list;
  return {
    items,
    meta: { limit: p.limit, offset: p.offset, count: items.length, hasMore, nextOffset: hasMore ? p.offset + p.limit : null },
  };
}
const jsonVal = (v: any) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
};
const b = (v: any) => v === true || v === 1 || v === "1";

// Tenant predicate. A platform key with no X-Org-Id sees every organization;
// everything else is pinned to ONE organization_id. Rows whose organization_id
// is NULL (pre-organization legacy data) are only visible to a platform key —
// an org key must never be able to read rows that may belong to another tenant.
export type Tenant = { orgId: string | null };
function orgWhere(col: string, t: Tenant, where: string[], params: any[]) {
  if (t.orgId) {
    where.push(`${col} = ?`);
    params.push(t.orgId);
  }
}

// ── Actor (who a WRITE acts as) ─────────────────────────────────────────────
// Every write lands in tables whose author column is a FK to users, so a write
// request runs as a real CoLab user: the key's default actor (user_id), or a
// per-request `asUserId` / `asUserEmail`. Either way the user must be live and —
// for a tenant-pinned request — an active member of that organization, so a
// key can never impersonate someone outside its own tenant.
export async function assertActorAllowed(t: Tenant, userId: string): Promise<{ id: string; name: string; email: string }> {
  const [u] = await rows("SELECT id, name, email FROM users WHERE id = ? AND deleted = 0 LIMIT 1", [String(userId)]);
  if (!u) throw bad(`User "${userId}" does not exist`, "ACTOR_NOT_FOUND");
  if (t.orgId) {
    const [m] = await rows(
      "SELECT 1 AS one FROM organization_members WHERE user_id = ? AND organization_id = ? AND status = 'active' AND deleted = 0 LIMIT 1",
      [u.id, t.orgId],
    );
    if (!m) throw new ApiError(403, "ACTOR_NOT_IN_ORG", `User "${userId}" is not an active member of this organization`);
  }
  return { id: u.id, name: u.name, email: u.email };
}
export async function userIdByEmail(t: Tenant, email: string): Promise<string> {
  const e = String(email || "").trim().toLowerCase();
  if (!e) throw bad("email is required");
  const params: any[] = [e];
  const f = userFrom(t, params);
  const [u] = await rows(`SELECT u.id FROM ${f.from} WHERE u.deleted = 0 AND LOWER(u.email) = ? LIMIT 1`, [...params.slice(1), ...params.slice(0, 1)]);
  if (!u) throw notFound(`No user with email "${email}" in this organization`);
  return u.id;
}
export async function resolveActor(key: ResolvedKey, t: Tenant, body: any = {}) {
  const asId = body && body.asUserId ? String(body.asUserId) : null;
  const asEmail = body && body.asUserEmail ? String(body.asUserEmail) : null;
  let userId = asId || (asEmail ? await userIdByEmail(t, asEmail) : null) || key.userId;
  if (!userId)
    throw bad(
      "This key has no default actor. Mint it with userId, or pass asUserId / asUserEmail in the request body.",
      "ACTOR_REQUIRED",
    );
  return assertActorAllowed(t, userId);
}
// Resolve the target of a message / call: an explicit conversation (must be in
// scope), or a person (userId / email) whose DM with the actor is found or
// created. Returns the conversation id.
export async function resolvePeer(t: Tenant, body: any): Promise<string | null> {
  if (body && body.userId) return String(body.userId);
  if (body && body.email) return userIdByEmail(t, body.email);
  return null;
}
export async function assertConversationInScope(t: Tenant, id: string) {
  return convInScope(t, id);
}

// ── Organization (for /ping) ────────────────────────────────────────────────
export async function orgSummary(orgId: string | null) {
  if (!orgId) return null;
  const [o] = await rows("SELECT id, name, slug, kind, status FROM organizations WHERE id=? AND deleted=0 LIMIT 1", [orgId]);
  return o ? { id: o.id, name: o.name, slug: o.slug, kind: o.kind, status: o.status } : null;
}
export async function orgExists(orgId: string): Promise<boolean> {
  const [o] = await rows("SELECT 1 AS one FROM organizations WHERE id=? AND deleted=0 LIMIT 1", [orgId]);
  return !!o;
}

// ── Users ───────────────────────────────────────────────────────────────────
const USER_COLS =
  "u.id, u.email, u.name, u.initials, u.color, u.title, u.pronouns, u.phone, u.timezone, u.role, u.presence, u.last_seen, u.share_last_seen, u.sso_enabled, u.created_at";
const mapUser = (r: any) => ({
  id: r.id,
  email: r.email,
  name: r.name,
  initials: r.initials,
  color: r.color,
  title: r.title || null,
  pronouns: r.pronouns || null,
  phone: r.phone || null,
  timezone: r.timezone || null,
  role: r.role,
  presence: r.presence,
  lastSeen: b(r.share_last_seen) ? r.last_seen || null : null,
  ssoEnabled: b(r.sso_enabled),
  createdAt: r.created_at,
  ...(r.org_role !== undefined ? { orgRole: r.org_role, orgStatus: r.org_status, teamId: r.team_id || null } : {}),
});
function userFrom(t: Tenant, params: any[]) {
  if (!t.orgId) return { select: USER_COLS, from: "users u" };
  params.push(t.orgId);
  return {
    select: USER_COLS + ", om.role AS org_role, om.status AS org_status, om.team_id",
    from: "users u JOIN organization_members om ON om.user_id = u.id AND om.organization_id = ? AND om.status='active' AND om.deleted=0",
  };
}
export async function listUsers(t: Tenant, q: any) {
  const p = parsePage(q);
  const params: any[] = [];
  const f = userFrom(t, params);
  const where = ["u.deleted = 0"];
  const search = str(q.q, 120);
  if (search) {
    where.push("(u.name LIKE ? OR u.email LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  const since = parseDate(q.since, "since");
  if (since) {
    where.push("u.created_at >= ?");
    params.push(since);
  }
  const list = await rows(
    `SELECT ${f.select} FROM ${f.from} WHERE ${where.join(" AND ")} ORDER BY u.created_at ASC, u.id ASC LIMIT ? OFFSET ?`,
    [...params, p.limit + 1, p.offset],
  );
  const out = page(list.map(mapUser), p);
  return out;
}
export async function getUser(t: Tenant, id: string) {
  const params: any[] = [];
  const f = userFrom(t, params);
  const [r] = await rows(`SELECT ${f.select} FROM ${f.from} WHERE u.deleted = 0 AND u.id = ? LIMIT 1`, [...params, String(id)]);
  if (!r) throw notFound("User not found");
  return mapUser(r);
}

// ── Conversations ───────────────────────────────────────────────────────────
const CONV_COLS =
  "c.id, c.kind, c.title, c.icon, c.description, c.created_by, c.organization_id, c.temporary, c.expires_at, c.created_at";
const CONV_EXTRA =
  "(SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id AND m.deleted = 0) AS member_count, " +
  "(SELECT MAX(x.created_at) FROM messages x WHERE x.conversation_id = c.id AND x.deleted = 0) AS last_message_at";
const mapConv = (r: any) => ({
  id: r.id,
  kind: r.kind,
  title: r.title || null,
  icon: r.icon || null,
  description: r.description || null,
  createdBy: r.created_by || null,
  organizationId: r.organization_id || null,
  temporary: b(r.temporary),
  expiresAt: r.expires_at || null,
  memberCount: Number(r.member_count) || 0,
  lastMessageAt: r.last_message_at || null,
  createdAt: r.created_at,
});
export async function listConversations(t: Tenant, q: any) {
  const p = parsePage(q);
  const where = ["c.deleted = 0"];
  const params: any[] = [];
  orgWhere("c.organization_id", t, where, params);
  const kind = str(q.kind, 32);
  if (kind) {
    where.push("c.kind = ?");
    params.push(kind);
  }
  const since = parseDate(q.since, "since");
  if (since) {
    where.push("c.created_at >= ?");
    params.push(since);
  }
  const list = await rows(
    `SELECT ${CONV_COLS}, ${CONV_EXTRA} FROM conversations c WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    [...params, p.limit + 1, p.offset],
  );
  return page(list.map(mapConv), p);
}
async function convInScope(t: Tenant, id: string) {
  const where = ["c.deleted = 0", "c.id = ?"];
  const params: any[] = [String(id)];
  orgWhere("c.organization_id", t, where, params);
  const [r] = await rows(`SELECT ${CONV_COLS}, ${CONV_EXTRA} FROM conversations c WHERE ${where.join(" AND ")} LIMIT 1`, params);
  if (!r) throw notFound("Conversation not found");
  return r;
}
export async function getConversation(t: Tenant, id: string) {
  return mapConv(await convInScope(t, id));
}
export async function listConversationMembers(t: Tenant, id: string) {
  await convInScope(t, id);
  const list = await rows(
    `SELECT m.user_id, m.role, m.last_read_at, u.name, u.email
       FROM conversation_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ? AND m.deleted = 0 AND u.deleted = 0
      ORDER BY m.role ASC, u.name ASC`,
    [String(id)],
  );
  return list.map((r) => ({ userId: r.user_id, role: r.role, name: r.name, email: r.email, lastReadAt: r.last_read_at || null }));
}

// ── Messages ────────────────────────────────────────────────────────────────
// End-to-end-encrypted messages carry no readable body on the server, so they
// are returned with body:null and encrypted:true — never the ciphertext.
const MSG_COLS =
  "m.id, m.conversation_id, m.sender_id, m.type, m.body, m.file_json, m.voice_json, m.reactions_json, m.forwarded, m.edited, m.pinned, m.parent_message_id, m.encryption_version, m.created_at";
const mapMsg = (r: any) => {
  const encrypted = Number(r.encryption_version) > 0;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id,
    type: r.type || "text",
    body: encrypted ? null : r.body,
    encrypted,
    file: encrypted ? null : jsonVal(r.file_json),
    voice: encrypted ? null : jsonVal(r.voice_json),
    reactions: jsonVal(r.reactions_json),
    forwarded: b(r.forwarded),
    edited: b(r.edited),
    pinned: b(r.pinned),
    parentMessageId: r.parent_message_id || null,
    createdAt: r.created_at,
  };
};
export async function listMessages(t: Tenant, q: any, conversationId?: string) {
  const p = parsePage(q);
  const where = ["m.deleted = 0", "c.deleted = 0"];
  const params: any[] = [];
  orgWhere("c.organization_id", t, where, params);
  const cid = conversationId || str(q.conversationId, 36);
  if (cid) {
    await convInScope(t, cid);
    where.push("m.conversation_id = ?");
    params.push(cid);
  }
  const sender = str(q.senderId, 36);
  if (sender) {
    where.push("m.sender_id = ?");
    params.push(sender);
  }
  const since = parseDate(q.since, "since");
  if (since) {
    where.push("m.created_at >= ?");
    params.push(since);
  }
  const until = parseDate(q.until, "until");
  if (until) {
    where.push("m.created_at <= ?");
    params.push(until);
  }
  const order = String(q.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const list = await rows(
    `SELECT ${MSG_COLS} FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE ${where.join(" AND ")} ORDER BY m.created_at ${order}, m.id ${order} LIMIT ? OFFSET ?`,
    [...params, p.limit + 1, p.offset],
  );
  return page(list.map(mapMsg), p);
}

// ── Meetings ────────────────────────────────────────────────────────────────
const MEET_COLS =
  "m.id, m.title, m.starts_at, m.duration_min, m.timezone, m.status, m.recurrence, m.recurrence_rule, m.created_by, m.conversation_id, m.organization_id, m.lobby_enabled, m.locked, m.created_at, " +
  "(SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id = m.id AND a.deleted = 0) AS attendee_count";
const mapMeeting = (r: any) => ({
  id: r.id,
  title: r.title,
  startsAt: r.starts_at,
  durationMin: Number(r.duration_min) || 0,
  timezone: r.timezone || null,
  status: r.status,
  recurrence: r.recurrence || "none",
  recurrenceRule: r.recurrence_rule || null,
  createdBy: r.created_by || null,
  conversationId: r.conversation_id || null,
  organizationId: r.organization_id || null,
  lobbyEnabled: b(r.lobby_enabled),
  locked: b(r.locked),
  attendeeCount: Number(r.attendee_count) || 0,
  createdAt: r.created_at,
});
export async function listMeetings(t: Tenant, q: any) {
  const p = parsePage(q);
  const where = ["m.deleted = 0"];
  const params: any[] = [];
  orgWhere("m.organization_id", t, where, params);
  const from = parseDate(q.from, "from");
  if (from) {
    where.push("m.starts_at >= ?");
    params.push(from);
  }
  const to = parseDate(q.to, "to");
  if (to) {
    where.push("m.starts_at <= ?");
    params.push(to);
  }
  const status = str(q.status, 32);
  if (status) {
    where.push("m.status = ?");
    params.push(status);
  }
  const list = await rows(
    `SELECT ${MEET_COLS} FROM meetings m WHERE ${where.join(" AND ")} ORDER BY m.starts_at ASC, m.id ASC LIMIT ? OFFSET ?`,
    [...params, p.limit + 1, p.offset],
  );
  return page(list.map(mapMeeting), p);
}
export async function getMeeting(t: Tenant, id: string) {
  const where = ["m.deleted = 0", "m.id = ?"];
  const params: any[] = [String(id)];
  orgWhere("m.organization_id", t, where, params);
  const [r] = await rows(`SELECT ${MEET_COLS} FROM meetings m WHERE ${where.join(" AND ")} LIMIT 1`, params);
  if (!r) throw notFound("Meeting not found");
  const attendees = await rows(
    `SELECT a.user_id, a.status, a.role, u.name, u.email FROM meeting_attendees a JOIN users u ON u.id = a.user_id
      WHERE a.meeting_id = ? AND a.deleted = 0 ORDER BY a.role ASC, u.name ASC`,
    [r.id],
  );
  return {
    ...mapMeeting(r),
    attendees: attendees.map((a) => ({ userId: a.user_id, status: a.status, role: a.role, name: a.name, email: a.email })),
  };
}

// ── Tasks ───────────────────────────────────────────────────────────────────
const TASK_COLS =
  "t.id, t.title, t.status, t.priority, t.description, t.labels, t.due_at, t.assignee_id, t.reporter_id, t.project, t.project_id, t.parent_task_id, t.recurrence, t.version, t.organization_id, t.created_at, t.updated_at";
const mapTask = (r: any, assignees: string[] = []) => ({
  id: r.id,
  title: r.title,
  status: r.status,
  priority: r.priority,
  description: r.description || null,
  labels: jsonVal(r.labels) || [],
  dueAt: r.due_at || null,
  assigneeId: r.assignee_id || null,
  assigneeIds: assignees,
  reporterId: r.reporter_id || null,
  project: r.project || null,
  projectId: r.project_id || null,
  parentTaskId: r.parent_task_id || null,
  recurrence: r.recurrence || "none",
  version: Number(r.version) || 1,
  organizationId: r.organization_id || null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
async function assigneesFor(ids: string[]) {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const list = await rows("SELECT task_id, user_id FROM task_assignees WHERE task_id IN (?) ORDER BY assigned_at ASC", [ids]);
  for (const r of list) {
    if (!map.has(r.task_id)) map.set(r.task_id, []);
    map.get(r.task_id)!.push(r.user_id);
  }
  return map;
}
export async function listTasks(t: Tenant, q: any) {
  const p = parsePage(q);
  const where = ["t.deleted = 0"];
  const params: any[] = [];
  orgWhere("t.organization_id", t, where, params);
  for (const [col, key, max] of [
    ["t.status", "status", 32],
    ["t.priority", "priority", 16],
    ["t.assignee_id", "assigneeId", 36],
    ["t.reporter_id", "reporterId", 36],
    ["t.project_id", "projectId", 36],
    ["t.parent_task_id", "parentTaskId", 36],
  ] as const) {
    const v = str(q[key], max);
    if (v) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  }
  const updatedSince = parseDate(q.updatedSince, "updatedSince");
  if (updatedSince) {
    where.push("t.updated_at >= ?");
    params.push(updatedSince);
  }
  const dueBefore = parseDate(q.dueBefore, "dueBefore");
  if (dueBefore) {
    where.push("t.due_at <= ?");
    params.push(dueBefore);
  }
  const list = await rows(
    `SELECT ${TASK_COLS} FROM tasks t WHERE ${where.join(" AND ")} ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, p.limit + 1, p.offset],
  );
  const pg = page(list, p);
  const asg = await assigneesFor(pg.items.map((r: any) => r.id));
  return { items: pg.items.map((r: any) => mapTask(r, asg.get(r.id) || [])), meta: pg.meta };
}
export async function getTask(t: Tenant, id: string) {
  const where = ["t.deleted = 0", "t.id = ?"];
  const params: any[] = [String(id)];
  orgWhere("t.organization_id", t, where, params);
  const [r] = await rows(`SELECT ${TASK_COLS} FROM tasks t WHERE ${where.join(" AND ")} LIMIT 1`, params);
  if (!r) throw notFound("Task not found");
  const asg = await assigneesFor([r.id]);
  const comments = await rows(
    "SELECT id, author_id, body, created_at FROM task_comments WHERE task_id = ? AND deleted = 0 ORDER BY created_at ASC LIMIT 200",
    [r.id],
  );
  return {
    ...mapTask(r, asg.get(r.id) || []),
    comments: comments.map((c) => ({ id: c.id, authorId: c.author_id || null, body: c.body, createdAt: c.created_at })),
  };
}

// ── Files (metadata only — never the bytes) ─────────────────────────────────
const FILE_COLS =
  "f.id, f.name, f.mime, f.size, f.conversation_id, f.uploader_id, f.organization_id, f.storage_backend, f.starred, f.encryption_version, f.created_at";
const mapFile = (r: any) => ({
  id: r.id,
  name: r.name,
  mime: r.mime || null,
  size: Number(r.size) || 0,
  conversationId: r.conversation_id || null,
  uploaderId: r.uploader_id || null,
  organizationId: r.organization_id || null,
  storageBackend: r.storage_backend || null,
  starred: b(r.starred),
  encrypted: Number(r.encryption_version) > 0,
  createdAt: r.created_at,
});
export async function listFiles(t: Tenant, q: any) {
  const p = parsePage(q);
  const where = ["f.deleted = 0"];
  const params: any[] = [];
  orgWhere("f.organization_id", t, where, params);
  const cid = str(q.conversationId, 36);
  if (cid) {
    where.push("f.conversation_id = ?");
    params.push(cid);
  }
  const up = str(q.uploaderId, 36);
  if (up) {
    where.push("f.uploader_id = ?");
    params.push(up);
  }
  const since = parseDate(q.since, "since");
  if (since) {
    where.push("f.created_at >= ?");
    params.push(since);
  }
  const list = await rows(
    `SELECT ${FILE_COLS} FROM files f WHERE ${where.join(" AND ")} ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?`,
    [...params, p.limit + 1, p.offset],
  );
  return page(list.map(mapFile), p);
}
export async function getFile(t: Tenant, id: string) {
  const where = ["f.deleted = 0", "f.id = ?"];
  const params: any[] = [String(id)];
  orgWhere("f.organization_id", t, where, params);
  const [r] = await rows(`SELECT ${FILE_COLS} FROM files f WHERE ${where.join(" AND ")} LIMIT 1`, params);
  if (!r) throw notFound("File not found");
  return mapFile(r);
}

// ── Generic allow-listed table reader ───────────────────────────────────────
// GET /tables lists these; GET /tables/:name reads one with equality filters,
// a time window and ordering. Only the columns named here can be selected,
// filtered or sorted — password hashes, ciphertext, blobs, tokens and secrets
// are simply not in the list. `org` is the tenant predicate for an org-bound
// key (a `?` bound to the key's organization). `soft` is the soft-delete column.
type TableSpec = { columns: string[]; org: string | null; soft: string | null; time: string; describe: string };
export const TABLES: Record<string, TableSpec> = {
  organizations: {
    columns: ["id", "name", "slug", "kind", "status", "owner_id", "created_at"],
    org: "t.id = ?",
    soft: "deleted",
    time: "created_at",
    describe: "Organizations (tenants).",
  },
  organization_members: {
    columns: ["id", "organization_id", "user_id", "role", "status", "team_id", "created_at"],
    org: "t.organization_id = ?",
    soft: "deleted",
    time: "created_at",
    describe: "Who belongs to which organization, with their org role.",
  },
  teams: {
    columns: ["id", "organization_id", "parent_team_id", "name", "path", "depth", "lead_user_id", "created_at"],
    org: "t.organization_id = ?",
    soft: "deleted",
    time: "created_at",
    describe: "Teams / departments inside an organization.",
  },
  team_members: {
    columns: ["team_id", "user_id", "role", "created_at"],
    org: "EXISTS (SELECT 1 FROM teams x WHERE x.id = t.team_id AND x.organization_id = ?)",
    soft: "deleted",
    time: "created_at",
    describe: "Team membership.",
  },
  users: {
    columns: ["id", "email", "name", "initials", "title", "pronouns", "phone", "timezone", "role", "presence", "last_seen", "sso_enabled", "created_at"],
    org: "EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = t.id AND om.organization_id = ? AND om.status='active' AND om.deleted=0)",
    soft: "deleted",
    time: "created_at",
    describe: "People. No password hashes or avatars.",
  },
  conversations: {
    columns: ["id", "kind", "title", "icon", "description", "created_by", "organization_id", "temporary", "expires_at", "created_at"],
    org: "t.organization_id = ?",
    soft: "deleted",
    time: "created_at",
    describe: "DMs, groups and channels.",
  },
  conversation_members: {
    columns: ["conversation_id", "user_id", "role", "last_read_at"],
    org: "EXISTS (SELECT 1 FROM conversations x WHERE x.id = t.conversation_id AND x.organization_id = ?)",
    soft: "deleted",
    time: "last_read_at",
    describe: "Conversation membership.",
  },
  messages: {
    columns: ["id", "conversation_id", "sender_id", "type", "body", "forwarded", "edited", "pinned", "parent_message_id", "encryption_version", "created_at"],
    org: "EXISTS (SELECT 1 FROM conversations x WHERE x.id = t.conversation_id AND x.organization_id = ?)",
    soft: "deleted",
    time: "created_at",
    describe: "Chat messages. body is NULL for end-to-end-encrypted rows.",
  },
  meetings: {
    columns: ["id", "title", "starts_at", "duration_min", "timezone", "status", "recurrence", "created_by", "conversation_id", "organization_id", "created_at"],
    org: "t.organization_id = ?",
    soft: "deleted",
    time: "starts_at",
    describe: "Scheduled and past meetings.",
  },
  meeting_attendees: {
    columns: ["meeting_id", "user_id", "status", "role"],
    org: "EXISTS (SELECT 1 FROM meetings x WHERE x.id = t.meeting_id AND x.organization_id = ?)",
    soft: "deleted",
    time: "meeting_id",
    describe: "Meeting invitees and their RSVP status.",
  },
  tasks: {
    columns: ["id", "title", "status", "priority", "due_at", "assignee_id", "reporter_id", "project", "project_id", "parent_task_id", "recurrence", "organization_id", "created_at", "updated_at"],
    org: "t.organization_id = ?",
    soft: "deleted",
    time: "updated_at",
    describe: "Tasks.",
  },
  task_projects: {
    columns: ["id", "owner_id", "name", "color", "archived", "organization_id", "created_at"],
    org: "t.organization_id = ?",
    soft: "deleted",
    time: "created_at",
    describe: "Task projects.",
  },
  task_assignees: {
    columns: ["task_id", "user_id", "assigned_at", "assigned_by"],
    org: "EXISTS (SELECT 1 FROM tasks x WHERE x.id = t.task_id AND x.organization_id = ?)",
    soft: null,
    time: "assigned_at",
    describe: "All assignees of a task.",
  },
  task_comments: {
    columns: ["id", "task_id", "author_id", "body", "organization_id", "created_at"],
    org: "t.organization_id = ?",
    soft: "deleted",
    time: "created_at",
    describe: "Task comments.",
  },
  files: {
    columns: ["id", "name", "mime", "size", "conversation_id", "uploader_id", "organization_id", "storage_backend", "starred", "created_at"],
    org: "t.organization_id = ?",
    soft: "deleted",
    time: "created_at",
    describe: "File metadata (never the bytes).",
  },
  reminders: {
    columns: ["id", "user_id", "folder_id", "text", "done", "due_at", "priority", "status", "recurrence", "organization_id", "created_at", "updated_at"],
    org: "t.organization_id = ?",
    soft: "deleted",
    time: "updated_at",
    describe: "Personal reminders.",
  },
  calls: {
    columns: ["id", "conversation_id", "initiator_id", "peer_id", "kind", "direction", "status", "duration_sec", "organization_id", "started_at"],
    org: "t.organization_id = ?",
    soft: null,
    time: "started_at",
    describe: "Call history.",
  },
};
export function listTables(t: Tenant) {
  return Object.entries(TABLES).map(([name, s]) => ({
    name,
    description: s.describe,
    columns: s.columns,
    timeColumn: s.time,
    // An org-bound key reads `organizations` only for its own tenant.
    scoped: !!(t.orgId && s.org),
  }));
}
const COL_RE = /^[a-z_][a-z0-9_]*$/;
export async function queryTable(t: Tenant, name: string, q: any) {
  const table = String(name || "").toLowerCase();
  const spec = TABLES[table];
  if (!spec) throw notFound(`Unknown table "${table}". GET /tables lists what is readable.`);
  const p = parsePage(q);
  // columns=a,b,c → subset of the allow-list (default: all of it)
  let cols = spec.columns;
  if (q.columns) {
    const want = String(q.columns).split(",").map((s) => s.trim()).filter(Boolean);
    for (const c of want) if (!COL_RE.test(c) || !spec.columns.includes(c)) throw bad(`Column "${c}" is not readable on ${table}`, "INVALID_COLUMN");
    if (want.length) cols = want;
  }
  const where: string[] = [];
  const params: any[] = [];
  if (spec.soft) where.push(`t.${spec.soft} = 0`);
  if (t.orgId && spec.org) {
    where.push(spec.org);
    params.push(t.orgId);
  }
  // filter[col]=value → equality; filter[col]=null → IS NULL. Express parses
  // `filter[col]` into req.query.filter = { col: value }.
  const filter = q.filter && typeof q.filter === "object" ? q.filter : {};
  for (const [c, v] of Object.entries(filter)) {
    if (!COL_RE.test(c) || !spec.columns.includes(c)) throw bad(`Cannot filter on "${c}"`, "INVALID_FILTER");
    if (v === "null") where.push(`t.${c} IS NULL`);
    else {
      if (typeof v !== "string" || v.length > 500) throw bad(`Bad filter value for "${c}"`, "INVALID_FILTER");
      where.push(`t.${c} = ?`);
      params.push(v);
    }
  }
  const since = parseDate(q.since, "since");
  if (since) {
    where.push(`t.${spec.time} >= ?`);
    params.push(since);
  }
  const until = parseDate(q.until, "until");
  if (until) {
    where.push(`t.${spec.time} <= ?`);
    params.push(until);
  }
  let orderBy = spec.time;
  if (q.orderBy) {
    const ob = String(q.orderBy);
    if (!COL_RE.test(ob) || !spec.columns.includes(ob)) throw bad(`Cannot order by "${ob}"`, "INVALID_ORDER");
    orderBy = ob;
  }
  const order = String(q.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const sql =
    `SELECT ${cols.map((c) => "t." + c).join(", ")} FROM ${table} t` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY t.${orderBy} ${order} LIMIT ? OFFSET ?`;
  const list = await rows(sql, [...params, p.limit + 1, p.offset]);
  const pg = page(list, p);
  return { table, columns: cols, items: pg.items, meta: pg.meta };
}
