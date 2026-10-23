# Collab Desktop — Electron Production Client
#
# The desktop app is a THIN SHELL around the HOSTED Collab web app. It loads
# https://collab.resulticks.com exactly like a browser — no bundled frontend,
# no localhost server. Employees install it and log in; everything (messaging,
# calls, meetings) runs against the hosted backend.
#
# ── Architecture ─────────────────────────────────────────────────────────────
#   Main Process  (main.js)        — window, IPC, env config, reconnect + crash
#                                    recovery, lifecycle/power logging, security
#   Preload       (preload.js)     — contextBridge: window.collabDesktop
#   Config        (config.js)      — resolves env (dev/staging/prod) + URLs
#   Notifications (desktopNotif.js)— native Notification + dedup + cleanup
#   Logger        (logger.js)      — local rotating file log (userData/logs)
#   Recovery      (recovery.html)  — fallback UI after repeated renderer crash
#   Reconnect     (reconnect.html) — auto-retry UI when the backend is unreachable
#   Renderer                       — the HOSTED Collab web app (loaded over https)
#
# ── Desktop Bridge (window.collabDesktop) ────────────────────────────────────
#   showNotification(opts)       — Electron native Notification API
#   onNotificationAction(cb)     — click/action handler
#   showOpenDialog(opts)         — native file dialog
#   clipboardWrite/Read          — system clipboard
#   openExternal(url)            — open http/https in the system browser
#   window.minimize/maximize/unmaximize/close
#   appInfo: { platform, isElectron, version }
#   recovery(action)             — INTERNAL: recovery.html only
#   reconnectNow / onReconnectStatus — INTERNAL: reconnect.html only
#
# ── Environment configuration (no source edits to switch) ────────────────────
#   Precedence: env vars  >  resources/collab.config.json  >  built-in defaults
#     COLLAB_ENV         development | staging | production
#     COLLAB_WEB_URL     e.g. https://collab.resulticks.com   (what Electron loads)
#     COLLAB_API_URL / COLLAB_SOCKET_URL / COLLAB_LIVEKIT_URL  (carried for ref;
#       the hosted web app derives these same-origin)
#     COLLAB_CONFIG      explicit path to a config json (overrides the above file)
#   Built-in defaults: dev → http://localhost:3002, prod → https://collab.resulticks.com
#   IT can repoint an INSTALLED build by editing  <install>/resources/collab.config.json
#   — no rebuild required.
#
# ── Develop ──────────────────────────────────────────────────────────────────
#   1. npm run dev          (repo root)  — starts backend + frontend (localhost:3002)
#   2. cd desktop && npm run dev          — Electron loads http://localhost:3002
#
# ── Build installers ─────────────────────────────────────────────────────────
#   cd desktop
#   npm install            # once — pulls electron, electron-builder, sharp, png-to-ico
#   npm run icons          # regenerate build/icon.png + build/icon.ico from build/icon.svg
#   npm run dist:win       # → dist/Collab Setup <version>.exe   (NSIS installer)
#   npm run dist:mac       # → dist/*.dmg + *.zip   (run on macOS)
#   npm run dist:linux     # → dist/*.AppImage + *.deb
#
# ── Production logs (local only, rotating, no cloud) ──────────────────────────
#   Windows : %APPDATA%\Collab\logs\main.log
#   macOS   : ~/Library/Application Support/Collab/logs/main.log
#   Linux   : ~/.config/Collab/logs/main.log
#
# The renderer NEVER imports Electron directly. All native access goes through
# the contextBridge. contextIsolation on, nodeIntegration off, navigation pinned
# to the configured origin, external links open in the system browser.
