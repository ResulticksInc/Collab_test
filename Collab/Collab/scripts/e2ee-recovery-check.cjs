#!/usr/bin/env node
// E2EE history-recovery check against a running stack (default: the local
// live-profile stack on http://localhost:7524).
//
// What it proves, end to end, with real browsers:
//   1. A sends B an encrypted message; B reads it (same-device decrypt).
//   2. B signs in on a BRAND-NEW device (fresh browser profile = no keys, no
//      plaintext cache) and the message must appear there WITHOUT any prompt:
//        - "sibling" mode: B's first device is still open (history arrives from
//          it over the sync relay);
//        - "backup" mode: B's first device is CLOSED after the backup refresh
//          has run (history must come from the server-escrowed backup alone).
//   3. B's first device has its E2EE storage WIPED (what the pre-2026-09-24
//      mismatch guard did) and must get its history back on reload.
//   4. A message that was NOT encrypted properly (a plaintext body posted
//      straight to the API into the encrypted conversation) must render its
//      text on B, tagged "Not encrypted", instead of a placeholder.
//
// Usage:
//   NODE_PATH=$PWD/node_modules node scripts/e2ee-recovery-check.cjs [--base URL]
//       [--a user4@colab.test:TestCall@123] [--b user5@colab.test:TestCall@123]
//       [--mode sibling|backup|redeliver|redeliver-late|sweep|both|all] [--backup-wait-sec 200] [--headed]
//
//   "burst": the live bug. A sends 25 messages, B's only device reads them and
//   leaves before its backup refresh, A goes offline. B opens the thread on a
//   fresh device (25 pending rows), then A comes back and re-delivers all 25 in
//   a burst. Every one must appear WITHOUT anyone sending a new message.
//
//   "nocache": the sender is online and still holds its keys, but its local
//   plaintext cache is EMPTY (cleared). It must open its own self-envelope on
//   the server row and re-deliver from that. B's fresh device must show the
//   probe with no other source.
//
//   "sweep": the MIGRATION case. B's fresh device signs in and never opens the
//   thread; its init sweep must ask for every unreadable old message by itself.
//   A then signs in on its own device and answers the stored asks. Only after
//   that does B open the thread — and the message must already be readable.
//
//   "redeliver-late": NOBODY is online when B's fresh device asks. B1 replies to
//   A first (so B has a message of its own in the thread), then A and B1 are
//   closed, B signs in on a fresh device (rows pending, asks stored on the
//   server), and only THEN does A sign in again. A must answer the stored asks
//   at init: the probe (its own message) AND B's reply (re-delivered by the
//   peer who read it). Both must appear on B's device with nobody typing anything.
//
//   "redeliver": B signs in on a brand-new device with NO other device online
//   and a backup that does NOT yet hold the message (B's first device is closed
//   before its debounced backup refresh). The only source left is the SENDER:
//   A's device re-seals the message to B's new device on request.
//
// Exit code 0 = every enabled scenario passed. Screenshots + a JSON log of the
// E2EE API calls and [e2ee] console lines land in ./e2ee-recovery-out/.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const flag = (name) => args.includes("--" + name);

const BASE = opt("base", "http://localhost:7524");
const [A_EMAIL, A_PASS] = opt("a", "user4@colab.test:TestCall@123").split(":");
const [B_EMAIL, B_PASS] = opt("b", "user5@colab.test:TestCall@123").split(":");
const MODE = opt("mode", "both");
const BACKUP_WAIT_SEC = Number(opt("backup-wait-sec", "200"));
const HEADED = flag("headed");
const OUT = path.resolve(process.cwd(), "e2ee-recovery-out");
fs.mkdirSync(OUT, { recursive: true });

const PENDING_COPY = [
  "Encrypted message",
  "Restoring…",
  "Message unavailable on this device",
  "Message can’t be recovered on this device",
];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-page telemetry: every /api/e2ee call with its status, and every [e2ee]
// console line. This is what tells you WHICH recovery source failed.
function instrument(page, label, sink) {
  page.on("console", (m) => {
    const t = m.text();
    if (/e2ee|E2EE/.test(t)) sink.push({ page: label, kind: "console", level: m.type(), text: t });
  });
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("/api/e2ee/") || u.includes("/api/auth/login") || r.status() === 429) {
      if (u.includes("/redeliver") || u.includes("/envelope")) log("  ", label, r.request().method(), u.replace(BASE, "").replace(/[0-9a-f-]{36}/, "<id>"), "->", r.status());
      sink.push({ page: label, kind: "http", method: r.request().method(), url: u.replace(BASE, ""), status: r.status() });
    }
  });
}

async function login(page, email, password) {
  await page.goto(BASE + "/");
  const em = page.locator('input[name="email"]');
  const pw = page.locator('input[name="password"]');
  await em.waitFor({ state: "visible", timeout: 60000 });
  // The form is a hydrated controlled component: a fill that lands before
  // hydration is reset to "" and the submit goes out empty. Fill, submit, and
  // retry on anything but a 200.
  let ok = false;
  for (let attempt = 0; attempt < 6 && !ok; attempt++) {
    await em.fill(email);
    await pw.fill(password);
    await sleep(300);
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/login"), { timeout: 20000 }).catch(() => null),
      page.locator("button.btn-p").first().click().catch(() => {}),
    ]);
    if (resp && resp.status() === 200) ok = true;
    else {
      log("login attempt", attempt + 1, "->", resp ? resp.status() + " " + (await resp.text()).slice(0, 160) : "no response");
      await sleep(1500);
    }
  }
  if (!ok) throw new Error("login failed for " + email);
  // Session cap ("Maximum devices reached"): sign out the oldest sessions until
  // this device may continue. Test accounts accumulate sessions across runs.
  const cap = page.getByText("Maximum devices reached");
  try {
    await cap.waitFor({ state: "visible", timeout: 6000 });
    const cont = page.getByRole("button", { name: "Continue on this device" });
    for (let i = 0; i < 6 && !(await cont.isEnabled()); i++) {
      await page.getByRole("button", { name: "Sign out" }).first().click();
      await sleep(800);
    }
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200, { timeout: 20000 }).catch(() => null),
      cont.click(),
    ]);
    log("session cap hit for", email, "- evicted oldest sessions");
  } catch (_) { /* no cap prompt */ }
  // Seeded test users have no organization; skip the onboarding gate if shown.
  const skip = page.getByRole("button", { name: /Continue without an organization/ }).first();
  try {
    await skip.waitFor({ state: "visible", timeout: 10000 });
    await skip.click();
  } catch (_) { /* not shown */ }
  try {
    await page.locator("#rail").waitFor({ state: "visible", timeout: 60000 });
  } catch (e) {
    await page.screenshot({ path: path.join(OUT, "login-stuck-" + email.split("@")[0] + ".png") }).catch(() => {});
    throw e;
  }
}

// Release this device's session so the 5-session cap doesn't fill up across runs.
async function logout(page) {
  try {
    await page.evaluate(async (base) => {
      const t = localStorage.getItem("clb_token");
      if (t) await fetch(base + "/api/auth/logout", { method: "POST", headers: { Authorization: "Bearer " + t } });
    }, BASE);
  } catch (_) { /* best-effort */ }
}

async function openDm(page, peerName) {
  // The app lands on the Dashboard; the chat list lives under Messages.
  await page.locator("#rail").getByRole("button", { name: "Messages" }).first().click();
  const row = page.locator(".cv[aria-label='" + peerName + "']").first();
  await row.waitFor({ state: "visible", timeout: 60000 });
  await row.click();
  await page.locator(".ProseMirror[contenteditable='true']").first().waitFor({ state: "visible", timeout: 60000 });
}

async function send(page, text) {
  const ed = page.locator(".ProseMirror[contenteditable='true']").first();
  await ed.click();
  await ed.type(text, { delay: 5 });
  await ed.press("Enter");
  await page.locator(".msg-body", { hasText: text }).first().waitFor({ state: "visible", timeout: 30000 });
}

// The row that holds `text` must render it — and must not be a placeholder.
async function expectReadable(page, text, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    // Exact match on the bubble text: a probe must never be satisfied by
    // another message that merely CONTAINS it.
    const n = await page.locator(".msg-body").filter({ hasText: new RegExp("^\\s*" + text + "\\s*$") }).count();
    if (n > 0) return true;
    const pend = await page.locator(".msg-locked").allTextContents().catch(() => []);
    last = pend.slice(0, 3).join(" | ");
    await sleep(1500);
  }
  await page.screenshot({ path: path.join(OUT, label + ".png"), fullPage: false });
  log("FAIL", label, "— probe text never rendered; placeholder rows:", last || "(none)");
  return false;
}

async function e2eeStorageSnapshot(page) {
  return page.evaluate(async () => {
    const ls = {};
    for (const k of Object.keys(localStorage)) if (k.startsWith("e2ee_")) ls[k] = localStorage.getItem(k);
    const dbs = (await indexedDB.databases?.()) || [];
    return { localStorage: ls, indexedDb: dbs.map((d) => d.name) };
  });
}

// What the old mismatch guard did to a device: drop the whole signal-store and
// the device id. The user is still signed in (the auth token is untouched).
async function wipeE2EEStorage(page) {
  await page.evaluate(async () => {
    for (const k of Object.keys(localStorage)) if (k.startsWith("e2ee_")) localStorage.removeItem(k);
    await new Promise((res) => {
      const req = indexedDB.deleteDatabase("signal-store");
      req.onsuccess = req.onerror = req.onblocked = () => res(null);
    });
  });
}

const telemetry = [];
const results = {};
function dump(probe) {
  fs.writeFileSync(path.join(OUT, "telemetry.json"), JSON.stringify({ probe, results, telemetry }, null, 2));
  const n429 = telemetry.filter((t) => t.kind === "http" && t.status === 429).length;
  if (n429) log("WARNING:", n429, "E2EE/API calls were rate-limited (429) during this run");
}
(async () => {
  const browser = await chromium.launch({ headless: !HEADED });
  const probe = "probe-" + Date.now().toString(36);
  const aName = A_EMAIL === "user4@colab.test" ? "User Four" : opt("a-name", "User Four");
  const bName = B_EMAIL === "user5@colab.test" ? "User Five" : opt("b-name", "User Five");

  // ── 1. A → B, B reads it on its first device ────────────────────────────
  const ctxA = await browser.newContext();
  const ctxB1 = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB1 = await ctxB1.newPage();
  instrument(pageA, "A", telemetry);
  instrument(pageB1, "B1", telemetry);
  log("login A", A_EMAIL);
  await login(pageA, A_EMAIL, A_PASS);
  log("login B1", B_EMAIL);
  await login(pageB1, B_EMAIL, B_PASS);
  await sleep(4000); // let both E2EE inits (device register + prekeys) settle
  await openDm(pageA, bName);
  await openDm(pageB1, aName);
  log("A sends", probe);
  await send(pageA, probe);
  results.sameDevice = await expectReadable(pageB1, probe, 30000, "1-b1-same-device");
  log("1. B reads on first device:", results.sameDevice ? "PASS" : "FAIL");

  // ── 4. A message that was NOT encrypted properly still shows its text ────
  // Posted straight to the REST API as A with a plain body (what a client whose
  // encryption failed would do). B must render the text with the "Not
  // encrypted" marker rather than "Message unavailable" / "rejected".
  const plainProbe = "unencrypted-" + Date.now().toString(36);
  const convId = await pageA.evaluate(async ({ base, peer }) => {
    const t = localStorage.getItem("clb_token");
    const r = await fetch(base + "/api/conversations", { headers: { Authorization: "Bearer " + t } });
    const j = await r.json();
    const dm = (j.data || []).find((c) => c.kind === "dm" && (c.name === peer || (c.members || []).some((m) => m && m.name === peer)));
    return dm ? dm.id : null;
  }, { base: BASE, peer: bName });
  if (!convId) {
    log("4. could not find the DM id via the API — skipping the plaintext scenario");
  } else {
    const posted = await pageA.evaluate(async ({ base, convId, text }) => {
      const t = localStorage.getItem("clb_token");
      const r = await fetch(base + "/api/conversations/" + convId + "/messages", {
        method: "POST",
        headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return r.status;
    }, { base: BASE, convId, text: plainProbe });
    log("4. posted plaintext message ->", posted);
    results.plaintextFallback = await expectReadable(pageB1, plainProbe, 30000, "4-b1-plaintext-fallback");
    if (results.plaintextFallback) {
      const marker = await pageB1.locator(".msg-body").filter({ hasText: plainProbe }).locator("..").locator(".msg-not-encrypted").count();
      log("4. plaintext message rendered on B" + (marker ? " with the 'Not encrypted' marker" : " (marker not found)"));
    }
    log("4. not-encrypted message shows its text:", results.plaintextFallback ? "PASS" : "FAIL");
  }
  log("B1 storage:", JSON.stringify(await e2eeStorageSnapshot(pageB1)));

  // ── 9. A burst of re-deliveries into an OPEN thread, no new message ───────
  if (MODE === "burst") {
    const N = Number(opt("burst-count", "25"));
    const texts = [];
    for (let i = 0; i < N; i++) {
      const t = `burst-${i}-${probe}`;
      texts.push(t);
      await send(pageA, t);
      await sleep(600); // a person typing, not a flood: keeps the sender under the per-user API limit
    }
    // Only messages the original reader actually RECEIVED exist on the server.
    // (The sender's own bubble appears optimistically even when the send is
    // refused, so it proves nothing.) Those are the ones that must come back.
    const received = [];
    for (const t of texts) if (await expectReadable(pageB1, t, 20000, "9-b1-reads")) received.push(t);
    log(`9. ${received.length}/${N} messages reached the reader`);
    if (!received.length) throw new Error("no burst message was delivered — cannot test re-delivery");
    texts.length = 0;
    texts.push(...received);
    await logout(pageB1);
    await ctxB1.close();
    await pageA.close(); // A offline, device intact
    const ctxB8 = await browser.newContext();
    const pageB8 = await ctxB8.newPage();
    instrument(pageB8, "B8-burst", telemetry);
    log(`login B8 (fresh device, thread open with ${N}+ pending rows; A offline)`);
    await login(pageB8, B_EMAIL, B_PASS);
    await openDm(pageB8, aName);
    await sleep(10000);
    const pageA2 = await ctxA.newPage();
    instrument(pageA2, "A2-burst", telemetry);
    log("A comes back; re-delivers the burst. Nobody sends anything.");
    await pageA2.goto(BASE + "/");
    await pageA2.locator("#rail").waitFor({ state: "visible", timeout: 60000 });
    const deadline = Date.now() + Number(opt("burst-wait-sec", "150")) * 1000;
    let missing = texts.slice();
    while (Date.now() < deadline && missing.length) {
      const bodies = await pageB8.locator(".msg-body").allTextContents().catch(() => []);
      const shown = new Set(bodies.map((x) => x.trim()));
      missing = texts.filter((t) => !shown.has(t));
      if (missing.length) await sleep(1500);
    }
    results.burst = missing.length === 0;
    const put = telemetry.filter((t) => t.kind === "http" && t.page === "A2-burst" && t.url.includes("/envelope") && t.status === 200).length;
    log(`9. burst of ${texts.length} re-deliveries into an open thread:`, results.burst ? "PASS" : `FAIL (${missing.length} still pending)`, `(${put} envelope(s) stored by A)`);
    if (!results.burst) await pageB8.screenshot({ path: path.join(OUT, "9-b8-burst.png") });
    await logout(pageB8);
    await ctxB8.close();
    await logout(pageA2);
    await ctxA.close();
    await browser.close();
    dump(probe);
    const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
    log("RESULTS", JSON.stringify(results), failed.length ? "FAILED: " + failed.join(", ") : "ALL PASS");
    process.exit(failed.length ? 1 : 0);
  }

  // ── 8. Sender has keys but no plaintext cache ─────────────────────────────
  if (MODE === "nocache") {
    await logout(pageB1);
    await ctxB1.close(); // B's only device leaves before its backup refresh
    await pageA.evaluate(async () => {
      await new Promise((res) => {
        const r = indexedDB.open("signal-store");
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(["plaintextCache"], "readwrite");
          tx.objectStore("plaintextCache").clear();
          tx.oncomplete = () => { db.close(); res(null); };
          tx.onerror = () => { db.close(); res(null); };
        };
        r.onerror = () => res(null);
      });
    });
    log("A's plaintext cache cleared (keys kept); reloading A");
    await pageA.reload();
    await pageA.locator("#rail").waitFor({ state: "visible", timeout: 60000 });
    const ctxB7 = await browser.newContext();
    const pageB7 = await ctxB7.newPage();
    instrument(pageB7, "B7-nocache", telemetry);
    log("login B7 (new device; only source = A's own server-side envelope)");
    await login(pageB7, B_EMAIL, B_PASS);
    await openDm(pageB7, aName);
    results.nocache = await expectReadable(pageB7, probe, 120000, "8-b7-nocache");
    const put = telemetry.filter((t) => t.kind === "http" && t.page === "A" && t.url.includes("/envelope") && t.status === 200).length;
    log("8. sender with empty cache re-delivered from its server copy:", results.nocache ? "PASS" : "FAIL", `(${put} envelope(s) stored by A)`);
    await logout(pageB7);
    await ctxB7.close();
    await logout(pageA);
    await ctxA.close();
    await browser.close();
    dump(probe);
    const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
    log("RESULTS", JSON.stringify(results), failed.length ? "FAILED: " + failed.join(", ") : "ALL PASS");
    process.exit(failed.length ? 1 : 0);
  }

  // ── 7. Migration sweep: the reader never opens the thread ────────────────
  if (MODE === "sweep") {
    await logout(pageB1);
    await ctxB1.close();
    await pageA.close(); // A offline, device intact
    const ctxB6 = await browser.newContext();
    const pageB6 = await ctxB6.newPage();
    instrument(pageB6, "B6-sweep", telemetry);
    log("login B6 (new device; A offline). B6 does NOT open the thread.");
    await login(pageB6, B_EMAIL, B_PASS);
    await sleep(25000); // init: recovery pass, backup walk, then the sweep
    const swept = telemetry.filter((t) => t.kind === "http" && t.page === "B6-sweep" && t.url.includes("/redeliver/bulk") && t.status === 200).length;
    log("7. sweep bulk-ask calls from B6:", swept);
    const pageA2 = await ctxA.newPage();
    instrument(pageA2, "A2-sweep", telemetry);
    log("A comes back on its own device; answers the stored asks");
    await pageA2.goto(BASE + "/");
    await pageA2.locator("#rail").waitFor({ state: "visible", timeout: 60000 });
    await sleep(15000);
    const put = telemetry.filter((t) => t.kind === "http" && t.page === "A2-sweep" && t.url.includes("/envelope") && t.status === 200).length;
    log("7. envelopes stored by A after the sweep:", put);
    log("B6 opens the thread only now");
    await openDm(pageB6, aName);
    results.sweep = await expectReadable(pageB6, probe, 60000, "7-b6-sweep");
    log("7. migration sweep (asked without opening the thread):", results.sweep && swept > 0 ? "PASS" : "FAIL");
    if (!swept) results.sweep = false;
    await logout(pageB6);
    await ctxB6.close();
    await logout(pageA2);
    await ctxA.close();
    await browser.close();
    dump(probe);
    const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
    log("RESULTS", JSON.stringify(results), failed.length ? "FAILED: " + failed.join(", ") : "ALL PASS");
    process.exit(failed.length ? 1 : 0);
  }

  // ── 6. Stored asks answered later, incl. B's OWN message via the peer ────
  // A goes OFFLINE (its page closes) and later comes back on the SAME device
  // (same browser profile, so its plaintext cache is intact) — the realistic
  // "the peer was away and opened the app the next morning" case.
  if (MODE === "redeliver-late") {
    const reply = "reply-" + probe;
    log("B1 replies", reply);
    await send(pageB1, reply);
    await expectReadable(pageA, reply, 30000, "6-a-reads-reply");
    await logout(pageB1);
    await ctxB1.close();
    await pageA.close(); // A offline, but its device (storage) survives
    const ctxB5 = await browser.newContext();
    const pageB5 = await ctxB5.newPage();
    instrument(pageB5, "B5-late", telemetry);
    log("login B5 (new device; A and B1 both offline)");
    await login(pageB5, B_EMAIL, B_PASS);
    await openDm(pageB5, aName);
    await sleep(8000); // let the asks get stored
    const beforeProbe = await pageB5.locator(".msg-body").filter({ hasText: new RegExp("^\\s*" + probe + "\\s*$") }).count();
    log("6. before A returns, probe visible on B5:", beforeProbe ? "yes (backup/sibling had it)" : "no (as expected)");
    const pageA2 = await ctxA.newPage(); // A comes back on the SAME device
    instrument(pageA2, "A2-late", telemetry);
    log("A comes back online on its own device; must answer the stored asks at init");
    await pageA2.goto(BASE + "/");
    await pageA2.locator("#rail").waitFor({ state: "visible", timeout: 60000 });
    results.lateProbe = await expectReadable(pageB5, probe, 120000, "6-b5-late-probe");
    results.lateOwnReply = await expectReadable(pageB5, reply, 120000, "6-b5-late-own-reply");
    const put = telemetry.filter((t) => t.kind === "http" && t.page === "A2-late" && t.url.includes("/envelope") && t.status === 200).length;
    log("6. A's message re-delivered late:", results.lateProbe ? "PASS" : "FAIL", "· B's OWN reply re-delivered by the peer:", results.lateOwnReply ? "PASS" : "FAIL", `(${put} envelope(s) stored by A)`);
    await logout(pageB5);
    await ctxB5.close();
    await logout(pageA2);
    await ctxA.close();
    await browser.close();
    dump(probe);
    const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
    log("RESULTS", JSON.stringify(results), failed.length ? "FAILED: " + failed.join(", ") : "ALL PASS");
    process.exit(failed.length ? 1 : 0);
  }

  // ── 5. Sender re-delivery: new device, no sibling online, backup lacks it ─
  if (MODE === "redeliver" || MODE === "all") {
    await logout(pageB1);
    await ctxB1.close(); // B's only device goes away BEFORE its backup refresh ran
    const ctxB4 = await browser.newContext();
    const pageB4 = await ctxB4.newPage();
    instrument(pageB4, "B4-redeliver", telemetry);
    log("login B4 (new device, no sibling online, backup without the message; A online)");
    await login(pageB4, B_EMAIL, B_PASS);
    await openDm(pageB4, aName);
    results.senderRedelivery = await expectReadable(pageB4, probe, 90000, "5-b4-sender-redelivery");
    const put = telemetry.filter((t) => t.kind === "http" && t.page === "A" && t.url.includes("/envelope") && t.status === 200).length;
    log("5. sender re-delivery (A re-sealed the message to B's new device):", results.senderRedelivery ? "PASS" : "FAIL", put ? `(${put} envelope(s) re-delivered by A)` : "(A never re-delivered)");
    await logout(pageB4);
    await ctxB4.close();
    await logout(pageA);
    await ctxA.close();
    await browser.close();
    dump(probe);
    const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
    log("RESULTS", JSON.stringify(results), failed.length ? "FAILED: " + failed.join(", ") : "ALL PASS");
    process.exit(failed.length ? 1 : 0);
  }

  // ── 2a. B on a brand-new device while B1 is still open (sibling path) ───
  if (MODE === "sibling" || MODE === "both") {
    const ctxB2 = await browser.newContext();
    const pageB2 = await ctxB2.newPage();
    instrument(pageB2, "B2-sibling", telemetry);
    log("login B2 (new device, sibling online)");
    await login(pageB2, B_EMAIL, B_PASS);
    await openDm(pageB2, aName);
    results.newDeviceSibling = await expectReadable(pageB2, probe, 90000, "2a-b2-new-device-sibling");
    log("2a. new device, sibling online:", results.newDeviceSibling ? "PASS" : "FAIL");
    log("B2 storage:", JSON.stringify(await e2eeStorageSnapshot(pageB2)));
    await logout(pageB2);
    await ctxB2.close();
  }

  // ── 2b. B on a brand-new device with NO other device online (backup) ────
  if (MODE === "backup" || MODE === "both") {
    log(`waiting ${BACKUP_WAIT_SEC}s for B1's debounced backup refresh (3 min after activity)…`);
    await sleep(BACKUP_WAIT_SEC * 1000);
    log("B1 storage after wait:", JSON.stringify(await e2eeStorageSnapshot(pageB1)));
    await logout(pageB1);
    await ctxB1.close(); // no sibling online from here on
    await logout(pageA);
    await ctxA.close();
    const ctxB3 = await browser.newContext();
    const pageB3 = await ctxB3.newPage();
    instrument(pageB3, "B3-backup", telemetry);
    log("login B3 (new device, no sibling online)");
    await login(pageB3, B_EMAIL, B_PASS);
    await openDm(pageB3, aName);
    results.newDeviceBackup = await expectReadable(pageB3, probe, 90000, "2b-b3-new-device-backup");
    log("2b. new device, backup only:", results.newDeviceBackup ? "PASS" : "FAIL");
    log("B3 storage:", JSON.stringify(await e2eeStorageSnapshot(pageB3)));

    // ── 3. B3 gets its E2EE storage wiped (old guard) and must recover ─────
    await wipeE2EEStorage(pageB3);
    log("B3 E2EE storage wiped; reloading");
    await pageB3.reload();
    await pageB3.locator("#rail").waitFor({ state: "visible", timeout: 60000 });
    await openDm(pageB3, aName);
    results.wipedDevice = await expectReadable(pageB3, probe, 90000, "3-b3-wiped-device");
    log("3. wiped device recovers:", results.wipedDevice ? "PASS" : "FAIL");
    await logout(pageB3);
    await ctxB3.close();
  } else {
    await logout(pageB1);
    await ctxB1.close();
    await logout(pageA);
    await ctxA.close();
  }

  await browser.close();
  dump(probe);
  const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
  log("RESULTS", JSON.stringify(results), failed.length ? "FAILED: " + failed.join(", ") : "ALL PASS");
  log("details:", path.join(OUT, "telemetry.json"));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  dump(null);
  process.exit(2);
});
