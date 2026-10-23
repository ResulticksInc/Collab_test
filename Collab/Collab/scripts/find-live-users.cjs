// Read-only diagnostic: locate users in the LIVE corporate DB.
// Reads DATABASE_URL_LIVE from .env.live so the credential is NEVER printed or
// passed on the command line. Run from repo root:  node scripts/find-live-users.cjs
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

(async () => {
  const envPath = path.join(__dirname, "..", ".env.live");
  const txt = fs.readFileSync(envPath, "utf8");
  const m = txt.match(/^DATABASE_URL_LIVE=(.+)$/m);
  if (!m) {
    console.error("DATABASE_URL_LIVE not found in .env.live");
    process.exit(1);
  }
  const u = new URL(m[1].trim());
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  console.log(`Connecting to LIVE DB ${u.hostname}:${u.port || 3306}/${db} …`);

  let conn;
  try {
    conn = await mysql.createConnection({
      host: u.hostname,
      port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: db,
      connectTimeout: 10000,
    });
  } catch (e) {
    console.error("CONNECT FAILED:", e.code || e.message);
    console.error("(Are you on the corporate network / VPN that can reach " + u.hostname + "?)");
    process.exit(2);
  }

  try {
    const [[{ live_total }]] = await conn.query("SELECT COUNT(*) AS live_total FROM users");
    console.log(`\nTotal users in LIVE DB: ${live_total}\n`);

    const [hits] = await conn.query(
      "SELECT id, name, email, created_at FROM users WHERE name LIKE '%Raghuram%' OR name LIKE '%Balaji%' OR name LIKE '%Madhan%' OR name LIKE '%Sridharan%' ORDER BY created_at DESC",
    );
    console.log("=== Search: Raghuram / Balaji / Madhan / Sridharan ===");
    console.table(hits.map((r) => ({ name: r.name, email: r.email, created_at: String(r.created_at) })));

    const [recent] = await conn.query(
      "SELECT name, email, created_at FROM users ORDER BY created_at DESC LIMIT 20",
    );
    console.log("\n=== 20 most recent signups in LIVE DB ===");
    console.table(recent.map((r) => ({ name: r.name, email: r.email, created_at: String(r.created_at) })));
  } finally {
    await conn.end();
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
