// Voice messages, end to end, in an E2EE DM.
//
// The bug: a voice note in an encrypted conversation is stored as CIPHERTEXT
// like every other attachment, but VoicePlayer fetched it raw and handed the
// encrypted bytes to <audio>, which silently refused to decode — the play button
// did nothing, and the rejected play() was swallowed.
//
// Chrome's fake media devices let MediaRecorder capture a real audio track with
// no hardware, so we can record and send a genuine voice message, then play it
// back as the RECIPIENT (the path that must decrypt).
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
  const email = `vv-${slug}-${ts}@t.local`;
  const r = await call("POST", "/api/auth/signup", null, { email, password: PW, name });
  return { tok: r.j?.data?.token, id: r.j?.data?.user?.id, email, name };
};

const sender = await mk("send", "Vee Sender");
const recip = await mk("recv", "Vee Recipient");
ok("signup", !!sender.tok && !!recip.tok);
if (fail) process.exit(1);
const inv = await call("POST", "/api/invites", sender.tok, { toUserId: recip.id });
if (inv.j?.data?.id) await call("POST", `/api/invites/${inv.j.data.id}/accept`, recip.tok, {});
const dm = await call("POST", "/api/conversations", sender.tok, { kind: "dm", memberIds: [recip.id] });
const cid = dm.j?.data?.id;
ok("dm created", !!cid);

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-capture", "--autoplay-policy=no-user-gesture-required"],
});
const login = async (user, label) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, permissions: ["microphone", "camera"] });
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
  await sleep(4000);
  await page.goto(`${BASE}/?conversation=${encodeURIComponent(cid)}`);
  await page.waitForSelector("#rail", { timeout: 45000 });
  await sleep(4000);
  return page;
};

const sp = await login(sender, "sender");
const rp = await login(recip, "recipient");

// RECORD + SEND a real voice message.
await sp.locator('button[aria-label="Record voice message"]').click();
await sleep(1200);
ok("recording started", (await sp.locator('button[aria-label="Send Recording"]').count()) > 0);
await sleep(2500); // capture a couple of seconds of the fake tone
await sp.locator('button[aria-label="Send Recording"]').click();
console.log("  sent recording");
await sleep(9000);

// Confirm the server stored it ENCRYPTED (otherwise this test proves nothing
// about the decrypt path).
const msgs = await call("GET", `/api/conversations/${cid}/messages`, sender.tok);
const list = msgs.j?.data || [];
const voice = [...list].reverse().find((m) => m && (m.type === "voice" || m.voice));
console.log("  stored voice message:", JSON.stringify({
  id: voice?.id, type: voice?.type, encrypted: voice?.encrypted,
  hasFile: !!voice?.file, fileId: voice?.file?.id || voice?.voice?.fileId,
}));
ok("a voice message was stored", !!voice, "no voice message found");
ok("it is stored ENCRYPTED (so playback must decrypt)", !!voice?.encrypted,
   "encrypted=" + voice?.encrypted + " — if false, this test does not exercise the fix");

// PLAY IT BACK as the RECIPIENT.
await rp.reload();
await rp.waitForSelector("#rail", { timeout: 45000 });
await sleep(7000);
const playerCount = await rp.locator(".vp").count();
ok("recipient sees the voice player", playerCount > 0, "no .vp element");

const playBtn = rp.locator(".vp .vp-play").last();
await playBtn.click();
console.log("  clicked play");

// Poll for real playback: currentTime must advance, and the button must not be
// showing the load-failed state.
let played = null;
for (let i = 0; i < 20; i++) {
  await sleep(700);
  played = await rp.evaluate(() => {
    const a = document.querySelector(".vp audio");
    const btn = document.querySelector(".vp .vp-play");
    return {
      hasAudio: !!a,
      src: a ? (a.getAttribute("src") || "").slice(0, 24) : null,
      currentTime: a ? a.currentTime : null,
      duration: a && isFinite(a.duration) ? a.duration : null,
      readyState: a ? a.readyState : null,
      error: a && a.error ? a.error.code : null,
      failedTitle: btn ? btn.getAttribute("title") : null,
    };
  });
  if (played && played.currentTime > 0.2) break;
}
console.log("  playback state:", JSON.stringify(played));
ok("audio element got a decrypted object URL", !!played?.src && played.src.startsWith("blob:"),
   "src=" + played?.src);
ok("no media decode error", played?.error == null, "MediaError code " + played?.error);
ok("player is NOT in the load-failed state", played?.failedTitle !== "Couldn't load audio",
   "title=" + played?.failedTitle);
ok("AUDIO ACTUALLY PLAYS (currentTime advanced)", (played?.currentTime || 0) > 0.2,
   "currentTime=" + played?.currentTime);

await rp.screenshot({ path: "C:/Users/ARAVIN~1/AppData/Local/Temp/claude/c--Users-Aravinth-K-P-Downloads-agen-x-projects-Collab/c66a65fe-acc2-4dde-b9e1-284239b1b450/scratchpad/voice-recipient.png" });
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
