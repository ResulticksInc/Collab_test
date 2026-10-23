import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, fail, db, currentOrgId } from "../platform";
import authMiddleware from "../middleware/auth";
import { requirePermission } from "../middleware/requirePermission";
import { PERMISSIONS } from "../services/rbacService";
import * as notifService from "../services/notificationService";
import { pushNotif } from "../realtime/notify";

router.use(authMiddleware);

// ── REPORT A CONCERN (Skype/Teams-style, filed from Settings) ────────────────
// Any signed-in user may file one; triage (list + status/response) is gated on
// org:manage — concerns are sensitive people/content reports, so they go to
// the org's actual managers, not everyone with audit read access.

const CATEGORIES = new Set(["harassment", "safety", "privacy", "content", "technical", "other"]);
// The product areas a concern can be filed against — MANDATORY at submission,
// so every report arrives with its owning module attached.
const MODULES = new Set([
  "chat", "calls", "meetings", "contacts", "tasks", "reminders", "files",
  "calendar", "organization", "notifications", "search", "settings",
  "desktop", "account", "other",
]);

// TRIAGE AT CAPTURE (mirrors the error ledger): every report lands with the
// owning dependency and a suggested-resolution playbook, so the handler starts
// from "here's what to do", not from a blank row.
//   dependency: 'infra' only for TECHNICAL reports whose text smells of
//   connectivity/resource failure; everything else is 'dev' (application/
//   policy side owns it). suggestedResolution: per-category playbook, with the
//   technical one split by that same infra/dev call.
function classifyConcern({ category, module, subject, body }: any): { dependency: string; suggestedResolution: string } {
  const text = `${subject || ""} ${String(body || "").replace(/<[^>]*>/g, " ")}`;
  const infraSmell = /timed? ?out|connect|connection|network|unreachable|server (down|error)|slow|lag|drop|disconnect|offline|5\d\d/i.test(text);
  if (category === "harassment")
    return { dependency: "dev", suggestedResolution: "Review the reported conversation and both members' history, apply the organization's conduct policy (warning, role restriction, or removal), and send the reporter a response." };
  if (category === "safety")
    return { dependency: "dev", suggestedResolution: "Treat as priority: verify whether anyone is at risk, escalate to HR/management immediately, and respond to the reporter with the action taken." };
  if (category === "privacy")
    return { dependency: "dev", suggestedResolution: "Identify what was exposed and to whom, restrict access and correct sharing/permissions (roles, channels), then confirm the fix to the reporter." };
  if (category === "content")
    return { dependency: "dev", suggestedResolution: "Review the reported content against policy, remove it if it violates (delete for everyone / withdraw broadcast), address the poster, and respond to the reporter." };
  if (category === "technical")
    return infraSmell
      ? { dependency: "infra", suggestedResolution: `Check server/network health (containers, LiveKit/coturn, DB) and the error_logs table for correlated infra entries around the report time in the ${module} module; restore service and confirm with the reporter.` }
      : { dependency: "dev", suggestedResolution: `Reproduce in the ${module} module using the reported steps, check the error_logs table for correlated entries from this user around the report time, fix, and confirm with the reporter.` };
  return { dependency: infraSmell ? "infra" : "dev", suggestedResolution: "Read the report, decide the owning area, handle per policy or route it to the right team, and respond to the reporter." };
}

router.post("/", async (req, res) => {
  const b = req.body || {};
  const bodyHtml = typeof b.body === "string" ? b.body.trim() : "";
  // Body must have real content: an empty rich-editor still submits "<p></p>".
  if (!bodyHtml || bodyHtml.replace(/<[^>]*>/g, "").trim().length === 0)
    return res.status(400).json(fail("EMPTY", "Please describe your concern."));
  // Module is REQUIRED — a concern must say which part of the product it is
  // about. The composer enforces this too; this is the authoritative gate.
  if (!MODULES.has(b.module))
    return res.status(400).json(fail("MODULE_REQUIRED", "Please select which part of Collab your concern is about."));
  const orgId = currentOrgId() || null;
  const category = CATEGORIES.has(b.category) ? b.category : "other";
  const triage = classifyConcern({ category, module: b.module, subject: b.subject, body: bodyHtml });
  const report = await db.concerns.create({
    userId: req.user.userId,
    orgId,
    category,
    module: b.module,
    dependency: triage.dependency,
    suggestedResolution: triage.suggestedResolution,
    subject: typeof b.subject === "string" && b.subject.trim() ? b.subject.trim() : null,
    body: bodyHtml.slice(0, 100_000),
    fileId: typeof b.fileId === "string" && b.fileId ? b.fileId : null,
  });
  res.status(201).json(ok(report));
  // Best-effort, after the response: ping everyone who can TRIAGE it.
  try {
    if (!orgId) return;
    const io = req.app.get("io");
    const [roster, roles, reporter] = await Promise.all([
      db.orgs.members(orgId),
      db.orgs.roleCatalog(orgId),
      db.users.getById(req.user.userId),
    ]);
    // Recipients = org:manage holders (the permission the triage routes gate
    // on) — same one-rule-for-both-sides principle as join requests.
    const managerRoles = new Set(
      (roles || [])
        .filter((r: any) => (r.permissions || []).includes(PERMISSIONS.ORG_MANAGE))
        .map((r: any) => r.key),
    );
    managerRoles.add("owner");
    managerRoles.add("admin");
    for (const m of (roster || []).filter(
      (x: any) => managerRoles.has(x.role) && x.status === "active" && x.userId !== req.user.userId,
    )) {
      const n = await notifService.notifyConcernReported({
        userId: m.userId,
        reporterName: reporter?.name || "A member",
        category: report.category,
        orgId,
      });
      if (n && io) pushNotif(io, n);
    }
  } catch (_) {
    /* best-effort */
  }
});

// The reporter's own reports — always visible to them, with current status.
router.get("/mine", async (req, res) =>
  res.json(ok(await db.concerns.listForUser(req.user.userId))),
);

// Triage list. [org:manage]
router.get("/", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const orgId = currentOrgId();
  if (!orgId) return res.status(400).json(fail("NO_ORG", "No active organization for this session."));
  const { status } = req.query as any;
  res.json(ok(await db.concerns.listForOrg(orgId, { status: status || null })));
});

// Triage update: status + written response, echoed to the reporter. [org:manage]
router.patch("/:id", requirePermission(PERMISSIONS.ORG_MANAGE), async (req, res) => {
  const orgId = currentOrgId();
  if (!orgId) return res.status(400).json(fail("NO_ORG", "No active organization for this session."));
  const b = req.body || {};
  const status = ["in_review", "closed", "open"].includes(b.status) ? b.status : "in_review";
  const out = await db.concerns.setStatus(req.params.id, orgId, {
    status,
    response: typeof b.response === "string" ? b.response.slice(0, 2000) : null,
    handledBy: req.user.userId,
  });
  if (!out) return res.status(404).json(fail("NOT_FOUND", "No such report."));
  res.json(ok(out));
  // Tell the reporter their concern moved — with the handler's response.
  try {
    if (out.userId !== req.user.userId) {
      const io = req.app.get("io");
      const n = await notifService.notifyConcernHandled({
        userId: out.userId,
        status: out.status,
        response: out.response,
      });
      if (n && io) pushNotif(io, n);
    }
  } catch (_) {
    /* best-effort */
  }
});

export default router;
