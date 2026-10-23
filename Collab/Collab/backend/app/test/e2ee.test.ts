import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";

// E2EE + TELEMETRY server-side tests. Only the pieces that are testable WITHOUT a
// browser / IndexedDB / Web Crypto round-trip:
//   - registerDevice trust logic (first device trusted, later devices pending)
//   - getPreKeyBundle filtering to trusted devices only (via bundleFor)
//   - history-sync authz guards (source must be trusted+own; target must be own)
//   - recovery-backup authz / put-get-delete round-trip (server stays blind)
//   - telemetry fingerprint + normalize (PURE — no DB; always run)
//
// The browser-crypto round-trip (ECIES encrypt/decrypt, ratchet, device-link via
// IndexedDB) is DELIBERATELY SKIPPED: it needs IndexedDB + Web Crypto mocking,
// which would require new test deps (fake-indexeddb etc.) the task forbids. That
// is a follow-up for a Playwright/jsdom harness, noted in the suite report.
//
// DB strategy matches calls-signalling.test.ts: real `colab` MySQL, skip-if-down.

let dbUp = false;
let db: any;
let e2eeService: any;
let telemetryService: any;

// Two isolated users for device-trust + cross-user authz checks.
const U1 = "u_e2ee_one";
const U2 = "u_e2ee_two";

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab";
  process.env.LIVEKIT_API_KEY = "testkey";
  process.env.LIVEKIT_API_SECRET = "testsecret_at_least_32_characters_long_xx";
  process.env.LIVEKIT_WS_URL = "ws://localhost:7534";

  // Pure telemetry service — no DB needed for fingerprint/normalize.
  telemetryService = await import("../src/services/telemetryService");

  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    await migrate(platform.config.database.url);
    e2eeService = await import("../src/services/e2eeService");

    for (const [id, name] of [
      [U1, "E2EE One"],
      [U2, "E2EE Two"],
    ] as const) {
      await db.users.upsert({
        id,
        email: id + "@ex.com",
        name,
        initials: "E2",
        color: "#2563EB",
        presence: "off",
        passwordHash: null,
      });
    }
    // Clean any devices left by a prior run so "first device" trust logic is
    // deterministic (the unique deviceIds below also use a per-run suffix).
    if (db.pool)
      await db.pool.query(
        "DELETE FROM e2ee_devices WHERE user_id IN (?, ?)",
        [U1, U2],
      );
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — DB cases will skip:", e.message);
  }
});

after(async () => {
  if (dbUp && db?.pool)
    await db.pool.query("DELETE FROM e2ee_devices WHERE user_id IN (?, ?)", [U1, U2]).catch(() => {});
  if (db?.pool?.end) await db.pool.end();
});

const dbTest = (name: string, fn: any) =>
  test(name, async (t) => {
    if (!dbUp) {
      t.skip("MySQL not available");
      return;
    }
    await fn(t);
  });

const RUN = Math.random().toString(36).slice(2, 8);
const devId = (label: string) => `dev_${RUN}_${label}`;

// ---------------------------------------------------------------------------
// TELEMETRY — pure, always-run
// ---------------------------------------------------------------------------

test("telemetry.normalize drops items with no message", () => {
  assert.equal(telemetryService.normalize({ message: "" }, {}), null);
  assert.equal(telemetryService.normalize({}, {}), null);
});

test("telemetry.normalize clips + defaults level, computes a fingerprint", () => {
  const out = telemetryService.normalize(
    { message: "Boom", stack: "Error: Boom\n    at foo (a.js:1:1)", level: "weird" },
    { userId: "u1", userAgent: "UA" },
  );
  assert.ok(out, "a message produces a normalized record");
  assert.equal(out.level, "error", "an unknown level defaults to error");
  assert.equal(out.userId, "u1");
  assert.match(out.fingerprint, /^[0-9a-f]{64}$/, "fingerprint is a 64-hex sha256 prefix");
});

test("telemetry fingerprint is stable for the same message+top-frame, differs otherwise", () => {
  const a = telemetryService.normalize(
    { message: "X", stack: "Error: X\n    at foo (a.js:1:1)" },
    {},
  );
  const b = telemetryService.normalize(
    { message: "X", stack: "Error: X\n    at foo (a.js:1:1)\n    at bar (b.js:2:2)" },
    {},
  );
  // Same message + same TOP frame → same group, even with different lower frames.
  assert.equal(a.fingerprint, b.fingerprint, "same message + top frame → same fingerprint");

  const c = telemetryService.normalize(
    { message: "X", stack: "Error: X\n    at other (z.js:9:9)" },
    {},
  );
  assert.notEqual(a.fingerprint, c.fingerprint, "a different top frame → different fingerprint");

  const d = telemetryService.normalize({ message: "Y", stack: "Error: Y\n    at foo (a.js:1:1)" }, {});
  assert.notEqual(a.fingerprint, d.fingerprint, "a different message → different fingerprint");
});

// ---------------------------------------------------------------------------
// E2EE device trust — DB-backed
// ---------------------------------------------------------------------------

dbTest("registerDevice: the FIRST device is trusted; later devices are pending", async () => {
  const d1 = devId("first");
  const d2 = devId("second");

  const first = await e2eeService.registerDevice(U1, {
    deviceId: d1,
    identityKey: "ik_" + d1,
  });
  assert.equal(first.trusted, true, "the first enrolled device is trusted (bootstrap)");

  const second = await e2eeService.registerDevice(U1, {
    deviceId: d2,
    identityKey: "ik_" + d2,
  });
  assert.equal(second.trusted, false, "a second device starts PENDING (untrusted)");

  // Re-registering the pending device must NOT silently promote it.
  const reReg = await e2eeService.registerDevice(U1, {
    deviceId: d2,
    identityKey: "ik_" + d2 + "_v2",
  });
  assert.equal(reReg.trusted, false, "re-registering a pending device keeps it pending");

  // Approving it from an existing (trusted) device flips it to trusted.
  await e2eeService.approveDevice(U1, d2);
  const after = await db.e2ee.getDevice(d2);
  assert.equal(after.trusted, true, "an approved device becomes trusted");
});

dbTest("getPreKeyBundle (bundleFor) returns ONLY trusted, non-revoked devices", async () => {
  const trusted = devId("bundle_trusted"); // first → trusted
  const pending = devId("bundle_pending"); // second → pending

  await e2eeService.registerDevice(U2, { deviceId: trusted, identityKey: "ik_" + trusted });
  await e2eeService.registerDevice(U2, { deviceId: pending, identityKey: "ik_" + pending });

  const bundle = await e2eeService.bundleFor(U2);
  const ids = bundle.map((d: any) => d.id);
  assert.ok(ids.includes(trusted), "the trusted device IS in the fan-out bundle");
  assert.equal(
    ids.includes(pending),
    false,
    "a pending (untrusted) device is EXCLUDED from key fan-out",
  );

  // Revoking the trusted device removes it from the bundle too.
  await e2eeService.revokeDevice(U2, trusted);
  const bundle2 = await e2eeService.bundleFor(U2);
  assert.equal(
    bundle2.map((d: any) => d.id).includes(trusted),
    false,
    "a revoked device is excluded from the bundle",
  );
});

dbTest("history-sync authz: source must be trusted+own, target must be own & not self", async () => {
  // U1 needs two TRUSTED devices here. Earlier tests in this same run already
  // enrolled U1's first (bootstrap-trusted) device, so neither device below is
  // "first" — both start pending and must be explicitly approved to be trusted.
  const src = devId("hs_src");
  const tgt = devId("hs_tgt");
  await e2eeService.registerDevice(U1, { deviceId: src, identityKey: "ik_" + src });
  await e2eeService.registerDevice(U1, { deviceId: tgt, identityKey: "ik_" + tgt });
  await e2eeService.approveDevice(U1, src);
  await e2eeService.approveDevice(U1, tgt);

  const goodBody = {
    targetDeviceId: tgt,
    ciphertext: "b64opaque",
    bundleId: "bundle1",
    chunkIndex: 0,
    chunkCount: 1,
  };

  // Happy path: trusted source → own target.
  const ok = await e2eeService.uploadHistorySync(U1, src, goodBody);
  assert.ok(ok, "a trusted source can push to its own user's target device");

  // No source-bound token → skipped (best-effort, not an error).
  const skipped = await e2eeService.uploadHistorySync(U1, null, goodBody);
  assert.deepEqual(skipped, { skipped: "no-device-bound-token" });

  // Target owned by a DIFFERENT user → 403.
  const foreignTgt = devId("hs_foreign");
  await e2eeService.registerDevice(U2, { deviceId: foreignTgt, identityKey: "ik_" + foreignTgt });
  await assert.rejects(
    () => e2eeService.uploadHistorySync(U1, src, { ...goodBody, targetDeviceId: foreignTgt }),
    (e: any) => e.status === 403,
    "pushing to another user's device is forbidden",
  );

  // Sync-to-self → 400.
  await assert.rejects(
    () => e2eeService.uploadHistorySync(U1, src, { ...goodBody, targetDeviceId: src }),
    (e: any) => e.status === 400,
    "syncing a device to itself is rejected",
  );

  // An UNTRUSTED source cannot push at all.
  const untrustedSrc = devId("hs_untrusted"); // third device for U1 → pending
  await e2eeService.registerDevice(U1, { deviceId: untrustedSrc, identityKey: "ik_" + untrustedSrc });
  await assert.rejects(
    () => e2eeService.uploadHistorySync(U1, untrustedSrc, goodBody),
    (e: any) => e.status === 403,
    "an untrusted source device cannot push history",
  );

  // Fetch is scoped to the JWT-supplied device id (never a body/query id).
  const fetched = await e2eeService.fetchHistorySync(U1, tgt);
  assert.ok(Array.isArray(fetched), "fetch returns the target device's relay rows");
  assert.ok(fetched.length >= 1, "the chunk pushed above is fetchable by the target");
  // No device id → nothing to fetch (best-effort).
  assert.deepEqual(await e2eeService.fetchHistorySync(U1, null), []);
});

dbTest("recovery-backup: put → get → delete, userId comes only from the caller (JWT)", async () => {
  const body = {
    salt: "saltb64",
    chunks: [{ index: 0, count: 1, ciphertext: "ctb64", iv: "ivb64" }],
  };
  const put = await e2eeService.putRecoveryBackup(U1, body);
  assert.equal(put.ok, true, "backup stored");

  const got = await e2eeService.getRecoveryBackup(U1);
  assert.ok(got, "the owner can fetch their backup");

  // A different user has no backup (isolation — userId is the only key).
  const other = await e2eeService.getRecoveryBackup(U2);
  assert.equal(other, null, "another user sees no backup of their own");

  // Metadata view: everything a client needs for existence / key checks and
  // NOTHING of the body — one probe chunk only.
  const meta = await e2eeService.getRecoveryBackupMeta(U1);
  assert.ok(meta, "the owner can fetch backup metadata");
  assert.equal(meta.salt, "saltb64");
  assert.equal(meta.chunkCount, 1);
  assert.ok(meta.byteLen > 0, "size summary is reported");
  assert.equal(meta.chunks, undefined, "meta carries no chunk list");
  assert.deepEqual(meta.probe, { ciphertext: "ctb64", iv: "ivb64" }, "first chunk rides along as the probe");
  assert.equal(await e2eeService.getRecoveryBackupMeta(U2), null, "another user sees no metadata");

  // An 'account' wrap (automatic recovery) is stored and served like the others.
  await e2eeService.putRecoveryWrap(U1, {
    kind: "account", ct: "ct", iv: "iv", salt: "s", iterations: 310000,
  });
  const withWrap = await e2eeService.getRecoveryBackupMeta(U1);
  assert.ok(withWrap.wraps.some((w: any) => w.kind === "account"), "account wrap is listed");

  await e2eeService.deleteRecoveryBackup(U1);
  assert.equal(await e2eeService.getRecoveryBackup(U1), null, "deleted backup is gone");
  assert.equal(await e2eeService.getRecoveryBackupMeta(U1), null, "deleted backup has no metadata");
});

dbTest("account-key: minted once per user, identical on every call, isolated per user, gone with the backup", async () => {
  process.env.E2EE_AUTO_RECOVERY = "true";
  const a = await e2eeService.getOrCreateAccountKey(U1);
  assert.match(a.key, /^[A-Za-z0-9+/=]+$/, "base64 key");
  assert.equal(Buffer.from(a.key, "base64").length, 32, "32 raw bytes");
  const again = await e2eeService.getOrCreateAccountKey(U1);
  assert.equal(again.key, a.key, "a second device gets the SAME key");
  const other = await e2eeService.getOrCreateAccountKey(U2);
  assert.notEqual(other.key, a.key, "another user gets their own key");
  // The escrow row goes with the backup so "turn off backup" leaves nothing.
  await e2eeService.deleteRecoveryBackup(U1);
  assert.equal(await db.e2ee.getAccountKey(U1), null, "account key deleted with the backup");
  const fresh = await e2eeService.getOrCreateAccountKey(U1);
  assert.notEqual(fresh.key, a.key, "re-minted afterwards");

  // Malformed input is rejected (empty chunks).
  await assert.rejects(
    () => e2eeService.putRecoveryBackup(U1, { salt: "s", chunks: [] }),
    "empty chunks array is rejected",
  );
});

dbTest("group epoch: an existing wrap is never overwritten; a lost create reports maxVersion", async () => {
  const dA = devId("epochA");
  const dB = devId("epochB");
  await e2eeService.registerDevice(U1, { deviceId: dA, identityKey: "ik_" + dA });
  await e2eeService.registerDevice(U2, { deviceId: dB, identityKey: "ik_" + dB });
  const conv = await db.conversations.create({
    kind: "group",
    title: "Epoch test",
    icon: "🔑",
    createdBy: U1,
  });
  await db.conversations.addMember(conv.id, U1, { role: "owner" });
  await db.conversations.addMember(conv.id, U2, { role: "member" });
  const env = (deviceId: string, userId: string, encryptedKey: string) => ({
    deviceId, userId, encryptedKey, algorithm: "ecies-p256-aesgcm",
  });

  const first = await e2eeService.createConversationEpoch(U1, conv.id, 1, [
    env(dA, U1, "K1-for-A"),
    env(dB, U2, "K1-for-B"),
  ]);
  assert.equal(first.created, true, "first epoch is created");

  // A second device racing the SAME version loses and learns the highest version.
  const lost = await e2eeService.createConversationEpoch(U2, conv.id, 1, [
    env(dA, U1, "OTHER-for-A"),
    env(dB, U2, "OTHER-for-B"),
  ]);
  assert.equal(lost.created, false, "the version is already taken");
  assert.equal(lost.maxVersion, 1, "the loser is told the highest existing version");

  // The legacy last-resort upsert must NOT replace a live epoch's wraps.
  await e2eeService.putConversationKeys(U2, conv.id, [
    { ...env(dA, U1, "CLOBBER-for-A"), keyVersion: 1 },
    { ...env(dB, U2, "CLOBBER-for-B"), keyVersion: 1 },
  ]);
  const mineA = await e2eeService.myConversationKeys(U1, conv.id);
  assert.equal(
    mineA.find((r: any) => r.deviceId === dA && Number(r.keyVersion) === 1).encryptedKey,
    "K1-for-A",
    "epoch 1 keeps its original key",
  );

  // Claiming the NEXT version works and leaves epoch 1 intact.
  const next = await e2eeService.createConversationEpoch(U2, conv.id, lost.maxVersion + 1, [
    env(dA, U1, "K2-for-A"),
    env(dB, U2, "K2-for-B"),
  ]);
  assert.equal(next.created, true, "the next free epoch is claimable");
});
