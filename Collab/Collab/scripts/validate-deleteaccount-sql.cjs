// Validate every deleteAccount cascade statement against the REAL local schema by
// running each with a non-existent user id (0 rows, but proves every table/column
// exists and the SQL parses). Run: node scripts/validate-deleteaccount-sql.cjs
const mysql = require("mysql2/promise");
const DUMMY = "__validate_no_such_user__";

const owned = [
  ["conversation_members", "user_id"], ["bookmarks", "user_id"],
  ["meeting_attendees", "user_id"], ["meeting_presence", "user_id"],
  ["folders", "user_id"], ["reminders", "user_id"], ["notifications", "user_id"],
  ["scheduled_messages", "sender_id"], ["voicemails", "from_user"], ["voicemails", "to_user"],
  ["user_blocks", "blocker_id"], ["user_blocks", "blocked_id"],
  ["user_reports", "reporter_id"], ["user_reports", "reported_id"],
  ["invites", "from_user_id"], ["invites", "to_user_id"],
];

(async () => {
  const c = await mysql.createConnection({ host: "127.0.0.1", port: 3306, user: "colab", password: "colab", database: "colab" });
  let ok = 0, fail = 0;
  const run = async (label, sql, params) => {
    try { await c.query(sql, params); ok++; }
    catch (e) { fail++; console.error(`  FAIL ${label}: ${e.code} ${e.sqlMessage}`); }
  };
  // softDelete (the user row)
  await run("users.softDelete", "UPDATE users SET deleted=1, deleted_at=now(3), deleted_by=?, email=CONCAT('deleted+', id, '@deleted.invalid'), name='Deleted user', avatar_url=NULL, about=NULL, manual_presence=NULL WHERE id=? AND deleted=0", [DUMMY, DUMMY]);
  // owned collections
  for (const [tbl, col] of owned)
    await run(`${tbl}.${col}`, `UPDATE \`${tbl}\` SET deleted=1, deleted_at=now(3), deleted_by=? WHERE \`${col}\`=? AND deleted=0`, [DUMMY, DUMMY]);
  // revoke + SET NULL detaches
  await run("e2ee_devices.revoke", "UPDATE e2ee_devices SET revoked=true WHERE user_id=? AND revoked=false", [DUMMY]);
  await run("notifications.actor_id NULL", "UPDATE notifications SET actor_id=NULL WHERE actor_id=?", [DUMMY]);
  await run("tasks.assignee_id NULL", "UPDATE tasks SET assignee_id=NULL WHERE assignee_id=?", [DUMMY]);
  await run("tasks.reporter_id NULL", "UPDATE tasks SET reporter_id=NULL WHERE reporter_id=?", [DUMMY]);
  await run("task_activity.actor_id NULL", "UPDATE task_activity SET actor_id=NULL WHERE actor_id=?", [DUMMY]);

  console.log(`\ndeleteAccount SQL: ${ok} statements valid, ${fail} failed (all ran against the real schema with a no-op id).`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
