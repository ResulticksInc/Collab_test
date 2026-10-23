// Verify the UI RENDERS the reply quote on voice messages that have a parent.
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
await page.locator(".mw").first().waitFor({ timeout: 30000 });
await sleep(2500);

// For every message row, report: has audio (voice)? has reply-quote? quote text?
const rows = await page.evaluate(() => {
  return [...document.querySelectorAll(".mw")].map((r) => {
    const q = r.querySelector(".reply-quote");
    return {
      id: (r.id || "").replace("msg-", "").slice(0, 8),
      voice: !!r.querySelector("audio"),
      hasQuote: !!q,
      quoteText: q ? q.querySelector(".reply-quote-text")?.textContent?.trim().slice(0, 30) : null,
    };
  });
});
console.log("ROWS (id | voice | hasQuote | quoteText):");
for (const x of rows) console.log(`  ${x.id} | voice=${x.voice} | quote=${x.hasQuote} | "${x.quoteText || ""}"`);
const voiceWithQuote = rows.filter((r) => r.voice && r.hasQuote);
console.log(`\nVoice messages rendering a reply-quote: ${voiceWithQuote.length}`);
await page.screenshot({ path: "scripts/diag_render.png", fullPage: true }).catch(() => {});
await browser.close();
process.exit(0);
