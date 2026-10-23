// Which tiles may be RENDERED on a meeting/call stage.
//
// Pure and DOM-free on purpose: both surfaces (MeetingStage and the 1:1/group
// call grid) call it with plain descriptors, and backend/app/test can unit-test
// the invariant directly — the "backend-no-frontend" dependency rule exempts
// test files precisely so a pure frontend helper keeps one source of truth.

export interface StageTileInfo {
  /** Stable tile id (`<sid>:screen` in meetings, the track key in calls). */
  pid: string;
  /** True for a screen-share tile (as opposed to a camera/avatar tile). */
  isScreen: boolean;
  /** True when the tile belongs to the local participant. */
  isLocal: boolean;
}

export interface StageHiddenReasons {
  /** Living in a pop-out window, so it is not on the stage. */
  poppedOut: boolean;
  /** Suppressed by the anti-mirror rule below. */
  mirrorGuard: boolean;
}

/**
 * THE ANTI-MIRROR RULE — why a sharer sees no other share.
 *
 * A "hall of mirrors" is a CYCLE: my captured screen shows your share, and your
 * captured screen shows mine, so each frame contains the previous one forever.
 * Suppressing only your OWN preview (which the tile code already does) breaks
 * the 1-node cycle — you sharing and watching yourself — but not the 2-node one,
 * which is exactly what two people screen-sharing at the same time produced.
 *
 * Every node in such a cycle must be BOTH publishing a screen share AND
 * rendering someone else's. Make one of those impossible and no cycle of ANY
 * length can form: a participant who is sharing renders no remote share, so a
 * sharer can never be a node, so there are no nodes left to form a cycle. That
 * holds for three or more simultaneous presenters too, and regardless of which
 * surface was picked (monitor, window or tab — all three can contain the CoLab
 * window, so none of them is safe to special-case).
 *
 * The cost is bounded: it only applies while YOU are sharing, only to OTHER
 * people's screen shares, and never to cameras (a camera feed cannot contain the
 * stage, so it cannot recurse).
 */
export function hiddenReasons(
  tile: StageTileInfo,
  ctx: { localIsSharing: boolean; poppedOutPids: readonly string[] | Set<string> },
): StageHiddenReasons {
  const popped =
    ctx.poppedOutPids instanceof Set
      ? ctx.poppedOutPids.has(tile.pid)
      : (ctx.poppedOutPids || []).includes(tile.pid);
  return {
    poppedOut: popped,
    mirrorGuard: !!ctx.localIsSharing && tile.isScreen && !tile.isLocal,
  };
}

/** Convenience: may this tile be laid out on the stage at all? */
export function isTileVisible(
  tile: StageTileInfo,
  ctx: { localIsSharing: boolean; poppedOutPids: readonly string[] | Set<string> },
): boolean {
  const r = hiddenReasons(tile, ctx);
  return !r.poppedOut && !r.mirrorGuard;
}

/** True when this participant publishes a screen share of their own. */
export function localIsSharing(tiles: readonly StageTileInfo[]): boolean {
  return tiles.some((t) => t.isScreen && t.isLocal);
}

/**
 * The property the rule buys, stated as code so a test can assert it: across a
 * whole meeting, no participant both shares and renders another share. If that
 * holds for everyone, a mirror cycle is unreachable.
 */
export function participantsThatCouldMirror(
  world: readonly { self: StageTileInfo[]; rendered: StageTileInfo[] }[],
): number {
  let n = 0;
  for (const p of world) {
    const sharing = localIsSharing(p.self);
    const rendersRemoteShare = p.rendered.some(
      (t) => isTileVisible(t, { localIsSharing: sharing, poppedOutPids: [] }) && t.isScreen && !t.isLocal,
    );
    if (sharing && rendersRemoteShare) n++;
  }
  return n;
}
