// §11 Q4 / MCHAT-21: an UNINVITED link-joiner's view of the meeting chat.
// Default MEETING_LINK_JOINER_HISTORY=joinpoint — the joiner reads from their
// join forward (a per-member history cutoff, enforced at read time); invited
// members keep the full thread. Pure REST. BASE = backend directly.
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
  const email = `lj-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const host = await mk("host", "LJ Host");
const invitee = await mk("inv", "LJ Invitee");
const joiner = await mk("join", "LJ LinkJoiner"); // never invited
ok("signup x3", !!host.tok && !!invitee.tok && !!joiner.tok);
if (fail) process.exit(1);
const inv = await call("POST", "/api/invites", host.tok, { toUserId: invitee.id });
if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, invitee.tok, {});

const mtg = await call("POST", "/api/meetings", host.tok, {
  title: `History policy ${ts}`,
  startsAt: new Date(Date.now() + 90_000).toISOString(),
  durationMin: 60,
  attendees: [invitee.id],
});
const mid = mtg.j?.data?.id;
const gid = mtg.j?.data?.meetingGroup?.id;
ok("meeting + chat scheduled", !!mid && !!gid);
if (fail) process.exit(1);

// Pre-meeting chatter the link-joiner must NOT see under the default policy.
await call("POST", `/api/conversations/${gid}/messages`, invitee.tok, { text: "secret pre-join agenda" });
await sleep(400);

// Host + the uninvited joiner enter the room (the joiner gains membership here).
await call("POST", `/api/meetings/${mid}/room/enter`, host.tok, {});
await call("POST", `/api/meetings/${mid}/room/enter`, joiner.tok, {});
await sleep(1200);
ok("MCHAT-21 link-joiner became a chat member",
  ((await call("GET", "/api/conversations", joiner.tok)).j?.data || []).some((c) => c.id === gid));

// Post-join chatter everyone should see.
await call("POST", `/api/conversations/${gid}/messages`, invitee.tok, { text: "after-join discussion" });
await sleep(400);

const textsFor = async (u) =>
  ((await call("GET", `/api/conversations/${gid}/messages`, u.tok)).j?.data || []).map((m) => m.text || "");
const joinerView = await textsFor(joiner);
const inviteeView = await textsFor(invitee);

ok("Q4 default: joiner does NOT see pre-join history",
  !joinerView.some((t) => /secret pre-join agenda/.test(t)),
  JSON.stringify(joinerView.slice(0, 6)));
ok("Q4 default: joiner sees everything from their join forward",
  joinerView.some((t) => /after-join discussion/.test(t)));
ok("invited member keeps the FULL thread",
  inviteeView.some((t) => /secret pre-join agenda/.test(t)) &&
  inviteeView.some((t) => /after-join discussion/.test(t)));

// The joiner can also post (membership is real, only history is scoped).
const post = await call("POST", `/api/conversations/${gid}/messages`, joiner.tok, { text: "hello from the link joiner" });
ok("joiner can post into the thread", !!post.j?.ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
