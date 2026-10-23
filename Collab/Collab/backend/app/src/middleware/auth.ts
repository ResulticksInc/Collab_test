import { fail, db, config, e2eeEnabled, e2eeDeviceBoundStrict, orgContext } from "../platform";
import * as authService from "../services/authService";
import { isBlocked } from "../services/tokenBlocklist";

// Short-TTL cache of device revocation state so the device-binding check (below)
// does not add a DB round-trip to every authenticated request. Lag on revoke is
// bounded by the TTL; the E2EE key-fan-out exclusion is immediate regardless.
const DEVICE_TTL_MS = 30_000;
const deviceCache = new Map<string, { userId: string | null; revoked: boolean; ts: number }>();

// Stale-device pruning input: stamp e2ee_devices.last_seen_at whenever a
// device-bound token makes an authenticated request, so an actively-used device
// can never be classed as stale by the fan-out filter (e2eeService.bundleFor).
// Throttled in-process to one attempt per device per 15 min (the SQL itself
// self-throttles to 1h) and FIRE-AND-FORGET — never blocks or fails a request.
const TOUCH_GAP_MS = 15 * 60_000;
const deviceTouched = new Map<string, number>();
// Negative cache for LAZY ORG ADOPTION (see the auth handler). Users who really
// belong to no org — legacy/single-tenant deploys, or someone mid-onboarding —
// would otherwise re-run the lookup on EVERY request. Short TTL so a member who
// was just added/approved is picked up within a minute without a re-login.
const NO_ORG_TTL_MS = 60_000;
const noOrgUntil = new Map<string, number>();
function touchDeviceSeen(deviceId: string) {
  const now = Date.now();
  const last = deviceTouched.get(deviceId) || 0;
  if (now - last < TOUCH_GAP_MS) return;
  deviceTouched.set(deviceId, now);
  if (deviceTouched.size > 10_000) deviceTouched.clear(); // bound memory
  Promise.resolve(db.e2ee.touchDevice?.(deviceId)).catch(() => {});
}

async function deviceState(deviceId: string) {
  const now = Date.now();
  const hit = deviceCache.get(deviceId);
  if (hit && now - hit.ts < DEVICE_TTL_MS) return hit;
  const dev = await db.e2ee.getDevice(deviceId);
  const state = { userId: dev ? dev.userId : null, revoked: !!(dev && dev.revoked), ts: now };
  deviceCache.set(deviceId, state);
  return state;
}

// SESSION ENFORCEMENT (#66). When a token carries a `jti` (the durable session id),
// validate that the session is neither revoked nor expired on EVERY authed request.
// Design constraints, in order of importance:
//   • CHEAP: a single PK lookup (getForAuth), plus a THROTTLED last-active write
//     gated to <= 1 per `LAST_ACTIVE_GAP_SEC` per session (fire-and-forget — never
//     blocks the response).
//   • FAIL-OPEN: if the lookup THROWS (a sessions-table/DB hiccup) we ALLOW the
//     request and log — a transient infra blip must NEVER mass-log-out everyone.
//   • Still REJECT a genuinely revoked or expired session (a real "row says no",
//     not an error).
//   • BACKWARD-COMPATIBLE: a token WITHOUT a jti (every pre-#66 token) skips this
//     entirely and is allowed, exactly as before.
const LAST_ACTIVE_GAP_SEC = 60;
// Per-process throttle of the last-active write so a burst of requests for the same
// session does not even issue the (already gap-guarded) UPDATE. Bounded in size by
// natural session turnover; entries are tiny.
const lastTouchAt = new Map<string, number>();

// ORG MEMBERSHIP GATE (#68). When a session asserts an active org, verify the user
// is STILL an active member of it — a stale active_org_id (the user was removed, or
// a forged/replayed switch) must NOT silently grant tenant access. Cached like the
// device/session checks so it costs one PK lookup per (user,org) per TTL.
//   • returns true  — an active membership row exists.
//   • returns false — the row DEFINITIVELY says no (no row / not active) → fail CLOSED.
//   • on a lookup ERROR — serve a recent cached decision if we have one
//     (stale-while-error, so a DB blip doesn't mass-reject legit members),
//     otherwise fail CLOSED (deny) — a stale/forged active_org_id must never grant
//     tenant access just because the check errored. The app is DB-bound anyway, so
//     failing closed here can't reduce availability beyond a real DB outage.
const MEMBERSHIP_TTL_MS = 30_000;
const membershipCache = new Map<string, { member: boolean; ts: number }>();
async function isActiveMember(userId: string, orgId: string): Promise<boolean> {
  const key = `${userId}|${orgId}`;
  const now = Date.now();
  const hit = membershipCache.get(key);
  if (hit && now - hit.ts < MEMBERSHIP_TTL_MS) return hit.member;
  let m: any;
  try {
    m = await db.orgs.membership(userId, orgId);
  } catch {
    // Lookup error: one quick retry first — a pool blip on a cold cache used to
    // 403 a legitimate member's request (client then saw "removed from org").
    try {
      await new Promise((r) => setTimeout(r, 150));
      m = await db.orgs.membership(userId, orgId);
    } catch {
      // Still failing: fall back to any prior decision (even if just-expired);
      // with no cache to lean on, fail CLOSED.
      return hit ? hit.member : false;
    }
  }
  const member = !!(m && m.status === "active");
  membershipCache.set(key, { member, ts: now });
  return member;
}

// Org removal must not wait out the membership cache: the removal flow calls
// this so the removed user's very next request re-checks the DB and 403s
// immediately instead of riding the cached "member" for up to 30 more seconds.
export function invalidateMembership(userId: string, orgId: string) {
  membershipCache.delete(`${userId}|${orgId}`);
}

// Returns:
//   "ok"      — no jti, OR a valid (not revoked / not expired) session, OR the
//               lookup failed (fail-open). The request proceeds.
//   "revoked" — the session row exists and is explicitly revoked.
//   "expired" — the session row exists and is past expires_at.
// A jti with NO matching row is treated as "ok" (a legacy/foreign/unknown jti is not
// proof of revocation — only an explicit revoked/expired row rejects).
type SessionCheck = { state: "ok" | "revoked" | "expired" | "unavailable"; activeOrgId: string | null };
// Last successful lookup per jti. A DB blip is bridged for SESSION_GRACE_MS from
// a prior good answer; with no recent answer to lean on we fail CLOSED (503), so
// a revoked session can't ride an outage indefinitely.
const SESSION_GRACE_MS = 5 * 60_000;
const lastGoodSession = new Map<string, { at: number; activeOrgId: string | null }>();
async function sessionState(jti: string): Promise<SessionCheck> {
  let s: any;
  try {
    s = await db.sessions.getForAuth(jti);
  } catch (e) {
    const good = lastGoodSession.get(jti);
    if (good && Date.now() - good.at < SESSION_GRACE_MS) {
      console.warn("[auth] session lookup failed — within grace window:", (e as any)?.message || e);
      return { state: "ok", activeOrgId: good.activeOrgId };
    }
    console.warn("[auth] session lookup failed — failing closed:", (e as any)?.message || e);
    return { state: "unavailable", activeOrgId: null };
  }
  if (lastGoodSession.size > 20_000) lastGoodSession.clear(); // bound memory
  lastGoodSession.set(jti, { at: Date.now(), activeOrgId: s?.activeOrgId || null });
  if (!s) return { state: "ok", activeOrgId: null }; // unknown jti → not proof of revocation
  if (s.revoked) return { state: "revoked", activeOrgId: null };
  if (s.expiresAt && new Date(s.expiresAt).getTime() <= Date.now())
    return { state: "expired", activeOrgId: null };
  // Throttled, fire-and-forget last-active bump (never blocks; never throws up).
  const now = Date.now();
  const last = lastTouchAt.get(jti) || 0;
  if (now - last >= LAST_ACTIVE_GAP_SEC * 1000) {
    lastTouchAt.set(jti, now);
    Promise.resolve(db.sessions.touch(jti, LAST_ACTIVE_GAP_SEC)).catch(() => {});
  }
  // Organizations: surface the session's active tenant (reuses THIS lookup — no extra
  // query). NULL on a legacy session — the request just carries no org until re-login.
  return { state: "ok", activeOrgId: s.activeOrgId || null };
}

// ── PUBLIC-LINK GUESTS ──────────────────────────────────────────────────────
// A guest token ({ guest:true, mid:<meetingId> }, minted by guestMeetingService
// when someone joins through a meeting's public link) is a deliberately NARROW
// credential. It authenticates a real `users` row, but that row has no org
// membership and the token may only ever call the handful of endpoints that run
// the in-meeting experience for THE ONE meeting it was minted for. Everything
// else — conversations, files, directory, settings, other meetings — is refused
// here, before any route code runs, so a new route is closed to guests by
// default rather than open until someone remembers to guard it.
//
// Each entry: [method, path pattern under /api]. `:mid` must equal the token's
// meeting (recurring occurrences "<id>__occ_N" resolve to their series id).
const GUEST_ROUTES: Array<[string, RegExp]> = [
  ["POST", /^\/meetings\/([^/]+)\/room\/(enter|heartbeat|leave)$/],
  ["GET", /^\/meetings\/([^/]+)\/lobby\/self$/],
  ["GET", /^\/meetings\/([^/]+)\/options$/],
  ["GET", /^\/meetings\/([^/]+)\/polls$/],
  ["POST", /^\/meetings\/([^/]+)\/polls\/[^/]+\/vote$/],
  // Ending the guest session on leave (revokes the session row, drops sockets).
  ["POST", /^\/auth\/logout$/],
];
const baseMeetingId = (id: unknown) => String(id || "").split("__occ_")[0];

function guestMayCall(req: any, meetingId: string): boolean {
  const prefix = config.constants.api.prefix;
  const full = String(req.originalUrl || req.url || "").split("?")[0].replace(/\/$/, "");
  const path = full.startsWith(prefix) ? full.slice(prefix.length) : full;
  const method = String(req.method || "").toUpperCase();
  for (const [m, re] of GUEST_ROUTES) {
    if (m !== method) continue;
    const hit = re.exec(path);
    if (hit) {
      if (hit[1] === undefined) return true;
      try {
        return baseMeetingId(decodeURIComponent(hit[1])) === meetingId;
      } catch {
        return false; // malformed %-escape — not our meeting
      }
    }
  }
  const body = req.body || {};
  // The LiveKit token for the guest's own meeting — never a call or a chat room.
  if (method === "POST" && path === "/calls/token")
    return !body.callId && !body.conversationId && baseMeetingId(body.meetingId) === meetingId;
  // Self-mute reporting for the guest's own meeting room.
  if (method === "POST" && path === "/calls/media/self-mute-state")
    return typeof body.room === "string" && baseMeetingId(body.room.replace(/^meeting_/, "")) === meetingId && body.room.startsWith("meeting_");
  return false;
}

async function guestAuth(req, res, next, p: any) {
  // A guest session is ALWAYS durable-session-bound (revocable); a token without
  // a jti or a meeting binding is not one we ever mint.
  if (!p.jti || typeof p.mid !== "string" || !p.mid)
    return res.status(401).json(fail("UNAUTHORIZED", "Invalid token"));
  const chk = await sessionState(String(p.jti));
  if (chk.state === "unavailable")
    return res.status(503).json(fail("UNAVAILABLE", "Session check unavailable — retry shortly"));
  if (chk.state === "revoked" || chk.state === "expired")
    return res.status(401).json(fail("UNAUTHORIZED", "Your guest session has ended"));
  if (!guestMayCall(req, baseMeetingId(p.mid)))
    return res
      .status(403)
      .json(fail("GUEST_FORBIDDEN", "Guests can only use the meeting they were invited to."));
  req.user = {
    userId: p.sub,
    name: p.name,
    deviceId: null,
    jti: p.jti,
    guest: true,
    guestMeetingId: baseMeetingId(p.mid),
  };
  // Tenant = the one stamped on the session at join (copied from the meeting row).
  // No membership gate: a guest has none by design — the allowlist above is what
  // bounds what the tenant context can reach.
  const orgId = chk.activeOrgId || null;
  (req as any).org = orgId ? { id: orgId } : null;
  return orgContext.run({ orgId }, () => next());
}

export default async function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token)
    return res.status(401).json(fail("UNAUTHORIZED", "Missing token"));
  try {
    const p: any = authService.verify(token);
    // SECURITY: reject ops-portal tokens attempting to act as app sessions.
    // Ops tokens carry { scope:'ops' } but no `sub` — allowing them through would
    // give `req.user.userId = undefined` (a null-user session) which bypasses every
    // userId-based authz check downstream. Fail fast with a clear rejection.
    if ((p as any)?.scope === "ops" || !(p as any)?.sub)
      return res.status(401).json(fail("UNAUTHORIZED", "Invalid token type"));
    if (await isBlocked(token))
      return res.status(401).json(fail("UNAUTHORIZED", "Token revoked"));
    // Public-link guest: narrow credential, handled entirely separately (no device
    // binding, no org-membership gate, route allowlist). See guestAuth above.
    if ((p as any).guest === true) return guestAuth(req, res, next, p);
    // Device-bound revocation — ONLY when E2EE is enabled (strict no-op otherwise,
    // so the live flag-off product is byte-for-byte unchanged).
    //
    // PERMISSIVE (default, e2eeDeviceBoundStrict=false): a token WITHOUT a
    // deviceId is allowed through; a token WITH a deviceId is checked. DB errors
    // fail-OPEN so a transient DB problem can never lock users out.
    //
    // STRICT (GAP-3, e2eeDeviceBoundStrict=true): a token without a deviceId is
    // REJECTED (forces re-login to mint a deviceId-bound token); DB errors fail
    // CLOSED (a revocation check we cannot run is treated as untrustworthy).
    // Flip to strict ONLY after the token-rotation window has passed so all
    // active tokens carry a deviceId.
    if (e2eeEnabled) {
      if (!p.deviceId) {
        if (e2eeDeviceBoundStrict)
          return res
            .status(401)
            .json(fail("UNAUTHORIZED", "Device-bound token required — please re-login"));
      } else {
        try {
          const dev = await deviceState(String(p.deviceId));
          // A device claim is BAD if it is revoked or registered to a DIFFERENT
          // user — e.g. a leftover e2ee_device_id in localStorage from earlier
          // E2EE testing or another account previously used on this browser.
          const bad = !!(dev.userId && (dev.revoked || dev.userId !== p.sub));
          if (e2eeDeviceBoundStrict) {
            if (bad)
              return res.status(401).json(fail("UNAUTHORIZED", "Device revoked"));
            // Strict: a deviceId unknown to the server (never registered, or
            // wiped) is rejected too — same posture as a revoked device.
            if (!dev.userId)
              return res
                .status(401)
                .json(fail("UNAUTHORIZED", "Device unknown — please re-login"));
          } else if (bad) {
            // PERMISSIVE MODE NEVER LOCKS A USER OUT. The session is already
            // password-authenticated; a stale/foreign device CLAIM is DROPPED
            // (not rejected) so login always succeeds. The client re-registers a
            // fresh device on E2EE init (wipeForUserSwitch), and the deviceId
            // binds on the next login — exactly like a brand-new device. This is
            // what prevents the "sign in bounces straight back to sign in"
            // regression when E2EE is first enabled with a leftover device id.
            p.deviceId = null;
          }
        } catch (_) {
          if (e2eeDeviceBoundStrict)
            return res
              .status(503)
              .json(fail("UNAVAILABLE", "Device revocation check unavailable"));
          /* permissive: fail-open */
        }
      }
      // Device survived validation (not revoked/foreign/dropped) → stamp activity
      // for stale-device pruning. Throttled + fire-and-forget (see touchDeviceSeen).
      if (p.deviceId) touchDeviceSeen(String(p.deviceId));
      else {
        // UNBOUND token (the first session after enrolment, or a rebind that
        // failed): the device is in daily use but nothing ever stamped
        // last_seen_at, so after E2EE_DEVICE_STALE_DAYS the fan-out silently
        // dropped it and every later message arrived with no envelope for it.
        // The client sends its device id as a header on every request; stamp
        // it when it provably belongs to this user. Never authoritative for
        // anything else (no revocation decision rides on a header).
        const hdr = String(req.headers["x-colab-device-id"] || "").trim();
        if (hdr && /^[0-9A-Za-z_-]{1,64}$/.test(hdr)) {
          try {
            const dev = await deviceState(hdr);
            if (dev.userId && dev.userId === p.sub && !dev.revoked) touchDeviceSeen(hdr);
          } catch (_) {
            /* best-effort */
          }
        }
      }
    }
    // SESSION CHECK (#66) — only when the token carries a jti. Rejects a revoked or
    // expired session (client auto-logs-out on 401 via api.ts); bridges a lookup
    // error from a recent good answer (5 min grace), otherwise fails closed (503).
    let activeOrgId: string | null = null;
    if (p.jti) {
      const chk = await sessionState(String(p.jti));
      if (chk.state === "unavailable")
        return res.status(503).json(fail("UNAVAILABLE", "Session check unavailable — retry shortly"));
      if (chk.state === "revoked")
        return res.status(401).json(fail("UNAUTHORIZED", "This session was signed out"));
      if (chk.state === "expired")
        return res.status(401).json(fail("UNAUTHORIZED", "Session expired — please sign in again"));
      activeOrgId = chk.activeOrgId;
    }
    // LAZY ORG ADOPTION. active_org_id is stamped when the SESSION ROW is created,
    // so a user added to (or approved into) an org while ALREADY signed in keeps a
    // NULL tenant for the life of that session: every /orgs/current/* route then
    // 403s "No active organization for this session" even though they are a full
    // member (and the org panel shows an empty roster / "you are a member" with no
    // org). Resolve their primary org once, persist it onto the session, and carry
    // on — the next request reads it through the normal path. The lookup itself
    // only returns an ACTIVE, non-deleted membership, so this can never adopt a
    // tenant the user doesn't belong to (the membership gate below still runs).
    if (!activeOrgId && p.jti) {
      const now = Date.now();
      if (now >= (noOrgUntil.get(p.sub) || 0)) {
        try {
          const adopted = await db.orgs.primaryForUser(p.sub);
          if (adopted) {
            activeOrgId = adopted;
            // Fire-and-forget: worst case the next request re-adopts it.
            Promise.resolve(db.sessions.setActiveOrg(String(p.jti), p.sub, adopted)).catch(
              () => {},
            );
          } else {
            noOrgUntil.set(p.sub, now + NO_ORG_TTL_MS);
          }
        } catch {
          /* best-effort — a lookup failure just leaves the session tenant-less */
        }
      }
    }
    req.user = { userId: p.sub, name: p.name, deviceId: p.deviceId || null, jti: p.jti || null };
    // ORG MEMBERSHIP GATE (#68). If the session asserts an active org, the caller
    // must be an active member of it. A non-membership (or an errored check with no
    // cached decision) 403s with a code the client acts on (re-sync / switch org) —
    // it does NOT lock the account out, it rejects the asserted TENANT. Skipped for a
    // NULL-org (legacy/pre-org) session, which simply carries no tenant.
    if (activeOrgId) {
      // AUDIT P1 (#12): let a user who was REMOVED from their active org still PIVOT —
      // list their orgs, switch to another, or read the current one — so offboarding
      // doesn't brick their app with no way out (every other route stays gated).
      // These routes are themselves user-scoped, so exempting them is safe.
      const url = (req.originalUrl || req.url || "").split("?")[0].replace(/\/$/, "");
      const isOrgPivot =
        url === "/api/orgs" ||
        url === "/api/orgs/switch" ||
        url === "/api/orgs/current";
      if (!isOrgPivot) {
        const ok = await isActiveMember(p.sub, activeOrgId);
        if (!ok)
          return res
            .status(403)
            .json(fail("ORG_MEMBERSHIP_INVALID", "You are not a member of the active organization"));
      }
    }
    // Organizations: expose the session's active tenant on the request AND run the
    // rest of the request inside the ambient org context, so every driver query
    // auto-scopes to this tenant via currentOrgId() with no per-call threading.
    // (database/src/orgContext.ts.) NULL-org (legacy) session -> queries stay unscoped.
    (req as any).org = activeOrgId ? { id: activeOrgId } : null;
    return orgContext.run({ orgId: activeOrgId }, () => next());
  } catch {
    return res.status(401).json(fail("UNAUTHORIZED", "Invalid token"));
  }
}
