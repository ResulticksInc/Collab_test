# Collab — Calls vs Meetings Feature Parity

Audit of the two real-time surfaces: **Calls** (1:1 + group huddles, rendered in
`CoLabV1.tsx`) and **Meetings** (scheduled rooms, `MeetingStage.tsx`). Both use the same
LiveKit media engine, token endpoint, TURN/ICE config, secure-context preflight, and
device-switch plumbing — so connectivity and media behave identically.

## Matrix

| Capability | Calls | Meetings | Status |
|---|---|---|---|
| Mic toggle (mute) | ✅ | ✅ | aligned |
| Camera toggle | ✅ | ✅ | aligned |
| Screen share (video) | ✅ | ✅ | aligned |
| Screen share audio | ✅ (Chromium) | ✅ (Chromium) | aligned (Firefox video-only — see browser matrix) |
| Device selection — mic/cam | ✅ | ✅ | aligned |
| Device selection — speaker | ✅ (Chromium) | ✅ (Chromium) | aligned — both gated on `setSinkId` |
| Mid-call device switch / hot-plug | ✅ | ✅ | aligned (`switchActiveDevice` + `ActiveDeviceChanged`) |
| Recording | ✅ | ✅ | aligned (`MediaRecorder` + `isTypeSupported` fallback) |
| **Pin** (Teams "Pin for me") | ✅ local **multi-pin** | ✅ local **multi-pin** | Teams-exact in BOTH (area + strip, sticky, local) |
| Active-speaker outline | ✅ | ✅ | aligned |
| Camera-off avatar fallback | ✅ | ✅ | aligned |
| Group host controls (mute/remove) | ✅ (group) | ✅ | aligned |
| In-call **chat** | ➖ (uses conversation chat) | ✅ (DataChannel) | **intentional diff** |
| **Reactions** | ✅ (DataChannel) | ✅ | **aligned this sprint** |
| **Raise hand** | ✅ group (DataChannel) | ✅ | **aligned this sprint** |
| Lobby / lock | n/a | ✅ | meeting-only by design |
| Co-host promote/demote, admit/deny | n/a | ✅ | meeting-only by design |
| Gallery / Speaker view modes | ➖ (auto grid) | ✅ | meeting-only by design |

## Intentional differences (documented, not bugs)
- **In-call chat:** a call always happens **inside a conversation** (DM/group) whose chat
  panel is right there, so a separate in-call chat is redundant. Meetings are standalone
  (may have no backing conversation) → they get a DataChannel chat. *Decision: keep as-is.*
- **Lobby / lock / co-host / admit-deny / view modes:** governance + large-room ergonomics
  that only apply to scheduled meetings. *Decision: meeting-only.*

## Genuine gaps — now closed
- **Reactions** + **Raise hand** added to calls via the **LiveKit DataChannel**
  (`publishData`/`DataReceived`) — no backend changes. Reactions: dock "React" button →
  emoji popover → floating overlay (auto-expire 4s), broadcast to all. Raise hand:
  group-call dock toggle → raised-hands pill (cleared on lower/leave/new-call). This
  differs from meetings (which use Socket.IO) but is functionally equivalent and fully
  client-side.

## Fixed / hardened this sprint
- **Pin parity:** calls gained a real tile pin → spotlight (full-width + thumbnail strip);
  meeting pin now also **expands** the person (true spotlight), not just page-1 rank.
- **Pin + screen-share glitch:** a participant who is camera + screen at once shares one
  `pid` across two tiles — the call spotlight now picks **one** big tile (prefers the
  screen) so it never renders two full-width rows. Screen tiles tagged `data-screen`.
- **Speaker-picker parity:** meeting speaker picker now gated on `setSinkId` like calls
  (no dead dropdown on Firefox). See `docs/BROWSER_MATRIX.md`.

## Cross-browser
Connectivity/media parity across Chrome/Edge/Brave/Arc/Firefox is covered in
`docs/BROWSER_MATRIX.md`. **Messaging** uses standard React + Socket.IO + Fetch + the
clipboard/file APIs — no browser-specific media APIs — so it behaves the same everywhere a
secure context is available.
