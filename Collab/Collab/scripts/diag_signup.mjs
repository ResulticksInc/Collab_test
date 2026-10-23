import { chromium } from "@playwright/test";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext(); // NO token -> login screen
const page = await ctx.newPage();
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await sleep(3500);
const info = await page.evaluate(() => ({
  bodyText: document.body.innerText.replace(/\s+/g, " ").slice(0, 300),
  hasSignupToggle: /sign up|don.t have an account|create your account/i.test(document.body.innerText),
}));
console.log("login screen text:", info.bodyText);
console.log("signup visible:", info.hasSignupToggle);
await browser.close();
process.exit(0);
