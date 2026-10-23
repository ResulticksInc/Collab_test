import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// Organizations product-backend tests (#70). Driven through the real orgService +
// db.orgs against the seeded `colab` MySQL DB (skip if unreachable). Covers the
// invariants that aren't a permission check: provisioning makes the creator an
// owner, the >=1-owner guard, switch-org membership enforcement, and invite-by-email
// requiring an existing account.

let dbUp = false;
let db: any;
let orgService: any;

const CREATOR = "u_orgtest_creator";
const OTHER = "u_orgtest_other";
const STRANGER = "u_orgtest_stranger";
const INVITEE = "u_orgtest_invitee";
let orgId: string;

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
    orgService = await import("../src/services/orgService");
    for (const [id, email] of [
      [CREATOR, "creator@orgtest.ex"],
      [OTHER, "other@orgtest.ex"],
      [STRANGER, "stranger@orgtest.ex"],
      [INVITEE, "invitee@orgtest.ex"],
    ] as const) {
      await db.users.upsert({
        id, email, name: id, initials: "OT", color: "#2563EB", presence: "off", passwordHash: null,
      });
    }
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — org cases will skip:", e.message);
  }
});

after(async () => {
  // Self-clean: these tests run against the shared `colab` DB, so remove every
  // artifact they created (orgs by slug, their memberships, the seeded test
  // users + sessions) — otherwise each run leaves junk tenants in the real DB.
  if (dbUp && db?.pool) {
    try {
      await db.pool.query(
        "DELETE FROM organization_members WHERE organization_id IN (SELECT id FROM (SELECT id FROM organizations WHERE slug LIKE 'org-test-co%') t)",
      );
      await db.pool.query("DELETE FROM organizations WHERE slug LIKE 'org-test-co%'");
      await db.pool.query("DELETE FROM auth_sessions WHERE user_id LIKE 'u_orgtest_%'");
      await db.pool.query("DELETE FROM users WHERE id LIKE 'u_orgtest_%'");
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

dbTest("provision makes the creator an active owner", async () => {
  const org = await orgService.provision({ userId: CREATOR, name: "Org Test Co" });
  orgId = org.id;
  assert.ok(org.id && org.slug);
  const m = await db.orgs.membership(CREATOR, orgId);
  assert.equal(m?.role, "owner");
  assert.equal(m?.status, "active");
  assert.equal(await db.orgs.ownerCount(orgId), 1);
});

dbTest("the last owner cannot be demoted", async () => {
  await assert.rejects(
    () => orgService.setMemberRole({ orgId, actorId: CREATOR, userId: CREATOR, role: "admin" }),
    /only owner|LAST_OWNER|owner/i,
  );
});

dbTest("invite-by-email requires an existing account", async () => {
  // NOTE: assert.rejects' RegExp form matches the error MESSAGE, not err.code.
  // The copy was professionalized in 5e85c59 ("No Collab user…" → "No Collab
  // account…") without updating this regex, and because this chain of tests
  // shares fixture state, the mismatch aborted the admin-demotion setup and
  // cascaded 7 downstream "missing expected rejection" failures that LOOKED
  // like rank-ceiling escalations. Match both wordings + the code.
  await assert.rejects(
    () => orgService.addMemberByEmail({ orgId, actorId: CREATOR, email: "nobody@nowhere.ex", role: "member" }),
    /No Collab account|No Collab user|USER_NOT_FOUND/i,
  );
  const added = await orgService.addMemberByEmail({ orgId, actorId: CREATOR, email: "other@orgtest.ex", role: "admin" });
  assert.equal(added.role, "admin");
});

dbTest("a second owner lets the first be demoted (invariant satisfied)", async () => {
  await orgService.setMemberRole({ orgId, actorId: CREATOR, userId: OTHER, role: "owner" });
  assert.equal(await db.orgs.ownerCount(orgId), 2);
  const demoted = await orgService.setMemberRole({ orgId, actorId: CREATOR, userId: CREATOR, role: "admin" });
  assert.equal(demoted.role, "admin");
});

// --- RBAC rank-ceiling (privilege-escalation prevention, Phase A) ---
// After the above, CREATOR is an admin (rank 80) and OTHER is an owner (rank 100).
dbTest("an admin cannot self-promote to owner (rank ceiling)", async () => {
  await assert.rejects(
    () => orgService.setMemberRole({ orgId, actorId: CREATOR, userId: CREATOR, role: "owner" }),
    /higher than your own|ROLE_TOO_HIGH/i,
  );
});

dbTest("an admin cannot change a member who outranks them", async () => {
  await assert.rejects(
    () => orgService.setMemberRole({ orgId, actorId: CREATOR, userId: OTHER, role: "admin" }),
    /outranks you|ROLE_TOO_HIGH/i,
  );
});

dbTest("an admin cannot invite a new member above their own rank", async () => {
  await assert.rejects(
    () => orgService.addMemberByEmail({ orgId, actorId: CREATOR, email: "invitee@orgtest.ex", role: "owner" }),
    /higher than your own|ROLE_TOO_HIGH/i,
  );
  // …but may invite at or below their own rank.
  const added = await orgService.addMemberByEmail({ orgId, actorId: CREATOR, email: "invitee@orgtest.ex", role: "member" });
  assert.equal(added.role, "member");
});

// --- Admin provisioning (enterprise alternative to public sign-up) ---
// CREATOR is an admin (rank 80) at this point; OTHER is an owner.
dbTest("an admin can provision a new local username/password user into the org", async () => {
  const out = await orgService.provisionUser({
    orgId, actorId: CREATOR, email: "provisioned@orgtest.ex",
    name: "Prov User", password: "Str0ng&Secure!", role: "member",
  });
  assert.equal(out.role, "member");
  const created = await db.users.getByEmail("provisioned@orgtest.ex");
  assert.ok(created && created.passwordHash, "account created WITH a password");
  assert.equal((await db.orgs.membership(created.id, orgId))?.role, "member");
});

dbTest("provisioning enforces the rank ceiling and rejects duplicates", async () => {
  await assert.rejects(
    () => orgService.provisionUser({ orgId, actorId: CREATOR, email: "prov2@orgtest.ex", name: "P2", password: "Str0ng&Secure!", role: "owner" }),
    /higher than your own|ROLE_TOO_HIGH/i,
  );
  await assert.rejects(
    () => orgService.provisionUser({ orgId, actorId: CREATOR, email: "provisioned@orgtest.ex", name: "Dup", password: "Str0ng&Secure!", role: "member" }),
    /already exists|USER_EXISTS/i,
  );
});

dbTest("switch-org fails for a non-member, succeeds for a member", async () => {
  await assert.rejects(
    () => orgService.switchOrg({ userId: STRANGER, sessionId: "sess_x", orgId }),
    /not a member|NOT_A_MEMBER/i,
  );
  // OTHER is an owner (member) → allowed. Uses a real session row so the UPDATE lands.
  const jti = "sess_orgtest_" + Date.now();
  await db.pool.query(
    "INSERT INTO auth_sessions (id,user_id,expires_at) VALUES (?,?, now(3) + INTERVAL 1 DAY)",
    [jti, OTHER],
  );
  const out = await orgService.switchOrg({ userId: OTHER, sessionId: jti, orgId });
  assert.equal(out.activeOrgId, orgId);
});
