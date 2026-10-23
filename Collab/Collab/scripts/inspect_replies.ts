// Evidence-gathering: pull every conversation's messages from the LOCAL backend
// API and report the real threading state — focusing on voice messages and any
// message carrying parentMessageId. No assumptions; prints what the API returns.
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";
const userId = process.argv[2] || "u_kp_aravinth_resulticksmail_com";
const secret = process.env.AUTH_JWT_SECRET!;
const token = jwt.sign({ sub: userId, userId }, secret, { expiresIn: "1d" });

async function get(path: string) {
  const r = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j: any = await r.json();
  return j.data ?? j;
}

(async () => {
  const convs = await get("/api/conversations");
  console.log(`viewer=${userId}  conversations=${convs.length}\n`);
  for (const c of convs) {
    const msgs = await get(`/api/conversations/${c.id}/messages?limit=200`);
    const byId: Record<string, any> = {};
    for (const m of msgs) byId[m.id] = m;
    const voices = msgs.filter((m: any) => m.type === "voice");
    const replies = msgs.filter((m: any) => m.parentMessageId);
    if (!voices.length && !replies.length) continue;
    console.log(`### conv ${c.id} (${c.kind}) "${c.name}" — ${msgs.length} msgs, ${voices.length} voice, ${replies.length} replies`);
    for (const m of msgs) {
      if (m.type !== "voice" && !m.parentMessageId) continue;
      const parent = m.parentMessageId ? byId[m.parentMessageId] : null;
      const ptype = parent ? parent.type : m.parentMessageId ? "(parent NOT in window)" : "—";
      const combo = m.parentMessageId
        ? `${parent ? parent.type : "?"}→${m.type}`
        : `(no parent) ${m.type}`;
      console.log(
        `  msg=${m.id.slice(0, 8)} type=${m.type} parent=${m.parentMessageId ? m.parentMessageId.slice(0, 8) : "null"} parentType=${ptype} createdAt=${m.createdAt}  [${combo}]`,
      );
    }
    console.log("");
  }
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
