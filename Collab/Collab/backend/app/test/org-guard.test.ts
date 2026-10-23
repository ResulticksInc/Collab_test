import { test } from "node:test";
import assert from "node:assert/strict";
import { unscopedOrgTable } from "../../../database/src/drivers/mysql";
import { orgContext, currentOrgId } from "../../../database/src/orgContext";

// Organizations Phase 0 — the q() tenant-isolation tripwire's pure detector.
// unscopedOrgTable(sql) returns the first DIRECT org-scoped table used WITHOUT an
// organization_id predicate (the cross-tenant-leak shape), else null. Pure (no env,
// no DB — importing it doesn't load mysql2, which is lazy inside createMysqlDb) so
// this always runs. The driver's q() wraps this behind COLAB_ORG_GUARD + NODE_ENV.

test("flags a DIRECT table query with no organization_id predicate", () => {
  assert.equal(unscopedOrgTable("SELECT * FROM conversations WHERE user_id=$1"), "conversations");
  assert.equal(unscopedOrgTable("UPDATE tasks SET status='done' WHERE id=$1"), "tasks");
  assert.equal(unscopedOrgTable("DELETE FROM reminders WHERE id=$1"), "reminders");
});

test("passes when the query carries an organization_id predicate", () => {
  assert.equal(unscopedOrgTable("SELECT * FROM conversations WHERE organization_id=$1 AND user_id=$2"), null);
  assert.equal(unscopedOrgTable("UPDATE tasks SET status='done' WHERE organization_id=$1 AND id=$2"), null);
});

test("ignores non-org-scoped tables", () => {
  assert.equal(unscopedOrgTable("SELECT * FROM users WHERE id=$1"), null);
  assert.equal(unscopedOrgTable("SELECT * FROM organizations WHERE slug=$1"), null);
  assert.equal(unscopedOrgTable("SELECT id FROM auth_sessions WHERE id=$1"), null);
});

test("ignores INSERT / DDL / SET / health probes", () => {
  assert.equal(unscopedOrgTable("INSERT INTO conversations (id, organization_id) VALUES ($1,$2)"), null);
  assert.equal(unscopedOrgTable("SELECT 1"), null);
  assert.equal(unscopedOrgTable("SET @x := 1"), null);
  assert.equal(unscopedOrgTable("ALTER TABLE conversations ADD COLUMN x INT"), null);
});

test("passes a join where the DIRECT table is scoped by organization_id", () => {
  assert.equal(
    unscopedOrgTable(
      "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.organization_id=$1",
    ),
    null,
  );
});

test("a comment mentioning organization_id does not count as a predicate", () => {
  assert.equal(
    unscopedOrgTable("SELECT * FROM files -- organization_id in a comment\nWHERE id=$1"),
    "files",
  );
});

// The ambient org context is what lets driver queries auto-scope to the tenant with
// no per-call threading — it MUST survive across awaits (the whole async request) and
// be null outside a request (so background jobs stay global).
test("orgContext propagates the active tenant across awaits; null outside", async () => {
  assert.equal(currentOrgId(), null);
  await orgContext.run({ orgId: "ACME" }, async () => {
    assert.equal(currentOrgId(), "ACME");
    await new Promise((r) => setTimeout(r, 3));
    assert.equal(currentOrgId(), "ACME"); // survives the await → the driver sees it
  });
  assert.equal(currentOrgId(), null);
});
