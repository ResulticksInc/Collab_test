const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, screen, powerMonitor, powerSaveBlocker, net, session, desktopCapturer, Menu, systemPreferences, Tray, nativeImage, globalShortcut, safeStorage } = require("electron");
const path = require("path");
const Store = require("electron-store");
const log = require("./logger");
const { resolveConfig, resolveAppInfo } = require("./config");
const { checkForUpdates, startDownload, installUpdate, currentState, startAutoUpdateScheduler } = require("./updater");
const { createDesktopNotification, clearAllNotifications } = require("./desktopNotif");
const remoteInput = require("./remoteInput");
const { createPermissionGate } = require("./mediaPermissions");

// Windows screen-capture: Chromium's WGC capturer spams
// "wgc_capture_session.cc ProcessFrame failed (-2147467259)" and can stall the
// shared frame when capturing certain hardware-accelerated windows. Force the
// stable legacy capturer for screen share. (Revert if a monitor/window ever
// shows black on capture.) Must run before app 'ready'.
app.commandLine.appendSwitch(
  "disable-features",
  "AllowWgcScreenCapturer,AllowWgcWindowCapturer",
);

// ── Smoothness: use the GPU/native advantage a web tab can't ────────────────
// Must run before app 'ready'. GPU-rasterize Skia (big scroll/animation win),
// zero-copy GPU memory, and OS smooth-scroll inertia.
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("enable-smooth-scrolling");
// DELIBERATELY NOT setting `disable-frame-rate-limit`: uncapping the compositor
// causes IRREGULAR frame pacing (visible micro-stutter) on most displays/GPUs.
// For UI, VSync-paced frames at the display's native refresh (incl. 120/144 Hz)
// are SMOOTHER than an uncapped rate — Chromium already renders to the display
// refresh by default, so we keep that and don't fight the pacing.
// Opt-in ONLY on a machine whose GPU is wrongly blocklisted (test that HW first):
// app.commandLine.appendSwitch("ignore-gpu-blocklist");

const isDev = process.argv.includes("--dev");

// ── Dev isolation: separate userData dir ─────────────────────────────────────
// The packaged app and this dev build BOTH resolve to app name "Collab", so by
// default they share ONE userData dir (%APPDATA%/Collab, ~/Library/Application
// Support/Collab, …). When the installed Collab is running in the tray it holds
// that dir's single-instance lock and keeps its cache/quota files open — so
// `electron . --dev` hits "Another instance holds the single-instance lock" and
// spews "Unable to move the cache / Access is denied / quota database" and never
// starts clean. (kill-stale.js deliberately can't kill the user's installed app.)
// Point dev at its OWN userData dir so the two can NEVER collide, in either
// direction. Must run before the electron-store constructors below and before
// anything reads app.getPath('userData').
if (isDev) {
  try {
    app.setPath("userData", path.join(app.getPath("appData"), "Collab (Dev)"));
  } catch {
    /* getPath('appData') is available pre-ready on all platforms; if it ever
       isn't, fall back to the shared dir rather than blocking the dev launch. */
  }
}

const appInfo = resolveAppInfo();
const winStore = new Store({ name: "window-state" });
// Background-presence preferences (tray / close-to-tray / auto-launch) persisted
// next to window-state in the same per-user data dir. Kept SEPARATE from
// window-state so a future schema change to either can't corrupt the other.
const prefsStore = new Store({
  name: "desktop-prefs",
  defaults: { closeToTray: true, openAtLogin: false, globalShortcuts: true, protectContent: false, autoUpdate: true },
});

const RECONNECT_MIN = appInfo.reconnectMinMs;
const RECONNECT_MAX = appInfo.reconnectMaxMs;

let mainWindow = null;
let cfg = null; // resolved runtime config (env + URLs)
let isQuitting = false;
// Remote Control: OS input is injected ONLY while the renderer has an ACTIVE
// granted session (armed via rc:arm) — defense-in-depth over the renderer gate.
let rcArmed = false;
let rcShareDisplayId = null; // which display is shared (so input maps to the right monitor)
let rendererFailures = 0;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN;
let pickerWin = null; // screen-share source picker
// Tier 5 — native pop-out windows. Each entry is { win, conversation } for a
// secondary chat window opened via desktop:open-popout. Pop-outs share the
// DEFAULT session (so they're already authenticated) and are purely secondary:
// closing one must NEVER hide-to-tray or quit the app (only mainWindow.close
// does that). Tracked so we can de-dupe (focus an existing one) + validate IPC.
const popoutWindows = new Set();
// ── Screen-share pop-out windows (POP-01/02) ─────────────────────────────
// The renderer pops a screen share into its own OS window with
// `window.open("", "colab_share_<pid>", "popup=yes,width=…")` (see
// frontend/app/src/lib/screenPopout.ts). That is a blank, same-origin window the
// opener scripts directly — it never navigates anywhere. The security
// setWindowOpenHandler below denies every non-SSO URL, which used to swallow
// this request too: window.open returned null, and the app fell back to a
// floating panel with a misleading "Pop-ups are blocked for this site" toast.
// Recognise the request by its reserved frame name + blank URL, and nothing else.
const SHARE_POPOUT_FRAME = /^colab_share_[A-Za-z0-9_]+$/;
const isSharePopoutRequest = (details) => {
  if (!details || typeof details.frameName !== "string") return false;
  if (!SHARE_POPOUT_FRAME.test(details.frameName)) return false;
  const u = typeof details.url === "string" ? details.url : "";
  return u === "" || u === "about:blank";
};
// A genuine OS window (native title bar → minimize / maximize / snap / second
// monitor all work), sized from the renderer's window.open features.
const sharePopoutWindowOptions = () => ({
  action: "allow",
  overrideBrowserWindowOptions: {
    frame: true,
    titleBarStyle: "default",
    autoHideMenuBar: true,
    minWidth: 320,
    minHeight: 200,
    backgroundColor: "#0d0f12",
    title: appInfo.appName,
    webPreferences: {
      // Same hardening as the opener (webPreferences are inherited from the
      // opener and merged with these). The window only mirrors a MediaStream;
      // it never talks to the desktop bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Keep the mirrored video rendering when the OPENER is backgrounded
      // (the pop-out is typically dragged to another monitor while the main
      // window sits behind other apps).
      backgroundThrottling: false,
    },
  },
});
// Lock the child down once it exists: it must stay blank (no navigation, no
// further window.open) and must never take the app down when closed.
const hardenSharePopout = (child, details) => {
  if (!isSharePopoutRequest(details)) return;
  try {
    child.setMenuBarVisibility(false);
    child.webContents.on("will-navigate", (event, navUrl) => {
      if (navUrl !== "about:blank") event.preventDefault();
    });
    child.webContents.setWindowOpenHandler(({ url: u }) => {
      if (/^https?:\/\//.test(u)) shell.openExternal(u).catch(() => { });
      return { action: "deny" };
    });
    log.info("screen-share pop-out opened:", details.frameName);
  } catch (e) {
    log.warn("screen-share pop-out hardening failed:", e && e.message);
  }
};
let preMiniBounds = null; // main-window bounds saved before entering native PiP
let tray = null; // system tray icon (background presence)
let overlayBadge = null; // cached Windows taskbar overlay image (>0 unread)
// Jump list (Windows) / dock menu (macOS) recent-conversation quick actions. The
// renderer pushes the top-N recent conversations ([{id,name}]); we rebuild the
// OS quick-action menu so "New message" + recent chats work even when the window
// is closed to the tray. Cached so a rebuild without new data reuses the last set.
let recentConversations = [];
// Deep linking (colab://): links can arrive BEFORE the renderer is ready (cold
// launch via a colab:// URL). Queue them and flush once the renderer signals it
// has subscribed (deepLinkReady) — or on each did-finish-load as a fallback.
let pendingDeepLinks = [];
let rendererDeepLinkReady = false;
let shortcutsRegistered = false; // global-shortcut registration state (idempotent)
// Smoother calls: keep the DISPLAY awake while a call/meeting is active so the
// screen never sleeps mid-call. Tracks the active powerSaveBlocker id (or null)
// so we never double-start; stopped on call-end and on quit. Core Electron — no
// dep. Does NOT touch the LiveKit media plane; purely an OS power hint.
let callPowerBlockerId = null;
// "Ring + answer when closed": the renderer reports an incoming call so the main
// process can flash the taskbar + surface answer/decline action buttons. We track
// whether the frame is currently flashing so we can clear it on answer/decline.
let callFlashing = false;
// Idle → auto-Away: poll handle + last broadcast presence so we only emit a
// state change on a TRANSITION (active↔away), never a repeated spam every tick.
let idlePollTimer = null;
let lastAutoPresence = "active";
const IDLE_AWAY_SECONDS = 300; // 5 min idle (or screen lock) → auto-Away
const IDLE_POLL_MS = 30000; // check system idle every 30s

// ── Single-instance lock ────────────────────────────────────────────────────
// In PRODUCTION a second launch just focuses the running app (below). In DEV,
// though, a stale/hidden instance (or the installed app in the tray) would hold
// the lock and make `electron . --dev` quit INSTANTLY with no window — which
// looks like "the app won't start". So in dev we log and keep going instead of
// quitting, letting a dev instance run alongside anything else.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !isDev) {
  app.quit();
  process.exit(0);
}
if (!gotLock && isDev) {
  log.warn("Another instance holds the single-instance lock — continuing anyway (dev mode).");
}
app.on("second-instance", (_event, argv) => {
  // Re-launching while hidden to the tray must bring CoLab back (show + focus),
  // not silently no-op. showMainWindow handles minimized + hidden + focus.
  if (mainWindow) showMainWindow();
  // Windows/Linux deliver a colab:// deep link as a token in the SECOND
  // instance's argv (the OS relaunches the app with the URL appended). Extract
  // and route it to the already-running window.
  const url = extractDeepLink(argv);
  if (url) handleDeepLink(url);
});

// macOS delivers colab:// links via open-url (NOT argv). Registered at module
// load — before app 'ready' — so a cold-launch URL is captured (handleDeepLink
// queues it until the renderer is ready). preventDefault() per Electron docs.
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// Register the colab: scheme as early as possible (safe before 'ready').
registerProtocol();

// ── IPC sender validation ───────────────────────────────────────────────────
function fromMain(event) {
  return !!mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

// Broader gate for IPC that ANY of our own windows may send (the main window OR
// a native pop-out). Privileged channels (notifications, deep-link, badge, PiP,
// remote-control, etc.) stay on the stricter fromMain so only the primary window
// drives app-wide state; window-control, open-popout and the download flow
// (save-file / reveal-in-folder / open-path) use this so a pop-out can
// drag/close itself, open a chat pop-out, and download + reveal/open attachments.
function fromColab(event) {
  if (fromMain(event)) return true;
  for (const p of popoutWindows) {
    if (p.win && !p.win.isDestroyed() && event.sender === p.win.webContents) return true;
  }
  return false;
}

// ── Deep linking (colab://) ─────────────────────────────────────────────────
// Register CoLab as the OS handler for the custom `colab:` scheme so a
// colab://… link (from a notification, a browser, or the OS) launches/focuses
// the app. SECURITY: ONLY the colab scheme is ever handled here; the URL is
// validated + normalised before it reaches the renderer, and the renderer maps
// it to in-app navigation only (never a raw page load — see deepLink.ts).
function registerProtocol() {
  try {
    if (process.defaultApp && process.platform === "win32" && process.argv.length >= 2) {
      // Dev/unpackaged on Windows: register THIS electron binary + the entry
      // script so `colab://` works when running `electron .` (best-effort).
      app.setAsDefaultProtocolClient("colab", process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    } else {
      app.setAsDefaultProtocolClient("colab");
    }
  } catch (e) {
    log.warn("setAsDefaultProtocolClient failed (best-effort):", e && e.message);
  }
}

// Pull the first colab:// token out of an argv array (Windows/Linux deliver the
// deep link as a process argument). Returns the URL string or null.
function extractDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    if (typeof a === "string" && /^colab:\/\//i.test(a.trim())) return a.trim();
  }
  return null;
}

// Validate + normalise a colab:// URL to a compact "kind/rest" path the renderer
// can parse. Rejects anything that isn't the colab scheme (returns null) so a
// malicious argv can never smuggle in http(s)/file/etc. The renderer applies its
// own parsing/whitelist on top (defense-in-depth).
function normalizeDeepLink(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!/^colab:\/\//i.test(trimmed)) return null;
  // Strip the scheme + leading slashes; keep only a safe path/query subset.
  let rest = trimmed.replace(/^colab:\/\//i, "");
  // Drop a trailing slash and any fragment; cap length defensively.
  rest = rest.replace(/#.*$/, "").replace(/\/+$/, "").slice(0, 512);
  // Allow only the characters that make up our grammar (kind/id/query). This
  // rejects backslashes, spaces, control chars, etc.
  if (!/^[A-Za-z0-9/_\-.=&?%:@]*$/.test(rest)) return null;
  return rest; // e.g. "chat/<id>", "message/<conv>/<msg>", "meeting/<id>"
}

// Route a (possibly raw) colab:// URL to the renderer, focusing the window. If
// the renderer isn't ready yet (cold launch), QUEUE it and flush on ready.
function handleDeepLink(rawUrl) {
  const norm = normalizeDeepLink(rawUrl);
  if (!norm) return; // not colab: / garbage → ignore (never throw)
  if (mainWindow) showMainWindow();
  if (rendererDeepLinkReady && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send("deep-link", norm); }
    catch (e) { log.warn("deep-link send failed:", e && e.message); }
  } else {
    if (pendingDeepLinks.length < 16) pendingDeepLinks.push(norm); // bounded queue
  }
}

// Send any queued deep links to the renderer (called once it signals ready, and
// on each clean did-finish-load as a belt-and-braces fallback).
function flushDeepLinks() {
  if (!mainWindow || mainWindow.isDestroyed() || !pendingDeepLinks.length) return;
  const queued = pendingDeepLinks;
  pendingDeepLinks = [];
  for (const url of queued) {
    try { mainWindow.webContents.send("deep-link", url); }
    catch (e) { log.warn("deep-link flush failed:", e && e.message); }
  }
}

// ── Window state helpers ────────────────────────────────────────────────────
function getWindowBounds() {
  const defaults = { width: appInfo.window.width, height: appInfo.window.height };
  try {
    const saved = winStore.get("bounds", {});
    if (saved.width && saved.height) {
      // Ignore a stale near-fullscreen saved size (e.g. left over from before
      // maximized bounds were excluded) so the RESTORE size is always a real
      // windowed size, not the full screen.
      const wa = screen.getPrimaryDisplay().workArea;
      if (saved.width >= wa.width - 8 && saved.height >= wa.height - 8) return defaults;
      return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    }
  } catch { }
  return defaults;
}

function isFirstLaunch() {
  try {
    const saved = winStore.get("bounds", {});
    return !(saved.width && saved.height);
  } catch {
    return true;
  }
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Persist ONLY the windowed size — never the maximized / minimized / fullscreen
  // bounds — so "restore down" returns to a real windowed size instead of the
  // full screen (which read as "minimize does nothing").
  if (
    mainWindow.isMaximized() ||
    mainWindow.isMinimized() ||
    mainWindow.isFullScreen()
  )
    return;
  try {
    winStore.set("bounds", mainWindow.getBounds());
  } catch { }
}

function clampToScreen(bounds) {
  // Always return a frame that is FULLY inside a display's work area and no
  // larger than it. (The old version only rescued windows that were off EVERY
  // display, so a window half off the left edge slipped through and looked
  // "stuck".) Missing x/y → centre on the primary display.
  try {
    const hasPos = Number.isFinite(bounds.x) && Number.isFinite(bounds.y);
    const wa = (hasPos
      ? screen.getDisplayMatching(bounds)
      : screen.getPrimaryDisplay()
    ).workArea;
    const width = Math.min(bounds.width, wa.width);
    const height = Math.min(bounds.height, wa.height);
    const x = hasPos
      ? Math.max(wa.x, Math.min(bounds.x, wa.x + wa.width - width))
      : wa.x + Math.round((wa.width - width) / 2);
    const y = hasPos
      ? Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - height))
      : wa.y + Math.round((wa.height - height) / 2);
    return { x, y, width, height };
  } catch {
    return bounds;
  }
}

// Runtime guard: after a restore / unmaximize / leave-fullscreen, force the
// windowed frame fully on-screen so it can never be stranded half off the edge
// (where it reads as "stuck" / can't be grabbed or maximized).
function ensureOnScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (
    mainWindow.isMaximized() ||
    mainWindow.isMinimized() ||
    mainWindow.isFullScreen()
  )
    return;
  try {
    const b = mainWindow.getBounds();
    const c = clampToScreen(b);
    if (c.x !== b.x || c.y !== b.y || c.width !== b.width || c.height !== b.height)
      mainWindow.setBounds(c);
  } catch { }
}

// ── Desktop preferences (background presence) ───────────────────────────────
function getDesktopPrefs() {
  return {
    closeToTray: prefsStore.get("closeToTray", true) !== false,
    openAtLogin: prefsStore.get("openAtLogin", false) === true,
    globalShortcuts: prefsStore.get("globalShortcuts", true) !== false,
    protectContent: prefsStore.get("protectContent", false) === true,
    autoUpdate: prefsStore.get("autoUpdate", true) !== false,
  };
}

// ── Global shortcuts (OS-wide hotkeys, work even when CoLab isn't focused) ───
// Gated behind the `globalShortcuts` pref (default ON). Each register() is
// wrapped so a hotkey already owned by another app just logs + continues —
// never a crash. Show/Hide is handled entirely in the main process; mute/PiP
// forward an IPC the renderer acts on (only when a call/meeting is active).
function sendGlobalShortcut(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send("global-shortcut", { action }); }
  catch (e) { log.warn("global-shortcut send failed:", e && e.message); }
}

function tryRegisterShortcut(accelerator, handler) {
  try {
    const ok = globalShortcut.register(accelerator, handler);
    if (!ok) log.warn(`Global shortcut ${accelerator} unavailable (taken by another app) — skipped`);
    return ok;
  } catch (e) {
    log.warn(`Global shortcut ${accelerator} register failed:`, e && e.message);
    return false;
  }
}

function registerGlobalShortcuts() {
  if (shortcutsRegistered) return;
  if (!getDesktopPrefs().globalShortcuts) return; // pref OFF → don't register
  // Show / hide the main window — main-process only (no renderer needed).
  tryRegisterShortcut("CommandOrControl+Shift+C", () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
  });
  // Toggle mic mute — renderer no-ops unless a call/meeting is active.
  tryRegisterShortcut("CommandOrControl+Shift+M", () => sendGlobalShortcut("toggle-mute"));
  // Toggle Picture-in-Picture — renderer no-ops unless a call is active.
  tryRegisterShortcut("CommandOrControl+Shift+D", () => sendGlobalShortcut("toggle-pip"));
  // Answer the ringing call — renderer no-ops unless a call is actually ringing.
  tryRegisterShortcut("CommandOrControl+Shift+A", () => sendGlobalShortcut("answer-call"));
  // Decline the ringing call — renderer no-ops unless a call is actually ringing.
  tryRegisterShortcut("CommandOrControl+Shift+J", () => sendGlobalShortcut("decline-call"));
  shortcutsRegistered = true;
  log.info("Global shortcuts registered");
}

function unregisterGlobalShortcuts() {
  try { globalShortcut.unregisterAll(); } catch { }
  shortcutsRegistered = false;
}

// Apply the auto-launch (login-item) preference to the OS. Cross-platform:
// Windows/macOS are real; on Linux setLoginItemSettings is a best-effort/no-op,
// so it's wrapped to never throw. macOS starts hidden (to tray) via openAsHidden.
function applyLoginItem(open) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!open,
      openAsHidden: process.platform === "darwin" ? !!open : undefined,
    });
  } catch (e) {
    log.warn("setLoginItemSettings failed (best-effort):", e && e.message);
  }
}

// ── Smoother calls: power-save blocker while a call/meeting is active ────────
// Start "prevent-display-sleep" so the screen doesn't dim/sleep during a call;
// stop it when the call ends. Idempotent: a second start() is a no-op (the id is
// already live), and stop() is safe to call when nothing is active. This is a
// pure OS power hint — it never touches LiveKit / the media plane.
function startCallPowerBlocker() {
  try {
    if (callPowerBlockerId !== null && powerSaveBlocker.isStarted(callPowerBlockerId)) return;
    callPowerBlockerId = powerSaveBlocker.start("prevent-display-sleep");
    log.info("Call active — display-sleep prevented (powerSaveBlocker)");
  } catch (e) {
    log.warn("powerSaveBlocker start failed (skipped):", e && e.message);
    callPowerBlockerId = null;
  }
}

function stopCallPowerBlocker() {
  if (callPowerBlockerId === null) return;
  try {
    if (powerSaveBlocker.isStarted(callPowerBlockerId)) powerSaveBlocker.stop(callPowerBlockerId);
    log.info("Call ended — display-sleep blocker stopped");
  } catch (e) {
    log.warn("powerSaveBlocker stop failed (skipped):", e && e.message);
  }
  callPowerBlockerId = null;
}

// ── Capture protection (DLP) ─────────────────────────────────────────────────
// setContentProtection(true) blanks the window in OS screenshots, screen-share
// and recorders (OBS, Teams, etc.). Driven by the `protectContent` pref (applied
// on startup + on toggle). A future per-confidential-channel auto-toggle can call
// the SAME bridge (collabDesktop.setContentProtection) to turn it on for the
// duration the sensitive channel is open, then off again.
function applyContentProtection(on) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setContentProtection(!!on);
    log.info("Content protection " + (on ? "enabled" : "disabled"));
  } catch (e) {
    log.warn("setContentProtection failed (skipped):", e && e.message);
  }
}

// ── Idle → auto-Away ─────────────────────────────────────────────────────────
// Poll powerMonitor.getSystemIdleTime() (+ honour explicit screen lock / suspend)
// and tell the renderer to flip presence to "away" after IDLE_AWAY_SECONDS of no
// input, then back to "active" on the next activity. We only send on a TRANSITION
// (not every tick) and the renderer NEVER overrides a manual Busy/DND/Offline —
// it only auto-Aways a default-online user (see CoLabV1). screenLocked forces
// "away" regardless of the idle counter.
function sendAutoPresence(state) {
  if (state === lastAutoPresence) return; // only on transition
  lastAutoPresence = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send("presence-auto", { state }); }
    catch (e) { log.warn("presence-auto send failed:", e && e.message); }
  }
}

let screenLocked = false;
function pollIdle() {
  try {
    if (screenLocked) { sendAutoPresence("away"); return; }
    const idleSec = powerMonitor.getSystemIdleTime(); // seconds since last input
    sendAutoPresence(idleSec >= IDLE_AWAY_SECONDS ? "away" : "active");
  } catch (e) {
    // getSystemIdleTime can be unavailable on some Linux sessions — skip quietly.
  }
}

function startIdleMonitor() {
  if (idlePollTimer) return;
  idlePollTimer = setInterval(pollIdle, IDLE_POLL_MS);
}

function stopIdleMonitor() {
  if (idlePollTimer) { clearInterval(idlePollTimer); idlePollTimer = null; }
}

// ── App icon + tray art resolution ──────────────────────────────────────────
// The brand icons live in build/ (shipped at runtime via electron-builder
// `files`). Returns a non-empty nativeImage, or null when art is missing so
// callers fall back gracefully (the tray is simply not created — never a crash).
function loadAppIcon() {
  const candidates =
    process.platform === "win32"
      ? ["icon.ico", "icon.png"]
      : ["icon.png", "icon.ico"];
  for (const name of candidates) {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, "build", name));
      if (img && !img.isEmpty()) return img;
    } catch { }
  }
  return null;
}

function loadTrayIcon() {
  const base = loadAppIcon();
  if (!base) return null;
  // macOS menu bar renders tray art tiny; a full-resolution icon there looks
  // oversized, so downscale to the standard ~18px menu-bar size. We do NOT mark
  // it as a template image — template images must be black+alpha only, and our
  // brand icon is full-colour (a colour icon flagged as template renders as a
  // solid black blob). Without a dedicated monochrome asset, the small colour
  // icon is the correct "else the normal icon" fallback. Win/Linux use it as-is.
  if (process.platform === "darwin") {
    try {
      return base.resize({ width: 18, height: 18 });
    } catch {
      return base;
    }
  }
  return base;
}

// ── Background presence: show / tray / badge ────────────────────────────────
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function realQuit() {
  isQuitting = true;
  app.quit();
}

function createTray() {
  if (tray) return; // already built (or rebuilt after icon swap)
  const icon = loadTrayIcon();
  if (!icon) {
    log.warn("Tray icon art missing — running without a system tray");
    return; // graceful: no tray, app behaves as before
  }
  try {
    tray = new Tray(icon);
    tray.setToolTip(appInfo.appName);
    const menu = Menu.buildFromTemplate([
      { label: "Open " + appInfo.appName, click: showMainWindow },
      { type: "separator" },
      { label: "Quit " + appInfo.appName, click: realQuit },
    ]);
    tray.setContextMenu(menu);
    // Left-click → toggle/show the window (Windows/Linux convention). On macOS a
    // single click opens the context menu by default; we still wire show for the
    // platforms that deliver a 'click'.
    tray.on("click", () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.hide();
      } else {
        showMainWindow();
      }
    });
    log.info("System tray created");
  } catch (e) {
    log.error("Failed to create tray:", e && e.message);
    tray = null;
  }
}

function destroyTray() {
  if (tray) {
    try { tray.destroy(); } catch { }
    tray = null;
  }
}

// ── Jump list (Windows) / dock menu (macOS) — quick actions ─────────────────
// Build the OS taskbar/dock quick-action menu so common entry points work even
// when CoLab is closed to the tray. Two surfaces, same intent:
//   • Windows → app.setJumpList([{ type:"tasks", items:[…] }]). A "task" item
//     relaunches THIS binary (a separate instance), so the single-instance lock
//     forwards the request to the running app; we pass the action as a colab://
//     deep link in the arguments so it routes through the EXISTING deep-link path
//     (extractDeepLink → handleDeepLink → the renderer). No parallel mechanism.
//   • macOS → app.dock.setMenu(Menu). Dock menu items run IN this process, so we
//     route them straight through handleDeepLink (same target as a real link).
// "New message" → colab://new (handled by lib/deepLink.ts → CoLabV1's existing
// new-message modal). Recent chats → colab://chat/<id> (existing chat route).
// Windows-only setJumpList / mac-only dock.setMenu; both guarded so a platform
// without the API (or a failure) is a quiet no-op, never a crash.
function deepLinkLaunchArgs(deepLink) {
  // The args a relaunched instance receives so extractDeepLink() finds the link.
  // Dev/unpackaged: prepend the entry script (electron needs it to run our app),
  // mirroring registerProtocol()'s setAsDefaultProtocolClient arguments.
  if (process.defaultApp && process.argv.length >= 2) {
    return `"${path.resolve(process.argv[1])}" "${deepLink}"`;
  }
  return `"${deepLink}"`;
}

// Presence quick-set states surfaced on the jump list / dock menu. Each routes
// through the SAME colab://presence/<state> deep link the renderer maps onto its
// existing presence setter (changeSetting("manualPresence", …)). No parallel
// mechanism — identical path to "New message".
// NOTE: aligned to the full Teams manual-presence set. "Do not disturb" must send
// state "dnd" (the state that actually suppresses notifications) — "busy" is now a
// separate non-suppressing "Busy". (Reaches users on the next installer rebuild.)
const PRESENCE_QUICK = [
  { state: "available", label: "Available" },
  { state: "busy", label: "Busy" },
  { state: "dnd", label: "Do not disturb" },
  { state: "away", label: "Appear away" },
];

function buildJumpList() {
  if (process.platform === "win32") {
    try {
      // Presence quick-set group (its own "tasks" category, shown as a section).
      const presenceItems = PRESENCE_QUICK.map((p) => ({
        type: "task",
        title: p.label,
        description: "Set status to " + p.label,
        program: process.execPath,
        args: deepLinkLaunchArgs("colab://presence/" + p.state),
      }));

      const items = [
        {
          type: "task",
          title: "New message",
          description: "Start a new message",
          program: process.execPath,
          args: deepLinkLaunchArgs("colab://new"),
        },
      ];
      // Up to 5 recent conversations, each launching/focusing + opening the chat.
      for (const c of recentConversations.slice(0, 5)) {
        if (!c || typeof c.id !== "string" || !c.id) continue;
        const name = (typeof c.name === "string" && c.name.trim()) || "Conversation";
        items.push({
          type: "task",
          title: name.slice(0, 60),
          description: "Open " + name.slice(0, 60),
          program: process.execPath,
          args: deepLinkLaunchArgs("colab://chat/" + encodeURIComponent(c.id)),
        });
      }
      app.setJumpList([
        { type: "custom", name: "Status", items: presenceItems },
        { type: "tasks", items },
      ]);
    } catch (e) {
      // setJumpList can reject a malformed category (returns/throws) — never crash.
      // Fall back to the tasks-only list so presence never breaks the recents.
      try {
        app.setJumpList([
          {
            type: "tasks",
            items: [
              {
                type: "task",
                title: "New message",
                description: "Start a new message",
                program: process.execPath,
                args: deepLinkLaunchArgs("colab://new"),
              },
            ],
          },
        ]);
      } catch (_) { }
      log.warn("setJumpList failed (skipped):", e && e.message);
    }
    return;
  }
  if (process.platform === "darwin") {
    try {
      if (!app.dock || typeof app.dock.setMenu !== "function") return;
      const template = [
        { label: "New message", click: () => handleDeepLink("colab://new") },
        { type: "separator" },
      ];
      // Presence quick-set: dock items run IN-process → handleDeepLink directly
      // (same target as a real colab://presence/<state> link).
      for (const p of PRESENCE_QUICK) {
        template.push({
          label: p.label,
          click: () => handleDeepLink("colab://presence/" + p.state),
        });
      }
      const recent = recentConversations
        .filter((c) => c && typeof c.id === "string" && c.id)
        .slice(0, 5);
      if (recent.length) {
        template.push({ type: "separator" });
        for (const c of recent) {
          const name = (typeof c.name === "string" && c.name.trim()) || "Conversation";
          template.push({
            label: name.slice(0, 60),
            click: () => handleDeepLink("colab://chat/" + encodeURIComponent(c.id)),
          });
        }
      }
      app.dock.setMenu(Menu.buildFromTemplate(template));
    } catch (e) {
      log.warn("dock.setMenu failed (skipped):", e && e.message);
    }
  }
}

// 3x5 bitmap glyphs for the overlay badge. A raw bitmap is the only reliable
// runtime path here — Electron's nativeImage does not decode SVG, and shipping
// eleven PNGs for the digits would be worse. Each row is 3 bits, MSB-left.
const BADGE_GLYPHS = {
  0: [0b111, 0b101, 0b101, 0b101, 0b111],
  1: [0b010, 0b110, 0b010, 0b010, 0b111],
  2: [0b111, 0b001, 0b111, 0b100, 0b111],
  3: [0b111, 0b001, 0b111, 0b001, 0b111],
  4: [0b101, 0b101, 0b111, 0b001, 0b001],
  5: [0b111, 0b100, 0b111, 0b001, 0b111],
  6: [0b111, 0b100, 0b111, 0b101, 0b111],
  7: [0b111, 0b001, 0b001, 0b001, 0b001],
  8: [0b111, 0b101, 0b111, 0b101, 0b111],
  9: [0b111, 0b101, 0b111, 0b001, 0b111],
  "+": [0b000, 0b010, 0b111, 0b010, 0b000],
};

// Build the Windows taskbar overlay badge — a red circle WITH THE UNREAD COUNT,
// the way Teams/Slack/Outlook render theirs.
//
// This previously drew a featureless red disc and cached the single image
// forever, so the taskbar could only ever say "something happened" — never what
// or how much — and sat next to Teams' numbered badge looking unfinished.
//
// Supersampled: rasterised at 4x (64px) and handed to Electron at that size so
// Windows' own downscale to ~16px does the anti-aliasing. Drawing the glyphs
// directly at 16px would put a 3px-wide digit on a pixel grid with no room to
// smooth, which is illegible. Returns null on any failure → overlay skipped.
function buildOverlayBadge(count) {
  try {
    const S = 4; // supersample factor
    const size = 16 * S;
    const r = size / 2;
    const c = r;
    const label = count > 9 ? "9+" : String(count);
    const buf = Buffer.alloc(size * size * 4); // BGRA

    // Glyph metrics, in supersampled pixels. The font is 3x5 cells, so one
    // font-pixel must stay under size/5 or the glyph overflows the disc: at
    // S=4 the badge is 64 tall, giving a 40-tall digit (2*S) with ~12px of
    // margin above and below. Two glyphs drop to 1.5*S so "9+" measures 40x30
    // — its corners land 25px from centre, inside the 32px radius.
    const px = label.length > 1 ? Math.round(1.5 * S) : 2 * S; // one font-pixel
    const gap = label.length > 1 ? S : 0;
    const textW = label.length * 3 * px + (label.length - 1) * gap;
    const textH = 5 * px;
    const x0 = Math.round(c - textW / 2);
    const y0 = Math.round(c - textH / 2);

    // Paint the glyph mask first so the fill loop can test it per pixel.
    const ink = new Uint8Array(size * size);
    for (let g = 0; g < label.length; g++) {
      const rows = BADGE_GLYPHS[label[g]];
      if (!rows) continue;
      const gx = x0 + g * (3 * px + gap);
      for (let ry = 0; ry < 5; ry++) {
        for (let rx = 0; rx < 3; rx++) {
          if (!((rows[ry] >> (2 - rx)) & 1)) continue;
          for (let yy = 0; yy < px; yy++) {
            for (let xx = 0; xx < px; xx++) {
              const X = gx + rx * px + xx;
              const Y = y0 + ry * px + yy;
              if (X >= 0 && X < size && Y >= 0 && Y < size) ink[Y * size + X] = 1;
            }
          }
        }
      }
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const dx = x + 0.5 - c;
        const dy = y + 0.5 - c;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Anti-aliased edge across the final supersampled pixel of the radius.
        const alpha = Math.max(0, Math.min(1, r - dist)) * 255;
        if (ink[y * size + x]) {
          buf[i] = 0xff; // B  → white glyph
          buf[i + 1] = 0xff; // G
          buf[i + 2] = 0xff; // R
        } else {
          // nativeImage.createFromBitmap expects BGRA byte order.
          buf[i] = 0x4d; // B
          buf[i + 1] = 0x48; // G
          buf[i + 2] = 0xe5; // R  (→ #e5484d, matching the in-app count badge)
        }
        buf[i + 3] = Math.round(alpha);
      }
    }
    const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
    return img && !img.isEmpty() ? img : null;
  } catch {
    return null;
  }
}

// Set the unread badge per-OS:
//  • macOS / Linux (Unity)  → numeric dock/taskbar badge via app.setBadgeCount
//  • Windows                → taskbar OVERLAY icon (red dot) when n>0, cleared at 0
function applyBadgeCount(n) {
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  // app.setBadgeCount is a no-op on Windows (returns false) — harmless to call.
  try { app.setBadgeCount(count); } catch { }
  if (process.platform === "win32" && mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (count > 0) {
        // Cache KEYED ON THE RENDERED LABEL, not a single image. The badge now
        // carries the count, so a plain `if (!overlayBadge)` would paint the
        // first count you ever received and never update again. Everything past
        // 9 renders "9+", so the cache holds at most ten images.
        const key = count > 9 ? "9+" : String(count);
        if (!overlayBadge || overlayBadge.key !== key) {
          overlayBadge = { key, img: buildOverlayBadge(count) };
        }
        // Only set a non-null overlay; a null image clears it (the count=0 path).
        if (overlayBadge.img)
          mainWindow.setOverlayIcon(
            overlayBadge.img,
            count === 1 ? "1 unread" : count + " unread",
          );
      } else {
        mainWindow.setOverlayIcon(null, "");
      }
    } catch (e) {
      // No overlay art / unsupported → skip rather than crash.
      log.warn("setOverlayIcon failed (skipped):", e && e.message);
    }
  }
}

// ── Connect / reconnect to the hosted app ───────────────────────────────────
function connectToApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadURL(cfg.webUrl).catch((e) => {
    // did-fail-load drives the reconnect flow; just record it.
    log.warn("loadURL rejected:", e && e.message);
  });
}

function showReconnectScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow
    .loadFile(path.join(__dirname, "reconnect.html"))
    .catch((e) => log.error("Failed to load reconnect screen:", e));
  if (!mainWindow.isVisible()) mainWindow.show();
}

function pushReconnectStatus(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send("desktop:reconnect-status", msg); } catch { }
  }
}

// Reachability probe via Electron's net stack (honours system proxy/VPN).
function probe(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const req = net.request({ method: "HEAD", url });
      const t = setTimeout(() => { try { req.abort(); } catch { } done(false); }, timeoutMs);
      req.on("response", () => { clearTimeout(t); done(true); }); // any HTTP response = reachable
      req.on("error", () => { clearTimeout(t); done(false); });
      req.end();
    } catch {
      done(false);
    }
  });
}

function startReconnectLoop() {
  if (reconnectTimer || isQuitting) return;
  reconnectDelay = RECONNECT_MIN;
  const tick = async () => {
    reconnectTimer = null;
    if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
    pushReconnectStatus("Checking connection…");
    const ok = await probe(cfg.webUrl);
    if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
    if (ok) {
      log.info("Backend reachable again — reloading app");
      stopReconnectLoop();
      connectToApp();
      return;
    }
    reconnectDelay = Math.min(Math.round(reconnectDelay * 1.5), RECONNECT_MAX);
    pushReconnectStatus("Server unreachable — retrying in " + Math.round(reconnectDelay / 1000) + "s…");
    reconnectTimer = setTimeout(tick, reconnectDelay);
  };
  reconnectTimer = setTimeout(tick, 500);
}

function stopReconnectLoop() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectDelay = RECONNECT_MIN;
}

// Renderer CRASH (process gone) — distinct from backend-unreachable. Reload up
// to maxRendererRecovery times, then show the recovery screen.
function loadRecoveryScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  log.error(`Renderer crashed ${rendererFailures}x — showing recovery screen`);
  mainWindow
    .loadFile(path.join(__dirname, "recovery.html"))
    .catch((e) => log.error("Failed to load recovery screen:", e));
  if (!mainWindow.isVisible()) mainWindow.show();
}

function handleRendererCrash(reason) {
  if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
  // AUDIT P2 (#36): disarm OS input injection when the renderer that authorized it
  // is gone. A crash/reload must require a fresh rc:arm grant, so a subsequent XSS
  // or a stray forwarded rc:inject can't drive the machine after recovery.
  rcArmed = false;
  rendererFailures++;
  log.error(`Renderer crash (${reason}) — attempt ${rendererFailures}/${appInfo.maxRendererRecovery}`);
  if (rendererFailures <= appInfo.maxRendererRecovery) {
    setTimeout(() => {
      if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) connectToApp();
    }, 1000);
  } else {
    loadRecoveryScreen();
  }
}

// ── Screen-share source picker (Electron-only) ──────────────────────────────
// A native, in-app picker showing every screen + window as a live thumbnail, so
// the user explicitly chooses what to share (entire screen / a monitor / a single
// window). Resolves with the chosen desktopCapturer source id, or null if the
// user cancelled. Used as the handler for getDisplayMedia() on platforms where
// the OS system picker isn't available.
function openScreenPicker(sources) {
  return new Promise((resolve) => {
    if (pickerWin && !pickerWin.isDestroyed()) {
      pickerWin.focus();
      return resolve(null);
    }
    let done = false;
    const finish = (id) => {
      if (done) return;
      done = true;
      ipcMain.removeListener("picker:choose", onChoose);
      if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
      pickerWin = null;
      resolve(id || null);
    };
    const onChoose = (event, id) => {
      if (pickerWin && event.sender === pickerWin.webContents) finish(id);
    };

    pickerWin = new BrowserWindow({
      width: 780,
      height: 580,
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "Choose what to share",
      backgroundColor: "#11141b",
      webPreferences: {
        preload: path.join(__dirname, "screenpicker-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    pickerWin.setMenuBarVisibility(false);

    const payload = (sources || []).map((s) => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      isScreen: s.id.startsWith("screen"),
    }));

    ipcMain.on("picker:choose", onChoose);
    pickerWin.once("ready-to-show", () => {
      try { pickerWin.webContents.send("picker:sources", payload); } catch { }
      pickerWin.show();
    });
    pickerWin.on("closed", () => finish(null));
    pickerWin.loadFile(path.join(__dirname, "screenpicker.html")).catch((e) => {
      log.error("screen picker load failed:", e && e.message);
      finish(null);
    });
  });
}

// Install media permission + screen-share handlers on the session. Without these
// the hosted app's getUserMedia()/getDisplayMedia() are denied in Electron.
function setupDesktopMedia() {
  const ses = session.defaultSession;
  // Any download the page triggers itself (an <a download> for an oversized
  // attachment's streaming link, a CSV export, …) also lands in Downloads with
  // no dialog — Electron would otherwise prompt "Save As" for every one.
  ses.on("will-download", (_event, item) => {
    try {
      item.setSavePath(uniqueDownloadPath(sanitizeDragName(item.getFilename(), item.getMimeType())));
    } catch (e) {
      log.warn("will-download: could not pin save path (default dialog):", e && e.message);
    }
  });
  // AUDIT P2 (#35) kept, but narrowed to the permission that actually needs it.
  //
  // The original rule granted camera, microphone AND screen capture only to our
  // own origin, explicitly refusing "an in-window IdP/SSO page". That also
  // refused the CAMERA to the SSO page doing face verification — the desktop app
  // showed "Camera permission was blocked" where the same sign-in worked in a
  // browser. Sign-in is a flow we already trust in-window (cfg.authOrigins is
  // what lets it navigate there at all), so those origins may use the camera and
  // microphone. Screen capture stays ours alone: no sign-in flow needs it, and
  // an IdP recording the user's screen is never legitimate.
  //
  // The decision lives in ./mediaPermissions — pure, and unit-tested, because a
  // slip here either breaks sign-in or hands the camera to any loaded page.
  const gate = createPermissionGate({
    appOrigin: cfg.origin,
    authOrigins: cfg.authOrigins,
  });
  const originOf = (u) => {
    try { return new URL(u || "").origin; } catch { return ""; }
  };
  const grantPerm = (permission, url, ctx) => {
    const ok = gate.grant(permission, url, ctx);
    // A denial used to be invisible — the only symptom was an error message
    // inside the page. Log it so the next one is diagnosable from the log.
    if (!ok && (permission === "media" || permission === "display-capture"))
      log.warn(
        `permission denied: ${permission} for ${originOf(url) || "(unknown origin)"} ` +
        `(allowed for camera/mic: ${gate.cameraOrigins.join(", ") || "none"})`,
      );
    return ok;
  };
  log.info("camera/mic permitted for:", gate.cameraOrigins.join(", ") || "none");
  // The OTHER thing that blocks a camera, and the one our handler cannot fix:
  // the operating system's own privacy switch (Windows: Settings › Privacy &
  // security › Camera › "Let desktop apps access your camera"; macOS: TCC).
  // When that is off Chromium gets nothing however we answer, and the page shows
  // the same "Camera permission was blocked" message. Record the state at
  // startup so it is diagnosable, and deal with it AT THE TIME OF USE below.
  const osMediaStatus = (device) => {
    try {
      if (process.platform !== "darwin" && process.platform !== "win32") return "granted";
      return systemPreferences.getMediaAccessStatus
        ? systemPreferences.getMediaAccessStatus(device)
        : "unknown";
    } catch {
      return "unknown";
    }
  };
  log.info(
    `OS media access — camera: ${osMediaStatus("camera")}, microphone: ${osMediaStatus("microphone")}`,
  );
  // NOTE: the OS prompt used to be raised here, at launch, with no window and no
  // context. Users dismissed it ("Don't Allow"), which macOS remembers forever —
  // and every later getUserMedia, including the SSO face check, then failed with
  // the same "permission blocked" message. It is now asked when a page actually
  // wants the device (see ensureOsMediaAccess), which is also what Apple expects.

  // Where the user can flip the switch back on, per OS. Both URL schemes open
  // the privacy pane directly.
  const OS_PRIVACY_PANE = {
    darwin: {
      camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
      microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    },
    win32: {
      camera: "ms-settings:privacy-webcam",
      microphone: "ms-settings:privacy-microphone",
    },
  };
  // Explain an OS-level block ONCE per device per run — a page may retry
  // getUserMedia in a loop and must not be able to spam native dialogs.
  const osBlockExplained = new Set();
  const explainOsBlock = (device) => {
    if (osBlockExplained.has(device)) return;
    osBlockExplained.add(device);
    const pane = (OS_PRIVACY_PANE[process.platform] || {})[device];
    const where =
      process.platform === "darwin"
        ? "System Settings › Privacy & Security › " + (device === "camera" ? "Camera" : "Microphone")
        : "Settings › Privacy & security › " + (device === "camera" ? "Camera" : "Microphone");
    log.warn(`The OPERATING SYSTEM is blocking ${device} access for this app (${where}).`);
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    dialog
      .showMessageBox(owner, {
        type: "warning",
        title: appInfo.appName,
        message: `${appInfo.appName} is not allowed to use your ${device}`,
        detail:
          `Your operating system is blocking ${device} access for this app, so pages that need it ` +
          `(such as sign-in verification and calls) cannot use it.\n\n` +
          `Turn it on under ${where}` +
          (process.platform === "win32" ? ` (including "Let desktop apps access your ${device}")` : "") +
          `, then try again.`,
        buttons: pane ? ["Open Settings", "Not now"] : ["OK"],
        defaultId: 0,
        cancelId: pane ? 1 : 0,
        noLink: true,
      })
      .then((r) => {
        if (pane && r && r.response === 0) shell.openExternal(pane).catch(() => { });
      })
      .catch(() => { });
  };
  // Make sure the OS lets this app reach the devices a getUserMedia() call asked
  // for. macOS: raise the TCC prompt now (first use) and wait for the answer, so
  // Chromium sees the final state instead of racing the prompt. Windows: nothing
  // an app can prompt for — detect the privacy switch and tell the user. Returns
  // true when every requested device is usable, false when the OS blocks one.
  const ensureOsMediaAccess = async (mediaTypes) => {
    const types = Array.isArray(mediaTypes) && mediaTypes.length ? mediaTypes : ["video", "audio"];
    const devices = [];
    if (types.includes("video")) devices.push("camera");
    if (types.includes("audio")) devices.push("microphone");
    let ok = true;
    for (const device of devices) {
      let status = osMediaStatus(device);
      if (
        status === "not-determined" &&
        process.platform === "darwin" &&
        systemPreferences.askForMediaAccess
      ) {
        try {
          status = (await systemPreferences.askForMediaAccess(device)) ? "granted" : "denied";
        } catch (e) {
          log.warn(`askForMediaAccess(${device}) failed:`, e && e.message);
          status = "unknown";
        }
        log.info(`OS ${device} access after prompt: ${status}`);
      }
      if (status === "denied" || status === "restricted") {
        ok = false;
        explainOsBlock(device);
      }
    }
    return ok;
  };
  const topUrlOf = (wc) => {
    try { return wc && wc.getURL ? wc.getURL() : ""; }
    catch { return ""; }
  };
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const topUrl = topUrlOf(wc);
    // details.requestingUrl is the URL of the FRAME asking — for an <iframe>
    // that is the iframe's own URL, not the page's; the page is `topUrl`.
    const url = (details && details.requestingUrl) || topUrl;
    const ok = grantPerm(permission, url, { topUrl });
    if (!ok || permission !== "media") return cb(ok);
    // Our answer is "yes" — now make sure the OS agrees, or say why not. The
    // request is still granted either way: when the OS blocks the device,
    // Chromium fails the call itself, and a wrong "denied" reading from the OS
    // must never hide a camera that actually works.
    ensureOsMediaAccess(details && details.mediaTypes)
      .catch(() => true)
      .then(() => cb(true));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    // Sub-frame checks carry the page's origin in details.embeddingOrigin.
    const topUrl = (details && details.embeddingOrigin) || topUrlOf(wc);
    return grantPerm(permission, requestingOrigin || topUrl, { topUrl });
  });

  // getDisplayMedia() → native picker. `useSystemPicker:true` uses the OS picker
  // where available (newer Windows/macOS); elsewhere our custom picker runs.
  // Each call is independent → multiple concurrent screen shares are supported.
  try {
    ses.setDisplayMediaRequestHandler(
      (request, callback) => {
        desktopCapturer
          .getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 320, height: 200 },
            fetchWindowIcons: true,
          })
          .then((sources) => {
            if (!sources || !sources.length) return callback({});
            openScreenPicker(sources).then((chosenId) => {
              const src = chosenId && sources.find((s) => s.id === chosenId);
              if (!src) return callback({}); // cancelled → deny cleanly
              // Remember which DISPLAY is shared so remote-control input lands on
              // the right monitor (multi-monitor). Window shares keep the last.
              if (src.display_id) {
                rcShareDisplayId = src.display_id;
                try { remoteInput.setDisplay(rcShareDisplayId); } catch (_) { }
              }
              // System-audio capture alongside the share (Windows supports loopback).
              const audio = process.platform === "win32" ? "loopback" : undefined;
              callback(audio ? { video: src, audio } : { video: src });
            });
          })
          .catch((e) => {
            log.error("display-media handler failed:", e && e.message);
            callback({});
          });
      },
      { useSystemPicker: true },
    );
    log.info("Media + screen-share handlers installed");
  } catch (e) {
    log.error("Failed to install screen-share handler:", e && e.message);
  }
}

// ── Native context menu + spellcheck (premium input) ────────────────────────
// A clear desktop-vs-web win: Chromium's built-in spellchecker paints red
// squiggles in the composer (the Tiptap editor already requests spellcheck:true),
// and this native right-click menu makes the suggestions actionable + gives real
// Cut/Copy/Paste/Select-All everywhere + "Open link in browser"/"Copy link" on a
// hyperlink. Purely additive: it never touches calls/meetings, E2EE, or the
// upload pipeline, and every step is guarded so a failure is a quiet no-op.
//
// Spellcheck language: Chromium's spellchecker is ON by default. We only set an
// explicit language list if the system locale resolves to one Chromium ships a
// dictionary for, so we don't accidentally DISABLE spellcheck by passing an
// unsupported tag. Best-effort + guarded.
function setupSpellchecker() {
  try {
    const ses = session.defaultSession;
    if (!ses || typeof ses.setSpellCheckerLanguages !== "function") return;
    let available = [];
    try { available = ses.availableSpellCheckerLanguages || []; } catch (_) { }
    // Prefer the OS UI locale (e.g. "en-US"); fall back to a bare language match
    // ("en" → "en-US") so a locale like "en-IN" still enables English checking.
    const locale = (app.getLocale && app.getLocale()) || "en-US";
    const candidates = [];
    if (locale) {
      candidates.push(locale);
      const base = locale.split("-")[0];
      if (base) {
        const match = available.find((l) => l.toLowerCase().startsWith(base.toLowerCase()));
        if (match) candidates.push(match);
      }
    }
    const langs = candidates.filter((l) => !available.length || available.includes(l));
    if (langs.length) {
      ses.setSpellCheckerLanguages([...new Set(langs)]);
      log.info("Spellchecker languages: " + langs.join(", "));
    }
    // else: leave Chromium's default language selection untouched (still on).
  } catch (e) {
    log.warn("setupSpellchecker failed (skipped):", e && e.message);
  }
}

// Build + pop up the native right-click menu for a given webContents. Wired on
// the main window AND each pop-out (same handler pattern). Everything is keyed on
// the `params` Electron hands us (editFlags / isEditable / misspelledWord /
// linkURL / selectionText) and guarded so it can never crash the renderer.
function attachContextMenu(wc) {
  if (!wc || typeof wc.on !== "function") return;
  wc.on("context-menu", (_event, params) => {
    try {
      const template = [];
      const ef = params.editFlags || {};

      // ── Spelling suggestions for a misspelled word (composer red squiggle) ──
      if (params.misspelledWord) {
        const suggestions = Array.isArray(params.dictionarySuggestions)
          ? params.dictionarySuggestions.slice(0, 5)
          : [];
        for (const s of suggestions) {
          template.push({
            label: s,
            click: () => { try { wc.replaceMisspelling(s); } catch (_) { } },
          });
        }
        if (!suggestions.length) {
          template.push({ label: "No spelling suggestions", enabled: false });
        }
        template.push({
          label: "Add to dictionary",
          click: () => {
            try {
              session.defaultSession.addWordToSpellCheckerDictionary(params.misspelledWord);
            } catch (_) { }
          },
        });
        template.push({ type: "separator" });
      }

      // ── Standard editing items (roles do the actual work) ──────────────────
      if (params.isEditable) {
        template.push(
          { role: "cut", enabled: !!ef.canCut },
          { role: "copy", enabled: !!ef.canCopy },
          { role: "paste", enabled: !!ef.canPaste },
          { type: "separator" },
          { role: "selectAll", enabled: ef.canSelectAll !== false },
        );
      } else if (params.selectionText && params.selectionText.trim()) {
        // Read-only selection → just Copy.
        template.push({ role: "copy", enabled: ef.canCopy !== false });
      }

      // ── Hyperlink actions (http/https only) ────────────────────────────────
      const link = typeof params.linkURL === "string" ? params.linkURL : "";
      if (/^https?:\/\//i.test(link)) {
        if (template.length) template.push({ type: "separator" });
        template.push(
          {
            label: "Open link in browser",
            click: () => { shell.openExternal(link).catch(() => { }); },
          },
          {
            label: "Copy link",
            click: () => { try { clipboard.writeText(link); } catch (_) { } },
          },
        );
      }

      if (!template.length) return; // nothing applicable → no menu (don't crash)
      const menu = Menu.buildFromTemplate(template);
      const win = BrowserWindow.fromWebContents(wc);
      menu.popup(win ? { window: win } : undefined);
    } catch (e) {
      log.warn("context-menu build failed (skipped):", e && e.message);
    }
  });
}

// ── Application menu ─────────────────────────────────────────────────────────
// Windows/Linux: NO menu lane (clean, theme-blended chrome). Keyboard shortcuts
// for cut/copy/paste/undo/redo/selectAll still work — they're handled by the
// renderer's DOM input fields, not menu roles.
// macOS: keep a minimal menu so Cmd+Q / Cmd+W / clipboard roles fire — macOS
// users expect a top-of-screen menu and we still hide the title-bar chrome via
// titleBarStyle:"hidden". "About" + "Check for Updates" stay reachable from the
// app submenu; the renderer can also trigger updates via collabDesktop.
function buildAppMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const aboutItem = {
    label: "About " + appInfo.appName,
    click: () => {
      dialog.showMessageBox(mainWindow || undefined, {
        type: "info",
        title: "About " + appInfo.appName,
        message: appInfo.appName,
        detail: `Version ${app.getVersion()} (build ${appInfo.build})\nChannel: ${appInfo.channel}\nEnvironment: ${cfg ? cfg.env : "?"}\n\nElectron ${appInfo.electronVersion}\nChromium ${appInfo.chromiumVersion}`,
        buttons: ["OK"],
      });
    },
  };
  const updateItem = {
    label: "Check for Updates…",
    // The native menu keeps the classic OS dialogs (source "menu") — a guaranteed
    // path independent of the in-app UI.
    click: () => { if (cfg) checkForUpdates(cfg, mainWindow, { manual: true, source: "menu" }); },
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: app.name, submenu: [aboutItem, updateItem, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
      { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] },
    ]),
  );
}

// ── Window creation ─────────────────────────────────────────────────────────
async function createWindow() {
  const rawBounds = getWindowBounds();
  const firstLaunch = isFirstLaunch();
  const bounds = firstLaunch ? rawBounds : clampToScreen(rawBounds);

  // Per-OS native window controls (each platform keeps its OWN convention; the
  // web chrome adapts via the os-mac/os-win body class + platform-gated pills):
  //  • macOS   → NATIVE traffic lights top-LEFT via titleBarStyle:'hiddenInset',
  //              nudged into the header band by trafficLightPosition. The web
  //              chrome renders NO custom pills on mac, and shifts the logo right
  //              of the lights (fixes the reported traffic-light↔logo overlap).
  //              NOTE: 'hidden' (the old value) still SHOWS the traffic lights at
  //              the default top-left corner — that is exactly what overlapped.
  //  • Windows → frameless; the web chrome paints its own min/max/close pills
  //              top-right (Windows convention), cleared by a right inset.
  //  • Linux   → NATIVE frame + the desktop environment's own controls; no custom
  //              web chrome is applied (os class omitted), so nothing is forced.
  const chromeOpts =
    process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } }
      : process.platform === "linux"
        ? { frame: true }
        : { frame: false };
  const winOpts = {
    width: bounds.width,
    height: bounds.height,
    minWidth: appInfo.window.minWidth,
    minHeight: appInfo.window.minHeight,
    show: false,
    ...chromeOpts,
    title: appInfo.appName,
    backgroundColor: "#0b0a14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Keep timers / WebRTC / sockets running at full speed even when the window
      // is backgrounded or hidden to the tray (close-to-tray). Chromium otherwise
      // throttles background tabs, which would stall an in-progress call's keep-
      // alives and the realtime socket while the app sits in the tray.
      backgroundThrottling: false,
    },
  };

  if (firstLaunch) winOpts.center = true;
  else { winOpts.x = bounds.x; winOpts.y = bounds.y; }

  mainWindow = new BrowserWindow(winOpts);

  // ── Native right-click menu + spellcheck suggestions (premium input) ───
  attachContextMenu(mainWindow.webContents);

  // ── Security: keep navigation pinned to the app origin — EXCEPT the SSO/OAuth
  // IdP origins (cfg.authOrigins), which MUST load in-window so the full login →
  // authenticator → callback round-trip completes inside the app. Without this the
  // IdP (off-origin, e.g. oa.re.cx) was kicked to the system browser mid-flow, which
  // restarted SSO and re-prompted for credentials. Everything else still opens
  // externally.
  const allowedInApp = (url) => {
    if (typeof url !== "string") return false;
    try {
      // Compare by ORIGIN (not startsWith) so a look-alike host like
      // collab.resulticks.com.evil.example cannot slip through a prefix match.
      const o = new URL(url).origin;
      return o === cfg.origin || (cfg.authOrigins || []).includes(o);
    } catch { return false; }
  };
  const isAuthOrigin = (url) => {
    try { return (cfg.authOrigins || []).includes(new URL(url).origin); }
    catch { return false; }
  };
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!allowedInApp(url)) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => { });
    }
  });

  // ── Security: new-window / target=_blank → system browser, EXCEPT popups to the
  // SSO/OAuth IdP origins. Some IdP/MFA flows open the authenticator in a popup
  // (window.open); those must open IN-APP so the flow finishes here — the
  // will-navigate allowlist above only covers top-frame navigation. Everything else
  // (incl. app-origin target=_blank) still goes to the system browser.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const { url } = details;
    if (isAuthOrigin(url)) return { action: "allow" };
    // Screen-share pop-out (blank, same-origin, opener-scripted) → real window.
    if (isSharePopoutRequest(details)) return sharePopoutWindowOptions();
    if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => { });
    return { action: "deny" };
  });
  mainWindow.webContents.on("did-create-window", hardenSharePopout);

  // ── Back-to-app affordance on the in-window SSO IdP pages ──────────────
  // The IdP (oa.re.cx …) now loads INSIDE the app window, which has no browser
  // chrome — so a user who starts SSO has no way back to the app's own sign-in.
  // Inject a small "← Back to sign in" button on auth-origin pages that returns the
  // window to the app origin. Re-injected on every navigation (login → authenticator
  // are separate page loads); never shown on the app's own pages.
  // Placement follows the window chrome of each OS (see createWindow):
  //  • macOS   → the native traffic lights sit at x:16,y:18 (12px dots, 8px
  //              apart → they end at x≈68, centre-line y≈24). The button starts
  //              at x:84 and is vertically centred on that line — it used to sit
  //              at 14,14 and overlap the lights.
  //  • Windows → frameless, nothing in the top-left; keep the corner.
  //  • Linux   → native frame above the page; keep the corner.
  //    macOS 26+ (Darwin 25+) draws the lights ~2.5px lower for the same
  //    trafficLightPosition (measured centre-line y≈26.5), so the button drops to
  //    top:9px there to stay centred on them; older macOS keeps top:7px. left:76
  //    leaves a ~12px gap after the last light (ends x≈64).
  const darwinMajor = process.platform === "darwin"
    ? parseInt(require("os").release().split(".")[0], 10) || 0
    : 0;
  const SSO_BACK_POS =
    process.platform === "darwin"
      ? darwinMajor >= 25 ? "top:40px;left:0px;" : "top:7px;left:76px;"
      : "top:14px;left:14px;";
  const injectSsoBackButton = (url) => {
    if (!isAuthOrigin(url)) return;
    const appOrigin = JSON.stringify(cfg.origin);
    mainWindow.webContents
      .executeJavaScript(
        `(function(){try{
          if(document.getElementById('__colab_sso_back'))return;
          var b=document.createElement('button');
          b.id='__colab_sso_back';
          b.type='button';
          b.textContent='\\u2190 Back to sign in';
          b.style.cssText='position:fixed;${SSO_BACK_POS}z-index:2147483647;box-sizing:border-box;display:inline-flex;align-items:center;height:34px;padding:0 13px;margin:0;font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;white-space:nowrap;color:#fff;background:rgba(24,22,34,.86);border:1px solid rgba(255,255,255,.28);border-radius:9px;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.35);-webkit-app-region:no-drag;user-select:none;-webkit-user-select:none';
          b.onmouseenter=function(){b.style.background='rgba(24,22,34,.97)';};
          b.onmouseleave=function(){b.style.background='rgba(24,22,34,.86)';};
          b.onclick=function(){window.location.href=${appOrigin};};
          (document.body||document.documentElement).appendChild(b);
        }catch(e){}})();`,
      )
      .catch(() => { });
  };
  mainWindow.webContents.on("did-navigate", (_e, url) => injectSsoBackButton(url));
  mainWindow.webContents.on("did-frame-navigate", (_e, url, _c, _s, isMainFrame) => {
    if (isMainFrame) injectSsoBackButton(url);
  });

  // ── Reset counters when the real app loads cleanly ─────────────────────
  mainWindow.webContents.on("did-finish-load", () => {
    const u = mainWindow.webContents.getURL();
    if (u && u.startsWith(cfg.origin)) {
      if (rendererFailures > 0) log.info("App loaded cleanly — recovery counter reset");
      rendererFailures = 0;
      stopReconnectLoop();
      // Belt-and-braces: re-deliver any queued deep links once the real app is
      // loaded, even if the renderer's explicit deepLinkReady hasn't fired yet
      // (e.g. an older bundle without the handler). Safe — the renderer ignores
      // links it can't route, and the flush only sends queued items.
      flushDeepLinks();
    }
  });

  // ── Backend unreachable → reconnect screen + auto-retry ────────────────
  mainWindow.webContents.on("did-fail-load", (_event, code, description, failingUrl, isMainFrame) => {
    if (isQuitting || !isMainFrame || code === -3) return; // -3 = ABORTED (benign)
    log.warn(`did-fail-load: ${code} ${description} (${failingUrl})`);
    showReconnectScreen();
    startReconnectLoop();
  });

  // ── Renderer crash → recovery flow ─────────────────────────────────────
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    handleRendererCrash("render-process-gone:" + details.reason);
  });

  mainWindow.webContents.on("unresponsive", () => log.warn("Renderer became unresponsive"));
  mainWindow.webContents.on("responsive", () => log.info("Renderer responsive again"));
  mainWindow.webContents.on("preload-error", (_e, p, error) => log.error("Preload error in", p, "-", error));

  // Always launch MAXIMIZED (full size); the saved/default windowed bounds become
  // the restore-down size. maximize() before show() avoids a windowed-size flash.
  mainWindow.on("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.on("resize", saveWindowBounds);
  mainWindow.on("move", saveWindowBounds);

  // ── Close-to-tray ──────────────────────────────────────────────────────────
  // When the "keep running in background" pref is ON (default, Slack-style) and
  // the user clicks X (not a real Quit), HIDE the window instead of quitting —
  // the socket/LiveKit/reconnect logic all keep running in the live renderer.
  // A real quit (tray Quit, before-quit, Cmd+Q/Alt+F4 menu role) sets isQuitting
  // first, so this guard lets the close proceed and the app exits as before.
  // No tray → never trap the window (can't be reopened), so X always quits.
  mainWindow.on("close", (event) => {
    if (isQuitting) return; // real quit — let it close
    if (!tray) return; // no tray to restore from → quit normally
    if (!getDesktopPrefs().closeToTray) return; // pref OFF → quit as before
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  });

  mainWindow.on("closed", () => { mainWindow = null; });

  // Broadcast maximize state so the in-app chrome can flip the maximize/restore
  // icon. Frameless windows have no native button — this is how the renderer
  // stays in sync.
  const pushMax = () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("desktop:maximize-changed", mainWindow.isMaximized());
      }
    } catch { }
  };
  mainWindow.on("maximize", pushMax);
  mainWindow.on("unmaximize", () => { pushMax(); ensureOnScreen(); });
  mainWindow.on("restore", ensureOnScreen); // returning from the taskbar
  mainWindow.on("enter-full-screen", pushMax);
  mainWindow.on("leave-full-screen", () => { pushMax(); ensureOnScreen(); });

  // ── Native Picture-in-Picture / Floating Call Window ────────────────────
  ipcMain.on("desktop:set-pip", (_event, on) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.setAlwaysOnTop(!!on, "floating");
      if (on) {
        mainWindow.show();
        mainWindow.focus();
      }
    } catch (e) {
      log.warn("desktop:set-pip handler error:", e && e.message);
    }
  });

  // DevTools auto-open is OFF by default: while DevTools is open, Chromium paints
  // a "<w>px × <h>px" viewport overlay on every window resize, which reads as a
  // CoLab glitch. Opt in with COLLAB_DEVTOOLS=1, or toggle any time with F12 /
  // Ctrl+Shift+I. (Packaged builds never open DevTools, so users never see it.)
  if (isDev && process.env.COLLAB_DEVTOOLS === "1")
    mainWindow.webContents.openDevTools({ mode: "detach" });
  if (isDev) {
    mainWindow.webContents.on("before-input-event", (_e, input) => {
      if (
        input.type === "keyDown" &&
        (input.key === "F12" ||
          (input.control && input.shift && (input.key === "I" || input.key === "i")) ||
          (input.meta && input.alt && (input.key === "I" || input.key === "i"))) // macOS
      ) {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }

  connectToApp();
}

// ── IPC: Native notifications ───────────────────────────────────────────────
ipcMain.handle("desktop:show-notification", async (event, opts) => {
  if (!fromMain(event)) return null;
  if (!opts || typeof opts.title !== "string") return null;
  try {
    return createDesktopNotification(opts, mainWindow);
  } catch (e) {
    log.error("show-notification failed:", e);
    return null;
  }
});

// ── IPC: File dialogs ───────────────────────────────────────────────────────
ipcMain.handle("desktop:show-open-dialog", async (event, opts) => {
  if (!fromMain(event) || !mainWindow || mainWindow.isDestroyed()) {
    return { filePaths: [], canceled: true };
  }
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: opts && opts.title ? opts.title : "Select file",
      filters: (opts && opts.filters) || [],
      properties: (opts && opts.properties) || ["openFile"],
    });
    return { filePaths: result.filePaths, canceled: result.canceled };
  } catch (e) {
    log.error("show-open-dialog failed:", e);
    return { filePaths: [], canceled: true, error: e.message };
  }
});

// ── IPC: Clipboard ──────────────────────────────────────────────────────────
ipcMain.handle("desktop:clipboard-write", async (event, text) => {
  if (!fromMain(event) || typeof text !== "string") return false;
  try { clipboard.writeText(text); return true; }
  catch (e) { log.error("clipboard-write failed:", e); return false; }
});

ipcMain.handle("desktop:clipboard-read", async (event) => {
  if (!fromMain(event)) return "";
  try { return clipboard.readText(); }
  catch (e) { log.error("clipboard-read failed:", e); return ""; }
});

// ── IPC: Login credential store — browser-like autofill for the in-app sign-in.
// Electron ships no Chrome password manager, so we persist the sign-in creds
// ourselves, encrypted with the OS keychain via safeStorage, and let the login
// screen prefill them. Opt-in via the login "Remember me" checkbox; a
// remember-off login clears them. The blob is bound to the OS user account, so
// it can't be decrypted if copied to another machine / user.
const CRED_FILE = () => path.join(app.getPath("userData"), "login.cred");
ipcMain.handle("desktop:cred-get", (event) => {
  if (!fromMain(event)) return null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const o = JSON.parse(safeStorage.decryptString(require("fs").readFileSync(CRED_FILE())));
    return o && o.email ? { email: String(o.email), password: String(o.password || "") } : null;
  } catch { return null; }
});
ipcMain.handle("desktop:cred-save", (event, cred) => {
  if (!fromMain(event) || !cred || typeof cred.email !== "string" || !cred.email) return false;
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const buf = safeStorage.encryptString(JSON.stringify({ email: cred.email, password: String(cred.password || "") }));
    require("fs").writeFileSync(CRED_FILE(), buf, { mode: 0o600 });
    return true;
  } catch (e) { log.error("cred-save failed:", e); return false; }
});
ipcMain.handle("desktop:cred-clear", (event) => {
  if (!fromMain(event)) return false;
  try { require("fs").rmSync(CRED_FILE(), { force: true }); } catch { }
  return true;
});

// ── IPC: Open external URL in system browser (scheme-validated) ────────────
ipcMain.handle("desktop:open-external", async (event, url) => {
  if (!fromMain(event) || typeof url !== "string") return false;
  if (!/^https?:\/\//.test(url)) return false;
  try { await shell.openExternal(url); return true; }
  catch (e) { log.error("open-external failed:", e); return false; }
});

// ── IPC: Remote Control (controlled side) — OS input injection ──────────────
// Whether native input injection is usable on this host (false on browsers,
// missing binary, or OS-blocked sessions like Wayland).
ipcMain.handle("rc:available", async (event) => {
  if (!fromMain(event)) return { available: false, error: "ipc" };
  let trusted = true;
  try {
    if (process.platform === "darwin")
      trusted = systemPreferences.isTrustedAccessibilityClient(false);
  } catch (_) { }
  return {
    available: remoteInput.available() && trusted,
    error: remoteInput.loadErr() || (trusted ? null : "macos-accessibility"),
  };
});
// Renderer arms/disarms injection on session grant/revoke (defense-in-depth on
// top of the renderer's own session gate).
ipcMain.on("rc:arm", (event, on) => {
  if (!fromMain(event)) return;
  if (on && process.platform === "darwin") {
    // macOS requires Accessibility permission to inject input — prompt once and
    // refuse to arm until the user grants it (System Settings → Privacy).
    try {
      if (!systemPreferences.isTrustedAccessibilityClient(true)) {
        rcArmed = false;
        return;
      }
    } catch (_) { }
  }
  rcArmed = !!on;
  try { remoteInput.resetLocalPriority(); } catch (_) { } // fresh session starts with no stale yield
});
// A single validated input event from the active controller — injected only
// while a granted session is armed.
ipcMain.on("rc:inject", (event, ev) => {
  if (!fromMain(event) || !rcArmed) return;
  remoteInput.inject(ev);
});

// ── IPC: Window controls ────────────────────────────────────────────────────
// Resolve the target from the SENDER's webContents, not a hardcoded mainWindow,
// so the controls work for ANY of our frameless windows (the main window AND a
// native pop-out — both render <DesktopChrome> and call this same channel). For
// the main window the resolved target IS mainWindow, so its behaviour is
// identical to before; for a pop-out the buttons act on the pop-out itself.
ipcMain.on("desktop:window-control", (event, action) => {
  if (!fromColab(event)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (action === "minimize") win.minimize();
  else if (action === "maximize") win.maximize();
  else if (action === "unmaximize") win.unmaximize();
  else if (action === "toggle-maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === "close") win.close();
});

// Renderer needs the initial maximize state on mount (no max-changed event will
// have fired yet). Synchronous-style invoke is cheaper than polling. Resolves
// the SENDER's window so a pop-out seeds its OWN maximize/restore icon (not the
// main window's). For the main window the sender IS mainWindow → identical.
ipcMain.handle("desktop:window-state", (event) => {
  if (!fromColab(event)) {
    return { maximized: false, fullscreen: false, platform: process.platform };
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) {
    return { maximized: false, fullscreen: false, platform: process.platform };
  }
  return {
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    platform: process.platform,
  };
});

// ── IPC: Native pop-out windows (Tier 5) ────────────────────────────────────
// Replace the browser `window.open(... ?conversation=<id>)` chat pop-out with a
// real, in-app BrowserWindow when running on desktop. The pop-out:
//   • loads cfg.origin + the SAME `?conversation=<id>` contract the web app
//     already auto-opens on boot (see CoLabV1 convLinkDoneRef) — no new contract.
//   • uses the SAME preload + webPreferences as the main window, and the DEFAULT
//     session/partition, so it shares localStorage and is already authenticated.
//   • is frameless → renders <DesktopChrome>; its min/max/close drive
//     desktop:window-control, which now targets the SENDER window (this pop-out).
//   • is SECONDARY: its 'close' never hides-to-tray or quits (no close handler).
//   • is pinned to cfg.origin for navigation, exactly like the main window.
function buildPopoutUrl(opts) {
  // Same-origin only. Build from cfg.origin and attach the existing query
  // contract; reject anything that would point off-origin.
  let target;
  try {
    target = new URL(cfg.origin);
  } catch {
    return null;
  }
  // Optional path override (defaults to the app root "/"). Must stay same-origin.
  if (opts && typeof opts.path === "string" && opts.path) {
    try {
      const resolved = new URL(opts.path, cfg.origin);
      if (resolved.origin !== target.origin) return null; // off-origin → reject
      target = resolved;
    } catch {
      return null;
    }
  }
  const conv = opts && typeof opts.conversation === "string" ? opts.conversation : "";
  // ISSUE #9: popout=1 makes the renderer hide the rail/sidebar/top bar so the
  // window shows ONLY this conversation (Teams-style single-chat pop-out).
  if (conv)
    target.search =
      "?conversation=" + encodeURIComponent(conv) + "&popout=1";
  // Final guard: never return a URL whose origin drifted from cfg.origin.
  if (target.origin !== new URL(cfg.origin).origin) return null;
  return target.toString();
}

function createPopoutWindow(url, conversation, size) {
  // Caller-suggested size (e.g. the org window wants ~1000×760, a chat pop-out
  // the slim default), clamped to sane bounds. Renderer input is untrusted.
  const clamp = (v, lo, hi, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const popup = new BrowserWindow({
    width: clamp(size && size.width, 360, 1800, 460),
    height: clamp(size && size.height, 400, 1400, 820),
    minWidth: 360,
    minHeight: 480,
    show: false,
    // Same per-OS chrome as the main window (createWindow): frame:false was
    // stripping the native traffic lights on macOS and the native frame on Linux
    // while the web chrome only paints pills on Windows — leaving mac/Linux
    // pop-outs with NO window controls at all. macOS → hidden-inset traffic
    // lights; Linux → native frame; Windows → frameless (web pills + carve-out).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } }
      : process.platform === "linux"
        ? { frame: true }
        : { frame: false }),
    title: appInfo.appName,
    backgroundColor: "#0b0a14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // No `partition` on purpose → DEFAULT session, so the pop-out shares
      // localStorage/cookies with the main window and is already logged in.
    },
  });

  const entry = { win: popup, conversation: conversation || "", url: url || "" };
  popoutWindows.add(entry);

  // ── Native right-click menu + spellcheck (same handler as the main window).
  attachContextMenu(popup.webContents);

  // ── Security: keep navigation pinned to the configured origin (same as main).
  popup.webContents.on("will-navigate", (event, navUrl) => {
    // AUDIT P2 (#34): compare by ORIGIN, not a startsWith prefix, so a look-alike
    // host (e.g. collab.example.com.evil.test) can't load attacker content into a
    // window that carries the preload bridge + the authenticated session.
    let ok = false;
    try {
      const o = new URL(navUrl).origin;
      ok = o === cfg.origin || (cfg.authOrigins || []).includes(o);
    } catch {
      ok = false;
    }
    if (!ok) {
      event.preventDefault();
      if (/^https?:\/\//.test(navUrl)) shell.openExternal(navUrl).catch(() => { });
    }
  });
  // ── Security: new-window / target=_blank → system browser (same as main).
  popup.webContents.setWindowOpenHandler((details) => {
    const u = details.url;
    // Screen-share pop-out from a call running inside this chat window.
    if (isSharePopoutRequest(details)) return sharePopoutWindowOptions();
    if (/^https?:\/\//.test(u)) shell.openExternal(u).catch(() => { });
    return { action: "deny" };
  });
  popup.webContents.on("did-create-window", hardenSharePopout);

  // Keep the in-app maximize/restore chrome in sync (frameless → no native btn).
  const pushMax = () => {
    try {
      if (!popup.isDestroyed())
        popup.webContents.send("desktop:maximize-changed", popup.isMaximized());
    } catch { }
  };
  popup.on("maximize", pushMax);
  popup.on("unmaximize", pushMax);

  popup.once("ready-to-show", () => {
    if (!popup.isDestroyed()) popup.show();
  });
  // Secondary window: untrack on close. NO close-to-tray / quit logic here — a
  // pop-out closing must never take down the app (that's mainWindow's job only).
  popup.on("closed", () => {
    popoutWindows.delete(entry);
  });

  popup.setMenuBarVisibility(false);
  popup.loadURL(url).catch((e) => log.warn("pop-out loadURL rejected:", e && e.message));
  return popup;
}

ipcMain.handle("desktop:open-popout", async (event, opts) => {
  // fromColab so a pop-out (e.g. the Organization window) can itself open a chat
  // pop-out instead of silently no-opping. The de-dupe loop below prevents stacking.
  if (!fromColab(event) || !cfg) return { ok: false, error: "ipc" };
  const conversation =
    opts && typeof opts.conversation === "string" ? opts.conversation : "";

  const url = buildPopoutUrl(opts);
  if (!url) return { ok: false, error: "bad-url" }; // off-origin → refuse

  // De-dupe: an existing pop-out for the SAME conversation — or, for path-based
  // pop-outs like the org window, the SAME resolved URL — is focused, not
  // duplicated (repeated "Manage organization" clicks were stacking windows).
  for (const p of popoutWindows) {
    if (!p.win || p.win.isDestroyed()) continue;
    const same = conversation ? p.conversation === conversation : p.url === url;
    if (same) {
      if (p.win.isMinimized()) p.win.restore();
      p.win.show();
      p.win.focus();
      return { ok: true, focused: true };
    }
  }

  try {
    createPopoutWindow(url, conversation, {
      width: opts && opts.width,
      height: opts && opts.height,
    });
    return { ok: true };
  } catch (e) {
    log.error("open-popout failed:", e && e.message);
    return { ok: false, error: "create-failed" };
  }
});

// ── IPC: Drag a chat attachment OUT to the OS desktop ───────────────────────
// Desktop-only "drag file out": the renderer starts an HTML5 dragstart on an
// attachment, preventDefaults it, and calls collabDesktop.startDrag(...). We
// download the file to a temp path and hand it to Electron's native drag via
// event.sender.startDrag — so the user can drop it onto Explorer/Finder/the
// desktop and get a REAL file copy. This is purely additive: it never touches
// the in-app upload/download pipeline, calls/meetings, or E2EE. A failure at
// ANY step is a silent no-op (the native drag simply doesn't start) — it must
// NEVER crash the main process.
const DRAG_TEMP_DIR = () => path.join(app.getPath("temp"), "colab-drag");
const DRAG_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB hard cap (mirrors the app limit)
const DRAG_TIMEOUT_MS = 120000; // give up a stuck download after 2 min
let dragInFlight = false; // coalesce: ignore a second startDrag while one is downloading

// Strip a filename to a safe basename for the temp dir (no path separators,
// no traversal, bounded length) -- WHILE PRESERVING the real extension so the
// dropped file opens in the right native app (.py->VS Code, .xlsx->Excel, etc).
//
// CRITICAL: the dropped temp file's name decides which app the OS opens it with.
// Most code/data files (.py/.ts/.sql/.csv/.md/.yml) arrive with the real type
// ONLY in the filename extension (their MIME is text/plain or octet-stream), so
// we must NEVER drop or "correct" a present extension. Rule:
//   1. Sanitize the basename's illegal chars -- but keep the dot, so the final
//      ".ext" survives.
//   2. If the sanitized name already ends in a sane extension (a final ".ext" of
//      1-8 alphanumerics), KEEP it verbatim.
//   3. ONLY if there's no extension, append one derived from the MIME (else .bin)
//      -- so the dropped file is never extensionless and always opens somewhere.
function sanitizeDragName(name, mime) {
  let base = typeof name === "string" ? name : "";
  // Keep only the basename (defend against "../" / absolute paths smuggled in).
  base = base.replace(/^.*[\\/]/, "").replace(/[ -<>:"|?*]/g, "_").trim();
  base = base.replace(/^\.+/, "").slice(0, 180); // no leading dots, bounded
  // A "sane extension" = a non-empty stem, a dot, then 1-8 alphanumerics.
  const hasSaneExt = /^.+\.[A-Za-z0-9]{1,8}$/.test(base);
  if (!base) {
    const ext = mimeToExt(mime);
    base = "attachment" + (ext ? "." + ext : ".bin");
  } else if (!hasSaneExt) {
    // No real extension on the filename -> derive one from the MIME so the OS
    // still opens it in the right app. Falls back to .bin (never extensionless).
    const ext = mimeToExt(mime);
    base = base + "." + (ext || "bin");
  }
  return base;
}

// Map a MIME type to a file extension. Covers code/data/office/archive/media
// types so a drag-out whose filename LACKS an extension still lands as a real,
// openable file. This is the FALLBACK path -- when the original filename already
// carries a real extension, sanitizeDragName keeps that verbatim and this map is
// not consulted. Returns "" when unknown (caller falls back to .bin).
function mimeToExt(mime) {
  const m = (typeof mime === "string" ? mime : "").toLowerCase().split(";")[0].trim();
  const map = {
    // -- Text / code / data --
    "text/plain": "txt", "text/markdown": "md", "text/x-markdown": "md",
    "text/csv": "csv", "text/tab-separated-values": "tsv",
    "text/html": "html", "text/css": "css", "text/calendar": "ics",
    "application/json": "json", "application/ld+json": "json",
    "application/xml": "xml", "text/xml": "xml",
    "application/javascript": "js", "text/javascript": "js",
    "application/typescript": "ts", "text/typescript": "ts",
    "text/x-python": "py", "application/x-python": "py", "text/x-python-script": "py",
    "application/x-sh": "sh", "text/x-shellscript": "sh",
    "application/sql": "sql", "text/x-sql": "sql",
    "application/x-yaml": "yml", "text/yaml": "yml", "text/x-yaml": "yml",
    "text/x-java-source": "java", "text/x-c": "c", "text/x-c++": "cpp",
    "text/x-go": "go", "text/x-rust": "rs", "text/rtf": "rtf", "application/rtf": "rtf",
    // -- Archives --
    "application/zip": "zip", "application/x-zip-compressed": "zip",
    "application/x-tar": "tar", "application/gzip": "gz", "application/x-gzip": "gz",
    "application/x-7z-compressed": "7z", "application/vnd.rar": "rar",
    "application/x-rar-compressed": "rar", "application/x-bzip2": "bz2",
    // -- Documents / office --
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/msword": "doc", "application/vnd.ms-excel": "xls",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.presentation": "odp",
    // -- Images --
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp",
    "image/avif": "avif", "image/heic": "heic", "image/heif": "heif",
    "image/tiff": "tiff", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
    // -- Video --
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "video/x-matroska": "mkv", "video/x-msvideo": "avi", "video/mpeg": "mpeg",
    "video/3gpp": "3gp",
    // -- Audio --
    "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav",
    "audio/wave": "wav", "audio/ogg": "ogg", "audio/opus": "opus",
    "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
    "audio/flac": "flac", "audio/x-flac": "flac", "audio/webm": "webm",
    // -- Fonts --
    "font/ttf": "ttf", "font/otf": "otf", "font/woff": "woff", "font/woff2": "woff2",
    // octet-stream is intentionally NOT mapped -> caller's .bin fallback (but the
    // "keep the original extension" rule already handles octet-stream code files).
  };
  return map[m] || "";
}

// A non-empty drag icon is REQUIRED — startDrag throws on an empty image on
// some platforms. Build a tiny 16×16 transparent BGRA bitmap (no asset, no
// decoder needed); fall back to the app icon, then to a 1×1 opaque pixel so we
// can never hand startDrag an empty image.
function dragIcon() {
  try {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4); // BGRA, fully transparent
    const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
    if (img && !img.isEmpty()) return img;
  } catch { }
  try {
    const appImg = loadAppIcon();
    if (appImg && !appImg.isEmpty()) return appImg.resize({ width: 32, height: 32 });
  } catch { }
  try {
    // Last resort: a 1×1 opaque pixel (createEmpty() is empty → throws; avoid it).
    return nativeImage.createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 });
  } catch {
    return nativeImage.createEmpty(); // may throw downstream, but we never get here in practice
  }
}

// Opportunistic cleanup: delete drag temp files older than maxAgeMs (and, on a
// best-effort basis, cap the dir so it can't grow unbounded). Wrapped so a
// missing dir / locked file is a quiet no-op.
function cleanupDragTemp(maxAgeMs = 30 * 60 * 1000) {
  try {
    const fs = require("fs");
    const dir = DRAG_TEMP_DIR();
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      try {
        const st = fs.statSync(fp);
        if (now - st.mtimeMs > maxAgeMs) fs.unlinkSync(fp);
      } catch { }
    }
  } catch { }
}

// Download `url` to `dest` via Electron's net stack (honours system proxy/VPN,
// same as probe()). Sends the bearer token ONLY when given. Enforces a size cap
// + a timeout, and cleans up a partial file on any failure. Resolves true on a
// complete write, false otherwise — never rejects.
function downloadToFile(url, dest, token) {
  return new Promise((resolve) => {
    const fs = require("fs");
    let settled = false;
    let out = null;
    let received = 0;
    let timer = null;
    const fail = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (out) out.destroy(); } catch { }
      try { fs.unlinkSync(dest); } catch { }
      resolve(false);
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    try {
      const req = net.request({ method: "GET", url });
      if (token && typeof token === "string") {
        try { req.setHeader("Authorization", "Bearer " + token); } catch { }
      }
      timer = setTimeout(() => { try { req.abort(); } catch { } fail(); }, DRAG_TIMEOUT_MS);
      req.on("response", (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          try { req.abort(); } catch { }
          return fail();
        }
        const len = Number(res.headers["content-length"] || 0);
        if (len && len > DRAG_MAX_BYTES) { try { req.abort(); } catch { } return fail(); }
        try { out = fs.createWriteStream(dest); } catch { return fail(); }
        out.on("error", fail);
        res.on("data", (chunk) => {
          received += chunk.length;
          if (received > DRAG_MAX_BYTES) { try { req.abort(); } catch { } return fail(); }
          try { out.write(chunk); } catch { fail(); }
        });
        res.on("end", () => { try { out.end(ok); } catch { fail(); } });
        res.on("error", fail);
      });
      req.on("error", fail);
      req.on("abort", fail);
      req.end();
    } catch {
      fail();
    }
  });
}

// fire-and-forget: startDrag MUST run on the SENDER's webContents, so this is an
// ipcMain.on (not a worker/invoke). Guarded with fromMain so only our own window
// can drive a native drag.
ipcMain.on("desktop:start-drag", async (event, payload) => {
  if (!fromMain(event)) return;
  try {
    const url = payload && typeof payload.url === "string" ? payload.url : "";
    if (!url) return; // no usable url (e.g. locked E2EE file) → silently no drag
    // Only same-origin app downloads or blob: URLs are valid sources. A blob:
    // URL lives in the renderer and can't be fetched from main — reject it (the
    // renderer should resolve blobs itself and never reach here with one).
    const isHttp = /^https?:\/\//i.test(url);
    if (!isHttp) return;
    // Pin the download to the configured app origin so a crafted payload can't
    // turn the desktop app into an arbitrary-URL downloader.
    try {
      if (cfg && cfg.origin && new URL(url).origin !== new URL(cfg.origin).origin) return;
    } catch { return; }
    if (dragInFlight) return; // a drag download is already running → ignore
    dragInFlight = true;

    const fs = require("fs");
    const dir = DRAG_TEMP_DIR();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
    cleanupDragTemp(); // opportunistic prune of old drag temp files

    const filename = sanitizeDragName(payload && payload.filename, payload && payload.mime);
    const dest = path.join(dir, filename);
    const token = payload && typeof payload.token === "string" ? payload.token : null;

    const okDl = await downloadToFile(url, dest, token);
    dragInFlight = false;
    if (!okDl) return; // download failed / too big / timed out → no drag
    if (!fromMain(event) || event.sender.isDestroyed()) {
      try { fs.unlinkSync(dest); } catch { }
      return;
    }
    try {
      event.sender.startDrag({ file: dest, icon: dragIcon() });
    } catch (e) {
      log.warn("startDrag failed (skipped):", e && e.message);
    }
  } catch (e) {
    dragInFlight = false;
    log.warn("start-drag handler error (skipped):", e && e.message);
  }
});

// ── IPC: Save a chat attachment to disk (→ Downloads) + reveal/open ─────────
// Desktop download of an attachment: the renderer calls this from an
// attachment's download affordance. Product decision (7 Oct 2026): NO Save-As
// dialog — the file goes straight into the user's Downloads folder, like a
// browser download, under a name that never overwrites an existing file
// ("report (2).pdf"). REUSES the SAME downloadToFile() helper the drag-out
// feature added (no duplicate download path). Origin-pinned to cfg.origin
// exactly like drag-out, and E2EE/locked files are already filtered out
// renderer-side (a missing/blob url is also rejected here). Returns the saved
// absolute path on success, or null (failed).
function uniqueDownloadPath(filename) {
  const fs = require("fs");
  const dir = app.getPath("downloads");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { }
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  let candidate = path.join(dir, filename);
  for (let n = 2; fs.existsSync(candidate) && n < 1000; n++) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}
ipcMain.handle("desktop:save-file", async (event, payload) => {
  // fromColab (not fromMain) so pop-out windows can save attachments too —
  // desktopFiles.maybeNativeSaveAs returns true unconditionally once cd.saveFile
  // exists, suppressing the browser blob fallback, so a fromMain gate here left
  // downloads in a pop-out silently dead. Origin + scheme are still pinned below.
  if (!fromColab(event)) return null;
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (!senderWin || senderWin.isDestroyed()) return null;
  try {
    const url = payload && typeof payload.url === "string" ? payload.url : "";
    if (!url) return null; // no usable url (e.g. locked E2EE file) → no save
    if (!/^https?:\/\//i.test(url)) return null; // blob:/file:/etc → reject
    // Pin the download to the configured app origin (same guard as drag-out) so a
    // crafted payload can't turn the app into an arbitrary-URL downloader.
    try {
      if (cfg && cfg.origin && new URL(url).origin !== new URL(cfg.origin).origin) return null;
    } catch { return null; }

    const filename = sanitizeDragName(payload && payload.filename, payload && payload.mime);
    const dest = uniqueDownloadPath(filename);

    const token = payload && typeof payload.token === "string" ? payload.token : null;
    const okDl = await downloadToFile(url, dest, token); // SAME helper as drag-out
    if (!okDl) return null; // download failed / too big / timed out
    return dest;
  } catch (e) {
    log.warn("save-file failed (skipped):", e && e.message);
    return null;
  }
});

// Reveal a previously-saved file in the OS file manager (Explorer/Finder),
// selected. Path-guarded: only a non-empty string is accepted; shell handles the
// rest. Quiet no-op on anything invalid.
ipcMain.handle("desktop:reveal-in-folder", async (event, filePath) => {
  // fromColab: these are the follow-up steps of the pop-out save-file flow, so a
  // pop-out that just downloaded a file must be able to reveal/open it too.
  if (!fromColab(event) || typeof filePath !== "string" || !filePath) return false;
  try { shell.showItemInFolder(filePath); return true; }
  catch (e) { log.warn("reveal-in-folder failed (skipped):", e && e.message); return false; }
});

// Open a previously-saved file with its default OS application. shell.openPath
// returns an empty string on success or an error message; we map that to a bool.
ipcMain.handle("desktop:open-path", async (event, filePath) => {
  // fromColab: pop-outs may open a file they just downloaded (see save-file).
  if (!fromColab(event) || typeof filePath !== "string" || !filePath) return false;
  try {
    const err = await shell.openPath(filePath);
    return !err; // "" → success
  } catch (e) {
    log.warn("open-path failed (skipped):", e && e.message);
    return false;
  }
});

// ── IPC: Recovery screen actions ────────────────────────────────────────────
ipcMain.on("desktop:recovery-action", (event, action) => {
  if (!fromMain(event)) return;
  log.info("Recovery action:", action);
  if (action === "reload") {
    rendererFailures = 0;
    connectToApp();
  } else if (action === "restart") {
    app.relaunch();
    app.exit(0);
  } else if (action === "exit") {
    app.quit();
  }
});

// ── IPC: Native Picture-in-Picture ──────────────────────────────────────────
// The shared web app already renders a compact in-call "PiP" view; on desktop we
// promote the WHOLE window to a small always-on-top frame so the call stays
// visible over Chrome/Explorer/VS Code/Outlook without returning to Collab. The
// renderer toggles this when it enters/leaves its own PiP mode (gated on
// window.collabDesktop, so the browser is unaffected). Off → restore prior size.
ipcMain.on("desktop:set-pip", (event, on) => {
  if (!fromMain(event) || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (on) {
      if (!preMiniBounds) preMiniBounds = mainWindow.getBounds();
      const wa = screen.getPrimaryDisplay().workArea;
      const w = 360, h = 230, margin = 16;
      mainWindow.setMinimumSize(280, 170);
      mainWindow.setAlwaysOnTop(true, "screen-saver");
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindow.setBounds({ x: wa.x + wa.width - w - margin, y: wa.y + wa.height - h - margin, width: w, height: h });
      mainWindow.webContents.send("desktop:pip-changed", true);
    } else {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setVisibleOnAllWorkspaces(false);
      mainWindow.setMinimumSize(900, 600);
      if (preMiniBounds) { mainWindow.setBounds(preMiniBounds); preMiniBounds = null; }
      mainWindow.webContents.send("desktop:pip-changed", false);
    }
  } catch (e) {
    log.error("set-pip failed:", e && e.message);
  }
});

// ── IPC: Call active (power-save blocker) ───────────────────────────────────
// The renderer flips this true on call/meeting CONNECT and false on DISCONNECT
// (the existing call-lifecycle, no media changes). While true we keep the display
// awake. Thin + guarded — start/stop are idempotent.
ipcMain.on("desktop:set-call-active", (event, on) => {
  if (!fromMain(event)) return;
  if (on === true) startCallPowerBlocker();
  else stopCallPowerBlocker();
});

// ── IPC: Content protection (capture protection / DLP) ──────────────────────
// Renderer (a future per-confidential-channel auto-toggle) or the Settings toggle
// can blank the window in screenshots / screen-share. The pref drives startup +
// the explicit toggle; this channel lets the renderer drive it transiently too.
ipcMain.on("desktop:set-content-protection", (event, on) => {
  if (!fromMain(event)) return;
  applyContentProtection(on === true);
});

// ── IPC: Incoming call (ring + answer when closed) ──────────────────────────
// On an incoming call/meeting invite the renderer calls this so the main process
// grabs the user's attention even when the window is hidden to the tray: flash the
// taskbar button (NOT a forced focus-steal) and surface a notification carrying
// Answer / Decline action buttons. A clicked button routes back to the renderer
// via desktop:notification-action ("answer" | "decline"), which CoLabV1 maps to
// its EXISTING answer/decline handlers. The in-app ring is unchanged/additive.
ipcMain.handle("desktop:incoming-call", async (event, opts) => {
  if (!fromMain(event) || !opts || typeof opts !== "object") return null;
  const id = typeof opts.id === "string" ? opts.id : "";
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.flashFrame(true); // taskbar attention; clears on focus or callCleared
      callFlashing = true;
    } catch (e) { log.warn("flashFrame failed (skipped):", e && e.message); }
  }
  try {
    return createDesktopNotification(
      {
        title: typeof opts.title === "string" ? opts.title : "Incoming call",
        body: typeof opts.body === "string" ? opts.body : "",
        tag: id ? "call-" + id : undefined,
        requireInteraction: true,
        silent: true, // the renderer plays the ringtone; avoid a double sound
        data: { kind: "incoming-call", id },
        actions: [
          { text: "Answer", action: "answer" },
          { text: "Decline", action: "decline" },
        ],
      },
      mainWindow,
    );
  } catch (e) {
    log.error("incoming-call notification failed:", e && e.message);
    return null;
  }
});

// ── IPC: Call ring cleared (answered / declined / missed) ───────────────────
// Stops the taskbar flash once the ring is resolved by ANY path (answered,
// declined, or it timed out). Safe to call when not flashing.
ipcMain.on("desktop:call-cleared", (event) => {
  if (!fromMain(event)) return;
  if (callFlashing && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.flashFrame(false); } catch { }
  }
  callFlashing = false;
});

// ── IPC: Desktop preferences (close-to-tray + auto-launch) ──────────────────
// The Settings UI reads both prefs on mount and writes them on toggle. Persisted
// in prefsStore; openAtLogin additionally drives the OS login-item.
ipcMain.handle("desktop:get-prefs", async (event) => {
  if (!fromMain(event)) return { closeToTray: true, openAtLogin: false };
  return getDesktopPrefs();
});

ipcMain.handle("desktop:set-pref", async (event, key, value) => {
  if (!fromMain(event)) return getDesktopPrefs();
  if (key === "closeToTray") {
    prefsStore.set("closeToTray", value === true);
  } else if (key === "openAtLogin") {
    const on = value === true;
    prefsStore.set("openAtLogin", on);
    applyLoginItem(on); // reflect to the OS immediately
  } else if (key === "globalShortcuts") {
    const on = value === true;
    prefsStore.set("globalShortcuts", on);
    // Apply immediately: toggling OFF unregisters the OS hotkeys, ON re-registers.
    if (on) registerGlobalShortcuts();
    else unregisterGlobalShortcuts();
  } else if (key === "protectContent") {
    const on = value === true;
    prefsStore.set("protectContent", on);
    applyContentProtection(on); // reflect to the window immediately
  } else if (key === "autoUpdate") {
    // The scheduler re-reads this pref on every tick. Turning it ON also checks
    // right away so the user doesn't wait up to 4h for the first background check.
    // A manual "Check for updates" always runs regardless of this toggle.
    prefsStore.set("autoUpdate", value === true);
    if (value === true && cfg && !isQuitting) {
      checkForUpdates(cfg, mainWindow, { auto: true, source: "auto" }).catch(() => { });
    }
  }
  return getDesktopPrefs();
});

// ── IPC: Deep link ready ────────────────────────────────────────────────────
// The renderer calls this once it has subscribed to onDeepLink (after mount);
// we mark it ready and flush any links that arrived during a cold launch.
ipcMain.on("desktop:deep-link-ready", (event) => {
  if (!fromMain(event)) return;
  rendererDeepLinkReady = true;
  flushDeepLinks();
});

// ── IPC: Taskbar / dock badge count (total unread) ──────────────────────────
ipcMain.on("desktop:set-badge", (event, n) => {
  if (!fromMain(event)) return;
  applyBadgeCount(typeof n === "number" ? n : 0);
});

// ── IPC: Taskbar / dock PROGRESS bar (file upload) ──────────────────────────
// The renderer drives the OS taskbar (Windows) / dock (macOS) progress arc from
// the EXISTING attachment-upload progress (a fraction 0..1), and clears it with
// -1 on completion/error/abort. setProgressBar(-1) removes the indicator; a value
// in (0..1] shows it. We clamp + treat <0 or >1 as "clear" so the bar can never
// get stuck. Pure OS hint — touches nothing in the upload pipeline.
ipcMain.on("desktop:set-progress", (event, fraction) => {
  if (!fromMain(event) || !mainWindow || mainWindow.isDestroyed()) return;
  const f = typeof fraction === "number" && isFinite(fraction) ? fraction : -1;
  try {
    // Out-of-range (negative, >1, or NaN→-1) clears the indicator entirely.
    if (f < 0 || f > 1) mainWindow.setProgressBar(-1);
    else mainWindow.setProgressBar(f);
  } catch (e) {
    log.warn("setProgressBar failed (skipped):", e && e.message);
  }
});

// ── IPC: Recent conversations → jump list / dock menu ───────────────────────
// The renderer pushes the top-N (by recency) conversations as [{id,name}] when
// its conversation list changes; we sanitise to id+name strings, cap at 5, and
// rebuild the OS quick-action menu (Windows jump list / macOS dock menu).
ipcMain.on("desktop:set-recent-conversations", (event, list) => {
  if (!fromMain(event)) return;
  const arr = Array.isArray(list) ? list : [];
  recentConversations = arr
    .filter((c) => c && typeof c.id === "string" && c.id)
    .slice(0, 5)
    .map((c) => ({
      id: c.id,
      name: typeof c.name === "string" ? c.name : "",
    }));
  buildJumpList();
});

// ── IPC: About info (Settings → About section) ─────────────────────────────
ipcMain.handle("desktop:about-info", async (event) => {
  if (!fromMain(event)) return null;
  return {
    appName: appInfo.appName,
    company: appInfo.company,
    version: appInfo.version,
    build: appInfo.build,
    channel: appInfo.channel,
    env: cfg ? cfg.env : "unknown",
    electronVersion: appInfo.electronVersion,
    chromiumVersion: appInfo.chromiumVersion,
    nodeVersion: appInfo.nodeVersion,
    updateUrl: cfg ? cfg.updateUrl : "",
    supportUrl: appInfo.supportUrl,
    websiteUrl: appInfo.websiteUrl,
  };
});

// ── IPC: Secure token storage (OS keychain via safeStorage) — #66 ───────────
// ADDITIVE, desktop-only. The shared web app stores its auth token in
// localStorage; on desktop the renderer's token shim PREFERS this secure store so
// the token is encrypted at rest by the OS keychain (DPAPI on Windows, Keychain on
// macOS, libsecret on Linux) instead of sitting in plaintext localStorage. The
// renderer falls back to localStorage when this is unavailable, so a missing
// keychain NEVER breaks login. We persist the safeStorage-encrypted bytes in a
// dedicated electron-store (separate from prefs/window-state) as base64.
const secureStore = new Store({ name: "secure-auth" });
// AUDIT #16: keyed multi-secret store so the 30-day REFRESH token gets its own
// OS-encrypted slot (previously it lived in plaintext localStorage). Allowlisted so
// the renderer can't create arbitrary keys; a missing/invalid key defaults to the
// legacy "authToken" so an un-bumped renderer keeps working byte-for-byte.
const SECURE_KEY = "authToken";
const SECURE_KEYS = new Set(["authToken", "refreshToken"]);
const secureKeyOf = (k) =>
  typeof k === "string" && SECURE_KEYS.has(k) ? k : SECURE_KEY;

// Whether OS-level encryption is actually available on this host. macOS/Windows are
// effectively always available; Linux needs a libsecret backend (may be absent on a
// headless box) — when false the renderer transparently falls back to localStorage.
function secureAvailable() {
  try {
    return !!safeStorage && safeStorage.isEncryptionAvailable();
  } catch (_) {
    return false;
  }
}

// get → { available, value } where value is the decrypted token or null. Never
// throws to the renderer; on any failure returns { available:false } so the shim
// falls back. Reads are PK-cheap (one file).
ipcMain.handle("desktop:secure-get", async (event, key) => {
  if (!fromMain(event)) return { available: false, value: null };
  if (!secureAvailable()) return { available: false, value: null };
  try {
    const b64 = secureStore.get(secureKeyOf(key), null);
    if (!b64 || typeof b64 !== "string") return { available: true, value: null };
    const plain = safeStorage.decryptString(Buffer.from(b64, "base64"));
    return { available: true, value: plain || null };
  } catch (e) {
    log.error("secure-get failed:", e && e.message);
    return { available: false, value: null };
  }
});

// set(key, value) → { available, ok }. Encrypts with the OS key and persists base64.
// (Old renderer calls set(value) with no key → secureKeyOf(value) falls back to the
// "authToken" default, preserving the legacy single-secret behaviour.)
ipcMain.handle("desktop:secure-set", async (event, key, value) => {
  if (!fromMain(event)) return { available: false, ok: false };
  if (!secureAvailable()) return { available: false, ok: false };
  try {
    const K = secureKeyOf(key);
    if (typeof value !== "string" || !value) {
      secureStore.delete(K);
      return { available: true, ok: true };
    }
    const enc = safeStorage.encryptString(value);
    secureStore.set(K, enc.toString("base64"));
    return { available: true, ok: true };
  } catch (e) {
    log.error("secure-set failed:", e && e.message);
    return { available: false, ok: false };
  }
});

// clear(key) → { available, ok }. A specific key clears that slot; no key clears ALL
// slots (logout must purge both the access + refresh tokens).
ipcMain.handle("desktop:secure-clear", async (event, key) => {
  if (!fromMain(event)) return { available: false, ok: false };
  try {
    if (typeof key === "string" && SECURE_KEYS.has(key)) {
      secureStore.delete(key);
    } else {
      for (const k of SECURE_KEYS) secureStore.delete(k);
    }
    return { available: secureAvailable(), ok: true };
  } catch (e) {
    log.error("secure-clear failed:", e && e.message);
    return { available: false, ok: false };
  }
});

// ── IPC: Check for updates (from an in-app button) ──────────────────────────
// source "app" → the updater drives the in-app premium UI via update:event.
// A manual check always runs, ignoring the autoUpdate pref.
ipcMain.on("desktop:check-updates", (event) => {
  if (!fromMain(event) || !cfg) return;
  checkForUpdates(cfg, mainWindow, { manual: true, source: "app" });
});

// ── IPC: Download the pending update (auto-update OFF → explicit "Download") ──
ipcMain.on("desktop:update-download", (event) => {
  if (!fromMain(event)) return;
  startDownload(mainWindow);
});

// ── IPC: Restart & install the downloaded update ("Restart to update") ───────
ipcMain.on("desktop:update-install", (event) => {
  if (!fromMain(event)) return;
  installUpdate(mainWindow);
});

// ── IPC: Current update state (replay for a late-mounting renderer) ───────────
// The update banner mounts inside the post-login shell; if the silent startup
// check already fired (e.g. the user was on the login screen), this lets the
// banner recover the current available/downloading/downloaded state on mount.
ipcMain.handle("desktop:update-state", (event) => {
  if (!fromMain(event)) return null;
  try { return currentState(); } catch { return null; }
});

// ── IPC: Reload-latest (hard-reload the origin to fetch the deployed web app) ─
ipcMain.on("desktop:reload-latest", async (event) => {
  if (!fromMain(event) || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    rendererFailures = 0;
    stopReconnectLoop();
    await session.defaultSession.clearCache();
    connectToApp();
  } catch (e) {
    log.error("reload-latest failed:", e && e.message);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
  }
});

// ── IPC: Reconnect-now (from the reconnect screen) ──────────────────────────
ipcMain.on("desktop:reconnect-now", async (event) => {
  if (!fromMain(event)) return;
  stopReconnectLoop();
  pushReconnectStatus("Checking connection…");
  const ok = await probe(cfg.webUrl);
  if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
  if (ok) connectToApp();
  else startReconnectLoop();
});

// ── App lifecycle ───────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  app.setName(appInfo.appName);
  log.init();

  // Automatic storage cleanup on version update or explicit --clear-storage flag
  try {
    const currentAppVersion = app.getVersion();
    const lastRunVersion = prefsStore.get("lastRunVersion");
    const forceClear = process.argv.includes("--clear-storage") || process.argv.includes("--clean-install");

    if (forceClear || (lastRunVersion && lastRunVersion !== currentAppVersion)) {
      log.info(`[Storage Migration] App version changed (${lastRunVersion || "none"} -> ${currentAppVersion}). Clearing cached storage data...`);
      await session.defaultSession.clearStorageData({
        storages: ["appcache", "cookies", "filesystem", "indexdb", "localstorage", "shadercache", "websql", "serviceworkers", "cachestorage"]
      }).catch((e) => log.error("clearStorageData error:", e));
      await session.defaultSession.clearCache().catch(() => { });
    }
    prefsStore.set("lastRunVersion", currentAppVersion);
  } catch (err) {
    log.error("Failed to execute storage cleanup on launch:", err);
  }

  if (isDev) {
    // Confirms the dev instance is isolated from the installed app's data dir
    // (see the app.setPath('userData', …) note near the top of this file).
    log.info(`Dev userData: ${app.getPath("userData")}`);
  }

  if (process.platform === "win32") {
    app.setAppUserModelId("com.resulticks.collab.desktop");
  }

  cfg = resolveConfig({ isDev });
  log.info(`Environment: ${cfg.env} — loading ${cfg.webUrl} (config: ${cfg.source})`);

  // Screen sharing + camera/mic permissions (Electron-specific).
  setupDesktopMedia();

  // Native spellchecker language (best-effort; Chromium's checker is on by default).
  setupSpellchecker();

  try {
    powerMonitor.on("suspend", () => {
      log.info("System suspend");
      // Going to sleep counts as "away" — flip immediately (don't wait for the
      // next idle poll, which won't run while suspended anyway).
      screenLocked = true;
      sendAutoPresence("away");
    });
    powerMonitor.on("resume", () => {
      log.info("System resume");
      // Back from sleep: clear the lock flag and let the next poll (or activity)
      // restore presence. After sleep the socket/LiveKit may be dead; the web
      // client reconnects itself. If we're parked on the reconnect screen, nudge.
      screenLocked = false;
      pollIdle(); // re-evaluate now (likely "active" once the user is back)
      if (reconnectTimer) { stopReconnectLoop(); startReconnectLoop(); }
    });
    powerMonitor.on("lock-screen", () => {
      log.info("Screen locked");
      screenLocked = true;
      sendAutoPresence("away"); // locked → away, regardless of the idle counter
    });
    powerMonitor.on("unlock-screen", () => {
      log.info("Screen unlocked");
      screenLocked = false;
      pollIdle(); // unlock = activity → typically restores "active"
    });
  } catch { }

  buildAppMenu();
  await createWindow();

  // Cold-launch deep link (Windows/Linux): a colab:// token may be sitting in
  // this process's own argv. Queue it now — handleDeepLink flushes once the
  // renderer signals ready (or on the first clean did-finish-load).
  const launchUrl = extractDeepLink(process.argv);
  if (launchUrl) handleDeepLink(launchUrl);

  // Background presence: tray is built AFTER the window exists (its menu/clicks
  // act on mainWindow). Keep the OS login-item in sync with the stored pref each
  // launch (covers a manual OS-level change or a reinstall).
  createTray();
  applyLoginItem(getDesktopPrefs().openAtLogin);

  // Jump list (Windows) / dock menu (macOS): seed the "New message" quick action
  // immediately (recent chats fill in once the renderer pushes its list). Safe
  // pre-login — "New message" just opens the composer when the user is authed.
  buildJumpList();

  // Global shortcuts: registered AFTER the window exists (handlers act on
  // mainWindow / send IPC to its renderer). Gated behind the globalShortcuts
  // pref (default ON); each register is guarded so a taken hotkey is skipped.
  registerGlobalShortcuts();

  // Capture protection (DLP): apply the stored pref to the window on startup so a
  // user who enabled "hide from screen capture" stays protected across restarts.
  applyContentProtection(getDesktopPrefs().protectContent);

  // Idle → auto-Away: start polling the OS idle counter (and we already listen to
  // lock/suspend above). The renderer ignores presence-auto unless on desktop +
  // the user is at the default-online state, so this is safe even pre-login.
  startIdleMonitor();

  // Silent auto-update checks: ~8s after launch, then every 4h and after the machine
  // wakes from sleep (see startAutoUpdateScheduler). The app lives in the tray for
  // days, so a single startup check missed every release published after launch.
  // Gated by the autoUpdate pref (ON by default), re-read on every tick: when ON, a
  // newer version is downloaded in the background and the in-app "Restart to
  // update" prompt appears. When OFF nothing runs — the user updates on demand via
  // the in-app button / native menu. source "auto" → in-app update:event UI.
  startAutoUpdateScheduler(
    () => ({
      cfg,
      win: mainWindow,
      enabled: getDesktopPrefs().autoUpdate,
      quitting: isQuitting,
    }),
    { initialDelayMs: appInfo.updateCheckDelayMs },
  );
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  // macOS dock click: recreate the window if gone, else re-show it if hidden to
  // the tray (close-to-tray). Mirrors showMainWindow without forcing focus loops.
  if (mainWindow === null) await createWindow();
  else showMainWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  log.info("before-quit — cleaning up");
  stopReconnectLoop();
  clearAllNotifications();
  destroyTray();
  stopCallPowerBlocker(); // release the display-sleep blocker if a call was active
  stopIdleMonitor();
  cleanupDragTemp(0); // remove all temp drag-out files on exit (best-effort)
});

// Release all OS-wide hotkeys right before exit (Electron's recommended place —
// fires after windows close). Without this, a hard kill could leave the
// accelerators registered until the OS reclaims them.
app.on("will-quit", () => {
  unregisterGlobalShortcuts();
});

process.on("uncaughtException", (e) => log.error("uncaughtException:", e));
process.on("unhandledRejection", (e) => log.error("unhandledRejection:", e));
