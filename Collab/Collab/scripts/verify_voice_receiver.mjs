// End-to-end voice RECEIVER test: marcus sends a voice note; emily (the other
// member) opens the DM and must see the duration and be able to play it.
import { chromium } from "@playwright/test";
import { io } from "socket.io-client";
import jwt from "jsonwebtoken";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();
const BASE = "http://localhost:4000";
const tok = (u) => jwt.sign({ sub: u, userId: u }, process.env.AUTH_JWT_SECRET, { expiresIn: "1d" });
const EV = { MESSAGE_SEND: "message:send", CONVERSATION_JOIN: "conversation:join" };
const DM = "fb89ae13-c255-498b-83fc-d2e262378bc3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// marcus uploads + sends a voice message
const bytes = fs.readFileSync("scripts/test_tone.wav");
const qs = new URLSearchParams({ name: "Voice Message.wav", mime: "audio/wav", conversationId: DM });
const up = await (await fetch(BASE + "/api/files?" + qs, { method: "POST", headers: { "Content-Type": "audio/wav", Authorization: "Bearer " + tok("u_marcus") }, body: bytes })).json();
const fileId = (up.data || up).id;
await new Promise((res) => {
  const s = io(BASE, { auth: { token: tok("u_marcus") }, transports: ["websocket"] });
  s.on("connect", () => {
    s.emit(EV.CONVERSATION_JOIN, { conversationId: DM });
    s.emit(EV.MESSAGE_SEND, { conversationId: DM, type: "voice", voice: { fileId, duration: 5, waveform: null, mimeType: "audio/webm" }, file: up.data || up });
    setTimeout(() => { s.disconnect(); res(); }, 1500);
  });
});
console.log("marcus sent voice note, fileId:", fileId);

// emily opens the DM and verifies playback
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
// open the Marcus DM
await page.locator(".cv", { hasText: "Marcus" }).first().click().catch(() => {});
await page.locator(".mw:has(audio)").last().waitFor({ timeout: 15000 });
await sleep(1000);
const row = page.locator(".mw:has(audio)").last();
const durLabel = await row.locator("span").filter({ hasText: /^\d+:\d{2}$/ }).first().textContent().catch(() => "(none)");
await row.locator(".bub:has(audio) button").first().click();
await sleep(2500);
const play = await page.evaluate(() => { const a = [...document.querySelectorAll("audio")].pop(); return a ? { scheme: (a.currentSrc || a.src).split(":")[0], paused: a.paused, t: +a.currentTime.toFixed(2), err: a.error?.code ?? null } : null; });
console.log("emily duration label:", durLabel);
console.log("emily playback:", JSON.stringify(play), "| download statuses:", dl);
console.log(play && play.scheme === "blob" && play.err === null ? "RESULT: receiver playback WORKS ✓" : "RESULT: receiver playback ✗");
await browser.close();
process.exit(0);
