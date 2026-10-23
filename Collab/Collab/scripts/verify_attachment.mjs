// #9/#10: marcus sends an IMAGE attachment; emily (receiver) must preview it.
import { chromium } from "@playwright/test";
import { io } from "socket.io-client";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();
const BASE = "http://localhost:4000";
const tok = (u) => jwt.sign({ sub: u, userId: u }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
const EV = { MESSAGE_SEND: "message:send", CONVERSATION_JOIN: "conversation:join" };
const DM = "fb89ae13-c255-498b-83fc-d2e262378bc3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a valid 1x1 PNG
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const qs = new URLSearchParams({ name: "photo.png", mime: "image/png", conversationId: DM });
const up = await (await fetch(BASE + "/api/files?" + qs, { method: "POST", headers: { "Content-Type": "image/png", Authorization: "Bearer " + tok("u_marcus") }, body: png })).json();
const meta = up.data || up;
console.log("marcus uploaded image:", meta.id, meta.mime);
await new Promise((res) => {
  const s = io(BASE, { auth: { token: tok("u_marcus") }, transports: ["websocket"] });
  s.on("connect", () => {
    s.emit(EV.CONVERSATION_JOIN, { conversationId: DM });
    s.emit(EV.MESSAGE_SEND, { conversationId: DM, file: meta });
    setTimeout(() => { s.disconnect(); res(); }, 1500);
  });
});

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addInitScript((t) => localStorage.setItem("clb_token", t), tok("u_emily"));
const page = await ctx.newPage();
const dl = [];
page.on("response", (r) => { if (r.url().includes("/download")) dl.push(r.status()); });
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await sleep(3500);
await page.locator('button[aria-label="Messages"]').first().click();
await sleep(1500);
await page.locator(".cv", { hasText: "Marcus" }).first().click().catch(() => {});
await sleep(2500);
const img = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".msgs img")].pop();
  if (!el) return null;
  return { scheme: (el.currentSrc || el.src).split(":")[0], naturalWidth: el.naturalWidth, complete: el.complete };
});
console.log("emily image element:", JSON.stringify(img), "| download statuses:", dl);
console.log(img && img.scheme === "blob" && img.naturalWidth > 0 ? "RESULT: receiver image preview WORKS ✓" : "RESULT: image preview ✗");
await browser.close();
process.exit(0);
