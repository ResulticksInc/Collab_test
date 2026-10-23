// Insert ONE valid sample row into every table via the One API gateway, in FK
// dependency order. Schema is introspected from LOCAL (same as live). Each insert
// uses the confirmed contract { action:"insert", values:{...} }. Verifies via a
// DIRECT live read at the end. Creds/config from .env.live.
// Run from repo root: node scripts/oneapi-seed-samples.cjs
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const f = fs.readFileSync(path.join(__dirname, "..", ".env.live"), "utf8");
const get = (k) => (f.match(new RegExp(`^${k}=(.*)$`, "m")) || [, ""])[1].trim();
const URL_ = get("ONE_API_URL"), DB_TYPE = get("ONE_API_DB_TYPE") || "mysql", DATABASE = get("ONE_API_DATABASE") || "colab", KEY = get("ONE_API_KEY");

async function conn(url) {
  const u = new URL(url);
  return mysql.createConnection({ host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname, port: +u.port || 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)), connectTimeout: 12000 });
}
async function gwInsert(table, values) {
  try {
    const res = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify({ db_type: DB_TYPE, database: DATABASE, table, action: "insert", values }) });
    const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch {}
    const ok = res.ok && j && j.status === "success" && j.data && j.data[0] && j.data[0].affected_rows >= 1;
    return { ok, status: res.status, text: text.slice(0, 200) };
  } catch (e) { return { ok: false, status: 0, text: (e.cause && e.cause.code) || e.message }; }
}

// A value generator by column type — future datetimes (meetings has a no-past
// trigger), enum-first, {} for json, length-capped strings.
function genVal(c) {
  const dt = c.dataType.toLowerCase(), ct = (c.columnType || "").toLowerCase(), name = c.name.toLowerCase();
  if (dt === "json") return "{}";
  if (dt === "enum" || dt === "set") { const m = ct.match(/\((.*)\)/); return m ? m[1].split(",")[0].replace(/'/g, "") : "x"; }
  if (dt.includes("int")) return ct.includes("tinyint(1)") ? 1 : 1;
  if (["decimal", "float", "double", "numeric"].includes(dt)) return 1;
  if (dt === "datetime" || dt === "timestamp") return ct.includes("(3)") ? "2027-01-01 12:00:00.000" : "2027-01-01 12:00:00";
  if (dt === "date") return "2027-01-01";
  if (dt === "time") return "12:00:00";
  let v;
  if (name.includes("email")) v = "oneapi.sample@example.com";
  else if (name.includes("name")) v = "OneAPI Sample";
  else if (name.includes("title")) v = "OneAPI Sample";
  else if (["body", "content", "text", "message", "descr", "notes", "label"].some((k) => name.includes(k))) v = "OneAPI sample data";
  else v = "sample";
  if (c.charMax && v.length > c.charMax) v = v.slice(0, c.charMax);
  return v;
}

(async () => {
  const local = await conn("mysql://colab:colab@localhost:3306/colab");
  const live = await conn(f.match(/^DATABASE_URL_LIVE=(.+)$/m)[1].trim());

  // ── Introspect columns + FKs from local ──
  const [colRows] = await local.query(
    `SELECT table_name t, column_name c, data_type dt, column_type ct, is_nullable nl,
            column_default cd, column_key ck, extra ex, character_maximum_length cm
     FROM information_schema.columns WHERE table_schema='colab' ORDER BY table_name, ordinal_position`);
  const [fkRows] = await local.query(
    `SELECT table_name t, column_name c, referenced_table_name rt, referenced_column_name rc
     FROM information_schema.key_column_usage
     WHERE table_schema='colab' AND referenced_table_name IS NOT NULL`);

  const cols = new Map();   // table -> [colMeta]
  for (const r of colRows) {
    const t = r.t || r.TABLE_NAME;
    if (!cols.has(t)) cols.set(t, []);
    cols.get(t).push({ name: r.c || r.COLUMN_NAME, dataType: r.dt || r.DATA_TYPE, columnType: r.ct || r.COLUMN_TYPE, nullable: (r.nl || r.IS_NULLABLE) === "YES", def: r.cd ?? r.COLUMN_DEFAULT, key: r.ck || r.COLUMN_KEY, extra: (r.ex || r.EXTRA || "").toLowerCase(), charMax: r.cm || r.CHARACTER_MAXIMUM_LENGTH });
  }
  const fk = new Map();     // table -> { col -> refTable }
  for (const r of fkRows) { const t = r.t || r.TABLE_NAME; if (!fk.has(t)) fk.set(t, {}); fk.get(t)[r.c || r.COLUMN_NAME] = r.rt || r.REFERENCED_TABLE_NAME; }

  const tables = [...cols.keys()].filter((t) => t !== "schema_migrations"); // skip ledger
  // ── Topo sort on NOT-NULL FK edges (nullable FKs set NULL → no edge) ──
  const notNullFkEdges = new Map(tables.map((t) => [t, new Set()]));
  for (const t of tables) {
    const fkmap = fk.get(t) || {};
    for (const col of cols.get(t)) {
      if (fkmap[col.name] && !col.nullable && fkmap[col.name] !== t) notNullFkEdges.get(t).add(fkmap[col.name]);
    }
  }
  const order = [], done = new Set();
  while (order.length < tables.length) {
    const next = tables.filter((t) => !done.has(t) && [...notNullFkEdges.get(t)].every((d) => done.has(d) || !tables.includes(d)));
    if (!next.length) { tables.filter((t) => !done.has(t)).forEach((t) => { order.push(t); done.add(t); }); break; } // break any cycle
    next.forEach((t) => { order.push(t); done.add(t); });
  }

  // ── Build + insert sample per table ──
  const idReg = {}; // table -> value used for its (first) PK column, for FK refs
  const results = [];
  for (const t of order) {
    const fkmap = fk.get(t) || {};
    const values = {};
    for (const c of cols.get(t)) {
      if (c.extra.includes("auto_increment") || c.extra.includes("generated") || c.extra.includes("virtual") || c.extra.includes("stored")) continue;
      const isPk = c.key === "PRI", isFk = !!fkmap[c.name];
      const required = !c.nullable && c.def === null;
      const readable = ["name", "title", "email", "body", "content"].some((k) => c.name.toLowerCase().includes(k));
      if (isFk) {
        // reference an already-seeded parent; if none and nullable, skip (NULL)
        const ref = idReg[fkmap[c.name]];
        if (ref !== undefined) values[c.name] = ref;
        else if (required) values[c.name] = "smpl_" + fkmap[c.name]; // best-effort
        continue;
      }
      if (isPk) { const v = ("smpl_" + t).slice(0, c.charMax || 36); values[c.name] = v; if (idReg[t] === undefined) idReg[t] = v; continue; }
      if (required || readable) values[c.name] = genVal(c);
    }
    const r = await gwInsert(t, values);
    results.push({ t, ...r, cols: Object.keys(values).length });
    console.log(`${r.ok ? "  OK  " : "  FAIL"} ${t.padEnd(24)} (${Object.keys(values).length} cols)  HTTP ${r.status}  ${r.ok ? "" : r.text}`);
  }

  // ── Verify via DIRECT live read ──
  console.log("\n── Direct live row counts (proof) ──");
  let withData = 0;
  for (const t of order) {
    const [[{ n }]] = await live.query(`SELECT COUNT(*) n FROM \`${t}\``);
    if (n > 0) withData++;
    console.log(`   ${t.padEnd(24)} ${n} row(s)`);
  }
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\nGateway inserts OK: ${okCount}/${order.length}   |   tables now holding data: ${withData}/${order.length}`);
  console.log("(schema_migrations was intentionally skipped.) Check from your SQL: SELECT * FROM <table>;");
  await local.end(); await live.end();
})().catch((e) => { console.error("ERROR:", e.code || e.message); process.exit(1); });
