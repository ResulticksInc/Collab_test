# CoLab Desktop Advantages — catalog + roadmap

**Framing:** a browser tab dies when you close it. CoLab's Electron shell can stay
resident in the tray to ring calls, badge unread, enforce OS‑level DLP, inject
remote‑control input, and run on‑device AI — none of which a web tab can do.

Legend — **Web**: ⛔ impossible on web · 🔸 worse on web · ⚪ parity.
**Status**: ✅ shipped (committed `57b4f66`) · 🟡 partial · ⬜ not started.
**Effort**: S / M / L.

---

## 🦄 Unique vs Teams / Slack / Discord / Zoom (the differentiators)

| Edge | Status | Effort | Why the giants can't / don't |
|---|---|---|---|
| Remote control in ANY call ("Live Collaboration") | ✅ (branded) | M | Decoupled from screen‑share via nut‑js OS‑input injection; Teams/Zoom only inside a share, Slack/Discord none. *(Has a grant prompt + audit log already.)* |
| On‑device meeting transcription/summaries | ⬜ | L | Teams/Zoom/Slack AI ship audio to their cloud (blocked in legal/finance/health). Bundle whisper.cpp on the loopback audio we already capture. |
| Screen‑capture‑protected confidential channels | ⬜ | **S** | `setContentProtection` blanks a channel from Snipping Tool/OBS/Zoom‑share. No giant does this. **Best enterprise win at S.** |
| **Ring + answer when fully closed/in tray** | ⬜ | L | All four giants do it; CoLab is the one missing it. **The reason enterprises mandate the desktop app.** Now unblocked — rides on the tray we just shipped. |
| Global push‑to‑talk + answer hotkeys | 🟡 | M | We have show/hide + mute + PiP hotkeys; PTT (hold) + answer‑call not yet. Discord's signature. |
| One‑hotkey screenshot → annotate → send | ⬜ | M | None of them; users alt‑tab to Snagit. Reuses desktopCapturer + upload. |
| Global quick‑capture → CoLab task | ⬜ | M | Ctrl+Shift+Space → type → lands in Tasks. Slack's shortcut only opens the app. |
| Watch‑a‑folder auto‑share | ⬜ | L | Drop a file in ~/CoLab‑Share → auto‑posts. No giant does fs‑watch. |
| Always‑on‑top mini‑call over fullscreen apps | 🟡 | S | Whole‑UI PiP ships; add mute/hang‑up to a compact tile. |
| Auto‑status from idle + foreground app + calendar | ⬜ | M | Teams reads only its calendar; nobody reads your active app. Web can't read OS idle. |
| Harder‑than‑Teams security (keychain tokens + cert pinning + signed updates) | ⬜ | M | Browsers dropped HPKP, stuck on localStorage. Also fixes today's localStorage‑token gap. |

---

## ✅ Shipped THIS session (committed `57b4f66`)
- **Live Collaboration** rebrand of remote‑control co‑browse
- **System tray** + **close‑to‑tray** + **auto‑launch** + **taskbar/dock badge** + Settings → Desktop toggles
- **`colab://` deep linking** (chat/message/meeting/call)
- **Global shortcuts** — `Ctrl/Cmd+Shift+C` show/hide, `+M` mute, `+D` PiP
- **Command palette** (Cmd/Ctrl+K)
- **Native pop‑out windows** (real Electron BrowserWindow, sender‑scoped controls)

## ✅ Shipped earlier (desktop‑only, live before this session)
Whole‑UI always‑on‑top PiP · remote control / OS‑input injection · system‑audio
capture in share · native screen‑picker (per‑window thumbnails, concurrent share)
· native notifications + click‑to‑focus · 2 GB uploads / 500 MB inline (vs 100 MB
web) · cross‑network calls (TURN/SFU solved) · crash‑safe relaunch/recovery.

---

## ⚡ Quick wins (S — plumbing already present)
| Item | Status | Web | Value | Note |
|---|---|---|---|---|
| `backgroundThrottling:false` + `powerSaveBlocker` in calls | ⬜ | ⛔ | high | **Best value‑per‑effort overall** — one line; web calls stutter when backgrounded. |
| Taskbar/dock unread badge | ✅ | 🔸 | high | `setBadgeCount`/overlay; data already in `c.unread`. |
| Capture protection (confidential) | ⬜ | ⛔ | high | one API call; best enterprise/DLP win at S. |
| Tray menu quick‑actions + presence | 🟡 | ⛔ | high | tray exists; add quick actions/presence. |
| Idle → auto‑Away presence | ⬜ | 🔸 | high | `powerMonitor` already imported, only logging today. |
| Launch‑on‑login / start‑minimized | ✅ | ⛔ | med | pairs with tray. |
| Reveal‑in‑folder / open‑with | ⬜ | ⛔ | med | two shell wrappers. |
| Native context menu + spellcheck | ⬜ | 🔸 | med | flag flip + context‑menu. |
| Clipboard image paste | ⬜ | 🔸 | med | extends existing clipboard IPC. |
| Drag files out to desktop | ⬜ | ⛔ | high | `startDrag`; reuses attachment pipeline. |
| Incoming‑call taskbar flash | ⬜ | 🔸 | med | `flashFrame`. |
| Taskbar upload progress | ⬜ | ⛔ | med | `setProgressBar`; XHR progress already feeds it. |
| Jump list / dock menu | ⬜ | ⛔ | med | New message / Set Away / recent chats. |
| Thumbnail toolbar Mute/Cam/Leave | ⬜ | ⛔ | low | hover‑preview buttons. |
| Clear‑on‑exit (kiosk/shared PC) | ⬜ | 🔸 | med | wipe cache+tokens on quit. |

---

## 🚀 Flagship / web‑impossible
Ring‑when‑closed (L) · on‑device AI transcription (L) · global PTT/mute hotkeys
(M, partial) · screenshot‑annotate‑send (M) · `colab://` deep links (✅) · pop‑out
call & chat per monitor (M, chat done) · local meeting recording to disk (M) ·
present‑mode screen‑annotation overlay (M) · co‑browse a shared interactive web
view (L) · watch‑folder auto‑share (L) · global quick‑capture → task (M) ·
file/.ics associations (M) · multi‑monitor PiP placement (M) · instant‑open
offline SQLite cache + background sync (L — biggest perceived‑quality leap).

## 🔒 Enterprise & security (deal‑enablers)
Code‑signing + notarization (M — foundational; without it IT won't whitelist) ·
MDM/GPO managed config (M) · OS‑keychain tokens via `safeStorage` (M — fixes
today's localStorage gap) · signed‑manifest update integrity (M — current updater
verifies nothing) · cert pinning (M) · app‑level DLP block copy/screenshot of
flagged content (M) · idle auto‑lock + re‑auth (M) · Windows Hello / Touch ID
unlock (M) · kiosk mode (M) · tamper‑evident local audit log (M) · power‑save
blocker for long meetings (S).

## 🛠 Power‑user
Default download folder + Save As (M) · persistent preferred mic/cam/speaker
across restarts (M) · portable zero‑install build (M) · on‑device smart replies (L).

---

## 🎯 Recommended NEXT bundle (highest value‑per‑effort, all NOT‑yet‑done)
1. **`backgroundThrottling:false` + power‑save blocker** (S) — instantly smoother calls; one line.
2. **Ring + answer when closed** (L) — the enterprise must‑have; rides on the tray + existing socket/notification path.
3. **`setContentProtection` confidential channels** (S) — best enterprise/DLP win.
4. **Idle → auto‑Away** (S) — `powerMonitor` already imported.
5. **Global PTT + answer‑call hotkeys** (M) — extends the shortcuts already wired.
6. **Drag files out to desktop** + **clipboard image paste** (S/M) — daily‑use polish.
7. **OS‑keychain tokens (`safeStorage`)** (M) — closes the localStorage‑token gap.

> Code‑signing/notarization is the gate for the security items to actually ship,
> but it needs certs (deferred — internal/unsigned for now).
