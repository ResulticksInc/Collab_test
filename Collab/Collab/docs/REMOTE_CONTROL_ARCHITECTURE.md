# Collab — Enterprise Remote Control (Teams-level): Architecture & Plan

Status: **design + foundation**. This document is deliverables 1–9; the code
foundation lands incrementally per the plan in §10. It integrates into the
**existing LiveKit/WebRTC pipeline** — no call-architecture redesign.

---

## 0. The one hard constraint (read first)

**A web browser physically cannot inject OS-level mouse/keyboard input.** It is
sandboxed — a page cannot move the OS cursor, type into another app, or drive an
IDE/terminal. This is a security boundary, not a missing feature.

Consequence for "control someone's computer":

| Role | Browser | Electron desktop |
|------|---------|------------------|
| **Controller** (the one taking control) | ✅ full — capture clicks/keys on the shared video, send events | ✅ full |
| **Controlled** (whose machine is driven) | ❌ impossible at OS level (sandbox) | ✅ full — native input injection |

So the spec's "Participant B gains mouse + keyboard control of A" works when **A
(the one sharing + being controlled) runs the Collab desktop app**. A browser
sharer can be *viewed* but not OS-controlled — we **gracefully degrade** (the
"Request control" button is hidden / shows "host is on web, control unavailable").
This matches **Quick Assist / Teams**: the controlled side runs the native app.

We do **not** reduce browser functionality: a browser user can still be a
*controller*, and everything else (request UI, cursor, toolbar) is identical.

> Optional later: in-page control of a **shared browser tab** (not the OS) via a
> content bridge — niche, deferred.

---

## 1. Architecture

Reuse the existing transport. Three planes:

```
 Controller (browser or app)                 Controlled (DESKTOP APP only)
 ┌─────────────────────────────┐             ┌──────────────────────────────────┐
 │ screen-share <video> (LiveKit│  rc:input   │ renderer: receives rc:input over │
 │  subscribed track)           │ ──────────► │  LiveKit DataChannel             │
 │ capture mouse/keys on video  │  (LiveKit   │   │ IPC                          │
 │  → normalize to 0..1         │  DataChannel│   ▼                              │
 │ render local "you control X" │  reliable)  │ main.js: map 0..1 → display px,  │
 │ overlay + toolbar            │ ◄────────── │  inject via native input module  │
 │ remote cursor of self        │  rc:cursor  │ render border + "X is controlling"│
 └─────────────────────────────┘  rc:state   └──────────────────────────────────┘
```

- **Video plane**: unchanged. The existing LiveKit screen-share track is the
  picture. We only raise its quality while control is active (§8).
- **Control plane**: a new **LiveKit DataChannel topic** `rc` (reliable, ordered).
  No new server media path; LiveKit already carries data messages (we already use
  the data channel for reactions / raise-hand).
- **Input-injection plane** (Electron only): renderer → `ipcRenderer` → `main.js`
  → native module (`@nut-tree-fork/nut-js`, prebuilt N-API, no compiler needed).

**Coordinate model**: the controller sends **normalized** coordinates `(x,y)` in
`[0,1]` relative to the *shared surface*. The controlled app maps them to the
**shared display's** bounds (`screen.getAllDisplays()` + the `desktopCapturer`
source id it is sharing) → absolute pixels → DPI-correct injection. Normalized
coords make it resolution/zoom independent and survive adaptive-resolution.

---

## 2. Browser capabilities & limitations

| Capability | Browser | Electron |
|---|---|---|
| Subscribe + render shared screen | ✅ | ✅ |
| Capture controller input on the video, normalize, send | ✅ | ✅ |
| Render remote cursor / toolbar / border | ✅ | ✅ |
| **Inject OS mouse/keyboard (be controlled)** | ❌ sandbox | ✅ native |
| Capture *system-wide* keys while controlling (e.g. Win/Cmd, F-keys) | ⚠️ partial — needs `navigator.keyboard.lock()` in fullscreen; some keys reserved by the OS/browser | ✅ full |
| Native context menus on the controlled side | n/a (controlled = app) | ✅ |

Mitigations: controller uses **Keyboard Lock API** + Pointer Lock in fullscreen
to capture the widest key set the browser allows; anything the browser reserves
is documented as a known browser limitation (Electron controller has no such cap).

---

## 3. Electron-specific implementation

- **Native input**: `@nut-tree-fork/nut-js` (maintained robotjs successor,
  prebuilt binaries for win/mac/linux-x64 → no node-gyp at install). Wrapped in
  `desktop/remoteInput.js` with a hard kill-switch.
- **IPC**: `rc:inject` (renderer→main, validated payload), `rc:session` (state),
  `rc:displays` (main→renderer: shareable displays + bounds).
- **macOS**: requires **Accessibility** + **Screen Recording** permissions
  (System Settings → Privacy). main.js checks `systemPreferences.isTrustedAccessibilityClient(true)`
  and surfaces a one-time prompt; control is blocked until granted.
- **Linux**: X11 fully supported; **Wayland** restricts synthetic input — detect
  (`XDG_SESSION_TYPE`), and where blocked, degrade to "view only / X11 required".
- **Security**: main.js only accepts `rc:inject` while a *granted* session exists
  (validated by a session token the renderer got from the approval handshake);
  every event is rate-limited and bounds-clamped.

---

## 4. Backend changes (minimal)

The control handshake rides the **LiveKit DataChannel** (peer-to-peer via SFU) —
**no backend needed for the live path**. Backend only for **audit logging**
(security requirement "log every control session"):

- `POST /api/calls/:id/remote-control/log` — `{ action, controllerId, controlledId, ts }`
  for request/grant/deny/stop/revoke/auto-revoke. Append-only, soft-delete aware.
- Migration `00xx_remote_control_log` (table `remote_control_log`).
- No token/SFU/LiveKit changes.

---

## 5. Frontend changes

- **`lib/remoteControl.ts`** — protocol + state machine over the LiveKit
  DataChannel (request/allow/deny/stop/revoke/input/cursor), timeouts, and the
  auto-revoke triggers (§6). Transport-agnostic; reused by call + meeting.
- **`components/RemoteControlLayer.tsx`** — all UI: Request-control button on a
  remote screen-share tile, the Allow/Deny prompt, the active toolbar, the remote
  cursor overlay (60fps via rAF + interpolation), the colored border + status
  badge. One component, mounted by both CallModal (CoLabV1) and MeetingStage.
- **Integration**: CoLabV1 `CallModal` + `MeetingStage` pass their LiveKit room +
  the active screen-share track into `RemoteControlLayer`.

---

## 6. Security model

- **Explicit approval required** — control never auto-starts; a session needs a
  fresh Allow click. Approval issues a short-lived **session token** the
  controlled renderer requires before forwarding any `rc:input` to main.
- **No auto-reconnect into control** — on any reconnect the session is dropped;
  control must be re-requested.
- **Auto-revoke** (all enforced client-side + the controlled main process stops
  injecting) on: call/meeting end, controller or controlled leaves, screen-share
  stops, network disconnect/reconnect, explicit revoke, app close, window close,
  controlled app loses the shared window.
- **Audit**: every transition logged (§4).
- **One active controller at a time** per shared surface (meeting host arbitrates).

---

## 7. Permission workflow (state machine)

```
IDLE ──Request──► REQUESTING ──(peer Allow)──► CONTROLLING        (controller)
  ▲                  │  └─(Deny / 30s timeout)─► IDLE
  │                  ▼
  └────────── Stop / auto-revoke ◄── (any §6 trigger)

IDLE ──(peer Request)──► PROMPTED ──Allow──► BEING_CONTROLLED     (controlled)
  ▲                         └─Deny──► IDLE          │
  └──────── Revoke / Take-back / auto-revoke ◄──────┘
```

Every transition emits an `rc:state` message so **both** sides' UI is always in
sync. Meeting host can Grant / Transfer / Revoke / Queue requests.

---

## 8. Performance

- **Cursor 60fps**: cursor positions sent throttled (~60Hz) on an *unreliable*
  data topic; receiver interpolates between samples with rAF — smooth even if
  some samples drop. Input events (clicks/keys) go on the *reliable* topic.
- **Input latency**: events sent immediately (no batching) on the reliable topic;
  main injects synchronously.
- **Video sharpness while controlling**: bump the screen-share encoding to
  prioritize resolution/detail (LiveKit `setScreenShareSimulcastLayers` /
  higher `maxBitrate`, `degradationPreference: "maintain-resolution"`, content
  hint `"detail"`), target 1080p/up-to-60fps, adaptive-degrade under congestion
  via LiveKit's existing adaptive stream — **reuse the existing transport, no
  re-encode pipeline added**.
- Bandwidth: control plane is tiny (events are bytes); only the existing video
  carries weight.

---

## 9. Files (planned)

- NEW `frontend/app/src/lib/remoteControl.ts`
- NEW `frontend/app/src/components/RemoteControlLayer.tsx`
- NEW `desktop/remoteInput.js` (native-input wrapper) + `desktop/package.json` dep
- EDIT `desktop/main.js` (`rc:inject`/`rc:displays` IPC + permission checks)
- EDIT `desktop/preload.js` (`window.collabDesktop.remoteInput` bridge)
- EDIT `frontend/app/src/components/CoLabV1.tsx` (mount layer in CallModal)
- EDIT `frontend/app/src/components/MeetingStage.tsx` (mount layer)
- NEW backend route + migration for the audit log
- NEW `frontend/app/src/styles` rules for cursor/border/toolbar

---

## 10. Implementation plan (staged — each stage is shippable + testable)

1. **Protocol + state machine** (`remoteControl.ts`) — no native deps, unit-checkable.
2. **UI layer** (`RemoteControlLayer.tsx`) — request/allow/deny/toolbar/cursor/border, wired to the protocol; works browser↔browser for the *handshake + cursor* (no injection yet).
3. **Electron input bridge** (`remoteInput.js` + main/preload + nut-js dep) — real OS injection on the controlled desktop app.
4. **Integration** into CallModal + MeetingStage across all call types.
5. **Quality bump** (§8) + **audit log** (§4) + **host arbitration** (§7).
6. **Per-OS native test + installer build** (win/mac/linux).

Stages 1–2 are platform-agnostic and verifiable in the browser; stage 3 needs the
native module + a 2-machine test; stage 6 needs per-OS hosts (esp. macOS).
