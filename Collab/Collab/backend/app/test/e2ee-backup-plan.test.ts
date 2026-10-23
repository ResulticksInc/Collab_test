import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeEntries,
  trimToBudget,
  newestTs,
  planRefreshGather,
  reduceRecovery,
  shouldRunRecovery,
  initialRecoveryState,
  type BackupEntry,
} from "../../../frontend/app/src/lib/e2ee/backupPlan";

// Guards the automatic-recovery rework. Three things must hold:
//   • the backup refresh MERGES (never drops what another device contributed,
//     never re-publishes a partial read as the whole backup);
//   • when the backup must shrink to fit, it is the OLDEST that go;
//   • the UI state machine only ever says "exhausted" when the device truly has
//     no key after every automatic source, and recovery runs are throttled.

const e = (msgId: string, ts: string, text = "t", convId = "c1"): BackupEntry => ({
  convId,
  msgId,
  senderDeviceId: "d1",
  ts,
  type: "text",
  text,
});

test("merge keeps everything the server already held and adds what is new", () => {
  const existing = [e("1", "2026-01-01T00:00:00Z"), e("2", "2026-01-02T00:00:00Z")];
  const fresh = [e("3", "2026-01-03T00:00:00Z")];
  const out = mergeEntries(existing, fresh);
  assert.deepEqual(out.map((x) => x.msgId).sort(), ["1", "2", "3"]);
});

test("a fresh entry for the same message REPLACES the old one (edits are carried)", () => {
  const existing = [e("1", "2026-01-01T00:00:00Z", "before")];
  const fresh = [e("1", "2026-01-01T00:00:00Z", "after")];
  const out = mergeEntries(existing, fresh);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "after");
});

test("an EMPTY gather cannot shrink the backup (the old full-replace bug)", () => {
  const existing = [e("1", "2026-01-01T00:00:00Z"), e("2", "2026-01-02T00:00:00Z")];
  assert.equal(mergeEntries(existing, []).length, 2);
});

test("trimming drops the OLDEST first and returns oldest→newest", () => {
  const list = [
    e("new", "2026-03-01T00:00:00Z"),
    e("old", "2026-01-01T00:00:00Z"),
    e("mid", "2026-02-01T00:00:00Z"),
  ];
  const one = JSON.stringify(list[0]).length + 1;
  const out = trimToBudget(list, one * 2 + 1);
  assert.deepEqual(out.map((x) => x.msgId), ["mid", "new"]);
  // No budget → nothing dropped, still ordered.
  assert.deepEqual(trimToBudget(list, 0).map((x) => x.msgId), ["old", "mid", "new"]);
});

test("newestTs is the incremental watermark; junk timestamps don't poison it", () => {
  assert.equal(newestTs([]), 0);
  const list = [e("a", "2026-01-01T00:00:00Z"), e("b", "not a date"), e("c", "2026-05-01T00:00:00Z")];
  assert.equal(newestTs(list), Date.parse("2026-05-01T00:00:00Z"));
});

test("state: a run that ends holding a key is 'done', one that doesn't is 'exhausted'", () => {
  let s = reduceRecovery(initialRecoveryState, { type: "start", at: 10 });
  assert.equal(s.phase, "restoring");
  s = reduceRecovery(s, {
    type: "finish", at: 20, restored: 0, tried: ["cached-key"], keyHeld: true, credentialCouldUnlock: false,
  });
  assert.equal(s.phase, "done");
  s = reduceRecovery(s, { type: "start", at: 30 });
  s = reduceRecovery(s, {
    type: "finish", at: 40, restored: 0, tried: ["keychain", "sibling-bundle"], keyHeld: false, credentialCouldUnlock: true,
  });
  assert.equal(s.phase, "exhausted");
  assert.equal(s.credentialCouldUnlock, true, "the UI may offer exactly one unlock");
  assert.deepEqual(s.tried, ["keychain", "sibling-bundle"]);
});

test("state: merging something counts as progress even without a held key", () => {
  const s = reduceRecovery(reduceRecovery(initialRecoveryState, { type: "start", at: 1 }), {
    type: "finish", at: 2, restored: 12, tried: ["sibling-bundle"], keyHeld: false, credentialCouldUnlock: false,
  });
  assert.equal(s.phase, "done");
  assert.equal(s.restored, 12);
});

test("throttle: never overlaps, forced runs always go, idle runs respect the interval", () => {
  const idle = { ...initialRecoveryState };
  assert.equal(shouldRunRecovery(idle, 1000, { inFlight: true, force: true }), false, "in-flight wins");
  assert.equal(shouldRunRecovery(idle, 1000, { inFlight: false, force: true }), true);
  const finished = reduceRecovery(idle, {
    type: "finish", at: 1000, restored: 0, tried: [], keyHeld: false, credentialCouldUnlock: false,
  });
  assert.equal(shouldRunRecovery(finished, 1000 + 59_000, { inFlight: false }), false, "inside the interval");
  assert.equal(shouldRunRecovery(finished, 1000 + 61_000, { inFlight: false }), true, "past the interval");
  const running = reduceRecovery(idle, { type: "start", at: 1000 });
  assert.equal(shouldRunRecovery(running, 1000 + 999_000, { inFlight: false }), false, "a restoring state never re-enters");
});

// A device contributes its WHOLE readable history to a backup once, then only
// what is newer than the watermark. Resuming from the backup's newest entry on a
// device that had never walked it is how a backup seeded by a key-less device
// stayed partial forever while the user's other devices could read everything.
test("gather plan: a device that never walked this backup walks everything, even when the backup has entries", () => {
  const plan = planRefreshGather({ fullWalkSalt: null, backupSalt: "s1", watermark: 500, existingNewest: 900 });
  assert.deepEqual(plan, { allTime: true, sinceTs: 0 });
});

test("gather plan: after the full walk, gathers resume from THIS device's own watermark — never the backup's newest entry", () => {
  // Another device contributed an entry at 900 without holding what this device
  // read between 500 and 900; resuming from 900 would skip that forever.
  assert.deepEqual(
    planRefreshGather({ fullWalkSalt: "s1", backupSalt: "s1", watermark: 500, existingNewest: 900 }),
    { allTime: false, sinceTs: 500 },
  );
  assert.deepEqual(
    planRefreshGather({ fullWalkSalt: "s1", backupSalt: "s1", watermark: 1200, existingNewest: 900 }),
    { allTime: false, sinceTs: 1200 },
  );
});

test("gather plan: a rotated backup (new salt) is walked in full again; an empty one is walked in full", () => {
  assert.deepEqual(
    planRefreshGather({ fullWalkSalt: "s1", backupSalt: "s2", watermark: 500, existingNewest: 900 }),
    { allTime: true, sinceTs: 0 },
  );
  assert.deepEqual(
    planRefreshGather({ fullWalkSalt: "s1", backupSalt: "s1", watermark: 0, existingNewest: 0 }),
    { allTime: true, sinceTs: 0 },
  );
});

test("state: a run that could not REACH a source is not exhausted — it goes back to idle for a retry", () => {
  const s = reduceRecovery(reduceRecovery(initialRecoveryState, { type: "start", at: 1 }), {
    type: "finish", at: 2, restored: 0, tried: ["account-key"], keyHeld: false, credentialCouldUnlock: false, transient: true,
  });
  assert.equal(s.phase, "idle", "rate-limited / 5xx / offline proves nothing");
  // ...and a run that held a key is still "done" even if some call was transient.
  const held = reduceRecovery(reduceRecovery(s, { type: "start", at: 3 }), {
    type: "finish", at: 4, restored: 0, tried: ["cached-key"], keyHeld: true, credentialCouldUnlock: false, transient: true,
  });
  assert.equal(held.phase, "done");
});
