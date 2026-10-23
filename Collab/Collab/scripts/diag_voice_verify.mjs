// Verify the VoicePlayer fix: (1) displayed duration label per voice row,
// (2) clicking play fetches the audio via blob (auth ok) and actually plays.
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
const dl = [];
page.on("response", (r) => { if (r.url().includes("/download")) dl.push(`${r.status()} ${r.url().split("/files/")[1]?.slice(0, 12)}`); });
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await sleep(3500);
await page.locator('button[aria-label="Messages"]').first().click();
await page.locator(".mw:has(audio)").first().waitFor({ timeout: 30000 });
await sleep(2000);

// (1) duration labels
const labels = await page.evaluate(() =>
  [...document.querySelectorAll(".mw:has(audio)")].map((r) => {
    const id = (r.id || "").replace("msg-", "").slice(0, 8);
    const span = [...r.querySelectorAll("span")].find((s) => /^\d+:\d{2}$/.test(s.textContent?.trim() || ""));
    return { id, label: span?.textContent?.trim() || "(none)" };
  }),
);
console.log("Displayed duration labels:");
for (const l of labels) console.log(`  ${l.id} -> ${l.label}`);

// (2) play the LAST voice row (newest, duration=3) and watch the audio element
const lastRow = page.locator(".mw:has(audio)").last();
await lastRow.scrollIntoViewIfNeeded();
await lastRow.locator(".bub:has(audio) button").first().click(); // VoicePlayer play button
await sleep(2500);
const playState = await page.evaluate(() => {
  const a = [...document.querySelectorAll("audio")].pop();
  return a ? { srcScheme: (a.currentSrc || a.src).split(":")[0], paused: a.paused, currentTime: +a.currentTime.toFixed(2), readyState: a.readyState, error: a.error?.code ?? null } : null;
});
console.log("\nPlayback of newest voice msg:", JSON.stringify(playState));
console.log("Download responses seen:", dl);
await browser.close();
process.exit(0);
