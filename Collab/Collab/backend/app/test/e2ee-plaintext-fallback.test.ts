import { test } from "node:test";
import assert from "node:assert/strict";
import { serverPlaintextOf, plaintextRow } from "../../../frontend/app/src/lib/e2ee/plaintextFallback";

// A message this device cannot decrypt shows its plaintext when the row (or a
// registered source) still carries readable text — tagged "not encrypted" —
// and the "unavailable on this device" placeholder only when there is nothing.

const PENDING = "Message unavailable on this device";

test("a real body on the row is used as the fallback", () => {
  assert.equal(serverPlaintextOf({ id: "1", text: "hello there" }, PENDING), "hello there");
  assert.equal(serverPlaintextOf({ id: "1", body: "from body" }, PENDING), "from body");
});

test("placeholders and empty strings are never mistaken for content", () => {
  assert.equal(serverPlaintextOf({ text: PENDING }, PENDING), null);
  assert.equal(serverPlaintextOf({ text: "   " }, PENDING), null);
  assert.equal(serverPlaintextOf({ text: "[Encrypted — waiting to sync]" }, PENDING), null);
  assert.equal(serverPlaintextOf({ text: "[Unencrypted message — rejected]" }, PENDING), null);
  assert.equal(serverPlaintextOf({ text: null, body: undefined }, PENDING), null);
  assert.equal(serverPlaintextOf(null, PENDING), null);
});

test("the fallback row is readable, unencrypted and tagged", () => {
  const m = { id: "9", encrypted: true, ciphertext: [{ body: "x" }], text: "" };
  const row = plaintextRow(m, "plain copy", "decrypt-failed");
  assert.equal(row.text, "plain copy");
  assert.equal(row.encrypted, false);
  assert.equal(row.ciphertext, null);
  assert.equal(row.notEncrypted, true);
  assert.equal(row._plaintextFallback, "decrypt-failed");
  assert.equal(row.id, "9");
});
