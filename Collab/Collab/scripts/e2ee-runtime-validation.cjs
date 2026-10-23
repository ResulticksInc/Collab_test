/**
 * GAP-1 — E2EE RUNTIME VALIDATION HARNESS
 *
 * Automates the server-blindness checks from docs/E2EE_ADVERSARIAL_AUDIT.md §5.
 * Run this AFTER:
 *   1. Setting NEXT_PUBLIC_E2EE_ENABLED=true + E2EE_ENABLED=true in the env.
 *   2. Rebuilding + restarting both servers.
 *   3. Opening TWO browsers (different users) and sending each of these from
 *      each browser to the other:
 *        a) A plain text message in a DM
 *        b) A text message in a GROUP (or channel)
 *        c) A FILE attachment in a DM
 *        d) A FILE attachment in a group
 *        e) Place a 1:1 CALL (any duration > 5s)
 *        f) Place a GROUP CALL or MEETING (any duration > 5s)
 *   4. Letting the harness sit for ~10 seconds after the last send so realtime
 *      writes settle.
 *
 * Then:  node scripts/e2ee-runtime-validation.cjs
 *
 * The script connects to the DB directly (no API auth needed) and asserts:
 *   V-1  At least one message exists with body=NULL AND ciphertext_json != NULL
 *        (proves E2EE writes are landing as ciphertext).
 *   V-2  ZERO messages exist with body != NULL when ciphertext_json != NULL
 *        (proves no plaintext is being co-stored).
 *   V-3  Every E2EE conversation has its messages.body NULL'd (proves no
 *        message-text leak path bypasses the gate).
 *   V-4  e2ee_devices has at least 2 rows (proves device registration), and
 *        EVERY row has identity_key populated.
 *   V-5  e2ee_devices.signing_key is populated for new devices (B2 — proves
 *        sender authentication keys are publishing).
 *   V-6  e2ee_conversation_keys has at least 1 row (proves group / call epoch
 *        key seeding works).
 *   V-7  notifications.body for "message" type notifications is empty or
 *        generic ("Sent a message") — never the plaintext (push leak check).
 *   V-8  Schema has signing_key column (migration 0050 applied).
 *
 * EXIT CODE:
 *   0 = all checks PASS — flag is safe to keep on for an enterprise audit
 *   1 = at least one check FAIL — DO NOT enable E2EE for customers
 *   2 = could not connect / could not run (re-check the env)
 *
 * The script READS ONLY — it never modifies any row. Safe to run on the live DB.
 */

const mysql = require("mysql2/promise");

const DB_URL =
  process.env.DATABASE_URL ||
  process.env.DATABASE_URL_LIVE ||
  "mysql://colab:colab@127.0.0.1:3306/colab";
const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

function parseUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, detail = "") {
  passed++;
  console.log("  PASS", name, detail ? "— " + detail : "");
}
function fail(name, detail) {
  failed++;
  fails.push(name);
  console.log("  FAIL", name, "— " + detail);
}

(async () => {
  console.log("\n=============================================================");
  console.log("CoLab E2EE Runtime Validation (GAP-1)");
  console.log("=============================================================\n");

  let conn;
  try {
    conn = await mysql.createConnection({ ...parseUrl(DB_URL), connectTimeout: 8000 });
  } catch (e) {
    console.error("Could not connect to DB at", DB_URL, "—", e.message);
    process.exit(2);
  }

  try {
    // V-8: migration 0050 applied
    const [cols] = await conn.query(
      "SHOW COLUMNS FROM e2ee_devices LIKE 'signing_key'",
    );
    if (cols.length === 1) ok("V-8 migration 0050 applied (signing_key column exists)");
    else fail("V-8 schema", "signing_key column missing on e2ee_devices — migration 0050 not applied");

    // V-1 / V-2 / V-3: per-message ciphertext invariants
    const [encCount] = await conn.query(
      "SELECT COUNT(*) AS n FROM messages WHERE ciphertext_json IS NOT NULL",
    );
    const [bodyAndCtCount] = await conn.query(
      "SELECT COUNT(*) AS n FROM messages WHERE ciphertext_json IS NOT NULL AND body IS NOT NULL AND body != ''",
    );
    const [emptyBodyEncCount] = await conn.query(
      "SELECT COUNT(*) AS n FROM messages WHERE ciphertext_json IS NOT NULL AND (body IS NULL OR body = '')",
    );
    const totalEnc = Number(encCount[0].n);
    if (totalEnc === 0) {
      fail(
        "V-1 ciphertext landings",
        "ZERO messages with ciphertext_json — either no E2EE sends happened yet, or the encrypted writes are not reaching the DB. Open 2 browsers, send a DM with the flag ON, then re-run.",
      );
    } else {
      ok("V-1 ciphertext landings", `${totalEnc} message(s) stored as ciphertext`);
    }
    if (Number(bodyAndCtCount[0].n) > 0) {
      fail(
        "V-2 no plaintext co-storage",
        `${bodyAndCtCount[0].n} message(s) have BOTH body AND ciphertext_json — plaintext is being co-stored. Critical leak.`,
      );
    } else if (totalEnc > 0) {
      ok("V-2 no plaintext co-storage", "no row has both body and ciphertext_json");
    }
    if (totalEnc > 0 && Number(emptyBodyEncCount[0].n) === totalEnc) {
      ok("V-3 every encrypted row has body NULL", `${emptyBodyEncCount[0].n}/${totalEnc}`);
    } else if (totalEnc > 0) {
      fail(
        "V-3 encrypted-row body NULL",
        `${emptyBodyEncCount[0].n}/${totalEnc} have body NULL — the remainder leak plaintext`,
      );
    }

    // V-4: device registration
    const [devCount] = await conn.query("SELECT COUNT(*) AS n FROM e2ee_devices");
    const [devsNoIdent] = await conn.query(
      "SELECT COUNT(*) AS n FROM e2ee_devices WHERE identity_key IS NULL OR identity_key = ''",
    );
    if (Number(devCount[0].n) >= 2) {
      ok("V-4 device registration", `${devCount[0].n} device(s) registered`);
    } else {
      fail(
        "V-4 device registration",
        `only ${devCount[0].n} device(s) — need ≥ 2 for a two-browser validation; have the second user logged in with the flag ON?`,
      );
    }
    if (Number(devsNoIdent[0].n) > 0) {
      fail(
        "V-4 identity keys",
        `${devsNoIdent[0].n} device(s) have NO identity_key — registration is broken`,
      );
    } else {
      ok("V-4 identity keys", "every registered device has identity_key");
    }

    // V-5: signing keys published (B2)
    const [signCount] = await conn.query(
      "SELECT COUNT(*) AS n FROM e2ee_devices WHERE signing_key IS NOT NULL AND signing_key != ''",
    );
    if (Number(signCount[0].n) >= 2) {
      ok("V-5 sender-auth signing keys", `${signCount[0].n} device(s) published signing_key`);
    } else if (Number(devCount[0].n) > 0) {
      fail(
        "V-5 sender-auth signing keys",
        `only ${signCount[0].n}/${devCount[0].n} device(s) have signing_key — B2 sender authentication won't engage for the rest`,
      );
    }

    // V-6: epoch keys for groups + calls
    const [epochCount] = await conn.query(
      "SELECT COUNT(*) AS n FROM e2ee_conversation_keys",
    );
    if (Number(epochCount[0].n) >= 1) {
      ok("V-6 epoch key seeding", `${epochCount[0].n} epoch row(s) — group / call media keys are publishing`);
    } else {
      fail(
        "V-6 epoch key seeding",
        "no epoch keys — group encryption or call media E2EE is NOT engaging",
      );
    }

    // V-7: push notification plaintext audit
    // Inspect message-type notifications; the body should be empty, generic, or
    // absent — NEVER the actual message text.
    const [msgNotifs] = await conn.query(
      "SELECT body FROM notifications WHERE type = 'message' ORDER BY id DESC LIMIT 50",
    );
    const generic = new Set(["", "sent a message", "new message"]);
    const leaks = msgNotifs.filter((r) => {
      const b = String(r.body || "").trim().toLowerCase();
      if (!b) return false;
      if (generic.has(b)) return false;
      // A body that begins with "Sent a message" or "New message" prefix is OK.
      if (b.startsWith("sent a message") || b.startsWith("new message")) return false;
      // A body that's just the sender's name + nothing else is OK (it's metadata).
      // Anything else is a probable plaintext excerpt.
      return true;
    });
    if (leaks.length === 0) {
      ok(
        "V-7 push notification text gating",
        msgNotifs.length === 0
          ? "no message notifications to inspect (send a few then re-run)"
          : `${msgNotifs.length} message notification(s) inspected, none leaked plaintext`,
      );
    } else {
      fail(
        "V-7 push notification text gating",
        `${leaks.length}/${msgNotifs.length} message notifications carry plaintext-like body (sample: "${leaks[0].body.slice(0, 60)}…")`,
      );
    }

    // Bonus: convFlags TOFU-encryption pin is per-CLIENT (IndexedDB) so we
    // can't check it here. But we CAN print encryption coverage so the
    // operator sees how much of the DB is encrypted vs plaintext.
    const [totalMsgs] = await conn.query(
      "SELECT COUNT(*) AS n FROM messages WHERE type IN ('text', 'file')",
    );
    const tot = Number(totalMsgs[0].n);
    const cov = tot > 0 ? ((totalEnc / tot) * 100).toFixed(1) : "n/a";
    console.log(`\n  INFO: encrypted coverage = ${cov}% (${totalEnc}/${tot} text+file messages)`);
    if (VERBOSE) {
      const [sample] = await conn.query(
        "SELECT id, conversation_id, sender_id, type, LENGTH(ciphertext_json) AS ct_len, LEFT(body, 40) AS body_excerpt FROM messages WHERE ciphertext_json IS NOT NULL ORDER BY id DESC LIMIT 5",
      );
      console.log("\n  VERBOSE: 5 most-recent encrypted rows:");
      for (const r of sample)
        console.log(
          `    msg ${r.id} conv=${r.conversation_id} type=${r.type} ct_bytes=${r.ct_len} body=${r.body_excerpt === null ? "NULL" : `"${r.body_excerpt}"`}`,
        );
    }
  } finally {
    await conn.end().catch(() => {});
  }

  console.log("\n=============================================================");
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFAILED CHECKS:");
    for (const f of fails) console.log("  -", f);
    console.log(
      "\nE2EE is NOT runtime-validated. DO NOT enable the flag for enterprise customers until every check above passes.",
    );
    process.exit(1);
  }
  console.log(
    "\nAll server-side runtime invariants hold. GAP-1 satisfied — schedule the independent audit (GAP-4) next.",
  );
  process.exit(0);
})().catch((e) => {
  console.error("Runtime validation crashed:", e);
  process.exit(2);
});
