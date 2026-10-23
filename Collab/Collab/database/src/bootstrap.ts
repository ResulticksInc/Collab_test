// Self-provisioning for MySQL: best-effort create the target database if it
// doesn't exist, then apply the migrations. Tolerant of a DB that isn't ready
// yet (containers report "started" before MySQL finishes initializing), so a
// cold `docker compose up` followed immediately by a migrate still works.
import fs from "fs";
import path from "path";

function parseUrl(url: string) {
  const u = new URL(url);
  // Prefer IPv4 — Node resolves "localhost" to ::1 first, which Docker's port
  // forwarding often doesn't answer (spurious ECONNREFUSED on ::1).
  const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname;
  return {
    host,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

// Errors that mean "MySQL isn't ready yet", not "your credentials/host are
// wrong". MySQL emits these during the brief window after the socket opens but
// before grant tables load on first boot.
const TRANSIENT = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "PROTOCOL_CONNECTION_LOST",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ER_HOST_NOT_PRIVILEGED", // 1130 — seen mid-initialization
  "ER_SERVER_SHUTDOWN",
  "ER_ACCESS_DENIED_ERROR", // grant tables still loading
]);

// "The database isn't up / reachable YET" — as opposed to a config error that
// retrying can never fix. Exported so the backend boot loop can decide whether
// to keep waiting (transient) or crash loudly (anything else).
function isTransientDbError(e: any): boolean {
  return !!e && (TRANSIENT.has(e.code) || e.errno === 1130);
}

async function connectWithRetry(opts: any, timeoutMs = 45000) {
  const mysql = require("mysql2/promise");
  const start = Date.now();
  let lastErr: any;
  let announced = false;
  for (;;) {
    try {
      return await mysql.createConnection(opts);
    } catch (e: any) {
      lastErr = e;
      const transient = isTransientDbError(e);
      if (!transient || Date.now() - start > timeoutMs) throw e;
      if (!announced) {
        console.log("[db] waiting for MySQL to accept connections ...");
        announced = true;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function ensureDatabase(url: string) {
  const cfg = parseUrl(url);
  if (!cfg.database) return;
  // Entirely best-effort: when running under docker-compose the database is
  // already created by MYSQL_DATABASE + the initdb script, so a failure here
  // (e.g. the app user can't CREATE DATABASE) must NOT abort boot.
  try {
    const conn = await connectWithRetry({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
    });
    try {
      await conn.query(
        "CREATE DATABASE IF NOT EXISTS `" +
          cfg.database.replace(/`/g, "") +
          "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
      );
      console.log("[db] ensured database:", cfg.database);
    } finally {
      await conn.end().catch(() => {});
    }
  } catch (e: any) {
    // "DB not reachable yet" must bubble up so the caller's retry loop prints
    // an honest "waiting for the database" message — NOT the misleading
    // "likely already exists" below (that line is for permission errors).
    if (isTransientDbError(e)) throw e;
    console.warn(
      "[db] skipping auto-create (the database likely already exists — e.g. created by docker-compose, or this user lacks CREATE DATABASE):",
      e.message,
    );
  }
}

// Per-statement errors that mean "this object already exists / this statement
// was already applied on a prior partial run" — safe to SWALLOW so re-running a
// half-applied migration file COMPLETES instead of crash-looping. On a clean
// first apply NONE of these fire, so first-run behaviour is unchanged.
const ALREADY_APPLIED_ERRNOS = new Set<number>([
  1050, // ER_TABLE_EXISTS_ERROR  — CREATE TABLE (already there)
  1060, // ER_DUP_FIELDNAME       — ADD COLUMN (already there)
  1061, // ER_DUP_KEYNAME         — CREATE INDEX / ADD KEY (already there)
  1826, // ER_FK_DUP_NAME         — ADD CONSTRAINT FOREIGN KEY (already there)
  1359, // ER_TRG_ALREADY_EXISTS  — CREATE TRIGGER (already there)
  1304, // ER_SP_ALREADY_EXISTS   — CREATE PROCEDURE/FUNCTION (already there)
  1065, // ER_EMPTY_QUERY         — a comment-only fragment → no-op
]);

// Split a .sql migration file into individual statements WITHOUT breaking
// compound statements. Critically: a CREATE TRIGGER ... BEGIN ...; ...; END body
// contains internal semicolons (and IF ... END IF) that must NOT split the
// statement — so we track BEGIN/END nesting and only split on a top-level `;`.
// Also skips string literals (' " `) and -- / # / block comments so a `;` inside
// them never triggers a split. No DELIMITER directive is used by any migration,
// so this BEGIN/END-aware pass is sufficient.
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  const n = sql.length;
  const isWord = (c: string) => /[A-Za-z0-9_$]/.test(c);
  const peekWord = (j: number): string => {
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
    // line comment: `-- ` (must be followed by whitespace/EOL) or `#`
    if ((c === "-" && d === "-" && (i + 2 >= n || /\s/.test(sql[i + 2]))) || c === "#") {
      while (i < n && sql[i] !== "\n") buf += sql[i++];
      continue;
    }
    // block comment
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
    // string / identifier literal
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
          } // doubled-quote escape
          buf += ch;
          i++;
          break;
        }
        buf += ch;
        i++;
      }
      continue;
    }
    // keyword boundary → track BEGIN / END nesting for compound bodies
    if (isWord(c) && (i === 0 || !isWord(sql[i - 1]))) {
      let w = "";
      let j = i;
      while (j < n && isWord(sql[j])) w += sql[j++];
      const W = w.toUpperCase();
      if (W === "BEGIN") beginDepth++;
      else if (W === "END") {
        const next = peekWord(j);
        // `END IF` / `END WHILE` / ... close a control block (we never counted
        // those as +1), so only a bare `END` closes the BEGIN block.
        if (!["IF", "WHILE", "LOOP", "CASE", "REPEAT"].includes(next) && beginDepth > 0)
          beginDepth--;
      }
      buf += w;
      i = j;
      continue;
    }
    // top-level statement terminator
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

async function migrate(url: string) {
  const cfg = parseUrl(url);
  const conn = await connectWithRetry({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: true, // migration files contain several statements
  });
  const dir = path.resolve(__dirname, "../migrations");
  const files = fs
    .readdirSync(dir)
    .filter((x) => x.endsWith(".sql"))
    .sort();
  try {
    // Run-once tracking: MySQL has no CREATE INDEX / ADD COLUMN IF NOT EXISTS,
    // so each migration file is applied exactly once and recorded here.
    await conn.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (filename VARCHAR(255) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    const [applied]: any = await conn.query(
      "SELECT filename FROM schema_migrations",
    );
    const done = new Set(applied.map((r: any) => r.filename));
    let n = 0;
    let skipped = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      // Apply STATEMENT-BY-STATEMENT (not the whole file at once) so that:
      //  • an "object already exists" error from a prior PARTIAL run is swallowed
      //    per statement — the file completes instead of crash-looping on reboot;
      //  • a genuine failure still re-throws, but the already-applied statements
      //    above it are idempotent, so the retry resumes from the real failure
      //    point rather than dying on the first ADD COLUMN.
      // MySQL DDL auto-commits and can't be transactionally rolled back, so
      // idempotent-replay is the correct safety model here.
      const statements = splitSqlStatements(
        fs.readFileSync(path.join(dir, f), "utf8"),
      );
      let triggerSkipped = false;
      for (const stmt of statements) {
        try {
          await conn.query(stmt);
        } catch (e: any) {
          // Non-SUPER user can't CREATE TRIGGER under binlog (errno 1419). The
          // trigger migrations (0009 meeting-in-past, 0018 audit append-only) are
          // defense-in-depth — both rules are ALSO enforced in the app layer — so
          // skip the trigger statement and continue.
          if (
            e &&
            (e.errno === 1419 ||
              e.code === "ER_BINLOG_CREATE_ROUTINE_NEED_SUPER" ||
              (e.errno === 1142 && /CREATE\s+TRIGGER/i.test(stmt)) ||
              (e.message && e.message.includes("TRIGGER command denied")))
          ) {
            triggerSkipped = true;
            continue;
          }
          // "Already applied" on a re-run after a partial failure → skip.
          if (e && ALREADY_APPLIED_ERRNOS.has(e.errno)) continue;
          // Anything else is a genuine error — surface it (boot will report it).
          throw e;
        }
      }
      if (triggerSkipped) {
        console.warn(
          `[migrate] ${f}: skipped DB trigger (no SUPER / log_bin_trust_function_creators). ` +
            `The equivalent check is enforced in the app layer. ` +
            `Ask your DBA to enable log_bin_trust_function_creators if you want the DB-level guard.`,
        );
        skipped++;
      }
      // INSERT IGNORE so the run-once record is idempotent: if another process
      // (e.g. a second test file's migrate(), or a concurrent boot) recorded this
      // file after we read the `applied` set, the duplicate PK is silently ignored
      // instead of throwing — the statements above are already idempotent, so the
      // file is genuinely applied either way.
      await conn.query(
        "INSERT IGNORE INTO schema_migrations (filename) VALUES (?)",
        [f],
      );
      n++;
    }
    if (skipped)
      console.warn(
        `[migrate] ${skipped} migration(s) partially skipped (see above).`,
      );
    return n;
  } finally {
    await conn.end();
  }
}

// Auto-promote bundled snapshot into the target DB on the very FIRST live boot.
//
// Context: the live server ran DB_PROFILE=local for weeks while the team
// signed up + chatted. Real data sits in the bundled local DB. Cutover to the
// shared corporate DB (DB_PROFILE=live) would expose an EMPTY DB unless we
// move the data. This runs that move automatically, exactly once, so IT only
// runs `docker compose up -d --build`.
//
// Decision matrix (idempotent — safe to re-run on every boot):
//   deploy_state.phase = 'migrated'        → no-op, snapshot was imported.
//   deploy_state.phase = 'existing'        → no-op, target had data; refused.
//   deploy_state.phase = 'fresh'           → no-op, started without a snapshot.
//   deploy_state row missing AND
//     target users count == 0
//     bundled dump exists                  → IMPORT dump, set 'migrated'.
//   deploy_state row missing AND
//     target users count >  0              → set 'existing', refuse to clobber.
//   deploy_state row missing AND
//     bundled dump missing                 → set 'fresh', warn.
//
// Override: COLAB_FORCE_REIMPORT=yes forces import even if 'existing'. Logged.
async function promoteIfNeeded(url: string) {
  const cfg = parseUrl(url);
  const conn = await connectWithRetry({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: true,
  });
  try {
    // 0044_deploy_state.sql creates the table; if for any reason migrate()
    // hasn't run yet (e.g. someone called promoteIfNeeded directly), self-heal.
    await conn.query(
      "CREATE TABLE IF NOT EXISTS deploy_state (" +
        "phase VARCHAR(32) NOT NULL," +
        "migrated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP," +
        "source_checksum VARCHAR(64) NULL," +
        "source_rows INT NULL," +
        "target_rows_pre INT NULL," +
        "target_rows_post INT NULL," +
        "notes TEXT NULL," +
        "PRIMARY KEY (phase)" +
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    );
    const [rows]: any = await conn.query(
      "SELECT phase, migrated_at FROM deploy_state LIMIT 1",
    );
    if (rows && rows.length) {
      const phase = rows[0].phase;
      if (!process.env.COLAB_FORCE_REIMPORT || process.env.COLAB_FORCE_REIMPORT !== "yes") {
        console.log(
          `[promote] deploy_state.phase=${phase} (migrated_at=${rows[0].migrated_at}) — already decided, skipping.`,
        );
        return { phase, imported: 0 };
      }
      console.warn(
        `[promote] COLAB_FORCE_REIMPORT=yes — IGNORING deploy_state.phase=${phase} and re-running promotion.`,
      );
    }

    // Explicit FRESH-START switch (COLAB_FRESH_START=yes): skip the bundled-dump
    // import so the target starts empty (schema only, from migrate()). It does NOT
    // delete or reset anything, and it is DEFENSIVE — if the target already has
    // users it is IGNORED, so a populated prod DB can NEVER be "factory reset" by
    // leaving this flag on. Combined with the deploy_state guard above (which makes
    // promote a one-time decision after the first boot), it is safe to leave set.
    if (process.env.COLAB_FRESH_START === "yes") {
      let nUsers = 0;
      try {
        const [r]: any = await conn.query("SELECT COUNT(*) AS n FROM users");
        nUsers = (r && r[0] && Number(r[0].n)) || 0;
      } catch (_) { /* users table may not exist yet on a brand-new schema */ }
      if (nUsers === 0) {
        await conn.query(
          "INSERT IGNORE INTO deploy_state (phase, notes) VALUES ('fresh', ?)",
          ["COLAB_FRESH_START=yes — empty target, bundled dump import skipped"],
        );
        console.log(
          "[promote] COLAB_FRESH_START=yes on an EMPTY target — starting clean (no dump import, no data touched).",
        );
        return { phase: "fresh", imported: 0 };
      }
      console.warn(
        `[promote] COLAB_FRESH_START=yes IGNORED — target already has ${nUsers} users; existing data left untouched.`,
      );
      // fall through to the normal path, which stamps 'existing' and refuses to clobber.
    }

    const dumpPath = path.resolve(__dirname, "../dumps/colab_full.sql");
    const dumpExists = (() => {
      try {
        const st = fs.statSync(dumpPath);
        return st.isFile() && st.size > 1024;
      } catch {
        return false;
      }
    })();

    // Determine if target DB has user data (the signal of "do not clobber").
    let usersBefore = 0;
    try {
      const [r]: any = await conn.query("SELECT COUNT(*) AS n FROM users");
      usersBefore = (r && r[0] && Number(r[0].n)) || 0;
    } catch (_) {
      usersBefore = 0; // users table doesn't exist yet → effectively empty
    }

    if (!dumpExists) {
      await conn.query(
        "INSERT IGNORE INTO deploy_state (phase, notes) VALUES ('fresh', ?)",
        [`no dump at ${dumpPath}; started empty`],
      );
      console.log(
        `[promote] no bundled dump at ${dumpPath} — phase='fresh' (target users=${usersBefore}).`,
      );
      return { phase: "fresh", imported: 0 };
    }

    if (usersBefore > 0 && process.env.COLAB_FORCE_REIMPORT !== "yes") {
      await conn.query(
        "INSERT IGNORE INTO deploy_state (phase, target_rows_pre, notes) VALUES ('existing', ?, ?)",
        [usersBefore, `target had ${usersBefore} users; refused to import bundled dump`],
      );
      console.warn(
        `[promote] target DB already has ${usersBefore} users — REFUSING to import the bundled dump (no data clobber). ` +
          `phase='existing'. To force, set COLAB_FORCE_REIMPORT=yes (DESTRUCTIVE; back up first).`,
      );
      return { phase: "existing", imported: 0 };
    }

    // Import the dump. The SQL contains DROP TABLE IF EXISTS + CREATE TABLE +
    // INSERTs (mysqldump --add-drop-table). MySQL multipleStatements allows
    // the whole file in one round-trip; we already verified the dump is plain
    // UTF-8 and well-formed. Disable FK checks during import so DROPs honor
    // mysqldump's own ordering.
    const dumpSql = fs.readFileSync(dumpPath, "utf8");
    const crypto = require("crypto");
    const checksum = crypto.createHash("sha256").update(dumpSql).digest("hex");
    console.log(
      `[promote] importing bundled snapshot from ${dumpPath} (${(dumpSql.length / 1024 / 1024).toFixed(2)}MB, sha256=${checksum.slice(0, 12)}…). target users before=${usersBefore}`,
    );
    await conn.query("SET FOREIGN_KEY_CHECKS=0");
    try {
      await conn.query(dumpSql);
    } finally {
      await conn.query("SET FOREIGN_KEY_CHECKS=1");
    }

    let usersAfter = 0;
    try {
      const [r]: any = await conn.query("SELECT COUNT(*) AS n FROM users");
      usersAfter = (r && r[0] && Number(r[0].n)) || 0;
    } catch (_) {
      usersAfter = 0;
    }

    if (usersAfter === 0) {
      // The dump imported but yielded no users — something is wrong. Mark and
      // surface loudly so the operator notices instead of silently bricking.
      await conn.query(
        "INSERT IGNORE INTO deploy_state (phase, source_checksum, source_rows, target_rows_pre, target_rows_post, notes) " +
          "VALUES ('error', ?, ?, ?, ?, ?)",
        [
          checksum,
          0,
          usersBefore,
          usersAfter,
          "import completed but users count is 0 — verify dump integrity",
        ],
      );
      throw new Error(
        "[promote] bundled snapshot imported but users table is EMPTY — refusing to mark as migrated. " +
          "Inspect database/dumps/colab_full.sql + DB and re-run.",
      );
    }

    // Migrations might have created schema rows AFTER import; rerun schema
    // migrations so any post-dump migration files apply on top of the imported
    // data. The schema_migrations table came from the dump too, so files
    // already in it are skipped automatically.
    await migrate(url);

    await conn.query(
      "INSERT INTO deploy_state (phase, source_checksum, source_rows, target_rows_pre, target_rows_post, notes) " +
        "VALUES ('migrated', ?, ?, ?, ?, ?)",
      [
        checksum,
        usersAfter,
        usersBefore,
        usersAfter,
        `auto-imported from database/dumps/colab_full.sql on first boot`,
      ],
    );
    console.log(
      `[promote] SUCCESS — phase='migrated'. users: ${usersBefore} -> ${usersAfter}. The signups + messages from the localhost-DB era are now in the target DB.`,
    );
    return { phase: "migrated", imported: usersAfter };
  } finally {
    await conn.end().catch(() => {});
  }
}

export { ensureDatabase, migrate, promoteIfNeeded, isTransientDbError };
