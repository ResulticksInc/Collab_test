// Lightweight, self-hosted update engine — zero extra infrastructure.
//
// Instead of running an electron-updater feed server, the desktop fetches a tiny
// JSON manifest (cfg.updateUrl, default <webUrl>/desktop/latest.json; the beta
// channel fetches latest-beta.json — see config.js channel derivation) and compares
// its `version` to the installed app version. If newer, it downloads the installer
// IN-APP and (Windows) runs it silently, then relaunches — no browser round-trip,
// no manually-run setup. NSIS upgrade preserves data + login. Fully offline-capable.
//
// Two surfaces, one engine:
//   • IN-APP (source "auto"/"app") — emits `update:event` IPC to the renderer so the
//     web app can render a premium progress UI (checking → available → downloading %
//     → downloaded → "Restart to update"). Auto-update ON downloads in the background
//     and just surfaces the restart prompt; OFF waits for an explicit download.
//   • NATIVE  (source "menu") — the OS "Check for Updates…" menu item keeps the
//     classic native dialogs so there is always a working path even before the web
//     app carrying the in-app UI is deployed.
//
// Manifest shape:
//   { "version": "1.1.0",
//     "url": "https://collab.resulticks.com/desktop/Collab%20Setup%201.1.0.exe",
//     "notes": "What's new…" }

const { app, dialog, shell, net, powerMonitor } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const log = require("./logger");

// Compare two dotted versions. Returns 1 if a>b, -1 if a<b, 0 if equal. Tolerates a
// leading "v" ("v1.0.3") and a prerelease suffix ("1.0.3-beta.1"): the numeric core
// decides first, then a release outranks its own prerelease (1.0.3 > 1.0.3-beta.1).
function cmpVersion(a, b) {
  const split = (v) => {
    const m = String(v || "0").trim().replace(/^v/i, "").split(/[-+]/);
    return { core: m[0].split(".").map((n) => parseInt(n, 10) || 0), pre: m[1] || "" };
  };
  const A = split(a), B = split(b);
  for (let i = 0; i < Math.max(A.core.length, B.core.length); i++) {
    const x = A.core[i] || 0, y = B.core[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1;
  if (!B.pre) return -1;
  return A.pre > B.pre ? 1 : -1;
}

// The update discovered by the most recent check (module-level so the renderer's
// download/install IPC can act on it without re-checking). filePath is set once the
// installer has been downloaded to temp.
let pending = null; // { version, notes, dlUrl, filePath }
let downloading = false;
let wantInstall = false; // user asked to install while a download was still in flight
let lastEvent = null; // last lifecycle event, replayed to a late-mounting renderer

// Emit an update lifecycle event to the renderer's premium UI. Safe no-op if the
// window is gone. Types: checking | available | downloading | downloaded | uptodate
// | installing | error. `downloading` carries { percent, transferred, total }.
function emit(win, payload) {
  lastEvent = payload;
  try {
    if (win && !win.isDestroyed()) win.webContents.send("update:event", payload);
  } catch { /* window torn down mid-flight */ }
}

// The current actionable update state, for a renderer that mounts AFTER the events
// fired (e.g. the user logs in after the silent startup check). Transient states
// (checking/uptodate) are not replayed — only states the banner should still show.
function currentState() {
  if (lastEvent && ["available", "downloading", "downloaded", "installing", "error"].includes(lastEvent.type)) {
    return lastEvent;
  }
  return null;
}

function fetchManifest(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    try {
      // Bypass Chromium's HTTP cache: a stale latest.json (CDN/nginx max-age, or a
      // cached copy from before the release was published) would hide a new version.
      const u = new URL(url);
      u.searchParams.set("_", String(Date.now()));
      const req = net.request({ method: "GET", url: u.href });
      req.setHeader("Cache-Control", "no-cache");
      req.setHeader("Pragma", "no-cache");
      const t = setTimeout(() => { try { req.abort(); } catch {} done(reject, new Error("timeout")); }, timeoutMs);
      req.on("response", (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          clearTimeout(t);
          res.on("data", () => {});
          return done(reject, new Error("HTTP " + res.statusCode));
        }
        res.on("data", (c) => { chunks.push(Buffer.from(c)); });
        res.on("aborted", () => { clearTimeout(t); done(reject, new Error("connection dropped")); });
        res.on("error", (e) => { clearTimeout(t); done(reject, e); });
        res.on("end", () => {
          clearTimeout(t);
          try { done(resolve, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (e) { done(reject, e); }
        });
      });
      req.on("error", (e) => { clearTimeout(t); done(reject, e); });
      req.end();
    } catch (e) { done(reject, e); }
  });
}

// Pick the installer URL for THIS OS from the manifest's per-OS `channels`, falling
// back to the flat top-level `url` (older/single-OS manifests). Without this a
// macOS/Linux app would download the Windows .exe on "check for updates".
function pickDownloadUrl(manifest) {
  const ch = (manifest && manifest.channels) || {};
  try {
    if (process.platform === "win32") {
      return (ch.windows && ch.windows.x64 && ch.windows.x64.installer) || manifest.url;
    }
    if (process.platform === "darwin") {
      return (
        (ch.mac &&
          ((ch.mac.universal && ch.mac.universal.installer) ||
            (ch.mac.x64 && ch.mac.x64.installer))) ||
        manifest.url
      );
    }
    // Linux (and any other platform): prefer AppImage, then .deb.
    return (
      (ch.linux && ch.linux.x64 && (ch.linux.x64.appimage || ch.linux.x64.deb)) ||
      manifest.url
    );
  } catch {
    return manifest.url;
  }
}

// Resolve a possibly-RELATIVE installer URL (the manifest uses same-origin
// "/desktop/…" paths so the web download works on any host) into an absolute URL
// against the manifest's origin — net.request + new URL() below need absolute.
function resolveDl(url, base) {
  if (!url) return url;
  try { return new URL(url, base).href; } catch { return url; }
}

// AUDIT #13: the SHA-256 the manifest declares for THIS OS's installer (mirrors
// pickDownloadUrl). Manifests without a digest return null → the caller fails the
// SILENT auto-install closed (never runs an unverified installer).
function pickExpectedHash(manifest) {
  const ch = (manifest && manifest.channels) || {};
  try {
    if (process.platform === "win32")
      return (ch.windows && ch.windows.x64 && ch.windows.x64.sha256) || manifest.sha256 || null;
    if (process.platform === "darwin")
      return (
        (ch.mac &&
          ((ch.mac.universal && ch.mac.universal.sha256) ||
            (ch.mac.x64 && ch.mac.x64.sha256))) ||
        manifest.sha256 || null
      );
    return (ch.linux && ch.linux.x64 && ch.linux.x64.sha256) || manifest.sha256 || null;
  } catch {
    return manifest && manifest.sha256 ? manifest.sha256 : null;
  }
}

// AUDIT #13: is `url` on the SAME origin the (HTTPS) manifest came from? The
// installer must not come from an attacker-supplied absolute URL or a cross-origin
// redirect — same-origin + HTTPS is what makes a manifest-carried hash trustworthy.
function sameOrigin(url, expectedOrigin) {
  try { return new URL(url).origin === expectedOrigin; } catch { return false; }
}

// AUDIT #13: stream-hash a downloaded file and compare (case-insensitive hex) to the
// manifest's expected SHA-256. Resolves true only on an exact match.
function verifyHash(filePath, expectedHex) {
  return new Promise((resolve) => {
    if (!expectedHex || typeof expectedHex !== "string") return resolve(false);
    try {
      const h = crypto.createHash("sha256");
      const s = fs.createReadStream(filePath);
      s.on("error", () => resolve(false));
      s.on("data", (d) => h.update(d));
      s.on("end", () =>
        resolve(h.digest("hex").toLowerCase() === expectedHex.trim().toLowerCase()),
      );
    } catch {
      resolve(false);
    }
  });
}

// Stream a URL to a file, reporting progress BOTH on the OS taskbar/dock arc AND —
// via onProgress — to the in-app UI. net.request follows redirects (CDN/S3)
// automatically. Resolves with the destination path.
function downloadWithProgress(url, destPath, win, onProgress, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const clearBar = () => { try { if (win && !win.isDestroyed()) win.setProgressBar(-1); } catch {} };
    // Always release the write stream on settle — the failure exits (non-2xx,
    // res/req error, timeout) otherwise leak the fd and leave a partial temp file.
    // On success the stream is already end()'d, so destroy() just frees resources.
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearBar();
      try { if (file && !file.destroyed) file.destroy(); } catch {}
      fn(v);
    };
    let file;
    try {
      file = fs.createWriteStream(destPath);
    } catch (e) { return reject(e); }
    file.on("error", (e) => done(reject, e));
    const req = net.request(url);
    const t = setTimeout(() => { try { req.abort(); } catch {} done(reject, new Error("timeout")); }, timeoutMs);
    req.on("response", (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(t);
        res.on("data", () => {});
        return done(reject, new Error("HTTP " + res.statusCode));
      }
      const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        file.write(chunk);
        if (total) {
          const frac = received / total;
          if (win && !win.isDestroyed()) { try { win.setProgressBar(frac); } catch {} }
          if (onProgress) { try { onProgress(frac, received, total); } catch {} }
        }
      });
      res.on("end", () => {
        clearTimeout(t);
        // A connection cut mid-stream can surface as a clean "end" — never accept a
        // short file (the hash check would reject it later, but fail fast + clearly).
        if (total && received < total) return done(reject, new Error("download incomplete"));
        file.end(() => done(resolve, destPath));
      });
      // net's IncomingMessage emits "aborted" (not "end") when the socket drops;
      // without this the promise hung until the 10-minute timeout.
      res.on("aborted", () => { clearTimeout(t); done(reject, new Error("connection dropped")); });
      res.on("error", (e) => { clearTimeout(t); done(reject, e); });
    });
    req.on("error", (e) => { clearTimeout(t); done(reject, e); });
    req.end();
  });
}

// Where the downloaded installer for `version` lands (temp, sanitized name).
function installerDest(version, dlUrl) {
  const isWin = process.platform === "win32";
  let ext = isWin ? ".exe" : ".dmg";
  try { ext = path.extname(new URL(dlUrl).pathname) || ext; } catch {}
  return path.join(app.getPath("temp"), `Collab-Setup-${String(version).replace(/[^\w.-]/g, "")}${ext}`);
}

// Launch the downloaded installer and quit so it can finish + relaunch. Windows:
// silent NSIS. A bare "/S" install does NOT relaunch the app (electron-builder only
// auto-runs it on silent installs when told to), so pass the same flags electron-updater
// does: --updated (this is an upgrade) and --force-run (start Collab when finished).
// macOS: open the package for the final step. Anything else falls back to the browser.
function runInstaller(filePath, dlUrl, win) {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const fail = (msg) => {
    log.info("Failed to launch installer:", msg);
    emit(win, { type: "error", stage: "install", message: "Couldn't start the installer — opening the download instead.", url: dlUrl });
    shell.openExternal(dlUrl).catch(() => {});
  };
  try {
    if (isWin) {
      emit(win, { type: "installing" });
      const child = spawn(filePath, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore" });
      let failed = false;
      // spawn() reports ENOENT/EACCES/EPERM (AV quarantine) asynchronously; don't quit
      // the app out from under the user if the installer never started.
      child.on("error", (e) => { failed = true; fail(e && e.message); });
      child.unref();
      setTimeout(() => { if (!failed) { try { app.quit(); } catch {} } }, 1200);
    } else if (isMac) {
      // The app keeps running (the .pkg/.dmg flow is user-driven), so tell the UI to
      // show a dismissible "finish in the installer" state rather than a permanent
      // "Installing…" spinner.
      emit(win, { type: "installing", manual: true });
      shell.openPath(filePath).then((err) => { if (err) fail(err); });
    } else {
      shell.openExternal(dlUrl).catch(() => {});
    }
  } catch (e) {
    fail(e && e.message);
  }
}

// Download the pending update to temp, streaming progress to the in-app UI. Used by
// BOTH the auto path (background) and the renderer's explicit "Download" action.
// Resolves the file path (or null on failure). Idempotent while in flight.
async function startDownload(win) {
  if (!pending || !pending.dlUrl) return null;
  if (pending.filePath && fs.existsSync(pending.filePath)) {
    emit(win, { type: "downloaded", version: pending.version, notes: pending.notes });
    return pending.filePath;
  }
  if (downloading) return null;
  // Non-Windows/mac (Linux) has no silent installer path — send the user to the
  // browser download and let the renderer surface the "available" state only.
  if (process.platform !== "win32" && process.platform !== "darwin") {
    shell.openExternal(pending.dlUrl).catch(() => {});
    return null;
  }
  downloading = true;
  // Snapshot: a concurrent re-check can replace/clear the module-level `pending`
  // (e.g. the server rolled back the manifest) while bytes are still streaming.
  const job = pending;
  const dest = installerDest(job.version, job.dlUrl);
  emit(win, { type: "downloading", version: job.version, percent: 0, transferred: 0, total: 0 });
  try {
    await downloadWithProgress(job.dlUrl, dest, win, (frac, received, total) => {
      emit(win, {
        type: "downloading",
        version: job.version,
        percent: Math.max(0, Math.min(100, Math.round(frac * 100))),
        transferred: received,
        total,
      });
    });
    // AUDIT #13: HASH-PIN — verify the downloaded bytes match the manifest's declared
    // SHA-256 BEFORE the installer is ever executed. Fails CLOSED: a missing hash or a
    // mismatch deletes the temp file and refuses to run — we never spawn an unverified
    // installer (the whole point: tamper-evidence against a swapped/redirected file).
    const verified = await verifyHash(dest, job.sha256);
    if (!verified) {
      downloading = false;
      wantInstall = false;
      try { fs.unlinkSync(dest); } catch {}
      const why = job.sha256
        ? "installer failed its integrity check"
        : "update is missing an integrity hash";
      log.error("[updater] " + why + " — refusing to run:", dest);
      emit(win, { type: "error", stage: "verify", message: why, url: job.dlUrl });
      return null;
    }
    job.filePath = dest;
    downloading = false;
    emit(win, { type: "downloaded", version: job.version, notes: job.notes });
    // If the user clicked "Restart to update" while this was still downloading,
    // honour it now that the installer is on disk.
    if (wantInstall) {
      wantInstall = false;
      runInstaller(dest, job.dlUrl, win);
    }
    return dest;
  } catch (e) {
    downloading = false;
    wantInstall = false; // a stale click must not auto-install a LATER download
    try { fs.unlinkSync(dest); } catch {} // drop the partial file
    log.info("Update download failed:", e && e.message);
    emit(win, { type: "error", stage: "download", message: String((e && e.message) || "download failed"), url: job.dlUrl });
    return null;
  }
}

// Renderer clicked "Restart to update". Install the already-downloaded installer;
// if it isn't downloaded yet (e.g. auto-update OFF and they clicked before it
// finished), download first, then install.
async function installUpdate(win) {
  if (!pending) return;
  const haveFile = pending.filePath && fs.existsSync(pending.filePath);
  if (!haveFile && downloading) {
    // A background download is still in flight — install the moment it finishes
    // instead of silently dropping the click (startDownload would no-op here).
    wantInstall = true;
    return;
  }
  if (!haveFile) {
    const fp = await startDownload(win);
    if (!fp) return;
  }
  runInstaller(pending.filePath, pending.dlUrl, win);
}

// ── Native (menu) path — classic dialogs, always available ────────────────────
async function nativeFlow(cfg, win, latest, notes, dlUrl) {
  const current = app.getVersion();
  const choice = dialog.showMessageBoxSync(win || undefined, {
    type: "info",
    title: "Update Available",
    message: `Collab ${latest} is available.`,
    detail: (notes ? notes + "\n\n" : "") +
      `You're on ${current}. Collab will download and install the update — your data and sign-in are kept.`,
    buttons: ["Download & Install", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) return;
  const dest = installerDest(latest, dlUrl);
  try {
    await downloadWithProgress(dlUrl, dest, win, null);
    // AUDIT #13: verify the SHA-256 before offering to install — fail closed on a
    // missing/mismatched hash (never run an unverified installer), same as startDownload.
    const verified = await verifyHash(dest, pending && pending.sha256);
    if (!verified) {
      try { fs.unlinkSync(dest); } catch {}
      log.error("[updater] native flow: installer failed integrity check — refusing to run");
      const c = dialog.showMessageBoxSync(win || undefined, {
        type: "warning", title: "Update verification failed",
        message: "The downloaded update could not be verified.",
        detail: "For your safety it was not installed. You can download it in your browser instead.",
        buttons: ["Open in browser", "Cancel"], defaultId: 0, cancelId: 1,
      });
      if (c === 0) shell.openExternal(dlUrl).catch(() => {});
      return;
    }
  } catch (e) {
    log.info("Update download failed:", e && e.message);
    const c = dialog.showMessageBoxSync(win || undefined, {
      type: "warning", title: "Download failed",
      message: "Couldn't download the update.",
      detail: "You can download it in your browser instead.",
      buttons: ["Open in browser", "Cancel"], defaultId: 0, cancelId: 1,
    });
    if (c === 0) shell.openExternal(dlUrl).catch(() => {});
    return;
  }
  const isWin = process.platform === "win32";
  const c = dialog.showMessageBoxSync(win || undefined, {
    type: "info", title: "Update ready",
    message: `Collab ${latest} is ready to install.`,
    detail: isWin
      ? "The app will close, install the update, and reopen automatically."
      : "The installer will open — drag Collab into Applications to finish.",
    buttons: [isWin ? "Restart & Install" : "Install", "Later"],
    defaultId: 0, cancelId: 1,
  });
  if (c !== 0) return;
  runInstaller(dest, dlUrl, win);
}

// The one entry point. opts: { manual?, auto?, source? }.
//   source "menu" → native dialogs; "app"/"auto" → in-app `update:event` IPC.
//   auto:true (auto-update ON, startup) → download in the background immediately.
// Back-compat: a boolean 3rd arg is treated as `manual` (old callers).
async function checkForUpdates(cfg, parentWindow, opts = {}) {
  if (typeof opts === "boolean") opts = { manual: opts };
  const source = opts.source || (opts.auto ? "auto" : opts.manual ? "app" : "auto");
  const native = source === "menu";
  const win = parentWindow;
  const current = app.getVersion();

  // Periodic background re-checks must never interrupt an in-flight download or
  // an install that is already underway.
  if (opts.auto && (downloading || (lastEvent && lastEvent.type === "installing"))) return;

  // Only surface "checking" for an explicit in-app check — the silent startup
  // (auto) check stays invisible until there's actually an update to show.
  if (source === "app") emit(win, { type: "checking" });

  let manifest;
  try {
    manifest = await fetchManifest(cfg.updateUrl);
  } catch (e) {
    log.info("Update check failed:", e && e.message);
    if (native && opts.manual) {
      dialog.showMessageBox(win || undefined, {
        type: "info", title: "Check for Updates",
        message: "Couldn't check for updates right now.",
        detail: "Please check your connection and try again later.",
        buttons: ["OK"],
      });
    } else if (source === "app") {
      // Only surface a check error for an explicit in-app check, never the silent
      // startup one (don't nag on a flaky network at launch).
      emit(win, { type: "error", stage: "check", message: String((e && e.message) || "check failed") });
    }
    return;
  }

  const latest = manifest && manifest.version;
  const dlUrl = latest ? resolveDl(pickDownloadUrl(manifest), cfg.updateUrl) : null;
  // AUDIT #13: ORIGIN-PIN the installer to the same origin the (HTTPS) manifest came
  // from, so a tampered manifest can't point the download at an attacker host.
  let expectedOrigin = null;
  try { expectedOrigin = new URL(cfg.updateUrl).origin; } catch {}
  const dlOk = !!dlUrl && !!expectedOrigin && sameOrigin(dlUrl, expectedOrigin);
  if (dlUrl && !dlOk)
    log.error("[updater] rejecting installer URL — not same-origin as manifest:", dlUrl, "expected", expectedOrigin);
  const isNewer = latest && cmpVersion(latest, current) > 0 && dlOk;

  if (!isNewer) {
    pending = null;
    if (native && opts.manual) {
      dialog.showMessageBox(win || undefined, {
        type: "info", title: "Check for Updates",
        message: "You're up to date.", detail: `Collab ${current} is the latest version.`,
        buttons: ["OK"],
      });
    } else if (source === "app") {
      emit(win, { type: "uptodate", version: current });
    }
    return;
  }

  // Preserve an installer already downloaded for THIS version, so a manual
  // re-check doesn't discard it and force a needless re-download.
  const keptFile =
    pending && pending.version === latest && pending.filePath && fs.existsSync(pending.filePath)
      ? pending.filePath
      : null;
  // A silent periodic re-check that finds the SAME update we already announced (and
  // possibly downloaded) must not re-pop a banner the user dismissed with "Later".
  const alreadyAnnounced = !!(opts.auto && pending && pending.version === latest);
  pending = {
    version: latest,
    notes: manifest.notes || "",
    dlUrl,
    filePath: keptFile,
    // AUDIT #13: the manifest-declared SHA-256 for this OS's installer + the pinned
    // origin, both enforced before the installer is executed (see startDownload).
    sha256: pickExpectedHash(manifest),
    expectedOrigin,
  };

  if (native) {
    await nativeFlow(cfg, win, latest, manifest.notes, dlUrl);
    return;
  }

  // In-app: announce availability, then either auto-download (auto-update ON) or
  // wait for the renderer's explicit "Download" (auto-update OFF, manual check).
  if (alreadyAnnounced) {
    if (!keptFile) await startDownload(win); // e.g. an earlier download failed — retry
    return;
  }
  emit(win, { type: "available", version: latest, notes: manifest.notes || "", auto: !!opts.auto });
  if (opts.auto) await startDownload(win);
}

// ── Background scheduler ──────────────────────────────────────────────────────
// The desktop app is meant to stay running in the tray for days, so a single
// startup check (the old behaviour) meant a release published after launch was never
// seen until the user restarted. Check shortly after launch, then every
// `intervalMs`, and again whenever the machine wakes from sleep (timers freeze while
// suspended, so a laptop that slept through the interval would otherwise wait longer).
// `getState()` returns { cfg, win, enabled, quitting } fresh on every tick so the
// autoUpdate pref and the current window are always honoured.
let schedulerStarted = false;
function startAutoUpdateScheduler(getState, { initialDelayMs = 8000, intervalMs = 4 * 60 * 60 * 1000 } = {}) {
  if (schedulerStarted) return;
  schedulerStarted = true;
  let lastRun = 0;
  const tick = (reason) => {
    try {
      const st = getState();
      if (!st || !st.cfg || st.quitting || !st.enabled) return;
      lastRun = Date.now();
      log.info("[updater] background check (" + reason + ")");
      checkForUpdates(st.cfg, st.win, { auto: true, source: "auto" }).catch((e) =>
        log.info("[updater] background check failed:", e && e.message));
    } catch (e) { log.info("[updater] scheduler error:", e && e.message); }
  };
  setTimeout(() => tick("startup"), initialDelayMs);
  setInterval(() => tick("interval"), intervalMs).unref?.();
  try {
    powerMonitor.on("resume", () => {
      // Wait a moment for the network to come back, and skip if we just checked.
      if (Date.now() - lastRun < 10 * 60 * 1000) return;
      setTimeout(() => tick("resume"), 15000);
    });
  } catch { /* powerMonitor unavailable before ready — interval still covers us */ }
}

module.exports = { checkForUpdates, startDownload, installUpdate, currentState, cmpVersion, startAutoUpdateScheduler };
