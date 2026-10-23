// Apply migration 0046 (soft-delete columns) to the LIVE corporate DB, idempotently
// (swallows dup-column 1060 / dup-index 1061, like the app's runner). Creds from
// .env.live. Run: node scripts/apply-softdelete-live.cjs
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

(async () => {
  const env = fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8");
  const u = new URL(env.match(/^DATABASE_URL_LIVE=(.+)$/m)[1].trim());
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const c = await mysql.createConnection({
    host: u.hostname, port: +u.port || 3306,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: db, connectTimeout: 12000, multipleStatements: false,
  });
  console.log(`LIVE ${u.hostname}:${u.port}/${db}`);

  const sql = fs.readFileSync(path.join(__dirname, "..", "database", "migrations", "0046_soft_delete_columns.sql"), "utf8");
  // Strip line comments, split on ; into statements.
  const stmts = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);

  let ok = 0, skip = 0, fail = 0;
  for (const stmt of stmts) {
    try { await c.query(stmt); ok++; }
    catch (e) {
      if (e.errno === 1060 || e.errno === 1061) { skip++; } // already-applied
      else { fail++; console.error("  FAIL:", e.errno, e.sqlMessage, "\n    " + stmt.slice(0, 80)); }
    }
  }
  await c.query("INSERT IGNORE INTO schema_migrations (filename) VALUES ('0046_soft_delete_columns.sql')");
  console.log(`statements: ${ok} applied, ${skip} already-present, ${fail} failed`);

  // Verify: count tables that now have the `deleted` column.
  const [[{ n }]] = await c.query(
    "SELECT COUNT(DISTINCT table_name) AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND column_name='deleted'");
  console.log(`Tables with a 'deleted' column on LIVE: ${n}`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
