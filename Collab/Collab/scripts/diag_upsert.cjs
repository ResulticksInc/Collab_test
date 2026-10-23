// Diagnose the users.upsert path: run the EXACT INSERT...AS new...ON DUPLICATE
// KEY UPDATE the driver uses, then read the row back. Reveals whether the row
// alias syntax or something else is the cause of signup returning undefined.
const mysql = require("mysql2/promise");
require("dotenv").config();
(async () => {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [[v]] = await conn.query("SELECT VERSION() AS v");
  console.log("MySQL VERSION:", v.v);
  const id = "u_diag_" + Date.now();
  const sql = `INSERT INTO users (id,email,name,initials,color,avatar_url,role,presence,password_hash) VALUES (?,?,?,?,?,?,?,?,?) AS new ON DUPLICATE KEY UPDATE email=new.email,name=new.name,initials=new.initials,color=new.color,avatar_url=new.avatar_url,role=new.role,presence=new.presence,password_hash=COALESCE(new.password_hash, users.password_hash)`;
  const params = [id, id + "@diag.test", "Diag", "D", "#2563EB", null, "member", "online", "x:y"];
  try {
    const [res] = await conn.query(sql, params);
    console.log("INSERT ok, affectedRows=", res.affectedRows);
  } catch (e) {
    console.log("INSERT THREW:", e.code, "-", e.sqlMessage || e.message);
  }
  const [rows] = await conn.query("SELECT id,email,name FROM users WHERE id=?", [id]);
  console.log("row after insert:", rows[0] || "(NOT FOUND)");
  await conn.query("DELETE FROM users WHERE id=?", [id]).catch(() => {});
  await conn.end();
  process.exit(0);
})().catch((e) => { console.log("FATAL:", e.code || "", e.message); process.exit(1); });
