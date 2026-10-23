// Password-safe logical backup of the LIVE corporate DB (reads creds from
// .env.live, never inlines them). Writes a timestamped .sql with CREATE + INSERTs.
// Run: node scripts/backup-live.cjs [outfile]
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

(async () => {
  const u = new URL(fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8").match(/^DATABASE_URL_LIVE=(.+)$/m)[1].trim());
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const c = await mysql.createConnection({ host: u.hostname, port: +u.port || 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: db, connectTimeout: 15000 });
  const out = process.argv[2] || ("colab-live-backup-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".sql");

  const [tbls] = await c.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema=DATABASE() AND table_type='BASE TABLE' ORDER BY t");
  const tables = tbls.map((r) => r.t || r.TABLE_NAME);
  let sql = `-- CoLab live backup ${db} @ ${new Date().toISOString()}\nSET FOREIGN_KEY_CHECKS=0;\nSET NAMES utf8mb4;\n\n`;
  let totalRows = 0;
  for (const t of tables) {
    const [[cr]] = await c.query(`SHOW CREATE TABLE \`${t}\``);
    sql += `DROP TABLE IF EXISTS \`${t}\`;\n${cr["Create Table"] || cr["Create View"]};\n`;
    const [rows] = await c.query(`SELECT * FROM \`${t}\``);
    if (rows.length) {
      const cols = Object.keys(rows[0]);
      sql += `INSERT INTO \`${t}\` (${cols.map((x) => "`" + x + "`").join(",")}) VALUES\n`;
      sql += rows.map((r) => "(" + cols.map((col) => c.escape(r[col])).join(",") + ")").join(",\n") + ";\n";
      totalRows += rows.length;
    }
    sql += "\n";
  }
  sql += "SET FOREIGN_KEY_CHECKS=1;\n";
  fs.writeFileSync(out, sql);
  console.log(`Backed up LIVE ${u.hostname}:${u.port}/${db}: ${tables.length} tables, ${totalRows} rows -> ${out} (${(sql.length / 1024).toFixed(1)} KB)`);
  await c.end();
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
