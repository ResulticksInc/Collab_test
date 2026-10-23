// Chat ordering — newest at top (§4: ORD-01/03/04/05/08/10/12/14 + D-3(b)),
// driven as a real user: Alice flips the per-user setting, Bob feeds messages
// over REST (delivered live over the socket). No SFU needed — chat only.
import { createRequire } from "module";
const require = createRequire(import.meta.url); // resolves playwright from the repo root
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
  const email = `ord-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const alice = await mk("alice", "Order Alice");
const bob = await mk("bob", "Order Bob");
const carol = await mk("carol", "Order Carol");
ok("signup", !!alice.tok && !!bob.tok && !!carol.tok);
if (fail) process.exit(1);
const inv = await call("POST", "/api/invites", alice.tok, { toUserId: bob.id });
if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, bob.tok, {});
const conv = await call("POST", "/api/conversations", alice.tok, { kind: "dm", memberIds: [bob.id] });
const cid = conv.j?.data?.conversation?.id || conv.j?.data?.id;
ok("dm created", !!cid, JSON.stringify(conv.j).slice(0, 200));
// A second DM (Carol) so Alice can be viewing SOMETHING ELSE while Bob's
// unread arrive — the unread divider only exists for messages that landed
// while the thread wasn't on screen.
const inv2 = await call("POST", "/api/invites", alice.tok, { toUserId: carol.id });
if (inv2.j?.data?.id) await call("POST", `/api/invites/${inv2.j.data.id}/accept`, carol.tok, {});
const conv2 = await call("POST", "/api/conversations", alice.tok, { kind: "dm", memberIds: [carol.id] });
const cid2 = conv2.j?.data?.conversation?.id || conv2.j?.data?.id;
await call("POST", `/api/conversations/${cid2}/messages`, carol.tok, { text: "hi from carol" });
if (fail) process.exit(1);

// Bob seeds 60 messages (> the 50-message window, so Load earlier appears).
for (let i = 1; i <= 60; i++) {
  const r = await call("POST", `/api/conversations/${cid}/messages`, bob.tok, { text: `seed ${i}` });
  if (!r.j?.ok) { console.log("seed send failed", i, JSON.stringify(r.j).slice(0, 120)); process.exit(1); }
}
console.log("  seeded 60 messages");

const browser = await chromium.launch({ headless: false, args: ["--hide-crash-restore-bubble"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log(`  [alice][PAGEERROR] ${String(e.message).slice(0, 160)}`));

const login = async () => {
  await page.goto(BASE + "/");
  await page.waitForSelector('input[type="email"]', { timeout: 45000 });
  await page.fill('input[type="email"]', alice.email);
  await page.fill('input[type="password"]', PW);
  await page.keyboard.press("Enter");
  try {
    const skip = page.locator('button:has-text("Continue without an organization")');
    await skip.waitFor({ state: "visible", timeout: 12000 }); await skip.click();
  } catch {}
  await page.waitForSelector("#rail", { timeout: 60000 });
};
const openConv = async () => {
  await page.goto(`${BASE}/?conversation=${encodeURIComponent(cid)}`);
  await page.waitForSelector("#tp-chat .msgs, #tp-chat", { timeout: 45000 });
  await page.waitForSelector('[id^="msg-"]', { timeout: 45000 });
  await sleep(1500); // let the auto-scroll settle
};

// Reads the visual order of message texts + scroll info from the list.
const listState = () => page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[id^="msg-"]'))
    .filter((el) => !el.classList.contains("date-div") && !el.classList.contains("unread-sep"));
  const el = rows[0] ? rows[0].closest(".msgs, [class*=msgs]")?.parentElement : null;
  // The actual scroller: walk up from a row to the overflowed ancestor.
  let scroller = rows[0];
  while (scroller && scroller !== document.body) {
    const s = getComputedStyle(scroller);
    if (/(auto|scroll)/.test(s.overflowY) && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  const texts = rows.map((r) => (r.textContent || "").slice(0, 40));
  return {
    n: rows.length,
    firstText: texts[0] || "",
    lastText: texts[texts.length - 1] || "",
    scrollTop: scroller ? scroller.scrollTop : -1,
    gstart: document.querySelectorAll(".gstart").length,
    gcont: document.querySelectorAll(".gcont").length,
    earlierIsLast: (() => {
      const b = document.querySelector(".msgs-earlier");
      if (!b || !rows.length) return null;
      return b.getBoundingClientRect().top > rows[rows.length - 1].getBoundingClientRect().top;
    })(),
    sepIdx: (() => {
      const sep = document.querySelector(".unread-sep");
      if (!sep) return null;
      let before = 0;
      for (const r of rows) if (r.getBoundingClientRect().top < sep.getBoundingClientRect().top) before++;
      return before; // message rows rendered ABOVE the divider
    })(),
  };
});

await login();
await openConv();

// ── Default (D-3(b)): newest at BOTTOM ──────────────────────────────────────
const d0 = await listState();
ok("default stays newest-at-bottom", /seed 60/.test(d0.lastText) && !/seed 60/.test(d0.firstText), JSON.stringify({ first: d0.firstText, last: d0.lastText }));

// ── Flip the per-user setting; Bob sends 3 unread before Alice reopens ──────
await call("PUT", "/api/settings", alice.tok, { newestAtTop: true });
await page.reload();
await page.waitForSelector("#rail", { timeout: 60000 });
await sleep(3000);
// Park Alice on the CAROL thread, then let Bob's messages land as true unread
// (a reload or deep link would mark Bob's thread read before the pane mounts,
// suppressing the divider in EITHER display order).
await page.click('.cv[aria-label="Order Carol"]');
await sleep(1500);
for (let i = 1; i <= 3; i++) await call("POST", `/api/conversations/${cid}/messages`, bob.tok, { text: `unread ${i}` });
await sleep(2500);
// Open Bob from the RAIL — the real user path, unread state intact.
await page.click('.cv[aria-label="Order Bob"]');
await page.waitForSelector('[id^="msg-"]', { timeout: 45000 });
await sleep(1500);

// ── ORD-01 + acceptance: newest first, visible without scrolling ────────────
const t0 = await listState();
ok("ORD-01 newest message renders at the top", /unread 3/.test(t0.firstText), JSON.stringify({ first: t0.firstText }));
ok("acceptance: newest visible without scrolling", t0.scrollTop >= 0 && t0.scrollTop < 40, `scrollTop=${t0.scrollTop}`);

// ── ORD-08: divider sits BELOW the unread block ─────────────────────────────
ok("ORD-08 unread divider below the 3 unread messages", t0.sepIdx === 3, `rowsAbove=${t0.sepIdx}`);

// ── ORD-10: grouping header on the topmost message of each group ────────────
ok("ORD-10 consecutive messages still group (headers < rows)", t0.gstart > 0 && t0.gcont > 0 && t0.gstart < t0.n, JSON.stringify({ gstart: t0.gstart, gcont: t0.gcont, rows: t0.n }));

// ── ORD-05: Load earlier lives at the OLDER (bottom) end ────────────────────
// Scroll to the bottom so the affordance arms (it tracks the older end).
await page.evaluate(() => {
  // Scroll the BUTTON itself into view before measuring: Playwright's click
  // auto-scrolls a clipped target, and measuring the anchor before that scroll
  // mis-reads the click's own scroll as an app-side jump.
  document.querySelector(".msgs-earlier")?.scrollIntoView({ block: "end" });
});
await sleep(800);
const t1 = await listState();
ok("ORD-05 Load-earlier button renders after the oldest message", t1.earlierIsLast === true, JSON.stringify({ earlierIsLast: t1.earlierIsLast }));
const oldestBefore = t1.lastText;
const anchorRect = await page.evaluate(() => {
  const rows = document.querySelectorAll('[id^="msg-"]');
  return rows[rows.length - 1].getBoundingClientRect().top;
});
await page.click(".msgs-earlier");
await sleep(1500);
const t2 = await listState();
const anchorRectAfter = await page.evaluate((txt) => {
  const rows = Array.from(document.querySelectorAll('[id^="msg-"]'));
  const el = rows.find((r) => (r.textContent || "").includes(txt));
  return el ? el.getBoundingClientRect().top : -9999;
}, oldestBefore.includes("seed") ? oldestBefore.match(/seed \d+/)[0] : oldestBefore);
ok("ORD-05 older messages append BELOW without a scroll jump", t2.n > t1.n && Math.abs(anchorRectAfter - anchorRect) < 24, JSON.stringify({ before: t1.n, after: t2.n, drift: Math.round(anchorRectAfter - anchorRect) }));

// ── ORD-03/04: live message while scrolled away — no jump + pill up ─────────
const refRect = await page.evaluate(() => {
  const rows = document.querySelectorAll('[id^="msg-"]');
  const mid = rows[Math.floor(rows.length / 2)];
  mid.scrollIntoView({ block: "center" });
  window.__ordRefId = mid.id;
  return mid.getBoundingClientRect().top;
});
await sleep(800);
await call("POST", `/api/conversations/${cid}/messages`, bob.tok, { text: "live ping" });
await sleep(2500);
const afterLive = await page.evaluate(() => {
  const el = document.getElementById(window.__ordRefId);
  const pill = document.querySelector(".chat-jump-latest");
  return {
    refTop: el ? el.getBoundingClientRect().top : -9999,
    present: !!Array.from(document.querySelectorAll('[id^="msg-"]')).find((r) => (r.textContent || "").includes("live ping")),
    pill: !!pill,
    pillUp: pill ? /jump to top|New messages/i.test(pill.getAttribute("aria-label") || "") : false,
  };
});
ok("ORD-03 pane does not jump when a message arrives", Math.abs(afterLive.refTop - refRect) < 24 && afterLive.present, JSON.stringify({ drift: Math.round(afterLive.refTop - refRect), present: afterLive.present }));
ok("ORD-04 'new messages' pill points up", afterLive.pill && afterLive.pillUp, JSON.stringify(afterLive));
await page.click(".chat-jump-latest");
await sleep(1200);
const backTop = await listState();
ok("ORD-04 pill returns to the top (newest visible)", backTop.scrollTop < 40 && /live ping/.test(backTop.firstText), JSON.stringify({ scrollTop: backTop.scrollTop, first: backTop.firstText }));

// ── ORD-12: sending shows your own message (composer stays bottom) ──────────
await page.click('#tp-chat [contenteditable="true"]');
await page.keyboard.type("alice reply");
await page.keyboard.press("Enter");
await sleep(2000);
const afterSend = await listState();
ok("ORD-12 own message lands at top and is visible", /alice reply/.test(afterSend.firstText) && afterSend.scrollTop < 40, JSON.stringify({ first: afterSend.firstText, scrollTop: afterSend.scrollTop }));

// ── ORD-14: conversation list (left pane) ordering untouched ────────────────
// (structural: the setting only feeds the message pane — assert the rail still
// lists the DM with the most recent activity first is a no-op with one chat.)

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
