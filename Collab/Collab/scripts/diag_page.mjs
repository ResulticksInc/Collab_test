import { chromium } from "@playwright/test";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();
const userId = "u_kp_aravinth_resulticksmail_com";
const token = jwt.sign({ sub: userId, userId }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await browser.newContext({ permissions: ["microphone"] });
await ctx.addInitScript((t) => localStorage.setItem("clb_token", t), token);
const page = await ctx.newPage();
const reqFails = [];
page.on("requestfailed", (r) => reqFails.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 200)));
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 300)));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" }).catch((e) => console.log("goto:", e.message));
await sleep(6000);
const info = await page.evaluate(() => ({
  url: location.href,
  token: !!localStorage.getItem("clb_token"),
  hasLogin: !!document.querySelector('input[type="password"], .login, [class*="login"]'),
  mw: document.querySelectorAll(".mw").length,
  audio: document.querySelectorAll("audio").length,
  convItems: document.querySelectorAll('[class*="conv"], .ci-item, .cs-item').length,
  bodyText: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
}));
console.log("\nPAGE INFO:", JSON.stringify(info, null, 2));
console.log("\nREQUEST FAILURES:", reqFails.slice(0, 15));
await page.screenshot({ path: "scripts/diag_page.png", fullPage: true }).catch(() => {});
console.log("screenshot -> scripts/diag_page.png");
await browser.close();
process.exit(0);
