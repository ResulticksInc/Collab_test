# Collab — Calls & Meetings Browser Compatibility Matrix

Scope: Chrome, Edge, Brave, Arc (all Chromium) and Firefox. Safari/WebKit noted where
relevant. This documents what each browser supports, the **fallbacks already in the
code**, and what was fixed for parity. Goal: **no browser silently fails.**

> Media requires a **secure context** (HTTPS, or `localhost`). On a plain-HTTP LAN
> origin `navigator.mediaDevices` is `undefined` in every browser — handled up-front
> by `lib/mediaSupport.ts` (clear "use HTTPS" message instead of a crash).

## Feature matrix

| Feature | Chrome | Edge | Brave | Arc | Firefox | Notes / fallback |
|---|---|---|---|---|---|---|
| **Camera** (getUserMedia) | ✅ | ✅ | ✅ | ✅ | ✅ | Secure-context preflight (`mediaSupport.ts`); `NotAllowedError` → "permission denied" message |
| **Microphone** (getUserMedia) | ✅ | ✅ | ✅ | ✅ | ✅ | same |
| **Screen share — video** (getDisplayMedia) | ✅ | ✅ | ✅ | ✅ | ✅ | LiveKit `setScreenShareEnabled` |
| **Screen share — system/tab audio** | ✅ | ✅ | ✅ | ✅ | ❌ | Firefox can't capture system audio → shares **video only** (LiveKit degrades gracefully, no crash) |
| **Speaker selection** (setSinkId) | ✅ | ✅ | ✅ | ✅ | ❌ | Chromium-only. Picker is **hidden** when unsupported — now in **both** calls and meetings (was a meeting-only gap, fixed) |
| **Video codec VP9 + simulcast** | ✅ | ✅ | ✅ | ✅ | ✅ | `backupCodec` vp8/h264 auto-negotiated by LiveKit (covers Safari/older) |
| **Recording** (MediaRecorder) | ✅ | ✅ | ✅ | ✅ | ✅ | `isTypeSupported` fallback chain (vp9→vp8→default); Safari limited |
| **Device hot-plug / mid-call switch** | ✅ | ✅ | ✅ | ✅ | ⚠️ | `ActiveDeviceChanged` + `switchActiveDevice`; Firefox emits fewer device-change events |

### App-layer features (browser-agnostic React UI — work everywhere)
Join · Leave · Rejoin · Participant list · Chat · Reactions · Raise hand · Recording
indicator · Audio toggle · Video toggle · Pin/spotlight · Direct calls · Group calls ·
Call controls · Participant/host controls. These don't touch browser-specific media APIs.

## Unsupported APIs by browser (the only real gaps)

| API | Unsupported in | Effect | Handling |
|---|---|---|---|
| `HTMLMediaElement.setSinkId` | Firefox, Safari | Can't pick output speaker | Speaker picker hidden (calls **and** meetings); audio still plays on the OS default |
| `getDisplayMedia({audio})` system audio | Firefox | No shared-tab audio | Screen shares video-only; participants still hear voices over the normal mic track |
| `MediaRecorder` vp9 | Safari | Recording mime fallback | `isTypeSupported` chain picks a supported mime |

## Messaging (cross-browser)

Messaging uses standard React + Socket.IO + Fetch + DOM APIs, so it behaves the same
across Chrome/Edge/Brave/Arc/Firefox. The few version-sensitive bits are feature-detected:

| Feature | Chrome | Edge | Brave | Arc | Firefox | Handling |
|---|---|---|---|---|---|---|
| Send / receive / realtime | ✅ | ✅ | ✅ | ✅ | ✅ | Socket.IO + Fetch |
| Rich text editor (TipTap) | ✅ | ✅ | ✅ | ✅ | ✅ | library-level cross-browser |
| **Copy message** (HTML + plain) | ✅ | ✅ | ✅ | ✅ | ✅ | `ClipboardItem` when present; **falls back** to plain `writeText`, then to `execCommand("copy")` — now via `lib/clipboard.ts`, so copy works even on insecure-context / older browsers (was a silent-fail gap) |
| Copy link / ID / app URL | ✅ | ✅ | ✅ | ✅ | ✅ | routed through the same `copyText()` fallback (CalendarView, MeetingsView, FilesView, Modals, Settings) |
| Paste rich text | ✅ | ✅ | ✅ | ✅ | ✅ | HTML parsed to safe text (`messageText`) |
| File / image upload + drag-drop | ✅ | ✅ | ✅ | ✅ | ✅ | `<input type=file>` + DnD — universal |
| **Voice messages** (MediaRecorder) | ✅ | ✅ | ✅ | ✅ | ✅ | `isTypeSupported` mime fallback chain |
| Emoji rendering (grapheme count) | ✅ | ✅ | ✅ | ✅ | ✅ | `Intl.Segmenter` with `Array.from` fallback (Safari <16.4 / FF <125) |
| Desktop notifications | ✅ | ✅ | ✅ | ✅ | ✅ | `Notification` permission-gated; no-op if denied/unsupported |
| Local timezone display | ✅ | ✅ | ✅ | ✅ | ✅ | `toLocale*` from raw ISO (`lib/time.ts`) |

## Brave / Arc specifics
- **Arc** = Chromium → identical to Chrome.
- **Brave** = Chromium, but **Shields** can block autoplay/devices on some sites. If media
  fails *only* in Brave, lower Shields for the site. (App behaves as Chrome otherwise.)

## What was fixed for parity (this pass)
- **Meeting speaker picker** is now gated on real `setSinkId` support (`sinkSupported`),
  matching the call path — Firefox no longer shows a dead "Speaker" dropdown that did
  nothing. (`MeetingStage.tsx`)

## Manual test checklist (run per browser)
For Chrome, Edge, Firefox, Brave (and Arc if used), on a **secure origin**:
1. Grant camera + mic when prompted; deny once → confirm the "permission denied" message.
2. Meeting: Join → Leave → Rejoin; participant list, chat, reactions, raise hand,
   audio/video toggle, pin a tile.
3. Screen share: confirm video shares everywhere; on Firefox confirm it shares video-only
   (no error) and others still hear you.
4. Speaker picker: present on Chromium, **absent** on Firefox (expected — no setSinkId).
5. 1:1 call + group call: controls, pin/spotlight, participant controls.
6. Console: **no uncaught errors**, no unhandled promise rejections, no `[CALLDIAG] Media Error`.

Use the in-app diagnostics while testing: `?calldebug=1` (call/meeting `[CALLDIAG]` trail)
and `Ctrl+Alt+D` (DiagnosticsPanel) to capture the exact failing layer per browser.
