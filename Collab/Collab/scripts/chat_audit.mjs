// Audit the chat module live: rich text rendering, message actions, tabs,
// unread badges, mention autocomplete. Reports ground truth.
import { chromium } from "@playwright/test";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();
const token = jwt.sign({ sub: "u_emily", userId: "u_emily" }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addInitScript((t) => localStorage.setItem("clb_token", t), token);
const page = await ctx.newPage();
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await sleep(3500);
await page.locator('button[aria-label="Messages"]').first().click();
await sleep(1500);
await page.locator(".cv", { hasText: "Marcus" }).first().click().catch(() => {});
await page.locator('input[name="message"]').waitFor({ timeout: 15000 });
await sleep(800);

// 1) Rich text
await page.locator('input[name="message"]').fill("**bold** _italic_ `code` https://ex.com @marcus");
await page.keyboard.press("Enter");
await sleep(1500);
const rich = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".bub")].pop();
  if (!b) return null;
  return { strong: !!b.querySelector("strong"), em: !!b.querySelector("em"), code: !!b.querySelector("code"), link: !!b.querySelector("a.msg-link"), mention: !!b.querySelector(".mention"), raw: b.textContent.includes("**") };
});
console.log("RICH TEXT:", JSON.stringify(rich));

// 2) Message actions (hover last message)
const lastRow = page.locator(".mw").last();
await lastRow.hover();
await sleep(400);
const actions = await page.evaluate(() => {
  const row = [...document.querySelectorAll(".mw")].pop();
  return [...(row?.querySelectorAll(".mac .ma, .mac button") || [])].map((b) => b.getAttribute("title") || b.getAttribute("aria-label") || "?");
});
console.log("MSG ACTIONS:", JSON.stringify(actions));

// 3) unread badges in sidebar
const unread = await page.evaluate(() => document.querySelectorAll(".cv .ub").length);
console.log("UNREAD BADGES visible:", unread);

// 4) Files / Links / Members tabs
for (const tab of ["Files", "Links", "Members"]) {
  const t = page.locator(".chat-tabs .tab", { hasText: tab });
  if (await t.count()) {
    await t.first().click();
    await sleep(1200);
    const info = await page.evaluate(() => ({ text: document.querySelector("#tp-chat, .tp.active")?.innerText?.slice(0, 80) || "", rows: document.querySelectorAll(".tp.active a, .tp.active [style*='border-bottom']").length }));
    console.log(`TAB ${tab}:`, JSON.stringify(info));
  } else console.log(`TAB ${tab}: (not present)`);
}
await browser.close();
process.exit(0);
