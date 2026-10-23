// Apply the missing migration 0043 to LIVE: add conversation_members.
// history_visible_from (DATETIME(3) NULL) — additive, safe on populated DBs
// (per the migration file) — and record 0043 in schema_migrations. Idempotent.
// Creds from .env.live. Run from repo root: node scripts/live-migrate-0043.cjs
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

(async () => {
  const u = new URL(fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8").match(/^DATABASE_URL_LIVE=(.+)$/m)[1].trim());
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const c = await mysql.createConnection({
    host: u.hostname, port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: db, connectTimeout: 12000,
  });
  console.log(`LIVE ${u.hostname}:${u.port}/${db}`);

  const [exists] = await c.query(
    "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='conversation_members' AND column_name='history_visible_from'",
  );
  if (exists[0].n > 0) {
    console.log("  = conversation_members.history_visible_from already present — skip");
  } else {
    await c.query("ALTER TABLE conversation_members ADD COLUMN history_visible_from DATETIME(3) NULL");
    console.log("  + added conversation_members.history_visible_from");
  }
  const [r] = await c.query("INSERT IGNORE INTO schema_migrations (filename) VALUES ('0043_member_history_cutoff.sql')");
  console.log(`  ledger: 0043_member_history_cutoff.sql ${r.affectedRows ? "recorded" : "already present"}`);

  const [[col]] = await c.query(
    "SELECT column_type AS ty, is_nullable AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='conversation_members' AND column_name='history_visible_from'",
  );
  const [[mig]] = await c.query("SELECT COUNT(*) AS n FROM schema_migrations");
  console.log(`\nVerify: column=${col ? col.ty + " null=" + col.n : "MISSING"}   ledger entries=${mig.n}`);
  console.log(col && mig.n >= 45 ? "RESULT: 0043 applied — live now fully in sync with local." : "RESULT: check output above.");
  await c.end();
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
