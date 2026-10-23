// Participant-grid geometry, shared by BOTH the meeting stage (MeetingStage) and
// the call grid (CoLabV1 sizeGrid) so calls and meetings lay out identically —
// there is no "meeting grid" and "call grid", only this.
//
// CEO CHANGE: a partial last row no longer STRETCHES to fill the empty cells.
// Previously n=3 in a 2×2 grid made the third tile span the whole bottom row, so
// one person's tile was twice the size of everyone else's. Now every tile is the
// SAME size and a partial row is CENTRED, leaving equal dead space left and
// right. n=4 fills the 2×2 exactly, n=5 centres 1 under a full row of… etc — the
// adaptation stays dynamic, only the stretch is gone.
//
// Centring needs half-column precision: 1 tile under 2 columns has to start at
// "column 1.5", which whole column tracks cannot express. So the template lays
// down TWO tracks per visual column and every tile spans 2. A partial row then
// starts at an odd track offset and lands exactly centred, at any cols/count.
// (The `gap` between the two tracks a tile spans falls INSIDE that tile, so all
// tiles still measure the same — the extra tracks change nothing visually.)
export function applyTileGrid(
  container: HTMLElement,
  cols: number,
  rows: number,
): void {
  container.style.gridTemplateColumns = `repeat(${cols * 2}, minmax(0, 1fr))`;
  container.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

  // Only real participant tiles (dataset.pid) that are actually laid out — tiles
  // hidden via a class (`.ms-tile-railed` / `.ms-tile-paged-out`, both
  // `display:none`) have a null offsetParent, so this excludes them without
  // depending on the inline style attribute. The self-view PiP (data-pip="true")
  // is absolutely positioned out of flow and never occupies a grid cell, so it
  // is excluded here too — otherwise the partial-last-row centring counts one
  // tile too many and offsets the wrong tile.
  const tiles = Array.from(container.children).filter(
    (c): c is HTMLElement =>
      c instanceof HTMLElement &&
      !!c.dataset.pid &&
      c.dataset.pip !== "true" &&
      c.dataset.rail !== "true" && // rail thumbnails are out of flow too (lib/stageView)
      c.offsetParent !== null,
  );
  // Reset every tile first, so a SHRINKING participant count can never leave a
  // stale offset behind on a tile that is no longer on the last row.
  for (const t of tiles) t.style.gridColumn = "span 2";
  if (cols <= 1 || rows <= 1) return;

  const n = tiles.length;
  const lastCount = n - (rows - 1) * cols; // tiles on the final row
  if (lastCount <= 0 || lastCount >= cols) return; // full row → nothing to centre

  // Half of the empty visual columns, expressed in the doubled tracks, +1 for
  // CSS's 1-based lines. cols=2/last=1 → track 2 of 4; cols=3/last=2 → track 2
  // of 6; cols=4/last=2 → track 3 of 8. Always an integer, always centred.
  const startTrack = cols - lastCount + 1;
  // Only the FIRST tile of the row is placed; the rest auto-flow after it. The
  // preceding rows are exactly full, so this row can't back-fill into them.
  tiles[n - lastCount].style.gridColumn = `${startTrack} / span 2`;
}
