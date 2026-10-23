import jwt from "jsonwebtoken";
import { randomBytes, scryptSync, timingSafeEqual, createHash, randomUUID } from "crypto";
import { config, db } from "../platform";
import { pubUser } from "../serialize";
import { validateEmail, validatePassword, normalizeEmail } from "./credentialPolicy";
import * as mfa from "./mfaService";

// Durable session window (#66). The access token rotates every ~tokenTtl (short),
// but the SESSION row anchors stay-logged-in for ~30 days. A request whose session
// is past this is 401'd by the auth middleware; the user re-logs and gets a fresh
// session. Tunable via AUTH_SESSION_TTL_DAYS but defaulted here so it is one value.
const SESSION_TTL_DAYS = Math.max(1, Number(process.env.AUTH_SESSION_TTL_DAYS) || 30);

// Concurrent-session limit — MANAGED multi-device (Teams/Slack/Google style), NOT
// one-login-only. Default 5; 0 = unlimited. When at the cap the login returns the
// device list so the client can prompt (sign out oldest / choose / cancel) — we
// NEVER silently remove a session. (Org-admin per-tenant override lands in the
// admin-console phase; this env is the global default.)
const MAX_SESSIONS_DEFAULT = Math.max(0, Number(process.env.AUTH_MAX_SESSIONS ?? 5));
// Effective per-login cap. A per-ORG override (Phase 4, resolved from the user's
// orgs — most-restrictive wins) takes precedence when set (>=0, where 0 =
// unlimited); otherwise the global env default applies. NULL/undefined = inherit.
function maxSessionsFor(orgLimit?: number | null): number {
  if (orgLimit !== undefined && orgLimit !== null && Number.isFinite(orgLimit) && orgLimit >= 0)
    return Math.max(0, Math.floor(orgLimit));
  return MAX_SESSIONS_DEFAULT;
}

// Parse best-effort STRUCTURED device info from the user-agent — display +
// suspicious-login input only, NEVER used for authz. Desktop is detected from the
// Electron UA token (the shared web app runs inside Electron) or an explicit
// platform hint from the route. Returns the coarse label too (back-compat with
// the device_label column + older rows).
function parseDevice(
  ua: string,
  platform?: string,
): { label: string; deviceType: string; browser: string; os: string } {
  const s = String(ua || "");
  let os = "Unknown";
  if (/Windows/i.test(s)) os = "Windows";
  else if (/Mac OS X|Macintosh/i.test(s)) os = "macOS";
  else if (/Android/i.test(s)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(s)) os = "iOS";
  else if (/Linux/i.test(s)) os = "Linux";
  const isDesktopApp = platform === "desktop" || /Electron/i.test(s);
  let deviceType = "web";
  if (isDesktopApp) deviceType = "desktop";
  else if (/iPad|Tablet/i.test(s)) deviceType = "tablet";
  else if (/Mobile|Android|iPhone|iPod/i.test(s)) deviceType = "mobile";
  else if (os === "Windows" || os === "macOS" || os === "Linux") deviceType = "desktop";
  let browser = "Browser";
  if (isDesktopApp) browser = "Desktop app";
  else if (/Edg\//i.test(s)) browser = "Edge";
  else if (/OPR\//i.test(s)) browser = "Opera";
  else if (/Chrome\//i.test(s)) browser = "Chrome";
  else if (/Firefox\//i.test(s)) browser = "Firefox";
  else if (/Safari\//i.test(s)) browser = "Safari";
  const label = isDesktopApp ? "Desktop app on " + os : browser + " on " + os;
  return { label, deviceType, browser, os };
}

// Request context captured at login/signup for the session row. Extracted from the
// Express req by the route (so the service stays HTTP-framework-agnostic).
export interface SessionContext {
  userAgent?: string | null;
  ip?: string | null;
  platform?: string | null; // "web" | "desktop"
  city?: string | null;
  country?: string | null;
}

// Best-effort approximate geo from proxy/CDN headers (Cloudflare, Vercel, or a
// custom X-Geo-* set by the ingress). Display + suspicious-login input only; a
// deployment without a geo-injecting proxy simply gets nulls.
function geoFrom(req: any): { city: string | null; country: string | null } {
  const h = (req && req.headers) || {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = h[k];
      const s = v == null ? "" : String(Array.isArray(v) ? v[0] : v).trim();
      if (s && s.toUpperCase() !== "XX" && s.toUpperCase() !== "UNKNOWN")
        return s.slice(0, 96);
    }
    return null;
  };
  return {
    country: pick("cf-ipcountry", "x-vercel-ip-country", "x-geo-country", "x-country-code"),
    city: pick("cf-ipcity", "x-vercel-ip-city", "x-geo-city"),
  };
}

// Pull the session context off an Express request — first X-Forwarded-For hop for
// the IP (the app trusts the proxy), the UA header, a desktop hint from either an
// explicit X-CoLab-Platform header or an Electron user-agent, and best-effort geo.
function sessionContextFrom(req: any): SessionContext {
  if (!req || !req.headers) return {};
  const xf = String(req.headers["x-forwarded-for"] || "");
  const ip = xf.split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || null;
  const ua = (req.headers["user-agent"] as string) || null;
  const hinted = String(req.headers["x-colab-platform"] || "").toLowerCase();
  const platform =
    hinted === "desktop" || (ua && /Electron/i.test(ua)) ? "desktop" : "web";
  const geo = geoFrom(req);
  return { userAgent: ua, ip, platform, city: geo.city, country: geo.country };
}

// Mint a durable session row and return its id (the JWT jti). FAIL-SOFT: a sessions
// table hiccup must never block login — we just mint an un-tracked (jti-less) token,
// exactly like a legacy token, which the middleware accepts. Returns null on failure.
async function createSession(userId: string, ctx: SessionContext = {}): Promise<string | null> {
  try {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const dev = parseDevice(ctx.userAgent || "", ctx.platform || undefined);
    await db.sessions.create({
      id,
      userId,
      deviceLabel: dev.label,
      deviceType: dev.deviceType,
      browser: dev.browser,
      os: dev.os,
      userAgent: ctx.userAgent || null,
      ip: ctx.ip || null,
      city: ctx.city || null,
      country: ctx.country || null,
      platform: ctx.platform === "desktop" ? "desktop" : "web",
      expiresAt,
    });
    return id;
  } catch (_) {
    return null;
  }
}

// Suspicious-login analysis: compare the just-created session to the user's OTHER
// active sessions. Returns human-readable reasons (empty = looks normal, or this
// is the user's first device). Best-effort; never throws. Used to flavour the
// "new sign-in" notification (and future MFA step-up hooks).
async function analyzeLoginSecurity(
  userId: string,
  newJti: string | null,
): Promise<{ reasons: string[]; session: any | null }> {
  const reasons: string[] = [];
  let session: any = null;
  try {
    const rows = (await db.sessions.listForUser(userId)) || [];
    session = rows.find((s: any) => s.id === newJti) || null;
    if (!session) return { reasons, session: null };
    const others = rows.filter((s: any) => s.id !== newJti && !s.revoked);
    if (!others.length) return { reasons, session }; // first device — nothing to compare
    const seenBefore = (key: string, val: any) =>
      !val ||
      others.some(
        (s: any) => String(s[key] || "").toLowerCase() === String(val).toLowerCase(),
      );
    if (session.country && !seenBefore("country", session.country))
      reasons.push("a new location (" + session.country + ")");
    if (session.deviceType && !seenBefore("deviceType", session.deviceType))
      reasons.push("a new device type");
    if (session.browser && !seenBefore("browser", session.browser))
      reasons.push("an unrecognised browser");
    if (session.os && !seenBefore("os", session.os))
      reasons.push("a new operating system");
  } catch (_) {
    /* best-effort */
  }
  return { reasons, session };
}

// Password hashing: Node's built-in scrypt (no native/extra deps). Stored as
// "saltHex:hashHex". verifyPassword recomputes with the stored salt.
function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return salt.toString("hex") + ":" + scryptSync(pw, salt, 64).toString("hex");
}
function verifyPassword(pw: string, stored: string): boolean {
  if (!stored || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  let actual: Buffer;
  try {
    actual = scryptSync(pw, Buffer.from(saltHex, "hex"), expected.length);
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function tokenFor(user, deviceId?: string, jti?: string) {
  const payload: any = { sub: user.id, name: user.name };
  // Bind the durable session id as the standard JWT `jti` (#66) so the middleware
  // can look the session up and reject a revoked/expired one. Backward-compatible:
  // a token minted WITHOUT a jti (legacy, or when session creation failed) is still
  // valid — the middleware only enforces when a jti is present.
  if (jti) payload.jti = String(jti);
  // Bind the caller's E2EE device into the token so a revoked device can be cut
  // off at the API layer (enforced in auth middleware, only when E2EE is on).
  // Validate OWNERSHIP at mint time: only bind a device that exists, belongs to
  // THIS user, and isn't revoked. The client sends whatever id is in its
  // localStorage, which after prior testing / a wipe can be a stale, foreign, or
  // unknown id — binding it blindly mints a token asserting a device the user
  // may not own. Today the permissive auth middleware drops such a claim, but if
  // device-bound STRICT mode is ever enabled it would 401-bounce these users on
  // every request. Validating here closes that before strict mode can be flipped.
  if (deviceId) {
    try {
      const dev = await db.e2ee.getDevice(String(deviceId));
      if (dev && dev.userId === user.id && !dev.revoked) {
        payload.deviceId = String(deviceId);
      }
    } catch (_) {
      /* DB blip → mint an unbound token; the permissive default tolerates it */
    }
  }
  return jwt.sign(payload, config.auth.jwtSecret, {
    expiresIn: config.auth.tokenTtl,
  });
}

// ── Refresh-token rotation (Session Mgmt Phase 5) ───────────────────────────
// Opaque, single-use refresh tokens bound to a session (the jti "family"). Stored
// hashed. issueRefreshToken mints one at login; rotateRefreshToken exchanges a
// valid one for a fresh access token + a NEW refresh token, detecting replay.
// Additive + fail-safe: login never fails if a refresh token can't be minted, and
// a revoked/expired SESSION makes its refresh tokens unusable automatically (the
// rotate path re-checks the session), so no revoke site needs to touch them.
const REFRESH_REUSE_GRACE_MS = Math.max(
  0,
  Number(process.env.AUTH_REFRESH_GRACE_MS ?? 60000),
);
async function issueRefreshToken(
  sessionId: string,
  userId: string,
  expiresAt?: Date,
): Promise<string | null> {
  try {
    if (!sessionId || !userId || !db.refreshTokens) return null;
    const raw = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(raw).digest("hex");
    const exp =
      expiresAt ||
      new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    await db.refreshTokens.issue({ id: randomUUID(), sessionId, userId, tokenHash: hash, expiresAt: exp });
    return raw;
  } catch (_) {
    return null; // additive — a refresh-store hiccup must never fail login
  }
}
// Returns one of:
//   { token, refreshToken, user, sessionId } — rotated OK.
//   { retry: true }        — a benign concurrent/just-rotated presentation; the
//                            caller should NOT log out (another rotation already
//                            issued the new token). Never revokes anything.
//   { reuse: true, sessionId } — a genuine replay (used token beyond the grace
//                            window) ⇒ token theft; the caller kills the family.
//   null                   — unknown / revoked / expired token or dead session.
type RotateResult =
  | { token: string; refreshToken: string; user: any; sessionId: string }
  | { retry: true }
  | { reuse: true; sessionId: string }
  | null;
async function rotateRefreshToken(rawToken: string, deviceId?: string): Promise<RotateResult> {
  const raw = String(rawToken || "");
  if (!raw || !db.refreshTokens) return null;
  const hash = createHash("sha256").update(raw).digest("hex");
  let row: any;
  try {
    row = await db.refreshTokens.findByHash(hash);
  } catch (_) {
    return null;
  }
  if (!row || row.revoked) return null;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) return null;
  if (row.used) {
    const usedMs = row.usedAt ? new Date(row.usedAt).getTime() : 0;
    if (usedMs && Date.now() - usedMs <= REFRESH_REUSE_GRACE_MS) return { retry: true };
    return { reuse: true, sessionId: row.sessionId };
  }
  // The refresh token is only as alive as its SESSION — re-check before minting a
  // new access token, so a revoked/expired session can't be refreshed back to life.
  let sess: any;
  try {
    sess = await db.sessions.getForAuth(row.sessionId);
  } catch (_) {
    sess = null;
  }
  if (!sess || sess.revoked) return null;
  if (sess.expiresAt && new Date(sess.expiresAt).getTime() <= Date.now()) return null;
  // Single-use guard: only the winner of the atomic 0→1 flip rotates.
  let won = false;
  try {
    won = await db.refreshTokens.markUsed(row.id);
  } catch (_) {
    won = false;
  }
  if (!won) return { retry: true };
  const user = await db.users.getById(row.userId);
  // Reject a soft-deleted account: getById (unlike getByEmail) does NOT filter
  // deleted, so guard here — a deleted user must never rotate a fresh token, even
  // if a stale session row somehow survived (defence-in-depth; account deletion
  // also revokes sessions + refresh tokens up front).
  if (!user || (user as any).deleted) return null;
  const fresh = await issueRefreshToken(row.sessionId, row.userId);
  const token = await tokenFor(user, deviceId, row.sessionId);
  return { token, refreshToken: fresh || "", user: pubUser(user), sessionId: row.sessionId };
}
function httpErr(status, message) {
  const e: any = new Error(message);
  e.status = status;
  return e;
}
const PALETTE = [
  "#2563EB",
  "#7C3AED",
  "#047857",
  "#DC2626",
  "#D946EF",
  "#0891B2",
];
function deriveIdentity(email, name) {
  const local = email.split("@")[0] || "user";
  const nm =
    (name && String(name).trim()) ||
    local.replace(/[._-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  const initials =
    nm
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "U";
  let sum = 0;
  for (let i = 0; i < email.length; i++) sum += email.charCodeAt(i);
  return { nm, initials, color: PALETTE[sum % PALETTE.length] };
}
// users.id is VARCHAR(36): a long email's derived id would overflow the column
// and surface as a raw HTTP 500 ("Data too long") at signup. Keep the readable
// id when it fits; for a long email, cap a readable prefix + a deterministic
// short hash so the id stays unique and <= 36 chars. Only affects NEW long-email
// signups — login looks up by email, and existing users keep their stored id.
const idFromEmail = (mail) => {
  const base = "u_" + mail.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (base.length <= 36) return base;
  const h = createHash("sha1").update(mail).digest("hex").slice(0, 8);
  return base.slice(0, 27) + "_" + h; // 27 + 1 + 8 = 36
};

// Create (or claim) a local password account. The shared primitive behind BOTH
// public signup and admin provisioning: enforces the enterprise credential policy
// (server-side authority — a client can't bypass it), hashes the password, and
// upserts the user. Returns the user row and mints NO session — the caller decides
// whether this is a self-signup (log them in) or an admin provisioning it for
// someone else (no session; they log in later).
async function createLocalUser({
  email,
  name,
  password,
}: {
  email: string;
  name?: string;
  password: string;
}) {
  const mail = normalizeEmail(email);
  const emailIssue = validateEmail(mail);
  if (emailIssue) throw httpErr(400, emailIssue.message);
  const pwIssue = validatePassword(password, { email: mail, name });
  if (pwIssue) throw httpErr(400, pwIssue.message);
  const existing = await db.users.getByEmail(mail);
  if (existing && existing.passwordHash)
    throw httpErr(409, "That email is already registered.");
  const { nm, initials, color } = deriveIdentity(mail, name);
  return db.users.upsert({
    id: existing ? existing.id : idFromEmail(mail),
    email: mail,
    name: existing && !name ? existing.name : nm,
    initials: existing?.initials || initials,
    color: existing?.color || color,
    avatarUrl: existing?.avatarUrl || "",
    role: existing?.role || "member",
    // Provisioned/just-created — real presence is set when they actually connect.
    presence: "offline",
    passwordHash: hashPassword(String(password)),
  });
}

// Public self-service sign-up. Gated by config.auth.signupEnabled: with SSO +
// admin-provisioned accounts (the enterprise default) this is OFF and the route
// returns 403 — no anonymous self-registration, even by calling the API directly.
async function signup(
  { email, name, password, deviceId = undefined }: any,
  ctx: SessionContext = {},
) {
  if (!config.auth.signupEnabled)
    throw httpErr(
      403,
      "Self-service sign-up is disabled. Ask your administrator to create your account, or sign in with SSO.",
    );
  const user = await createLocalUser({ email, name, password });
  const jti = await createSession(user.id, ctx);
  const refreshToken = jti ? await issueRefreshToken(jti, user.id) : null;
  return { token: await tokenFor(user, deviceId, jti || undefined), user: pubUser(user), sessionId: jti || null, refreshToken };
}

// Verify credentials against the stored password hash.
// ── Enterprise role bootstrap ────────────────────────────────────────────────
// ORG_BOOTSTRAP_OWNERS: comma-separated emails auto-elevated to OWNER of the default
// org on every sign-in (SSO or password). Solves the SSO first-admin chicken-and-egg:
// SSO users auto-join as 'member', so without a seeded owner nobody could ever manage
// the org. Elevate-only — never demotes.
function bootstrapOwnerEmails(): Set<string> {
  return new Set(
    (process.env.ORG_BOOTSTRAP_OWNERS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}
// SSO_GROUP_ROLE_MAP: "IdpGroupA:admin,IdpGroupB:director" — maps IdP group/role claims
// to org roles so SSO users land in the RIGHT role instead of a flat 'member' (needs
// the IdP to send a `groups`/`roles` claim). Returns the HIGHEST-ranked match, or null.
function roleFromGroups(groups: string[]): string | null {
  const raw = process.env.SSO_GROUP_ROLE_MAP || "";
  if (!raw || !Array.isArray(groups) || !groups.length) return null;
  const rank: Record<string, number> = {
    owner: 100, admin: 80, member: 40, guest: 20,
  };
  const map = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const [g, r] = pair.split(":").map((s) => (s || "").trim());
    if (g && r) map.set(g.toLowerCase(), r.toLowerCase());
  }
  let best: string | null = null;
  for (const g of groups) {
    const role = map.get(String(g).toLowerCase());
    if (role && (!best || (rank[role] || 0) > (rank[best] || 0))) best = role;
  }
  return best;
}
// Ensure a bootstrap-owner email is OWNER of the default org (elevate-only, best-effort).
async function ensureBootstrapOwner(userId: string, email: string): Promise<void> {
  try {
    if (!bootstrapOwnerEmails().has((email || "").toLowerCase())) return;
    if (!db.orgs?.defaultOrg) return;
    const org = await db.orgs.defaultOrg();
    if (!org) return;
    const m = await db.orgs.membership(userId, org.id);
    if (!m || m.role !== "owner") await db.orgs.addMember(org.id, userId, "owner");
  } catch (_) {
    /* best-effort */
  }
}

// Concurrent-session limit gate. The client may pass evictSessionId (a device it
// chose to sign out at the "max devices reached" prompt) — revoke it, then
// re-check. Returns { limitReached, max, sessions } when still at the cap (caller
// mints NOTHING), or null when there's room to proceed. FAIL-OPEN on count errors:
// a lookup hiccup never blocks a valid login. Per-org override (Phase 4): the
// strictest cap across the user's active orgs wins, else the env default.
async function enforceSessionLimit(user: any, evictSessionId?: string) {
  let orgLimit: number | null = null;
  try {
    orgLimit = await db.orgs.effectiveSessionLimitForUser(user.id, MAX_SESSIONS_DEFAULT);
  } catch (_) {
    orgLimit = null;
  }
  const max = maxSessionsFor(orgLimit);
  if (max <= 0) return null;
  if (evictSessionId) {
    try {
      await db.sessions.revoke(user.id, String(evictSessionId));
    } catch (_) {}
  }
  let active = 0;
  try {
    active = await db.sessions.countActive(user.id);
  } catch (_) {
    active = 0;
  }
  if (active < max) return null;
  const rows = await db.sessions.listForUser(user.id).catch(() => []);
  const sessions = (rows || [])
    .filter((s: any) => !s.revoked)
    .map((s: any) => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      platform: s.platform,
      location: [s.city, s.country].filter(Boolean).join(", ") || null,
      lastActiveAt: s.lastActiveAt,
      createdAt: s.createdAt,
    }));
  return { limitReached: true, max, sessions };
}

// Mint the durable session row + access/refresh tokens for a user who has fully
// authenticated (password + any required second factor) and cleared the cap.
async function mintSession(user: any, { deviceId, ctx }: { deviceId?: string; ctx: SessionContext }) {
  try {
    await db.users.setPresence(user.id, "online");
  } catch (_) {}
  await ensureBootstrapOwner(user.id, user.email);
  const jti = await createSession(user.id, ctx);
  const refreshToken = jti ? await issueRefreshToken(jti, user.id) : null;
  return { token: await tokenFor(user, deviceId, jti || undefined), user: pubUser(user), sessionId: jti || null, refreshToken };
}

// Session-limit check + mint, in one step. Shared by the password path (no MFA)
// and any caller that has already cleared the second factor.
async function completeLogin(
  user: any,
  { deviceId, evictSessionId, ctx }: { deviceId?: string; evictSessionId?: string; ctx: SessionContext },
) {
  const limited = await enforceSessionLimit(user, evictSessionId);
  if (limited) return limited;
  return mintSession(user, { deviceId, ctx });
}

async function login(
  { email, password, deviceId = undefined, evictSessionId = undefined }: any,
  ctx: SessionContext = {},
) {
  const mail = (email || "").toLowerCase().trim();
  const user = await db.users.getByEmail(mail);
  if (!user || !user.passwordHash)
    throw httpErr(401, "Invalid email or password.");
  if (!verifyPassword(String(password || ""), user.passwordHash))
    throw httpErr(401, "Invalid email or password.");
  // Second-factor gate. Dormant unless MFA_ENABLED and the user has enrolled —
  // then we do NOT mint a session yet; we hand back a short-lived challenge the
  // client must satisfy at /auth/mfa/verify. FAIL-CLOSED: if enrollment state
  // can't be read we refuse to mint a (possibly MFA-required) session rather than
  // silently downgrade to password-only.
  let stepUp: { method: string; challengeId: string } | null;
  try {
    stepUp = await mfa.requiresStepUp(user.id, deviceId);
  } catch (_) {
    throw httpErr(503, "Sign-in is temporarily unavailable. Please try again.");
  }
  if (stepUp) return { mfaRequired: true, challengeId: stepUp.challengeId, methods: [stepUp.method] };
  return completeLogin(user, { deviceId, evictSessionId, ctx });
}

// "Maximum devices reached" management WITHOUT completing sign-in. Verifies the
// credentials, revokes ONE chosen device, and returns the REFRESHED device list +
// cap — but never mints a session. This lets the user sign out several devices from
// the limit prompt before continuing: the normal login path evicts-and-proceeds the
// moment they drop under the cap, which is why it closed the prompt after a single
// sign-out. The client calls this per "Sign out", then hits /login (no evict) to
// finish once `underLimit` is true.
async function evictSession({ email, password, sessionId }: any) {
  const mail = (email || "").toLowerCase().trim();
  const user = await db.users.getByEmail(mail);
  if (!user || !user.passwordHash) throw httpErr(401, "Invalid email or password.");
  if (!verifyPassword(String(password || ""), user.passwordHash))
    throw httpErr(401, "Invalid email or password.");
  if (sessionId) {
    try {
      await db.sessions.revoke(user.id, String(sessionId));
    } catch (_) {}
  }
  let max = 0;
  try {
    const orgLimit = await db.orgs.effectiveSessionLimitForUser(user.id, MAX_SESSIONS_DEFAULT).catch(() => null);
    max = maxSessionsFor(orgLimit);
  } catch (_) {
    max = maxSessionsFor(null);
  }
  let active = 0;
  try {
    active = await db.sessions.countActive(user.id);
  } catch (_) {
    active = 0;
  }
  const rows = await db.sessions.listForUser(user.id).catch(() => []);
  const sessions = (rows || [])
    .filter((s: any) => !s.revoked)
    .map((s: any) => ({
      id: s.id,
      deviceLabel: s.deviceLabel,
      platform: s.platform,
      location: [s.city, s.country].filter(Boolean).join(", ") || null,
      lastActiveAt: s.lastActiveAt,
      createdAt: s.createdAt,
    }));
  // underLimit = there's room for THIS device (active count is below the cap).
  return { sessions, max, active, underLimit: max <= 0 || active < max };
}

// Complete a login that was gated on MFA: validate the challenge, then the code,
// then mint the deferred session. The challenge binds the userId (and device), so
// a code alone can never mint a session for a different account. Order matters:
// we check the device-session cap BEFORE consuming the one-time code, so hitting
// the cap doesn't burn a backup code (the client retries with evictSessionId).
async function verifyMfaLogin(
  { challengeId, code, deviceId = undefined, evictSessionId = undefined }: any,
  ctx: SessionContext = {},
) {
  const parsed = mfa.readChallenge(String(challengeId || ""));
  if (!parsed) throw httpErr(401, "That code isn't valid or has expired. Please sign in again.");
  // Re-load fresh and reject soft-deleted (getById, unlike getByEmail, does NOT
  // filter deleted — mirror rotateRefreshToken so an offboarded account can't
  // complete an in-flight MFA login).
  const user = await db.users.getById(parsed.userId);
  if (!user || (user as any).deleted) throw httpErr(401, "Account not found.");
  const limited = await enforceSessionLimit(user, evictSessionId);
  if (limited) return limited;
  const ok = await mfa.verifyCode(parsed.userId, String(code || ""));
  if (!ok) throw httpErr(401, "That code isn't valid or has expired. Please sign in again.");
  return mintSession(user, { deviceId: deviceId || parsed.deviceId, ctx });
}

function verify(token) {
  return jwt.verify(token, config.auth.jwtSecret);
}
async function me(userId) {
  return pubUser(await db.users.getById(userId));
}

// SSO sign-in (OIDC). The IdP has ALREADY authenticated the user — we trust the
// verified email claim (ssoService validates the id_token before calling this) and
// FIND-OR-CREATE a passwordless local account for it. A brand-new SSO user is
// created with NO password hash (they can only sign in via SSO); an existing
// account (password or invited) is reused as-is — we never clobber its profile or
// wipe its password (upsert COALESCEs password_hash, but we skip upsert entirely
// for an existing row). Mints the same durable session + JWT as password login.
async function ssoLogin(
  {
    email,
    name,
    groups,
    picture,
  }: { email: string; name?: string; groups?: string[]; picture?: string },
  ctx: SessionContext = {},
  deviceId?: string,
) {
  const mail = normalizeEmail(email);
  if (!mail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail))
    throw httpErr(400, "SSO identity has no usable email.");
  let user = await db.users.getByEmail(mail);
  if (!user) {
    const { nm, initials, color } = deriveIdentity(mail, name);
    user = await db.users.upsert({
      id: idFromEmail(mail),
      email: mail,
      name: nm,
      initials,
      color,
      // IdP-supplied picture (from the decrypted PII claims) seeds the avatar; the
      // user can still change it in-app afterwards.
      avatarUrl: picture || "",
      role: "member",
      presence: "online",
      // No password → passwordless, SSO-only account (upsert stores NULL).
    });
  } else {
    try {
      await db.users.setPresence(user.id, "online");
    } catch (_) {}
  }
  // Mark the account SSO-capable (idempotent). Best-effort: a stamping failure must
  // never block a valid sign-in. Drives the admin console's SSO badge and the
  // "reset password only where a local password exists" logic.
  try {
    if (db.users.setSsoEnabled && !user.ssoEnabled) {
      user = (await db.users.setSsoEnabled(user.id)) || user;
    }
  } catch (_) {}
  // ORG AUTO-JOIN (#70). A brand-new SSO user belongs to no org, so their session
  // would carry no tenant (null active org → no org context). If a default org is
  // resolvable (an explicit SSO_DEFAULT_ORG_SLUG, or the sole org on a single-tenant
  // deploy), enroll them as a plain 'member' — but ONLY when they are not already a
  // member (never demote an existing owner/admin). Best-effort: a failure here must
  // never block sign-in. Runs BEFORE createSession so active_org_id picks it up.
  try {
    if (db.orgs?.defaultOrg) {
      const boot = bootstrapOwnerEmails().has(mail);
      // ENTERPRISE ONBOARDING (Teams/Slack-style): a platform account is SEPARATE from
      // org membership. A brand-new SSO user is NO LONGER auto-enrolled into the default
      // org as a plain 'member' — they land org-less and go through Create/Join
      // onboarding. We STILL auto-provision on an EXPLICIT signal only: a bootstrap-owner
      // email (ORG_BOOTSTRAP_OWNERS) or an IdP group→role mapping (SSO_GROUP_ROLE_MAP).
      // Both are deliberate admin opt-ins — the seam future SSO/SCIM provisioning uses —
      // NOT the old "everyone silently becomes a Resulticks member" default.
      const mappedRole = boot ? "owner" : roleFromGroups(groups || []);
      if (mappedRole) {
        const org = await db.orgs.defaultOrg();
        if (org) {
          const m = await db.orgs.membership(user.id, org.id);
          if (!m || m.status !== "active") {
            await db.orgs.addMember(org.id, user.id, mappedRole);
          } else if (boot && m.role !== "owner") {
            await db.orgs.addMember(org.id, user.id, "owner"); // elevate-only, never demote
          }
        }
      }
    }
  } catch (_) {
    /* auto-provision/elevate is best-effort; sign-in proceeds regardless */
  }
  // App-level MFA applies regardless of auth method: an enrolled user signing in
  // via SSO still owes their second factor (the IdP proving identity ≠ the app's
  // enrolled TOTP). Dormant unless MFA_ENABLED. FAIL-CLOSED on a lookup error.
  let stepUp: { method: string; challengeId: string } | null;
  try {
    stepUp = await mfa.requiresStepUp(user.id);
  } catch (_) {
    throw httpErr(503, "Sign-in is temporarily unavailable. Please try again.");
  }
  if (stepUp) return { mfaRequired: true, challengeId: stepUp.challengeId, methods: [stepUp.method] };
  const jti = await createSession(user.id, ctx);
  const refreshToken = jti ? await issueRefreshToken(jti, user.id) : null;
  // Bind the device id into the token (tokenFor only honors a device that exists,
  // belongs to this user, and isn't revoked — so an unknown/stale id is ignored,
  // never a security hole). This keeps E2EE history-sync alive on SSO sessions.
  return { token: await tokenFor(user, deviceId || undefined, jti || undefined), user: pubUser(user), sessionId: jti || null, refreshToken };
}

// Admin-initiated password reset — the SECURE answer to "a user forgot their
// password". Passwords are one-way scrypt hashes (by design, so a DB/backend
// compromise can never yield plaintext), which is exactly why recovery is a *reset*,
// not a decrypt: an admin sets a NEW password and hands it over. This validates the
// new password against the same strength policy as sign-up, re-hashes it, and stores
// it. The ROUTE layer gates this behind [members:manage] + a same-org/rank check.
async function setUserPassword(userId: string, newPassword: string) {
  const user = await db.users.getById(userId);
  if (!user) throw httpErr(404, "User not found.");
  const pwIssue = validatePassword(newPassword, { email: user.email, name: user.name });
  if (pwIssue) throw httpErr(400, pwIssue.message);
  await db.users.updatePassword(userId, hashPassword(String(newPassword)));
  // Force sign-out everywhere: revoke all active sessions so the old token is rejected
  // on its next request across every device and the user must re-authenticate with the
  // NEW password. Best-effort — the password change is the primary effect and must not
  // be reported as failed (losing the admin's copy of the new password) if this cleanup
  // query hiccups.
  try {
    await db.sessions.revokeAllForUser(userId);
  } catch (e) {
    console.warn("[auth] setUserPassword: session revoke failed for", userId, e);
  }
  // Mobile push K4: every session is dead, so every phone registration is too —
  // the app re-registers on its next login.
  try { await db.pushDevices.removeForUser(userId); } catch (_) {}
  return { userId, email: user.email, name: user.name };
}

export {
  signup,
  createLocalUser,
  login,
  evictSession,
  verifyMfaLogin,
  ssoLogin,
  verify,
  me,
  sessionContextFrom,
  analyzeLoginSecurity,
  setUserPassword,
  issueRefreshToken,
  rotateRefreshToken,
};
