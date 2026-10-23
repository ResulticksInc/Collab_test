// One-shot: DROP all tables in the shared prod colab DB, then apply all 42
// migrations clean. BEGIN/END-aware splitter (peeks the word AFTER END so
// END IF / END WHILE don't close the compound block).
//
// Usage:
//   node scripts/fresh-prod-migrate.js
//
// DESTRUCTIVE — drops every table in `colab`. User confirmed "lets go fresh".

const path = require("path");
const fs = require("fs");
const mysql = require("mysql2/promise");

// Prod DB URL comes from the environment (.env.live / secret store) — NEVER hard
// -code a production credential in a tracked script. This script is DESTRUCTIVE,
// so refuse to run without it rather than falling back to a baked-in secret.
const DB_URL = process.env.PROD_DATABASE_URL;
if (!DB_URL) {
  console.error(
    "Set PROD_DATABASE_URL (mysql://user:pass@10.101.3.2:3603/colab) from .env.live\n" +
      "or your secret store before running this DESTRUCTIVE migration.",
  );
  process.exit(1);
}

const ALREADY_APPLIED_ERRNOS = new Set([1050, 1060, 1061, 1826, 1359, 1304, 1065]);

function splitSqlStatements(sql) {
  const out = [];
  const n = sql.length;
  const isWord = (c) => /[A-Za-z0-9_$]/.test(c);
  const peekWord = (j) => {
    while (j < n && /\s/.test(sql[j])) j++;
    let w = "";
    while (j < n && isWord(sql[j])) {
      w += sql[j];
      j++;
    }
    return w.toUpperCase();
  };
  let buf = "";
  let beginDepth = 0;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if ((c === "-" && d === "-" && (i + 2 >= n || /\s/.test(sql[i + 2]))) || c === "#") {
      while (i < n && sql[i] !== "\n") buf += sql[i++];
      continue;
    }
    if (c === "/" && d === "*") {
      buf += "/*";
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) buf += sql[i++];
      if (i < n) {
        buf += "*/";
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      buf += c;
      i++;
      while (i < n) {
        const ch = sql[i];
        if (ch === "\\" && q !== "`" && i + 1 < n) {
          buf += ch + sql[i + 1];
          i += 2;
          continue;
        }
        if (ch === q) {
          if (sql[i + 1] === q) {
            buf += q + q;
            i += 2;
            continue;
          }
          buf += ch;
          i++;
          break;
        }
        buf += ch;
        i++;
      }
      continue;
    }
    if (isWord(c) && (i === 0 || !isWord(sql[i - 1]))) {
      let w = "";
      let j = i;
      while (j < n && isWord(sql[j])) w += sql[j++];
      const W = w.toUpperCase();
      if (W === "BEGIN") beginDepth++;
      else if (W === "END") {
        const next = peekWord(j);
        if (!["IF", "WHILE", "LOOP", "CASE", "REPEAT"].includes(next) && beginDepth > 0)
          beginDepth--;
      }
      buf += w;
      i = j;
      continue;
    }
    if (c === ";" && beginDepth === 0) {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

(async () => {
  const u = new URL(DB_URL);
  const conn = await mysql.createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    multipleStatements: true,
  });
  console.log("[fresh] connected to", u.hostname + ":" + u.port);

  await conn.query("SET FOREIGN_KEY_CHECKS = 0");
  const [tables] = await conn.query(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()",
  );
  console.log(`[fresh] dropping ${tables.length} existing tables`);
  for (const row of tables) {
    const name = row.t || row.TABLE_NAME;
    await conn.query("DROP TABLE IF EXISTS `" + name + "`");
  }
  await conn.query("SET FOREIGN_KEY_CHECKS = 1");

  await conn.query(
    "CREATE TABLE schema_migrations (filename VARCHAR(255) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const dir = path.resolve(__dirname, "../database/migrations");
  const files = fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort();
  console.log(`[fresh] applying ${files.length} migration files`);
  let triggerSkipped = 0;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    const statements = splitSqlStatements(sql);
    let skippedHere = false;
    for (const stmt of statements) {
      try {
        await conn.query(stmt);
      } catch (e) {
        if (e && (e.errno === 1419 || e.code === "ER_BINLOG_CREATE_ROUTINE_NEED_SUPER")) {
          skippedHere = true;
          continue;
        }
        if (e && ALREADY_APPLIED_ERRNOS.has(e.errno)) continue;
        console.error("[fresh] ERROR in", f, "->", e.message);
        console.error("[fresh] failing statement:\n" + stmt.slice(0, 400));
        throw e;
      }
    }
    if (skippedHere) {
      console.warn(`[fresh] ${f}: trigger skipped (non-SUPER user); app-layer enforces it`);
      triggerSkipped++;
    }
    await conn.query("INSERT INTO schema_migrations (filename) VALUES (?)", [f]);
    console.log(`[fresh]   ok ${f}`);
  }

  const [[{ n: tableCount }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()",
  );
  const [[{ n: appliedCount }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM schema_migrations",
  );
  console.log(`[fresh] DONE -- ${tableCount} tables, ${appliedCount} migrations applied${triggerSkipped ? `, ${triggerSkipped} triggers skipped (app-layer enforced)` : ""}`);
  await conn.end();
})().catch((e) => {
  console.error("[fresh] FATAL:", e.message);
  process.exit(1);
});
