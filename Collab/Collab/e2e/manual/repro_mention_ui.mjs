// Same invariant, driven through the REAL UI so the real send path (socket ->
// notifyMentions) runs. Two group members share the first name "Aravinth".
// We PICK the second one from the "@" picker and assert HE is the one notified.
import { createRequire } from "module";
const require = createRequire("C:/Users/Aravinth K P/Downloads/agen-x projects/Collab/package.json");
const { chromium } = require("playwright");

const BASE = process.env.BASE || "http://localhost:3002";
const ts = Date.now();
const PW = "Passw0rd!123";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + "  " + e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (m, p, t, b) => {
  const res = await fetch(BASE + p, {
    method: m,
    headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  let j = null; try { j = await res.json(); } catch {}
  return { status: res.status, j };
};
const mk = async (slug, fullName) => {
  const email = `dui-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name: fullName });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name: fullName };
};

const me     = await mk("me", `Sender ${ts}`);
const first  = await mk("a1", `Aravinth KP`);
const second = await mk("a2", `Aravinth Swamy`);
ok("signup", [me, first, second].every((u) => u.tok && u.id));
if (fail) process.exit(1);
for (const p of [first, second]) {
  const inv = await call("POST", "/api/invites", me.tok, { toUserId: p.id });
  if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, p.tok, {});
}
const title = `Dup${ts}`;
const grp = await call("POST", "/api/conversations", me.tok, {
  kind: "group", title, memberIds: [first.id, second.id],
});
ok("group created", !!grp.j?.data?.id);

const mentions = async (u) => {
  const r = await call("GET", "/api/notifications", u.tok);
  return (r.j?.data || []).filter((n) => n && n.type === "mention");
};
const b1 = (await mentions(first)).length, b2 = (await mentions(second)).length;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
await page.goto(BASE + "/");
await page.waitForSelector('input[type="email"]', { timeout: 45000 });
await page.fill('input[type="email"]', me.email);
await page.fill('input[type="password"]', PW);
await page.keyboard.press("Enter");
try {
  const skip = page.locator('button:has-text("Continue without an organization")');
  await skip.waitFor({ state: "visible", timeout: 12000 }); await skip.click();
} catch {}
await page.waitForSelector("#rail", { timeout: 60000 });
await sleep(3500);
await page.locator('#rail button:has-text("Messages"), #rail a:has-text("Messages")').first().click();
await sleep(3500);
// The list can lag the socket/hydration; retry briefly and dump on failure.
let clicked = false;
for (let i = 0; i < 10 && !clicked; i++) {
  try {
    await page.locator(`text=${title}`).first().click({ timeout: 4000 });
    clicked = true;
  } catch {
    await sleep(2500);
    await page.reload();
    await page.waitForSelector("#rail", { timeout: 45000 });
    await sleep(3000);
    try {
      await page.locator('#rail button:has-text("Messages"), #rail a:has-text("Messages")').first().click();
    } catch {}
    await sleep(2500);
  }
}
if (!clicked) {
  console.log("  [diag] sidebar text:", (await page.evaluate(() => document.body.innerText)).slice(0, 1200));
  throw new Error("could not open group " + title);
}
await sleep(2500);

const editor = page.locator('[contenteditable="true"]').last();
await editor.click();
await editor.type("Please review @Aravinth", { delay: 90 });
await sleep(1800);
const offered = await page.evaluate(() =>
  [...document.querySelectorAll(".tiptap-mention-popover .mention-item .mention-name")]
    .map((e) => e.textContent.trim().replace(/\s+/g, " ")));
console.log("  picker offered:", JSON.stringify(offered));
ok("picker offers BOTH same-first-name members", offered.length >= 2, JSON.stringify(offered));

// Click the SECOND Aravinth explicitly — the one that is NOT first in the list.
const idx = offered.findIndex((n) => n.includes("Swamy"));
ok("'Aravinth Swamy' is offered", idx >= 0, JSON.stringify(offered));
console.log(`  clicking index ${idx} -> ${offered[idx]}`);
await page.locator(`.tiptap-mention-popover .mention-item[data-index="${idx}"]`).click();
await sleep(900);

// What did the composer actually build?
const composed = await page.evaluate(() => {
  const el = [...document.querySelectorAll('[contenteditable="true"]')].pop();
  return el ? el.innerHTML : "";
});
console.log("  composer HTML:", composed.slice(0, 300));

await editor.type(" thanks", { delay: 40 });
await page.keyboard.press("Enter");
await sleep(5000);

const a1 = (await mentions(first)).length - b1;
const a2 = (await mentions(second)).length - b2;
console.log(`\n  notifications gained -> ${first.name}: ${a1}   ${second.name}(PICKED): ${a2}`);
ok(`PICKED user (${second.name}) notified`, a2 === 1, `got ${a2}`);
ok(`OTHER same-first-name member (${first.name}) NOT notified`, a1 === 0,
   `got ${a1} — WRONG USER MENTIONED`);

await page.screenshot({ path: "C:/Users/ARAVIN~1/AppData/Local/Temp/claude/c--Users-Aravinth-K-P-Downloads-agen-x-projects-Collab/c66a65fe-acc2-4dde-b9e1-284239b1b450/scratchpad/mention-dup-firstname.png" });
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
