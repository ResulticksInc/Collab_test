import { fail } from "../platform";
import { can } from "../services/rbacService";

// Route guard: gate an org-admin endpoint behind an RBAC permission (0069).
// Runs AFTER authMiddleware (which sets req.user + req.org from the session). It is
// lazy by design — only admin routes pay the permission lookup (cached in
// rbacService), so ordinary product traffic never hits the role catalog.
//
// Fail-closed: no active org → 403; missing permission → 403. The active org comes
// from the server-side session (auth.ts), so it is not client-forgeable; the
// separate membership gate (#68) additionally rejects a stale/forged active org.
export function requirePermission(permission: string) {
  return async (req: any, res: any, next: any) => {
    const userId = req.user?.userId;
    const orgId = req.org?.id || null;
    if (!userId)
      return res.status(401).json(fail("UNAUTHORIZED", "Missing user"));
    if (!orgId)
      return res
        .status(403)
        .json(fail("FORBIDDEN", "No active organization for this session"));
    let ok = false;
    try {
      ok = await can(userId, orgId, permission);
    } catch {
      ok = false; // fail-closed
    }
    if (!ok)
      return res
        .status(403)
        .json(fail("FORBIDDEN", "You don't have permission to do that"));
    return next();
  };
}
