// Bring LIVE (corporate) schema up to LOCAL: create the two missing tables
// (deploy_state = migration 0044, meeting_ejected = 0045) with local's exact DDL
// and record them in schema_migrations. Additive + idempotent (IF NOT EXISTS /
// INSERT IGNORE) — safe to re-run, no data touched. Creds from .env.live.
// Run from repo root: node scripts/live-migrate-missing.cjs
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const DDL = {
  deploy_state: `CREATE TABLE IF NOT EXISTS \`deploy_state\` (
    \`phase\` varchar(32) NOT NULL,
    \`migrated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`source_checksum\` varchar(64) DEFAULT NULL,
    \`source_rows\` int DEFAULT NULL,
    \`target_rows_pre\` int DEFAULT NULL,
    \`target_rows_post\` int DEFAULT NULL,
    \`notes\` text,
    PRIMARY KEY (\`phase\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  meeting_ejected: `CREATE TABLE IF NOT EXISTS \`meeting_ejected\` (
    \`meeting_id\` varchar(36) NOT NULL,
    \`user_id\` varchar(36) NOT NULL,
    \`ejected_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
    \`ejected_by\` varchar(36) NOT NULL,
    PRIMARY KEY (\`meeting_id\`,\`user_id\`),
    KEY \`idx_meeting_ejected_meeting\` (\`meeting_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
};
const MIGRATIONS = ["0044_deploy_state.sql", "0045_meeting_ejected.sql"];

(async () => {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8");
  const url = (txt.match(/^DATABASE_URL_LIVE=(.+)$/m) || [])[1];
  if (!url) throw new Error("DATABASE_URL_LIVE not in .env.live");
  const u = new URL(url.trim());
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  console.log(`Connecting to LIVE ${u.hostname}:${u.port}/${db} ...`);
  const c = await mysql.createConnection({
    host: u.hostname, port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: db, connectTimeout: 12000, multipleStatements: false,
  });

  const before = (await c.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE()"))[0][0].n;
  console.log(`Tables before: ${before}\n`);

  for (const [name, ddl] of Object.entries(DDL)) {
    const [rows] = await c.query(
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?",
      [name],
    );
    if (rows[0].n > 0) { console.log(`  = ${name} already present — skip`); continue; }
    await c.query(ddl);
    console.log(`  + created ${name}`);
  }

  for (const m of MIGRATIONS) {
    const [r] = await c.query("INSERT IGNORE INTO schema_migrations (filename) VALUES (?)", [m]);
    console.log(`  ledger: ${m} ${r.affectedRows ? "recorded" : "already present"}`);
  }

  const after = (await c.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE()"))[0][0].n;
  const [[chk]] = await c.query(
    "SELECT SUM(table_name='deploy_state') ds, SUM(table_name='meeting_ejected') me FROM information_schema.tables WHERE table_schema=DATABASE()",
  );
  console.log(`\nTables after: ${after}   deploy_state=${chk.ds} meeting_ejected=${chk.me}`);
  console.log(after >= 35 ? "RESULT: LIVE schema now matches LOCAL (35)." : "RESULT: check — fewer tables than expected.");
  await c.end();
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
