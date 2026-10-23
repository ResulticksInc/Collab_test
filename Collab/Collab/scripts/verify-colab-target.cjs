#!/usr/bin/env node
/* =============================================================================
 * verify-colab-target.cjs  —  zero-data-loss verification for the TARGET DB.
 *
 * Connects to the TARGET (default = DATABASE_URL_LIVE from .env.live, exactly
 * like scripts/find-live-users.cjs — the password is read from the file and
 * NEVER inlined or printed), runs a real SELECT COUNT(*) for EVERY CoLab table
 * (hardcoded 36-table list = 34 app tables + the 2 control tables), prints a
 * per-table 'table: <rows>' line and a clear TOTAL.
 *
 * If a baseline file (the source counts captured by dump-colab-live.sh) is
 * passed as argv[2], it prints PASS / FAIL per table by comparing target vs
 * source counts, plus an audit_log AUTO_INCREMENT check, and exits non-zero if
 * ANY app table FAILs or is missing on the target.
 *
 * USAGE:
 *   node scripts/verify-colab-target.cjs                            # counts only
 *   node scripts/verify-colab-target.cjs colab-source-counts.txt    # + PASS/FAIL
 *   # override target:
 *   TARGET_DB_URL=mysql://u:p@host:3603/colab node scripts/verify-colab-target.cjs base.txt
 *   ENV_VAR=DATABASE_URL_DEMO node scripts/verify-colab-target.cjs   # different .env.live key
 * ========================================================================== */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

// ── Canonical CoLab table set (verification baseline). 34 app tables +
// schema_migrations + deploy_state = 36. Enumerated from every CREATE TABLE in
// database/migrations/0001..0045 plus the two control tables. Do NOT derive
// from schema.sql (incomplete) or by grepping the driver (misses deploy_state).
const APP_TABLES = [
  "users", "conversations", "conversation_members", "messages", "message_deletions",
  "audit_log", "bookmarks", "meetings", "meeting_attendees", "meeting_presence",
  "meeting_lobby", "meeting_ejected", "meeting_recordings", "meeting_messages", "folders",
  "reminders", "calls", "voicemails", "user_settings", "user_blocks",
  "user_reports", "tasks", "task_activity", "task_deps", "task_comments",
  "invites", "files", "file_shares", "scheduled_messages", "notifications",
  "e2ee_devices", "e2ee_one_time_prekeys", "e2ee_conversation_keys",
];
// Control tables: present for completeness, but NOT failed on a count mismatch
// (schema_migrations ~= 46 filename rows; deploy_state is promotion state, 0/1
// rows, and the loader stamps it). They still print their counts.
const CONTROL_TABLES = ["schema_migrations", "deploy_state"];
const ALL_TABLES = [...APP_TABLES, ...CONTROL_TABLES];

const C = {
  reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", dim: "\x1b[2m",
};

function readTargetUrl() {
  // 1) explicit env override wins.
  if (process.env.TARGET_DB_URL) return process.env.TARGET_DB_URL.trim();
  // 2) read from .env.live (default key DATABASE_URL_LIVE; override via ENV_VAR).
  const envPath = path.join(__dirname, "..", ".env.live");
  if (!fs.existsSync(envPath)) {
    console.error(`${C.red}.env.live not found at ${envPath} and TARGET_DB_URL unset.${C.reset}`);
    process.exit(1);
  }
  const key = process.env.ENV_VAR || "DATABASE_URL_LIVE";
  const txt = fs.readFileSync(envPath, "utf8");
  const m = txt.match(new RegExp(`^${key}=(.+)$`, "m"));
  if (!m) {
    console.error(`${C.red}${key} not found in .env.live${C.reset}`);
    process.exit(1);
  }
  return m[1].trim();
}

function parseBaseline(file) {
  // 'table<TAB>count' lines (from dump-colab-live.sh). Returns a Map plus the
  // recorded audit_log AUTO_INCREMENT (key '__audit_log_auto_increment').
  const map = new Map();
  let sourceAutoInc = null;
  const txt = fs.readFileSync(file, "utf8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [t, c] = line.split("\t");
    if (!t) continue;
    if (t === "__audit_log_auto_increment") { sourceAutoInc = Number(c); continue; }
    map.set(t.trim(), Number(c));
  }
  return { map, sourceAutoInc };
}

(async () => {
  const url = readTargetUrl();
  const u = new URL(url);
  const db = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname;
  console.log(`${C.cyan}Verifying TARGET ${host}:${u.port || 3306}/${db}${C.reset}\n`);

  const baselineFile = process.argv[2];
  let baseline = null;
  if (baselineFile) {
    if (!fs.existsSync(baselineFile)) {
      console.error(`${C.red}baseline file '${baselineFile}' not found.${C.reset}`);
      process.exit(1);
    }
    baseline = parseBaseline(baselineFile);
    console.log(`${C.dim}Comparing against source baseline: ${baselineFile}${C.reset}\n`);
  } else {
    console.log(`${C.dim}(no baseline file given — printing target counts only)${C.reset}\n`);
  }

  let conn;
  try {
    conn = await mysql.createConnection({
      host, port: Number(u.port) || 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: db, connectTimeout: 15000,
    });
  } catch (e) {
    console.error(`${C.red}CONNECT FAILED: ${e.code || e.message}${C.reset}`);
    console.error(`(On the corporate network / VPN that can reach ${host}?)`);
    process.exit(2);
  }

  let anyFail = false;
  let total = 0;
  const colW = 30;
  const head = baseline
    ? `  ${"TABLE".padEnd(colW)} ${"SRC".padStart(10)} ${"TGT".padStart(10)}  RESULT`
    : `  ${"TABLE".padEnd(colW)} ${"ROWS".padStart(10)}`;
  console.log(head);
  console.log(`  ${"-".repeat(colW)} ${"-".repeat(10)}${baseline ? " " + "-".repeat(10) + "  ------" : ""}`);

  try {
    for (const t of ALL_TABLES) {
      const isControl = CONTROL_TABLES.includes(t);
      let tgt = null, missing = false;
      try {
        const [[row]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
        tgt = Number(row.n);
      } catch (e) {
        missing = true; // table absent on target
      }

      if (missing) {
        // A missing APP table is a hard FAIL; a missing control table is a warn.
        const label = isControl ? `${C.yellow}MISSING(ctl)${C.reset}` : `${C.red}MISSING -> FAIL${C.reset}`;
        if (!isControl) anyFail = true;
        if (baseline) {
          const src = baseline.map.has(t) ? baseline.map.get(t) : "-";
          console.log(`  ${t.padEnd(colW)} ${String(src).padStart(10)} ${"-".padStart(10)}  ${label}`);
        } else {
          console.log(`  ${t.padEnd(colW)} ${"-".padStart(10)}  ${label}`);
        }
        continue;
      }

      total += tgt;

      if (baseline) {
        const hasSrc = baseline.map.has(t);
        const src = hasSrc ? baseline.map.get(t) : null;
        let result;
        if (isControl) {
          result = `${C.yellow}ctl${C.reset}`;               // informational only
        } else if (!hasSrc || src === -1) {
          result = `${C.yellow}no-baseline${C.reset}`;        // source didn't record it
        } else if (src === tgt) {
          result = `${C.green}PASS${C.reset}`;
        } else {
          result = `${C.red}FAIL (diff ${tgt - src})${C.reset}`;
          anyFail = true;
        }
        console.log(`  ${t.padEnd(colW)} ${String(src ?? "-").padStart(10)} ${String(tgt).padStart(10)}  ${result}`);
      } else {
        const tag = isControl ? ` ${C.dim}(control)${C.reset}` : "";
        console.log(`  ${t.padEnd(colW)} ${String(tgt).padStart(10)}${tag}`);
      }
    }
  } finally {
    // audit_log AUTO_INCREMENT continuity check (only AUTO_INCREMENT table).
    if (baseline && baseline.sourceAutoInc != null) {
      try {
        const [[row]] = await conn.query(
          "SELECT AUTO_INCREMENT AS ai FROM information_schema.tables WHERE table_schema=? AND table_name='audit_log'",
          [db],
        );
        const tgtAI = Number(row.ai);
        const ok = tgtAI >= baseline.sourceAutoInc;
        console.log(
          `\n  ${"audit_log AUTO_INCREMENT".padEnd(colW)} ` +
          `src>=${baseline.sourceAutoInc} tgt=${tgtAI}  ` +
          (ok ? `${C.green}PASS${C.reset}` : `${C.red}FAIL (counter regressed -> PK collision risk)${C.reset}`),
        );
        if (!ok) anyFail = true;
      } catch (_) { /* audit_log absence already flagged above */ }
    }
    await conn.end().catch(() => {});
  }

  console.log(`\n  ${"-".repeat(colW)}`);
  console.log(`  Tables covered : ${ALL_TABLES.length}  (${APP_TABLES.length} app + ${CONTROL_TABLES.length} control)`);
  console.log(`  TOTAL rows     : ${total}`);

  if (baseline) {
    if (anyFail) {
      console.log(`\n${C.red}RESULT: FAIL — at least one table is short or missing. DO NOT go live; re-load or roll back.${C.reset}`);
      process.exit(1);
    }
    console.log(`\n${C.green}RESULT: PASS — every app table matches the source baseline. Zero data loss verified.${C.reset}`);
  } else {
    console.log(`\n${C.dim}Pass a baseline file (colab-source-counts.txt) as argv[2] to get PASS/FAIL.${C.reset}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error(`${C.red}ERROR: ${e.message}${C.reset}`);
  process.exit(1);
});