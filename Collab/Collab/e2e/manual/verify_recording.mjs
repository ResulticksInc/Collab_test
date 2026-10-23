// Meeting recording end-to-end (§6: REC-01/08/11/12/15 + access control).
// Pure REST — no browser, no SFU: the client-recording upload path stores a
// blob, lands in the meeting's recordings list, streams back to members only,
// is audit-logged at every touch, and the attendance report posts to the
// meeting chat at completion. BASE points at the BACKEND directly.
import { createRequire } from "module";
const require = createRequire(import.meta.url); // repo-root deps
void require; // (no runtime deps needed — kept for parity with sibling scripts)

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
  const email = `rec-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const host = await mk("host", "Rec Host");
const member = await mk("mem", "Rec Member");
const outsider = await mk("out", "Rec Outsider");
ok("signup x3", !!host.tok && !!member.tok && !!outsider.tok);
if (fail) process.exit(1);
const inv = await call("POST", "/api/invites", host.tok, { toUserId: member.id });
if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, member.tok, {});

const mtg = await call("POST", "/api/meetings", host.tok, {
  title: `Recording run ${ts}`,
  startsAt: new Date(Date.now() + 90_000).toISOString(),
  durationMin: 60,
  attendees: [member.id],
});
const mid = mtg.j?.data?.id;
const gid = mtg.j?.data?.meetingGroup?.id;
ok("meeting + chat scheduled", !!mid && !!gid);
if (fail) process.exit(1);

// Both enter the room (presence rows feed the attendance report).
await call("POST", `/api/meetings/${mid}/room/enter`, host.tok, {});
await call("POST", `/api/meetings/${mid}/room/enter`, member.tok, {});
await sleep(1200);

// A fake-but-nonempty webm payload (the upload path validates bytes, not codecs).
const blob = Buffer.alloc(64 * 1024, 7);
const upload = async (tok) =>
  fetch(`${BASE}/api/meetings/${mid}/recordings/upload?durationSec=95&mime=video/webm`, {
    method: "POST",
    headers: { "Content-Type": "video/webm", Authorization: "Bearer " + tok },
    body: blob,
  }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));

// ── REC-01: recording is host/co-host gated ─────────────────────────────────
const memUp = await upload(member.tok);
ok("REC-01 a plain member cannot save a recording", memUp.status === 403, `status=${memUp.status}`);
const up = await upload(host.tok);
const rid = up.j?.data?.id;
ok("host upload lands as a ready recording", up.status === 201 && up.j?.data?.status === "ready" && !!rid, JSON.stringify(up.j).slice(0, 140));
if (!rid) process.exit(1);

// ── list + access control ───────────────────────────────────────────────────
const memList = await call("GET", `/api/meetings/${mid}/recordings`, member.tok);
ok("member sees the recording in the list", (memList.j?.data || []).some((r) => r.id === rid));
const outList = await call("GET", `/api/meetings/${mid}/recordings`, outsider.tok);
ok("REC-11 outsider cannot list recordings", outList.status === 403, `status=${outList.status}`);

// ── REC-11/12: download for members only, denied for outsiders ─────────────
const dl = await fetch(`${BASE}/api/meetings/${mid}/recordings/${rid}/download`, { headers: { Authorization: "Bearer " + member.tok } });
const bytes = Buffer.from(await dl.arrayBuffer());
ok("member can stream the recording back", dl.status === 200 && bytes.length === blob.length, `status=${dl.status} bytes=${bytes.length}`);
const dlOut = await fetch(`${BASE}/api/meetings/${mid}/recordings/${rid}/download`, { headers: { Authorization: "Bearer " + outsider.tok } });
ok("REC-11 outsider download denied", dlOut.status === 403, `status=${dlOut.status}`);

// ── REC-12: the touches are audit-logged ────────────────────────────────────
await sleep(800); // audit writes are fire-and-forget
const hostAudit = (await call("GET", "/api/audit", host.tok)).j?.data || [];
ok("REC-11 upload audit-logged for the host", hostAudit.some((e) => e.action === "recording.upload" && e.targetId === rid), JSON.stringify(hostAudit.map((e) => e.action)).slice(0, 120));
const memAudit = (await call("GET", "/api/audit", member.tok)).j?.data || [];
ok("REC-12 download audit-logged for the member", memAudit.some((e) => e.action === "recording.download" && e.targetId === rid), JSON.stringify(memAudit.map((e) => e.action)).slice(0, 120));

// ── REC-15: attendance report posts to the meeting chat on completion ──────
await call("POST", `/api/meetings/${mid}/complete`, host.tok, {});
await sleep(1500);
const msgs = (await call("GET", `/api/conversations/${gid}/messages`, member.tok)).j?.data || [];
const report = msgs.find((m) => /Attendance report/.test(m.text || m.body || ""));
ok("REC-15 attendance report in the meeting chat", !!report);
ok("REC-15 report names both attendees", !!report && /Rec Host/.test(report.text || "") && /Rec Member/.test(report.text || ""), (report?.text || "").slice(0, 160));

// ── delete: host-only + audit-logged ────────────────────────────────────────
const memDel = await call("DELETE", `/api/meetings/${mid}/recordings/${rid}`, member.tok);
ok("member cannot delete a recording", memDel.status === 403, `status=${memDel.status}`);
await call("DELETE", `/api/meetings/${mid}/recordings/${rid}`, host.tok);
await sleep(800);
const afterDel = (await call("GET", `/api/meetings/${mid}/recordings`, host.tok)).j?.data || [];
ok("host delete removes the recording", !afterDel.some((r) => r.id === rid));
const hostAudit2 = (await call("GET", "/api/audit", host.tok)).j?.data || [];
ok("REC-11 delete audit-logged", hostAudit2.some((e) => e.action === "recording.delete" && e.targetId === rid));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
