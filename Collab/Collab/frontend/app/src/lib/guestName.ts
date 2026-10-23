// Display-name rules for a public-link guest.
//
// MIRRORS backend/app/src/services/guestMeetingService.ts › normalizeGuestName —
// the server is the authority and re-validates on join; this copy exists so the
// lobby's Join button enables exactly when the server would accept the name
// (backend/app/test/guest-meeting-link.test.ts asserts the two agree on a corpus).
// Keep the two in step.

const GUEST_NAME_MIN = 2;
export const GUEST_NAME_MAX = 50;

export type GuestNameResult =
  | { ok: true; name: string; error?: undefined }
  | { ok: false; name?: undefined; error: string };

export function validateGuestName(raw: unknown): GuestNameResult {
  if (typeof raw !== "string") return { ok: false, error: "Enter your name to join." };
  let n = raw
    // control, zero-width and bidi-override characters can spoof or hide a name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // "(Guest)" is appended by the server — never typed twice.
  n = n.replace(/\s*\(guest\)\s*$/i, "").trim();
  const len = Array.from(n).length;
  if (len < GUEST_NAME_MIN) return { ok: false, error: "Enter at least 2 characters." };
  if (len > GUEST_NAME_MAX) return { ok: false, error: "That name is too long (50 characters max)." };
  if (/[<>]/.test(n)) return { ok: false, error: "Names can't contain < or >." };
  if (!/[\p{L}\p{N}]/u.test(n)) return { ok: false, error: "Use letters or numbers in your name." };
  return { ok: true, name: n };
}
