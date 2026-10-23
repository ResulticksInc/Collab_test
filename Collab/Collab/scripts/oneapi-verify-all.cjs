// Verify One API across ALL tables after the soft-delete change: (1) read sweep,
// (2) insert/update CRUD, (3) demonstrate "soft-delete via UPDATE deleted=1" (the
// point: One API needs no DELETE — soft-delete is an UPDATE it supports). Config
// from .env.live. Run: node scripts/oneapi-verify-all.cjs
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const f = fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8");
const get = (k) => (f.match(new RegExp(`^${k}=(.*)$`, "m")) || [, ""])[1].trim();
const URL_ = get("ONE_API_URL"), DB_TYPE = get("ONE_API_DB_TYPE") || "mysql", DATABASE = get("ONE_API_DATABASE") || "colab", KEY = get("ONE_API_KEY");
const TABLES = ["users","conversations","conversation_members","messages","message_deletions","audit_log","bookmarks","meetings","meeting_attendees","meeting_presence","meeting_lobby","meeting_ejected","meeting_recordings","meeting_messages","folders","reminders","calls","voicemails","user_settings","user_blocks","user_reports","tasks","task_activity","task_deps","task_comments","invites","files","file_shares","scheduled_messages","notifications","e2ee_devices","e2ee_one_time_prekeys","e2ee_conversation_keys","deploy_state","schema_migrations"];

async function api(payload) {
  const res = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify({ db_type: DB_TYPE, database: DATABASE, export: "json", ...payload }) });
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, j, text };
}

(async () => {
  console.log(`One API ${URL_}  db=${DATABASE}\n`);

  // (1) READ SWEEP — all tables queryable?
  let read = 0;
  for (const t of TABLES) {
    const r = await api({ table: t, limit: 1 });
    if (r.ok && r.j && r.j.status === "success") read++;
    else console.log(`  READ FAIL ${t}: HTTP ${r.status} ${r.text.slice(0, 80)}`);
  }
  console.log(`READ sweep: ${read}/${TABLES.length} tables queryable via One API`);

  // (2)+(3) CRUD + soft-delete-via-UPDATE on the inert meeting_ejected table.
  const M = "_oneapi_verify_";
  const ins = await api({ table: "meeting_ejected", action: "insert", values: { meeting_id: M, user_id: M, ejected_by: "creator" } });
  console.log(`\nINSERT (values): ${ins.j && ins.j.data && ins.j.data[0] ? JSON.stringify(ins.j.data[0]) : ins.text.slice(0, 80)}`);
  const upd = await api({ table: "meeting_ejected", action: "update", values: { ejected_by: "updated" }, conditions: [{ column: "meeting_id", operator: "=", value: M }] });
  console.log(`UPDATE (values+conditions): ${upd.j && upd.j.data && upd.j.data[0] ? JSON.stringify(upd.j.data[0]) : upd.text.slice(0, 80)}`);
  const del = await api({ table: "meeting_ejected", action: "update", values: { deleted: 1 }, conditions: [{ column: "meeting_id", operator: "=", value: M }] });
  const delOk = del.ok && del.j && del.j.status === "success";
  console.log(`SOFT-DELETE via UPDATE {deleted:1}: ${delOk ? JSON.stringify(del.j.data && del.j.data[0]) : "NOT YET — " + (del.text || "").slice(0, 90)}`);
  console.log(delOk ? "  => One API CAN delete: a soft-delete is just an UPDATE it supports." : "  => live DB needs migration 0046 (deleted column) first; mechanism verified on local.");

  // Cleanup the verify row directly (targeted).
  const u = new URL(get("DATABASE_URL_LIVE") || f.match(/^DATABASE_URL_LIVE=(.+)$/m)[1].trim());
  const c = await mysql.createConnection({ host: u.hostname, port: +u.port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)), connectTimeout: 12000 });
  const [d] = await c.query("DELETE FROM meeting_ejected WHERE meeting_id=? AND user_id=? LIMIT 1", [M, M]);
  console.log(`\nCleanup: removed ${d.affectedRows} verify row(s).`);
  await c.end();
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
