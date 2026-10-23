// Repro #3: does a conversation vanish from the sidebar on a benign state change
// (mark read/unread) on the default "All" filter? Drive the real UI and count rows.
import { chromium } from "@playwright/test";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();
const BASE = "http://localhost:4000";
const emily = jwt.sign({ sub: "u_emily", userId: "u_emily" }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed a message into the emily↔marcus DM so it has a preview and is clearly listed.
async function seed() {
  const H = { Authorization: "Bearer " + emily, "Content-Type": "application/json" };
  const convs = (await (await fetch(BASE + "/api/conversations", { headers: H })).json()).data;
  const dm = convs.find((c) => c.kind === "dm" && (c.members || []).includes("u_marcus"));
  if (dm) await fetch(BASE + `/api/conversations/${dm.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text: "hello from emily " + Date.now() }) });
  return dm && dm.id;
}

const countRows = (page) => page.locator(".cv").count();
const marcusPresent = (page) => page.locator(".cv", { hasText: "Marcus" }).count();
async function clickMenuItem(page, rowName, label) {
  const row = page.locator(".cv", { hasText: rowName }).first();
  await row.hover();
  await sleep(150);
  await row.locator(".kebab-btn").click({ force: true });
  await sleep(300);
  await page.locator("#ctx-menu .ctx-item", { hasText: label }).first().click();
  await sleep(700);
}
async function marcusSendsToEmily(text) {
  const marcus = jwt.sign({ sub: "u_marcus", userId: "u_marcus" }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
  const H = { Authorization: "Bearer " + marcus, "Content-Type": "application/json" };
  const convs = (await (await fetch(BASE + "/api/conversations", { headers: H })).json()).data;
  const dm = convs.find((c) => c.kind === "dm" && (c.members || []).includes("u_emily"));
  if (dm) await fetch(BASE + `/api/conversations/${dm.id}/messages`, { method: "POST", headers: H, body: JSON.stringify({ text }) });
}

const dmId = await seed();
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addInitScript((t) => localStorage.setItem("clb_token", t), emily);
const page = await ctx.newPage();
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await sleep(3500);
await page.locator('button[aria-label="Messages"]').first().click();
await page.locator(".cv").first().waitFor({ timeout: 30000 });
await sleep(1500);

const activeFilter = await page.locator(".ft.active").first().textContent().catch(() => "?");
console.log(`active filter: "${activeFilter}" | rows: ${await countRows(page)} | Marcus present: ${await marcusPresent(page)}`);

await clickMenuItem(page, "Marcus", "Mark as unread");
console.log(`after Mark-as-unread -> rows: ${await countRows(page)} | Marcus present: ${await marcusPresent(page)}`);

await clickMenuItem(page, "Marcus", "Mark as read");
console.log(`after Mark-as-read   -> rows: ${await countRows(page)} | Marcus present: ${await marcusPresent(page)}`);

// Hide, then check a NEW incoming message resurfaces it (WhatsApp/Teams archive behavior).
await clickMenuItem(page, "Marcus", "Hide chat");
const afterHide = await marcusPresent(page);
console.log(`after Hide chat      -> rows: ${await countRows(page)} | Marcus present: ${afterHide}`);
await marcusSendsToEmily("ping after hide " + Date.now());
await sleep(2500); // allow socket MESSAGE_NEW to arrive
const afterPing = await marcusPresent(page);
console.log(`after incoming msg   -> rows: ${await countRows(page)} | Marcus present: ${afterPing}  (should resurface = 1)`);

await browser.close();
process.exit(0);
