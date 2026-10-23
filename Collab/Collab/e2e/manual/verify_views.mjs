// Meeting stage views end-to-end (§1: VIEW-01/03/06/07/08/09/11/22/23), using
// the VERIFIED join flow from verify_muteall.mjs / verify_popout.mjs:
//   ?meeting=<id> -> PreJoin green room (.pj-overlay-v2) -> .pj-join-v2 -> .ms-wrap
// Three real participants on a real SFU: host + two guests. Needs a LOCAL
// LiveKit (LIVEKIT_WS_URL must not point at production) and runs headed.
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
  const email = `vw-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const host = await mk("host", "Views Host");
const g1 = await mk("g1", "Views GuestOne");
const g2 = await mk("g2", "Views GuestTwo");
ok("signup x3", !!host.tok && !!g1.tok && !!g2.tok);
if (fail) process.exit(1);
for (const g of [g1, g2]) {
  const inv = await call("POST", "/api/invites", host.tok, { toUserId: g.id });
  if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, g.tok, {});
}
const mtg = await call("POST", "/api/meetings", host.tok, {
  title: `ViewsVerify ${ts}`,
  startsAt: new Date(Date.now() + 90_000).toISOString(),
  durationMin: 60,
  attendees: [g1.id, g2.id],
});
const mid = mtg.j?.data?.id;
ok("meeting created", !!mid, JSON.stringify(mtg.j).slice(0, 200));
if (fail) process.exit(1);

const browser = await chromium.launch({
  headless: false,
  args: [
    "--use-fake-device-for-media-capture",
    "--autoplay-policy=no-user-gesture-required",
    "--auto-select-tab-capture-source-by-title=ShareTarget",
    "--hide-crash-restore-bubble",
  ],
});

const enterMeeting = async (user, label, withShareTab = false) => {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 950 },
    permissions: ["microphone", "camera"],
  });
  if (withShareTab) {
    const shareTab = await ctx.newPage();
    await shareTab.goto('data:text/html,<title>ShareTarget</title><h1 style="font-size:80px;color:red">SHARED CONTENT</h1>');
  }
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [${label}][PAGEERROR] ${String(e.message).slice(0, 160)}`));
  await page.goto(BASE + "/");
  await page.waitForSelector('input[type="email"]', { timeout: 45000 });
  await page.fill('input[type="email"]', user.email);
  await page.fill('input[type="password"]', PW);
  await page.keyboard.press("Enter");
  try {
    const skip = page.locator('button:has-text("Continue without an organization")');
    await skip.waitFor({ state: "visible", timeout: 12000 }); await skip.click();
  } catch {}
  await page.waitForSelector("#rail", { timeout: 60000 });
  await sleep(6000);
  await page.goto(`${BASE}/?meeting=${encodeURIComponent(mid)}`);
  await page.waitForSelector(".pj-overlay-v2", { timeout: 45000 });
  await page.click(".pj-join-v2");
  await page.waitForSelector(".ms-wrap", { timeout: 45000 });
  console.log(`  [${label}] on meeting stage`);
  return page;
};

const hostPage = await enterMeeting(host, "host", true);
const g1Page = await enterMeeting(g1, "g1");
const g2Page = await enterMeeting(g2, "g2");
await sleep(4000); // let all publications/tiles settle

const stageState = (page) => page.evaluate(() => {
  const tiles = Array.from(document.querySelectorAll(".ms-tile[data-pid]"));
  return {
    total: tiles.length,
    railed: tiles.filter((t) => t.classList.contains("ms-tile-railed")).length,
    pinned: tiles.filter((t) => t.classList.contains("ms-tile-pinned")).length,
    spotlit: tiles.filter((t) => t.classList.contains("ms-tile-spotlit")).length,
    screen: tiles.filter((t) => t.dataset.screen === "true").length,
    pager: !!document.querySelector(".ms-wrap [class*=pager], .ms-page"),
    viewPref: (() => { try { return localStorage.getItem("clb_view_mode"); } catch { return null; } })(),
    banner: (document.querySelector(".ms-spotlight-banner") || {}).textContent || "",
    sr: (document.querySelector('[aria-live="polite"]') || {}).textContent || "",
  };
});

// ── VIEW-01: gallery is the default — every tile equal, nothing hidden ──────
const s0 = await stageState(g1Page);
ok("VIEW-01 gallery default with all tiles shown", s0.total >= 3 && s0.railed === 0 && s0.spotlit === 0, JSON.stringify(s0));

// ── VIEW-03/07: switch to Participant (speaker) view; persisted ─────────────
await g1Page.click('button[title="Participant view"]');
await sleep(1500);
const s1 = await stageState(g1Page);
ok("VIEW-03 speaker view rails the non-focal tiles", s1.railed > 0, JSON.stringify(s1));
ok("VIEW-07 choice persisted", s1.viewPref === "speaker", `pref=${s1.viewPref}`);

// ── VIEW-06: g1's switch changed nothing for the host ───────────────────────
const sHost = await stageState(hostPage);
ok("VIEW-06 per-participant only (host unaffected)", sHost.railed === 0, JSON.stringify(sHost));

// back to gallery for the pin/spotlight steps
await g1Page.click('button[title="Gallery view"]');
await sleep(1200);

// ── VIEW-08: pin (local-only) via the tile pin button ───────────────────────
await g1Page.hover(".ms-tile[data-pid]:not([data-local])");
await g1Page.click(".ms-tile[data-pid]:not([data-local]) .ms-expand-btn");
await sleep(1200);
const s2 = await stageState(g1Page);
ok("VIEW-08 pin fills the stage, others hidden", s2.pinned === 1 && s2.railed > 0, JSON.stringify(s2));
const sHost2 = await stageState(hostPage);
ok("VIEW-08 pin is local-only (host unaffected)", sHost2.pinned === 0 && sHost2.railed === 0, JSON.stringify(sHost2));

// ── VIEW-09: host spotlights GuestTwo for everyone ──────────────────────────
await hostPage.click('button[title="Participant view"]'); // opens the People panel
await hostPage.waitForSelector(".ms-person-row", { timeout: 15000 });
const g2Row = hostPage.locator(`.ms-person-row:has-text("Views GuestTwo")`);
const spotBtn = g2Row.locator(".ms-person-spotlight");
ok("VIEW-09 spotlight control visible to the organizer", (await spotBtn.count()) > 0);
await g2Row.first().hover(); // actions are hover-revealed on desktop
await spotBtn.first().click();
await sleep(2000);

const g1Spot = await stageState(g1Page);
ok("VIEW-09 spotlight forces g1's layout (1 spotlit, pin retained but hidden)",
  g1Spot.spotlit === 1 && g1Spot.pinned === 0 && /Spotlighted by Views Host/.test(g1Spot.banner),
  JSON.stringify(g1Spot));
ok("VIEW-11 forced change announced to screen readers", /Spotlight applied by Views Host/.test(g1Spot.sr), `sr="${g1Spot.sr}"`);
const g2Spot = await stageState(g2Page);
ok("VIEW-09 applies to everyone (g2 too)", g2Spot.spotlit === 1 && /Spotlighted by/.test(g2Spot.banner), JSON.stringify(g2Spot));
const hostSpot = await stageState(hostPage);
ok("VIEW-09 actor sees it too, banner reads 'by you'", hostSpot.spotlit === 1 && /Spotlighted by you/.test(hostSpot.banner), JSON.stringify(hostSpot));

// ── VIEW-09 escape: Return to my view (local only) ──────────────────────────
await g1Page.click(".ms-spotlight-return");
await sleep(1500);
const g1Esc = await stageState(g1Page);
ok("VIEW-09 'Return to my view' restores g1's pin locally",
  g1Esc.spotlit === 0 && g1Esc.pinned === 1 && !g1Esc.banner, JSON.stringify(g1Esc));
const g2Still = await stageState(g2Page);
ok("VIEW-09 escape is per-viewer (g2 still spotlighted)", g2Still.spotlit === 1, JSON.stringify(g2Still));

// ── VIEW-09 late joiner: g2 leaves and rejoins — spotlight re-announced ─────
await g2Page.evaluate(() => { const b = document.querySelector(".ms-dock-leave"); b && b.click(); });
await sleep(2000);
await g2Page.goto(`${BASE}/?meeting=${encodeURIComponent(mid)}`);
await g2Page.waitForSelector(".pj-overlay-v2", { timeout: 45000 });
await g2Page.click(".pj-join-v2");
await g2Page.waitForSelector(".ms-wrap", { timeout: 45000 });
await sleep(4000);
const g2Back = await stageState(g2Page);
ok("VIEW-09 late joiner lands in the spotlight layout", g2Back.spotlit === 1 && /Spotlighted by/.test(g2Back.banner), JSON.stringify(g2Back));

// ── VIEW-09 off: organizer removes the spotlight ────────────────────────────
await g2Row.first().hover();
await spotBtn.first().click();
await sleep(2000);
const g2Off = await stageState(g2Page);
ok("VIEW-09 removing the spotlight releases everyone", g2Off.spotlit === 0 && !g2Off.banner, JSON.stringify(g2Off));

// unpin so the share step starts from a clean gallery
await g1Page.evaluate(() => { const t = document.querySelector(".ms-tile-pinned .ms-expand-btn"); t && t.click(); });
await sleep(1000);

// ── VIEW-22/23: content share promotes to focal, then returns ───────────────
let shared = false;
for (let i = 1; i <= 4 && !shared; i++) {
  await hostPage.click('button[aria-label="Share screen"]');
  try { await hostPage.waitForSelector('button[aria-label="Stop sharing"]', { timeout: 8000 }); shared = true; }
  catch { await sleep(1500); }
}
ok("host share started", shared);
await g1Page.waitForSelector(".ms-tile-screen", { timeout: 30000 });
await sleep(1500);
const g1Share = await stageState(g1Page);
ok("VIEW-22 content fills the stage (camera tiles collapse)", g1Share.screen >= 1 && g1Share.railed > 0, JSON.stringify(g1Share));
await hostPage.click('button[aria-label="Stop sharing"]');
await sleep(2500);
const g1After = await stageState(g1Page);
ok("VIEW-23 stage returns to the prior view after sharing stops", g1After.screen === 0 && g1After.railed === 0, JSON.stringify(g1After));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
