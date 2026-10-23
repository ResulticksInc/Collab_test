# Presenter Mode

Composites a presenter's camera in front of the content they are sharing into a
single outgoing `ScreenShare` stream. One shared implementation for calls, group
calls and meetings; the browser is the reference and Electron inherits it
unchanged (both Chromium) — there is **no** desktop-only code path.

Status: **implemented, reviewed, building green. Not yet live-validated.** The
live QA sign-off below is the gate between "implemented" and "enterprise-grade."

---

## Architecture

```
camera track ─┐
              ├─▶ PresenterProcessor (canvas)  ─▶ processedTrack ─▶ LiveKit ─▶ SFU ─▶ viewers
screen track ─┘   segment · composite · layout      (ScreenShare)
```

- A LiveKit **`Track.Processor`** ([`PresenterProcessor.ts`](../frontend/app/src/lib/presenter/PresenterProcessor.ts))
  is attached to the screen-share `LocalVideoTrack` via `setProcessor()`. It holds
  the camera as a side input, composites per the active layout on a 1280×720
  canvas, and exposes `processedTrack` (a `captureStream`) which LiveKit publishes.
  Remote peers receive **one already-composited stream** and do nothing special.
- **Segmentation** ([`segmentation.ts`](../frontend/app/src/lib/presenter/segmentation.ts)):
  MediaPipe Tasks Vision `ImageSegmenter` (the engine `@livekit/track-processors`
  itself ships). Mask is edge-feathered and temporally smoothed (EMA) to kill
  flicker. Person/background **polarity is auto-detected** (centre-bottom vs
  corners) so it cannot invert across MediaPipe's selfie model variants. GPU
  delegate with CPU fallback. Runtime + model are vendored under
  [`public/mediapipe/`](../frontend/app/public/mediapipe) — no CDN, so it is
  CSP-safe and works offline in Electron.
- **Modes** ([`layouts.ts`](../frontend/app/src/lib/presenter/layouts.ts)): a
  registry — adding a mode is one entry, the pipeline never changes.
  - **Standard** — no processor; raw screen share (today's behavior).
  - **Presenter** — background removed; presenter composited over the content.
  - **Side-by-Side** — content beside a framed camera panel.
  - **Spotlight** — content primary; a small framed camera floats in a corner.
  - Only Presenter needs the model, so the other three run on any hardware and are
    the graceful-degrade targets.
- **Lifecycle** ([`usePresenterMode.ts`](../frontend/app/src/lib/presenter/usePresenterMode.ts)):
  a shared hook. Attaches/updates/detaches the processor, serializes apply(),
  broadcasts the active mode (`t:"presenter"`), and runs a **reconnect watchdog**
  that re-attaches after a full LiveKit reconnect re-publishes the screen track.
- **UI** ([`PresentationModeMenu.tsx`](../frontend/app/src/components/PresentationModeMenu.tsx)):
  the "Presentation mode" selector, shown only while sharing. Non-standard modes
  are disabled unless the camera is on.
- **Layering**: `--z-presenter: 125` (in [`v1.css`](../frontend/app/src/styles/v1.css)) —
  above the whiteboard (5) and dock popovers, below the participant ⋮ menu (2080).

### Performance & auto-degrade

Compositing is **local to the presenter** — zero extra SFU or viewer cost. The
processor measures per-frame cost and scales the segmentation cadence:

| Avg frame cost | Action | Level |
|---|---|---|
| < 24 ms | segment every frame | 0 |
| 30–45 ms | segment every 2nd frame, reuse mask | 1 |
| > 45 ms | segment every 3rd frame | 2 |

If the segmenter can't load (no GPU/model), the segmented mode falls back to the
raw framed camera automatically; the three no-ML modes are unaffected.

---

## Live QA sign-off checklist

Run in a real deployment with ≥2 participants (one presenter P, one viewer V) on
both a browser and the Electron desktop build. Every row must pass before GA.

### 1 · Functional — each mode, both calls and meetings

- [ ] While P shares, the "Presentation mode" selector appears; hidden otherwise.
- [ ] **Standard**: V sees the raw screen. No composite.
- [ ] **Presenter**: V sees P's background removed and composited over the content;
      the silhouette is the **person** (not inverted), edges are clean, no flicker.
- [ ] **Side-by-Side**: content left, full camera panel right; both legible.
- [ ] **Spotlight**: content full; small framed camera floats in the corner.
- [ ] Switching modes mid-share updates V's view within ~1 s, no crash.
- [ ] Non-standard options are disabled when P's camera is off; enabling the
      camera enables them.
- [ ] Identical behavior in a 1:1 call, a group call, and a meeting.
- [ ] While P presents, viewers no longer see P's *separate* camera tile (it is in
      the composite); it reappears when P returns to Standard or stops sharing.
      Late joiners also see it hidden (re-announced on join). Confirm no wrong tile
      is hidden and the grid has no broken gap.

### 2 · Real-time resilience

- [ ] **Reconnect**: drop P's network for ~20 s mid-presentation; on reconnect the
      composite **resumes in the same mode** (watchdog re-attach), not raw share.
- [ ] **Camera device switch** mid-present: composite follows the new camera.
- [ ] **Camera off→on** mid-present: composite shows content-only then resumes.
- [ ] **Screen source switch** (share a different window): composite follows it.
- [ ] **Browser "Stop sharing" bar**: selector disappears, mode resets to Standard,
      processor is torn down (no lingering canvas capture).
- [ ] Two simultaneous presenters in one room each composite independently.

### 3 · Performance (measure `chrome://tracing` or the on-canvas degrade level)

- [ ] 1080p GPU laptop: steady 30 fps, degrade level 0.
- [ ] Low-end / integrated GPU: ≥24 fps; verify it drops to 720p / level 1–2
      rather than dropping frames.
- [ ] Thermal / CPU-only machine: Presenter stays usable or auto-falls-back;
      Side-by-Side / Spotlight remain smooth.
- [ ] Presenter's outbound bitrate stays within the screen-share budget; **screen
      text is legible** on V at the lowest simulcast layer.
- [ ] 30-minute soak: no memory growth on P (processor teardown releases the
      canvas capture, camera/screen video elements, and closes the segmenter).

### 4 · Compatibility (no regressions)

- [ ] **Recording** (client canvas): the composite is captured (it is a published
      tile). Confirm the recording shows the composite, not the raw feeds.
- [ ] **Recording** (egress, if `EGRESS_ENABLED`): confirm the room-composite
      layout includes the composited ScreenShare track.
- [ ] **Whiteboard**: open the board while presenting — no layering conflict; the
      selector popover sits above the board, below the ⋮ menu.
- [ ] **PiP** (dock minimize): entering a non-standard mode does not break the
      minimized dock; restoring full view shows the composite.
- [ ] **Cross-browser**: Chrome/Edge (VP9), Safari (VP8 fallback) — segmentation
      may be CPU-only on Safari; confirm graceful.
- [ ] **Electron**: identical to browser; screen picker unaffected; GPU on.
- [ ] Existing screen-share, camera toggle, mic, reactions, and data-channel
      (whiteboard / hand / rec) all still work with the hook mounted.

### 5 · E2EE (only if/when enabled)

- [ ] With `NEXT_PUBLIC_E2EE_ENABLED`, confirm the composited track encrypts and
      decrypts correctly, or gate Presenter Mode off under E2EE.

---

## Known limitations / deferred

- **Redundant camera tile — handled.** While presenting, P's camera is in the
  composite, so viewers hide P's *separate* camera tile: P broadcasts
  `t:"presenter"`, peers mark that participant's camera tile `data-presenter-hidden`
  and CSS collapses it. Deliberately done **without** touching the two grid-layout
  functions (matched precisely by sid + non-screen + non-local; `display:none`
  drops it from grid flow) — the worst case is a tile that fails to hide, never a
  broken grid. Re-announced on join, cleared on leave / Standard. Still needs the
  live tile-QA row above.
- **Whiteboard-as-direct-input** (composite the camera over the live board canvas
  without screen capture) — architecture supports it; not built.
- **1080p output tier** for text-dense decks — one constant (`PRESENTER_OUT_*`).
- **Rotate / auto-framing / laser pointer / gestures** — future; the processor +
  layout registry and the shared MediaPipe runtime already support them.

## Config

[`types.ts`](../frontend/app/src/lib/presenter/types.ts): `PRESENTER_OUT_W/H`
(default 1280×720), `PRESENTER_FPS` (30), `PRESENTER_ASSET_BASE` (`/mediapipe`).
The vendored assets are the SIMD MediaPipe runtime + the selfie segmenter model;
the no-SIMD fallback was omitted (all targets are SIMD-capable Chromium/modern
browsers) — restore it from `@mediapipe/tasks-vision/wasm` if an old browser must
be supported.
