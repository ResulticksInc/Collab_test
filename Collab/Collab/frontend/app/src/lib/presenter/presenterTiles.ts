// Presenter Mode — receiver-side redundant-tile hide. When a peer is presenting,
// their camera is composited into their ScreenShare, so their SEPARATE camera
// tile is redundant. We mark it with data-presenter-hidden; v1.css collapses it
// with `display:none` (which drops it from grid flow — no layout code touched).
//
// Matching is precise and non-destructive: only a REMOTE, NON-screen tile whose
// data-pid is in the presenting set is ever marked. The screen tile (the actual
// composite) and every other tile are untouched, and nothing is removed — so the
// worst case is a tile that fails to hide, never a broken grid.

export function applyPresenterHidden(
  stage: HTMLElement | null | undefined,
  presentingSids: Set<string>,
): void {
  if (!stage) return;
  try {
    const tiles = stage.querySelectorAll<HTMLElement>("[data-pid]");
    tiles.forEach((t) => {
      const isScreen = t.dataset.screen === "true";
      const isLocal = t.dataset.local === "true";
      // CoLabV1 keys tiles by the bare sid; MeetingStage by "<sid>:<suffix>".
      // Normalize to the base sid (the codebase's own convention) so the match
      // works in both hosts.
      const pid = (t.dataset.pid || "").split(":")[0];
      const hide = !isScreen && !isLocal && !!pid && presentingSids.has(pid);
      if (hide) t.dataset.presenterHidden = "true";
      else if (t.dataset.presenterHidden) delete t.dataset.presenterHidden;
    });
  } catch {
    /* purely cosmetic — never let a hide attempt disturb the call */
  }
}
