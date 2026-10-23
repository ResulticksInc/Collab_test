import { chromium } from "@playwright/test";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();
const userId = "u_kp_aravinth_resulticksmail_com";
const token = jwt.sign({ sub: userId, userId }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
await ctx.addInitScript((t) => localStorage.setItem("clb_token", t), token);
const page = await ctx.newPage();
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await sleep(4000);
await page.locator('button[aria-label="Messages"]').first().click();
await page.locator(".mw").first().waitFor({ timeout: 30000 });
await sleep(2000);
const headerBtns = await page.evaluate(() =>
  [...document.querySelectorAll(".ch-acts button")].map((b) => b.getAttribute("aria-label") || b.getAttribute("data-tip")),
);
console.log("chat header buttons:", JSON.stringify(headerBtns));
await page.screenshot({ path: "scripts/diag_chat.png", fullPage: false }).catch(() => {});
console.log("screenshot -> scripts/diag_chat.png");
await browser.close();
process.exit(0);
