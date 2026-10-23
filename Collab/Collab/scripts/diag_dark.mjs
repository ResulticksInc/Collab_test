// Dark/OLED theme sanity check: apply theme, screenshot, and report computed
// colors for key surfaces + text to flag invisible (low-contrast) text.
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
await sleep(2000);

const lum = (rgb) => {
  const m = rgb.match(/\d+/g)?.map(Number) || [0, 0, 0];
  return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]);
};
async function probe(themeClass, label) {
  await page.evaluate((cls) => {
    document.body.classList.remove("dark", "oled");
    if (cls) document.body.classList.add(...cls.split(" "));
  }, themeClass);
  await sleep(600);
  const data = await page.evaluate(() => {
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const bub = document.querySelector(".bub");
    const tm = document.querySelector(".mtm");
    const chName = document.querySelector(".ch-nm");
    return {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      msgsBg: cs(document.querySelector(".msgs"))?.backgroundColor,
      bubBg: cs(bub)?.backgroundColor, bubColor: cs(bub)?.color,
      tmColor: cs(tm)?.color,
      chNameColor: cs(chName)?.color,
    };
  });
  const contrast = Math.abs(lum(data.bubColor || "") - lum(data.bubBg || data.bodyBg || ""));
  console.log(`\n[${label}]`);
  for (const [k, v] of Object.entries(data)) console.log(`  ${k}: ${v}`);
  console.log(`  bubble text/bg luminance gap: ${contrast.toFixed(0)} ${contrast < 40 ? "⚠ LOW CONTRAST" : "ok"}`);
  await page.screenshot({ path: `scripts/diag_${label}.png`, fullPage: false }).catch(() => {});
}

await probe("", "light");
await probe("dark", "dark");
await probe("dark oled", "oled");
await browser.close();
process.exit(0);
