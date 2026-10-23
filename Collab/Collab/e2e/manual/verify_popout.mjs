// Screen-share POP OUT end-to-end (POP-01..POP-10), using the VERIFIED join
// flow from e2e/manual/verify_muteall.mjs:
//   ?meeting=<id> -> PreJoin green room (.pj-overlay-v2) -> .pj-join-v2 -> .ms-wrap
// Host shares a TAB (auto-selected by title — tab capture needs no macOS
// Screen Recording permission); guest pops the share out via Document PiP.
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
  const email = `po-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const host = await mk("host", "Popout Host");
const guest = await mk("guest", "Popout Guest");
ok("signup", !!host.tok && !!guest.tok);
if (fail) process.exit(1);
const inv = await call("POST", "/api/invites", host.tok, { toUserId: guest.id });
if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, guest.tok, {});
const mtg = await call("POST", "/api/meetings", host.tok, {
  title: `PopoutVerify ${ts}`,
  startsAt: new Date(Date.now() + 90_000).toISOString(),
  durationMin: 60,
  attendees: [guest.id],
});
const mid = mtg.j?.data?.id;
ok("meeting created", !!mid, JSON.stringify(mtg.j).slice(0, 200));
if (fail) process.exit(1);

const browser = await chromium.launch({
  headless: false, // Document PiP needs a real window manager
  args: [
    "--use-fake-device-for-media-capture",
    "--autoplay-policy=no-user-gesture-required",
    // A dedicated ShareTarget tab is the capture source: LiveKit excludes the
    // sharer's own tab (selfBrowserSurface), so the app tab can't be the target.
    "--auto-select-tab-capture-source-by-title=ShareTarget",
    "--hide-crash-restore-bubble",
  ],
});

const enterMeeting = async (user, label) => {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 950 },
    permissions: ["microphone", "camera"],
  });
  if (label === "host") {
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
  await sleep(6000); // deep link needs the meetings list hydrated; fires once per load
  await page.goto(`${BASE}/?meeting=${encodeURIComponent(mid)}`);
  await page.waitForSelector("#rail", { timeout: 45000 });
  await page.waitForSelector(".pj-overlay-v2", { timeout: 45000 });
  console.log(`  [${label}] green room shown`);
  await page.click(".pj-join-v2");
  await page.waitForSelector(".ms-wrap", { timeout: 45000 });
  console.log(`  [${label}] on meeting stage`);
  return page;
};

const hostPage = await enterMeeting(host, "host");
const guestPage = await enterMeeting(guest, "guest");
await sleep(3000); // let both publications settle


// Chromium's auto-select tab capture intermittently aborts BEFORE getDisplayMedia
// under automation (LiveKit surfaces it as a benign picker-cancel). Retry like a
// real user re-clicking; the wrapper records what actually happened for triage.
const startShare = async (page) => {
  await page.evaluate(() => {
    if (window.__gdmWrapped) return; window.__gdmWrapped = true;
    const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (c) => {
      try { const st = await orig(c); window.__gdm = "OK"; return st; }
      catch (e) { window.__gdm = "FAIL " + e.name + ": " + e.message; throw e; }
    };
  });
  for (let i = 1; i <= 4; i++) {
    await page.click('button[aria-label="Share screen"]');
    try {
      await page.waitForSelector('button[aria-label="Stop sharing"]', { timeout: 8000 });
      return true;
    } catch {
      console.log(`  [host] share attempt ${i} did not take (gdm=${await page.evaluate(() => window.__gdm)}) — retrying`);
      await sleep(1500);
    }
  }
  return false;
};
// ── Host shares a tab ────────────────────────────────────────────────────────
ok("host share started", await startShare(hostPage));
await guestPage.waitForSelector(".ms-tile-screen", { timeout: 30000 });
ok("guest sees the screen-share tile", true);

// ── POP-08: host's OWN share tile has an inert, explained Pop out ───────────
await hostPage.waitForSelector(".ms-tile-screen", { timeout: 15000 });
const ownBtn = await hostPage.$(".ms-tile-screen .ms-popout-btn");
const ownDisabled = ownBtn ? await ownBtn.evaluate((b) => b.disabled && (b.title || "").includes("mirror")) : false;
ok("POP-08 own-share pop out disabled with explanation", ownDisabled);

// ── Guest pops the share out (Document PiP) ─────────────────────────────────
await guestPage.hover(".ms-tile-screen");
await guestPage.click(".ms-tile-screen .ms-popout-btn");
await sleep(1500);
const pipOpen = await guestPage.evaluate(() => !!(window.documentPictureInPicture && window.documentPictureInPicture.window));
ok("POP-01/02 Document PiP window opened", pipOpen);
const phState = await guestPage.evaluate(() => {
  const tile = document.querySelector(".ms-tile-screen");
  const ph = tile && tile.querySelector(".ms-popout-placeholder");
  return {
    popped: !!(tile && tile.classList.contains("ms-tile-popped-out")),
    placeholder: !!ph,
    bringback: !!(ph && ph.querySelector(".ms-popout-bringback")),
    videoStillThere: !!(tile && tile.querySelector("video")), // live thumbnail
  };
});
ok("POP-04 placeholder + Bring back + live thumbnail", phState.popped && phState.placeholder && phState.bringback && phState.videoStillThere, JSON.stringify(phState));

// POP-02: the pop-out header carries minimize / maximize / Bring back — real
// resizes need a human gesture inside the PiP window (Playwright can't reach
// in), so this pins the controls' presence, labels, and the resize capability.
const hdrState = await guestPage.evaluate(() => {
  const w = window.documentPictureInPicture && window.documentPictureInPicture.window;
  if (!w) return null;
  const btns = Array.from(w.document.querySelectorAll(".pp-btn")).map((b) => b.title || "");
  return { btns, canResize: typeof w.resizeTo === "function" };
});
ok("POP-02 pop-out header has Minimize / Maximize / Bring back",
  !!hdrState && hdrState.btns.includes("Minimize") && hdrState.btns.includes("Maximize") && hdrState.btns.some((t) => /Bring back/.test(t)),
  JSON.stringify(hdrState));
ok("POP-02 window is programmatically resizable", !!hdrState && hdrState.canResize === true);

// Re-click focuses the existing window, never duplicates
await guestPage.hover(".ms-tile-screen");
await guestPage.click(".ms-tile-screen .ms-popout-btn");
await sleep(800);
const stillOne = await guestPage.evaluate(() => !!(window.documentPictureInPicture && window.documentPictureInPicture.window));
ok("re-click focuses (no duplicate, no crash)", stillOne);

// ── POP-05: Bring back returns content, closes the window ───────────────────
await guestPage.click(".ms-popout-bringback");
await sleep(1200);
const afterBack = await guestPage.evaluate(() => ({
  pip: !!(window.documentPictureInPicture && window.documentPictureInPicture.window),
  popped: !!document.querySelector(".ms-tile-popped-out"),
  placeholder: !!document.querySelector(".ms-popout-placeholder"),
}));
ok("POP-05 Bring back closes window and restores tile", !afterBack.pip && !afterBack.popped && !afterBack.placeholder, JSON.stringify(afterBack));

// ── POP-10: leaving the meeting closes the open pop-out ─────────────────────
await guestPage.hover(".ms-tile-screen");
await guestPage.click(".ms-tile-screen .ms-popout-btn");
await sleep(1200);
ok("pop out re-opens after bring back", await guestPage.evaluate(() => !!(window.documentPictureInPicture && window.documentPictureInPicture.window)));
await guestPage.evaluate(() => { const b = document.querySelector(".ms-dock-leave"); b && b.click(); });
await sleep(2500);
const afterLeave = await guestPage.evaluate(() => ({
  pip: !!(window.documentPictureInPicture && window.documentPictureInPicture.window),
  stage: !!document.querySelector(".ms-wrap"),
}));
ok("POP-10 leave closes pop-outs", !afterLeave.pip && !afterLeave.stage, JSON.stringify(afterLeave));

// ── Guest rejoins (share still live), pops out; presenter STOPS sharing ─────
await guestPage.goto(`${BASE}/?meeting=${encodeURIComponent(mid)}`);
await guestPage.waitForSelector(".pj-overlay-v2", { timeout: 45000 });
await guestPage.click(".pj-join-v2");
await guestPage.waitForSelector(".ms-wrap", { timeout: 45000 });
await guestPage.waitForSelector(".ms-tile-screen", { timeout: 30000 });
console.log("  [guest] rejoined, share visible");
await guestPage.hover(".ms-tile-screen");
await guestPage.click(".ms-tile-screen .ms-popout-btn");
await sleep(1500);
ok("pop out open after rejoin", await guestPage.evaluate(() => !!(window.documentPictureInPicture && window.documentPictureInPicture.window)));

await hostPage.click('button[aria-label="Stop sharing"]');
// The toast lives 2400ms — poll for it instead of sleeping past it.
let sawToast = false;
try {
  await guestPage.waitForFunction(
    () => /sharing ended/i.test((document.querySelector(".cv-toast") || {}).textContent || ""),
    { timeout: 8000 },
  );
  sawToast = true;
} catch {}
await sleep(1000);
const afterStop = await guestPage.evaluate(() => ({
  pip: !!(window.documentPictureInPicture && window.documentPictureInPicture.window),
  screenTile: !!document.querySelector(".ms-tile-screen"),
}));
ok("share end auto-closes the pop-out (acceptance §2)", !afterStop.pip, JSON.stringify(afterStop));
ok("screen tile removed after share end", !afterStop.screenTile);
ok("'sharing ended' toast shown", sawToast);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
