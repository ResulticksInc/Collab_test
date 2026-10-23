import { test } from "node:test";
import assert from "node:assert/strict";
import { otherMemberId } from "../../../frontend/app/src/lib/identity";

// Guards the directional ringing fix: the caller's peerId must resolve to the
// OTHER member relative to the real self id, both ways.
const A = "u_aravinthswamy230_gmail_com"; // Brave
const B = "u_kp_aravinth_resulticksmail_com"; // Chrome

test("resolves the correct other party in BOTH directions", () => {
  assert.equal(otherMemberId([A, B], A), B, "A calling resolves to B");
  assert.equal(otherMemberId([A, B], B), A, "B calling resolves to A");
});

test("is independent of member order", () => {
  assert.equal(otherMemberId([B, A], A), B);
  assert.equal(otherMemberId([B, A], B), A);
});

test("a hardcoded non-member self id reproduces the original bug", () => {
  // With self wrongly pinned to a seed id, BOTH callers collapse to members[0],
  // so one direction dials itself -> 'cannot call yourself' -> callee never rings.
  assert.equal(otherMemberId([A, B], "u_you"), A);
  assert.equal(otherMemberId([A, B], "u_you"), A);
});

test("handles empty / single-member / missing input", () => {
  assert.equal(otherMemberId([], A), null);
  assert.equal(otherMemberId(null, A), null);
  assert.equal(otherMemberId([A], A), null);
});
