import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, fail, db } from "../platform";
import authMiddleware from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import { PERMISSIONS } from "../services/rbacService";
import { record as logError, fingerprintOf } from "../services/logService";

router.use(authMiddleware);

// ── ERROR LEDGER API ─────────────────────────────────────────────────────────
// Read/triage is gated on audit:view — the same permission that guards the org
// audit feed, because the ledger serves the same governance audience (owners,
// admins, and any custom role granted it). The CLIENT-REPORT endpoint below is
// open to every signed-in user: reporting an error you hit is not a privilege.

// List with filters: ?status=open|resolved|ignored&severity=&source=&q=&limit=
router.get("/", requirePermission(PERMISSIONS.AUDIT_VIEW), async (req, res) => {
  const { status, severity, source, q, limit } = req.query as any;
  res.json(
    ok(
      await db.errorLogs.list({
        status: status || null,
        severity: severity || null,
        source: source || null,
        q: q || null,
        limit: limit || 100,
      }),
    ),
  );
});

// Triage: mark resolved/ignored (or re-open), with the resolution note and the
// owning dependency (infra | dev | external) — the columns the ops runbook keys on.
router.patch("/:id", requirePermission(PERMISSIONS.AUDIT_VIEW), async (req, res) => {
  const b = req.body || {};
  const status = ["resolved", "ignored", "open"].includes(b.status) ? b.status : "resolved";
  const dependency = ["infra", "dev", "external"].includes(b.dependency) ? b.dependency : null;
  const out = await db.errorLogs.resolve(req.params.id, {
    status,
    resolution: typeof b.resolution === "string" ? b.resolution.slice(0, 2000) : null,
    dependency,
    resolvedBy: req.user.userId,
  });
  if (!out) return res.status(404).json(fail("NOT_FOUND", "No such log entry."));
  res.json(ok(out));
});

// Frontend error reports (window.onerror / unhandledrejection / caught fatals).
// Body size is bounded field-by-field in the service; the global API limiter
// already throttles volume, and the client additionally dedups per session.
router.post("/client", async (req, res) => {
  const b = req.body || {};
  logError({
    source: "frontend",
    severity: b.severity === "warn" ? "warn" : "error",
    code: b.code,
    message: b.message,
    stack: b.stack,
    context: {
      url: typeof b.url === "string" ? b.url.slice(0, 300) : undefined,
      userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
    },
    requestPath: null,
    userId: req.user.userId,
  });
  res.json(ok({ recorded: true }));
});

export default router;

// Re-exported for tests (fingerprint grouping is part of the API contract).
export { fingerprintOf };
