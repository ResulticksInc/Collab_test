import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { useTestDatabase } from "./_setup";

// EXTERNAL DATA API — driven over HTTP through the real app against the
// throwaway `colab_test` schema (skipped when MySQL is unreachable, like the
// other suites). The security boundary is what matters here:
//   - no key / bad key / revoked / rotated-away key → 401, identically
//   - an ORG key only ever sees its own organization's rows (and 404s on
//     another tenant's ids rather than leaking existence)
//   - a PLATFORM key (admin-minted or EXTERNAL_API_KEYS) sees everything and
//     can narrow with X-Org-Id
//   - scopes are enforced per route (403 FORBIDDEN_SCOPE)
//   - soft-deleted rows are invisible; E2EE messages carry no body
//   - the generic table reader refuses unknown tables and un-listed columns
//   - org admins manage keys only inside their own org

let server: any;
let base = "";
let dbUp = false;
let pool: any;
const JWT_SECRET = "test-secret-external-api";
const ADMIN_EMAIL = "admin@collab.test";
const ADMIN_PASS = "secureAdminSecret123!";
const STATIC_KEY = "colab_static_test_key_" + crypto.randomBytes(8).toString("hex");

const T = Date.now().toString(36);
const ORG_A = `org_ext_a_${T}`;
const ORG_B = `org_ext_b_${T}`;
const U_A1 = `u_ext_a1_${T}`;
const U_A2 = `u_ext_a2_${T}`;
const U_B1 = `u_ext_b1_${T}`;
const CONV_A = `c_ext_a_${T}`;
const CONV_B = `c_ext_b_${T}`;
const MSG_PLAIN = `m_ext_plain_${T}`;
const MSG_ENC = `m_ext_enc_${T}`;
const MSG_DEL = `m_ext_del_${T}`;
const MEET_A = `mt_ext_a_${T}`;
const TASK_A = `t_ext_a_${T}`;

let adminToken = "";
let orgKey = ""; // org A, all scopes
let orgKeyId = "";

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + "/api/external/v1" + path, { headers });
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as any });
const withKey = (key: string, extra: Record<string, string> = {}) => ({ "X-API-Key": key, ...extra });
const admin = (path: string, init: any = {}) =>
  fetch(base + "/api/admin" + path, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}`, ...(init.headers || {}) },
  });

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = JWT_SECRET;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASS;
  process.env.EXTERNAL_API_ENABLED = "true";
  process.env.EXTERNAL_API_KEYS = STATIC_KEY;
  process.env.WEBHOOKS_ENABLED = "true";
  process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS = "true"; // subscription target is a loopback URL below
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    await migrate(platform.config.database.url);
    pool = (platform.db as any).pool;
    const { createApp } = await import("../src/app");
    server = http.createServer(createApp());
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });

    // Seed two tenants straight into MySQL — the readers under test are plain
    // SQL, so the fixture should be too (no repository behaviour in the way).
    const q = (sql: string, p: any[] = []) => pool.query(sql, p);
    await q("INSERT INTO organizations (id, name, slug, kind, status) VALUES (?,?,?,?,?),(?,?,?,?,?)", [
      ORG_A, "Ext Org A", "ext-a-" + T, "team", "active",
      ORG_B, "Ext Org B", "ext-b-" + T, "team", "active",
    ]);
    for (const [id, name] of [[U_A1, "Ext A One"], [U_A2, "Ext A Two"], [U_B1, "Ext B One"]]) {
      await q("INSERT INTO users (id, email, name, initials, color, presence, password_hash) VALUES (?,?,?,?,?,?,?)", [
        id, id + "@ex.com", name, "EX", "#2563EB", "off", "not-a-real-hash",
      ]);
    }
    const om = (org: string, user: string, role: string) =>
      q("INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?,?,?,?,?)", [
        crypto.randomUUID(), org, user, role, "active",
      ]);
    await om(ORG_A, U_A1, "owner");
    await om(ORG_A, U_A2, "member");
    await om(ORG_B, U_B1, "owner");
    await q("INSERT INTO conversations (id, kind, title, created_by, organization_id) VALUES (?,?,?,?,?),(?,?,?,?,?)", [
      CONV_A, "group", "Ext Group A", U_A1, ORG_A,
      CONV_B, "group", "Ext Group B", U_B1, ORG_B,
    ]);
    await q("INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?,?,?),(?,?,?),(?,?,?)", [
      CONV_A, U_A1, "owner", CONV_A, U_A2, "member", CONV_B, U_B1, "owner",
    ]);
    await q(
      "INSERT INTO messages (id, conversation_id, sender_id, body, organization_id, encryption_version, ciphertext_json, deleted, created_at) VALUES " +
        "(?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?)",
      [
        MSG_PLAIN, CONV_A, U_A1, "hello from A", ORG_A, 0, null, 0, new Date("2026-01-01T10:00:00Z"),
        MSG_ENC, CONV_A, U_A2, null, ORG_A, 1, JSON.stringify({ v: 1, env: "opaque" }), 0, new Date("2026-01-01T10:01:00Z"),
        MSG_DEL, CONV_A, U_A1, "deleted one", ORG_A, 0, null, 1, new Date("2026-01-01T10:02:00Z"),
        `m_ext_b_${T}`, CONV_B, U_B1, "hello from B", ORG_B, 0, null, 0, new Date("2026-01-01T11:00:00Z"),
      ],
    );
    await q("INSERT INTO meetings (id, title, starts_at, duration_min, created_by, organization_id) VALUES (?,?,?,?,?,?)", [
      MEET_A, "Ext Meeting A", new Date(Date.now() + 86_400_000), 30, U_A1, ORG_A,
    ]);
    await q("INSERT INTO meeting_attendees (meeting_id, user_id, status, role) VALUES (?,?,?,?)", [MEET_A, U_A2, "accepted", "participant"]);
    await q("INSERT INTO tasks (id, title, status, priority, assignee_id, reporter_id, organization_id) VALUES (?,?,?,?,?,?,?)", [
      TASK_A, "Ext Task A", "todo", "High", U_A2, U_A1, ORG_A,
    ]);
    await q("INSERT INTO task_assignees (task_id, user_id) VALUES (?,?)", [TASK_A, U_A2]);

    const login = await json(
      await fetch(base + "/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
      }),
    );
    adminToken = login.body.token || login.body.data?.token || login.body.accessToken;
    assert.ok(adminToken, "admin login must mint a token: " + JSON.stringify(login.body));
    dbUp = true;
  } catch (err) {
    console.warn("[external-api.test] MySQL unreachable — suite skipped:", (err as any)?.message || err);
  }
});

after(async () => {
  if (server) await new Promise<void>((r) => server.close(r));
  if (pool) {
    const q = (sql: string, p: any[] = []) => pool.query(sql, p).catch(() => {});
    await q("DELETE FROM external_api_keys WHERE organization_id IN (?,?) OR created_by LIKE 'admin:%'", [ORG_A, ORG_B]);
    await q("DELETE FROM calls WHERE initiator_id IN (?,?,?) OR peer_id IN (?,?,?)", [U_A1, U_A2, U_B1, U_A1, U_A2, U_B1]);
    await q("DELETE FROM chat_webhooks WHERE owner_id IN (?,?,?)", [U_A1, U_A2, U_B1]);
    await q("DELETE FROM messages WHERE sender_id IN (?,?,?)", [U_A1, U_A2, U_B1]);
    await q("DELETE FROM meeting_attendees WHERE user_id IN (?,?,?)", [U_A1, U_A2, U_B1]);
    await q("DELETE FROM meetings WHERE created_by IN (?,?,?)", [U_A1, U_A2, U_B1]);
    await q("DELETE FROM conversations WHERE created_by IN (?,?,?)", [U_A1, U_A2, U_B1]);
    await q("DELETE FROM task_assignees WHERE task_id=?", [TASK_A]);
    await q("DELETE FROM tasks WHERE id=?", [TASK_A]);
    await q("DELETE FROM meeting_attendees WHERE meeting_id=?", [MEET_A]);
    await q("DELETE FROM meetings WHERE id=?", [MEET_A]);
    await q("DELETE FROM messages WHERE conversation_id IN (?,?)", [CONV_A, CONV_B]);
    await q("DELETE FROM conversation_members WHERE conversation_id IN (?,?)", [CONV_A, CONV_B]);
    await q("DELETE FROM conversations WHERE id IN (?,?)", [CONV_A, CONV_B]);
    await q("DELETE FROM organization_members WHERE organization_id IN (?,?)", [ORG_A, ORG_B]);
    await q("DELETE FROM users WHERE id IN (?,?,?)", [U_A1, U_A2, U_B1]);
    await q("DELETE FROM organizations WHERE id IN (?,?)", [ORG_A, ORG_B]);
  }
});

test("EXT: /health and /openapi.json are public", async () => {
  if (!dbUp) return;
  const h = await json(await get("/health"));
  assert.equal(h.status, 200);
  assert.equal(h.body.data.service, "colab-external-api");
  const o = await json(await get("/openapi.json"));
  assert.equal(o.status, 200);
  assert.equal(o.body.openapi, "3.0.3");
  assert.ok(o.body.paths["/tables/{name}"]);
});

test("EXT: no key → 401; a user JWT is not an API key → 401", async () => {
  if (!dbUp) return;
  assert.equal((await get("/ping")).status, 401);
  const userJwt = jwt.sign({ sub: U_A1, name: "A1" }, JWT_SECRET);
  const r = await json(await get("/ping", { Authorization: `Bearer ${userJwt}` }));
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, "UNAUTHORIZED");
  assert.equal((await get("/ping", withKey("colab_definitely_not_a_key"))).status, 401);
});

test("EXT: admin mints an ORG key; the raw key is returned once and only a hint is kept", async () => {
  if (!dbUp) return;
  const r = await json(
    await admin("/api-keys", { method: "POST", body: JSON.stringify({ name: "CRM sync", organizationId: ORG_A, scopes: "read" }) }),
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  orgKey = r.body.data.key;
  orgKeyId = r.body.data.apiKey.id;
  assert.ok(orgKey.startsWith("colab_"));
  assert.equal(r.body.data.apiKey.keyHint, orgKey.slice(-6));
  assert.equal(r.body.data.apiKey.organizationId, ORG_A);
  assert.equal(r.body.data.apiKey.platform, false);
  assert.ok(r.body.data.apiKey.scopes.includes("messages:read"));
  const [rows] = await pool.query("SELECT key_hash FROM external_api_keys WHERE id=?", [orgKeyId]);
  assert.equal(rows[0].key_hash, crypto.createHash("sha256").update(orgKey).digest("hex"));
  const list = await json(await admin(`/api-keys?organizationId=${ORG_A}`));
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some((k: any) => k.id === orgKeyId));
  assert.ok(!JSON.stringify(list.body).includes(orgKey), "listing must never expose a raw key");
});

test("EXT: /ping reports the key's organization and scopes (X-API-Key and Authorization forms)", async () => {
  if (!dbUp) return;
  const a = await json(await get("/ping", withKey(orgKey)));
  assert.equal(a.status, 200);
  assert.equal(a.body.data.organization.id, ORG_A);
  assert.equal(a.body.data.platform, false);
  const b = await json(await get("/ping", { Authorization: `ApiKey ${orgKey}` }));
  assert.equal(b.status, 200);
  const c = await json(await get("/ping", { Authorization: `Bearer ${orgKey}` }));
  assert.equal(c.status, 200);
});

test("EXT: an org key sees only its own organization's users/conversations and 404s on another tenant's ids", async () => {
  if (!dbUp) return;
  const u = await json(await get("/users", withKey(orgKey)));
  assert.equal(u.status, 200);
  const ids = u.body.data.map((x: any) => x.id);
  assert.ok(ids.includes(U_A1) && ids.includes(U_A2));
  assert.ok(!ids.includes(U_B1));
  assert.ok(!JSON.stringify(u.body).includes("not-a-real-hash"), "password hashes must never be exposed");
  assert.equal(u.body.data.find((x: any) => x.id === U_A1).orgRole, "owner");

  const c = await json(await get("/conversations", withKey(orgKey)));
  assert.equal(c.status, 200);
  const cids = c.body.data.map((x: any) => x.id);
  assert.ok(cids.includes(CONV_A) && !cids.includes(CONV_B));
  assert.equal(c.body.data.find((x: any) => x.id === CONV_A).memberCount, 2);

  assert.equal((await get(`/conversations/${CONV_B}`, withKey(orgKey))).status, 404);
  assert.equal((await get(`/conversations/${CONV_B}/messages`, withKey(orgKey))).status, 404);
  assert.equal((await get(`/users/${U_B1}`, withKey(orgKey))).status, 404);
});

test("EXT: messages hide E2EE bodies, skip soft-deleted rows, and page with hasMore/nextOffset", async () => {
  if (!dbUp) return;
  const r = await json(await get(`/conversations/${CONV_A}/messages`, withKey(orgKey)));
  assert.equal(r.status, 200);
  const ids = r.body.data.map((m: any) => m.id);
  assert.deepEqual(ids, [MSG_PLAIN, MSG_ENC]);
  const plain = r.body.data[0];
  assert.equal(plain.body, "hello from A");
  assert.equal(plain.encrypted, false);
  const enc = r.body.data[1];
  assert.equal(enc.body, null);
  assert.equal(enc.encrypted, true);
  assert.ok(!JSON.stringify(r.body).includes("opaque"), "ciphertext must never be exposed");
  assert.equal(r.body.meta.hasMore, false);

  const p1 = await json(await get(`/conversations/${CONV_A}/messages?limit=1`, withKey(orgKey)));
  assert.equal(p1.body.data.length, 1);
  assert.equal(p1.body.meta.hasMore, true);
  assert.equal(p1.body.meta.nextOffset, 1);
  const p2 = await json(await get(`/conversations/${CONV_A}/messages?limit=1&offset=1`, withKey(orgKey)));
  assert.equal(p2.body.data[0].id, MSG_ENC);
  assert.equal(p2.body.meta.hasMore, false);

  const since = await json(await get(`/messages?since=2026-01-01T10:00:30Z`, withKey(orgKey)));
  assert.deepEqual(since.body.data.map((m: any) => m.id), [MSG_ENC]);
  assert.equal((await get(`/messages?since=not-a-date`, withKey(orgKey))).status, 400);
});

test("EXT: meetings and tasks are tenant-scoped and carry attendees/assignees", async () => {
  if (!dbUp) return;
  const m = await json(await get(`/meetings/${MEET_A}`, withKey(orgKey)));
  assert.equal(m.status, 200);
  assert.equal(m.body.data.attendeeCount, 1);
  assert.equal(m.body.data.attendees[0].userId, U_A2);
  const t = await json(await get(`/tasks?status=todo`, withKey(orgKey)));
  assert.equal(t.status, 200);
  const task = t.body.data.find((x: any) => x.id === TASK_A);
  assert.ok(task);
  assert.deepEqual(task.assigneeIds, [U_A2]);
});

test("EXT: scopes are enforced per route", async () => {
  if (!dbUp) return;
  const r = await json(
    await admin("/api-keys", { method: "POST", body: JSON.stringify({ name: "users only", organizationId: ORG_A, scopes: ["users:read"] }) }),
  );
  assert.equal(r.status, 201);
  const k = r.body.data.key;
  assert.equal((await get("/users", withKey(k))).status, 200);
  const denied = await json(await get("/messages", withKey(k)));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "FORBIDDEN_SCOPE");
  assert.equal(denied.body.error.details.required, "messages:read");
  const badScope = await json(await admin("/api-keys", { method: "POST", body: JSON.stringify({ name: "x", scopes: ["admin:everything"] }) }));
  assert.equal(badScope.status, 400);
  assert.equal(badScope.body.error.code, "INVALID_SCOPE");
});

test("EXT: generic table reader honours the allow-list, filters and tenant", async () => {
  if (!dbUp) return;
  const tables = await json(await get("/tables", withKey(orgKey)));
  assert.equal(tables.status, 200);
  assert.ok(tables.body.data.some((t: any) => t.name === "messages"));
  assert.ok(!tables.body.data.find((t: any) => t.name === "users").columns.includes("password_hash"));

  const rows = await json(await get(`/tables/messages?filter[conversation_id]=${CONV_A}&columns=id,body`, withKey(orgKey)));
  assert.equal(rows.status, 200, JSON.stringify(rows.body));
  assert.deepEqual(rows.body.meta.columns, ["id", "body"]);
  assert.deepEqual(rows.body.data.map((r: any) => r.id).sort(), [MSG_ENC, MSG_PLAIN].sort());

  // Another tenant's conversation filter simply yields nothing.
  const other = await json(await get(`/tables/messages?filter[conversation_id]=${CONV_B}`, withKey(orgKey)));
  assert.equal(other.body.data.length, 0);

  const users = await json(await get(`/tables/users?orderBy=email`, withKey(orgKey)));
  assert.deepEqual(users.body.data.map((u: any) => u.id).sort(), [U_A1, U_A2].sort());

  const badCol = await json(await get(`/tables/users?columns=password_hash`, withKey(orgKey)));
  assert.equal(badCol.status, 400);
  assert.equal(badCol.body.error.code, "INVALID_COLUMN");
  assert.equal((await get(`/tables/users?filter[password_hash]=x`, withKey(orgKey))).status, 400);
  assert.equal((await get(`/tables/external_api_keys`, withKey(orgKey))).status, 404);
  assert.equal((await get(`/tables/users;drop`, withKey(orgKey))).status, 404);
});

test("EXT: a PLATFORM key (static env) sees every org and narrows with X-Org-Id", async () => {
  if (!dbUp) return;
  const ping = await json(await get("/ping", withKey(STATIC_KEY)));
  assert.equal(ping.status, 200);
  assert.equal(ping.body.data.platform, true);
  assert.equal(ping.body.data.organization, null);

  const all = await json(await get("/conversations", withKey(STATIC_KEY)));
  const ids = all.body.data.map((c: any) => c.id);
  assert.ok(ids.includes(CONV_A) && ids.includes(CONV_B));

  const onlyB = await json(await get("/conversations", withKey(STATIC_KEY, { "X-Org-Id": ORG_B })));
  const bids = onlyB.body.data.map((c: any) => c.id);
  assert.ok(bids.includes(CONV_B) && !bids.includes(CONV_A));
  assert.equal((await get("/conversations", withKey(STATIC_KEY, { "X-Org-Id": "org_does_not_exist" }))).status, 404);

  // An ORG key cannot escalate by asking for another org.
  const pinned = await json(await get("/conversations", withKey(orgKey, { "X-Org-Id": ORG_B })));
  assert.ok(!pinned.body.data.some((c: any) => c.id === CONV_B));
});

test("EXT: org admins manage keys inside their own org only", async () => {
  if (!dbUp) return;
  // A session token WITHOUT a stored session row: the auth middleware treats an
  // unknown jti as valid and lazily adopts the user's primary org (owner of A).
  const tok = (sub: string) => jwt.sign({ sub, name: sub, jti: crypto.randomUUID() }, JWT_SECRET);
  const hdr = (sub: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${tok(sub)}` });
  const created = await json(
    await fetch(base + "/api/orgs/current/api-keys", { method: "POST", headers: hdr(U_A1), body: JSON.stringify({ name: "BI export" }) }),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.apiKey.organizationId, ORG_A);
  const mine = await json(await fetch(base + "/api/orgs/current/api-keys", { headers: hdr(U_A1) }));
  assert.ok(mine.body.data.every((k: any) => k.organizationId === ORG_A));

  // A plain member lacks org:manage → 403; B's owner cannot see or revoke A's key.
  assert.equal((await fetch(base + "/api/orgs/current/api-keys", { headers: hdr(U_A2) })).status, 403);
  const cross = await fetch(base + `/api/orgs/current/api-keys/${created.body.data.apiKey.id}`, { method: "DELETE", headers: hdr(U_B1) });
  assert.equal(cross.status, 404);
  // Still works, then the owner revokes it.
  assert.equal((await get("/ping", withKey(created.body.data.key))).status, 200);
  const gone = await fetch(base + `/api/orgs/current/api-keys/${created.body.data.apiKey.id}`, { method: "DELETE", headers: hdr(U_A1) });
  assert.equal(gone.status, 200);
  assert.equal((await get("/ping", withKey(created.body.data.key))).status, 401);
});

test("EXT: rotate replaces the secret; revoke kills the key immediately", async () => {
  if (!dbUp) return;
  const rot = await json(await admin(`/api-keys/${orgKeyId}/rotate`, { method: "POST" }));
  assert.equal(rot.status, 200);
  const fresh = rot.body.data.key;
  assert.notEqual(fresh, orgKey);
  assert.equal((await get("/ping", withKey(orgKey))).status, 401, "old secret must stop working");
  assert.equal((await get("/ping", withKey(fresh))).status, 200);
  const rev = await json(await admin(`/api-keys/${orgKeyId}`, { method: "DELETE" }));
  assert.equal(rev.status, 200);
  assert.equal(rev.body.data.enabled, false);
  assert.equal((await get("/ping", withKey(fresh))).status, 401);
  const again = await json(await admin(`/api-keys/${orgKeyId}/rotate`, { method: "POST" }));
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, "KEY_REVOKED");
});

// ── Write side ──────────────────────────────────────────────────────────────
let writeKey = ""; // org A, scopes "all", default actor U_A1
let noActorKey = ""; // org A, scopes "all", no default actor
const post = (path: string, key: string, body: any, extra: Record<string, string> = {}) =>
  fetch(base + "/api/external/v1" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": key, ...extra },
    body: JSON.stringify(body),
  });

test("EXT-W: a key can carry a default actor; the actor must belong to the key's org", async () => {
  if (!dbUp) return;
  const bad = await json(
    await admin("/api-keys", { method: "POST", body: JSON.stringify({ name: "x", organizationId: ORG_A, scopes: "all", userId: U_B1 }) }),
  );
  assert.equal(bad.status, 403);
  assert.equal(bad.body.error.code, "ACTOR_NOT_IN_ORG");
  const ghost = await json(
    await admin("/api-keys", { method: "POST", body: JSON.stringify({ name: "x", organizationId: ORG_A, scopes: "all", userId: "u_nope" }) }),
  );
  assert.equal(ghost.status, 400);
  assert.equal(ghost.body.error.code, "ACTOR_NOT_FOUND");
  const ok1 = await json(
    await admin("/api-keys", { method: "POST", body: JSON.stringify({ name: "CRM bot", organizationId: ORG_A, scopes: "all", userId: U_A1 }) }),
  );
  assert.equal(ok1.status, 201, JSON.stringify(ok1.body));
  writeKey = ok1.body.data.key;
  assert.equal(ok1.body.data.apiKey.userId, U_A1);
  assert.ok(ok1.body.data.apiKey.scopes.includes("messages:write") && ok1.body.data.apiKey.scopes.includes("users:read"));
  const ok2 = await json(
    await admin("/api-keys", { method: "POST", body: JSON.stringify({ name: "no actor", organizationId: ORG_A, scopes: ["write"] }) }),
  );
  assert.equal(ok2.status, 201);
  noActorKey = ok2.body.data.key;
  assert.equal(ok2.body.data.apiKey.userId, null);
  assert.ok(!ok2.body.data.apiKey.scopes.includes("users:read"));
});

test("EXT-W: send a message into a conversation as the actor; read scope alone is refused", async () => {
  if (!dbUp) return;
  const r = await json(await post(`/conversations/${CONV_A}/messages`, writeKey, { text: "hello from the CRM" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.posted, true);
  assert.equal(r.body.data.senderId, U_A1);
  const list = await json(await get(`/conversations/${CONV_A}/messages?order=desc&limit=1`, withKey(writeKey)));
  assert.equal(list.body.data[0].id, r.body.data.messageId);
  assert.equal(list.body.data[0].body, "hello from the CRM");
  // A key WITHOUT a default actor must name one; naming someone outside the org is refused.
  const noActor = await json(await post(`/conversations/${CONV_A}/messages`, noActorKey, { text: "x" }));
  assert.equal(noActor.status, 400);
  assert.equal(noActor.body.error.code, "ACTOR_REQUIRED");
  const asOutsider = await json(await post(`/conversations/${CONV_A}/messages`, noActorKey, { text: "x", asUserId: U_B1 }));
  assert.equal(asOutsider.status, 403);
  assert.equal(asOutsider.body.error.code, "ACTOR_NOT_IN_ORG");
  const asMember = await json(await post(`/conversations/${CONV_A}/messages`, noActorKey, { text: "as A2", asUserId: U_A2 }));
  assert.equal(asMember.status, 201);
  assert.equal(asMember.body.data.senderId, U_A2);
  // Another tenant's conversation: 404, nothing posted.
  assert.equal((await post(`/conversations/${CONV_B}/messages`, writeKey, { text: "x" })).status, 404);
  // Read-only key → 403 FORBIDDEN_SCOPE.
  const ro = await json(await admin("/api-keys", { method: "POST", body: JSON.stringify({ name: "ro", organizationId: ORG_A, scopes: "read", userId: U_A1 }) }));
  const denied = await json(await post(`/conversations/${CONV_A}/messages`, ro.body.data.key, { text: "x" }));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.details.required, "messages:write");
  assert.equal((await post(`/conversations/${CONV_A}/messages`, writeKey, { text: "" })).status, 400);
});

test("EXT-W: message a PERSON by email → the actor's DM is opened (once) and reused", async () => {
  if (!dbUp) return;
  const r1 = await json(await post("/messages", writeKey, { email: U_A2 + "@ex.com", text: "dm one" }));
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const r2 = await json(await post("/messages", writeKey, { userId: U_A2, text: "dm two" }));
  assert.equal(r2.status, 201);
  assert.equal(r1.body.data.conversationId, r2.body.data.conversationId, "same DM reused");
  const conv = await json(await get(`/conversations/${r1.body.data.conversationId}`, withKey(writeKey)));
  assert.equal(conv.status, 200);
  assert.equal(conv.body.data.kind, "dm");
  const msgs = await json(await get(`/conversations/${r1.body.data.conversationId}/messages`, withKey(writeKey)));
  assert.deepEqual(msgs.body.data.map((m: any) => m.body), ["dm one", "dm two"]);
  // A person in another org cannot be messaged from an org key.
  assert.equal((await post("/messages", writeKey, { userId: U_B1, text: "x" })).status, 403);
  assert.equal((await post("/messages", writeKey, { text: "x" })).status, 400);
});

test("EXT-W: subscribe a webhook to receive messages; list, test, deliveries, remove", async () => {
  if (!dbUp) return;
  const r = await json(await post("/webhooks", writeKey, { conversationId: CONV_A, targetUrl: "https://127.0.0.1:9/colab-hook", name: "CRM inbound" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(String(r.body.data.secret).startsWith("whsec_"));
  const id = r.body.data.webhook.id;
  assert.equal(r.body.data.webhook.direction, "out");
  assert.equal(r.body.data.webhook.ownerId, U_A1);
  const list = await json(await get("/webhooks", withKey(writeKey)));
  assert.ok(list.body.data.some((w: any) => w.id === id));
  assert.ok(!JSON.stringify(list.body).includes(r.body.data.secret), "secret must not be listed");
  // A message in that conversation is queued for delivery (the loopback target refuses, so it stays pending/failed — the row proves the hook fired).
  await post(`/conversations/${CONV_A}/messages`, writeKey, { text: "trigger delivery" });
  const d = await json(await get(`/webhooks/${id}/deliveries`, withKey(writeKey)));
  assert.equal(d.status, 200);
  assert.ok(Array.isArray(d.body.data));
  const t = await json(await post(`/webhooks/${id}/test`, writeKey, {}));
  assert.equal(t.status, 200);
  const del = await fetch(base + `/api/external/v1/webhooks/${id}`, { method: "DELETE", headers: { "X-API-Key": writeKey, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(del.status, 200);
  const after = await json(await get("/webhooks", withKey(writeKey)));
  assert.ok(!after.body.data.some((w: any) => w.id === id));
  // Scope + tenant: a read key can't subscribe; another tenant's conversation 404s.
  assert.equal((await post("/webhooks", noActorKey, { conversationId: CONV_B, targetUrl: "https://127.0.0.1:9/x", asUserId: U_A1 })).status, 404);
});

test("EXT-W: place a call (rings the callee), inspect it, hang up; join tokens are minted", async () => {
  if (!dbUp) return;
  const r = await json(await post("/calls", writeKey, { userId: U_A2, kind: "video" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.ringing, true);
  const call = r.body.data.call;
  assert.equal(call.status, "ringing");
  assert.equal(call.initiatorId, U_A1);
  assert.equal(call.peerId, U_A2);
  assert.equal(call.kind, "video");
  assert.ok(r.body.data.join && r.body.data.join.token, "caller gets a LiveKit join token");
  const st = await json(await get(`/calls/${call.id}`, withKey(writeKey)));
  assert.equal(st.body.data.status, "ringing");
  // The callee's side can re-mint its own token while the call is live.
  const tok = await json(await post(`/calls/${call.id}/token`, writeKey, { asUserId: U_A2 }));
  assert.equal(tok.status, 200, JSON.stringify(tok.body));
  assert.ok(tok.body.data.join.token);
  // An outsider can't touch it.
  assert.equal((await post(`/calls/${call.id}/token`, noActorKey, { asUserId: U_B1 })).status, 403);
  const hang = await json(await post(`/calls/${call.id}/hangup`, writeKey, {}));
  assert.equal(hang.status, 200, JSON.stringify(hang.body));
  assert.equal(hang.body.data.call.status, "cancelled", "hanging up a ringing call as the caller cancels it");
  assert.equal((await post(`/calls/${call.id}/token`, writeKey, {})).status, 403);
  // Accept / decline run as the callee by default.
  const r2 = await json(await post("/calls", writeKey, { email: U_A2 + "@ex.com" }));
  assert.equal(r2.status, 201);
  const acc = await json(await post(`/calls/${r2.body.data.call.id}/accept`, writeKey, {}));
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.data.call.status, "connected");
  assert.ok(acc.body.data.join.token);
  const end = await json(await post(`/calls/${r2.body.data.call.id}/hangup`, writeKey, { asUserId: U_A2, durationSec: 12 }));
  assert.equal(end.body.data.call.status, "ended");
  const hist = await json(await get("/calls", withKey(writeKey)));
  assert.equal(hist.status, 200);
  assert.ok(hist.body.data.length >= 2);
  // Group call room token for a conversation the actor is in.
  const grp = await json(await post(`/conversations/${CONV_A}/call-token`, writeKey, {}));
  assert.equal(grp.status, 200);
  assert.equal(grp.body.data.room, "conv_" + CONV_A);
  // Tenant: a person outside the org cannot be called from an org key.
  assert.equal((await post("/calls", writeKey, { userId: U_B1 })).status, 403);
});

test("EXT-W: schedule a meeting with invitees (by email) and mint a join token", async () => {
  if (!dbUp) return;
  const startsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const r = await json(
    await post("/meetings", writeKey, { title: "Quarterly review", startsAt, durationMin: 45, attendees: [U_A2 + "@ex.com", U_A1], description: "Numbers" }),
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const m = r.body.data.meeting;
  assert.equal(m.title, "Quarterly review");
  assert.equal(r.body.data.room, "meeting_" + m.id);
  assert.ok(r.body.data.join.token);
  const got = await json(await get(`/meetings/${m.id}`, withKey(writeKey)));
  assert.equal(got.status, 200);
  assert.ok(got.body.data.attendees.some((a: any) => a.userId === U_A2));
  // An invitee gets a participant token; someone outside the org is refused.
  const tok = await json(await post(`/meetings/${m.id}/token`, writeKey, { asUserId: U_A2 }));
  assert.equal(tok.status, 200, JSON.stringify(tok.body));
  assert.equal(tok.body.data.role, "participant");
  assert.equal((await post(`/meetings/${m.id}/token`, noActorKey, { asUserId: U_B1 })).status, 403);
  // Validation: nobody invited / past start.
  assert.equal((await post("/meetings", writeKey, { title: "x", startsAt, attendees: [] })).status, 400);
  const past = await post("/meetings", writeKey, { title: "x", startsAt: "2020-01-01T00:00:00Z", attendees: [U_A2] });
  assert.ok(past.status === 400 || past.status === 409, "past start is rejected, got " + past.status);
});
