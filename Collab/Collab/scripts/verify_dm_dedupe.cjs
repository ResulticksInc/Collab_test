// Verify backend one-DM-per-pair enforcement: creating a DM with the same peer
// twice must return the SAME conversation id (no duplicate).
const jwt = require("jsonwebtoken");
require("dotenv").config();
const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";
const me = process.argv[2] || "u_emily";
const peer = process.argv[3] || "u_marcus";
const token = jwt.sign({ sub: me, userId: me }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
const get = async (p) => (await (await fetch(BASE + p, { headers: H })).json()).data;
const post = async (p, body) => (await (await fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(body) })).json());

(async () => {
  console.log("me:", me, "| peer:", peer);

  const r1 = await post("/api/conversations", { kind: "dm", memberIds: [peer] });
  const c1 = (r1.data || r1).id;
  const r2 = await post("/api/conversations", { kind: "dm", memberIds: [peer] });
  const c2 = (r2.data || r2).id;
  console.log("create #1 ->", c1);
  console.log("create #2 ->", c2);
  console.log(c1 && c1 === c2 ? "RESULT: no duplicate (same id) ✓" : "RESULT: DUPLICATE created ✗");

  // count DMs with this peer now
  const after = await get("/api/conversations");
  const dups = after.filter((c) => c.kind === "dm" && (c.members || []).includes(peer) && c.members.length === 2);
  console.log("DMs with this peer now:", dups.length, dups.map((d) => d.id));
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
