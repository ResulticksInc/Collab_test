import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// Organizations RBAC (Phase 2) tests. Driven through the real db.orgs resolver +
// rbacService.can() against the seeded `colab` MySQL DB (same strategy as
// messaging/calls-signalling: skip if MySQL is unreachable). Verifies the role
// catalog (0069) resolves the correct permission set per role, and that a
// non-member / inactive membership is fail-CLOSED (zero permissions).

let dbUp = false;
let db: any;
let rbac: any;

const ORG = "org_rbactest";
const OWNER = "u_rbac_owner";
const ADMIN = "u_rbac_admin";
const MEMBER = "u_rbac_member";
const OUTSIDER = "u_rbac_outsider";

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";
  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    await migrate(platform.config.database.url);
    rbac = await import("../src/services/rbacService");
    // A throwaway org with one member per role (idempotent so re-runs are clean).
    await db.pool.query(
      "INSERT IGNORE INTO organizations (id,name,slug) VALUES (?,?,?)",
      [ORG, "RBAC Test Org", "rbac-test-org"],
    );
    for (const [uid, role] of [
      [OWNER, "owner"],
      [ADMIN, "admin"],
      [MEMBER, "member"],
    ] as const) {
      await db.pool.query(
        `INSERT INTO organization_members (id,organization_id,user_id,role,status)
           VALUES (?,?,?,?, 'active')
         ON DUPLICATE KEY UPDATE role=VALUES(role), status='active', deleted=0`,
        [`m_${uid}`, ORG, uid, role],
      );
    }
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — RBAC cases will skip:", e.message);
  }
});

after(async () => {
  // Self-clean the throwaway RBAC org + its memberships from the shared DB.
  if (dbUp && db?.pool) {
    try {
      await db.pool.query("DELETE FROM organization_members WHERE organization_id=?", [ORG]);
      await db.pool.query("DELETE FROM organizations WHERE id=?", [ORG]);
    } catch {
      /* best-effort cleanup */
    }
  }
  if (db?.pool?.end) await db.pool.end();
});

const dbTest = (name: string, fn: any) =>
  test(name, async (t) => {
    if (!dbUp) return t.skip("MySQL unavailable");
    await fn(t);
  });

dbTest("owner holds every permission incl. org:delete", async () => {
  const perms = await db.orgs.permissionsForMember(OWNER, ORG);
  assert.ok(perms.includes("org:delete"), "owner can delete the org");
  assert.ok(perms.includes("members:manage"));
  assert.equal(perms.length, 10);
});

dbTest("admin holds members:manage but NOT org:delete", async () => {
  assert.equal(await rbac.can(ADMIN, ORG, "members:manage"), true);
  assert.equal(await rbac.can(ADMIN, ORG, "org:delete"), false);
});

dbTest("member holds no management permissions", async () => {
  assert.equal(await rbac.can(MEMBER, ORG, "members:invite"), false);
  const perms = await db.orgs.permissionsForMember(MEMBER, ORG);
  assert.equal(perms.length, 0);
});

dbTest("a non-member resolves to zero permissions (fail-closed)", async () => {
  assert.equal(await rbac.can(OUTSIDER, ORG, "members:invite"), false);
  const perms = await db.orgs.permissionsForMember(OUTSIDER, ORG);
  assert.equal(perms.length, 0);
});

dbTest("membership() returns the role for a member, null for an outsider", async () => {
  const m = await db.orgs.membership(ADMIN, ORG);
  assert.equal(m?.role, "admin");
  assert.equal(await db.orgs.membership(OUTSIDER, ORG), null);
});
