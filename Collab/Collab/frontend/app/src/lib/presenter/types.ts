// Presenter Mode — shared vocabulary for the calls / group-calls / meetings
// presentation-composition feature. One implementation, consumed identically by
// CoLabV1 (calls) and MeetingStage (meetings); no Electron-specific branches.
//
// The composite is produced entirely on the presenter's device and published as
// the ordinary ScreenShare track, so remote peers need no awareness of it.

export type PresenterMode = "standard" | "presenter" | "sidebyside" | "spotlight";

export interface PresenterModeDef {
  id: PresenterMode;
  label: string;
  hint: string;
  /** Non-standard modes composite the camera and therefore require it to be on. */
  needsCamera: boolean;
  /** Only "presenter" removes the background (needs the segmentation model). */
  segmented: boolean;
}

// Registry order = order shown in the selector. Adding a future mode is a single
// entry here + a `layoutFor()` case — the capture / composite / publish pipeline
// never changes.
export const PRESENTER_MODES: PresenterModeDef[] = [
  {
    id: "standard",
    label: "Standard",
    hint: "Share your screen exactly as it is.",
    needsCamera: false,
    segmented: false,
  },
  // NOTE: the "presenter" mode (segmented camera-over-content, background removed
  // via MediaPipe) is intentionally omitted from the selector for now — the other
  // views stay. The type + processor path remain, so re-adding it is one entry.
  {
    id: "sidebyside",
    label: "Side-by-Side",
    hint: "Your content beside your camera.",
    needsCamera: true,
    segmented: false,
  },
  {
    id: "spotlight",
    label: "Spotlight",
    hint: "Content stays big; you float in a corner.",
    needsCamera: true,
    segmented: false,
  },
];

export function modeDef(mode: PresenterMode): PresenterModeDef {
  return PRESENTER_MODES.find((m) => m.id === mode) || PRESENTER_MODES[0];
}

// Data-channel signal a presenter broadcasts when they change layout. Peers may
// use it later (badge / hide the now-redundant camera tile); the composite works
// without anyone consuming it. Shares the existing `publishData` op-log; the tag
// slots alongside the reserved wb / react / hand / rec / rc tags.
export interface PresenterSignal {
  t: "presenter";
  mode: PresenterMode;
}

// Output canvas. 1280×720 is the safe default — crisp enough for most decks while
// leaving per-frame headroom for segmentation + the encoder. Bump to 1920×1080
// for text-dense content on capable hardware.
export const PRESENTER_OUT_W = 1280;
export const PRESENTER_OUT_H = 720;
export const PRESENTER_FPS = 30;

// Where the bundled MediaPipe runtime + model live (served from /public).
export const PRESENTER_ASSET_BASE = "/mediapipe";
