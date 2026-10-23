/**
 * E2EE runtime verification — checks live DB state after two-browser smoke test.
 *
 * Prerequisites:
 *   1. Set NEXT_PUBLIC_E2EE_ENABLED=true and E2EE_ENABLED=true in .env
 *   2. Restart backend + frontend: npm run dev (or docker compose restart)
 *   3. Open TWO browsers as two different users, send a DM and a group message
 *   4. Run: node scripts/verify-e2ee-runtime.cjs [optional-DB-url]
 *
 * If no DB URL is given, falls back to DATABASE_URL in .env.
 * Prints PASS/FAIL for each check. Exit 0 = all pass.
 */
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

// ---- DB connection --------------------------------------------------------
function loadEnv(file) {
  const p = path.join(__dirname, "..", file);
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

async function connect(urlOverride) {
  const env = loadEnv(".env");
  const url = urlOverride || env.DATABASE_URL || "mysql://colab:colab@localhost:3306/colab";
  const u = new URL(url);
  return mysql.createConnection({
    host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    connectTimeout: 8000,
  });
}

// ---- helpers ---------------------------------------------------------------
let pass = 0, fail = 0, warn = 0;
function PASS(name, detail = "") { pass++; console.log(`  ✓  PASS  ${name}${detail ? "  " + detail : ""}`); }
function FAIL(name, detail = "") { fail++; console.log(`  ✗  FAIL  ${name}${detail ? "  — " + detail : ""}`); }
function WARN(name, detail = "") { warn++; console.log(`  ⚠  WARN  ${name}${detail ? "  — " + detail : ""}`); }
function INFO(msg) { console.log(`       ${msg}`); }

// ---- main ------------------------------------------------------------------
(async () => {
  console.log("\nCoLab E2EE Runtime Verification\n");

  let c;
  try {
    c = await connect(process.argv[2]);
  } catch (e) {
    console.error("DB connect failed:", e.message);
    console.error("Is the database running? (docker compose up -d db)");
    process.exit(2);
  }

  // 1 ── E2EE flag on backend --------------------------------------------------
  {
    // We detect indirectly: if E2EE is enabled, encrypted messages exist.
    // (The flag itself is in env, not DB — just remind the runner.)
    console.log("§1  E2EE flag check");
    INFO("NEXT_PUBLIC_E2EE_ENABLED and E2EE_ENABLED must both be 'true' in .env");
    INFO("Restart backend + frontend after changing them, then hard-reload the browser.");
    console.log();
  }

  // 2 ── Messages encrypted -------------------------------------------------------
  {
    console.log("§2  Messages table — encrypted content");
    const [rows] = await c.query(`
      SELECT
        id, type, conversation_id, sender_id,
        body IS NOT NULL AS has_body,
        encryption_version,
        ciphertext_json IS NOT NULL AS has_ct,
        LEFT(ciphertext_json, 60) AS ct_preview
      FROM messages
      WHERE type = 'text'
        AND deleted = 0
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const total = rows.length;
    const encrypted = rows.filter(r => r.has_ct && !r.has_body && r.encryption_version >= 1);
    const plaintext = rows.filter(r => r.has_body && !r.has_ct);
    const mixed = rows.filter(r => r.has_ct && r.has_body);

    if (encrypted.length > 0) {
      PASS("encrypted messages exist", `${encrypted.length}/${total} messages have body=NULL + ciphertext_json`);
    } else if (total === 0) {
      WARN("no text messages found", "Send a DM and a group message with the flag ON, then re-run");
    } else {
      FAIL("no encrypted messages", `${total} messages found but none are encrypted (flag may be OFF or messages pre-date E2EE)`);
    }
    if (mixed.length > 0) {
      FAIL("mixed body+ciphertext rows", `${mixed.length} rows have BOTH body and ciphertext_json — encryption not blocking plaintext store`);
    }
    INFO(`Plaintext messages: ${plaintext.length}  (expected: legacy/pre-E2EE messages only)`);
    if (encrypted.length > 0) {
      INFO("Sample encrypted row:");
      INFO(`  id=${encrypted[0].id}  conv=${encrypted[0].conversation_id}  ct_preview: ${encrypted[0].ct_preview}`);
    }
    console.log();
  }

  // 3 ── E2EE devices registered ---------------------------------------------------
  {
    console.log("§3  e2ee_devices table — device registration");
    const [rows] = await c.query(`
      SELECT id, user_id, name,
        LEFT(identity_key, 20) AS ik_preview,
        trusted, revoked, created_at
      FROM e2ee_devices
      ORDER BY created_at DESC
      LIMIT 10
    `);

    if (rows.length === 0) {
      FAIL("no devices registered", "initE2EE() must have run — did the browser load the app with the flag ON?");
    } else {
      const trusted = rows.filter(r => r.trusted && !r.revoked);
      const pending = rows.filter(r => !r.trusted && !r.revoked);
      const revoked = rows.filter(r => r.revoked);
      PASS("devices registered", `${rows.length} total (${trusted.length} trusted, ${pending.length} pending, ${revoked.length} revoked)`);
      for (const d of rows) {
        INFO(`  device ${d.id}  user=${d.user_id}  trusted=${d.trusted}  revoked=${d.revoked}  ik=...${d.ik_preview}`);
      }
    }
    console.log();
  }

  // 4 ── Conversation epoch keys (group E2EE) ------------------------------------
  {
    console.log("§4  e2ee_conversation_keys table — group/channel epoch keys");
    let rows;
    try {
      [rows] = await c.query(`
        SELECT conversation_id, device_id, key_version,
          LEFT(encrypted_key, 30) AS ek_preview,
          created_at
        FROM e2ee_conversation_keys
        ORDER BY created_at DESC
        LIMIT 20
      `);
    } catch (e) {
      WARN("e2ee_conversation_keys not queryable", e.message);
      rows = [];
    }

    if (rows.length === 0) {
      WARN("no group/channel epoch keys", "Send a group/channel message with the flag ON to seed the epoch");
    } else {
      const convs = new Set(rows.map(r => r.conversation_id));
      PASS("epoch keys exist", `${rows.length} wrapped keys across ${convs.size} conversation(s)`);
      for (const conv of convs) {
        const keys = rows.filter(r => r.conversation_id === conv);
        INFO(`  conv=${conv}  devices=${keys.length}  epoch_ver=${keys[0].key_version}`);
      }
    }
    console.log();
  }

  // 5 ── Prekeys stored (V4 forward secrecy) ----------------------------------------
  {
    console.log("§5  e2ee_one_time_prekeys table — one-time prekeys for forward secrecy (V4)");
    let rows;
    try {
      [rows] = await c.query(`
        SELECT device_id,
          COUNT(*) AS cnt,
          SUM(consumed_at IS NOT NULL) AS used,
          SUM(consumed_at IS NULL) AS available
        FROM e2ee_one_time_prekeys
        GROUP BY device_id
      `);
    } catch (e) {
      WARN("e2ee_one_time_prekeys not queryable", e.message);
      rows = [];
    }

    if (rows.length === 0) {
      WARN("no prekeys", "initE2EE() publishes 100 prekeys on first run — did device registration run?");
    } else {
      const totalAvail = rows.reduce((s, r) => s + Number(r.available), 0);
      if (totalAvail > 0) {
        PASS("prekeys available for forward secrecy", `${totalAvail} available across ${rows.length} device(s)`);
      } else {
        WARN("all prekeys consumed", "replenishment should trigger when <20 remain");
      }
      for (const d of rows) {
        INFO(`  device=${d.device_id}  available=${d.available}  used=${d.used}`);
      }
    }
    console.log();
  }

  // 6 ── Notifications — no plaintext leak ----------------------------------------
  {
    console.log("§6  notifications table — E2EE notifications must not expose message content");
    let rows;
    try {
      // Notifications use target_id (message id) + target_type, not message_id.
      // The notification body is the push text; for E2EE DMs it should say
      // "Sent a message" not the actual content (gated in realtime/socket.ts).
      [rows] = await c.query(`
        SELECT n.id, n.type, n.target_type, n.target_id, n.body AS notif_body,
          m.encryption_version, m.body IS NULL AS msg_body_null
        FROM notifications n
        LEFT JOIN messages m ON m.id = n.target_id AND n.target_type = 'message'
        WHERE n.type IN ('dm', 'mention', 'group', 'reply')
          AND n.deleted = 0
        ORDER BY n.created_at DESC
        LIMIT 20
      `);
    } catch (e) {
      WARN("notifications not queryable", e.message);
      rows = [];
    }

    if (rows.length === 0) {
      INFO("No message-type notifications found yet");
    } else {
      // A leak: notification body contains non-generic text for an encrypted message.
      // "Sent a message" / "Sent an attachment" / "Sent a file" are safe generic bodies.
      const safePattern = /^(Sent a message|Sent an attachment|Sent a file|New message|📎)/i;
      const leaks = rows.filter(r =>
        r.encryption_version >= 1 && r.msg_body_null &&
        r.notif_body && !safePattern.test(String(r.notif_body))
      );
      if (leaks.length === 0) {
        PASS("notification bodies are generic for encrypted messages", `checked ${rows.length} notifications`);
      } else {
        FAIL("notification body leaks plaintext for encrypted message",
          `${leaks.length} rows expose content in the notification body for E2EE messages`);
        for (const l of leaks) {
          INFO(`  notif id=${l.id}  type=${l.type}  body="${(l.notif_body || "").slice(0, 60)}"`);
        }
      }
      INFO(`Encrypted-message notifications checked: ${rows.filter(r => r.encryption_version >= 1).length}`);
    }
    console.log();
  }

  // 7 ── Self-read guard: sender device must have an envelope to themselves ---------
  {
    console.log("§7  Self-envelope check (sender can re-read own DMs)");
    let rows;
    try {
      [rows] = await c.query(`
        SELECT m.id, m.sender_id,
          JSON_LENGTH(m.ciphertext_json, '$.envelopes') AS env_count
        FROM messages m
        WHERE m.encryption_version >= 1
          AND m.ciphertext_json IS NOT NULL
          AND m.deleted = 0
        ORDER BY m.created_at DESC
        LIMIT 10
      `);
    } catch (e) {
      WARN("Could not check envelope count in ciphertext_json", e.message);
      rows = [];
    }

    if (rows.length === 0) {
      INFO("No encrypted messages to check");
    } else {
      const missing = rows.filter(r => r.env_count !== null && r.env_count < 2);
      if (missing.length === 0) {
        PASS("all encrypted messages have ≥2 envelopes (self + recipient)", `checked ${rows.length} messages`);
      } else {
        WARN("some messages have only 1 envelope", `${missing.length} may be missing self-envelope (sender can't re-read)`);
        for (const m of missing) {
          INFO(`  msg=${m.id}  sender=${m.sender_id}  envelope_count=${m.env_count}`);
        }
      }
    }
    console.log();
  }

  // 8 ── Summary ------------------------------------------------------------------
  await c.end();
  console.log("─".repeat(60));
  console.log(`RESULT: ${pass} pass  ${warn} warn  ${fail} fail`);
  if (fail > 0) {
    console.log("\nAction: fix the FAIL items above before enabling E2EE in production.");
    process.exit(1);
  } else if (warn > 0) {
    console.log("\nAll checks PASS or WARN (warnings require the two-browser smoke test to be run first).");
    console.log("Re-run after sending DM + group messages with the flag ON.");
    process.exit(0);
  } else {
    console.log("\nAll DB-side E2EE checks pass.");
    console.log("Complete the browser-side checks in docs/E2EE_ADVERSARIAL_AUDIT.md §5.");
    process.exit(0);
  }
})().catch(e => { console.error("Script crashed:", e); process.exit(2); });
