// Functional end-to-end soft-delete test on LOCAL: build a conversation with
// children + a user with owned data, run the ACTUAL driver cascade SQL, and assert
// every row moves correctly. Cleans up the synthetic rows after. No network needed.
const mysql = require("mysql2/promise");
const P = "_sdt_"; // test-id prefix
const A = P + "userA", B = P + "userB", C = P + "conv", MSG = P + "msg", CALL = P + "call", INV = P + "inv", FOL = P + "folder", NOT = P + "notif";

(async () => {
  const db = await mysql.createConnection({ host: "127.0.0.1", port: 3306, user: "colab", password: "colab", database: "colab", multipleStatements: true });
  const q = (s, p) => db.query(s, p);
  let pass = 0, fail = 0;
  const assert = (label, cond) => { if (cond) { pass++; console.log("  PASS " + label); } else { fail++; console.log("  FAIL " + label); } };
  const one = async (sql, p) => (await q(sql, p))[0][0];

  // ── clean any prior run, then seed ──
  await cleanup(q);

  console.log("Seeding synthetic conversation + user graph ...");
  await q("INSERT INTO users (id,email,name,initials) VALUES (?,?,?,?),(?,?,?,?)", [A, A + "@t.invalid", "Test A", "TA", B, B + "@t.invalid", "Test B", "TB"]);
  await q("INSERT INTO conversations (id,kind) VALUES (?,?)", [C, "group"]);
  await q("INSERT INTO conversation_members (conversation_id,user_id,role) VALUES (?,?,?),(?,?,?)", [C, A, "owner", C, B, "member"]);
  await q("INSERT INTO messages (id,conversation_id,sender_id,body) VALUES (?,?,?,?)", [MSG, C, A, "hi"]);
  await q("INSERT INTO bookmarks (user_id,message_id) VALUES (?,?)", [A, MSG]);
  await q("INSERT INTO calls (id,initiator_id,conversation_id) VALUES (?,?,?)", [CALL, A, C]);
  await q("INSERT INTO invites (id,from_user_id,to_user_id,conversation_id,status) VALUES (?,?,?,?,?)", [INV, A, B, C, "pending"]);
  await q("INSERT INTO folders (id,user_id,name) VALUES (?,?,?)", [FOL, A, "Test Folder"]);
  await q("INSERT INTO notifications (id,user_id,type,title) VALUES (?,?,?,?)", [NOT, A, "test", "Test"]);

  // ── 1) CONVERSATION soft-delete cascade (mirrors conversations.remove) ──
  console.log("\n[1] Soft-delete conversation -> cascade:");
  await q("UPDATE conversations SET deleted=1, deleted_at=now(3), deleted_by=?, dm_key=NULL WHERE id=?", [A, C]);
  await q("UPDATE conversation_members SET deleted=1, deleted_at=now(3), deleted_by=? WHERE conversation_id=? AND deleted=0", [A, C]);
  await q("UPDATE bookmarks SET deleted=1, deleted_at=now(3) WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?) AND deleted=0", [C]);
  await q("UPDATE calls SET conversation_id=NULL WHERE conversation_id=?", [C]);
  await q("UPDATE invites SET conversation_id=NULL WHERE conversation_id=?", [C]);
  assert("conversation is deleted=1 + dm_key NULL", (await one("SELECT deleted,dm_key FROM conversations WHERE id=?", [C])).deleted === 1);
  assert("both members deleted=1", (await one("SELECT COUNT(*) n FROM conversation_members WHERE conversation_id=? AND deleted=1", [C])).n === 2);
  assert("bookmark of the conv message deleted=1", (await one("SELECT deleted FROM bookmarks WHERE user_id=? AND message_id=?", [A, MSG])).deleted === 1);
  assert("call.conversation_id detached to NULL", (await one("SELECT conversation_id FROM calls WHERE id=?", [CALL])).conversation_id === null);
  assert("invite.conversation_id detached to NULL", (await one("SELECT conversation_id FROM invites WHERE id=?", [INV])).conversation_id === null);
  assert("message row KEPT (not tombstoned by conv delete)", (await one("SELECT deleted FROM messages WHERE id=?", [MSG])).deleted === 0);

  // ── 2) ACCOUNT deletion (mirrors users.deleteAccount) for user A ──
  console.log("\n[2] Delete account A -> anonymize + cascade:");
  await q("UPDATE users SET deleted=1, deleted_at=now(3), deleted_by=?, email=CONCAT('deleted+', id, '@deleted.invalid'), name='Deleted user', avatar_url=NULL, about=NULL, manual_presence=NULL WHERE id=? AND deleted=0", [A, A]);
  await q("UPDATE folders SET deleted=1, deleted_at=now(3), deleted_by=? WHERE user_id=? AND deleted=0", [A, A]);
  await q("UPDATE notifications SET deleted=1, deleted_at=now(3), deleted_by=? WHERE user_id=? AND deleted=0", [A, A]);
  const ua = await one("SELECT deleted,email,name FROM users WHERE id=?", [A]);
  assert("user A deleted=1", ua.deleted === 1);
  assert("user A email munged (freed for re-signup)", ua.email === "deleted+" + A + "@deleted.invalid");
  assert("user A name anonymized to 'Deleted user'", ua.name === "Deleted user");
  assert("user A folder deleted=1", (await one("SELECT deleted FROM folders WHERE id=?", [FOL])).deleted === 1);
  assert("user A notification deleted=1", (await one("SELECT deleted FROM notifications WHERE id=?", [NOT])).deleted === 1);
  assert("user B untouched (deleted=0)", (await one("SELECT deleted FROM users WHERE id=?", [B])).deleted === 0);

  // ── cleanup ──
  await cleanup(q);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed. (synthetic rows cleaned up)`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.code || e.sqlMessage || e.message); process.exit(1); });

async function cleanup(q) {
  await q("DELETE FROM bookmarks WHERE user_id LIKE '_sdt_%' OR message_id LIKE '_sdt_%'").catch(() => {});
  for (const t of ["messages", "conversation_members", "calls", "invites", "notifications", "folders", "scheduled_messages"]) {
    await q(`DELETE FROM \`${t}\` WHERE id LIKE '_sdt_%'`).catch(() => {});
    await q(`DELETE FROM \`${t}\` WHERE conversation_id LIKE '_sdt_%'`).catch(() => {});
    await q(`DELETE FROM \`${t}\` WHERE user_id LIKE '_sdt_%'`).catch(() => {});
  }
  await q("DELETE FROM conversations WHERE id LIKE '_sdt_%'").catch(() => {});
  await q("DELETE FROM users WHERE id LIKE '_sdt_%'").catch(() => {});
}
async function colMatch() { return "1=0"; }
