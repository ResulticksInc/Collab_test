import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newAccountKey,
  sealAccountKey,
  openAccountKey,
  ACCOUNT_KEY_BYTES,
} from "../src/services/e2eeEscrow";

// Guards the automatic-recovery escrow: the sealed account key must round-trip
// under the right secret, and must NOT open under a wrong secret or after any
// tampering — a wrong secret yielding garbage bytes would silently wrap the
// user's backup secret under something no device can ever reproduce.

const SECRET = "test-escrow-secret-with-enough-entropy";

test("a fresh account key is 32 random bytes", () => {
  const a = newAccountKey();
  const b = newAccountKey();
  assert.equal(a.length, ACCOUNT_KEY_BYTES);
  assert.notEqual(a.toString("hex"), b.toString("hex"));
});

test("seal → open round-trips under the same secret", () => {
  const raw = newAccountKey();
  const sealed = sealAccountKey(raw, SECRET);
  assert.match(sealed, /^[A-Za-z0-9+/=]+$/, "sealed form is base64");
  assert.equal(openAccountKey(sealed, SECRET).toString("hex"), raw.toString("hex"));
});

test("two seals of the same key differ (fresh IV), both open", () => {
  const raw = newAccountKey();
  const s1 = sealAccountKey(raw, SECRET);
  const s2 = sealAccountKey(raw, SECRET);
  assert.notEqual(s1, s2);
  assert.equal(openAccountKey(s2, SECRET).toString("hex"), raw.toString("hex"));
});

test("a wrong secret cannot open it", () => {
  const sealed = sealAccountKey(newAccountKey(), SECRET);
  assert.throws(() => openAccountKey(sealed, SECRET + "x"));
});

test("a tampered blob is rejected", () => {
  const sealed = Buffer.from(sealAccountKey(newAccountKey(), SECRET), "base64");
  sealed[sealed.length - 1] ^= 0x01;
  assert.throws(() => openAccountKey(sealed.toString("base64"), SECRET));
  assert.throws(() => openAccountKey("not-long-enough", SECRET));
});

test("an empty escrow secret is refused outright", () => {
  assert.throws(() => sealAccountKey(newAccountKey(), ""));
  assert.throws(() => sealAccountKey(Buffer.alloc(16), SECRET), /32 bytes/);
});
