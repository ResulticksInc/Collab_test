// Migrate data from a remote MySQL to the local Docker MySQL.
// Uses parameterized queries for reliable JSON/binary handling.
//
// Credentials come from the environment (NEVER hardcode them — this file is
// committed). Set REMOTE_DATABASE_URL to the source DB before dumping:
//   REMOTE_DATABASE_URL=mysql://user:pass@host:3306  (LOCAL_DATABASE_URL optional)
//
// Usage:
//   npx tsx scripts/migrate-db.ts                     # dump remote -> local import
//   npx tsx scripts/migrate-db.ts --dump-only          # only dump remote to JSON files
//   npx tsx scripts/migrate-db.ts --import-only        # only import from existing JSON dumps

import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";

const DUMP_DIR = path.resolve(__dirname, "../database/dumps");

// Parse a mysql:// URL into a mysql2 connection config (no database selected;
// the script switches DBs per the DATABASES list).
function dbConfig(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

// Source DB is required only when dumping (validated in main before use).
const REMOTE = process.env.REMOTE_DATABASE_URL
  ? dbConfig(process.env.REMOTE_DATABASE_URL)
  : null;
// Target defaults to the local Docker MySQL. Credentials are built from env (with
// the docker-compose defaults) so no literal credentials live in source.
const LOCAL = dbConfig(
  process.env.LOCAL_DATABASE_URL ||
    `mysql://${process.env.LOCAL_DB_USER || "colab"}:${process.env.LOCAL_DB_PASS || "colab"}@127.0.0.1:3306`,
);

const DATABASES = ["colab", "colab_demo"];

async function getTableNames(conn: mysql.Connection, db: string): Promise<string[]> {
  await conn.query(`USE \`${db}\``);
  const [rows]: any = await conn.query("SHOW TABLES");
  return rows.map((r: any) => Object.values(r)[0] as string);
}

async function dumpDbToJson(conn: mysql.Connection, db: string) {
  console.log(`\nDumping ${db}...`);
  const tables = await getTableNames(conn, db);
  const data: Record<string, any[]> = {};
  for (const table of tables) {
    const [rows]: any = await conn.query(`SELECT * FROM \`${table}\``);
    data[table] = rows;
    console.log(`  ${db}.${table}: ${rows.length} rows`);
  }
  const filePath = path.join(DUMP_DIR, `${db}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  console.log(`  written to ${filePath}`);
  return data;
}

async function getColumnTypes(conn: mysql.Connection, db: string, table: string): Promise<Record<string, string>> {
  const [cols]: any = await conn.query(
    `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?`,
    [db, table]
  );
  const map: Record<string, string> = {};
  for (const c of cols) map[c.COLUMN_NAME] = c.DATA_TYPE;
  return map;
}

function toMySQLDate(iso: string): string {
  // Convert "2026-06-08T08:34:34.000Z" to "2026-06-08 08:34:34"
  return iso.replace("T", " ").replace(/\.\d{3}Z$/, "").replace(/\.\d+Z$/, "");
}

function coerceValue(v: any, colType: string, colName: string): any {
  if (v === null || v === undefined) return null;
  // Buffer type from JSON
  if (v && typeof v === "object" && v.type === "Buffer") return Buffer.from(v);
  // ISO datetime → MySQL datetime format
  if (["datetime", "timestamp"].includes(colType) && typeof v === "string" && v.includes("T")) {
    return toMySQLDate(v);
  }
  // JSON columns: validate, wrap plain strings as JSON strings
  if (colType === "json" && typeof v === "string") {
    if (v === "") return null;
    try { JSON.parse(v); return v; } catch { return JSON.stringify(v); }
  }
  return v;
}

async function importJsonToDb(conn: mysql.Connection, db: string) {
  const filePath = path.join(DUMP_DIR, `${db}.json`);
  if (!fs.existsSync(filePath)) {
    console.warn(`  skip ${db}: no dump file at ${filePath}`);
    return;
  }
  console.log(`\nImporting ${db}...`);
  const data: Record<string, any[]> = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const tables = Object.keys(data);

  // Cache column types
  const colTypes: Record<string, Record<string, string>> = {};
  for (const table of tables) {
    colTypes[table] = await getColumnTypes(conn, db, table);
  }

  // GOVERNANCE (soft-delete policy): this JSON-import tool WIPES-AND-REPLACES every
  // table — the only destructive DB operation left in the repo. Under the "no hard
  // delete anywhere" policy it must NEVER run against production data. Fence it
  // behind NODE_ENV + an explicit, loud opt-in.
  if (process.env.NODE_ENV === "production" && process.env.COLAB_ALLOW_DESTRUCTIVE_IMPORT !== "yes") {
    throw new Error(
      "migrate-db.ts wipe-and-replace is REFUSED in production (NODE_ENV=production). " +
        "It DELETEs/TRUNCATEs every table. Set COLAB_ALLOW_DESTRUCTIVE_IMPORT=yes ONLY if you truly intend to destroy and rebuild the target.",
    );
  }

  // Disable FK checks
  await conn.query("SET FOREIGN_KEY_CHECKS = 0");
  await conn.query("SET UNIQUE_CHECKS = 0");
  await conn.query("SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'");

  // Truncate all tables in reverse order (children before parents)
  for (const table of tables.reverse()) {
    if (data[table].length === 0) continue; // skip empty tables
    try {
      await conn.query(`DELETE FROM \`${db}\`.\`${table}\``);
    } catch {
      try { await conn.query(`TRUNCATE TABLE \`${db}\`.\`${table}\``); } catch {}
    }
  }
  tables.reverse(); // restore order for INSERT

  // Insert data
  for (const table of tables) {
    const rows = data[table];
    if (rows.length === 0) continue;

    const cols = Object.keys(rows[0]);
    const colList = cols.map((c) => "`" + c + "`").join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const types = colTypes[table] || {};

    for (const row of rows) {
      const vals = cols.map((c) => coerceValue(row[c], types[c] || "", c));
      try {
        await conn.query(
          `INSERT IGNORE INTO \`${db}\`.\`${table}\` (${colList}) VALUES (${placeholders})`,
          vals
        );
      } catch (e: any) {
        console.warn(`  [warn] ${db}.${table}: ${e.message.slice(0, 120)}`);
      }
    }
  }

  await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  await conn.query("SET UNIQUE_CHECKS = 1");
  console.log(`  ${db} import complete.`);
}

async function displayCounts(conn: mysql.Connection, db: string) {
  console.log(`\n${db}:`);
  const tables = await getTableNames(conn, db);
  for (const table of tables) {
    const [cnt]: any = await conn.query(`SELECT COUNT(*) c FROM \`${db}\`.\`${table}\``);
    if (cnt[0].c > 0) {
      console.log(`  ${table}: ${cnt[0].c}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dumpOnly = args.includes("--dump-only");
  const importOnly = args.includes("--import-only");

  if (!fs.existsSync(DUMP_DIR)) fs.mkdirSync(DUMP_DIR, { recursive: true });

  if (!importOnly) {
    if (!REMOTE) {
      console.error(
        "REMOTE_DATABASE_URL is not set. Provide the source DB to dump, e.g.\n" +
          "  REMOTE_DATABASE_URL=mysql://user:pass@host:3306 npx tsx scripts/migrate-db.ts\n" +
          "(or use --import-only to import previously dumped JSON files).",
      );
      process.exit(1);
    }
    console.log("Connecting to remote MySQL at", REMOTE.host + ":" + REMOTE.port);
    const remote = await mysql.createConnection(REMOTE);
    for (const db of DATABASES) {
      await dumpDbToJson(remote, db);
    }
    await remote.end();
    console.log("\nRemote dump complete.");
  }

  if (dumpOnly) {
    console.log("Skip import (--dump-only). Files ready at:", DUMP_DIR);
    return;
  }

  // ── SAFETY RAIL (data-loss prevention) ────────────────────────────────────
  // The import below TRUNCATES every table and replaces it from the JSON dump.
  // This is a LOCAL-DEV import ONLY. Refuse to run it against any non-loopback
  // target (e.g. a test/live server) so local data can NEVER be pushed over a
  // real database, and a real DB can never be wiped by this tool. To override
  // (you accept the data loss), set ALLOW_NONLOCAL_IMPORT=1 explicitly.
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(LOCAL.host);
  if (!isLoopback && process.env.ALLOW_NONLOCAL_IMPORT !== "1") {
    console.error(
      `\n🚫 REFUSING to import into non-local DB host "${LOCAL.host}".\n` +
        `   This tool TRUNCATES every table and replaces it from database/dumps —\n` +
        `   it must NEVER run against a test or live database.\n` +
        `   Live schema changes go through proper migrations, not this tool.\n` +
        `   If you absolutely intend to overwrite a remote DB, set ALLOW_NONLOCAL_IMPORT=1\n` +
        `   (you are then responsible for the data loss).\n`,
    );
    process.exit(1);
  }

  console.log("\nConnecting to local Docker MySQL...");
  let local: mysql.Connection;
  try {
    local = await mysql.createConnection(LOCAL);
  } catch (e: any) {
    console.error(
      "Cannot connect to local MySQL at 127.0.0.1:3306.\n" +
        "Make sure Docker is running: docker compose up -d db\nError:",
      e.message
    );
    process.exit(1);
  }

  for (const db of DATABASES) {
    await importJsonToDb(local, db);
  }

  console.log("\n=== Import Summary ===");
  for (const db of DATABASES) {
    await displayCounts(local, db);
  }

  await local.end();
  console.log("\nMigration complete!");
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
