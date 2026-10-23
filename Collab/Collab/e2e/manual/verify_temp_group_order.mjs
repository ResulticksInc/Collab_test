// "Group chats are still at the top" — an auto-created call temp group was
// hard-pinned above every chat (a temporary-first tier in the sidebar sort),
// so for its whole 7-day life no chat with NEWER activity could rise above it.
// Fix: the pin is gone; a fresh temp group tops the list by RECENCY only and
// then decays like any chat (ORD-14). Browser check: needs the frontend +
// backend rig; asserts the visual rail order.
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
  const email = `tgo-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const alice = await mk("a", "Order Alice");
const bob = await mk("b", "Order Bob");
ok("signup", !!alice.tok && !!bob.tok);
if (fail) process.exit(1);
const inv = await call("POST", "/api/invites", alice.tok, { toUserId: bob.id });
if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, bob.tok, {});
const conv = await call("POST", "/api/conversations", alice.tok, { kind: "dm", memberIds: [bob.id] });
const cid = conv.j?.data?.conversation?.id || conv.j?.data?.id;
await call("POST", `/api/conversations/${cid}/messages`, alice.tok, { text: "old dm message" });

// The auto-created call temp group (what a shared file/message mid-call mints).
const tg = await call("POST", "/api/conversations/temp-from-session", alice.tok, {
  sessionKey: "call-" + ts,
  memberIds: [bob.id],
  messages: [{ senderId: alice.id, text: "shared during the call" }],
});
const gid = tg.j?.data?.id || tg.j?.data?.conversation?.id;
ok("call temp group created", tg.status < 300 && !!gid, JSON.stringify(tg.j).slice(0, 120));
await sleep(600);

// NEWER activity in the DM — this must outrank the temp group.
await call("POST", `/api/conversations/${cid}/messages`, bob.tok, { text: "newest dm message" });
await sleep(600);

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
// Fresh logins land on the dashboard; the conversation rail renders in the
// chats module — deep-link into the DM (also marks it read, so the assertion
// tests pure RECENCY order, not the unread tier).
await page.goto(`${BASE}/?conversation=${encodeURIComponent(cid)}`);
await page.waitForSelector(".cv", { timeout: 45000 });
await sleep(2500);
const order = await page.evaluate(() =>
  Array.from(document.querySelectorAll(".cv")).map((e) => e.getAttribute("aria-label") || ""),
);
// The temp group auto-names itself "Order Alice + Order Bob" — match exactly.
const dmIdx = order.findIndex((n) => n === "Order Bob");
const tgIdx = order.findIndex((n) => n.includes(" + "));
ok("rail lists both rows", dmIdx >= 0 && tgIdx >= 0, JSON.stringify(order));
ok("chat with the NEWEST activity sits ABOVE the call temp group", dmIdx < tgIdx, JSON.stringify(order));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
