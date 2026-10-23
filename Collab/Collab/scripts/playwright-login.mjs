// Playwright login script for the CoLab app running under Docker.
//
//   node scripts/playwright-login.mjs
//
// Env (all optional):
//   BASE      app URL                (default http://localhost:3003 — Docker frontend)
//   EMAIL     account to sign in as  (default: create a fresh signup)
//   PASSWORD  password               (default Passw0rd!123)
//   SIGNUP    "1" to force sign-up even if EMAIL is set
//   HEADLESS  "1" to run headless    (default: headed, so you can watch + click)
//   KEEP      "1" to leave the browser open after login (Ctrl-C to quit)
//
// With no EMAIL it signs a brand-new account up (needs AUTH_SIGNUP_ENABLED=true
// on the backend), lands on the dashboard, and — if KEEP=1 — leaves the window
// open so you can click around and verify the icons.
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3003";
const PASSWORD = process.env.PASSWORD || "Passw0rd!123";
const HEADLESS = process.env.HEADLESS === "1";
const KEEP = process.env.KEEP === "1";
const doSignup = process.env.SIGNUP === "1" || !process.env.EMAIL;
const EMAIL = process.env.EMAIL || `pw-${Date.now()}@t.local`;
const NAME = process.env.NAME || "Playwright User";

const api = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// A fresh account is created through the REST API (deterministic), then the
// browser logs in through the real UI — mirroring a genuine user session.
if (doSignup) {
  const r = await api("/api/auth/signup", { email: EMAIL, password: PASSWORD, name: NAME });
  if (r.status >= 300 || !r.json?.data?.token) {
    console.error(
      `Sign-up failed (${r.status}). If it says signup is disabled, start the ` +
        `backend with AUTH_SIGNUP_ENABLED=true, or pass EMAIL=<existing account>.`,
    );
    console.error(JSON.stringify(r.json)?.slice(0, 200));
    process.exit(1);
  }
  console.log(`Created account: ${EMAIL} / ${PASSWORD}`);
}

const browser = await chromium.launch({ headless: HEADLESS });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", String(e.message).slice(0, 160)));

console.log(`Opening ${BASE} …`);
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });

// The sign-in form.
await page.waitForSelector('input[type="email"]', { timeout: 45000 });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button:has-text("Sign In"), button:has-text("Sign in")').catch(() => page.keyboard.press("Enter"));

// New signups get the org onboarding — skip it to land on the dashboard.
try {
  const skip = page.locator('button:has-text("Continue without an organization")');
  await skip.waitFor({ state: "visible", timeout: 12000 });
  await skip.click();
} catch { /* returning users skip straight in */ }

// The left nav rail (#rail) is the "we're in" signal.
await page.waitForSelector("#rail", { timeout: 60000 });
// Let the dashboard hydrate + paint before we call it done / screenshot.
await page.waitForSelector("#rail a, #rail button, #rail [role=button]", { timeout: 15000 }).catch(() => {});
await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
console.log(`✓ Logged in as ${EMAIL} — dashboard loaded.`);

// A quick screenshot as proof, saved next to the script.
const shot = new URL("./playwright-login.png", import.meta.url).pathname;
await page.screenshot({ path: shot });
console.log(`Screenshot: ${shot}`);

if (KEEP) {
  console.log("KEEP=1 — leaving the browser open. Press Ctrl-C here to close it.");
  await new Promise(() => {}); // hold open until the process is killed
} else {
  await browser.close();
  console.log("Done. (Set KEEP=1 to keep the window open for clicking around.)");
}
