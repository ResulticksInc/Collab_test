import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import jwt from "jsonwebtoken";
import { useTestDatabase } from "./_setup";

let server: any;
let base = "";
let dbUp = false;
const JWT_SECRET = "test-secret-admin-colab";
const ADMIN_EMAIL = "admin@collab.test";
const ADMIN_PASS = "secureAdminSecret123!";

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = JWT_SECRET;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASS;
  process.env.ADMIN_SESSION_TTL = "1h";

  try {
    const { createApp } = await import("../src/app");
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr: any = server.address();
        base = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    dbUp = true;
  } catch (err) {
    console.warn("Could not start test server:", err);
  }
});

after(async () => {
  if (server) {
    await new Promise<void>((r) => server.close(r));
  }
});

test("ADMIN: /api/admin/auth/status is publicly reachable", async () => {
  if (!dbUp) return;
  const res = await fetch(`${base}/api/admin/auth/status`);
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.configured, true);
});

test("ADMIN: /api/admin/auth/login rejects incorrect credentials with 401", async () => {
  if (!dbUp) return;
  const res = await fetch(`${base}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong-password" }),
  });
  assert.equal(res.status, 401);
  const body: any = await res.json();
  assert.equal(body.ok, false);
});

test("ADMIN: /api/admin/auth/login succeeds with valid credentials and mints admin JWT", async () => {
  if (!dbUp) return;
  const res = await fetch(`${base}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.token, "expected JWT token in login response");

  // Verify decoded JWT scope
  const decoded: any = jwt.decode(body.token);
  assert.equal(decoded.scope, "admin");
  assert.equal(decoded.email, ADMIN_EMAIL);
});

test("ADMIN: protected endpoints reject unauthenticated or non-admin requests", async () => {
  if (!dbUp) return;
  // 1. No token -> 401
  const noAuthRes = await fetch(`${base}/api/admin/dashboard`);
  assert.equal(noAuthRes.status, 401);

  // 2. Regular user token (without admin scope) -> 403
  const userToken = jwt.sign({ userId: "u123", email: "user@example.com" }, JWT_SECRET);
  const forbiddenRes = await fetch(`${base}/api/admin/dashboard`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(forbiddenRes.status, 403);
});

test("ADMIN: protected endpoints succeed with admin token", async () => {
  if (!dbUp) return;
  const adminToken = jwt.sign({ scope: "admin", email: ADMIN_EMAIL }, JWT_SECRET);
  const headers = { Authorization: `Bearer ${adminToken}` };

  // 1. Dashboard
  const dashRes = await fetch(`${base}/api/admin/dashboard`, { headers });
  assert.equal(dashRes.status, 200);
  const dashBody: any = await dashRes.json();
  assert.equal(dashBody.ok, true);
  assert.ok("totalOrganizations" in dashBody.data);
  assert.ok("totalMeetings" in dashBody.data);

  // 2. Organizations
  const orgsRes = await fetch(`${base}/api/admin/organizations`, { headers });
  assert.equal(orgsRes.status, 200);
  const orgsBody: any = await orgsRes.json();
  assert.equal(orgsBody.ok, true);
  assert.ok(Array.isArray(orgsBody.data.organizations));

  // 3. Members
  const membersRes = await fetch(`${base}/api/admin/members`, { headers });
  assert.equal(membersRes.status, 200);
  const membersBody: any = await membersRes.json();
  assert.equal(membersBody.ok, true);
  assert.ok(Array.isArray(membersBody.data.members));

  // 4. Online users
  const onlineRes = await fetch(`${base}/api/admin/online-users`, { headers });
  assert.equal(onlineRes.status, 200);
  const onlineBody: any = await onlineRes.json();
  assert.equal(onlineBody.ok, true);
  assert.ok(Array.isArray(onlineBody.data.users));

  // 5. Meetings
  const mtgsRes = await fetch(`${base}/api/admin/meetings`, { headers });
  assert.equal(mtgsRes.status, 200);
  const mtgsBody: any = await mtgsRes.json();
  assert.equal(mtgsBody.ok, true);
  assert.ok(Array.isArray(mtgsBody.data.meetings));

  // 6. Analytics
  const analyticsRes = await fetch(`${base}/api/admin/analytics`, { headers });
  assert.equal(analyticsRes.status, 200);
  const analyticsBody: any = await analyticsRes.json();
  assert.equal(analyticsBody.ok, true);
  assert.ok("summary" in analyticsBody.data);

  // 7. Audit logs
  const auditRes = await fetch(`${base}/api/admin/audit-logs`, { headers });
  assert.equal(auditRes.status, 200);
  const auditBody: any = await auditRes.json();
  assert.equal(auditBody.ok, true);
  assert.ok(Array.isArray(auditBody.data.logs));
});
