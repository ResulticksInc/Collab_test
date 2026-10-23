# Collab Desktop — Cross-Platform Build, Distribution & Deployment Guide

Collab Desktop v1.0 is a thin Electron client that loads the **hosted** Collab web
app (`https://collab.resulticks.com`) exactly like a browser — no localhost, no
bundled frontend, no dev tooling for end users. This guide covers producing and
distributing installers for **Windows, macOS, and Linux**.

---

## 1. Build-machine setup

Requirements: Node 18+, npm. Each OS builds its own installers:

| Target | Build on |
|---|---|
| Windows `.exe` (NSIS + portable) | Windows |
| macOS `.dmg` + `.zip` (universal) | macOS (signing/notarization need Apple tooling) |
| Linux `.AppImage` + `.deb` | Linux |

```bash
cd desktop
npm install        # electron, electron-builder, electron-store, sharp, png-to-ico
```

---

## 2. Icons (already generated, committed)

`build/icon.svg` → `build/icon.png` (1024²) + `build/icon.ico`:

```bash
npm run icons
```

electron-builder derives macOS `.icns` from `icon.png`. Used by installer,
executable, taskbar/dock, and native notifications. Re-run only if the SVG changes.

---

## 3. Environment selection (no code edits)

Precedence: **env vars → `resources/collab.config.json` → built-in defaults**.

| Var | Meaning |
|---|---|
| `COLLAB_ENV` | `development` \| `staging` \| `production` |
| `COLLAB_WEB_URL` | the hosted origin Electron loads |
| `COLLAB_API_URL` / `COLLAB_SOCKET_URL` / `COLLAB_LIVEKIT_URL` | carried for reference; the hosted app derives these same-origin |
| `COLLAB_CONFIG` | explicit path to a config json |

Defaults: prod → `https://collab.resulticks.com`, dev → `http://localhost:3002`.
For a **staging** build, edit `desktop/collab.config.json` before packaging. IT can
also repoint an **installed** build by editing `<install>/resources/collab.config.json`
— no rebuild.

---

## 4. Build commands

```bash
cd desktop
npm run dist:win      # Windows  → dist/Collab Setup <ver>.exe  +  Collab Portable <ver>.exe
npm run dist:mac      # macOS    → dist/Collab-<ver>.dmg  +  .zip   (run on macOS)
npm run dist:linux    # Linux    → dist/Collab-<ver>.AppImage  +  .deb   (run on Linux)
```

Output dir: `desktop/dist/`.

### Windows note — winCodeSign symlink prerequisite (handled automatically)

electron-builder's exe-stamping downloads `winCodeSign-2.6.0.7z`, which contains
macOS `.dylib` **symlinks**. Extracting a symlink on Windows needs the *Create
symbolic links* privilege (**Developer Mode ON**, or an elevated/admin shell).
On a standard machine the build otherwise fails with:

> ERROR: Cannot create symbolic link : A required privilege is not held by the client

`npm run dist:win` runs `predist:win` (`scripts/prebuild-wincodesign.js`) first,
which seeds electron-builder's cache by extracting winCodeSign **excluding the
`darwin/` folder** (the only symlinks; a Windows build never uses the macOS libs).
This makes the build succeed with **no admin and no Developer Mode**. On machines
that already have Developer Mode, it's a harmless no-op.

---

## 5. Verified build output (this machine, Windows x64)

| Artifact | Size | Notes |
|---|---|---|
| `dist/Collab Setup 1.0.0.exe` | ~77 MB | NSIS installer (per-user, shortcuts, uninstall entry) |
| `dist/Collab Portable 1.0.0.exe` | ~70 MB | single-file portable, no install |

Package verified: `resources/collab.config.json` shipped (ops-editable);
dev-only modules (sharp, png-to-ico, electron-builder) **excluded** from the asar;
`electron-store` + all app sources included; brand icon applied.

> macOS and Linux installers were **not** produced here (this is a Windows host;
> dmg/notarization require macOS, AppImage/deb build on Linux). The configuration
> for all three is complete and validated — run the commands above on each OS / in
> CI to produce them.

---

## 6. Distribution

Host the installer on an intranet share / SharePoint / S3 / the Collab server. Then:

1. Download `Collab Setup <ver>.exe` (or the `.dmg` / `.AppImage`).
2. Install (Windows NSIS is per-user → **no admin prompt**; choose folder + desktop shortcut).
3. Launch **Collab** like any app.
4. Log in with the existing Collab account.
5. Use messaging, calls, meetings against the hosted infrastructure.

No localhost. No npm. No manual file copying.

---

## 7. Upgrades, uninstall & data

- **Upgrade:** bump `version` in `desktop/package.json`, rebuild, ship the new file. NSIS replaces the old version in place.
- **User data preserved** across upgrade *and* uninstall — login session, settings, window state, logs in `%APPDATA%\Collab` (macOS `~/Library/Application Support/Collab`, Linux `~/.config/Collab`) are never wiped (`deleteAppDataOnUninstall: false`). Reinstall keeps the user logged in.
- **Uninstall:** Windows *Apps & features* → Collab; macOS drag to Trash; Linux package manager / delete AppImage.

---

## 8. Startup behaviour

| Situation | Behaviour |
|---|---|
| Backend reachable | Loads the hosted app; user logs in. |
| Backend unreachable | Branded **reconnect screen**, auto-probes with backoff, connects when the server returns. Never crashes. |
| Renderer crash | Auto-reloads ≤3×, then a **recovery screen** (Reload / Restart / Exit). Never a blank window. |
| Sleep/resume, lock | Logged; the web client re-establishes its own socket/LiveKit sessions. |

---

## 9. Platform specifics

### macOS (universal: Apple Silicon + Intel)
- `mac.target` builds `dmg` + `zip` at `arch: [universal]`.
- `hardenedRuntime: true` + `entitlements.mac.plist` (camera, microphone, audio-input) → notarization-ready.
- `extendInfo` declares `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`, `NSScreenCaptureUsageDescription` — the TCC prompts shown on first call/meeting/screen-share.
- **Signing/notarization:** set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (and a Developer ID cert via `CSC_LINK`/`CSC_KEY_PASSWORD`) before `npm run dist:mac`; `mac.notarize` flips on automatically. Left off so unsigned dev builds succeed.

### Windows 10/11
- NSIS installer + portable exe; per-user, desktop + Start Menu shortcuts, uninstall entry, taskbar grouping via `AppUserModelId`.
- **Code-signing:** set `CSC_LINK` + `CSC_KEY_PASSWORD` (PFX) — picked up automatically; no config change.

### Linux (Ubuntu primary)
- AppImage + `.deb`; `.desktop` entry (`StartupWMClass: Collab`), icon, Office category. Native notifications via libnotify.

---

## 10. Security posture

contextIsolation on · nodeIntegration off · navigation pinned to the configured
origin · `setWindowOpenHandler` sends external links to the system browser · every
IPC handler validates the sender · preload exposes only the `collabDesktop` bridge.

---

## 11. Remaining platform-specific limitations

- **macOS/Linux installers** must be built on their own OS (or CI runners) — not producible from Windows.
- **macOS notarization** requires an Apple Developer account + credentials (config is ready; just supply env vars).
- **Code-signing** (Windows + macOS) is configured but unsigned by default — users see the OS "unknown publisher" prompt until a cert is supplied. Strongly recommended before external/customer distribution.
- The Windows `winCodeSign` symlink workaround (§4) is local-machine-specific; CI runners with Developer Mode don't need it but the no-op prebuild is safe everywhere.
