import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recoveryPathsOf,
  createRecoveryPathsCache,
} from "../../../frontend/app/src/lib/e2ee/recoveryPaths";

// Guards the "Message unavailable on this device" fix. Two things must hold:
// the verdict must only say "terminal" when the key really exists nowhere, and
// the shared cache must not turn one bad thread into hundreds of API calls.

test("a backup alone makes a message recoverable", () => {
  const r = recoveryPathsOf(true, 0);
  assert.equal(r.recoverable, true);
});

test("a sibling device alone makes a message recoverable", () => {
  assert.equal(recoveryPathsOf(false, 1).recoverable, true);
  assert.equal(recoveryPathsOf(false, 4).recoverable, true);
});

test("terminal ONLY when there is no backup and no sibling", () => {
  const r = recoveryPathsOf(false, 0);
  assert.deepEqual(r, {
    hasBackup: false,
    siblingDevices: 0,
    recoverable: false,
    verified: true,
  });
});

test("a negative or junk sibling count can't fake a recovery path", () => {
  // A malformed count must not read as "someone out there has it".
  assert.equal(recoveryPathsOf(false, -3).recoverable, false);
  assert.equal(recoveryPathsOf(false, -3).siblingDevices, 0);
});

test("hundreds of rows mounting at once cause exactly ONE fetch", async () => {
  let calls = 0;
  const cache = createRecoveryPathsCache(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return recoveryPathsOf(true, 1);
  });
  const results = await Promise.all(
    Array.from({ length: 300 }, () => cache.load()),
  );
  assert.equal(calls, 1, "in-flight request must be shared");
  assert.equal(results.length, 300);
  assert.ok(results.every((r) => r.recoverable));
});

test("a fresh answer is reused; an expired one is refetched", async () => {
  let calls = 0;
  let clock = 1000;
  const cache = createRecoveryPathsCache(
    async () => {
      calls++;
      return recoveryPathsOf(false, 0);
    },
    { ttlMs: 60_000, now: () => clock },
  );
  await cache.load();
  await cache.load();
  assert.equal(calls, 1, "within TTL the cached answer is reused");
  clock += 59_000;
  await cache.load();
  assert.equal(calls, 1, "still inside the TTL");
  clock += 2_000;
  await cache.load();
  assert.equal(calls, 2, "past the TTL it refetches");
});

test("force refetches even inside the TTL", async () => {
  let calls = 0;
  const cache = createRecoveryPathsCache(async () => {
    calls++;
    return recoveryPathsOf(true, 0);
  });
  await cache.load();
  await cache.load(true);
  assert.equal(calls, 2);
});

test("invalidate makes the next read refetch — a restore must flip the verdict", async () => {
  let hasBackup = false;
  let calls = 0;
  const cache = createRecoveryPathsCache(async () => {
    calls++;
    return recoveryPathsOf(hasBackup, 0);
  });
  assert.equal((await cache.load()).recoverable, false);
  hasBackup = true; // the user just restored / enabled a backup
  assert.equal((await cache.load()).recoverable, false, "still the cached verdict");
  cache.invalidate();
  assert.equal((await cache.load()).recoverable, true, "refetched after invalidate");
  assert.equal(calls, 2);
});

test("get() never blocks and never fetches", async () => {
  let calls = 0;
  const cache = createRecoveryPathsCache(async () => {
    calls++;
    return recoveryPathsOf(true, 2);
  });
  assert.equal(cache.get(), null);
  assert.equal(calls, 0);
  await cache.load();
  assert.equal(cache.get()?.siblingDevices, 2);
  assert.equal(calls, 1);
});

test("subscribers are notified, unsubscribe stops them, and one bad one can't break the rest", async () => {
  const seen: number[] = [];
  const cache = createRecoveryPathsCache(async () => recoveryPathsOf(true, 3));
  const off1 = cache.subscribe(() => {
    throw new Error("a badly-behaved subscriber");
  });
  cache.subscribe((v) => seen.push(v.siblingDevices));
  await cache.load();
  assert.deepEqual(seen, [3], "the good subscriber still ran");
  off1();
  cache.invalidate();
  await cache.load();
  assert.deepEqual(seen, [3, 3]);
});

test("a FAILED lookup is unknown, never terminal", () => {
  // 429 / offline / expired token: both counts read 0, but that is "unknown".
  const r = recoveryPathsOf(false, 0, false);
  assert.equal(r.recoverable, true);
  assert.equal(r.verified, false);
});

test("an unverified answer is retried after a few seconds, a verified one is not", async () => {
  let calls = 0;
  let clock = 1000;
  let healthy = false;
  const cache = createRecoveryPathsCache(
    async () => {
      calls++;
      return healthy ? recoveryPathsOf(true, 0) : recoveryPathsOf(false, 0, false);
    },
    { ttlMs: 60_000, unverifiedTtlMs: 5_000, now: () => clock },
  );
  await cache.load();
  await cache.load();
  assert.equal(calls, 1, "a burst of row mounts shares the failed answer");
  healthy = true;
  clock += 6_000;
  const r = await cache.load();
  assert.equal(calls, 2, "past the short TTL it asks again");
  assert.equal(r.verified, true);
  clock += 30_000;
  await cache.load();
  assert.equal(calls, 2, "a verified answer keeps the full TTL");
});
