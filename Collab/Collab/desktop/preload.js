const { contextBridge, ipcRenderer } = require("electron");

// Read static values once at preload time (not inside getters) so they're safe
// regardless of sandbox mode changes in the future.
const PLATFORM = process.platform;
// Read the DESKTOP app's own package.json (./), not the repo-root one (../) —
// the root is colab@1.0.0 while the shipped app is @collab/desktop@1.x.x. Using
// the root made appInfo.version stale (1.0.0), so the in-app "update available"
// badge mis-fired against latest.json while the native updater (app.getVersion)
// correctly reported up-to-date.
const VERSION = (() => {
  try { return require("./package.json").version; } catch { return "1.0.0"; }
})();
// Optional CI build number, surfaced to the shared web app's analytics
// (getClientEnv → post-call feedback #67). package.json may carry a top-level
// "buildNumber" (set by the release pipeline); when absent we fall back to the
// electron-builder buildVersion, then to the plain version, so the exposed field
// is always a real value rather than the always-null it used to be.
const BUILD_NUMBER = (() => {
  try {
    const pkg = require("./package.json");
    return String(
      pkg.buildNumber || (pkg.build && pkg.build.buildVersion) || pkg.version || "",
    ) || undefined;
  } catch {
    return undefined;
  }
})();

contextBridge.exposeInMainWorld("collabDesktop", {
  // ── Platform ───────────────────────────────────────────────────────────────
  // The raw Node platform string ('win32' | 'darwin' | 'linux' | …), read once at
  // preload time. The renderer uses this to show OS-correct keyboard shortcuts
  // (⌘ vs Ctrl, jump-list vs dock-menu notes) in the Help Center. On the web this
  // bridge is absent, so the renderer falls back to navigator-based detection.
  platform: PLATFORM,

  // ── Notifications ──────────────────────────────────────────────────────────
  showNotification(opts) {
    if (!opts || typeof opts.title !== "string") return Promise.reject(new Error("invalid opts"));
    return ipcRenderer.invoke("desktop:show-notification", opts);
  },

  onNotificationAction(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, action, data) => {
      try { callback(action, data); } catch {}
    };
    ipcRenderer.on("desktop:notification-action", handler);
    return () => ipcRenderer.removeListener("desktop:notification-action", handler);
  },

  // ── File Dialogs ───────────────────────────────────────────────────────────
  showOpenDialog(opts) {
    return ipcRenderer.invoke("desktop:show-open-dialog", opts || {});
  },

  // ── Clipboard ──────────────────────────────────────────────────────────────
  clipboardWrite(text) {
    if (typeof text !== "string") return Promise.resolve(false);
    return ipcRenderer.invoke("desktop:clipboard-write", text);
  },

  clipboardRead() {
    return ipcRenderer.invoke("desktop:clipboard-read");
  },

  // ── Login credential autofill ────────────────────────────────────────────────
  // Browser-like "remember me": the main process persists the sign-in credentials
  // encrypted with the OS keychain (safeStorage) so the login screen can prefill
  // them. No-op in the browser (window.collabDesktop is undefined there).
  getCredential() {
    return ipcRenderer.invoke("desktop:cred-get");
  },
  saveCredential(email, password) {
    if (typeof email !== "string" || !email) return Promise.resolve(false);
    return ipcRenderer.invoke("desktop:cred-save", { email, password: String(password || "") });
  },
  clearCredential() {
    return ipcRenderer.invoke("desktop:cred-clear");
  },

  // ── External links ─────────────────────────────────────────────────────────
  // Opens http/https URLs in the user's default system browser.
  // Main process validates the scheme before calling shell.openExternal.
  openExternal(url) {
    if (typeof url !== "string") return Promise.resolve(false);
    return ipcRenderer.invoke("desktop:open-external", url);
  },

  // ── Window Controls ────────────────────────────────────────────────────────
  // Used by <DesktopChrome> to drive the in-app min/max/close pills on the RIGHT
  // of the custom title bar (the native chrome is hidden via frame:false +
  // titleBarStyle:"hidden").
  window: {
    minimize() {
      ipcRenderer.send("desktop:window-control", "minimize");
    },
    maximize() {
      ipcRenderer.send("desktop:window-control", "maximize");
    },
    unmaximize() {
      ipcRenderer.send("desktop:window-control", "unmaximize");
    },
    toggleMaximize() {
      ipcRenderer.send("desktop:window-control", "toggle-maximize");
    },
    close() {
      ipcRenderer.send("desktop:window-control", "close");
    },
    getState() {
      return ipcRenderer.invoke("desktop:window-state");
    },
    onMaximizeChanged(callback) {
      if (typeof callback !== "function") return () => {};
      const handler = (_event, isMax) => { try { callback(!!isMax); } catch {} };
      ipcRenderer.on("desktop:maximize-changed", handler);
      return () => ipcRenderer.removeListener("desktop:maximize-changed", handler);
    },
  },

  // ── Native pop-out windows (Tier 5) ──────────────────────────────────────
  // Open a chat in a real in-app BrowserWindow instead of the browser's
  // window.open. opts: { conversation?: string, path?: string }. The main
  // process builds a SAME-ORIGIN URL using the existing `?conversation=<id>`
  // contract, shares the default session (so it's already authenticated), and
  // de-dupes (focuses an existing pop-out for the same conversation). Resolves
  // { ok, focused? } / { ok:false, error }. No-op in the browser (collabDesktop
  // is undefined → the renderer falls back to window.open).
  openPopout(opts) {
    return ipcRenderer.invoke("desktop:open-popout", opts && typeof opts === "object" ? opts : {});
  },

  // ── Recovery screen actions ──────────────────────────────────────────────
  // Used ONLY by the built-in recovery.html fallback (reload / restart / exit).
  // The main React app never calls this.
  recovery(action) {
    if (typeof action !== "string") return;
    ipcRenderer.send("desktop:recovery-action", action);
  },

  // ── Smoother calls: power-save blocker ───────────────────────────────────
  // The renderer flips this true on call/meeting CONNECT and false on DISCONNECT
  // (wired into the EXISTING call lifecycle — no media changes). While true the
  // main process prevents the display from sleeping. No-op in the browser.
  setCallActive(on) {
    ipcRenderer.send("desktop:set-call-active", !!on);
  },

  // ── Capture protection (DLP) ─────────────────────────────────────────────
  // Blank the window in OS screenshots / screen-share / recorders. Driven by the
  // Settings "hide from screen capture" toggle (a desktop pref) and, in future, a
  // per-confidential-channel auto-toggle that calls this same bridge transiently.
  setContentProtection(on) {
    ipcRenderer.send("desktop:set-content-protection", !!on);
  },

  // ── Incoming call (ring + answer when closed) ────────────────────────────
  // On an incoming call/meeting invite the renderer calls this; the main process
  // flashes the taskbar (NOT a focus-steal) and shows a notification with
  // Answer / Decline action buttons. A clicked button comes back via
  // onNotificationAction(action, data) with action "answer" | "decline".
  // Resolves the notification id (or null). No-op in the browser.
  incomingCall(opts) {
    if (!opts || typeof opts !== "object") return Promise.resolve(null);
    return ipcRenderer.invoke("desktop:incoming-call", opts);
  },
  // Stop the taskbar flash once the ring is resolved (answered/declined/missed).
  callCleared() {
    ipcRenderer.send("desktop:call-cleared");
  },

  // ── Idle → auto-Away ─────────────────────────────────────────────────────
  // The main process watches the OS idle counter + screen lock/suspend and sends
  // { state:"away" } after the idle threshold (or on lock) and { state:"active" }
  // on the next activity/unlock/resume. The renderer flips presence to Away ONLY
  // if the user is at the default-online state (never overriding a manual choice).
  onPresenceAuto(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = (_e, payload) => { try { callback(payload); } catch {} };
    ipcRenderer.on("presence-auto", handler);
    return () => ipcRenderer.removeListener("presence-auto", handler);
  },

  // ── Native Picture-in-Picture ────────────────────────────────────────────
  // The shared web app calls this when it enters/leaves its in-call PiP view;
  // Electron promotes the window to a compact always-on-top frame over other apps.
  setPictureInPicture(on) {
    ipcRenderer.send("desktop:set-pip", !!on);
  },
  onPictureInPictureChanged(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = (_e, on) => { try { callback(!!on); } catch {} };
    ipcRenderer.on("desktop:pip-changed", handler);
    return () => ipcRenderer.removeListener("desktop:pip-changed", handler);
  },

  // ── Deep linking (colab://) ──────────────────────────────────────────────
  // The main process forwards a normalised "kind/rest" path (the scheme +
  // host stripped) whenever a colab:// link is opened from the OS / a
  // notification / a browser. The renderer parses it (lib/deepLink.ts) and
  // routes to in-app navigation. Call deepLinkReady() once subscribed so any
  // link captured during a cold launch is flushed.
  onDeepLink(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, url) => { try { callback(url); } catch {} };
    ipcRenderer.on("deep-link", handler);
    return () => ipcRenderer.removeListener("deep-link", handler);
  },
  deepLinkReady() {
    ipcRenderer.send("desktop:deep-link-ready");
  },

  // ── Global shortcuts (OS-wide hotkeys) ───────────────────────────────────
  // The main process sends { action } for renderer-facing hotkeys (toggle-mute,
  // toggle-pip). Show/Hide is handled entirely in the main process and never
  // reaches here. The renderer acts only when a call/meeting is active.
  onGlobalShortcut(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => { try { callback(payload); } catch {} };
    ipcRenderer.on("global-shortcut", handler);
    return () => ipcRenderer.removeListener("global-shortcut", handler);
  },

  // ── Updates ──────────────────────────────────────────────────────────────
  // Trigger a manual "Check for Updates" (same as the Help-menu item). The web
  // app can wire this to an in-app button when running on desktop. source "app"
  // → the updater drives the in-app premium progress UI via onUpdateEvent below.
  checkForUpdates() {
    ipcRenderer.send("desktop:check-updates");
  },
  // Start downloading the pending update (used by the in-app banner's "Download"
  // when auto-update is OFF; auto-update ON downloads on its own).
  downloadUpdate() {
    ipcRenderer.send("desktop:update-download");
  },
  // "Restart to update" — install the downloaded installer and relaunch.
  installUpdate() {
    ipcRenderer.send("desktop:update-install");
  },
  // Current update state for a late-mounting banner (returns the last actionable
  // event: available/downloading/downloaded/installing/error, or null).
  getUpdateState() {
    return ipcRenderer.invoke("desktop:update-state");
  },
  // Subscribe to the update lifecycle for the in-app progress UI. The main
  // process sends { type, version?, notes?, percent?, transferred?, total?, ... }
  // where type ∈ checking | available | downloading | downloaded | uptodate |
  // installing | error. Returns an unsubscribe fn. No-op in the browser.
  onUpdateEvent(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => { try { callback(payload); } catch {} };
    ipcRenderer.on("update:event", handler);
    return () => ipcRenderer.removeListener("update:event", handler);
  },
  // Hard-reload the hosted origin to pull the freshly deployed web app.
  reloadLatest() {
    ipcRenderer.send("desktop:reload-latest");
  },
  update() {
    ipcRenderer.send("desktop:reload-latest");
  },

  // ── Remote Control (controlled side) — OS input injection ────────────────
  // The shared web app forwards validated input events here while a granted
  // remote-control session is active; the main process injects them via the
  // native module. remoteArm gates injection on session grant/revoke.
  remoteInput(ev) {
    if (ev && typeof ev === "object") ipcRenderer.send("rc:inject", ev);
  },
  remoteArm(on) {
    ipcRenderer.send("rc:arm", !!on);
  },
  remoteAvailable() {
    return ipcRenderer.invoke("rc:available");
  },

  // ── Reconnect screen (backend unreachable) ───────────────────────────────
  // Used ONLY by the built-in reconnect.html fallback.
  reconnectNow() {
    ipcRenderer.send("desktop:reconnect-now");
  },
  onReconnectStatus(callback) {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, msg) => { try { callback(msg); } catch {} };
    ipcRenderer.on("desktop:reconnect-status", handler);
    return () => ipcRenderer.removeListener("desktop:reconnect-status", handler);
  },

  // ── Desktop preferences (background presence) ────────────────────────────
  // The Settings UI reads both prefs on mount and writes on toggle.
  //   getDesktopPrefs() -> Promise<{ closeToTray:boolean, openAtLogin:boolean }>
  //   setDesktopPref(key, value) -> Promise<the updated prefs>
  // closeToTray drives the X→hide behaviour; openAtLogin drives the OS auto-launch.
  getDesktopPrefs() {
    return ipcRenderer.invoke("desktop:get-prefs");
  },
  setDesktopPref(key, value) {
    if (typeof key !== "string") return Promise.resolve(null);
    return ipcRenderer.invoke("desktop:set-pref", key, !!value);
  },

  // ── Taskbar / dock badge count ───────────────────────────────────────────
  // The web app calls this with the total unread count; the main process maps it
  // to the per-OS badge (macOS/Linux numeric dock badge, Windows taskbar overlay).
  // No-op in the browser (collabDesktop is undefined there).
  setBadgeCount(n) {
    const count = typeof n === "number" && isFinite(n) ? n : 0;
    ipcRenderer.send("desktop:set-badge", count);
  },

  // ── Taskbar / dock progress bar (file upload) ────────────────────────────
  // The web app calls this with a fraction 0..1 during an attachment upload to
  // show the OS taskbar (Windows) / dock (macOS) progress arc, and -1 to clear
  // it on complete/error/abort. Anything out of [0,1] clears the indicator. No-op
  // in the browser (collabDesktop is undefined there).
  setProgress(fraction) {
    const f = typeof fraction === "number" && isFinite(fraction) ? fraction : -1;
    ipcRenderer.send("desktop:set-progress", f);
  },

  // ── Recent conversations → jump list / dock menu ─────────────────────────
  // The web app calls this with the top-N (by recency) conversations as
  // [{id,name}] whenever its conversation list changes; the main process rebuilds
  // the OS quick-action menu (Windows jump list / macOS dock menu) so "New
  // message" + recent chats work even when the window is closed to the tray. Only
  // id+name strings are forwarded. No-op in the browser.
  setRecentConversations(list) {
    const safe = Array.isArray(list)
      ? list
          .filter((c) => c && typeof c.id === "string" && c.id)
          .slice(0, 5)
          .map((c) => ({ id: c.id, name: typeof c.name === "string" ? c.name : "" }))
      : [];
    ipcRenderer.send("desktop:set-recent-conversations", safe);
  },

  // ── Drag a chat attachment OUT to the OS desktop ─────────────────────────
  // The renderer calls this from an attachment's HTML5 onDragStart (after
  // preventDefault) to start a NATIVE OS drag: the main process downloads the
  // file to a temp path and hands it to event.sender.startDrag, so the user can
  // drop it on the desktop / a folder / another app and get a real file copy.
  // Fire-and-forget (startDrag must run on the sender's webContents → ipcRenderer
  // .send, not invoke). opts: { url, filename?, mime?, token? }. No-op in the
  // browser (collabDesktop is undefined there). A locked/E2EE file with no plain
  // url should simply not call this — main also rejects a missing/blob url.
  startDrag(opts) {
    if (!opts || typeof opts !== "object") return;
    if (typeof opts.url !== "string" || !opts.url) return;
    ipcRenderer.send("desktop:start-drag", {
      url: opts.url,
      filename: typeof opts.filename === "string" ? opts.filename : "",
      mime: typeof opts.mime === "string" ? opts.mime : "",
      token: typeof opts.token === "string" ? opts.token : "",
    });
  },

  // ── Save a chat attachment to disk (Save as…) ────────────────────────────
  // The renderer offers this on an attachment's download affordance when running
  // on desktop. The main process pops a native Save dialog, then REUSES the same
  // authenticated download helper drag-out uses to stream the file to the chosen
  // path. opts: { url, filename?, mime?, token? }. Resolves the saved absolute
  // path on success, or null (cancelled / failed / locked-E2EE). No-op in the
  // browser (collabDesktop is undefined → the renderer uses its web blob save).
  saveFile(opts) {
    if (!opts || typeof opts !== "object") return Promise.resolve(null);
    if (typeof opts.url !== "string" || !opts.url) return Promise.resolve(null);
    return ipcRenderer.invoke("desktop:save-file", {
      url: opts.url,
      filename: typeof opts.filename === "string" ? opts.filename : "",
      mime: typeof opts.mime === "string" ? opts.mime : "",
      token: typeof opts.token === "string" ? opts.token : "",
    });
  },
  // Reveal a saved file in the OS file manager (Explorer/Finder), selected.
  revealInFolder(path) {
    if (typeof path !== "string" || !path) return Promise.resolve(false);
    return ipcRenderer.invoke("desktop:reveal-in-folder", path);
  },
  // Open a saved file with its default OS application.
  openPath(path) {
    if (typeof path !== "string" || !path) return Promise.resolve(false);
    return ipcRenderer.invoke("desktop:open-path", path);
  },

  // ── App Info ───────────────────────────────────────────────────────────────
  appInfo: {
    platform: PLATFORM,
    isElectron: true,
    version: VERSION,
    buildNumber: BUILD_NUMBER,
  },

  // ── About dialog ─────────────────────────────────────────────────────────
  getAboutInfo() {
    return ipcRenderer.invoke("desktop:about-info");
  },

  // ── Secure token storage (OS keychain) — #66 ────────────────────────────────
  // ADDITIVE, desktop-only. The shared web app's token shim (lib/tokenStore.ts)
  // PREFERS this secure store on desktop so the auth token is encrypted at rest by
  // the OS keychain instead of plaintext localStorage; it falls back to localStorage
  // when `available` is false (e.g. Linux with no libsecret), so the web token flow
  // is never affected and login never breaks if the keychain is missing.
  //   secureStore.get(key?)         -> Promise<{ available:boolean, value:string|null }>
  //   secureStore.set(key?, token)  -> Promise<{ available:boolean, ok:boolean }>
  //   secureStore.clear(key?)       -> Promise<{ available:boolean, ok:boolean }>
  // AUDIT #16: KEYED so the 30-day refresh token gets its own OS-encrypted slot.
  // `keyed:true` lets the web renderer detect this newer shell and use the keyed
  // API; on an OLDER shell (no `keyed`) it falls back to its legacy behaviour, so a
  // version-skew window never corrupts the store or breaks login.
  secureStore: {
    keyed: true,
    get(key) {
      return ipcRenderer.invoke(
        "desktop:secure-get",
        typeof key === "string" ? key : "authToken",
      );
    },
    set(key, token) {
      return ipcRenderer.invoke(
        "desktop:secure-set",
        typeof key === "string" ? key : "authToken",
        typeof token === "string" ? token : "",
      );
    },
    clear(key) {
      return ipcRenderer.invoke(
        "desktop:secure-clear",
        typeof key === "string" ? key : undefined,
      );
    },
  },
});
