// Shared VIEW behaviour for meetings (MeetingStage) and calls (useCallSessionMedia).
// Both build their tiles imperatively and lay them out in one "relayout" pass;
// everything here is DOM-level and surface-agnostic so the two cannot drift.
//
//   • prefs        — per-user view preferences, remembered across sessions
//   • tileRank     — who comes first (gallery pages, rail)
//   • layoutRail   — the in-stage thumbnail RAIL beside the main tile(s)
//   • pip corners  — the self-view can be dragged to any corner
//   • tile badges  — raised hand / reaction shown ON the person's tile

// ── Preferences ──────────────────────────────────────────────────────────────
export type PipCorner = "br" | "bl" | "tr" | "tl";
export type StageViewPrefs = {
  /** Hide everyone but the main tile(s) — the old behaviour, now a choice. */
  focusContent: boolean;
  /** Leave camera-off participants out of the stage (they stay in People). */
  hideNoVideo: boolean;
  /** Don't show my own camera preview (others still see me). */
  hideSelf: boolean;
  pipCorner: PipCorner;
};
const PREFS_KEY = "clb_stage_view";
const DEFAULT_PREFS: StageViewPrefs = {
  focusContent: false,
  hideNoVideo: false,
  hideSelf: false,
  pipCorner: "br",
};
export function loadStageViewPrefs(): StageViewPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
    return {
      focusContent: !!raw.focusContent,
      hideNoVideo: !!raw.hideNoVideo,
      hideSelf: !!raw.hideSelf,
      pipCorner: ["br", "bl", "tr", "tl"].includes(raw.pipCorner) ? raw.pipCorner : "br",
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}
export function saveStageViewPrefs(p: StageViewPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode — preference just won't persist */
  }
}

// ── Call layouts ─────────────────────────────────────────────────────────────
// Per-viewer stage layout for calls (VIEW-03/06/07): chosen from the dock,
// switchable mid-call, remembered as the default for the next call. Speaker
// view is the default. The layout only changes where tiles are POSITIONED —
// no tile is re-parented, so audio/video never pause on a switch (VIEW-28).
export type CallLayout = "speaker" | "speaker-bottom" | "gallery" | "focus";
export const CALL_LAYOUTS: { id: CallLayout; label: string; hint: string }[] = [
  { id: "speaker", label: "Speaker view", hint: "Active speaker large, everyone else in a strip on the right" },
  { id: "speaker-bottom", label: "Speaker · bottom strip", hint: "Active speaker large, everyone else in a strip along the bottom" },
  { id: "gallery", label: "Gallery view", hint: "Everyone in an equal grid" },
  { id: "focus", label: "Focus view", hint: "Only the active speaker or shared content — no strip" },
];
const CALL_LAYOUT_KEY = "clb_call_layout";
export const MEETING_LAYOUT_KEY = "clb_meeting_layout"; // meetings remember their own
export function isCallLayout(v: unknown): v is CallLayout {
  return CALL_LAYOUTS.some((l) => l.id === v);
}
export function callLayoutLabel(l: CallLayout): string {
  return (CALL_LAYOUTS.find((x) => x.id === l) || CALL_LAYOUTS[0]).label;
}
export function loadCallLayout(key: string = CALL_LAYOUT_KEY): CallLayout {
  try {
    const raw = localStorage.getItem(key);
    if (isCallLayout(raw)) return raw;
    // Older call builds remembered only gallery|speaker under another key;
    // honour an explicit Gallery choice, everything else starts on Speaker.
    if (key === CALL_LAYOUT_KEY && localStorage.getItem("clb_call_view_mode") === "gallery")
      return "gallery";
  } catch {
    /* private mode */
  }
  return "speaker";
}
export function saveCallLayout(l: CallLayout, key: string = CALL_LAYOUT_KEY): void {
  try {
    localStorage.setItem(key, l);
  } catch {
    /* preference just won't persist */
  }
}
/** Which edge the thumbnail strip rides for a layout. */
export function railSideFor(l: CallLayout): RailSide {
  return l === "speaker-bottom" ? "bottom" : "right";
}

// ── Ordering ─────────────────────────────────────────────────────────────────
// Lower = earlier. Deliberately built from SLOW-changing facts (sharing, pinned,
// hand up, camera on) so tiles don't reshuffle every time someone speaks; the
// live speaker only leads the RAIL, where a moving thumbnail is expected.
export type RankCtx = {
  pinned: (pid: string) => boolean;
  handRaised: (tile: HTMLElement) => boolean;
  speakerPid?: string | null;
};
export function tileHasVideo(t: HTMLElement): boolean {
  return !!t.querySelector("video");
}
export function galleryRank(t: HTMLElement, ctx: RankCtx): number {
  if (t.dataset.screen === "true") return 0;
  if (t.dataset.local === "true" || ctx.pinned(t.dataset.pid || "")) return 1;
  if (ctx.handRaised(t)) return 2;
  if (tileHasVideo(t)) return 3;
  return 4;
}
export function railRank(t: HTMLElement, ctx: RankCtx): number {
  if (ctx.speakerPid && t.dataset.pid === ctx.speakerPid) return 0;
  return 1 + galleryRank(t, ctx);
}
export function sortByRank<T>(items: T[], rank: (t: T) => number): T[] {
  return items
    .map((item, i) => ({ item, i, r: rank(item) }))
    .sort((a, b) => a.r - b.r || a.i - b.i) // stable
    .map((x) => x.item);
}

// ── Rail ─────────────────────────────────────────────────────────────────────
// The people who are NOT the main tile ride a vertical thumbnail rail on the
// right edge, INSIDE the stage (never a row under it, never relocated into the
// People panel). Tiles stay direct children of the stage — they are positioned
// absolutely rather than re-parented, because moving a playing <video> between
// parents pauses it on some engines.
export const RAIL_MIN_STAGE_W = 640; // below this there's no room for a side rail
// Bottom strip: with the 60px header + 96px dock a short window drops the stage
// under 360px quickly, and hiding EVERYONE (no strip, no "+N" chip) is far worse
// than a smaller strip — so the floor accepts a stage down to 220px (64px
// thumbnails) and, below that, falls back to the side rail when width allows.
export const RAIL_MIN_STAGE_H = 220;
const RAIL_GAP = 8;
export type RailSide = "right" | "bottom";

export function railWidthFor(stageW: number): number {
  return stageW >= 1200 ? 200 : stageW >= 900 ? 168 : 136;
}
/** Thumbnail height for a BOTTOM strip (16:9 tiles along the stage floor). */
export function railHeightFor(stageH: number): number {
  return stageH >= 800 ? 112 : stageH >= 560 ? 96 : stageH >= 360 ? 80 : 64;
}

/** Undo everything layoutRail did to a tile. */
export function clearRailTile(t: HTMLElement): void {
  if (t.dataset.rail !== "true") return;
  delete t.dataset.rail;
  t.classList.remove("stage-rail-tile");
  t.style.position = "";
  t.style.top = "";
  t.style.right = "";
  t.style.left = "";
  t.style.bottom = "";
  t.style.width = "";
  t.style.height = "";
}

/**
 * Place `railTiles` (already ordered) along one stage edge — down the right
 * (default) or across the bottom (`side: "bottom"`). Returns how many fit and
 * how many were left over (the caller hides those). Pass an empty list to
 * remove the rail. Tiles are positioned, never re-parented (video keeps playing).
 */
/** The stage's reserved SIDE band (right rail width + gap + inset), published
 *  on the call/meeting root as --stage-rail-band so fixed-positioned overlays
 *  (reaction picker, muted prompt) can centre on the MAIN tile, not the whole
 *  width. 0 when there's no side rail (bottom strip / no rail). */
function publishRailBand(stage: HTMLElement, px: number): void {
  const root = stage.closest(".ms-wrap, [data-call-view]") as HTMLElement | null;
  // Fold in the panel's own reservation (--panel-band, from .panel-open) so
  // overlays centred on --stage-rail-band (the reaction picker, the muted
  // prompt) stay centred on the visible video even when a rail's caller
  // publishes its own band as 0 (no rail — the panel-open CSS class still
  // reserves real width via padding-right, just not through this function).
  const panelBand = parseFloat(getComputedStyle(stage).getPropertyValue("--panel-band")) || 0;
  const band = Math.max(px, panelBand);
  (root || stage).style.setProperty("--stage-rail-band", Math.max(0, Math.round(band)) + "px");
}

export function layoutRail(
  stage: HTMLElement,
  railTiles: HTMLElement[],
  opts: { side?: RailSide; __fallback?: boolean } = {},
): { shown: HTMLElement[]; overflow: HTMLElement[] } {
  const side: RailSide = opts.side || "right";
  let chip = stage.querySelector(":scope > .stage-rail-more") as HTMLElement | null;
  // Rail tiles are positioned absolutely, so they must copy the stage's OWN
  // insets: the main tile sits at the stage's padding edge, and the rail must
  // share the same top/outer margin and the same gap the grid uses between
  // tiles — otherwise the thumbnail column starts a few px lower and further
  // out than the main tile (visibly uneven). Read them from the SHEET: this
  // function writes its own inline padding-right / padding-bottom (the rail's
  // reserved band), so those must be cleared first or every relayout would
  // read back the previous pass's band as the "inset" and grow it without
  // bound (the bottom strip ate the whole stage that way).
  stage.style.paddingRight = "";
  stage.style.paddingBottom = "";
  const cs = getComputedStyle(stage);
  const rect = stage.getBoundingClientRect();
  const num = (v: string) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : 0);
  const padT = num(cs.paddingTop);
  const padL = num(cs.paddingLeft);
  const padB = num(cs.paddingBottom);
  const gap = Math.max(RAIL_GAP, num(cs.columnGap || cs.gap));
  const noRoom = side === "bottom" ? rect.height < RAIL_MIN_STAGE_H : rect.width < RAIL_MIN_STAGE_W;
  // No room on the requested edge but room on the other one → use that edge
  // rather than hiding the participants (each edge is tried at most once).
  if (railTiles.length && noRoom && !opts.__fallback) {
    const other: RailSide = side === "bottom" ? "right" : "bottom";
    const otherOk = other === "bottom" ? rect.height >= RAIL_MIN_STAGE_H : rect.width >= RAIL_MIN_STAGE_W;
    if (otherOk) return layoutRail(stage, railTiles, { side: other, __fallback: true });
  }
  if (!railTiles.length || noRoom) {
    publishRailBand(stage, 0);
    stage.classList.remove("has-rail", "has-rail-bottom");
    stage.style.removeProperty("--rail-w");
    stage.style.removeProperty("--rail-h");
    stage.style.paddingRight = "";
    stage.style.paddingBottom = "";
    if (chip) chip.remove();
    return { shown: [], overflow: railTiles };
  }
  const ensureChip = () => {
    if (!chip) {
      chip = document.createElement("div");
      chip.className = "stage-rail-more";
      stage.appendChild(chip);
    }
    return chip;
  };
  if (side === "bottom") {
    const h = railHeightFor(rect.height);
    const w = Math.round((h * 16) / 9);
    const inner = Math.max(0, rect.width - padL * 2);
    let fit = Math.max(1, Math.floor((inner + gap) / (w + gap)));
    const needChip = railTiles.length > fit;
    if (needChip) fit = Math.max(1, fit - 1);
    const shown = railTiles.slice(0, fit);
    const overflow = railTiles.slice(fit);
    const slots = shown.length + (needChip ? 1 : 0);
    const total = slots * (w + gap) - gap;
    const startX = Math.max(padL, Math.round((rect.width - total) / 2)); // centred strip
    const inset = padB || padL;
    publishRailBand(stage, 0);
    stage.classList.add("has-rail", "has-rail-bottom");
    stage.style.removeProperty("--rail-w");
    stage.style.setProperty("--rail-h", h + "px");
    stage.style.paddingRight = "";
    stage.style.paddingBottom = h + gap + inset + "px";
    shown.forEach((t, i) => {
      t.dataset.rail = "true";
      t.classList.add("stage-rail-tile");
      t.style.position = "absolute";
      t.style.top = "";
      t.style.right = "";
      t.style.bottom = inset + "px";
      t.style.left = startX + i * (w + gap) + "px";
      t.style.width = w + "px";
      t.style.height = h + "px";
    });
    if (needChip) {
      const c = ensureChip();
      c.textContent = "+" + overflow.length;
      c.title = overflow.length + " more — see People";
      c.style.top = "";
      c.style.right = "auto";
      c.style.bottom = inset + "px";
      c.style.left = startX + shown.length * (w + gap) + "px";
      c.style.width = w + "px";
      c.style.height = h + "px";
    } else if (chip) {
      chip.remove();
    }
    return { shown, overflow };
  }
  const w = railWidthFor(rect.width);
  const h = Math.round((w * 9) / 16);
  const inner = Math.max(0, rect.height - padT - padB);
  let fit = Math.max(1, Math.floor((inner + gap) / (h + gap)));
  // Keep the last slot for the "+N" chip when not everyone fits.
  const needChip = railTiles.length > fit;
  if (needChip) fit = Math.max(1, fit - 1);
  const shown = railTiles.slice(0, fit);
  const overflow = railTiles.slice(fit);

  stage.classList.add("has-rail");
  stage.classList.remove("has-rail-bottom");
  stage.style.setProperty("--rail-w", w + "px");
  stage.style.removeProperty("--rail-h");
  stage.style.paddingBottom = "";
  // NOTE on --panel-band: when the Chat/People panel is open, the STAGE'S
  // OWN box (`rect`, read above) is ALREADY narrowed to exclude it — the call
  // view's wrapper applies its own paddingRight, and the meeting stage is a
  // real flex sibling of the panel — in BOTH cases before this function ever
  // runs. So the rail's own placement inside the stage needs nothing extra
  // for the panel; adding panelBand here too DOUBLE-reserves it and leaves a
  // dead gap between the rail thumbnail and the (already-narrowed) panel.
  // panelBand is still folded into --stage-rail-band below: that variable is
  // for VIEWPORT-relative fixed overlays (reaction picker, muted-mic toast,
  // now portaled to <body>) that sit OUTSIDE the narrowed stage entirely and
  // so need the FULL combined reservation to clear both the rail and panel.
  const panelBand =
    parseFloat(getComputedStyle(stage).getPropertyValue("--panel-band")) || 0;
  // Column = rail width + the grid gap + the same outer inset as the left edge.
  stage.style.paddingRight = w + gap + padL + "px";
  publishRailBand(stage, w + gap + padL + panelBand);
  shown.forEach((t, i) => {
    t.dataset.rail = "true";
    t.classList.add("stage-rail-tile");
    t.style.position = "absolute";
    t.style.left = "";
    t.style.bottom = "";
    t.style.right = padL + "px";
    t.style.top = padT + i * (h + gap) + "px";
    t.style.width = w + "px";
    t.style.height = h + "px";
  });
  if (needChip) {
    const c = ensureChip();
    c.textContent = "+" + overflow.length;
    c.title = overflow.length + " more — see People";
    c.style.left = "";
    c.style.bottom = "";
    c.style.right = padL + "px";
    c.style.height = "";
    c.style.top = padT + shown.length * (h + gap) + "px";
    c.style.width = w + "px";
  } else if (chip) {
    chip.remove();
  }
  return { shown, overflow };
}

// ── Self-view corner drag ────────────────────────────────────────────────────
/**
 * Make the self-view draggable; on release it snaps to the nearest stage corner.
 * A press that barely moves is still a TAP (the tile's own onclick — tap-to-swap
 * — keeps working); a real drag swallows the click it would otherwise produce.
 * Idempotent per tile. Returns nothing: the listeners live and die with the tile.
 */
export function enablePipDrag(
  tile: HTMLElement,
  getStage: () => HTMLElement | null,
  onCorner: (c: PipCorner) => void,
): void {
  if ((tile as any).__pipDrag) return;
  (tile as any).__pipDrag = true;
  let start: { x: number; y: number; left: number; top: number } | null = null;
  let dragged = false;

  tile.addEventListener("pointerdown", (e: PointerEvent) => {
    if (tile.dataset.pip !== "true" || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return; // tile buttons stay clickable
    const stage = getStage();
    if (!stage) return;
    const tr = tile.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: tr.left - sr.left, top: tr.top - sr.top };
    dragged = false;
    try { tile.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });
  tile.addEventListener("pointermove", (e: PointerEvent) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!dragged && Math.hypot(dx, dy) < 6) return;
    const stage = getStage();
    if (!stage) return;
    dragged = true;
    tile.classList.add("pip-dragging");
    const sr = stage.getBoundingClientRect();
    const maxL = Math.max(0, sr.width - tile.offsetWidth);
    const maxT = Math.max(0, sr.height - tile.offsetHeight);
    tile.style.left = Math.min(maxL, Math.max(0, start.left + dx)) + "px";
    tile.style.top = Math.min(maxT, Math.max(0, start.top + dy)) + "px";
    tile.style.right = "auto";
    tile.style.bottom = "auto";
  });
  const end = () => {
    if (!start) return;
    start = null;
    if (!dragged) return;
    const stage = getStage();
    tile.classList.remove("pip-dragging");
    if (stage) {
      const sr = stage.getBoundingClientRect();
      const tr = tile.getBoundingClientRect();
      const right = tr.left + tr.width / 2 - sr.left > sr.width / 2;
      const bottom = tr.top + tr.height / 2 - sr.top > sr.height / 2;
      onCorner(((bottom ? "b" : "t") + (right ? "r" : "l")) as PipCorner);
    }
    tile.style.left = "";
    tile.style.top = "";
    tile.style.right = "";
    tile.style.bottom = "";
  };
  tile.addEventListener("pointerup", end);
  tile.addEventListener("pointercancel", end);
  // A drag ends in a click event on release — swallow it so dropping the
  // self-view doesn't also trigger tap-to-swap.
  tile.addEventListener(
    "click",
    (e) => {
      if (!dragged) return;
      dragged = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
}

// ── Camera aspect fit (mobile/web parity) ───────────────────────────────────
// A camera tile is always object-fit COVER by default — a face reads fine
// cropped. But a PORTRAIT capture (a phone held upright) rendered with cover
// inside a LANDSCAPE tile (a 1:1 call's full-bleed remote tile, a meeting's
// speaker focal tile, a rail/PiP thumbnail) scales up by the video's WIDTH to
// cover the box, which crops away most of the frame's HEIGHT — the mobile
// participant's face reads as blown up disproportionately large next to a
// landscape webcam feed in an identically-sized tile. Detecting that
// orientation mismatch and switching just that tile to CONTAIN (letterboxed,
// full frame visible, same neutral tile background as a screen share already
// uses) keeps every participant's video reading at a consistent, proportionate
// size regardless of which device captured it or which device is viewing it.
// Only how the video paints INSIDE its box changes — the box itself (grid
// cell, rail slot, PiP corner) is untouched, so layout/paging/pin/spotlight
// are unaffected. Screen shares never go through this — they hardcode contain.
function aspectOrientation(ratio: number): -1 | 0 | 1 {
  if (ratio > 1.1) return 1; // landscape
  if (ratio < 0.9) return -1; // portrait
  return 0; // near-square — never forced into a mismatch
}
// A portrait feed (phone) letterboxed in a landscape tile would leave black
// bars either side. Instead of bare bars, paint a BLURRED copy of the same
// stream behind the contained video (the Teams/Meet treatment): a second
// <video> on the same MediaStream (one decode, two paints), object-fit cover,
// heavy blur + dim, inserted BEFORE the real video so it sits behind it.
function syncBlurBackdrop(el: HTMLVideoElement, on: boolean): void {
  const parent = el.parentElement;
  if (!parent) return;
  let bg = parent.querySelector(":scope > .vid-blur-bg") as HTMLVideoElement | null;
  if (!on) {
    if (bg) {
      try { bg.srcObject = null; } catch { /* ignore */ }
      bg.remove();
    }
    return;
  }
  if (!bg) {
    bg = document.createElement("video");
    bg.className = "vid-blur-bg";
    bg.muted = true;
    bg.autoplay = true;
    bg.playsInline = true;
    bg.setAttribute("aria-hidden", "true");
    parent.insertBefore(bg, el);
    // The real video is detached when the track ends / the camera goes off —
    // drop the backdrop with it, or a frozen blur would linger under the avatar.
    const mo = new MutationObserver(() => {
      if (!el.isConnected) {
        syncBlurBackdrop(el, false);
        mo.disconnect();
      }
    });
    mo.observe(parent, { childList: true });
  }
  if (bg.srcObject !== el.srcObject) {
    bg.srcObject = el.srcObject;
    bg.play().catch(() => { /* autoplay policy — muted, so normally fine */ });
  }
}

export function attachAdaptiveVideoFit(el: HTMLVideoElement): void {
  if ((el as any).__adaptiveFit) return;
  (el as any).__adaptiveFit = true;
  const update = () => {
    const vw = el.videoWidth, vh = el.videoHeight;
    const bw = el.clientWidth, bh = el.clientHeight;
    if (!vw || !vh || !bw || !bh) return;
    const srcO = aspectOrientation(vw / vh);
    const boxO = aspectOrientation(bw / bh);
    const mismatched = srcO !== 0 && boxO !== 0 && srcO !== boxO;
    // Same orientation → COVER (fills the tile, no bars). Mismatch (a phone's
    // portrait feed in a landscape tile) → CONTAIN over a blurred backdrop.
    el.style.objectFit = mismatched ? "contain" : "cover";
    syncBlurBackdrop(el, mismatched);
  };
  // 'loadedmetadata' — the source's real dimensions are known.
  // 'resize' — a <video> event that fires when its intrinsic size changes
  // (camera switch, device rotation re-publishing a different orientation).
  el.addEventListener("loadedmetadata", update);
  el.addEventListener("resize", update);
  // The tile's own box changes on every relayout (layout switch, pin, window
  // resize, fullscreen, PiP) — re-evaluate whenever the element's rendered
  // size changes, since object-fit's correctness depends on BOTH sides.
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(update);
    ro.observe(el);
  }
  update();
}

// ── Active speaker ───────────────────────────────────────────────────────────
/**
 * Mark a person's tile as SPEAKING: a pulsing accent glow on the tile border and
 * an animated sound-wave under the avatar (CSS shows the wave only while the tile
 * is showing an avatar, i.e. camera off — over live video the glow alone reads
 * best). The wave element is created once per tile, on first use. Shared by
 * calls (.cv-tile) and meetings (.ms-tile). Never for screen-share tiles.
 */
export function setTileSpeaking(tile: HTMLElement, on: boolean): void {
  if (tile.dataset.screen === "true") on = false;
  if (on && !tile.querySelector(":scope > .tile-wave")) {
    const wave = document.createElement("div");
    wave.className = "tile-wave";
    wave.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 5; i++) wave.appendChild(document.createElement("span"));
    tile.appendChild(wave);
  }
  tile.classList.toggle("tile-speaking", on);
}

// ── Tile badges ──────────────────────────────────────────────────────────────
/** Raised-hand badge on the person's own tile (top-left). */
export function setTileHand(tile: HTMLElement, raised: boolean): void {
  let b = tile.querySelector(":scope > .tile-hand-badge") as HTMLElement | null;
  if (!raised) {
    if (b) b.remove();
    return;
  }
  if (b) return;
  b = document.createElement("div");
  b.className = "tile-hand-badge";
  b.title = "Hand raised";
  b.setAttribute("aria-label", "Hand raised");
  b.textContent = "✋";
  tile.appendChild(b);
}

/** Pop a reaction emoji on the sender's tile for a few seconds. */
export function flashTileReaction(tile: HTMLElement, emoji: string, ms = 3500): void {
  const old = tile.querySelector(":scope > .tile-reaction") as HTMLElement | null;
  if (old) old.remove();
  const el = document.createElement("div");
  el.className = "tile-reaction";
  el.textContent = emoji;
  el.setAttribute("aria-hidden", "true");
  tile.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
