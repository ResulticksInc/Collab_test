// Orphan date separator ("Monday 24 Aug" with NOTHING under it). Root cause:
// date pills were computed over the RAW message list, but some rows render as
// null — most commonly an ended/expired meeting-invite card, which the client
// suppresses from the stream. A day whose only occupant is suppressed left a
// bare date pill. Fix: separators + grouping run over the VISIBLE rows only.
// Needs the frontend+backend rig AND direct DB access (MYSQL via docker exec,
// container colab-test-mysql) to plant a backdated expired invite.
import { execSync } from "node:child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.BASE || "http://localhost:3002";
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
  const email = `odp-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const alice = await mk("a", "Pill Alice");
const bob = await mk("b", "Pill Bob");
ok("signup", !!alice.tok && !!bob.tok);
if (fail) process.exit(1);
const inv = await call("POST", "/api/invites", alice.tok, { toUserId: bob.id });
if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, bob.tok, {});
const conv = await call("POST", "/api/conversations", alice.tok, { kind: "dm", memberIds: [bob.id] });
const cid = conv.j?.data?.conversation?.id || conv.j?.data?.id;

// Plant history: an EXPIRED meeting-invite card as the ONLY row on Aug 24, and
// a normal message on Aug 28 (both backdated — the API can't do that).
const sql = (q) => execSync(
  `docker exec colab-test-mysql mysql -uroot -pcolab colab -e ${JSON.stringify(q)}`,
  { stdio: ["ignore", "pipe", "pipe"] },
).toString();
const invitePayload = JSON.stringify({ meetingId: "odp-meeting-" + ts, title: "Old standup", startsAt: "2026-08-24T09:00:00.000Z", durationMin: 30 }).replace(/"/g, '\\"');
sql(`INSERT INTO messages (id,conversation_id,sender_id,body,type,created_at) VALUES ('odp-inv-${ts}','${cid}','${bob.id}',"${invitePayload}",'meeting_invite','2026-08-24 09:00:00');`);
sql(`INSERT INTO messages (id,conversation_id,sender_id,body,type,created_at) VALUES ('odp-msg-${ts}','${cid}','${bob.id}','seen on friday','text','2026-08-28 10:00:00');`);
ok("history planted (expired invite Mon 24 Aug, message Fri 28 Aug)", true);

const browser = await chromium.launch({ headless: false, args: ["--hide-crash-restore-bubble"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
await page.goto(BASE + "/");
await page.fill('input[type="email"]', alice.email);
await page.fill('input[type="password"]', PW);
await page.keyboard.press("Enter");
try {
  const skip = page.locator('button:has-text("Continue without an organization")');
  await skip.waitFor({ state: "visible", timeout: 12000 }); await skip.click();
} catch {}
await page.waitForSelector("#rail", { timeout: 60000 });
await page.goto(`${BASE}/?conversation=${encodeURIComponent(cid)}`);
await page.waitForSelector('[id^="msg-"]', { timeout: 45000 });
await sleep(2000);

const scan = await page.evaluate(() => {
  const pills = Array.from(document.querySelectorAll(".date-div")).map((d) => (d.textContent || "").trim());
  // An ORPHAN pill = a .date-div whose next element siblings reach another
  // .date-div (or nothing) without any message row in between.
  const orphans = [];
  for (const d of Array.from(document.querySelectorAll(".date-div"))) {
    let el = d.nextElementSibling; let fed = false;
    while (el && !el.classList.contains("date-div")) {
      if (el.id && el.id.startsWith("msg-")) { fed = true; break; }
      el = el.nextElementSibling;
    }
    if (!fed) orphans.push((d.textContent || "").trim());
  }
  return { pills, orphans };
});
ok("no ORPHAN date pill (every pill has content under it)", scan.orphans.length === 0, JSON.stringify(scan));
ok("the suppressed-invite day shows NO pill at all", !scan.pills.some((p) => /24/.test(p)), JSON.stringify(scan.pills));
ok("the real message's day still shows its pill", scan.pills.some((p) => /28|Friday/.test(p)), JSON.stringify(scan.pills));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
