// Read-only schema audit: diff LOCAL (bundled colab) vs LIVE (corporate) — tables
// + migration ledger. Live creds come from .env.live (never printed), same as
// scripts/find-live-users.cjs. Run from repo root: node scripts/live-audit.cjs
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

function liveUrl() {
  const txt = fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8");
  const m = txt.match(/^DATABASE_URL_LIVE=(.+)$/m);
  if (!m) throw new Error("DATABASE_URL_LIVE not in .env.live");
  return m[1].trim();
}

async function connFromUrl(url) {
  const u = new URL(url);
  return mysql.createConnection({
    host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    connectTimeout: 12000,
  });
}

async function tables(c) {
  const [r] = await c.query(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY t",
  );
  return r.map((x) => x.t || x.TABLE_NAME);
}
async function migs(c) {
  try {
    const [r] = await c.query("SELECT name FROM schema_migrations ORDER BY name");
    return r.map((x) => x.name);
  } catch {
    return null; // table may not exist
  }
}

(async () => {
  const LOCAL = "mysql://colab:colab@localhost:3306/colab";
  const local = await connFromUrl(LOCAL);
  let live;
  try {
    live = await connFromUrl(liveUrl());
  } catch (e) {
    console.error("LIVE connect failed:", e.code || e.message, "(on corporate net/VPN?)");
    process.exit(2);
  }

  const lt = await tables(local);
  const vt = await tables(live);
  const onlyLocal = lt.filter((t) => !vt.includes(t));
  const onlyLive = vt.filter((t) => !lt.includes(t));

  console.log(`LOCAL tables: ${lt.length}    LIVE tables: ${vt.length}\n`);
  console.log("Missing on LIVE (present local, absent live):");
  console.log(onlyLocal.length ? onlyLocal.map((t) => "  + " + t).join("\n") : "  (none)");
  console.log("\nExtra on LIVE (present live, absent local):");
  console.log(onlyLive.length ? onlyLive.map((t) => "  - " + t).join("\n") : "  (none)");

  const lm = await migs(local);
  const vm = await migs(live);
  if (lm && vm) {
    const missMig = lm.filter((m) => !vm.includes(m));
    console.log(`\nMigration ledger — LOCAL: ${lm.length}   LIVE: ${vm.length}`);
    console.log("Migrations applied on LOCAL but NOT LIVE:");
    console.log(missMig.length ? missMig.map((m) => "  " + m).join("\n") : "  (none)");
  } else {
    console.log("\n(schema_migrations missing on one side: local=" + !!lm + " live=" + !!vm + ")");
  }

  await local.end();
  await live.end();
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
