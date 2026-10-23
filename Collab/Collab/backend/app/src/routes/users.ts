import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { shared, ok, db } from "../platform";
import authMiddleware from "../middleware/auth";
import { pubUser } from "../serialize";
const { EVENTS } = shared;
import {
  block as blockUser,
  unblock as unblockUser,
  list as listBlocked,
  report as reportUser,
  listReports,
  removeReport,
} from "../services/blockService";
router.use(authMiddleware);
router.get("/", async (req, res) =>
  res.json(ok((await db.users.list((req as any).org?.id)).map(pubUser))),
);

// Paginated + server-searched directory for the Contacts list. A SEPARATE endpoint
// from GET / (which stays a full list for the people-pickers and by-id lookups
// that need the whole set), so this scale improvement can't regress them. Static
// path — declared before any /:id route. Returns { users, hasMore }.
router.get("/page", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q = String(req.query.q || "").trim();
  const out = await db.users.listPage({
    orgId: (req as any).org?.id,
    q,
    limit,
    offset,
  });
  res.json(ok({ users: (out.users || []).map(pubUser), hasMore: !!out.hasMore }));
});

// Contacts ranked by interaction frequency (most-interacted first). Powers the
// dashboard "Frequent users" panel and frequency-ordered people pickers.
router.get("/frequent", async (req, res) => {
  const scores = await db.users.interactionScores(req.user.userId);
  // Resolve every scored user in ONE batched read instead of a getById per row
  // (N+1). Order, the `if (u)` filter and the {...u, score} shape are unchanged;
  // a map MISS still falls back to getById so the map is an optimization only.
  const byId = new Map<string, any>();
  const ids = scores.map((s: any) => s.userId).filter(Boolean);
  if (ids.length && (db.users as any).getByIds) {
    for (const u of (await (db.users as any).getByIds(ids)) || [])
      if (u && u.id) byId.set(u.id, u);
  }
  const out = [];
  for (const s of scores) {
    const raw = byId.has(s.userId)
      ? byId.get(s.userId)
      : await db.users.getById(s.userId);
    const u = pubUser(raw);
    if (u) out.push({ ...u, score: s.score });
  }
  res.json(ok(out));
});

// Org-scoped directory search for people pickers (invite-to-call, add-to-group)
// so the search box reaches the WHOLE tenant, not just already-loaded/DM-connected
// users. db.users.search restricts to the active org's members (LIMIT 20); pubUser
// strips password_hash etc. Static path — declared before any /:id route.
router.get("/search", async (req, res) =>
  res.json(
    ok(
      (
        await db.users.search(
          String(req.query.q || "").trim(),
          (req as any).org?.id || null,
        )
      ).map(pubUser),
    ),
  ),
);
router.patch("/me", async (req, res) => {
  const { avatarUrl, about, name, title, pronouns, phone, timezone } = req.body || {};
  const patch: any = {};
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl;
  if (about !== undefined) patch.about = typeof about === "string" ? about.slice(0, 255) : null;
  if (typeof name === "string" && name.trim()) patch.name = name.trim().slice(0, 255);
  // Structured profile fields. Empty string clears the field (stored as null).
  const strOrNull = (v: any, max: number) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  if (title !== undefined) patch.title = strOrNull(title, 120);
  if (pronouns !== undefined) patch.pronouns = strOrNull(pronouns, 40);
  if (phone !== undefined) patch.phone = strOrNull(phone, 40);
  if (timezone !== undefined) patch.timezone = strOrNull(timezone, 64);
  if (Object.keys(patch).length === 0) return res.status(400).json(ok({ updated: false }));
  const user = await db.users.updateProfile(req.user.userId, patch);
  const pub = pubUser(user);
  // Reflect the change everywhere, to everyone, instantly: every connected
  // client patches this person's avatar/name in their directory, DMs, and
  // message rows. The payload is just the small public-URL shape (no bloat).
  const io = req.app.get("io");
  if (io) io.emit(EVENTS.USER_UPDATED, pub);
  res.json(ok(pub));
});

// Block list (people the current user has blocked).
router.get("/blocks", async (req, res) =>
  res.json(ok(await listBlocked(req.user.userId))),
);
router.post("/:id/block", async (req, res) =>
  res.json(
    ok(
      await blockUser({
        blockerId: req.user.userId,
        blockedId: req.params.id,
        reason: (req.body || {}).reason,
      }),
    ),
  ),
);
router.delete("/:id/block", async (req, res) =>
  res.json(
    ok(
      await unblockUser({
        blockerId: req.user.userId,
        blockedId: req.params.id,
      }),
    ),
  ),
);
router.post("/:id/report", async (req, res) =>
  res.json(
    ok(
      await reportUser({
        reporterId: req.user.userId,
        reportedId: req.params.id,
        reason: (req.body || {}).reason,
      }),
    ),
  ),
);
// Reports the current user has filed (Settings → Safety).
router.get("/reports", async (req, res) =>
  res.json(ok(await listReports(req.user.userId))),
);
router.delete("/reports/:reportId", async (req, res) =>
  res.json(ok(await removeReport({ userId: req.user.userId, reportId: req.params.reportId }))),
);
export default router;
