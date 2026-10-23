// "Mute everyone" end-to-end, using the VERIFIED join flow:
//   ?meeting=<id>  ->  PreJoin green room (.pj-overlay-v2)  ->  .pj-join-v2
//   ->  meeting stage (.ms-wrap)
// Deep link requires a token AND meetings.length > 0, and fires once per load.
// Chrome fake devices give real published audio with no hardware.
import { createRequire } from "module";
const require = createRequire("C:/Users/Aravinth K P/Downloads/agen-x projects/Collab/package.json");
const { chromium } = require("playwright");

const BASE = process.env.BASE || "http://localhost:3003";
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
  const email = `mv-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const host = await mk("host", "Hostie Kay");
const guest = await mk("guest", "Guestie Swam");
ok("signup", !!host.tok && !!guest.tok);
if (fail) process.exit(1);
const inv = await call("POST", "/api/invites", host.tok, { toUserId: guest.id });
if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, guest.tok, {});
const mtg = await call("POST", "/api/meetings", host.tok, {
  title: `MuteVerify ${ts}`,
  startsAt: new Date(Date.now() + 90_000).toISOString(),
  durationMin: 60,
  attendees: [guest.id],
});
const mid = mtg.j?.data?.id;
ok("meeting created", !!mid, JSON.stringify(mtg.j).slice(0, 200));

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-capture", "--autoplay-policy=no-user-gesture-required"],
});
const enterMeeting = async (user, label) => {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 950 },
    permissions: ["microphone", "camera"],
  });
  const page = await ctx.newPage();
  const toasts = [];
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
  // The deep link needs meetings.length > 0, so let the meeting list hydrate,
  // THEN navigate (it fires once per page load).
  await sleep(6000);
  await page.goto(`${BASE}/?meeting=${encodeURIComponent(mid)}`);
  await page.waitForSelector("#rail", { timeout: 45000 });
  // Green room -> Join now
  await page.waitForSelector(".pj-overlay-v2", { timeout: 45000 });
  console.log(`  [${label}] green room shown`);
  await page.locator(".pj-join-v2").click();
  await page.waitForSelector(".ms-wrap", { timeout: 60000 });
  console.log(`  [${label}] ON MEETING STAGE`);
  await sleep(9000);
  return { page, toasts };
};

const H = await enterMeeting(host, "host");
const G = await enterMeeting(guest, "guest");

// Ground truth: is the guest publishing a live mic, per the tile badge?
const guestBadgeVisible = () => G.page.evaluate(() => {
  const b = document.querySelector(".ms-wrap .ms-tile-mic");
  if (!b) return null;
  return getComputedStyle(b).display !== "none";
});
const guestDockMuted = () => G.page.evaluate(() => {
  // The dock mic button reflects `mic` state; find it by aria-label.
  const btns = [...document.querySelectorAll(".ms-wrap button")];
  const m = btns.find((b) => /mic|mute/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || ""));
  return m ? (m.getAttribute("aria-label") || m.getAttribute("title")) : null;
});
console.log("  guest dock mic BEFORE:", await guestDockMuted());

// Count the mute explanation as it appears, installed BEFORE the FIRST mute.
// It has to be the first: on a second mute the guest's mic is already off, so
// setMicrophoneEnabled(false) is a no-op and nothing further fires — measuring
// that one passes no matter what. Sampling innerText afterwards is equally
// useless, because toasts auto-dismiss.
//
// HONESTY NOTE on sensitivity: removing the selfMicChangeRef guard in
// MeetingStage.onForceMute does NOT make these assertions fail — a duplicate
// toast was hypothesised from reading the code but does not reproduce, because
// the local mute the handler performs does not re-enter the toast path with the
// timing that would be required. So treat "appears exactly once" as a guard
// against a FUTURE regression, not as a proven-sensitive check.
await G.page.evaluate(() => {
  const w = window;
  w.__mt = { max: 0, appearances: 0, present: false };
  const check = () => {
    const n = (document.body.innerText.match(/The host muted you/g) || []).length;
    if (n > w.__mt.max) w.__mt.max = n;
    if (n > 0 && !w.__mt.present) w.__mt.appearances += 1;
    w.__mt.present = n > 0;
  };
  new MutationObserver(check).observe(document.body, {
    childList: true, subtree: true, characterData: true,
  });
});

// Host clicks the real button. This is the mute that matters: the guest's mic is
// live, so the force-mute handler really does mute locally and can re-enter the
// sync path that used to show the toast a second time.
await H.page.locator(".ms-wrap .ms-topbar-people").click();
await sleep(1500);
const muteBtn = H.page.locator(".ms-people-mute-all");
ok("host sees 'Mute everyone'", (await muteBtn.count()) > 0);
await muteBtn.click();
await sleep(6000);

const mt = await G.page.evaluate(() => window.__mt || {});
console.log("  toast observer (first mute):", JSON.stringify(mt));
ok("the muted person is TOLD they were muted", (mt.appearances || 0) >= 1,
   "no explanation shown to the muted user");
ok("the mute explanation is never shown twice at once",
   (mt.max || 0) <= 1, "max simultaneous copies = " + mt.max);
ok("the mute explanation appears exactly once",
   (mt.appearances || 0) === 1, "appeared " + mt.appearances + " times");

// Call the endpoint DIRECTLY too, so we can read exactly what the server did —
// including which users it decided to notify. (Toast sampling is unreliable:
// toasts auto-dismiss, so a later innerText read misses them.)
const raw = await call("POST", `/api/meetings/${mid}/controls/mute-all`, host.tok, {});
console.log("  RAW mute-all response:", JSON.stringify(raw.j));
const rd = raw.j?.data || {};
ok("server muted at least one track", Number(rd.mutedTracks) > 0, JSON.stringify(rd));
ok("server identified who to notify", (rd.mutedUserIds || []).length > 0,
   "mutedUserIds=" + JSON.stringify(rd.mutedUserIds));
console.log("  guest.id =", guest.id);
ok("the notified id matches the guest", (rd.mutedUserIds || []).includes(guest.id),
   "got " + JSON.stringify(rd.mutedUserIds) + " expected to contain " + guest.id);

// Poll (don't sample once) for the guest's dock to flip and the toast to appear.
let dockFlipped = null, toastSeen = null;
for (let i = 0; i < 20; i++) {
  await sleep(700);
  dockFlipped = await guestDockMuted();
  if (!toastSeen)
    toastSeen = await G.page.evaluate(() => document.body.innerText.match(/The host muted you[^\n]*/)?.[0] || null);
  if (/unmute/i.test(dockFlipped || "") && toastSeen) break;
}
console.log("  guest dock (polled):", dockFlipped, "| toast (polled):", JSON.stringify(toastSeen));
ok("guest's dock toggle flips to Unmute", /unmute/i.test(dockFlipped || ""), "dock=" + dockFlipped);

// The decisive checks, on the GUEST.
const dockAfter = await guestDockMuted();
console.log("  guest dock mic AFTER:", dockAfter);
// Distinguish "the event never fired" from "the event fired but my guard ate it":
// the TILE badge is repainted by updateParticipants (which re-derives from the
// SDK), the DOCK is driven by syncLocalMicState. Both hang off the same handler.
const guestSelfState = await G.page.evaluate(() => {
  const tiles = [...document.querySelectorAll(".ms-wrap [data-local='true'], .ms-wrap .ms-tile")];
  return tiles.map((t) => {
    const b = t.querySelector(".ms-tile-mic");
    return {
      local: t.getAttribute("data-local"),
      label: (t.querySelector(".ms-tile-label")?.textContent || "").trim().slice(0, 24),
      micBadgeVisible: b ? getComputedStyle(b).display !== "none" : null,
    };
  });
});
console.log("  guest OWN tiles:", JSON.stringify(guestSelfState));
// Open the guest's own People panel so updateParticipants' view of THEIR OWN
// mic (derived straight from room.localParticipant.isMicrophoneEnabled) is
// readable. This tells us whether the guest's SDK even knows it was muted.
try {
  await G.page.locator(".ms-wrap .ms-topbar-people").click({ timeout: 8000 });
  await sleep(2500);
} catch (e) { console.log("  [guest] could not open people panel:", e.message.slice(0, 80)); }
const guestRoster = await G.page.evaluate(() => {
  const p = document.querySelector(".ms-people-panel");
  if (!p) return "people panel not open";
  return [...p.querySelectorAll(".ms-person")].map((r) => ({
    who: (r.textContent || "").trim().slice(0, 30),
    muted: !!r.querySelector(".ms-person-muted"),
  }));
});
console.log("  guest roster view:", JSON.stringify(guestRoster));
ok("the muted person is TOLD they were muted", !!toastSeen, "no explanation shown to the muted user");
// EXACTLY ONCE. The force-mute handler mutes locally, which fires TrackMuted and
// re-enters the same sync path — without a guard that path shows the identical
// toast a second time. Counting occurrences is the only way to catch it; simply
// asserting the toast appeared passes either way.


// Roster badge on the host side.
const roster = await H.page.evaluate(() =>
  [...document.querySelectorAll(".ms-people-panel .ms-person, .ms-people-panel [class*='person']")]
    .map((r) => ({ who: (r.textContent || "").trim().slice(0, 34), muted: !!r.querySelector(".ms-person-muted") }))
    .filter((r) => r.who));
console.log("  host roster:", JSON.stringify(roster));
ok("host roster shows the guest as muted",
   roster.some((r) => /Guestie/.test(r.who) && r.muted), JSON.stringify(roster));

await H.page.screenshot({ path: "C:/Users/ARAVIN~1/AppData/Local/Temp/claude/c--Users-Aravinth-K-P-Downloads-agen-x-projects-Collab/c66a65fe-acc2-4dde-b9e1-284239b1b450/scratchpad/mv-host.png" });
await G.page.screenshot({ path: "C:/Users/ARAVIN~1/AppData/Local/Temp/claude/c--Users-Aravinth-K-P-Downloads-agen-x-projects-Collab/c66a65fe-acc2-4dde-b9e1-284239b1b450/scratchpad/mv-guest.png" });
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
