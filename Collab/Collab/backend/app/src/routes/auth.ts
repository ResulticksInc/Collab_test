import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, fail, db, config } from "../platform";
import { signup, login, evictSession, verifyMfaLogin, ssoLogin, me, verify, sessionContextFrom, analyzeLoginSecurity, rotateRefreshToken } from "../services/authService";
import authMiddleware from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { record } from "../services/auditService";
import { add as blockToken } from "../services/tokenBlocklist";
import * as sso from "../services/ssoService";
import { create as createNotification } from "../services/notificationService";
import { pushNotif } from "../realtime/notify";
import { disconnectSession, disconnectOtherSessions } from "../realtime/socket";
import { validate } from "../middleware/validate";
import {
  enrollmentStatus as mfaEnrollmentStatus,
  beginTotpEnroll,
  confirmTotpEnroll,
  disable as mfaDisable,
  regenerateBackupCodes,
  verifyCode as mfaVerifyCode,
} from "../services/mfaService";

// Brute-force guard on the second-factor endpoints. A TOTP code is 1e6-wide and
// rotates every 30s; with a short challenge TTL this makes guessing infeasible.
const mfaLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 12, message: "Too many attempts — wait a moment and try again." });

// Fire a "new sign-in" (or "suspicious sign-in") notification to the account's
// OTHER connected sessions — the just-logged-in device isn't socket-connected yet,
// so the alert naturally reaches the existing devices. Best-effort; a failure here
// must never affect the login response.
async function announceLogin(io: any, userId: string, sessionId: string) {
  try {
    const { reasons, session } = await analyzeLoginSecurity(userId, sessionId);
    if (!session) return;
    const suspicious = reasons.length > 0;
    const where = [session.city, session.country].filter(Boolean).join(", ");
    const n = await createNotification({
      userId,
      type: suspicious ? "security_login_suspicious" : "security_login",
      title: suspicious ? "Suspicious sign-in detected" : "New sign-in to your account",
      body:
        (session.deviceLabel || "A device") +
        (where ? " · " + where : "") +
        (suspicious ? " · " + reasons.join(", ") : "") +
        ". If this wasn't you, open Settings → Security to review your devices.",
      targetType: "session",
      targetId: sessionId,
    });
    if (n && io) pushNotif(io, n);
  } catch (_) {
    /* best-effort */
  }
}

router.post("/signup", validate({
  email: { required: true, isEmail: true },
  password: { required: true, minLength: 8, maxLength: 128 },
  name: { maxLength: 100 },
}), async (req, res) => {
  try {
    const out = await signup(req.body || {}, sessionContextFrom(req));
    if (out && out.user)
      await record({ actorId: out.user.id, action: "auth.signup" });
    res.json(ok(out));
  } catch (e: any) {
    res.status(e.status || 500).json(fail("SIGNUP_FAILED", e.message));
  }
});
router.post("/login", validate({
  email: { required: true, isEmail: true },
  password: { required: true },
}), async (req, res) => {
  try {
    const out: any = await login(req.body || {}, sessionContextFrom(req));
    if (out && out.user)
      await record({ actorId: out.user.id, action: "auth.login" });
    if (out && out.user && (out as any).sessionId)
      void announceLogin(req.app.get("io"), out.user.id, (out as any).sessionId);
    // Device-limit eviction: the user chose a device to sign out at the "max
    // devices reached" prompt (login() already revoked its session row). Kick its
    // live sockets now so the evicted device returns to sign-in immediately.
    if (out && out.user && req.body && req.body.evictSessionId)
      void disconnectSession(req.app.get("io"), String(req.body.evictSessionId), "revoked");
    res.json(ok(out));
  } catch (e: any) {
    res.status(e.status || 500).json(fail("LOGIN_FAILED", e.message));
  }
});
// Sign out ONE device from the "maximum devices reached" prompt WITHOUT completing
// sign-in (credentials are re-verified). Lets the user clear several devices before
// continuing — /login evicts-and-proceeds the moment they're under the cap, which
// closed the prompt after a single sign-out. Returns the refreshed device list.
router.post("/sessions/evict", validate({
  email: { required: true, isEmail: true },
  password: { required: true },
  sessionId: { required: true },
}), async (req, res) => {
  try {
    const out: any = await evictSession(req.body || {});
    if (req.body && req.body.sessionId)
      void disconnectSession(req.app.get("io"), String(req.body.sessionId), "revoked");
    res.json(ok(out));
  } catch (e: any) {
    res.status(e.status || 500).json(fail("EVICT_FAILED", e.message));
  }
});
router.get("/me", authMiddleware, async (req, res) =>
  res.json(ok(await me((req as any).user.userId))),
);

// MFA-ready hook (Session Mgmt Phase 5): the caller's second-factor enrollment
// status, so the client is MFA-aware (shows "Not enabled" today, and a future
// "Enable MFA" flow plugs into the same contract). No-op until enrollment ships.
router.get("/mfa/status", authMiddleware, async (req, res) =>
  res.json(ok(await mfaEnrollmentStatus((req as any).user.userId))),
);

// Begin TOTP enrollment — returns the base32 secret + otpauth:// URI (rendered as
// a QR by the client). Does NOT enable MFA until /mfa/totp/confirm succeeds.
router.post("/mfa/totp/begin", authMiddleware, mfaLimiter, async (req, res) => {
  try {
    const uid = (req as any).user.userId;
    const user = await db.users.getById(uid);
    res.json(ok(await beginTotpEnroll(uid, (user && user.email) || uid)));
  } catch (e: any) {
    res.status(e.status || 400).json(fail("MFA_BEGIN_FAILED", e.message));
  }
});

// Confirm enrollment with the first authenticator code. Returns one-time backup
// codes (shown ONCE — only their hashes are stored).
router.post("/mfa/totp/confirm", authMiddleware, mfaLimiter, async (req, res) => {
  try {
    const uid = (req as any).user.userId;
    const out = await confirmTotpEnroll(uid, String((req.body || {}).code || ""));
    await record({ actorId: uid, action: "auth.mfa.enroll" });
    res.json(ok(out));
  } catch (e: any) {
    res.status(e.status || 400).json(fail("MFA_CONFIRM_FAILED", e.message));
  }
});

// Turn MFA off — requires re-proving the factor so a hijacked live session can't
// silently disable it.
router.post("/mfa/disable", authMiddleware, mfaLimiter, async (req, res) => {
  const uid = (req as any).user.userId;
  const st = await mfaEnrollmentStatus(uid);
  if (!st.enabled) return res.json(ok({ disabled: true }));
  const okCode = await mfaVerifyCode(uid, String((req.body || {}).code || ""));
  if (!okCode) return res.status(400).json(fail("MFA_CODE_INVALID", "Enter a current code to turn off MFA."));
  await mfaDisable(uid);
  await record({ actorId: uid, action: "auth.mfa.disable" });
  res.json(ok({ disabled: true }));
});

// Regenerate backup codes (invalidates the previous set). Requires a current code.
router.post("/mfa/backup-codes", authMiddleware, mfaLimiter, async (req, res) => {
  try {
    const uid = (req as any).user.userId;
    const okCode = await mfaVerifyCode(uid, String((req.body || {}).code || ""));
    if (!okCode) return res.status(400).json(fail("MFA_CODE_INVALID", "Enter a current code to regenerate backup codes."));
    const out = await regenerateBackupCodes(uid);
    await record({ actorId: uid, action: "auth.mfa.backup_regen" });
    res.json(ok(out));
  } catch (e: any) {
    res.status(e.status || 400).json(fail("MFA_BACKUP_FAILED", e.message));
  }
});

// Complete an MFA-gated login: exchange { challengeId, code } for a real session.
// NO authMiddleware (there's no session yet); the signed challenge is the ticket.
router.post("/mfa/verify", mfaLimiter, async (req, res) => {
  try {
    const out: any = await verifyMfaLogin(req.body || {}, sessionContextFrom(req));
    if (out && out.user) {
      await record({ actorId: out.user.id, action: "auth.login", detail: { mfa: true } });
      if (out.sessionId) void announceLogin(req.app.get("io"), out.user.id, out.sessionId);
    }
    if (out && out.user && req.body && req.body.evictSessionId)
      void disconnectSession(req.app.get("io"), String(req.body.evictSessionId), "revoked");
    res.json(ok(out));
  } catch (e: any) {
    res.status(e.status || 401).json(fail("MFA_VERIFY_FAILED", e.message));
  }
});

// Refresh-token rotation (Session Mgmt Phase 5). Exchange a valid refresh token
// for a fresh access token + a rotated refresh token WITHOUT a full re-login —
// so an access token can lapse while the 30-day session lives on. NO authMiddleware
// (the access token may be expired; the refresh token itself is the credential).
// Replay of a used token is treated as theft: the family + session are revoked and
// every device disconnected. A benign concurrent rotation returns 409 (retry), so
// the client re-reads its already-updated token instead of logging out.
router.post("/refresh", async (req, res) => {
  const b = req.body || {};
  const rawToken = String(b.refreshToken || "");
  const deviceId = b.deviceId || undefined;
  if (!rawToken) return res.status(400).json(fail("REFRESH_MISSING", "No refresh token."));
  const out: any = await rotateRefreshToken(rawToken, deviceId);
  if (!out)
    return res.status(401).json(fail("REFRESH_INVALID", "Your session has expired. Please sign in again."));
  if (out.retry)
    return res.status(409).json(fail("REFRESH_RETRY", "A refresh is already in progress."));
  if (out.reuse) {
    const sid = String(out.sessionId || "");
    try { await db.refreshTokens.revokeFamily(sid); } catch (_) {}
    try { await db.sessions.revokeById(sid); } catch (_) {}
    void disconnectSession(req.app.get("io"), sid, "revoked");
    await record({ action: "auth.refresh_reuse_detected", targetType: "session", targetId: sid });
    return res
      .status(401)
      .json(fail("REFRESH_REUSE", "For your security we signed you out on this device. Please sign in again."));
  }
  await record({ actorId: out.user?.id, action: "auth.refresh" });
  res.json(ok({ token: out.token, refreshToken: out.refreshToken, user: out.user }));
});

// ── SSO (OpenID Connect, Auth Code + PKCE) ──────────────────────────────────
// Lightweight status so the client can show/hide the SSO button.
router.get("/sso/status", async (_req, res) =>
  res.json(ok({ enabled: config.sso.enabled, configured: sso.ssoConfigured() })),
);

// Sign-in: mint PKCE + state + nonce and 302 the browser to the IdP login. On any
// misconfiguration, bounce back to the app with a friendly ?sso_error (never a
// raw 500 the user can't act on).
router.get("/sso/start", async (req, res) => {
  try {
    if (!sso.ssoConfigured()) return res.redirect("/?sso_error=not_configured");
    // Straight to /authorize. (An earlier build first bounced the browser through
    // the IdP end-session endpoint to force re-authentication; the AgenXchange
    // staging IdP shows its own login page anyway, and the IdP session is ended
    // on app logout via /sso/logout, so that pre-login logout hop is gone.)
    // IdP launcher hand-off (guide v3 §8d): the homepage was opened with
    // ?login_hint=<email>; the SPA forwards it here and we pass it to /authorize.
    const loginHint = sso.cleanLoginHint(req.query.login_hint);
    const verifier = sso.randomString(48);
    const codeChallenge = sso.sha256b64url(verifier);
    const nonce = sso.randomString(16);
    const state = sso.createSsoState({ v: verifier, n: nonce });
    const redirect = await sso.buildLoginRedirect({ state, nonce, codeChallenge, loginHint });
    return res.redirect(redirect);
  } catch (e: any) {
    return res.redirect("/?sso_error=start_failed");
  }
});

// Logout (RP-initiated, guide v3 §9): the app has ALREADY revoked its own session
// (POST /logout) and cleared local storage; this hop ends the IdP's SSO cookie too,
// so the next "Sign in with SSO" asks for credentials instead of silently
// re-authenticating. Full-page navigation target (browser follows the 302). Falls
// back to the app root when no end-session endpoint is known.
router.get("/sso/logout", async (_req, res) => {
  try {
    const url = await sso.buildLogoutRedirect(sso.appRootUrl());
    return res.redirect(url || sso.appRootUrl());
  } catch (_) {
    return res.redirect(sso.appRootUrl());
  }
});

// Callback: the IdP redirects the BROWSER to the registered redirect_uri — the app
// ROOT ("/") — with ?code&state. The SPA reads them off its own URL and POSTs them
// here. We verify state (recovering the PKCE verifier + nonce it carries), exchange
// the code + validate the id_token, find-or-create the user, mint the session, and
// return { token, user } directly in the JSON body (the app JWT never rides a URL).
router.post("/sso/callback", async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || "");
  const state = String(b.state || "");
  // Bind the caller's E2EE device to the SSO token (same as /refresh reads b.deviceId).
  const deviceId = b.deviceId ? String(b.deviceId) : undefined;
  if (!code || !state)
    return res.status(400).json(fail("SSO_BAD_CALLBACK", "Missing authorization code or state."));
  try {
    const parsed = sso.parseSsoState(state);
    if (!parsed)
      return res
        .status(400)
        .json(fail("SSO_STATE_MISMATCH", "Your sign-in link expired. Please try again."));
    const profile = await sso.completeSsoCallback(code, parsed.v, parsed.n);
    // eslint-disable-next-line no-console
    console.log("[sso] step 4/4 — find-or-create user for", profile.email);
    const out = await ssoLogin(profile, sessionContextFrom(req), deviceId);
    // eslint-disable-next-line no-console
    console.log("[sso] done — session minted for user", out?.user?.id);
    if (out && out.user) await record({ actorId: out.user.id, action: "auth.sso" });
    if (out && out.user && (out as any).sessionId)
      void announceLogin(req.app.get("io"), out.user.id, (out as any).sessionId);
    res.json(ok(out));
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn("[sso] callback failed:", e?.message || e);
    const status = Number(e?.status) || 500;
    // Surface the REAL reason to the client. SSO back-channel errors (token-exchange
    // status, JWKS fetch, claim/nonce/issuer mismatches) are operator-facing config
    // diagnostics, not user PII — showing them makes the flow debuggable without
    // tailing the server log. Map an upstream 5xx to 502 but keep the detail.
    const detail = e?.message ? String(e.message) : "SSO sign-in failed.";
    res.status(status >= 500 ? 502 : status).json(fail("SSO_FAILED", detail));
  }
});
// NATIVE / MOBILE SSO: the app ran the OIDC + PKCE exchange itself and posts the
// IdP's tokens. { id_token (required), access_token?, nonce?, deviceId? } →
// { token, user, refreshToken } — the same session the web callback mints.
// Trust boundary = id_token signature + iss + aud (SSO_CLIENT_ID / SSO_EXTRA_CLIENT_IDS)
// + exp + nonce (when the app supplies the one it sent to /authorize).
router.post("/sso/token", async (req, res) => {
  const b = req.body || {};
  const deviceId = b.deviceId ? String(b.deviceId) : undefined;
  try {
    const profile = await sso.completeSsoTokenLogin(b);
    // eslint-disable-next-line no-console
    console.log("[sso] token login — find-or-create user for", profile.email);
    const out = await ssoLogin(profile, sessionContextFrom(req), deviceId);
    if (out && out.user) await record({ actorId: out.user.id, action: "auth.sso" });
    if (out && out.user && (out as any).sessionId)
      void announceLogin(req.app.get("io"), out.user.id, (out as any).sessionId);
    res.json(ok(out));
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn("[sso] token login failed:", e?.message || e);
    const status = Number(e?.status) || 500;
    const detail = e?.message ? String(e.message) : "SSO sign-in failed.";
    res.status(status >= 500 ? 502 : status).json(fail("SSO_FAILED", detail));
  }
});
router.post("/logout", authMiddleware, async (req, res) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  try {
    const payload = verify(token);
    await blockToken(token, payload.exp);
    await record({ actorId: (req as any).user.userId, action: "auth.logout" });
  } catch (_) {}
  // Revoke this device's durable session row too (#66) so it leaves the user's
  // "active sessions" list and a still-valid access token for it is rejected.
  // Best-effort: a sessions hiccup must not fail logout.
  try {
    const jti = (req as any).user?.jti;
    if (jti) {
      await db.sessions.revoke((req as any).user.userId, jti);
      // Sign out THIS device fully: close every tab/window sharing this session's
      // live socket so they all return to sign-in, not just the tab that clicked.
      void disconnectSession(req.app.get("io"), jti, "logout");
    }
  } catch (_) {}
  res.json(ok({ loggedOut: true }));
});
// Account deletion — SOFT + anonymized. Soft-deletes the user (frees the email),
// cascades the data they own, and KEEPS their authored messages attached to the
// anonymized "Deleted user" shell (a true row delete is impossible — sender_id is
// FK RESTRICT). Then revokes the current session token. No hard delete anywhere.
router.delete("/account", authMiddleware, async (req, res) => {
  const userId = (req as any).user.userId;
  // Organizations: refuse if the user is the SOLE active owner of any org — deleting
  // their account would orphan the tenant. They must transfer ownership first
  // (the >=1-active-owner invariant). 409 with the offending orgs so the UI can guide.
  const orphaned = await db.users.orgsSolelyOwnedBy(userId);
  if (orphaned.length) {
    return res
      .status(409)
      .json(
        fail(
          "ORG_OWNERSHIP_TRANSFER_REQUIRED",
          "Transfer ownership of your organization(s) before deleting your account.",
          { organizations: orphaned },
        ),
      );
  }
  await db.users.deleteAccount(userId, userId);
  // Terminate ALL access for the deleted account — not just this device's token.
  // Without this, other devices' sessions survive (revoked=0) and, with Phase 5
  // refresh rotation, could renew a fresh access token for the ~30-day session
  // window, defeating the deletion. Revoke every session + refresh token and
  // force-disconnect every live socket. (blockToken below still cuts THIS device's
  // current access token instantly; the session revoke handles the rest via the
  // per-request #66 check + the rotate-time session re-check.)
  try { await db.sessions.revokeAllForUser(userId); } catch (_) {}
  try { await db.refreshTokens.revokeAllForUser(userId); } catch (_) {}
  // Mobile push K4: the users FK cascade doesn't fire for a SOFT delete, so
  // retire the phones' push registrations explicitly.
  try { await db.pushDevices.removeForUser(userId); } catch (_) {}
  void disconnectOtherSessions(req.app.get("io"), userId, "");
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  try {
    const payload = verify(token);
    await blockToken(token, payload.exp);
  } catch (_) {}
  await record({ actorId: userId, action: "account.delete" });
  res.json(ok({ deleted: true }));
});
export default router;
