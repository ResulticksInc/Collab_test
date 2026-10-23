// One API gateway test — fetch + insert against the live colab DB via the
// structured-JSON gateway (ONE_API_URL). Config read from .env.live. Prints raw
// responses. Insert target = meeting_ejected (no FK, no trigger, inert) and is
// cleaned up at the end. Run from repo root: node scripts/oneapi-test.cjs
const fs = require("fs");
const path = require("path");

function env(key, file) {
  const m = file.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

(async () => {
  const f = fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8");
  const URL_ = env("ONE_API_URL", f);
  const DB_TYPE = env("ONE_API_DB_TYPE", f) || "mysql";
  const DATABASE = env("ONE_API_DATABASE", f) || "colab";
  const KEY = env("ONE_API_KEY", f);
  const ENABLED = env("ONE_API_ENABLED", f);
  console.log(`One API gateway: ${URL_}`);
  console.log(`  db_type=${DB_TYPE} database=${DATABASE} key=${KEY ? "set" : "(none)"} ONE_API_ENABLED=${ENABLED}\n`);
  if (typeof fetch !== "function") { console.error("global fetch unavailable (need Node 18+)"); process.exit(1); }

  async function call(label, payload) {
    const body = { db_type: DB_TYPE, database: DATABASE, export: "json", ...payload };
    process.stdout.write(`\n>>> ${label}\n    req: ${JSON.stringify(payload)}\n`);
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(URL_, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(to);
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
      const rows = Array.isArray(json) ? json
        : json && (json.data || json.results || json.rows || json.values || json.records || json.result) || null;
      console.log(`    HTTP ${res.status} ${res.ok ? "OK" : "ERR"}`);
      console.log(`    body: ${text.length > 600 ? text.slice(0, 600) + "…(truncated)" : text}`);
      if (Array.isArray(rows)) console.log(`    parsed rows: ${rows.length}`);
      return { ok: res.ok, status: res.status, json, rows };
    } catch (e) {
      console.log(`    REQUEST FAILED: ${e.name === "AbortError" ? "timeout (15s)" : (e.cause && e.cause.code) || e.message}`);
      return { ok: false, error: e.message };
    }
  }

  // ── FETCH probes ──────────────────────────────────────────────────────────
  await call("FETCH users (limit 1)", { table: "users", limit: 1 });
  await call("FETCH schema_migrations (limit 3) — proves which DB the gateway sees",
    { table: "schema_migrations", columns: ["filename"], limit: 3, order_by: "filename DESC" });
  await call("FETCH deploy_state — does the gateway see the table I just created on 10.101.3.2?",
    { table: "deploy_state", limit: 5 });

  // ── INSERT (assumed write contract — confirm w/ DB architect) ─────────────
  const TESTID = "__oneapi_test__";
  const ins = await call("INSERT into meeting_ejected (test row)", {
    table: "meeting_ejected",
    action: "insert",
    data: { meeting_id: TESTID, user_id: TESTID, ejected_by: TESTID },
  });

  // ── FETCH-BACK to confirm the insert actually landed ──────────────────────
  const back = await call("FETCH-BACK the test row", {
    table: "meeting_ejected",
    conditions: [{ column: "meeting_id", operator: "=", value: TESTID }],
  });

  // ── CLEANUP (delete the test row) ─────────────────────────────────────────
  await call("DELETE the test row (cleanup)", {
    table: "meeting_ejected",
    action: "delete",
    conditions: [{ column: "meeting_id", operator: "=", value: TESTID }],
  });

  console.log("\n──────── SUMMARY ────────");
  console.log(`FETCH works : ${back ? "(see HTTP codes above)" : "no"}`);
  console.log(`INSERT works: ${ins.ok ? "HTTP OK" : "no/uncertain"}  — write contract is ASSUMED (oneApiClient.ts), so an error here likely means the gateway is read-only or uses different write fields.`);
  console.log("NOTE: if FETCH-BACK returned the row, insert truly landed. Cleanup attempted regardless.");
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
