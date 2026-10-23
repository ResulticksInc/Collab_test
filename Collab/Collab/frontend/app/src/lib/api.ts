import config from "./config";
import { log, hintForStatus } from "./logger";
import { getRefreshToken, saveRefreshToken, clearRefreshToken, saveToken } from "./tokenStore";
const base = config.apiBaseUrl;

// ── Refresh-token rotation (Session Mgmt Phase 5) ───────────────────────────
// Before giving up on a confirmed-dead access token (and logging out), try to
// silently renew it with the rotating refresh token. Single-flight so a burst of
// concurrent 401s triggers exactly ONE refresh; multi-tab-safe because the token
// mirror is shared (a tab whose own refresh loses the race adopts the sibling's
// freshly-written token instead of logging out). Fail-safe: if nothing recovers,
// fall back to the existing colab:unauthorized logout — no worse than before.
// Sentinel distinct from any real JWT: the server said 409 (a concurrent tab is
// mid-rotation with the shared token). We must NOT log out — wait for that tab to
// write the renewed token to the shared mirror and adopt it.
const REFRESH_RETRY = "__colab_refresh_retry__";
const REFRESH_TIMEOUT_MS = 12000;
let refreshInFlight: Promise<string | null> | null = null;
function readAccessMirror(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem("clb_token") : null;
  } catch {
    return null;
  }
}
// True for a public-link guest bearer ({ guest:true } claim). Decoded WITHOUT
// verification — it only decides whether to skip signed-in-session recovery;
// the server is what actually authenticates the token.
function isGuestToken(token: string): boolean {
  try {
    const part = String(token).split(".")[1] || "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    return !!(JSON.parse(json) || {}).guest;
  } catch {
    return false;
  }
}
async function attemptRefresh(): Promise<string | null> {
  const rt = getRefreshToken();
  if (!rt) return null;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      // Bounded so a hung/half-open request can't pin the single-flight promise
      // forever (which would block every later 401 from recovering OR logging out).
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* */ } }, REFRESH_TIMEOUT_MS) : null;
      try {
        const res = await fetch(base + "/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: rt, deviceId: e2eeDeviceId() }),
          signal: ctrl ? ctrl.signal : undefined,
        });
        // 409 = a sibling tab already rotated this exact token (server marked it
        // used within the grace window). Not a failure — signal "wait for the mirror".
        if (res.status === 409) return REFRESH_RETRY;
        const j = await res.json().catch(() => null);
        if (res.ok && j && j.ok && j.data && j.data.token) {
          try {
            await saveToken(j.data.token);
          } catch {
            /* mirror write best-effort */
          }
          // Rotated OK. If the server couldn't mint a replacement refresh token
          // (transient store error → empty), DROP the now-used one so we don't
          // replay it later and trip a false reuse/theft revoke — fall back to a
          // clean re-login on the next lapse instead.
          if (j.data.refreshToken) saveRefreshToken(j.data.refreshToken);
          else clearRefreshToken();
          return j.data.token as string;
        }
      } catch {
        /* network / abort / parse error → treat as no-refresh */
      } finally {
        if (timer) clearTimeout(timer);
      }
      return null;
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}
// Poll the shared access-token mirror for a change (a concurrent tab's rotation
// writing the renewed token) up to timeoutMs. Resolves the new token or null.
function waitForMirrorChange(before: string | null, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const now = readAccessMirror();
      if (now && now !== before) return resolve(now);
      if (Date.now() - start >= timeoutMs) return resolve(null);
      setTimeout(tick, 150);
    };
    tick();
  });
}
async function handleConfirmedUnauthorized(): Promise<void> {
  if (typeof window === "undefined") return;
  const before = readAccessMirror();
  let recovered: string | null = null;
  let r: string | null = null;
  try {
    r = await attemptRefresh();
  } catch {
    r = null;
  }
  if (r && r !== REFRESH_RETRY) {
    recovered = r; // our own refresh minted a fresh token
  } else if (r === REFRESH_RETRY) {
    // A sibling tab is rotating the shared token — give it a moment to publish the
    // renewed token to the mirror, then adopt it instead of wrongly logging out.
    recovered = await waitForMirrorChange(before, 2000);
  }
  // Belt-and-braces: even on a hard-fail (null), a concurrent tab may have JUST
  // finished — adopt a changed mirror rather than logging out needlessly.
  if (!recovered) {
    const mirror = readAccessMirror();
    if (mirror && mirror !== before) recovered = mirror;
  }
  if (recovered) {
    window.dispatchEvent(
      new CustomEvent("colab:token-refreshed", { detail: { token: recovered } }),
    );
  } else {
    clearRefreshToken();
    window.dispatchEvent(new CustomEvent("colab:unauthorized"));
  }
}
// P0 (intermittent empty data): ONE bounded retry for idempotent reads that
// fail transiently — network blip (status 0), 5xx, or 429. A single failed GET
// during boot/navigation used to surface as a permanently empty list until the
// user refreshed. Writes (POST/PATCH/DELETE) are never retried here — a
// double-apply is worse than a surfaced error.

// Single site for surfacing a failed request to the diagnostics log (which the
// ops telemetry taps at ERROR level). 5xx + network(0) are real failures
// (error); 4xx are usually expected/handled (warn). Centralised so the retry
// wrapper can DEFER a GET's first-attempt log until the retry's outcome is known
// — a GET cut mid-flight by a backend redeploy but healed on retry should leave
// NO red error on the ops board.
function logReqFailure(
  method: string,
  path: string,
  status: number,
  msg?: string,
  netDetail?: string,
) {
  if (status === 0)
    log.error("server", `${method} ${path} — network error`, {
      hint: hintForStatus(0),
      data: netDetail,
    });
  else
    log[status >= 500 ? "error" : "warn"](
      "server",
      `${method} ${path} → ${status}: ${msg}`,
      { hint: hintForStatus(status, msg) },
    );
}

async function req(
  path: string,
  opts: { method?: string; token?: string; body?: any; silent?: boolean } = {},
) {
  const method = opts.method || "GET";
  // GETs are retried once on a transient failure (below), so defer the first
  // attempt's diagnostics log until we know the retry's outcome — otherwise a
  // GET that FAILS once (e.g. an in-flight request cut by a backend restart)
  // but SUCCEEDS on retry still spammed a red error into telemetry, inflating
  // the ops board with self-healing blips. Non-GETs aren't retried, so they log
  // on their first (only) attempt exactly as before.
  const willRetry = method === "GET";
  try {
    return await reqOnce(path, { ...opts, deferLog: willRetry });
  } catch (err: any) {
    const transient =
      err && (err.status === 0 || err.status === 429 || (err.status >= 500 && err.status <= 599));
    if (willRetry && transient) {
      await new Promise((r) => setTimeout(r, 600));
      // The retry logs on its own failure (deferLog defaults off); a success
      // returns cleanly with nothing logged.
      return await reqOnce(path, opts);
    }
    // No retry (a non-transient GET failure, e.g. a 4xx the user must act on):
    // the deferred first attempt didn't log, so emit it now.
    if (willRetry && !opts.silent)
      logReqFailure(method, path, (err && err.status) || 0, err && err.message);
    throw err;
  }
}
async function reqOnce(
  path: string,
  {
    method = "GET",
    token,
    body,
    silent = false,
    deferLog = false,
  }: {
    method?: string;
    token?: string;
    body?: any;
    silent?: boolean;
    deferLog?: boolean;
  } = {},
) {
  // `silent` suppresses diagnostics logging for endpoints whose failure is an
  // EXPECTED, gracefully-handled state (e.g. push not configured → 503). Without
  // it, a benign "feature not available" response shows up as a red SERVER error
  // and trips the "Connection issue" pill.
  let res: Response;
  try {
    // The E2EE device id rides along on every authenticated request so the
    // server can stamp this device as ACTIVE even while the token is still
    // unbound (first session after enrolment) — otherwise the stale-device
    // pruning could drop a device in daily use from the sender fan-out.
    const devId = token ? e2eeDeviceId() : undefined;
    res = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(devId ? { "X-CoLab-Device-Id": devId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (netErr) {
    // The request never reached the server (offline, DNS, server down, CORS).
    const err: any = new Error("Couldn't reach the server");
    err.status = 0;
    if (!silent && !deferLog)
      logReqFailure(method, path, 0, undefined, String((netErr as any)?.message || netErr));
    throw err;
  }
  // Mid-session 401 on an AUTHENTICATED request means the token was revoked or
  // expired (logout elsewhere, TTL lapse, server restart). Signal a graceful
  // logout so the app returns to the sign-in screen instead of silently failing.
  // `token` gates this so a 401 from login/signup (bad credentials, no token)
  // does NOT trigger it.
  // A public-link GUEST token is never the user's own session: its 401 (guest
  // session ended) must not run the refresh/logout recovery below, which acts on
  // the signed-in account's refresh token stored in this same browser.
  if (res.status === 401 && token && typeof window !== "undefined" && !isGuestToken(token)) {
    // A single 401 is often transient — a backend restart/redeploy, a brief
    // blip, or an endpoint-specific authz check — and should NOT tear down the
    // whole session (the old behavior logged users out on ANY 401, which showed
    // up as "unexpected logouts" during calls on flaky networks). Confirm the
    // SESSION is actually dead by re-validating the token via /auth/me; only a
    // 401 there means it is genuinely revoked/expired. A 401 on /auth/me itself
    // is already conclusive, so act on it directly (and avoid a loop).
    // Phase 5: try a silent refresh-token rotation before logging out. Skip the
    // auth endpoints themselves to avoid any loop (refresh is a raw fetch, not via
    // req(), so it never re-enters here anyway).
    if (path.startsWith("/api/auth/me")) {
      void handleConfirmedUnauthorized();
    } else if (!path.startsWith("/api/auth/")) {
      fetch(base + "/api/auth/me", {
        headers: { Authorization: "Bearer " + token },
      })
        .then((r) => {
          if (r.status === 401) void handleConfirmedUnauthorized();
        })
        .catch(() => {
          /* network error ≠ confirmed auth failure → stay signed in */
        });
    }
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON / empty body */
  }
  if (!json || json.ok !== true) {
    // Attach the HTTP status so callers can categorize failures — e.g. a 403 on a
    // call/meeting token must surface the precise "locked / removed / not
    // admitted / ended" reason (MeetingStage + CoLabV1 connect-error handling key
    // off err.status === 403). Without this the status is lost and every denial
    // reads as a generic network/firewall error telling the user to switch
    // networks, which is actively misleading for a removed/locked-out user.
    const msg = (json && json.error && json.error.message) || "Request failed";
    const err: any = new Error(msg);
    err.status = res.status;
    // Surface the structured error payload so callers can act on it — e.g. a
    // 409 task version-conflict carries `details.current` (the latest server
    // task) and `details.code` so the client can reconcile/live-merge rather
    // than clobber. Generic callers that ignore `err.details` are unaffected.
    if (json && json.error) {
      err.code = json.error.code;
      err.details = json.error.details || null;
    }
    // AUDIT P1 (#12): a 403 because the user was removed from their active org. The
    // app would otherwise be bricked (every call 403s). Signal the shell to pivot to
    // another org or the chooser rather than surfacing a dead-end error.
    if (
      res.status === 403 &&
      err.code === "ORG_MEMBERSHIP_INVALID" &&
      token &&
      typeof window !== "undefined"
    ) {
      window.dispatchEvent(new CustomEvent("colab:org-invalid"));
    }
    // Surface to the diagnostics log with a plain-English direction. 5xx are real
    // server failures (error); 4xx are usually expected/handled (warn). `silent`
    // endpoints (e.g. push, which degrades gracefully) never log; `deferLog`
    // holds a retriable GET's first-attempt log until the retry's outcome.
    if (!silent && !deferLog) logReqFailure(method, path, res.status, msg);
    throw err;
  }
  return json.data;
}
// The E2EE device id (set by initE2EE in a prior session) so login/signup can
// bind it into the token for device-revocation enforcement. Empty when E2EE has
// never run on this browser — the token is then simply unbound (no-op server-side).
function e2eeDeviceId(): string | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage.getItem("e2ee_device_id") || undefined;
  } catch {
    return undefined;
  }
}
export const api = {
  login: (email, password, evictSessionId?) =>
    req("/api/auth/login", {
      method: "POST",
      body: { email, password, deviceId: e2eeDeviceId(), evictSessionId },
    }),
  // Sign out ONE device at the "maximum devices reached" prompt WITHOUT completing
  // sign-in — returns the refreshed { sessions, max, active, underLimit } so the user
  // can clear several devices before continuing.
  evictLoginSession: (email, password, sessionId) =>
    req("/api/auth/sessions/evict", {
      method: "POST",
      body: { email, password, sessionId },
    }),
  signup: (name, email, password) =>
    req("/api/auth/signup", {
      method: "POST",
      body: { name, email, password, deviceId: e2eeDeviceId() },
    }),
  me: (token) => req("/api/auth/me", { token }),
  logout: (token) =>
    req("/api/auth/logout", { method: "POST", token }).catch(() => {}),
  // SSO (OIDC). ssoStartUrl is a FULL-PAGE navigation target (not fetch) — the
  // browser must follow the backend's 302 to the IdP. The IdP then redirects back
  // to the app ROOT with ?code&state; the SPA posts those to ssoCallback, which
  // does the server-side token exchange and returns { token, user } (the app JWT
  // never rides in a URL).
  ssoStartUrl: (loginHint?: string) =>
    (base || "") +
    "/api/auth/sso/start" +
    (loginHint ? "?login_hint=" + encodeURIComponent(loginHint) : ""),
  // FULL-PAGE navigation target: ends the IdP's SSO session after the app's own
  // logout, so the next SSO sign-in re-prompts for credentials. IdP returns to root.
  ssoLogoutUrl: () => (base || "") + "/api/auth/sso/logout",
  ssoCallback: (code: string, state: string) =>
    // Send the E2EE device id so the SSO session token is device-BOUND (like
    // login/signup/refresh). Without it the token is unbound and E2EE history
    // sync silently no-ops → "[Encrypted — not available on this device]".
    req("/api/auth/sso/callback", {
      method: "POST",
      body: { code, state, deviceId: e2eeDeviceId() },
    }),
  ssoStatus: () => req("/api/auth/sso/status", { silent: true }),
  // Organizations (#70/#71). listOrgs backs the switcher; orgCurrent returns the
  // active org + the caller's role + resolved permissions; switchOrg flips the
  // session's active org (no token reissue). The rest are the admin console.
  listOrgs: (token) => req("/api/orgs", { token }),
  orgCurrent: (token) => req("/api/orgs/current", { token }),
  switchOrg: (token, orgId) =>
    req("/api/orgs/switch", { method: "POST", token, body: { orgId } }),
  // Leave the caller's active organization (self-serve — auth only). Returns
  // { removed, orgName, nextOrgId }; a sole owner is rejected 409 LAST_OWNER.
  leaveOrg: (token) => req("/api/orgs/current/leave", { method: "POST", token }),
  provisionOrg: (token, name) =>
    req("/api/orgs", { method: "POST", token, body: { name } }),
  updateOrg: (token, patch) =>
    req("/api/orgs/current", { method: "PATCH", token, body: patch }),
  orgMembers: (token) => req("/api/orgs/current/members", { token }),
  orgAddMember: (token, email, role) =>
    req("/api/orgs/current/members", { method: "POST", token, body: { email, role } }),
  // Provision a NEW local username/password account + add to the active org.
  // [members:manage] — the enterprise alternative to public sign-up.
  orgProvisionUser: (token, body) =>
    req("/api/orgs/current/members/provision", { method: "POST", token, body }),
  // Admin-initiated password reset (forgotten-password recovery). Sets a NEW
  // password for the member — passwords stay one-way hashed. [members:manage].
  orgResetMemberPassword: (token, userId, password) =>
    req(`/api/orgs/current/members/${userId}/reset-password`, { method: "POST", token, body: { password } }),
  orgSetMemberRole: (token, userId, role) =>
    req(`/api/orgs/current/members/${userId}`, { method: "PATCH", token, body: { role } }),
  // Optional `reason` (BA #1) — audited + echoed to the removed user.
  orgRemoveMember: (token, userId, reason = "") =>
    req(`/api/orgs/current/members/${userId}`, {
      method: "DELETE",
      token,
      body: reason ? { reason } : undefined,
    }),
  orgTeams: (token) => req("/api/orgs/current/teams", { token }),
  orgRoles: (token) => req("/api/orgs/current/roles", { token }),
  // Custom roles (roles:manage): the permission catalog + create/edit/delete.
  orgPermissionCatalog: (token) => req("/api/orgs/current/permissions", { token }),
  orgCreateRole: (token, name, rank, permissions) =>
    req("/api/orgs/current/roles", { method: "POST", token, body: { name, rank, permissions } }),
  orgUpdateRole: (token, roleId, patch) =>
    req(`/api/orgs/current/roles/${roleId}`, { method: "PATCH", token, body: patch }),
  orgDeleteRole: (token, roleId) =>
    req(`/api/orgs/current/roles/${roleId}`, { method: "DELETE", token }),
  orgSetMyTeam: (token, teamId) =>
    req("/api/orgs/current/my-team", { method: "POST", token, body: { teamId } }),
  // Multi-team: join (true) or leave (false) a specific team.
  orgSetTeamMembership: (token, teamId, join) =>
    req(`/api/orgs/current/teams/${teamId}/membership`, { method: "POST", token, body: { join } }),
  // Create a team / sub-team (parentTeamId nests it under a parent).
  orgCreateTeam: (token, name, parentTeamId) =>
    req("/api/orgs/current/teams", { method: "POST", token, body: { name, parentTeamId: parentTeamId || null } }),
  // Session Management admin console (Phase 4). Org session policy (limit + idle
  // timeout) [org:manage], and per-member device viewing / force-logout
  // [members:manage].
  orgSessionPolicy: (token) => req("/api/orgs/current/session-policy", { token }),
  orgUpdateSessionPolicy: (token, patch) =>
    req("/api/orgs/current/session-policy", { method: "PATCH", token, body: patch }),
  // Org media settings — the GIF-search API key (GIPHY). GET returns only whether
  // a key is set (never the secret); PATCH sets ("...") or clears (null) it.
  orgMediaSettings: (token) => req("/api/orgs/current/media-settings", { token }),
  orgSetGifKey: (token, provider, apiKey) =>
    req("/api/orgs/current/media-settings", { method: "PATCH", token, body: { provider, apiKey } }),
  orgMemberSessions: (token, userId) =>
    req(`/api/orgs/current/members/${userId}/sessions`, { token }),
  orgRevokeMemberSession: (token, userId, sid) =>
    req(`/api/orgs/current/members/${userId}/sessions/${sid}`, { method: "DELETE", token }),
  orgRevokeAllMemberSessions: (token, userId) =>
    req(`/api/orgs/current/members/${userId}/sessions/revoke-all`, { method: "POST", token }),
  // Enterprise onboarding — join requests. requestJoin creates a PENDING request by
  // org slug/"code" (or id from an invite link); myJoinRequests backs the "Request
  // Sent" state. The admin side lists + approves/rejects pending requests
  // [members:manage]. (Org discovery-by-name was removed — the list is sensitive.)
  requestJoinOrg: (token, body) =>
    req("/api/orgs/join-requests", { method: "POST", token, body }),
  myJoinRequests: (token) => req("/api/orgs/my-join-requests", { token }),
  orgJoinRequests: (token) => req("/api/orgs/current/join-requests", { token }),
  orgApproveJoinRequest: (token, id) =>
    req(`/api/orgs/current/join-requests/${id}/approve`, { method: "POST", token }),
  // Optional `reason` (BA #1) — audited + echoed to the requester.
  orgRejectJoinRequest: (token, id, reason = "") =>
    req(`/api/orgs/current/join-requests/${id}/reject`, {
      method: "POST",
      token,
      body: reason ? { reason } : {},
    }),
  // Org activity feed (BA #4) [audit:view] + org-wide broadcasts (BA #6):
  // owners/admins post [org:manage]; any active member lists.
  orgAuditLog: (token, limit = 100) =>
    req(`/api/orgs/current/audit?limit=${limit}`, { token }),
  orgBroadcasts: (token) => req("/api/orgs/current/broadcasts", { token }),
  // `sendAt` (ISO) schedules the announcement for later instead of sending now;
  // `fileId` attaches an upload (e.g. a voice note recorded in the composer).
  orgSendBroadcast: (token, title, body, sendAt = null, fileId = null) =>
    req("/api/orgs/current/broadcasts", {
      method: "POST",
      token,
      body: { title, body, sendAt, fileId },
    }),
  // Deletes/edits apply FOR EVERYONE (the row backs every member's list).
  orgDeleteBroadcast: (token, id) =>
    req(`/api/orgs/current/broadcasts/${id}`, { method: "DELETE", token }),
  orgUpdateBroadcast: (token, id, patch) =>
    req(`/api/orgs/current/broadcasts/${id}`, { method: "PATCH", token, body: patch }),
  // Active sessions (#66). listSessions returns { sessions:[{ id, deviceLabel,
  // platform, ip, createdAt, lastActiveAt, expiresAt, revoked, current }] } newest
  // first, with the caller's current device flagged `current`. revokeSession signs
  // out one OTHER device (IDOR-guarded server-side); revokeOtherSessions signs out
  // every device except this one.
  listSessions: (token) => req("/api/sessions", { token }),
  revokeSession: (token, id) =>
    req(`/api/sessions/${id}`, { method: "DELETE", token }),
  revokeOtherSessions: (token) =>
    req("/api/sessions/revoke-others", { method: "POST", token }),
  // Chat media (cost-free). GIFs + stickers proxied through GIPHY (key server-side;
  // returns { configured, results, next }).
  gifSearch: (token, q, type, pos) =>
    req(
      `/api/media/gifs?type=${type || "gif"}&q=${encodeURIComponent(q || "")}` +
        (pos ? `&pos=${encodeURIComponent(pos)}` : ""),
      { token, silent: true },
    ),
  // Custom stickers (WhatsApp-style personal tray). listStickers returns
  // { stickers:[{ id, url, mime, name, kind, width, height }] } (url is API-root
  // relative). uploadSticker streams the raw image body (like uploadFile).
  listStickers: (token) => req("/api/media/stickers", { token, silent: true }),
  uploadSticker: (token, data, mime, name, kind, width?: number, height?: number) =>
    fetch(
      base +
        `/api/media/stickers?mime=${encodeURIComponent(mime || "image/png")}&name=${encodeURIComponent(name || "sticker")}&kind=${kind === "gif" ? "gif" : "sticker"}` +
        (width ? `&width=${Math.round(width)}` : "") +
        (height ? `&height=${Math.round(height)}` : ""),
      { method: "POST", headers: { "Content-Type": mime || "image/png", Authorization: "Bearer " + token }, body: data },
    ).then(async (r) => {
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || j.ok !== true) throw new Error((j && j.error && j.error.message) || "Upload failed");
      return j.data;
    }),
  deleteSticker: (token, id) => req(`/api/media/stickers/${id}`, { method: "DELETE", token }),
  getUsers: (token) => req("/api/users", { token }),
  // Paginated + server-searched directory for the Contacts list. Returns
  // { users, hasMore }. offset paging; q is an optional server-side search.
  getUsersPage: (
    token,
    opts?: { limit?: number; offset?: number; q?: string },
  ) => {
    const p = new URLSearchParams();
    p.set("limit", String((opts && opts.limit) || 50));
    p.set("offset", String((opts && opts.offset) || 0));
    if (opts && opts.q) p.set("q", opts.q);
    return req("/api/users/page?" + p.toString(), { token });
  },
  // Org-scoped directory search for people pickers (returns pubUser rows).
  searchUsers: (token, q) =>
    req(`/api/users/search?q=${encodeURIComponent(q)}`, { token }),
  getInvites: (token) => req("/api/invites", { token }),
  sendInvite: (token, toUserId) =>
    req("/api/invites", { method: "POST", token, body: { toUserId } }),
  acceptInvite: (token, id) =>
    req(`/api/invites/${id}/accept`, { method: "POST", token }),
  declineInvite: (token, id) =>
    req(`/api/invites/${id}/decline`, { method: "POST", token }),
  blockInvite: (token, id) =>
    req(`/api/invites/${id}/block`, { method: "POST", token }),
  // Sender withdraws their own pending request (recipient's copy disappears too).
  cancelInvite: (token, id) =>
    req(`/api/invites/${id}/cancel`, { method: "POST", token }),
  getFrequentUsers: (token) => req("/api/users/frequent", { token }),
  getBlockedUsers: (token) => req("/api/users/blocks", { token }),
  blockUser: (token, userId, reason?) =>
    req(`/api/users/${userId}/block`, {
      method: "POST",
      token,
      body: { reason },
    }),
  unblockUser: (token, userId) =>
    req(`/api/users/${userId}/block`, { method: "DELETE", token }),
  reportUser: (token, userId, reason?) =>
    req(`/api/users/${userId}/report`, {
      method: "POST",
      token,
      body: { reason },
    }),
  getReportedUsers: (token) => req("/api/users/reports", { token }),
  removeReport: (token, reportId) =>
    req(`/api/users/reports/${reportId}`, { method: "DELETE", token }),
  getConversations: (token) => req("/api/conversations", { token }),
  createConversation: (token, payload) =>
    req("/api/conversations", { method: "POST", token, body: payload }),
  // BA/CEO: preserve a call's ephemeral chat as an auto-expiring temp group at
  // hangup (meetings do this server-side; call chat is never persisted).
  tempGroupFromCall: (token, payload) =>
    req("/api/conversations/temp-from-session", { method: "POST", token, body: payload }),
  getMessages: (token, id, opts?: { before?: string }) =>
    req(
      `/api/conversations/${id}/messages${opts && opts.before ? `?before=${encodeURIComponent(opts.before)}` : ""}`,
      { token },
    ),
  sendMessage: (token, id, text, parentMessageId?) =>
    req(`/api/conversations/${id}/messages`, {
      method: "POST",
      token,
      body: { text, parentMessageId },
    }),
  // Link unfurl: returns { url, title, description, image, siteName } | null.
  getLinkPreview: (token, url) =>
    req(`/api/link-preview?url=${encodeURIComponent(url)}`, { token }),
  // Posts a full message payload verbatim — used by the offline HTTP fallback so
  // an E2EE message's { encrypted } envelopes (and never the plaintext) are sent.
  sendPayload: (token, id, payload) =>
    req(`/api/conversations/${id}/messages`, {
      method: "POST",
      token,
      body: payload,
    }),
  forwardMessage: (token, id, text, body) =>
    req(`/api/conversations/${id}/messages`, {
      method: "POST",
      token,
      body: { text, ...body, forwarded: true },
    }),
  bookmark: (token, cid, mid) =>
    req(`/api/conversations/${cid}/messages/${mid}/bookmark`, {
      method: "POST",
      token,
    }),
  getBookmarks: (token) => req("/api/bookmarks", { token }),
  addMembers: (token, id, userIds, shareHistory = true) =>
    req(`/api/conversations/${id}/members`, {
      method: "POST",
      token,
      // #16: shareHistory=false withholds prior messages from the new members.
      body: { userIds, shareHistory },
    }),
  // Promote a 1:1 call to a group: the server makes a group conversation from the
  // two call parties + the invitees and returns its id, so the call moves to the
  // "conv_<id>" room. Used by the in-call "Add people" control on 1:1 calls.
  addCallParticipants: (token, callId, userIds) =>
    req(`/api/calls/${callId}/add-participants`, {
      method: "POST",
      token,
      body: { userIds },
    }),
  getMembers: (token, id) => req(`/api/conversations/${id}/members`, { token }),
  setMemberRole: (token, id, uid, role) =>
    req(`/api/conversations/${id}/members/${uid}`, {
      method: "PATCH",
      token,
      body: { role },
    }),
  removeMember: (token, id, uid) =>
    req(`/api/conversations/${id}/members/${uid}`, { method: "DELETE", token }),
  leaveConversation: (token, id) =>
    req(`/api/conversations/${id}/members/me`, { method: "DELETE", token }),
  setStar: (token, id, value) =>
    req(`/api/conversations/${id}/star`, {
      method: "POST",
      token,
      body: { value },
    }),
  setMute: (token, id, value) =>
    req(`/api/conversations/${id}/mute`, {
      method: "POST",
      token,
      body: { value },
    }),
  // receipts=false suppresses the read-receipt broadcast to others (WhatsApp:
  // turning read receipts off stops you sending them). Unread state still clears.
  setRead: (token, id, read, receipts = true) =>
    req(`/api/conversations/${id}/read`, {
      method: "POST",
      token,
      body: { read, receipts },
    }),
  getReceipts: (token, id) =>
    req(`/api/conversations/${id}/receipts`, { token }),
  getThread: (token, id, mid) =>
    req(`/api/conversations/${id}/thread/${mid}`, { token }),
  hideConversation: (token, id, value) =>
    req(`/api/conversations/${id}/hide`, {
      method: "POST",
      token,
      body: { value },
    }),
  clearConversation: (token, id) =>
    req(`/api/conversations/${id}/clear`, { method: "POST", token }),
  deleteConversation: (token, id) =>
    req(`/api/conversations/${id}`, { method: "DELETE", token }),
  editMessage: (token, cid, mid, text, encrypted = null) =>
    req(`/api/conversations/${cid}/messages/${mid}`, {
      method: "PATCH",
      token,
      body: encrypted ? { encrypted } : { text },
    }),
  deleteMessage: (token, cid, mid) =>
    req(`/api/conversations/${cid}/messages/${mid}`, {
      method: "DELETE",
      token,
    }),

  listScheduled: (token, cid) =>
    req(`/api/conversations/${cid}/scheduled`, { token }),
  scheduleMessage: (token, cid, body, sendAt, encrypted: any = null) =>
    req(`/api/conversations/${cid}/scheduled`, {
      method: "POST",
      token,
      // `body` (plaintext) is the sender's scheduled-list preview; `encrypted` is
      // the per-device E2EE envelope delivered at send time (null for non-E2EE).
      body: { body, sendAt, encrypted },
    }),
  rescheduleMessage: (token, cid, sid, patch) =>
    req(`/api/conversations/${cid}/scheduled/${sid}`, {
      method: "PATCH",
      token,
      body: patch,
    }),
  cancelScheduled: (token, cid, sid) =>
    req(`/api/conversations/${cid}/scheduled/${sid}`, {
      method: "DELETE",
      token,
    }),
  updateAvatar: (token, avatarUrl) =>
    req("/api/users/me", { method: "PATCH", token, body: { avatarUrl } }),
  updateProfile: (token, patch) =>
    req("/api/users/me", { method: "PATCH", token, body: patch }),
  renameConversation: (token, id, title, icon) =>
    req(`/api/conversations/${id}`, {
      method: "PATCH",
      token,
      body: { title, icon },
    }),
  updateConversation: (token, id, patch) =>
    req(`/api/conversations/${id}`, { method: "PATCH", token, body: patch }),
  // Temp-group lifecycle: promote to a permanent group, or change its auto-delete
  // window (sliding N-day TTL). Both ride the same PATCH; server is member-gated.
  convertConversationToPermanent: (token: string, id: string) =>
    req(`/api/conversations/${id}`, { method: "PATCH", token, body: { temporary: false } }),
  setConversationRetention: (token: string, id: string, retentionDays: number) =>
    req(`/api/conversations/${id}`, { method: "PATCH", token, body: { retentionDays } }),
  deleteMessageForMe: (token, cid, mid) =>
    req(`/api/conversations/${cid}/messages/${mid}/delete-me`, {
      method: "POST",
      token,
    }),
  getFiles: (token, id) => req(`/api/conversations/${id}/files`, { token }),
  getLinks: (token, id) => req(`/api/conversations/${id}/links`, { token }),
  search: (token, q) =>
    req(`/api/search?q=${encodeURIComponent(q)}`, { token }),
  // Paginated. Returns { files, hasMore, nextCursor, count }. Pass { cursor }
  // (the opaque token from a prior page) to fetch the next page, an optional
  // { limit } (server-clamped), an optional { tab } (owned/shared/starred/all)
  // to paginate WITHIN a tab (count + pages stay correct per tab), and an optional
  // { search } — a name/type filter applied SERVER-SIDE within the tab so search
  // spans ALL the user's files, not just the loaded page. Mirrors getTasks /
  // getReminders.
  listFiles: (
    token,
    opts: {
      cursor?: string | null;
      limit?: number;
      tab?: string;
      search?: string;
    } = {},
  ) => {
    const qs: string[] = [];
    if (opts && opts.cursor) qs.push("cursor=" + encodeURIComponent(opts.cursor));
    if (opts && opts.limit) qs.push("limit=" + encodeURIComponent(opts.limit));
    if (opts && opts.tab) qs.push("tab=" + encodeURIComponent(opts.tab));
    if (opts && opts.search)
      qs.push("search=" + encodeURIComponent(opts.search));
    return req("/api/files" + (qs.length ? "?" + qs.join("&") : ""), { token });
  },
  // Recycle bin: the caller's OWN soft-deleted files, newest-deleted first.
  // Paginated like listFiles. Returns { files, hasMore, nextCursor }; each file
  // carries deletedAt.
  listDeletedFiles: (
    token,
    opts: { cursor?: string | null; limit?: number } = {},
  ) => {
    const qs: string[] = [];
    if (opts && opts.cursor) qs.push("cursor=" + encodeURIComponent(opts.cursor));
    if (opts && opts.limit) qs.push("limit=" + encodeURIComponent(opts.limit));
    return req("/api/files/trash" + (qs.length ? "?" + qs.join("&") : ""), {
      token,
    });
  },
  // Restore a soft-deleted file from the recycle bin (owner-only server-side).
  restoreFile: (token, id) =>
    req(`/api/files/${id}/restore`, { method: "POST", token }),
  // XMLHttpRequest (not fetch) so we can report upload progress via
  // upload.onprogress. The request shape is byte-identical to the old fetch call
  // (raw file body, metadata in the query string, same headers, same {ok,data,
  // error} envelope), so all existing callers keep working — onProgress is an
  // optional 4th arg.
  uploadFile: (
    token,
    file,
    conversationId?,
    onProgress?: (pct: number) => void,
    encrypted?: { version: number; algorithm?: string } | null,
    signal?: AbortSignal,
  ) =>
    new Promise<any>((resolve, reject) => {
      // Cancellable: if the caller's AbortController fires we abort the XHR (the
      // onabort handler below rejects with an AbortError the caller can detect).
      if (signal?.aborted) {
        reject(new DOMException("Upload aborted", "AbortError"));
        return;
      }
      const qs = new URLSearchParams({
        name: file.name || "file",
        mime: file.type || "application/octet-stream",
      });
      if (conversationId) qs.set("conversationId", conversationId);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", base + "/api/files?" + qs.toString());
      xhr.setRequestHeader(
        "Content-Type",
        file.type || "application/octet-stream",
      );
      if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);
      // E2EE marker: backend reads X-CoLab-E2EE and stamps encryption_version
      // on the file row so DB audits ("are files actually encrypted?") return
      // the truth. Without it the row reads encryption_version=0 even though
      // the bytes on disk are AES-GCM ciphertext.
      if (encrypted)
        xhr.setRequestHeader(
          "X-CoLab-E2EE",
          JSON.stringify({
            version: encrypted.version || 1,
            algorithm: encrypted.algorithm || "aes-gcm",
          }),
        );
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable)
            onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = () => {
        let json: any = null;
        try {
          json = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON body */
        }
        if (!json || json.ok !== true) {
          // Surface the real reason so failures are diagnosable instead of an
          // opaque "Upload failed": prefer the server's error message, else the
          // HTTP status (e.g. 413 too large, 500 server error, 429 rate-limited).
          const serverMsg = json && json.error && json.error.message;
          const err: any = new Error(
            serverMsg || `Upload failed (HTTP ${xhr.status || "?"})`,
          );
          // Carry the server's error code (e.g. STORAGE_UNAVAILABLE) so callers
          // can show a curated server message verbatim instead of re-labelling
          // it as a network or encryption failure.
          err.code = (json && json.error && json.error.code) || null;
          err.status = xhr.status || 0;
          reject(err);
          return;
        }
        resolve(json.data);
      };
      xhr.onerror = () =>
        reject(
          new Error(
            "Upload failed — couldn't reach the server (network error).",
          ),
        );
      xhr.onabort = () =>
        reject(new DOMException("Upload aborted", "AbortError"));
      if (signal)
        signal.addEventListener("abort", () => xhr.abort(), { once: true });
      xhr.send(file);
    }),
  deleteFile: (token, id) =>
    req(`/api/files/${id}`, { method: "DELETE", token }),
  starFile: (token, id, starred) =>
    req(`/api/files/${id}/star`, { method: "POST", token, body: { starred } }),
  downloadFile: async (token, id) => {
    const res = await fetch(base + `/api/files/${id}/download`, {
      headers: { ...(token ? { Authorization: "Bearer " + token } : {}) },
    });
    if (!res.ok) throw new Error("Download failed");
    return res.blob();
  },
  filePresignedUrl: (token, id) => req(`/api/files/${id}/presigned`, { token }),
  // AUDIT #28: short-lived signed ticket for a SAME-ORIGIN streaming download of
  // an oversized attachment. Returns { ticket, url } — navigate the browser to
  // fileLinkUrl(url) to stream the download through the backend proxy.
  fileDownloadTicket: (token, id) =>
    req(`/api/files/${id}/download-ticket`, { token }),
  fileDetails: (token, id) => req(`/api/files/${id}/details`, { token }),
  listFileShares: (token, id) => req(`/api/files/${id}/shares`, { token }),
  shareFile: (token, id, subjectType, subjectId, permission) =>
    req(`/api/files/${id}/share`, {
      method: "POST",
      token,
      body: { subjectType, subjectId, permission },
    }),
  unshareFile: (token, id, shareId) =>
    req(`/api/files/${id}/shares/${shareId}`, { method: "DELETE", token }),
  createFileLink: (token, id, permission) =>
    req(`/api/files/${id}/link`, {
      method: "POST",
      token,
      body: { permission },
    }),
  revokeFileLink: (token, id) =>
    req(`/api/files/${id}/link`, { method: "DELETE", token }),
  fileLinkUrl: (path) => base + path,
  getMeetings: (token) => req("/api/meetings?calendar=true", { token }),
  createMeeting: (token, payload) =>
    req("/api/meetings", { method: "POST", token, body: payload }),
  updateMeeting: (token, id, patch) =>
    req(`/api/meetings/${id}`, { method: "PATCH", token, body: patch }),
  deleteMeeting: (token, id) =>
    req(`/api/meetings/${id}`, { method: "DELETE", token }),
  leaveMeeting: (token, id) =>
    req(`/api/meetings/${id}/leave`, { method: "POST", token }),
  rsvpMeeting: (token, id, status) =>
    req(`/api/meetings/${id}/rsvp`, {
      method: "POST",
      token,
      body: { status },
    }),
  inviteMeetingAttendee: (token, id, userId) =>
    req(`/api/meetings/${id}/invite`, {
      method: "POST",
      token,
      body: { userId },
    }),
  inviteMeetingConversation: (token, id, conversationId) =>
    req(`/api/meetings/${id}/invite`, {
      method: "POST",
      token,
      body: { conversationId },
    }),
  getRecordings: (token, id) =>
    req(`/api/meetings/${id}/recordings`, { token }),
  startRecording: (token, id) =>
    req(`/api/meetings/${id}/recordings/start`, { method: "POST", token }),
  stopRecording: (token, id, rid) =>
    req(`/api/meetings/${id}/recordings/${rid}/stop`, {
      method: "POST",
      token,
    }),
  deleteRecording: (token, id, rid) =>
    req(`/api/meetings/${id}/recordings/${rid}`, { method: "DELETE", token }),
  // Upload a browser-recorded (MediaRecorder) meeting blob — lands as a ready,
  // playable recording. Raw body, like leaveVoicemail.
  uploadRecording: async (token, id, blob, opts: any = {}) => {
    const qs = new URLSearchParams();
    qs.set("mime", opts.mime || blob.type || "video/webm");
    if (opts.durationSec) qs.set("durationSec", String(opts.durationSec));
    const res = await fetch(
      base + `/api/meetings/${id}/recordings/upload?` + qs.toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": opts.mime || blob.type || "video/webm",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        body: blob,
      },
    );
    const json = await res.json();
    if (!json || json.ok !== true)
      throw new Error(
        (json && json.error && json.error.message) || "Recording upload failed",
      );
    return json.data;
  },
  // Fetch a recording's bytes (auth'd) for inline playback — the <video> element
  // can't send a Bearer header, so we fetch → objectURL like attachments do.
  recordingBlob: async (token, path) => {
    const res = await fetch(base + path, {
      headers: token ? { Authorization: "Bearer " + token } : {},
    });
    if (!res.ok) throw new Error("Couldn't load the recording");
    return res.blob();
  },
  // MIC-02: report the local participant's OWN mute state so the server can
  // enforce it at the SFU. `room` is LiveKit's Room.name (conv_*/call_*/meeting_*).
  // Fire-and-forget at every call site — enforcement is belt-and-braces, a lost
  // report must never affect the UI.
  reportMuteState: (token, room: string, muted: boolean) =>
    req(`/api/calls/media/self-mute-state`, { method: "POST", token, body: { room, muted } }),
  muteAllMeetingParticipants: (token, id) =>
    req(`/api/meetings/${id}/controls/mute-all`, { method: "POST", token }),
  muteMeetingParticipant: (token, id, userId, muted = true) =>
    req(`/api/meetings/${id}/controls/participants/${userId}/mute`, {
      method: "POST",
      token,
      body: { muted },
    }),
  removeMeetingParticipant: (token, id, userId) =>
    req(`/api/meetings/${id}/controls/participants/${userId}`, {
      method: "DELETE",
      token,
    }),
  promoteMeetingCoHost: (token, id, userId) =>
    req(`/api/meetings/${id}/controls/participants/${userId}/promote`, {
      method: "POST",
      token,
    }),
  demoteMeetingCoHost: (token, id, userId) =>
    req(`/api/meetings/${id}/controls/participants/${userId}/demote`, {
      method: "POST",
      token,
    }),
  toggleMeetingLobby: (token, id, enabled) =>
    req(`/api/meetings/${id}/lobby/toggle`, {
      method: "POST",
      token,
      body: { enabled },
    }),
  lockMeeting: (token, id, locked) =>
    req(`/api/meetings/${id}/lock`, {
      method: "POST",
      token,
      body: { locked },
    }),
  // Free/busy for the scheduler. INTERNAL meetings only — it says nothing about
  // anyone's Outlook or Google calendar, because there is no calendar sync.
  meetingAvailability: (token, body) =>
    req(`/api/meetings/availability`, { method: "POST", token, body }),
  // Meeting polls (0121). Reading and voting are open to anyone in the meeting;
  // create / close / delete are host-only, enforced server-side.
  getMeetingPolls: (token, id) => req(`/api/meetings/${id}/polls`, { token }),
  createMeetingPoll: (token, id, body) =>
    req(`/api/meetings/${id}/polls`, { method: "POST", token, body }),
  voteMeetingPoll: (token, id, pollId, optionIndexes) =>
    req(`/api/meetings/${id}/polls/${pollId}/vote`, {
      method: "POST",
      token,
      body: { optionIndexes },
    }),
  closeMeetingPoll: (token, id, pollId) =>
    req(`/api/meetings/${id}/polls/${pollId}/close`, { method: "POST", token }),
  deleteMeetingPoll: (token, id, pollId) =>
    req(`/api/meetings/${id}/polls/${pollId}`, { method: "DELETE", token }),
  meetingPollVoters: (token, id, pollId) =>
    req(`/api/meetings/${id}/polls/${pollId}/voters`, { token }),
  // Per-meeting options (0116). GET is open to anyone in the meeting — the
  // client needs the policy to disable controls the server would refuse anyway.
  getMeetingOptions: (token, id) => req(`/api/meetings/${id}/options`, { token }),
  setMeetingOptions: (token, id, patch) =>
    req(`/api/meetings/${id}/options`, { method: "PATCH", token, body: patch }),
  // Host Settings modal — the meeting's CREATOR only (the server refuses a
  // co-host). Camera / screen share / whiteboard, meeting-wide and per person.
  // Permissions are `true` = allowed.
  getMeetingHostControls: (token, id) =>
    req(`/api/meetings/${id}/controls/settings`, { token }),
  setMeetingHostSettings: (token, id, patch) =>
    req(`/api/meetings/${id}/controls/settings`, { method: "PATCH", token, body: patch }),
  setMeetingParticipantPermissions: (token, id, userId, patch) =>
    req(`/api/meetings/${id}/controls/participants/${userId}/permissions`, {
      method: "PATCH",
      token,
      body: patch,
    }),
  getMeetingLobby: (token, id) => req(`/api/meetings/${id}/lobby`, { token }),
  // The WAITING person's own view (status + who is inside / who else is
  // holding). Read-only on purpose: the wait screen polls it, and re-POSTing
  // /room/enter to poll would re-queue someone the host had just denied.
  getMyLobbyStatus: (token, id) => req(`/api/meetings/${id}/lobby/self`, { token }),
  // What the green room shows EVERYONE before joining — started/not, how many
  // are already in, and who. Same facts the lobby screen shows, so an invited
  // person who walks straight in and a held person waiting outside are told the
  // same thing.
  getMeetingPreview: (token, id) => req(`/api/meetings/${id}/preview`, { token }),
  admitLobbyParticipant: (token, id, userId) =>
    req(`/api/meetings/${id}/lobby/admit`, {
      method: "POST",
      token,
      body: { userId },
    }),
  denyLobbyParticipant: (token, id, userId) =>
    req(`/api/meetings/${id}/lobby/deny`, {
      method: "POST",
      token,
      body: { userId },
    }),
  admitAllLobby: (token, id) =>
    req(`/api/meetings/${id}/lobby/admit-all`, { method: "POST", token }),
  muteAllGroupCall: (token, convId) =>
    req(`/api/calls/group/${convId}/controls/mute-all`, {
      method: "POST",
      token,
    }),
  muteGroupCallParticipant: (token, convId, userId, muted = true) =>
    req(`/api/calls/group/${convId}/controls/participants/${userId}/mute`, {
      method: "POST",
      token,
      body: { muted },
    }),
  removeGroupCallParticipant: (token, convId, userId) =>
    req(`/api/calls/group/${convId}/controls/participants/${userId}`, {
      method: "DELETE",
      token,
    }),
  // 1:1 (direct) call host controls — target the "call_<id>" room, gated on the
  // call initiator server-side. Used when a call has a callId but no
  // conversationId (a DM call that wasn't promoted to a group).
  muteAllDirectCall: (token, callId) =>
    req(`/api/calls/direct/${callId}/controls/mute-all`, {
      method: "POST",
      token,
    }),
  muteDirectCallParticipant: (token, callId, userId, muted = true) =>
    req(`/api/calls/direct/${callId}/controls/participants/${userId}/mute`, {
      method: "POST",
      token,
      body: { muted },
    }),
  removeDirectCallParticipant: (token, callId, userId) =>
    req(`/api/calls/direct/${callId}/controls/participants/${userId}`, {
      method: "DELETE",
      token,
    }),
  leaveVoicemail: async (token, toUserId, blob, opts: any = {}) => {
    const qs = new URLSearchParams({ toUserId });
    if (opts.callId) qs.set("callId", opts.callId);
    if (opts.durationSec) qs.set("durationSec", String(opts.durationSec));
    qs.set("mime", opts.mime || blob.type || "audio/webm");
    const res = await fetch(base + "/api/calls/voicemail?" + qs.toString(), {
      method: "POST",
      headers: {
        "Content-Type": opts.mime || blob.type || "audio/webm",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: blob,
    });
    const json = await res.json();
    if (!json || json.ok !== true)
      throw new Error(
        (json && json.error && json.error.message) || "Voicemail failed",
      );
    return json.data;
  },
  getVoicemails: (token) => req("/api/calls/voicemails", { token }),
  markVoicemailListened: (token, id) =>
    req(`/api/calls/voicemails/${id}/listened`, { method: "POST", token }),
  deleteVoicemail: (token, id) =>
    req(`/api/calls/voicemails/${id}`, { method: "DELETE", token }),
  getVoicemailAudio: async (token, id) => {
    const res = await fetch(base + `/api/calls/voicemails/${id}/audio`, {
      headers: { ...(token ? { Authorization: "Bearer " + token } : {}) },
    });
    if (!res.ok) throw new Error("Audio unavailable");
    return res.blob();
  },
  // ── Public (guest) meeting link ──────────────────────────────────────────
  // Host side: get / create (idempotent) / revoke the link for a meeting. The
  // response carries the secret token and its /join/<token> path.
  getMeetingPublicLink: (token, id) =>
    req(`/api/meetings/${id}/public-link`, { token }),
  createMeetingPublicLink: (token, id) =>
    req(`/api/meetings/${id}/public-link`, { method: "POST", token }),
  revokeMeetingPublicLink: (token, id) =>
    req(`/api/meetings/${id}/public-link`, { method: "DELETE", token }),
  // Guest side (NO auth): what the lobby may show, and the join that mints a
  // short-lived guest session for the meeting behind the link.
  // `deviceId` is the browser profile's persistent guest id (lib/guestDevice.ts):
  // the server keeps ONE guest identity per browser profile per meeting.
  getPublicMeeting: (linkToken: string, deviceId?: string) =>
    req(
      `/api/public/meetings/${encodeURIComponent(linkToken)}` +
        (deviceId ? `?device=${encodeURIComponent(deviceId)}` : ""),
    ),
  joinPublicMeeting: (linkToken: string, name: string, deviceId?: string) =>
    req(`/api/public/meetings/${encodeURIComponent(linkToken)}/join`, {
      method: "POST",
      body: { name, ...(deviceId ? { deviceId } : {}) },
    }),
  enterMeetingRoom: (token, id) =>
    req(`/api/meetings/${id}/room/enter`, { method: "POST", token }),
  meetingRoomHeartbeat: (token, id) =>
    req(`/api/meetings/${id}/room/heartbeat`, { method: "POST", token }),
  leaveMeetingRoom: (token, id) =>
    req(`/api/meetings/${id}/room/leave`, { method: "POST", token }),
  // CNCL-01: cancel the whole series or (for a recurring meeting) one
  // occurrence — opts: { scope: "occurrence", occurrenceStartsAt }.
  // RCR-05: server-computed preview of a recurrence's next dates (nothing saved).
  previewMeetingOccurrences: (token, body) =>
    req(`/api/meetings/preview-occurrences`, { method: "POST", token, body }),
  cancelMeeting: (token, id, note?: string, opts?: any) =>
    req(`/api/meetings/${id}/cancel`, {
      method: "POST",
      token,
      body:
        note || (opts && opts.scope)
          ? { ...(note ? { note } : {}), ...(opts || {}) }
          : undefined,
    }),
  completeMeeting: (token, id) =>
    req(`/api/meetings/${id}/complete`, { method: "POST", token }),
  // Attendance report (host / co-host only). `since` pins the report to the
  // session an attendance card was posted for (recurring meetings share an id).
  getMeetingAttendance: (token, id, since?: string | null) =>
    req(
      `/api/meetings/${id}/attendance` +
        (since ? `?since=${encodeURIComponent(since)}` : ""),
      { token },
    ),
  // V1_2: reminders + folders
  // Paginated. Returns { reminders, hasMore, nextCursor, count, counts }. Pass
  // { cursor } (the opaque token from a prior page) to fetch the next page, and
  // an optional { limit } (server-clamped). `counts` carries the authoritative
  // per-smart-view / per-folder / open totals so badges don't undercount.
  getReminders: (token, opts: { cursor?: string | null; limit?: number } = {}) => {
    const qs: string[] = [];
    if (opts && opts.cursor) qs.push("cursor=" + encodeURIComponent(opts.cursor));
    if (opts && opts.limit) qs.push("limit=" + encodeURIComponent(opts.limit));
    return req("/api/reminders" + (qs.length ? "?" + qs.join("&") : ""), {
      token,
    });
  },
  createReminder: (token, body) =>
    req("/api/reminders", { method: "POST", token, body }),
  // NL QUICK-ADD (#53): server parses one line of natural language into a reminder.
  // Returns { created:true, reminder } when confident, or { created:false, draft }
  // (text/dueAt/recurrence/recurrenceRule) when ambiguous so the UI pre-fills the modal.
  quickAddReminder: (token, text, folderId = null) =>
    req("/api/reminders/quick", {
      method: "POST",
      token,
      // Thread the user's TIMEZONE so the server parses clock/relative times in the
      // user's zone, not the (UTC) server's. IANA zone is preferred (DST-aware);
      // the numeric offset is a fallback for environments where Intl is unavailable.
      body: {
        text,
        folderId,
        timeZone: (() => {
          try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }
        })(),
        tzOffsetMinutes: (() => {
          try { return new Date().getTimezoneOffset(); } catch { return null; }
        })(),
      },
    }),
  toggleReminder: (token, id) =>
    req(`/api/reminders/${id}/toggle`, { method: "POST", token }),
  patchReminder: (token, id, patch) =>
    req(`/api/reminders/${id}`, { method: "PATCH", token, body: patch }),
  setReminderStatus: (token, id, status) =>
    req(`/api/reminders/${id}/status`, {
      method: "POST",
      token,
      body: { status },
    }),
  // Snooze a reminder by `minutes` (default 10 server-side) — re-arms the firing
  // engine to re-fire once at now + minutes.
  snoozeReminder: (token, id, minutes) =>
    req(`/api/reminders/${id}/snooze`, {
      method: "POST",
      token,
      body: { minutes },
    }),
  // Complete a reminder (used by the notification "Complete" action).
  completeReminder: (token, id) =>
    req(`/api/reminders/${id}/complete`, { method: "POST", token }),
  bulkReminders: (token, body) =>
    req("/api/reminders/bulk", { method: "POST", token, body }),
  renameFolder: (token, id, name, icon) =>
    req(`/api/reminders/folders/${id}`, {
      method: "PATCH",
      token,
      body: { name, icon },
    }),
  deleteReminder: (token, id) =>
    req(`/api/reminders/${id}`, { method: "DELETE", token }),
  getFolders: (token) => req("/api/reminders/folders", { token }),
  createFolder: (token, body) =>
    req("/api/reminders/folders", { method: "POST", token, body }),
  deleteFolder: (token, id) =>
    req(`/api/reminders/folders/${id}`, { method: "DELETE", token }),
  // V1_2: calls
  // V1_2: tasks (native board)
  // Paginated. Returns { tasks, hasMore, nextCursor, count }. Pass
  // { cursor } (the opaque token from a prior page) to fetch the next page, and
  // an optional { limit } (server-clamped).
  getTasks: (
    token,
    opts: { cursor?: string | null; limit?: number; project?: string | null } = {},
  ) => {
    const qs: string[] = [];
    if (opts && opts.cursor) qs.push("cursor=" + encodeURIComponent(opts.cursor));
    if (opts && opts.limit) qs.push("limit=" + encodeURIComponent(opts.limit));
    // PROJECTS-AS-ENTITIES (#52b): SERVER-SIDE project filter. A project id filters
    // to that project; "none" filters to unfiled tasks; absent = no filter.
    if (opts && opts.project != null && opts.project !== "")
      qs.push("project=" + encodeURIComponent(opts.project));
    return req("/api/tasks" + (qs.length ? "?" + qs.join("&") : ""), { token });
  },
  // PROJECTS-AS-ENTITIES (#52b). Owner-scoped task projects (CRUD).
  getTaskProjects: (token) => req("/api/tasks/projects", { token }),
  createTaskProject: (token, body) =>
    req("/api/tasks/projects", { method: "POST", token, body }),
  updateTaskProject: (token, id, body) =>
    req(`/api/tasks/projects/${id}`, { method: "PATCH", token, body }),
  deleteTaskProject: (token, id) =>
    req(`/api/tasks/projects/${id}`, { method: "DELETE", token }),
  // SAVED VIEWS / SWIMLANES (#52b). User-scoped named board views (CRUD).
  getTaskViews: (token) => req("/api/tasks/views", { token }),
  createTaskView: (token, body) =>
    req("/api/tasks/views", { method: "POST", token, body }),
  updateTaskView: (token, id, body) =>
    req(`/api/tasks/views/${id}`, { method: "PATCH", token, body }),
  deleteTaskView: (token, id) =>
    req(`/api/tasks/views/${id}`, { method: "DELETE", token }),
  createTask: (token, body) =>
    req("/api/tasks", { method: "POST", token, body }),
  moveTask: (token, id, status) =>
    req(`/api/tasks/${id}/move`, { method: "POST", token, body: { status } }),
  // `version` is the optimistic-concurrency token the client last saw for this
  // task. Sent inside the body; the server guards the UPDATE on it and returns
  // 409 (with the current task in error.details.current) on a concurrent edit.
  updateTask: (token, id, patch, version?) =>
    req(`/api/tasks/${id}`, {
      method: "PATCH",
      token,
      body: version == null ? patch : { ...patch, version },
    }),
  deleteTask: (token, id) =>
    req(`/api/tasks/${id}`, { method: "DELETE", token }),
  getTaskActivity: (token, id) => req(`/api/tasks/${id}/activity`, { token }),
  getTaskDeps: (token, id) => req(`/api/tasks/${id}/deps`, { token }),
  addTaskDep: (token, id, dependsOnId) =>
    req(`/api/tasks/${id}/deps`, {
      method: "POST",
      token,
      body: { dependsOnId },
    }),
  removeTaskDep: (token, id, depId) =>
    req(`/api/tasks/${id}/deps/${depId}`, { method: "DELETE", token }),
  // Attachments (feature #51). The blob is uploaded via api.uploadFile (the
  // EXISTING Files streaming pipeline → a `files` row); these only manage the
  // task<->file LINK. listTaskAttachments returns the attachment summaries;
  // attachTaskFile links an already-uploaded file id; detachTaskFile unlinks it
  // (and soft-deletes the underlying file when the caller owns it). Each returns
  // the fresh attachment list. Download reuses api.downloadFile(token, fileId).
  listTaskAttachments: (token, id) =>
    req(`/api/tasks/${id}/attachments`, { token }),
  attachTaskFile: (token, id, fileId) =>
    req(`/api/tasks/${id}/attachments`, {
      method: "POST",
      token,
      body: { fileId },
    }),
  detachTaskFile: (token, id, fileId) =>
    req(`/api/tasks/${id}/attachments/${fileId}`, { method: "DELETE", token }),
  getTaskComments: (token, id) => req(`/api/tasks/${id}/comments`, { token }),
  addTaskComment: (token, id, body) =>
    req(`/api/tasks/${id}/comments`, { method: "POST", token, body: { body } }),
  removeTaskComment: (token, id, cid) =>
    req(`/api/tasks/${id}/comments/${cid}`, { method: "DELETE", token }),
  bulkTasks: (token, body) =>
    req("/api/tasks/bulk", { method: "POST", token, body }),
  // Multiple assignees (feature #50). add/remove one, or replace the whole set.
  addTaskAssignee: (token, id, userId) =>
    req(`/api/tasks/${id}/assignees`, {
      method: "POST",
      token,
      body: { userId },
    }),
  removeTaskAssignee: (token, id, userId) =>
    req(`/api/tasks/${id}/assignees/${userId}`, { method: "DELETE", token }),
  setTaskAssignees: (token, id, userIds) =>
    req(`/api/tasks/${id}/assignees`, {
      method: "PUT",
      token,
      body: { userIds },
    }),
  // Watchers. List / start watching / stop watching.
  getTaskWatchers: (token, id) => req(`/api/tasks/${id}/watchers`, { token }),
  watchTask: (token, id) =>
    req(`/api/tasks/${id}/watch`, { method: "POST", token }),
  unwatchTask: (token, id) =>
    req(`/api/tasks/${id}/watch`, { method: "DELETE", token }),
  // Subtasks / progress (feature #52a). List a parent's subtasks, add one under a
  // parent, or re-parent a task (cycle-guarded server-side). Each returns the
  // serialized subtask / list.
  listSubtasks: (token, id) => req(`/api/tasks/${id}/subtasks`, { token }),
  createSubtask: (token, id, body) =>
    req(`/api/tasks/${id}/subtasks`, { method: "POST", token, body }),
  setTaskParent: (token, id, parentId) =>
    req(`/api/tasks/${id}/parent`, {
      method: "PUT",
      token,
      body: { parentId: parentId || null },
    }),
  // CSV export (feature #52a). Streams the caller's FULL accessible task set as a
  // text/csv download (authz-scoped + CSV-injection-safe server-side). Returns a
  // Blob the caller saves; mirrors downloadFile (raw fetch, not the { ok } envelope).
  exportTasksCsv: async (token) => {
    const res = await fetch(base + "/api/tasks/export.csv", {
      headers: { ...(token ? { Authorization: "Bearer " + token } : {}) },
    });
    if (!res.ok) throw new Error("Export failed");
    return res.blob();
  },
  getCalls: (token, opts: { before?: string; limit?: number } = {}) => {
    const qs =
      opts && opts.before
        ? `?before=${encodeURIComponent(opts.before)}` +
          (opts.limit ? `&limit=${opts.limit}` : "")
        : "";
    return req(`/api/calls${qs}`, { token });
  },
  getCallToken: (token, body) =>
    req("/api/calls/token", { method: "POST", token, body }),
  getDiagToken: (token) =>
    req("/api/calls/diag-token", { method: "POST", token }),
  // V1_2: settings
  getSettings: (token) => req("/api/settings", { token }),
  getAuditLog: (token) => req("/api/audit", { token }),
  // ── Error ledger (error_logs table) — admin triage + client reports ──
  listErrorLogs: (token, opts: any = {}) => {
    const qs = new URLSearchParams();
    for (const k of ["status", "severity", "source", "q", "limit"])
      if (opts[k] != null && opts[k] !== "") qs.set(k, String(opts[k]));
    const tail = qs.toString();
    return req(`/api/logs${tail ? "?" + tail : ""}`, { token });
  },
  resolveErrorLog: (token, id, body) =>
    req(`/api/logs/${id}`, { method: "PATCH", token, body }),
  reportClientError: (token, body) =>
    req("/api/logs/client", { method: "POST", token, body }),
  // ── Report a concern (Settings) ──
  submitConcern: (token, body) =>
    req("/api/concerns", { method: "POST", token, body }),
  myConcerns: (token) => req("/api/concerns/mine", { token }),
  orgConcerns: (token, status?: string) =>
    req(`/api/concerns${status ? `?status=${encodeURIComponent(status)}` : ""}`, { token }),
  updateConcern: (token, id, body) =>
    req(`/api/concerns/${id}`, { method: "PATCH", token, body }),
  askAgent: (token, prompt) =>
    req("/api/ai/ask", { method: "POST", token, body: { prompt } }),
  summarizeConversation: (token, conversationId) =>
    req("/api/ai/summarize", {
      method: "POST",
      token,
      body: { conversationId },
    }),
  updateSettings: (token, body) =>
    req("/api/settings", { method: "PUT", token, body }),
  // E2EE
  e2eeDevices: (token) => req("/api/e2ee/devices", { token }),
  e2eeRegisterDevice: (token, body) =>
    req("/api/e2ee/devices", { method: "POST", token, body }),
  e2eeRevokeDevice: (token, deviceId) =>
    req(`/api/e2ee/devices/${deviceId}`, { method: "DELETE", token }),
  e2eeApproveDevice: (token, deviceId) =>
    req(`/api/e2ee/devices/${deviceId}/approve`, { method: "POST", token }),
  e2eePublishPreKeys: (token, deviceId, keys) =>
    req(`/api/e2ee/devices/${deviceId}/prekeys`, {
      method: "POST",
      token,
      body: { keys },
    }),
  e2eeConsumePreKey: (token, deviceId, keyId) =>
    req(`/api/e2ee/devices/${deviceId}/prekeys/${keyId}/consume`, {
      method: "POST",
      token,
    }),
  e2eeBundleFor: (token, userId) =>
    req(`/api/e2ee/users/${userId}/bundle`, { token }),
  e2eeGetConversationKeys: (token, conversationId) =>
    req(`/api/e2ee/conversations/${conversationId}/keys`, { token }),
  e2eePutConversationKeys: (token, conversationId, envelopes) =>
    req(`/api/e2ee/conversations/${conversationId}/keys`, {
      method: "POST",
      token,
      body: { envelopes },
    }),
  e2eeCreateConversationEpoch: (token, conversationId, version, envelopes) =>
    req(`/api/e2ee/conversations/${conversationId}/epoch`, {
      method: "POST",
      token,
      body: { version, envelopes },
    }),
  // Epoch-key backfill: ask the conversation's online members to re-wrap the
  // existing epoch key to THIS device (server relays to the conversation room).
  e2eeRequestEpochRekey: (token, conversationId) =>
    req(`/api/e2ee/conversations/${conversationId}/keys/rekey-request`, {
      method: "POST",
      token,
    }),
  // Mechanism A: server-blind device-link history sync. No deviceId param — the
  // server derives the target/source device from the device-bound JWT.
  e2eePutHistorySync: (
    token,
    targetDeviceId,
    bundleId,
    chunkIndex,
    chunkCount,
    ciphertext,
    algorithm,
  ) =>
    req("/api/e2ee/history-sync", {
      method: "POST",
      token,
      body: { targetDeviceId, bundleId, chunkIndex, chunkCount, ciphertext, algorithm },
    }),
  e2eeGetHistorySync: (token) => req("/api/e2ee/history-sync", { token }),
  e2eeAckHistorySync: (token, bundleId) =>
    req(
      "/api/e2ee/history-sync" +
        (bundleId ? "?bundleId=" + encodeURIComponent(bundleId) : ""),
      { method: "DELETE", token },
    ),
  // On-demand heal: this device rendered "[Encrypted — not available…]" for these
  // conversations. The server relays the request to the user's OTHER devices
  // (socket), which push a targeted history bundle back through the relay above.
  // deviceId rides along as a fallback identity: a brand-new device's token may
  // not be device-bound yet, and that is exactly the device that needs healing.
  // The server verifies the id belongs to the caller before relaying.
  // Sender re-delivery of one DM message this device cannot open.
  e2eeRequestRedelivery: (token, messageId: string, deviceId?: string | null) =>
    req(`/api/e2ee/messages/${encodeURIComponent(messageId)}/redeliver`, {
      method: "POST",
      token,
      body: deviceId ? { deviceId } : {},
    }),
  e2eePutRedeliveredEnvelope: (
    token,
    messageId: string,
    body: { recipientId: string; recipientDeviceId: string; envelope: any },
  ) =>
    req(`/api/e2ee/messages/${encodeURIComponent(messageId)}/envelope`, {
      method: "PUT",
      token,
      body,
    }),
  e2eeRequestRedeliveryBulk: (token, messageIds: string[], deviceId?: string | null) =>
    req("/api/e2ee/messages/redeliver/bulk", {
      method: "POST",
      token,
      body: { messageIds, ...(deviceId ? { deviceId } : {}) },
      silent: true,
    }),
  e2eeGetOwnEnvelopes: (token, messageIds: string[], deviceId?: string | null) =>
    req("/api/e2ee/messages/own-envelopes", {
      method: "POST",
      token,
      body: { messageIds, ...(deviceId ? { deviceId } : {}) },
      silent: true,
    }),
  e2eeGetMessageEnvelopes: (token, messageId: string) =>
    req(`/api/e2ee/messages/${encodeURIComponent(messageId)}`, { token, silent: true }),
  e2eeRedeliverStatus: (token, conversationId: string, deviceId?: string | null) =>
    req(
      "/api/e2ee/redeliver-requests/status?conversationId=" + encodeURIComponent(conversationId) +
        (deviceId ? "&deviceId=" + encodeURIComponent(deviceId) : ""),
      { token, silent: true },
    ),
  // Stored re-delivery asks this device can answer (0126).
  e2eeRedeliverRequests: (token, deviceId?: string | null) =>
    req("/api/e2ee/redeliver-requests" + (deviceId ? "?deviceId=" + encodeURIComponent(deviceId) : ""), { token, silent: true }),
  // What the server can say about the caller's recovery state (no secrets).
  e2eeDiagnostics: (token, deviceId?: string | null) =>
    req("/api/e2ee/diagnostics" + (deviceId ? "?deviceId=" + encodeURIComponent(deviceId) : ""), { token, silent: true }),
  e2eeRequestHistorySync: (token, conversationIds: string[], deviceId?: string | null) =>
    req("/api/e2ee/history-sync/request", {
      method: "POST",
      token,
      body: { conversationIds, ...(deviceId ? { deviceId } : {}) },
    }),
  // Device-BIND the access token. A brand-new device signs in BEFORE its E2EE
  // device id exists, so its JWT carries no deviceId and every history-sync
  // call silently no-ops (the exact session where sync matters most). After
  // initE2EE mints/loads the device id, this rotates the token via the normal
  // refresh path (which sends deviceId) and broadcasts the rebound token to the
  // app. Returns the fresh token, or null when no rebind was possible/needed.
  rebindDeviceToken: async (currentToken: string): Promise<string | null> => {
    try {
      const want = e2eeDeviceId();
      if (!want || typeof window === "undefined") return null;
      const payload = JSON.parse(
        atob((currentToken.split(".")[1] || "").replace(/-/g, "+").replace(/_/g, "/")) || "{}",
      );
      if (String(payload.deviceId || "") === String(want)) return null; // already bound
      const fresh = await attemptRefresh();
      if (!fresh || fresh === REFRESH_RETRY) return null;
      window.dispatchEvent(
        new CustomEvent("colab:token-refreshed", { detail: { token: fresh } }),
      );
      return fresh;
    } catch {
      return null;
    }
  },
  // Mechanism B: server-blind encrypted history recovery backup. The body carries
  // only the non-secret salt + opaque base64 ciphertext/iv chunks; the server
  // never sees the recovery key, the derived KEK, or any plaintext.
  e2eePutRecoveryBackup: (
    token,
    salt: string,
    chunks: { index: number; count: number; ciphertext: string; iv: string }[],
    // Optional PASSWORD WRAP (auto-backup): the 32-byte recovery secret,
    // AES-GCM-wrapped client-side under a PBKDF2 key derived from the user's
    // sign-in password. Lets a brand-new device restore the whole backup right
    // after a password login — zero user ceremony (the WhatsApp model). The
    // server stores the opaque wrap and can no more open it than the backup.
    passwordWrap?: { ct: string; iv: string; salt: string; iterations: number } | null,
  ) =>
    req("/api/e2ee/recovery-backup", {
      method: "PUT",
      token,
      body: { salt, chunks, ...(passwordWrap ? { passwordWrap } : {}) },
    }),
  e2eeGetRecoveryBackup: (token) =>
    req("/api/e2ee/recovery-backup", { token }),
  // Metadata only (salt, version, wraps, size, a one-chunk probe) — no chunk
  // ciphertext. Use for every existence / capability / key-verification check
  // so they don't download the whole full-history backup.
  e2eeGetRecoveryBackupMeta: (token) =>
    req("/api/e2ee/recovery-backup?meta=1", { token }),
  // Automatic recovery: this user's server-escrowed account key (base64, 32
  // bytes). The recovery secret is wrapped under it (wrap kind 'account') so any
  // signed-in device restores history with no prompt. 404 when the server has
  // the feature off — callers treat that as "not available", not an error.
  e2eeGetAccountKey: (token) =>
    req("/api/e2ee/account-key", { token, silent: true }),
  e2eeDeleteRecoveryBackup: (token) =>
    req("/api/e2ee/recovery-backup", { method: "DELETE", token }),
  // Slice 2: add/replace a single recovery wrap (e.g. a recovery-passphrase wrap
  // of the SAME secret) WITHOUT re-uploading the backup chunks. Opaque to the
  // server. Kinds: 'password' | 'passphrase' | 'legacy-password'.
  e2eePutRecoveryWrap: (
    token,
    wrap: { kind: string; ct: string; iv: string; salt: string; iterations: number },
  ) =>
    req("/api/e2ee/recovery-wrap", { method: "PUT", token, body: wrap }),
  e2eeDeleteRecoveryWrap: (token, kind: string) =>
    req(
      "/api/e2ee/recovery-wrap?kind=" + encodeURIComponent(kind || "passphrase"),
      { method: "DELETE", token },
    ),
  // Notifications
  getNotifications: (token, opts?: { limit?: number; beforeId?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.beforeId) qs.set("beforeId", opts.beforeId);
    const q = qs.toString();
    return req(`/api/notifications${q ? "?" + q : ""}`, { token });
  },
  getUnreadNotificationCount: (token) =>
    req("/api/notifications/unread-count", { token }),
  markNotificationRead: (token, id) =>
    req(`/api/notifications/${id}/read`, { method: "POST", token }),
  markAllNotificationsRead: (token) =>
    req("/api/notifications/read-all", { method: "POST", token }),
  deleteNotification: (token, id) =>
    req(`/api/notifications/${id}`, { method: "DELETE", token }),

  reactMessage: (token, cid, mid, emoji) =>
    req(`/api/conversations/${cid}/messages/${mid}/react`, {
      method: "POST",
      token,
      body: { emoji },
    }),
  pinMessage: (token, cid, mid) =>
    req(`/api/conversations/${cid}/messages/${mid}/pin`, {
      method: "POST",
      token,
    }),
  unpinMessage: (token, cid, mid) =>
    req(`/api/conversations/${cid}/messages/${mid}/unpin`, {
      method: "POST",
      token,
    }),
  markImportant: (token, cid, mid, important) =>
    req(`/api/conversations/${cid}/messages/${mid}/important`, {
      method: "POST",
      token,
      body: { important },
    }),
  getPinnedMessages: (token, cid) =>
    req(`/api/conversations/${cid}/pinned`, { token }),
  // Push endpoints degrade gracefully (server may not have VAPID configured) —
  // `silent` keeps an expected 503 out of diagnostics and off the error pill.
  getVapidKey: (token) =>
    req("/api/push/vapid-key", { token, silent: true }),
  pushSubscribe: (token, subscription) =>
    req("/api/push/subscribe", { method: "POST", token, body: { subscription }, silent: true }),
  pushUnsubscribe: (token, endpoint) =>
    req("/api/push/unsubscribe", { method: "POST", token, body: { endpoint }, silent: true }),
  // Remote Control audit: records every control session (security requirement
  // "log every control session"). Fire-and-forget — callers `.catch(()=>{})` and
  // `silent` keeps a logging failure off the diagnostics error pill.
  logRemoteControl: (
    token,
    body: { action: string; peer: string; session?: string },
  ) =>
    req("/api/remote-control/log", {
      method: "POST",
      token,
      body,
      silent: true,
    }),
  // Server-side client-error aggregation. `silent` is REQUIRED here: a failed
  // telemetry POST must never call log.error (which would feed the telemetry
  // queue and loop). Auth is optional server-side — pass the token when known so
  // the error attaches to a user, but it works pre-login too. Best-effort.
  // §9.2 usage counters — same silent, fire-and-forget posture as error
  // telemetry: a failed POST must never surface or loop.
  reportEvents: (token: string | undefined, events: string[]) =>
    req(`/api/telemetry/events`, { method: "POST", token, body: { events }, silent: true } as any),
  reportClientErrors: (
    token: string | undefined,
    errors: Array<{
      level?: string;
      message: string;
      stack?: string;
      url?: string;
      appVersion?: string;
    }>,
  ) =>
    req("/api/telemetry/error", {
      method: "POST",
      token,
      body: { errors },
      silent: true,
    }),
  // Post-call / post-meeting feedback (#67). Fire-and-forget analytics: the
  // client already decided WHEN to show the dialog; this just records the result.
  // `silent` — a failed submit is surfaced by the caller (a toast), never as a
  // red diagnostics error.
  submitCallFeedback: (
    token: string | undefined,
    payload: {
      kind: "call" | "meeting";
      callId?: string | null;
      meetingId?: string | null;
      feedbackType: "good" | "issues";
      categories?: Record<string, string[]>;
      comment?: string;
      durationSec?: number;
      networkQuality?: string | null;
      platform?: string;
      os?: string;
      browser?: string;
      appVersion?: string;
      buildNumber?: string;
      // Session Replay Lite: the session's diagnostics timeline (plain text),
      // attached only on "issues" when the user leaves the checkbox on.
      diagnostics?: string;
    },
  ) =>
    req("/api/feedback/call", {
      method: "POST",
      token,
      body: payload,
      silent: true,
    }),
};
