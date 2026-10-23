import jwt from "jsonwebtoken";
import { randomBytes, randomUUID } from "crypto";
import { config, db } from "../platform";
import { pubUser } from "../serialize";

// ── Public (guest) meeting link ─────────────────────────────────────────────
//
// A host mints one unguessable token per meeting (meetings.public_link_token).
// Anyone holding it can open /join/<token>, type a display name and enter the
// meeting WITHOUT a Collab account.
//
// What a guest is: an ordinary `users` row with role='guest', a synthetic
// @guest.invalid email, no password and NO organisation membership, plus a
// short-lived session whose active_org_id is copied from the MEETING row — so the
// tenant is established server-side and a guest can never be pointed at another
// organisation by the client. Everything else is enforced where the guest's JWT
// is accepted:
//   • middleware/auth.ts   — a guest token reaches only the room endpoints of
//                            its own meeting (allowlist), and skips the org
//                            membership gate (a guest has none).
//   • realtime/socket.ts   — a guest socket may only emit meeting events for its
//                            own meeting.
//   • routes/calls.ts      — the LiveKit token is minted for its meeting only.
// The meeting's own lobby policy still applies: enterRoom treats a guest as
// "not invited", so a host who has the lobby on admits guests one by one.

/** Guest sessions are deliberately short: a meeting, not an account. */
const GUEST_TTL_HOURS = Math.max(1, Number(process.env.GUEST_SESSION_TTL_HOURS) || 12);

const GUEST_SUFFIX = " (Guest)";
const COLORS = ["#2563EB", "#7C3AED", "#DB2777", "#EA580C", "#059669", "#0891B2", "#CA8A04", "#4F46E5"];

const GUEST_NAME_MIN = 2;
const GUEST_NAME_MAX = 50;

const httpError = (status: number, code: string, message: string) => {
  const e: any = new Error(message);
  e.status = status;
  e.code = code;
  return e;
};

/** 32-char URL-safe secret (192 bits). */
export function newPublicToken(): string {
  return randomBytes(24).toString("base64url");
}

/** A token is only worth a DB lookup if it has the shape we mint. */
export function looksLikePublicToken(t: unknown): t is string {
  return typeof t === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(t);
}

/**
 * The lobby's persistent browser-profile id (frontend lib/guestDevice.ts): an
 * opaque random string the client generates once and keeps in localStorage.
 * Only its shape is checked — it is a correlation key, never a credential.
 */
export function looksLikeDeviceId(d: unknown): d is string {
  return typeof d === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(d);
}

/** "Ada (Guest)" → "Ada": the name as the guest typed it (what the lobby field shows). */
export function rawGuestName(display: unknown): string {
  return String(display || "").replace(/\s*\(guest\)\s*$/i, "").trim();
}

/**
 * The guest identity this browser profile already holds for the meeting, if
 * any. A binding whose user row vanished (account purge) is treated as absent so
 * the next join mints afresh instead of failing.
 */
async function findGuestIdentity(meetingId: string, deviceId: string | null | undefined) {
  if (!looksLikeDeviceId(deviceId)) return null;
  const bound = await db.meetings.getGuestDevice(meetingId, deviceId).catch(() => null);
  if (!bound) return null;
  if (bound.userDeleted) return { user: null, joinCount: bound.joinCount, stale: true };
  const user = await db.users.getById(bound.userId).catch(() => null);
  if (!user || user.role !== "guest") return { user: null, joinCount: bound.joinCount, stale: true };
  return { user, joinCount: bound.joinCount, stale: false };
}

/**
 * Validate and normalise the display name a guest typed. Kept in step with the
 * lobby form (frontend GuestMeeting.tsx) so the Join button enables exactly when
 * the server would accept the name.
 *   • whitespace collapsed, control / zero-width / bidi-override characters
 *     removed (they can spoof or hide a name in the roster),
 *   • 2–50 characters, at least one letter or digit,
 *   • no angle brackets (names are rendered into chat and the roster).
 */
export function normalizeGuestName(
  raw: unknown,
): { ok: boolean; name?: string; message?: string } {
  if (typeof raw !== "string") return { ok: false, message: "Enter your name to join." };
  let n = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // "(Guest)" is appended by us — don't let it be typed twice, or typed to look
  // like a different suffix.
  n = n.replace(/\s*\(guest\)\s*$/i, "").trim();
  const len = Array.from(n).length;
  if (len < GUEST_NAME_MIN) return { ok: false, message: "Enter at least 2 characters." };
  if (len > GUEST_NAME_MAX) return { ok: false, message: "That name is too long (50 characters max)." };
  if (/[<>]/.test(n)) return { ok: false, message: "Names can't contain < or >." };
  if (!/[\p{L}\p{N}]/u.test(n)) return { ok: false, message: "Use letters or numbers in your name." };
  return { ok: true, name: n };
}

function initialsOf(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  const pick = (s: string) => Array.from(s)[0] || "";
  const out = parts.length > 1 ? pick(parts[0]) + pick(parts[parts.length - 1]) : pick(parts[0] || "?");
  return out.toUpperCase().slice(0, 2) || "?";
}

/** Strip a user object down to what a roster tile needs — no email/phone/title. */
const SLIM_KEYS = ["id", "name", "initials", "color", "avatarUrl", "presence", "role", "joinedAt", "status", "optional"];
export function slimPerson(p: any) {
  if (!p || typeof p !== "object") return p;
  const out: any = {};
  for (const k of SLIM_KEYS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

/**
 * Guests are anonymous strangers to the org's members' contact details. Room
 * payloads carry full public profiles (email, phone, title…) for every attendee
 * and participant, so a guest-bound copy is reduced to roster essentials.
 * Non-destructive — returns a new object.
 */
export function redactRoomForGuest(room: any) {
  if (!room || typeof room !== "object") return room;
  const out: any = { ...room };
  if (Array.isArray(room.participants)) out.participants = room.participants.map(slimPerson);
  if (room.meeting && typeof room.meeting === "object") {
    out.meeting = { ...room.meeting };
    // The org's meeting chat group is not the guest's to reach (in-meeting chat
    // runs over the meeting socket room, not that conversation).
    out.meeting.conversationId = null;
    if (Array.isArray(room.meeting.attendees))
      out.meeting.attendees = room.meeting.attendees.map(slimPerson);
  }
  return out;
}

/** True for the users minted by this service. */
const isGuestUser = (u: any) => !!u && u.role === "guest";

/** Drop guest ids from a list (chat-group fan-out must never include them). */
export async function withoutGuests(ids: string[]): Promise<string[]> {
  const list = Array.from(new Set((ids || []).filter(Boolean)));
  if (!list.length) return list;
  try {
    const users = await db.users.getByIds(list);
    const guests = new Set((users || []).filter(isGuestUser).map((u: any) => u.id));
    return list.filter((id) => !guests.has(id));
  } catch (_) {
    return list; // never block the caller on a lookup blip
  }
}

const baseMeetingId = (id: string) => String(id || "").split("__occ_")[0];

/**
 * Is this meeting closed to NEW joiners? Same rules enterRoom applies: a
 * cancelled meeting is closed outright; a hard-ended ("End for everyone") one
 * stops the live session but its link stays valid for the whole scheduled
 * window, and is closed only once that window has passed. (Imported lazily —
 * meetingService imports this module for the guest filter, so a static import
 * would be a cycle.)
 */
async function isClosedForJoin(m: any): Promise<boolean> {
  if (m.status === "cancelled") return true;
  if (!m.hardEnded) return false;
  const { sessionWindow } = await import("./meetingService");
  const win = sessionWindow(m);
  return !win || Date.now() > win.end;
}

async function requireHostOrCoHost(meetingId: string, userId: string) {
  const m = await db.meetings.getById(baseMeetingId(meetingId));
  if (!m) throw httpError(404, "NOT_FOUND", "Meeting not found.");
  if (m.createdBy === userId) return m;
  const role = await db.meetings.getAttendeeRole(m.id, userId).catch(() => null);
  if (role === "co-host") return m;
  throw httpError(403, "FORBIDDEN", "Only the host or a co-host can manage the public link.");
}

/** Create the public link for a meeting, or return the existing one (idempotent). */
export async function ensureLink({ meetingId, userId }: { meetingId: string; userId: string }) {
  const m = await requireHostOrCoHost(meetingId, userId);
  if (m.status === "cancelled") throw httpError(409, "MEETING_CANCELLED", "This meeting was cancelled.");
  if (m.publicLinkToken) return { enabled: true, token: m.publicLinkToken, created: false };
  // Collisions are astronomically unlikely (192 bits) and the unique index would
  // reject one — a single retry covers the impossible.
  for (let i = 0; i < 2; i++) {
    const token = newPublicToken();
    try {
      await db.meetings.setPublicLinkToken(m.id, token);
      return { enabled: true, token, created: true };
    } catch (e) {
      if (i === 1) throw e;
    }
  }
  throw httpError(500, "INTERNAL", "Could not create the link.");
}

export async function getLink({ meetingId, userId }: { meetingId: string; userId: string }) {
  const m = await requireHostOrCoHost(meetingId, userId);
  return m.publicLinkToken
    ? { enabled: true, token: m.publicLinkToken }
    : { enabled: false, token: null };
}

/** Revoke: the old URL stops resolving immediately. Guests already inside stay until they leave. */
export async function revokeLink({ meetingId, userId }: { meetingId: string; userId: string }) {
  const m = await requireHostOrCoHost(meetingId, userId);
  if (m.publicLinkToken) await db.meetings.setPublicLinkToken(m.id, null);
  return { enabled: false, token: null, meetingId: m.id };
}

/**
 * What the lobby page may show a stranger holding the link. Deliberately thin:
 * the meeting title, who is hosting and which organisation it belongs to — enough
 * to confirm they are in the right place — and nothing about attendees.
 */
export async function describeLink(token: string, deviceId?: string | null) {
  if (!looksLikePublicToken(token)) return null;
  const m = await db.meetings.getByPublicToken(token);
  if (!m) return null;
  const [host, org, identity] = await Promise.all([
    m.createdBy ? db.users.getById(m.createdBy).catch(() => null) : null,
    m.organizationId ? db.orgs.getById(m.organizationId).catch(() => null) : null,
    findGuestIdentity(m.id, deviceId),
  ]);
  return {
    // This browser profile already joined this meeting: the lobby shows the
    // name it used and will rejoin as that same guest (see joinAsGuest).
    identity:
      identity && identity.user ? { name: rawGuestName(identity.user.name), joinCount: identity.joinCount } : null,
    meetingId: m.id,
    title: m.title || "Meeting",
    hostName: (host && host.name) || null,
    organizationName: (org && org.name) || null,
    startsAt: m.startsAt,
    durationMin: m.durationMin,
    ended: await isClosedForJoin(m),
    lobby: (m.lobbyPolicy || "everyone") !== "everyone" || !!m.lobbyEnabled,
  };
}

/**
 * Mint a guest identity + session for the meeting behind `token`. The caller
 * (the lobby's Join button) then enters the room with the returned bearer token
 * through the normal endpoints.
 */
export async function joinAsGuest({
  token,
  name,
  deviceId,
  ip,
  userAgent,
}: {
  token: string;
  name: unknown;
  /** Persistent browser-profile id from the lobby (lib/guestDevice.ts). */
  deviceId?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}) {
  const nm = normalizeGuestName(name);
  if (!nm.ok) throw httpError(400, "INVALID_NAME", nm.message);
  if (!looksLikePublicToken(token)) throw httpError(404, "NOT_FOUND", "This meeting link isn't valid.");
  const m = await db.meetings.getByPublicToken(token);
  if (!m) throw httpError(404, "NOT_FOUND", "This meeting link isn't valid or was turned off.");
  if (await isClosedForJoin(m)) throw httpError(410, "MEETING_ENDED", "This meeting has ended.");

  // ── One identity per browser profile per meeting ──────────────────────────
  // The same browser coming back (refresh, reconnect, a second join under a
  // different name) reuses the guest user it was given the first time, so the
  // roster and the attendance log never show the same person twice. The ORIGINAL
  // display name is kept; the client is told so it can show it. A browser that
  // can't send a device id (storage blocked, very old page) gets a fresh identity
  // per join, exactly as before.
  const dev = looksLikeDeviceId(deviceId) ? deviceId : null;
  const existing = dev ? await findGuestIdentity(m.id, dev) : null;

  let user: any;
  let resumed = false;
  if (existing && existing.user) {
    user = existing.user;
    resumed = true;
    await db.meetings.bindGuestDevice({ meetingId: m.id, deviceId: dev, userId: user.id }).catch(() => null);
  } else {
    const id = randomUUID();
    const display = (nm.name as string) + GUEST_SUFFIX;
    user = await db.users.upsert({
      id,
      email: `guest+${id}@guest.invalid`,
      name: display,
      initials: initialsOf(nm.name as string),
      color: COLORS[randomBytes(1)[0] % COLORS.length],
      avatarUrl: null,
      role: "guest",
      presence: "off",
      passwordHash: null,
    });
    if (dev && existing && existing.stale) {
      // The binding's guest row was deleted: point it at the new guest.
      await db.meetings.rebindGuestDevice({ meetingId: m.id, deviceId: dev, userId: id }).catch(() => null);
    } else if (dev) {
      // Two tabs of the same browser joining at once race on the binding; the
      // first writer wins and the other tab adopts that identity (its own fresh
      // row is simply never used — no session is ever minted for it).
      const bound = await db.meetings.bindGuestDevice({ meetingId: m.id, deviceId: dev, userId: id }).catch(() => null);
      if (bound && !bound.userDeleted && bound.userId !== id) {
        const winner = await db.users.getById(bound.userId).catch(() => null);
        if (winner && winner.role === "guest") {
          user = winner;
          resumed = true;
        }
      }
    }
  }
  const id: string = user.id;
  const display: string = user.name;

  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + GUEST_TTL_HOURS * 3600_000);
  await db.sessions.create({
    id: jti,
    userId: id,
    deviceLabel: "Guest (browser)",
    deviceType: "desktop",
    userAgent: userAgent || null,
    ip: ip || null,
    platform: "web",
    expiresAt,
  });
  // The tenant comes from the MEETING row, never from the client. A meeting that
  // pre-dates organisations (organization_id NULL) simply yields an org-less
  // session, exactly like a legacy member session.
  if (m.organizationId) await db.sessions.setActiveOrg(jti, id, m.organizationId);

  const bearer = jwt.sign(
    { sub: id, name: display, jti, guest: true, mid: m.id },
    config.auth.jwtSecret,
    { expiresIn: `${GUEST_TTL_HOURS}h` },
  );
  return {
    token: bearer,
    user: pubUser(user),
    meetingId: m.id,
    expiresAt: expiresAt.toISOString(),
    // true when this browser profile had already joined: the identity (and its
    // original name) was reused rather than a second participant being created.
    resumed,
    // the name the guest is in the meeting under, without the "(Guest)" suffix
    name: rawGuestName(display),
  };
}
