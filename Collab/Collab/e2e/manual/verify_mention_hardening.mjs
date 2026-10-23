// Hardening checks on the new id-based mention path.
//  1. A client CANNOT ping a non-member by claiming their id (server filters to
//     real conversation members).
//  2. An ENCRYPTED mention notification stores NO plaintext excerpt.
//  3. Mentions work in a DM and a CHANNEL, not just a group.
//  4. Self-mention never notifies the sender.
import { createRequire } from "module";
const require = createRequire("C:/Users/Aravinth K P/Downloads/agen-x projects/Collab/package.json");
const { io } = require("socket.io-client");

const BASE = process.env.BASE || "http://localhost:3003";
const SOCK = process.env.SOCK || "http://localhost:4000";
const ts = Date.now();
const PW = "Passw0rd!123";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + "  " + e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (m, p, t, b) => {
  const res = await fetch(BASE + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, j };
};
const mk = async (slug, name) => {
  const email = `hd-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};
const mentions = async (u) => {
  const r = await call("GET", "/api/notifications", u.tok);
  return (r.j?.data || []).filter((n) => n && n.type === "mention");
};

const me      = await mk("me", "Hd Sender");
const member  = await mk("mm", "Hd Member");
const outsider= await mk("out", "Hd Outsider");   // NOT in the conversation
ok("signup", [me, member, outsider].every((u) => u.tok && u.id));
if (fail) process.exit(1);
for (const p of [member, outsider]) {
  const inv = await call("POST", "/api/invites", me.tok, { toUserId: p.id });
  if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, p.tok, {});
}
const grp = await call("POST", "/api/conversations", me.tok, { kind: "group", title: `Hg${ts}`, memberIds: [member.id] });
const dm  = await call("POST", "/api/conversations", me.tok, { kind: "dm", memberIds: [member.id] });
const chn = await call("POST", "/api/conversations", me.tok, { kind: "channel", title: `Hc${ts}`, memberIds: [member.id] });
const gid = grp.j?.data?.id, did = dm.j?.data?.id, cid = chn.j?.data?.id;
ok("group+dm+channel created", !!(gid && did && cid));

// Talk to the socket directly so we can craft the payload (that is exactly the
// threat model: a malicious/buggy client choosing its own mentionUserIds).
const sock = io(SOCK, { auth: { token: me.tok }, transports: ["websocket"] });
await new Promise((res, rej) => {
  sock.on("connect", res);
  sock.on("connect_error", rej);
  setTimeout(() => rej(new Error("socket timeout")), 15000);
});
ok("sender socket connected", sock.connected);

const bOut = (await mentions(outsider)).length;
const bMem = (await mentions(member)).length;
const bMe  = (await mentions(me)).length;

// 1 + 4: claim the OUTSIDER's id and my OWN id on a group message.
sock.emit("message:send", {
  conversationId: gid,
  text: "<p>ping <span class=\"mention\" data-user-id=\"" + outsider.id + "\">@Hd Outsider</span></p>",
  mentionUserIds: [outsider.id, me.id],
});
await sleep(4000);
ok("a non-member CANNOT be mentioned into a conversation",
   (await mentions(outsider)).length - bOut === 0,
   "outsider got notified — membership filter failed");
ok("sender is never self-notified", (await mentions(me)).length - bMe === 0);

// 2: an ENCRYPTED mention must carry NO plaintext excerpt.
sock.emit("message:send", {
  conversationId: gid,
  encrypted: [{ recipientId: member.id, recipientDeviceId: "d1", body: "ZmFrZQ==" }],
  mentionUserIds: [member.id],
});
await sleep(4000);
const memNotifs = await mentions(member);
const gained = memNotifs.length - bMem;
ok("member IS mentioned on an encrypted message", gained >= 1, `gained ${gained}`);
const newest = memNotifs[0];
console.log("  [diag] newest mention notif:", JSON.stringify({ title: newest?.title, body: newest?.body }));
ok("encrypted mention stores NO plaintext excerpt",
   !newest?.body, `body was ${JSON.stringify(newest?.body)}`);

// 3: DM + CHANNEL.
for (const [label, conv] of [["DM", did], ["channel", cid]]) {
  const before = (await mentions(member)).length;
  sock.emit("message:send", {
    conversationId: conv,
    encrypted: [{ recipientId: member.id, recipientDeviceId: "d1", body: "ZmFrZQ==" }],
    mentionUserIds: [member.id],
  });
  await sleep(3500);
  ok(`mention delivered in a ${label}`, (await mentions(member)).length - before === 1);
}

sock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
