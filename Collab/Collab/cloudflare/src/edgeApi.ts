// Worker-side API, mounted at /api/edge/* by src/index.ts.
//
// Every read here is served from the CoLab External Data API (src/externalApi.ts) with the deployment's
// API key; nothing in this Worker talks to a database. The caller is identified by the same bearer token
// the CoLab app uses, validated against the application API (src/upstream.ts → GET /api/auth/me).
// The two writes the External API does not offer (profile update, mark-read) are forwarded to the
// application API as the caller, so Socket.IO fan-out and read receipts behave exactly as in-app.
//
// Required key scopes: users:read, conversations:read, messages:read, tables:read (i.e. "read").
import { ExternalApi, ExternalApiError, apiOrigin, externalHealth, type ExternalApiEnv } from "./externalApi";
import { forwardAsUser, whoAmI, type Caller } from "./upstream";

export type EdgeApiEnv = ExternalApiEnv;

export const EDGE_API_PREFIX = "/api/edge";

type Handler = (c: Ctx) => Promise<Response>;
interface Ctx { req: Request; env: EdgeApiEnv; ctx: ExecutionContext; params: Record<string, string>; url: URL }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const ok = (data: unknown, meta?: unknown) => json(meta === undefined ? { ok: true, data } : { ok: true, data, meta });
const fail = (status: number, code: string, message?: string, headers?: Record<string, string>) =>
  json({ ok: false, error: { code, ...(message ? { message } : {}) } }, status, headers);

const clampInt = (v: string | null, def: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// ── Shapes (the External API's camelCase objects, passed through) ────────────────────────────────

interface ExtUser {
  id: string; email: string; name: string; initials: string; color: string; title: string | null;
  pronouns: string | null; phone: string | null; timezone: string | null; role: string; presence: string;
  lastSeen: string | null; ssoEnabled: boolean; createdAt: string; orgRole?: string; orgStatus?: string; teamId?: string | null;
}
interface ExtConversation {
  id: string; kind: string; title: string | null; icon: string | null; description: string | null; createdBy: string | null;
  organizationId: string | null; temporary: boolean; expiresAt: string | null; memberCount: number; lastMessageAt: string | null; createdAt: string;
}
interface ExtMember { userId: string; role: string; name: string; email: string; lastReadAt: string | null }
interface ExtMessage {
  id: string; conversationId: string; senderId: string; type: string; body: string | null; encrypted: boolean;
  file: unknown; voice: unknown; reactions: unknown; forwarded: boolean; edited: boolean; pinned: boolean;
  parentMessageId: string | null; createdAt: string;
}
interface MembershipRow { conversation_id: string; role: string; last_read_at: string | null }

// ── Handlers ─────────────────────────────────────────────────────────────────────────────────────

// GET /api/edge/health — no auth. Proves the Worker can reach the External API and that the key works.
const health: Handler = async (c) => {
  const t0 = Date.now();
  const origin = apiOrigin(c.env);
  const live = await externalHealth(c.env);
  if (!live.ok) return json({ ok: false, apiOrigin: origin, external: live, ms: Date.now() - t0 }, 503);
  try {
    const api = new ExternalApi(c.env);
    const { data } = await api.get<{ keyId: string; keyName: string; platform: boolean; organization: unknown; scopes: string[]; serverTime: string }>("/ping");
    return json({ ok: true, apiOrigin: origin, key: { id: data.keyId, name: data.keyName, platform: data.platform, scopes: data.scopes },
      organization: data.organization, serverTime: data.serverTime, ms: Date.now() - t0 });
  } catch (e) {
    const err = e instanceof ExternalApiError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: String(e).slice(0, 200) };
    return json({ ok: false, apiOrigin: origin, external: live, error: err, ms: Date.now() - t0 }, e instanceof ExternalApiError ? e.status : 500);
  }
};

// Every handler below runs with a validated caller and an External API client.
const authed = (fn: (c: Ctx, api: ExternalApi, user: Caller, token: string) => Promise<Response>): Handler => async (c) => {
  const who = await whoAmI(c.req, c.env);
  if ("error" in who) return who.error;
  return fn(c, new ExternalApi(c.env), who.user, who.token);
};

// GET /api/edge/me — the caller's profile as the External API sees it.
const me = authed(async (_c, api, user) => {
  const row = await api.maybe<ExtUser>(`/users/${encodeURIComponent(user.id)}`);
  return row ? ok(row) : fail(404, "NOT_FOUND", "user not found in the API key's organization");
});

// PATCH /api/edge/me  { about?, name?, title?, pronouns?, phone?, timezone?, avatarUrl? }
// The External API has no profile write, so this goes to the application API as the caller.
const updateMe = authed(async (c, _api, _user, token) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return fail(400, "BAD_REQUEST", "body must be JSON"); }
  const allowed = ["about", "name", "title", "pronouns", "phone", "timezone", "avatarUrl"];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in body) patch[k] = body[k];
  if (!Object.keys(patch).length) return fail(400, "BAD_REQUEST", `send one of ${allowed.join(", ")}`);
  if ("about" in patch && patch.about !== null && (typeof patch.about !== "string" || patch.about.length > 255)) return fail(400, "BAD_REQUEST", "about: string ≤255 or null");
  return forwardAsUser(c.env, token, "PATCH", "/api/users/me", patch);
});

// GET /api/edge/users?q=&limit=&offset= — directory search (never password hashes or avatars).
const users = authed(async (c, api) => {
  const { data, meta } = await api.get<ExtUser[]>("/users", {
    q: (c.url.searchParams.get("q") ?? "").trim().slice(0, 120),
    limit: clampInt(c.url.searchParams.get("limit"), 50, 1, 500),
    offset: clampInt(c.url.searchParams.get("offset"), 0, 0, 1_000_000),
  });
  return ok(data, meta);
});

// GET /api/edge/conversations — the caller's memberships with member count and last message time.
// Membership rows come from the generic table reader (conversation_members, filtered on user_id);
// the conversation objects from the typed /conversations list, joined here.
const conversations = authed(async (_c, api, user) => {
  const memberships = await api.list<MembershipRow>("/tables/conversation_members", {
    "filter[user_id]": user.id, columns: "conversation_id,role,last_read_at",
  });
  const mine = new Map(memberships.map((m) => [m.conversation_id, m]));
  if (!mine.size) return ok([]);
  const found: Array<ExtConversation & { memberRole: string; lastReadAt: string | null }> = [];
  let offset = 0;
  for (let page = 0; page < 40 && found.length < mine.size; page++) {
    const { data, meta } = await api.get<ExtConversation[]>("/conversations", { limit: 500, offset });
    for (const conv of data ?? []) {
      const m = mine.get(conv.id);
      if (m) found.push({ ...conv, memberRole: m.role, lastReadAt: m.last_read_at });
    }
    if (!meta?.hasMore || meta.nextOffset === null || meta.nextOffset === undefined) break;
    offset = meta.nextOffset;
  }
  found.sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt) || b.createdAt.localeCompare(a.createdAt));
  return ok(found, { count: found.length, memberships: mine.size });
});

async function membersOf(api: ExternalApi, conversationId: string): Promise<ExtMember[] | null> {
  return api.maybe<ExtMember[]>(`/conversations/${encodeURIComponent(conversationId)}/members`);
}

// GET /api/edge/conversations/:id/messages?limit=&before=<message id> — newest first, keyset paged.
const messages = authed(async (c, api, user) => {
  const id = c.params.id;
  const members = await membersOf(api, id);
  if (!members) return fail(404, "NOT_FOUND", "conversation not found");
  if (!members.some((m) => m.userId === user.id)) return fail(403, "FORBIDDEN", "not a member of this conversation");
  const limit = clampInt(c.url.searchParams.get("limit"), 50, 1, 200);
  const before = c.url.searchParams.get("before");
  let until: string | undefined;
  if (before) {
    const [row] = (await api.get<Array<{ id: string; created_at: string }>>("/tables/messages", {
      "filter[id]": before, "filter[conversation_id]": id, columns: "id,created_at", limit: 1,
    })).data ?? [];
    if (!row) return fail(400, "BAD_REQUEST", "before: unknown message id");
    until = row.created_at;
  }
  // `until` is inclusive on created_at, so over-fetch by one and drop the boundary message itself.
  const { data } = await api.get<ExtMessage[]>(`/conversations/${encodeURIComponent(id)}/messages`, { order: "desc", limit: limit + 1, until });
  const rows = (data ?? []).filter((m) => m.id !== before).slice(0, limit);
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const unknown = [...new Set(rows.map((m) => m.senderId).filter((s) => s && !names.has(s)))].slice(0, 20);
  await Promise.all(unknown.map(async (uid) => {
    const u = await api.maybe<ExtUser>(`/users/${encodeURIComponent(uid)}`);
    if (u) names.set(uid, u.name);
  }));
  const out = rows.map((m) => ({ ...m, senderName: names.get(m.senderId) ?? null }));
  return ok(out, { count: out.length, nextBefore: rows.length === limit ? rows[rows.length - 1].id : null });
});

// POST /api/edge/conversations/:id/read  { receipts?: boolean } — mark read for the caller.
// Read state is not writable through the External API; the application API does it and fans out.
const markRead = authed(async (c, _api, _user, token) => {
  let body: { receipts?: unknown } = {};
  try { body = await c.req.json(); } catch { /* empty body is fine */ }
  return forwardAsUser(c.env, token, "POST", `/api/conversations/${encodeURIComponent(c.params.id)}/read`, { read: true, receipts: body.receipts !== false });
});

// ── Router ───────────────────────────────────────────────────────────────────────────────────────

const ROUTES: Array<[method: string, pattern: string, handler: Handler]> = [
  ["GET", "/health", health],
  ["GET", "/me", me],
  ["PATCH", "/me", updateMe],
  ["GET", "/users", users],
  ["GET", "/conversations", conversations],
  ["GET", "/conversations/:id/messages", messages],
  ["POST", "/conversations/:id/read", markRead],
];

function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/"), s = path.split("/");
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) { if (!s[i]) return null; params[p[i].slice(1)] = decodeURIComponent(s[i]); }
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

export function isEdgeApiRequest(url: URL): boolean {
  return url.pathname === EDGE_API_PREFIX || url.pathname.startsWith(EDGE_API_PREFIX + "/");
}

export async function handleEdgeApi(req: Request, env: EdgeApiEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const sub = url.pathname.slice(EDGE_API_PREFIX.length).replace(/\/+$/, "") || "/";
  let methodMismatch = false;
  for (const [method, pattern, handler] of ROUTES) {
    const params = match(pattern, sub);
    if (!params) continue;
    if (method !== req.method) { methodMismatch = true; continue; }
    try {
      return await handler({ req, env, ctx, params, url });
    } catch (e) {
      if (e instanceof ExternalApiError) {
        console.log(`[edge-api] ${req.method} ${url.pathname}: ${e.status} ${e.code} ${e.message.slice(0, 200)}`);
        return fail(e.status, e.code, e.message, e.retryAfter ? { "retry-after": e.retryAfter } : undefined);
      }
      console.log(`[edge-api] ${req.method} ${url.pathname} failed: ${String(e).slice(0, 300)}`);
      return fail(500, "INTERNAL");
    }
  }
  return methodMismatch ? fail(405, "METHOD_NOT_ALLOWED") : fail(404, "NOT_FOUND");
}
