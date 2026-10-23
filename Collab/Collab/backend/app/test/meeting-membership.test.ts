// db.conversations.isMember must resolve MEETING chat membership ("meeting:<id>")
// from meeting participation (host / attendee / live presence) — since meeting
// conversations have no conversation_members rows — while leaving normal
// conversation membership (conversation_members) unchanged. This is the gate for
// in-meeting chat send/read AND its E2EE key exchange, so a regression here
// silently 403s meeting chat for participants (the live bug this fixes).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

let dbUp = false;
let db: any;

const MID = "m_memtest";
const HOST = "u_mem_host";
const ATT = "u_mem_att";
const PRES = "u_mem_pres";
const OUT = "u_mem_out";
const CONV = "c_memtest";
const CMEMBER = "u_mem_conv";

before(async () => {
  await useTestDatabase();
  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    await migrate(platform.config.database.url);
    const p = db.pool;
    // The rows below FK-reference users(id), so create the users first (upsert is
    // idempotent for re-runs).
    for (const id of [HOST, ATT, PRES, CMEMBER]) {
      await db.users.upsert({ id, email: `${id}@t.test`, name: id, initials: "ZZ", color: "#94A3B8", avatarUrl: "", role: "member", presence: "offline" });
    }
    // Meeting owned by HOST, with ATT as a formal attendee and PRES live in the room.
    await p.query("INSERT IGNORE INTO meetings (id, created_by, title, starts_at) VALUES (?,?,?, now())", [MID, HOST, "Mem Test"]);
    await p.query("INSERT IGNORE INTO meeting_attendees (meeting_id, user_id) VALUES (?,?)", [MID, ATT]);
    await p.query(
      "INSERT IGNORE INTO meeting_presence (meeting_id, user_id, joined_at, last_seen) VALUES (?,?, now(), now())",
      [MID, PRES],
    );
    // A normal conversation with one member (the untouched path).
    await p.query("INSERT IGNORE INTO conversations (id, kind) VALUES (?, 'group')", [CONV]);
    await p.query("INSERT IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?,?, 'member')", [CONV, CMEMBER]);
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — meeting-membership cases will skip:", e.message);
  }
});

function dbTest(name: string, fn: () => Promise<void>) {
  test(name, async (t) => {
    if (!dbUp) return (t as any).skip("MySQL unavailable");
    await fn();
  });
}

dbTest("meeting:<id> membership = host / attendee / live participant", async () => {
  assert.equal(await db.conversations.isMember(`meeting:${MID}`, HOST), true, "host");
  assert.equal(await db.conversations.isMember(`meeting:${MID}`, ATT), true, "attendee");
  assert.equal(await db.conversations.isMember(`meeting:${MID}`, PRES), true, "live participant");
  assert.equal(await db.conversations.isMember(`meeting:${MID}`, OUT), false, "outsider is NOT a member");
});

dbTest("normal conversation membership is unaffected (conversation_members path)", async () => {
  assert.equal(await db.conversations.isMember(CONV, CMEMBER), true, "real member");
  assert.equal(await db.conversations.isMember(CONV, OUT), false, "non-member");
  // A meeting id that doesn't exist grants nobody.
  assert.equal(await db.conversations.isMember("meeting:does-not-exist", HOST), false, "unknown meeting");
});
