import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hiddenReasons,
  isTileVisible,
  localIsSharing,
  participantsThatCouldMirror,
} from "../../../frontend/app/src/lib/stageVisibility";

// Guards the screen-share "hall of mirrors": two people sharing at once, each
// rendering the other, recursed forever (reported with a screenshot of the
// nested stages). The fix is structural — a participant who is sharing renders
// no remote share — so these tests assert the INVARIANT, not the pixels.

const camera = (pid: string, isLocal = false) => ({ pid, isScreen: false, isLocal });
const share = (pid: string, isLocal = false) => ({ pid, isScreen: true, isLocal });

test("a viewer who is NOT sharing sees every remote share", () => {
  const ctx = { localIsSharing: false, poppedOutPids: [] as string[] };
  assert.equal(isTileVisible(share("a:screen"), ctx), true);
  assert.equal(isTileVisible(share("b:screen"), ctx), true);
  assert.equal(isTileVisible(camera("c"), ctx), true);
});

test("while sharing, remote screen shares are suppressed", () => {
  const ctx = { localIsSharing: true, poppedOutPids: [] as string[] };
  assert.equal(isTileVisible(share("a:screen"), ctx), false);
  assert.equal(hiddenReasons(share("a:screen"), ctx).mirrorGuard, true);
});

test("while sharing, CAMERAS are untouched — they cannot recurse", () => {
  const ctx = { localIsSharing: true, poppedOutPids: [] as string[] };
  assert.equal(isTileVisible(camera("a"), ctx), true);
  assert.equal(isTileVisible(camera("b"), ctx), true);
});

test("your own share tile is not suppressed by the guard", () => {
  // It is hidden by the tile code (which renders a placeholder instead), not by
  // this rule — the rule must not claim a reason that is not its own.
  const ctx = { localIsSharing: true, poppedOutPids: [] as string[] };
  assert.equal(hiddenReasons(share("me:screen", true), ctx).mirrorGuard, false);
});

test("popping out and the mirror guard are independent reasons", () => {
  const r = hiddenReasons(share("a:screen"), {
    localIsSharing: true,
    poppedOutPids: ["a:screen"],
  });
  assert.deepEqual(r, { poppedOut: true, mirrorGuard: true });
  const r2 = hiddenReasons(share("a:screen"), {
    localIsSharing: false,
    poppedOutPids: ["a:screen"],
  });
  assert.deepEqual(r2, { poppedOut: true, mirrorGuard: false });
});

test("poppedOutPids accepts a Set as well as an array", () => {
  const ctx = { localIsSharing: false, poppedOutPids: new Set(["a:screen"]) };
  assert.equal(isTileVisible(share("a:screen"), ctx), false);
  assert.equal(isTileVisible(share("b:screen"), ctx), true);
});

test("localIsSharing keys off the LOCAL screen tile only", () => {
  assert.equal(localIsSharing([camera("me", true), share("a:screen")]), false);
  assert.equal(localIsSharing([camera("me", true), share("me:screen", true)]), true);
});

test("TWO simultaneous sharers cannot mirror each other", () => {
  // The exact reported case: A and B both share; each has the other's share
  // tile on their stage. Before the rule, both rendered it and recursed.
  const A = { self: [camera("a", true), share("a:screen", true)], rendered: [share("b:screen"), camera("b")] };
  const B = { self: [camera("b", true), share("b:screen", true)], rendered: [share("a:screen"), camera("a")] };
  assert.equal(participantsThatCouldMirror([A, B]), 0);
});

test("THREE simultaneous sharers cannot mirror either", () => {
  const mk = (me: string, others: string[]) => ({
    self: [camera(me, true), share(me + ":screen", true)],
    rendered: others.flatMap((o) => [share(o + ":screen"), camera(o)]),
  });
  const world = [mk("a", ["b", "c"]), mk("b", ["a", "c"]), mk("c", ["a", "b"])];
  assert.equal(participantsThatCouldMirror(world), 0);
});

test("a non-sharing observer of two sharers is NOT a mirror risk", () => {
  // C watches both shares. C's screen is not captured by anyone, so no cycle —
  // and the rule must not cost C anything.
  const C = { self: [camera("c", true)], rendered: [share("a:screen"), share("b:screen")] };
  assert.equal(participantsThatCouldMirror([C]), 0);
  const ctx = { localIsSharing: localIsSharing(C.self), poppedOutPids: [] as string[] };
  assert.equal(isTileVisible(share("a:screen"), ctx), true);
  assert.equal(isTileVisible(share("b:screen"), ctx), true);
});
