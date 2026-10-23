// VoicePlayer-side evidence: for each <audio> in the chat, report the src, the
// HTTP status of that src, and what the browser computes for .duration (the
// value VoicePlayer relies on). Proves whether webm metadata yields a duration.
import { chromium } from "@playwright/test";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();
const userId = "u_kp_aravinth_resulticksmail_com";
const token = jwt.sign({ sub: userId, userId }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addInitScript((t) => localStorage.setItem("clb_token", t), token);
const page = await ctx.newPage();
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await sleep(3500);
await page.locator('button[aria-label="Messages"]').first().click();
await page.locator(".mw:has(audio)").first().waitFor({ timeout: 30000 });
await sleep(2500);

const result = await page.evaluate(async () => {
  const auds = [...document.querySelectorAll("audio")].slice(0, 4);
  const out = [];
  for (const a of auds) {
    // force a load + wait briefly for metadata
    try { a.load(); } catch {}
    await new Promise((r) => {
      let done = false;
      const fin = () => { if (!done) { done = true; r(); } };
      a.addEventListener("loadedmetadata", fin, { once: true });
      a.addEventListener("error", fin, { once: true });
      setTimeout(fin, 2500);
    });
    let httpStatus = "?";
    try { const resp = await fetch(a.currentSrc || a.src); httpStatus = resp.status; } catch (e) { httpStatus = "fetch-fail:" + e.message; }
    out.push({
      src: (a.currentSrc || a.src).replace(location.origin, "").slice(0, 70),
      httpStatus,
      readyState: a.readyState,
      duration: a.duration,
      durationFinite: Number.isFinite(a.duration),
      networkState: a.networkState,
      error: a.error ? a.error.code : null,
    });
  }
  return out;
});
console.log("AUDIO ELEMENTS (what VoicePlayer reads):");
for (const r of result) console.log(JSON.stringify(r));
await browser.close();
process.exit(0);
