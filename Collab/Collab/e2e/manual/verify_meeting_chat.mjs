// Meeting-linked group chat end-to-end (§5: MCHAT-01/03/04/05/10/12/20/21).
// Pure REST + socket — no browser, no SFU: schedule a meeting, chat before it
// starts, enter the room over the presence API, send in-meeting chat over the
// socket, end the meeting — asserting the ONE persistent group thread the whole
// way. BASE points at the BACKEND directly (default http://localhost:4010).
import { createRequire } from "module";
const require = createRequire(import.meta.url); // resolves deps from the repo root
const { io } = require("socket.io-client");

const BASE = process.env.BASE || "http://localhost:4010";
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
  const email = `mc-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const host = await mk("host", "Chat Host");
const invitee = await mk("inv", "Chat Invitee"); // invited, never attends
const joiner = await mk("join", "Chat Joiner"); // attends, never invited
const late = await mk("late", "Chat LateAdd"); // invited mid-flight
ok("signup x4", !!host.tok && !!invitee.tok && !!joiner.tok && !!late.tok);
if (fail) process.exit(1);
for (const u of [invitee, joiner, late]) {
  const inv = await call("POST", "/api/invites", host.tok, { toUserId: u.id });
  if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, u.tok, {});
}

// ── MCHAT-01/20: scheduling creates the chat, invitees are members ──────────
const mtg = await call("POST", "/api/meetings", host.tok, {
  title: `Sprint planning ${ts}`,
  startsAt: new Date(Date.now() + 90_000).toISOString(),
  durationMin: 60,
  attendees: [invitee.id],
});
const mid = mtg.j?.data?.id;
const grp = mtg.j?.data?.meetingGroup;
ok("MCHAT-01 chat created at scheduling", !!mid && !!grp?.id, JSON.stringify(mtg.j?.data?.meetingGroup || {}));
const gid = grp?.id;
if (!gid) process.exit(1);
ok("MCHAT-20 invitee is a member from scheduling", (grp.memberIds || []).includes(invitee.id));

const convsOf = async (u) => (await call("GET", "/api/conversations", u.tok)).j?.data || [];
const inList = (list, id) => (list || []).find((c) => c && c.id === id);
const invConv = inList(await convsOf(invitee), gid);
ok("MCHAT-01 invitee sees the chat BEFORE the meeting", !!invConv, JSON.stringify((await convsOf(invitee)).map((c) => c.id)).slice(0, 120));
ok("MCHAT-03 chat named from the meeting subject", /Sprint planning/.test(invConv?.title || invConv?.name || ""), `title=${invConv?.title || invConv?.name}`);
ok("MCHAT-04 chat is persistent (not a temp group)", !(invConv?.temporary === true), `temporary=${invConv?.temporary}`);

const pre = await call("POST", `/api/conversations/${gid}/messages`, invitee.tok, { text: "agenda item from the invitee" });
ok("MCHAT-20 invitee can post before the meeting starts", !!pre.j?.ok, JSON.stringify(pre.j).slice(0, 120));

// ── Meeting goes live: host + an UNINVITED link joiner enter the room ───────
await call("POST", `/api/meetings/${mid}/room/enter`, host.tok, {});
await call("POST", `/api/meetings/${mid}/room/enter`, joiner.tok, {});
await sleep(1500);
const msgsOf = async (u) => (await call("GET", `/api/conversations/${gid}/messages`, u.tok)).j?.data || [];
const afterStart = await msgsOf(host);
const divider = (afterStart || []).find((m) => m.type === "session_divider" && /Sprint planning/.test(m.text || m.body || ""));
ok("MCHAT-05 occurrence divider posted at session start", !!divider, JSON.stringify((afterStart || []).map((m) => m.type)).slice(0, 160));
ok("MCHAT-21 uninvited link joiner became a chat member", !!inList(await convsOf(joiner), gid));

// ── MCHAT-10: in-meeting chat mirrors into the group LIVE ───────────────────
const sock = io(BASE, { auth: { token: host.tok }, transports: ["websocket"] });
await new Promise((res, rej) => { sock.on("connect", res); sock.on("connect_error", rej); setTimeout(() => rej(new Error("socket timeout")), 10000); });
sock.emit("meeting:chat:send", { meetingId: mid, text: "hello from inside the meeting" });
await sleep(2000);
const liveSeen = (await msgsOf(invitee)).filter((m) => /hello from inside the meeting/.test(m.text || m.body || ""));
ok("MCHAT-10 in-meeting message reaches the chat-list thread LIVE", liveSeen.length === 1, `copies=${liveSeen.length}`);

// ── End the meeting: no duplicates, trace posted, chat persists ─────────────
await call("POST", `/api/meetings/${mid}/complete`, host.tok, {});
await sleep(1500);
const afterEnd = await msgsOf(invitee);
const copies = (afterEnd || []).filter((m) => /hello from inside the meeting/.test(m.text || m.body || ""));
ok("end-of-meeting back-fill does not duplicate mirrored lines", copies.length === 1, `copies=${copies.length}`);
ok("MCHAT-12 'Meeting ended' system trace in the chat", (afterEnd || []).some((m) => /Meeting ended/.test(m.text || m.body || "")), JSON.stringify((afterEnd || []).map((m) => (m.text || "").slice(0, 24))).slice(0, 200));
const post = await call("POST", `/api/conversations/${gid}/messages`, invitee.tok, { text: "follow-up after the meeting" });
ok("MCHAT-04 chat still writable after the meeting ends", !!post.j?.ok);

// ── MCHAT-03: renaming the meeting renames the chat ─────────────────────────
await call("PATCH", `/api/meetings/${mid}`, host.tok, { title: `Sprint planning RENAMED ${ts}` });
await sleep(800);
const renamed = inList(await convsOf(invitee), gid);
ok("MCHAT-03 meeting rename renames the chat", /RENAMED/.test(renamed?.title || renamed?.name || ""), `title=${renamed?.title || renamed?.name}`);

// ── MCHAT-20: inviting someone mid-flight adds them to the chat ─────────────
await call("POST", `/api/meetings/${mid}/invite`, host.tok, { userId: late.id });
await sleep(800);
ok("MCHAT-20 late invitee gains chat membership", !!inList(await convsOf(late), gid));

sock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
