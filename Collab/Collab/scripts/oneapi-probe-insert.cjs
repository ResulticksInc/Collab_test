// Discover the One API gateway's REAL insert contract by probing candidate
// payload shapes, then verifying via a DIRECT live-DB read which shape actually
// landed the column values. Inert test table (meeting_ejected). Cleans up after.
// Config + creds from .env.live. Run: node scripts/oneapi-probe-insert.cjs
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const f = fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8");
const get = (k) => (f.match(new RegExp(`^${k}=(.*)$`, "m")) || [, ""])[1].trim();
const URL_ = get("ONE_API_URL"), DB_TYPE = get("ONE_API_DB_TYPE") || "mysql", DATABASE = get("ONE_API_DATABASE") || "colab", KEY = get("ONE_API_KEY");

async function post(payload) {
  const body = { db_type: DB_TYPE, database: DATABASE, export: "json", ...payload };
  try {
    const res = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text: text.length > 240 ? text.slice(0, 240) + "…" : text };
  } catch (e) { return { status: 0, text: (e.cause && e.cause.code) || e.message }; }
}

// Each candidate uses a DISTINCT meeting_id so the direct read tells us which
// shape mapped the columns correctly (ejected_by must equal the marker too).
const TID = (n) => `_probe_${n}_`;
const COLS = (n) => ({ meeting_id: TID(n), user_id: TID(n), ejected_by: TID(n) });
const candidates = [
  { n: "A", desc: 'data:[{...}] (array of row objects)', p: { table: "meeting_ejected", action: "insert", data: [COLS("A")] } },
  { n: "B", desc: 'columns + values:[[...]] (SQL-style)', p: { table: "meeting_ejected", action: "insert", columns: ["meeting_id", "user_id", "ejected_by"], values: [[TID("B"), TID("B"), TID("B")]] } },
  { n: "C", desc: 'values:{...} (values object)', p: { table: "meeting_ejected", action: "insert", values: COLS("C") } },
  { n: "D", desc: 'values:[{...}] (values array of objects)', p: { table: "meeting_ejected", action: "insert", values: [COLS("D")] } },
  { n: "E", desc: 'data:{...} (object — the original guess)', p: { table: "meeting_ejected", action: "insert", data: COLS("E") } },
  { n: "F", desc: 'records:[{...}]', p: { table: "meeting_ejected", action: "insert", records: [COLS("F")] } },
];

(async () => {
  console.log(`Gateway ${URL_}  db=${DATABASE}\n`);
  for (const c of candidates) {
    const r = await post(c.p);
    console.log(`[${c.n}] ${c.desc}\n    -> HTTP ${r.status}  ${r.text}`);
  }

  // Verify via DIRECT read which probe markers actually landed with real values.
  const u = new URL(get("DATABASE_URL_LIVE") || f.match(/^DATABASE_URL_LIVE=(.+)$/m)[1].trim());
  const conn = await mysql.createConnection({ host: u.hostname, port: +u.port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)), connectTimeout: 12000 });
  const [rows] = await conn.query("SELECT meeting_id,user_id,ejected_by FROM meeting_ejected WHERE meeting_id LIKE '\\_probe\\_%' OR meeting_id=''");
  console.log(`\n── DIRECT live read: rows that landed (${rows.length}) ──`);
  rows.forEach((r) => console.log("   ", JSON.stringify(r)));
  const winners = candidates.filter((c) => rows.some((r) => r.meeting_id === TID(c.n) && r.ejected_by === TID(c.n)));
  console.log("\nWINNING shape(s) — columns mapped correctly:", winners.length ? winners.map((w) => `${w.n} (${w.desc})`).join("; ") : "NONE");

  // Cleanup: targeted delete of each probe row by exact PK (+ any empty-string row).
  let cleaned = 0;
  for (const r of rows) { const [d] = await conn.query("DELETE FROM meeting_ejected WHERE meeting_id=? AND user_id=? LIMIT 1", [r.meeting_id, r.user_id]); cleaned += d.affectedRows; }
  const [[{ n }]] = await conn.query("SELECT COUNT(*) n FROM meeting_ejected");
  console.log(`\nCleaned up ${cleaned} probe row(s). meeting_ejected now has ${n} rows.`);
  await conn.end();
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
