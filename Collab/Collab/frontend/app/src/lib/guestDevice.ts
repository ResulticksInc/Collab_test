// Persistent browser-profile id for public-link guests.
//
// One browser profile = one guest identity per meeting. The lobby sends this id
// with the lookup and the join; the server pins (meeting, device) → the guest
// user minted on the first join, so a refresh, a reconnect or a second join under
// a different name all come back as the SAME participant (same name, same
// attendance rows) instead of a new one. See backend guestMeetingService.
//
// It is an opaque random string generated here once and kept in localStorage —
// not a hardware fingerprint, not shared with anything else, and only meaningful
// to the meeting server's guest-device table. Clearing site data forgets it,
// which is the same as arriving from a new browser. When storage is unavailable
// (private mode, blocked) the id lives for the page only, which is the pre-
// existing behaviour: a fresh identity per visit.

const KEY = "clb_guest_device_id";
let inMemory: string | null = null;

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      return crypto.randomUUID().replace(/-/g, "");
  } catch {
    /* fall through */
  }
  const bytes = new Uint8Array(24);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Shape the server accepts (mirrors backend looksLikeDeviceId). */
export function isGuestDeviceId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v);
}

/** The browser profile's guest device id, created on first use. Never throws. */
export function getGuestDeviceId(): string {
  if (inMemory) return inMemory;
  try {
    const stored = localStorage.getItem(KEY);
    if (isGuestDeviceId(stored)) {
      inMemory = stored;
      return stored;
    }
  } catch {
    /* storage unavailable */
  }
  const fresh = randomId();
  inMemory = fresh;
  try {
    localStorage.setItem(KEY, fresh);
  } catch {
    /* private mode — the id lives for this page only */
  }
  return fresh;
}
