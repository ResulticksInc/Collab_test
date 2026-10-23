// Performance benchmark: One API gateway vs the DIRECT MySQL pool, same query,
// same live DB. Measures per-query latency (the overhead the gateway adds).
// Creds/config from .env.live. Run: node scripts/oneapi-bench.cjs
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const f = fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8");
const get = (k) => (f.match(new RegExp(`^${k}=(.*)$`, "m")) || [, ""])[1].trim();
const URL_ = get("ONE_API_URL"), DB_TYPE = get("ONE_API_DB_TYPE") || "mysql", DATABASE = get("ONE_API_DATABASE") || "colab", KEY = get("ONE_API_KEY");

const N = 30, WARM = 4;

function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return { min: s[0], p50: pct(50), avg, p95: pct(95), max: s[s.length - 1] };
}
const fmt = (x) => x.toFixed(1).padStart(7);

async function timeIt(fn) {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6; // ms
}

(async () => {
  const conn = await mysql.createConnection(fixUrl(f.match(/^DATABASE_URL_LIVE=(.+)$/m)[1].trim()));
  function fixUrl(url) { const u = new URL(url); return { host: u.hostname, port: +u.port, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)), connectTimeout: 12000 }; }

  // Equivalent query both ways: read up to 10 users (id,email).
  const directQ = () => conn.query("SELECT id, email FROM users LIMIT 10");
  const gwQ = () => fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify({ db_type: DB_TYPE, database: DATABASE, table: "users", columns: ["id", "email"], limit: 10, export: "json" }) }).then((r) => r.text());

  // Connectivity + warmup
  await directQ(); await gwQ();
  for (let i = 0; i < WARM; i++) { await directQ(); await gwQ(); }

  const direct = [], gw = [];
  for (let i = 0; i < N; i++) { direct.push(await timeIt(directQ)); gw.push(await timeIt(gwQ)); }

  const d = stats(direct), g = stats(gw);
  console.log(`Same query (SELECT id,email FROM users LIMIT 10), ${N} iterations each, same live DB.\n`);
  console.log(`                 min      p50      avg      p95      max   (ms)`);
  console.log(`Direct MySQL  ${fmt(d.min)} ${fmt(d.p50)} ${fmt(d.avg)} ${fmt(d.p95)} ${fmt(d.max)}`);
  console.log(`One API       ${fmt(g.min)} ${fmt(g.p50)} ${fmt(g.avg)} ${fmt(g.p95)} ${fmt(g.max)}`);
  console.log(`\nOverhead (One API vs direct):`);
  console.log(`  p50: +${(g.p50 - d.p50).toFixed(1)} ms  (${(g.p50 / d.p50).toFixed(1)}x)`);
  console.log(`  avg: +${(g.avg - d.avg).toFixed(1)} ms  (${(g.avg / d.avg).toFixed(1)}x)`);
  console.log(`  p95: +${(g.p95 - d.p95).toFixed(1)} ms  (${(g.p95 / d.p95).toFixed(1)}x)`);
  console.log(`\nNote: live DB is nearly empty, so this isolates per-query OVERHEAD (HTTP + gateway`);
  console.log(`processing), which is what the gateway adds to EVERY query regardless of result size.`);
  await conn.end();
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
