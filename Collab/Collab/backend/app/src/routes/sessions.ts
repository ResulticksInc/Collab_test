import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, db } from "../platform";
import authMiddleware from "../middleware/auth";
import { verify } from "../services/authService";
import { add as blockToken } from "../services/tokenBlocklist";
import { record } from "../services/auditService";
import { disconnectSession, disconnectOtherSessions } from "../realtime/socket";

// ── Active sessions (#66): list + revoke the caller's OWN login sessions ──────
// Mounted under /api/sessions, all routes behind authMiddleware so req.user.{userId,
// jti} are populated. Every query is user-scoped — the repo's `user_id` predicate is
// the IDOR guard, so a session id belonging to another user is a silent no-op, never
// their row. This surface NEVER touches calls/meetings/E2EE; it only reads/writes the
// auth_sessions table.
router.use(authMiddleware);

// GET /api/sessions — the caller's sessions, newest first; the request's own jti is
// flagged `current` so the UI can highlight "THIS device". `id` is intentionally
// returned so the UI can target a specific session in DELETE.
router.get("/", async (req, res) => {
  const u = (req as any).user;
  const rows = await db.sessions.listForUser(u.userId);
  const sessions = (rows || []).map((s: any) => ({
    id: s.id,
    deviceLabel: s.deviceLabel,
    deviceType: s.deviceType || null,
    browser: s.browser || null,
    os: s.os || null,
    platform: s.platform,
    ip: s.ip,
    city: s.city || null,
    country: s.country || null,
    location:
      [s.city, s.country].filter(Boolean).join(", ") || null,
    status: s.status || (s.revoked ? "revoked" : "active"),
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    expiresAt: s.expiresAt,
    revoked: s.revoked,
    current: !!u.jti && s.id === u.jti,
  }));
  res.json(ok({ sessions }));
});

// DELETE /api/sessions/:id — revoke ONE of the caller's sessions (IDOR-guarded by
// the repo's user_id predicate). Returns { revoked: boolean }. Revoking the CURRENT
// session is allowed (the next request 401s and the client auto-logs-out), and we
// also blocklist the current access token for an instant cut rather than waiting out
// its short TTL.
router.delete("/:id", async (req, res) => {
  const u = (req as any).user;
  const id = String(req.params.id || "");
  const revoked = await db.sessions.revoke(u.userId, id);
  if (revoked && u.jti && id === u.jti) {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    try {
      const payload: any = verify(token);
      await blockToken(token, payload.exp);
    } catch (_) {}
  }
  if (revoked) {
    await record({
      actorId: u.userId,
      action: "session.revoke",
      targetType: "session",
      targetId: id,
      detail: { self: !!u.jti && id === u.jti },
    });
    // Live enforcement: kick that device's open sockets NOW (not just on its next
    // REST call). Best-effort — never let a realtime hiccup fail the revoke.
    void disconnectSession(req.app.get("io"), id, "revoked");
  }
  res.json(ok({ revoked }));
});

// POST /api/sessions/revoke-others — "Sign out all other sessions": revoke every
// session EXCEPT the current one. Returns { revoked: <count> }. A request with no jti
// (a legacy token) keeps nothing — passing "" keeps no row, which is the safe choice.
router.post("/revoke-others", async (req, res) => {
  const u = (req as any).user;
  const out = await db.sessions.revokeOthers(u.userId, u.jti || "");
  if (out && (out.revoked || 0) > 0) {
    await record({
      actorId: u.userId,
      action: "session.revoke_others",
      targetType: "user",
      targetId: u.userId,
      detail: { count: out.revoked, keptJti: u.jti || null },
    });
    // Live enforcement: kick every OTHER device's open sockets now, keeping this one.
    void disconnectOtherSessions(req.app.get("io"), u.userId, u.jti || "");
  }
  res.json(ok(out));
});

export default router;
