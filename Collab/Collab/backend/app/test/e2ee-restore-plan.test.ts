import { test } from "node:test";
import assert from "node:assert/strict";
import {
  looksLikeRecoveryKey,
  planRestore,
  wrongCredentialMessage,
  credentialPrompt,
  type BackupCapabilities,
} from "../../../frontend/app/src/lib/e2ee/restorePlan";

// Guards the "new device can't get its history back" fix. The restore box takes
// ONE field because people don't know which of the three credentials their
// account holds; this is the decision about what to try against it.

const caps = (
  hasBackup: boolean,
  hasPasswordWrap: boolean,
  hasPassphraseWrap: boolean,
): BackupCapabilities => ({ hasBackup, hasPasswordWrap, hasPassphraseWrap });

// 32 bytes of base32 = 52 chars, shown in dash-separated groups of 4.
const KEY = "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRST";

test("a real recovery key is recognised, in grouped or bare form", () => {
  assert.equal(looksLikeRecoveryKey(KEY), true);
  assert.equal(looksLikeRecoveryKey(KEY.replace(/-/g, "")), true);
  assert.equal(looksLikeRecoveryKey(KEY.toLowerCase()), true);
});

test("passwords and passphrases are NOT mistaken for a recovery key", () => {
  assert.equal(looksLikeRecoveryKey("hunter2"), false);
  assert.equal(looksLikeRecoveryKey("correct horse battery staple"), false);
  // Long, but carries characters outside the base32 alphabet.
  assert.equal(looksLikeRecoveryKey("A".repeat(40) + "!" + "B".repeat(20)), false);
  // Base32-legal but too short to be 32 bytes.
  assert.equal(looksLikeRecoveryKey("ABCDEFGH"), false);
});

test("THE BUG: a password-only account must try the password wrap", () => {
  // The old code guessed from the input's shape and could only ever reach the
  // passphrase (or a key), so this account could never be restored.
  const plan = planRestore("my-sign-in-password", caps(true, true, false));
  assert.equal(plan[0], "password");
  assert.ok(plan.includes("recoveryKey"), "a mistyped key still gets a last try");
  assert.ok(!plan.includes("passphrase"), "never attempt a wrap that doesn't exist");
});

test("a pasted recovery key is tried FIRST, before any PBKDF2 unwrap", () => {
  const plan = planRestore(KEY, caps(true, true, true));
  assert.equal(plan[0], "recoveryKey");
});

test("with both wraps, a typed secret tries password then passphrase", () => {
  assert.deepEqual(planRestore("something", caps(true, true, true)), [
    "password",
    "passphrase",
    "recoveryKey",
  ]);
});

test("a passphrase-only account never attempts the password wrap", () => {
  const plan = planRestore("my passphrase", caps(true, false, true));
  assert.deepEqual(plan, ["passphrase", "recoveryKey"]);
});

test("no backup, or no input, means nothing to attempt", () => {
  assert.deepEqual(planRestore("anything", caps(false, false, false)), []);
  assert.deepEqual(planRestore("", caps(true, true, true)), []);
  assert.deepEqual(planRestore("   ", caps(true, true, true)), []);
});

test("the plan never repeats a method", () => {
  const plan = planRestore(KEY, caps(true, true, true));
  assert.equal(new Set(plan).size, plan.length);
});

test("the failure message names only credentials the account actually has", () => {
  const only = wrongCredentialMessage(caps(true, true, false));
  assert.ok(only.includes("sign-in password"));
  assert.ok(
    !only.includes("recovery passphrase"),
    "must not send someone hunting for a passphrase they never set",
  );
  const both = wrongCredentialMessage(caps(true, true, true));
  assert.ok(both.includes("sign-in password") && both.includes("recovery passphrase"));
  assert.ok(wrongCredentialMessage(caps(false, false, false)).includes("No encrypted backup"));
});

test("the input's prompt matches what the account holds", () => {
  assert.ok(credentialPrompt(caps(true, true, false)).includes("sign-in password"));
  assert.ok(credentialPrompt(caps(true, false, true)).includes("recovery passphrase"));
  assert.equal(credentialPrompt(caps(true, false, false)), "Your recovery key");
  assert.equal(credentialPrompt(caps(false, false, false)), "No backup found");
});
