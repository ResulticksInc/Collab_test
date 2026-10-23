// #1/#8: validate the messaging matrix end-to-end (two users, HTTP send path).
// Text, Text→Reply, Voice, Voice→Voice reply, File, File→Reply — each must
// persist with the right type and threading.
const jwt = require("jsonwebtoken");
const fs = require("fs");
require("dotenv").config();
const BASE = "http://localhost:4000";
const DM = "fb89ae13-c255-498b-83fc-d2e262378bc3";
const tok = (u) => jwt.sign({ sub: u, userId: u }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
const H = (u) => ({ Authorization: "Bearer " + tok(u), "Content-Type": "application/json" });

async function sendMsg(u, body) {
  const r = await fetch(`${BASE}/api/conversations/${DM}/messages`, { method: "POST", headers: H(u), body: JSON.stringify(body) });
  const j = await r.json();
  return { status: r.status, msg: j.data || j };
}
async function upload(u, mime, name) {
  const bytes = fs.readFileSync("scripts/test_tone.wav");
  const qs = new URLSearchParams({ name, mime, conversationId: DM });
  const r = await fetch(`${BASE}/api/files?${qs}`, { method: "POST", headers: { "Content-Type": mime, Authorization: "Bearer " + tok(u) }, body: bytes });
  return (await r.json()).data;
}

(async () => {
  const results = [];
  const check = (label, cond, detail) => { results.push(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`); };

  // 1) Text → Text reply (emily)
  const t1 = await sendMsg("u_emily", { text: "matrix text 1" });
  check("Text send", t1.status === 201 && t1.msg.type === "text", `status ${t1.status}, type ${t1.msg.type}`);
  const t2 = await sendMsg("u_marcus", { text: "matrix reply", parentMessageId: t1.msg.id });
  check("Text → Reply (threaded)", t2.status === 201 && t2.msg.parentMessageId === t1.msg.id, `parent ${t2.msg.parentMessageId === t1.msg.id}`);

  // 2) Voice (marcus) + Voice→Voice reply (emily)
  const vf = await upload("u_marcus", "audio/wav", "Voice Message.wav");
  const v1 = await sendMsg("u_marcus", { type: "voice", voice: { fileId: vf.id, duration: 4, mimeType: "audio/wav" }, file: vf });
  check("Voice send", v1.status === 201 && v1.msg.type === "voice", `type ${v1.msg.type}, dur ${v1.msg.voice && v1.msg.voice.duration}`);
  const vf2 = await upload("u_emily", "audio/wav", "Voice Message.wav");
  const v2 = await sendMsg("u_emily", { type: "voice", voice: { fileId: vf2.id, duration: 3, mimeType: "audio/wav" }, file: vf2, parentMessageId: v1.msg.id });
  check("Voice → Voice reply (threaded)", v2.status === 201 && v2.msg.type === "voice" && v2.msg.parentMessageId === v1.msg.id, `type ${v2.msg.type}, parent ${v2.msg.parentMessageId === v1.msg.id}`);

  // 3) File + File→Reply
  const ff = await upload("u_marcus", "application/pdf", "doc.pdf");
  const f1 = await sendMsg("u_marcus", { file: ff });
  check("File send", f1.status === 201 && !!f1.msg.file, `file ${!!f1.msg.file}`);
  const f2 = await sendMsg("u_emily", { text: "re: your file", parentMessageId: f1.msg.id });
  check("File → Reply (threaded)", f2.status === 201 && f2.msg.parentMessageId === f1.msg.id, `parent ${f2.msg.parentMessageId === f1.msg.id}`);

  // 4) Multi-user read-back: both see all messages
  const eView = (await (await fetch(`${BASE}/api/conversations/${DM}/messages?limit=200`, { headers: H("u_emily") })).json()).data;
  const mView = (await (await fetch(`${BASE}/api/conversations/${DM}/messages?limit=200`, { headers: H("u_marcus") })).json()).data;
  check("Multi-user: both see same history", eView.length === mView.length && eView.length > 0, `emily ${eView.length}, marcus ${mView.length}`);

  console.log(results.join("\n"));
  console.log(results.every((r) => r.startsWith("✓")) ? "\nRESULT: messaging matrix ALL PASS ✓" : "\nRESULT: some checks FAILED ✗");
  process.exit(0);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
