// Verifies the optimized (3-query) conversations.listForUser produces IDENTICAL
// results to the old N+1 version, against the real local DB. Run:
//   node scripts/verify-listforuser.cjs
const mysql = require("mysql2/promise");

(async () => {
  const c = await mysql.createConnection({
    host: "127.0.0.1", port: 3306, user: "colab", password: "colab", database: "colab",
  });

  // Pick every user who is a member of something, and compare per user.
  const [users] = await c.query("SELECT DISTINCT user_id FROM conversation_members");

  // OLD: 1 + 2N queries.
  async function oldList(uid) {
    const [rows] = await c.query(
      "SELECT c.*, cm.starred, cm.muted, cm.hidden, cm.unread, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=?",
      [uid],
    );
    const out = [];
    for (const cv of rows) {
      const [mem] = await c.query("SELECT user_id FROM conversation_members WHERE conversation_id=?", [cv.id]);
      const [last] = await c.query("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1", [cv.id]);
      out.push({ id: cv.id, members: mem.map((x) => x.user_id).sort(), lastId: last[0] ? last[0].id : null });
    }
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  // NEW: 3 queries total (the version going into mysql.ts).
  async function newList(uid) {
    const [rows] = await c.query(
      "SELECT c.*, cm.starred, cm.muted, cm.hidden, cm.unread, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=?",
      [uid],
    );
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [memRows] = await c.query("SELECT conversation_id, user_id FROM conversation_members WHERE conversation_id IN (?)", [ids]);
    const memBy = new Map();
    for (const m of memRows) {
      if (!memBy.has(m.conversation_id)) memBy.set(m.conversation_id, []);
      memBy.get(m.conversation_id).push(m.user_id);
    }
    const [lastRows] = await c.query(
      "SELECT * FROM (SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at DESC, m.id DESC) AS rn FROM messages m WHERE m.conversation_id IN (?)) t WHERE t.rn = 1",
      [ids],
    );
    const lastBy = new Map();
    for (const m of lastRows) lastBy.set(m.conversation_id, m);
    const out = rows.map((cv) => ({
      id: cv.id,
      members: (memBy.get(cv.id) || []).slice().sort(),
      lastId: lastBy.get(cv.id) ? lastBy.get(cv.id).id : null,
    }));
    return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  let mismatches = 0;
  for (const u of users) {
    const a = JSON.stringify(await oldList(u.user_id));
    const b = JSON.stringify(await newList(u.user_id));
    if (a !== b) {
      mismatches++;
      console.log("MISMATCH for", u.user_id);
      console.log("  old:", a);
      console.log("  new:", b);
    }
  }
  console.log(`Checked ${users.length} users — ${mismatches} mismatches.`);
  await c.end();
  process.exit(mismatches === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
