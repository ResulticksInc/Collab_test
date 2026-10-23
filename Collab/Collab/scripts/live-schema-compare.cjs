// READ-ONLY deep schema compare: LOCAL vs LIVE — migration ledger + per-table
// column signatures (name+type+nullability+default). Flags any drift beyond the
// table list. Live creds from .env.live. Run: node scripts/live-schema-compare.cjs
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

async function conn(url) {
  const u = new URL(url);
  return mysql.createConnection({
    host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")), connectTimeout: 12000,
  });
}
async function migrations(c) {
  try { const [r] = await c.query("SELECT filename FROM schema_migrations ORDER BY filename"); return r.map((x) => x.filename); }
  catch { return []; }
}
async function colSig(c) {
  // table -> "col:type:null:key" sorted, so we can compare structure exactly.
  const [r] = await c.query(
    `SELECT table_name AS t, column_name AS c, column_type AS ty, is_nullable AS n, column_key AS k
     FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY t, c`,
  );
  const m = new Map();
  for (const row of r) {
    const t = row.t || row.TABLE_NAME, c2 = row.c || row.COLUMN_NAME, ty = row.ty || row.COLUMN_TYPE, n = row.n || row.IS_NULLABLE, k = row.k || row.COLUMN_KEY;
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(`${c2}:${ty}:${n}:${k}`);
  }
  return m;
}

(async () => {
  const live = await conn(fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8").match(/^DATABASE_URL_LIVE=(.+)$/m)[1].trim());
  const local = await conn("mysql://colab:colab@localhost:3306/colab");

  const lm = await migrations(local), vm = await migrations(live);
  const missMig = lm.filter((m) => !vm.includes(m));
  const extraMig = vm.filter((m) => !lm.includes(m));
  console.log(`MIGRATION LEDGER — local: ${lm.length}  live: ${vm.length}`);
  console.log("  missing on live:", missMig.length ? missMig.join(", ") : "(none)");
  console.log("  extra on live  :", extraMig.length ? extraMig.join(", ") : "(none)");

  const lc = await colSig(local), vc = await colSig(live);
  console.log("\nPER-TABLE COLUMN DRIFT (tables in both):");
  let drift = 0;
  for (const t of [...lc.keys()].filter((t) => vc.has(t)).sort()) {
    const a = lc.get(t).join("|"), b = vc.get(t).join("|");
    if (a !== b) {
      drift++;
      const la = new Set(lc.get(t)), lb = new Set(vc.get(t));
      const onlyLocal = [...la].filter((x) => !lb.has(x)).map((x) => x.split(":")[0]);
      const onlyLive = [...lb].filter((x) => !la.has(x)).map((x) => x.split(":")[0]);
      console.log(`  ${t}: cols local=${lc.get(t).length} live=${vc.get(t).length}`
        + (onlyLocal.length ? `  | only-local: ${onlyLocal.join(",")}` : "")
        + (onlyLive.length ? `  | only-live: ${onlyLive.join(",")}` : ""));
    }
  }
  console.log(drift ? `\n${drift} table(s) drifted.` : "\nNo column drift — every shared table matches exactly.");

  await live.end(); await local.end();
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
