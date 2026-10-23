// Runtime repro: drive the REAL frontend with a fake mic, capture every
// `message:send` WebSocket frame, and report whether parentMessageId is present
// for each reply scenario. Token is injected into localStorage to skip login.
import { chromium } from "@playwright/test";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();

const userId = "u_kp_aravinth_resulticksmail_com";
const token = jwt.sign({ sub: userId, userId }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });

const sent = []; // {label, raw, payload}
let label = "init";

function parseFrame(raw) {
  if (typeof raw !== "string") return null;
  const i = raw.indexOf("[");
  if (i < 0) return null;
  try {
    const arr = JSON.parse(raw.slice(i));
    if (Array.isArray(arr) && arr[0] === "message:send") return arr[1];
  } catch {}
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function recordReply(page, rowLocator, scenario) {
  label = scenario;
  console.log(`\n--- ${scenario} ---`);
  await rowLocator.scrollIntoViewIfNeeded();
  await rowLocator.hover();
  await sleep(300);
  const reply = rowLocator.locator('button[title="Reply"]');
  await reply.click();
  console.log("  clicked Reply; reply-bar:", await page.locator(".reply-bar").count());
  // ensure composer empty so mic button shows
  const mic = page.locator('button[aria-label="Record voice message"]');
  await mic.waitFor({ state: "visible", timeout: 5000 });
  await mic.click();
  console.log("  recording started");
  await sleep(3500);
  const send = page.locator('.sb-btn[style*="--ac"]');
  await send.click();
  console.log("  clicked recording-send; waiting for upload+emit…");
  await sleep(4000);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  await context.addInitScript((t) => {
    localStorage.setItem("clb_token", t);
  }, token);

  const page = await context.newPage();
  page.on("websocket", (ws) => {
    ws.on("framesent", (f) => {
      const p = parseFrame(f.payload);
      if (p) sent.push({ label, payload: p });
    });
  });
  page.on("console", (m) => {
    const t = m.text();
    if (/error|fail|denied/i.test(t)) console.log("  [page]", t.slice(0, 160));
  });

  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await sleep(3500); // let auth + dashboard settle
  // App boots on the Dashboard — switch to Messages (auto-selects first DM).
  await page.locator('button[aria-label="Messages"]').first().click();
  // wait for messages to load (voice players present)
  await page.locator(".mw").first().waitFor({ timeout: 30000 });
  await sleep(2500);
  const voiceRows = page.locator(".mw:has(audio)");
  const textRows = page.locator(".mw:has(.bub):not(:has(audio)):not(:has(.fb-bub))");
  console.log("voice rows:", await voiceRows.count(), "| text rows:", await textRows.count());

  // Scenario 1: VOICE → VOICE (reply with voice to a voice message)
  try { await recordReply(page, voiceRows.first(), "VOICE→VOICE"); }
  catch (e) { console.log("  scenario1 error:", e.message.slice(0, 120)); }

  // clear any lingering reply state, move pointer away
  await page.locator(".reply-bar-x").first().click().catch(() => {});
  await page.mouse.move(5, 5);
  await sleep(800);

  // Scenario 2: TEXT → VOICE (reply with voice to a text message)
  try { await recordReply(page, textRows.first(), "TEXT→VOICE"); }
  catch (e) { console.log("  scenario2 error:", e.message.slice(0, 120)); }

  console.log("\n================ CAPTURED message:send FRAMES ================");
  for (const s of sent) {
    const p = s.payload;
    console.log(
      `[${s.label}] type=${p.type || "text"} parentMessageId=${p.parentMessageId || "MISSING"} file=${p.file ? "yes" : "no"} voice=${JSON.stringify(p.voice)}`,
    );
  }
  if (!sent.length) console.log("(no message:send frames captured — UI flow may not have emitted)");

  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error("REPRO FAILED:", e.message);
  process.exit(1);
});
