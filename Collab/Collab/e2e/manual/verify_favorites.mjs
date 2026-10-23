// File favorites (the "favourites are not stable" report). Root cause: a
// single GLOBAL files.starred flag + an owner-only setStar gate — starring
// your own uploads worked, starring a file shared WITH you 404'd and the
// optimistic star silently reverted, and one member's star leaked into every
// member's Favorites tab. Fix (migration 0114): per-user file_stars rows,
// access-gated. Pure REST; BASE = backend directly.
const BASE = process.env.BASE || "http://localhost:4010";
const ts = Date.now();
const PW = "Passw0rd!123";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + "  " + e); } };
const call = async (m, p, t, b) => {
  const res = await fetch(BASE + p, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, j };
};
const mk = async (slug, name) => {
  const email = `fav-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const alice = await mk("a", "Fav Alice");
const bob = await mk("b", "Fav Bob");
const eve = await mk("e", "Fav Eve"); // no access to the file at all
ok("signup x3", !!alice.tok && !!bob.tok && !!eve.tok);
if (fail) process.exit(1);
const inv = await call("POST", "/api/invites", alice.tok, { toUserId: bob.id });
if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, bob.tok, {});
const conv = await call("POST", "/api/conversations", alice.tok, { kind: "dm", memberIds: [bob.id] });
const cid = conv.j?.data?.conversation?.id || conv.j?.data?.id;

// Alice uploads a file INTO the DM (Bob gets access as a conversation member).
const up = await fetch(`${BASE}/api/files?name=notes.txt&conversationId=${cid}`, {
  method: "POST",
  headers: { "Content-Type": "text/plain", Authorization: "Bearer " + alice.tok },
  body: Buffer.from("favorite me"),
}).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
const fid = up.j?.data?.id;
ok("file uploaded into the DM", up.status < 300 && !!fid, JSON.stringify(up.j).slice(0, 120));
if (!fid) process.exit(1);
await call("POST", `/api/conversations/${cid}/messages`, alice.tok, { text: "here you go", file: up.j.data });
// Explicitly SHARE the file with Bob — the Files app's accessible set is
// deliberately explicit shares (chat attachments stay in-chat), and the star
// control lives in the Files app.
const sh = await call("POST", `/api/files/${fid}/share`, alice.tok, { subjectType: "user", subjectId: bob.id, permission: "view" });
ok("file shared with the member", sh.status < 300, JSON.stringify(sh.j).slice(0, 100));

const star = (u, starred) => call("POST", `/api/files/${fid}/star`, u.tok, { starred });
const favList = async (u) => (await call("GET", "/api/files?tab=starred", u.tok)).j?.data?.files
  ?? (await call("GET", "/api/files?tab=starred", u.tok)).j?.data ?? [];

// ── The reported bug: a member starring a SHARED file ───────────────────────
const bobStar = await star(bob, true);
ok("ROOT CAUSE FIXED: member can favorite a file shared with them", bobStar.status === 200 && bobStar.j?.data?.starred === true, `status=${bobStar.status} ${JSON.stringify(bobStar.j).slice(0, 100)}`);
ok("member's Favorites tab lists it", (await favList(bob)).some((f) => f.id === fid));

// ── Per-user isolation: Bob's star is not Alice's ───────────────────────────
ok("uploader's Favorites tab is NOT polluted by the member's star", !(await favList(alice)).some((f) => f.id === fid));
const aliceStar = await star(alice, true);
ok("uploader stars the same file independently", aliceStar.status === 200 && aliceStar.j?.data?.starred === true);
const bobUnstar = await star(bob, false);
ok("member un-stars: their view flips off", bobUnstar.j?.data?.starred === false);
ok("…without touching the uploader's star", (await favList(alice)).some((f) => f.id === fid));
ok("…and the member's tab is empty again", !(await favList(bob)).some((f) => f.id === fid));

// ── Access is still enforced ────────────────────────────────────────────────
const eveStar = await star(eve, true);
ok("no access → no star (404)", eveStar.status === 404, `status=${eveStar.status}`);

// ── The list rows report the VIEWER's star state ────────────────────────────
const aliceAll = (await call("GET", "/api/files?tab=all", alice.tok)).j?.data;
const aliceRow = (aliceAll?.files ?? aliceAll ?? []).find((f) => f.id === fid);
const bobAll = (await call("GET", "/api/files?tab=all", bob.tok)).j?.data;
const bobRow = (bobAll?.files ?? bobAll ?? []).find((f) => f.id === fid);
ok("row.starred is per-viewer (alice on, bob off)", aliceRow?.starred === true && bobRow?.starred === false, JSON.stringify({ a: aliceRow?.starred, b: bobRow?.starred }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
