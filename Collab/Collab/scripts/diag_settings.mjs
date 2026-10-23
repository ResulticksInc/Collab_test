import { chromium } from "@playwright/test";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();
const userId = "u_kp_aravinth_resulticksmail_com";
const token = jwt.sign({ sub: userId, userId }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((t) => localStorage.setItem("clb_token", t), token);
const page = await ctx.newPage();
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await sleep(3500);
await page.locator('button[aria-label="Profile and settings"]').first().click().catch((e) => console.log("profile click:", e.message));
await sleep(800);
// a menu may appear with a Settings item
const settingsItem = page.getByText("Settings", { exact: true });
if (await settingsItem.count()) await settingsItem.first().click().catch(() => {});
await sleep(1000);
// ensure Appearance section
const appearance = page.locator(".spn", { hasText: "Appearance" });
if (await appearance.count()) await appearance.first().click().catch(() => {});
await sleep(800);
const foCount = await page.locator(".fo").count();
const dims = await page.evaluate(() => {
  const fo = document.querySelector(".fo");
  const r = fo?.getBoundingClientRect();
  return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
});
console.log("typeface cards:", foCount, "| first card size:", JSON.stringify(dims));
await page.screenshot({ path: "scripts/diag_settings.png", fullPage: false }).catch(() => {});
console.log("screenshot -> scripts/diag_settings.png");
await browser.close();
process.exit(0);
