// Confirm the full One API CRUD contract now that insert uses `values`.
// INSERT (values) -> FETCH (conditions) -> UPDATE? -> DELETE (probe shapes),
// each verified by a DIRECT live read. Inert table, cleaned up after.
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const f = fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8");
const get = (k) => (f.match(new RegExp(`^${k}=(.*)$`, "m")) || [, ""])[1].trim();
const URL_ = get("ONE_API_URL"), DB_TYPE = get("ONE_API_DB_TYPE") || "mysql", DATABASE = get("ONE_API_DATABASE") || "colab", KEY = get("ONE_API_KEY");
const M = "_crud_test_";

async function post(label, payload) {
  const body = { db_type: DB_TYPE, database: DATABASE, export: "json", ...payload };
  try {
    const res = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify(body) });
    const text = await res.text();
    console.log(`\n>>> ${label}\n    req ${JSON.stringify(payload)}\n    -> HTTP ${res.status}  ${text.length > 260 ? text.slice(0, 260) + "…" : text}`);
    let j = null; try { j = JSON.parse(text); } catch {}
    return j;
  } catch (e) { console.log(`\n>>> ${label}\n    REQUEST FAILED: ${(e.cause && e.cause.code) || e.message}`); return null; }
}

(async () => {
  console.log(`Gateway ${URL_}  db=${DATABASE}`);

  await post("INSERT (values object)", { table: "meeting_ejected", action: "insert", values: { meeting_id: M, user_id: M, ejected_by: "creator" } });
  await post("FETCH conditions [{column,operator,value}]", { table: "meeting_ejected", conditions: [{ column: "meeting_id", operator: "=", value: M }] });
  await post("FETCH conditions {column,value} (no operator)", { table: "meeting_ejected", conditions: [{ column: "meeting_id", value: M }] });
  await post("FETCH where:{col:val}", { table: "meeting_ejected", where: { meeting_id: M } });
  await post("UPDATE values+conditions", { table: "meeting_ejected", action: "update", values: { ejected_by: "updated" }, conditions: [{ column: "meeting_id", operator: "=", value: M }] });
  await post("DELETE conditions", { table: "meeting_ejected", action: "delete", conditions: [{ column: "meeting_id", operator: "=", value: M }] });
  await post("DELETE where:{col:val}", { table: "meeting_ejected", action: "delete", where: { meeting_id: M } });
  await post("DELETE values:{col:val}", { table: "meeting_ejected", action: "delete", values: { meeting_id: M } });

  // Direct verify + guaranteed cleanup.
  const u = new URL(f.match(/^DATABASE_URL_LIVE=(.+)$/m)[1].trim());
  const conn = await mysql.createConnection({ host: u.hostname, port: +u.port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)), connectTimeout: 12000 });
  const [rows] = await conn.query("SELECT meeting_id,user_id,ejected_by FROM meeting_ejected WHERE meeting_id=?", [M]);
  console.log(`\n── DIRECT read after CRUD: ${rows.length} row(s) for marker ──`);
  rows.forEach((r) => console.log("   ", JSON.stringify(r)));
  console.log(rows.length === 0 ? "   (gateway DELETE succeeded)" : `   (gateway DELETE did NOT remove it — ejected_by='${rows[0].ejected_by}' shows if UPDATE worked)`);
  for (const r of rows) await conn.query("DELETE FROM meeting_ejected WHERE meeting_id=? AND user_id=? LIMIT 1", [r.meeting_id, r.user_id]);
  const [[{ n }]] = await conn.query("SELECT COUNT(*) n FROM meeting_ejected");
  console.log(`\nFinal cleanup done. meeting_ejected rows: ${n}`);
  await conn.end();
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
