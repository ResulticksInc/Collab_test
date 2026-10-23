// End-to-end sign-up test: toggle to Sign up, fill the form, submit, and confirm
// the new account authenticates (token stored + dashboard shown).
import { chromium } from "@playwright/test";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const email = `e2e_signup_${Date.now()}@colab.test`;
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const apiResp = [];
page.on("response", (r) => { if (r.url().includes("/api/auth/")) apiResp.push(`${r.status()} ${r.url().split("/api")[1]}`); });
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await sleep(3500);
await page.getByRole("button", { name: /^sign up$/i }).click();
await sleep(400);
await page.locator('input[name="name"]').fill("E2E Test User");
await page.locator('input[name="email"]').fill(email);
await page.locator('input[name="password"]').fill("test123456");
await page.getByRole("button", { name: /create account/i }).click();
await sleep(4000);
const out = await page.evaluate(() => ({
  token: !!localStorage.getItem("clb_token"),
  onLogin: /sign in to colab|create your account/i.test(document.body.innerText),
  body: document.body.innerText.replace(/\s+/g, " ").slice(0, 120),
}));
console.log("signup email:", email);
console.log("auth API responses:", apiResp);
console.log("token stored:", out.token, "| still on login:", out.onLogin);
console.log("landed on:", out.body);
console.log(out.token && !out.onLogin ? "RESULT: SIGN-UP WORKS END-TO-END ✓" : "RESULT: sign-up did NOT authenticate ✗");
await browser.close();
process.exit(0);
