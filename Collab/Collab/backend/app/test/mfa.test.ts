// MFA (TOTP) tests. Two layers:
//   1. PURE crypto — RFC 6238 known-answer vectors + base32 round-trip (no DB).
//      These prove interoperability with real authenticator apps.
//   2. Service flow against the throwaway `colab_test` MySQL (skips if unreachable):
//      enroll → confirm → step-up challenge → verify, backup-code single-use,
//      wrong-code rejection, forged/expired challenge rejection.
process.env.MFA_ENABLED = "true"; // must be set BEFORE platform/config is imported

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { useTestDatabase } from "./_setup";
import { totp, verifyTotp, base32Encode, base32Decode, generateSecret } from "../src/services/totp";

// ── 1. Pure TOTP / base32 (RFC 6238 Appendix B, SHA1, 6-digit truncation) ─────
const RFC_SECRET = Buffer.from("12345678901234567890"); // the RFC test seed (ASCII)

test("TOTP matches RFC 6238 known-answer vectors (6-digit)", () => {
  // 8-digit RFC values → last 6 digits for our 6-digit codes.
  assert.equal(totp(RFC_SECRET, { t: 59_000, digits: 6 }), "287082"); // T=59  → 94287082
  assert.equal(totp(RFC_SECRET, { t: 1_111_111_109_000, digits: 6 }), "081804"); // → 07081804
  assert.equal(totp(RFC_SECRET, { t: 1_234_567_890_000, digits: 6 }), "005924"); // → 89005924
});

test("verifyTotp accepts the current code and tolerates ±1 step of skew", () => {
  const t = 1_111_111_109_000;
  assert.equal(verifyTotp(RFC_SECRET, "081804", { t }), true);
  assert.equal(verifyTotp(RFC_SECRET, "081804", { t: t + 25_000 }), true); // within +1 window
  assert.equal(verifyTotp(RFC_SECRET, "081804", { t: t - 25_000 }), true); // within -1 window
  assert.equal(verifyTotp(RFC_SECRET, "081804", { t: t + 120_000 }), false); // >1 window away
  assert.equal(verifyTotp(RFC_SECRET, "000000", { t }), false); // wrong code
  assert.equal(verifyTotp(RFC_SECRET, "12345", { t }), false); // wrong length
  assert.equal(verifyTotp(RFC_SECRET, "abcdef", { t }), false); // non-numeric
});

test("base32 round-trips arbitrary bytes", () => {
  for (const n of [1, 5, 7, 20, 33]) {
    const buf = generateSecret().raw.subarray(0, n);
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
  }
  // A generated secret decodes back to 20 bytes.
  const { raw, base32 } = generateSecret();
  assert.equal(raw.length, 20);
  assert.deepEqual(base32Decode(base32), raw);
});

// ── 2. Service flow (DB-backed) ───────────────────────────────────────────────
let dbUp = false;
let mfa: any;
let db: any;
const UID = "u_mfa_test";

before(async () => {
  await useTestDatabase();
  process.env.AUTH_JWT_SECRET = "test-secret-colab-at-least-32-chars-xx";
  try {
    const { migrate } = await import("../../../database/src");
    const platform = await import("../src/platform");
    db = platform.db;
    await migrate(platform.config.database.url);
    mfa = await import("../src/services/mfaService");
    await db.mfa.remove(UID); // clean slate for idempotent re-runs
    dbUp = true;
  } catch (e: any) {
    console.error("[test] MySQL unavailable — MFA service cases will skip:", e.message);
  }
});

function dbTest(name: string, fn: (t: any) => Promise<void>) {
  test(name, async (t) => {
    if (!dbUp) return (t as any).skip("MySQL unavailable");
    await fn(t);
  });
}

// Derive the current authenticator code from a base32 secret (what the app does).
const codeFor = (secretB32: string) => totp(base32Decode(secretB32));

dbTest("enroll → confirm → challenge; backup codes single-use; re-enroll guarded", async () => {
  await db.mfa.remove(UID);

  // Not enrolled yet.
  assert.equal((await mfa.enrollmentStatus(UID)).enabled, false);
  assert.equal(await mfa.requiresStepUp(UID), null);

  // Begin: a pending secret exists but MFA is not yet active.
  const begin = await mfa.beginTotpEnroll(UID, "u@colab.app");
  assert.match(begin.secret, /^[A-Z2-7]+$/);
  assert.ok(begin.otpauthUri.startsWith("otpauth://totp/"));
  assert.equal((await mfa.enrollmentStatus(UID)).enabled, false);

  // A wrong code does NOT confirm enrollment.
  await assert.rejects(() => mfa.confirmTotpEnroll(UID, "000000"));

  // Confirm with the real code → active + 10 backup codes returned once.
  const confirm = await mfa.confirmTotpEnroll(UID, codeFor(begin.secret));
  assert.equal(confirm.confirmed, true);
  assert.equal(confirm.backupCodes.length, 10);

  const status = await mfa.enrollmentStatus(UID);
  assert.equal(status.enabled, true);
  assert.deepEqual(status.methods, ["totp"]);
  assert.equal(status.backupCodesRemaining, 10);

  // Step-up issues a challenge; readChallenge parses a real one, rejects a forgery.
  const step = await mfa.requiresStepUp(UID);
  assert.equal(step.method, "totp");
  assert.equal(mfa.readChallenge("forged.token"), null);
  assert.deepEqual(mfa.readChallenge(step.challengeId), { userId: UID, deviceId: undefined });

  // Anti-replay: confirm already consumed the current TOTP step, so re-verifying
  // the same-window code must be REJECTED (RFC 6238 §5.2 single-use).
  assert.equal(await mfa.verifyCode(UID, codeFor(begin.secret)), false);

  // Backup code works ONCE then is consumed.
  const backup = confirm.backupCodes[0];
  assert.equal(await mfa.verifyCode(UID, backup), true);
  assert.equal(await mfa.verifyCode(UID, backup), false);
  assert.equal((await mfa.enrollmentStatus(UID)).backupCodesRemaining, 9);

  // Re-enroll takeover guard: begin on a CONFIRMED factor must be refused (no
  // silent secret clobber / confirmed_at reset).
  await assert.rejects(() => mfa.beginTotpEnroll(UID, "u@colab.app"), /already enabled/i);

  // Disable clears everything.
  await mfa.disable(UID);
  assert.equal((await mfa.enrollmentStatus(UID)).enabled, false);
  assert.equal(await mfa.requiresStepUp(UID), null);
});

dbTest("bumpTotpStep is a monotonic single-use compare-and-set (anti-replay core)", async () => {
  await db.mfa.remove(UID);
  await db.mfa.upsertPending(UID, "x"); // a row to carry last_step
  await db.mfa.confirm(UID);
  assert.equal(await db.mfa.bumpTotpStep(UID, 1000), true); // first accept
  assert.equal(await db.mfa.bumpTotpStep(UID, 1000), false); // same step → replay rejected
  assert.equal(await db.mfa.bumpTotpStep(UID, 999), false); // earlier step → rejected
  assert.equal(await db.mfa.bumpTotpStep(UID, 1001), true); // advances → accepted
  await db.mfa.remove(UID);
});
