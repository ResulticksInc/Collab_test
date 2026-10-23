import { asyncRouter } from "../asyncRouter";
import { ok, fail, db } from "../platform";
import authMiddleware from "../middleware/auth";

// ── Post-call / post-meeting feedback (#67) ──────────────────────────────────
// Mounted under /api/feedback, behind authMiddleware so req.user.userId is set.
// The single POST /call endpoint is the sink for the "How was your call
// experience?" dialog shown after a connected call or meeting ends normally.
//
// This surface NEVER touches calls/meetings/E2EE or the media plane — it only
// inserts one analytics row. It fails SOFT: a bad payload is coerced to safe
// defaults rather than 4xx'd, because feedback must never block or error the
// leave flow. The client already gates WHEN to show the dialog; the server just
// records what it's given, defensively bounded.
const router = asyncRouter();
router.use(authMiddleware);

// The allowed issue buckets + their labels. Keeping this server-side lets us
// discard anything the client didn't legitimately offer (defense in depth) while
// still storing a compact structured blob for future dashboards. Values are kept
// as free strings (the labels the UI shows) but capped in count + length.
const CATEGORY_KEYS = new Set([
  "audio",
  "video",
  "screen",
  "connectivity",
  "participants",
]);

function sanitizeCategories(raw: any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!CATEGORY_KEYS.has(k) || !Array.isArray(v)) continue;
    const items = v
      .filter((x) => typeof x === "string" && x.trim())
      .map((x) => String(x).slice(0, 120))
      .slice(0, 24); // hard cap per bucket
    if (items.length) out[k] = items;
  }
  return out;
}

// POST /api/feedback/call — record one feedback submission. Returns { id }.
router.post("/call", async (req, res) => {
  const userId = (req as any).user.userId;
  const b = req.body || {};

  const kind = b.kind === "meeting" ? "meeting" : "call";
  const feedbackType = b.feedbackType === "issues" ? "issues" : "good";
  // For a plain "good" rating we never persist categories (nothing to store);
  // for "issues" we keep only the whitelisted buckets.
  const categories =
    feedbackType === "issues" ? sanitizeCategories(b.categories) : {};

  const comment =
    typeof b.comment === "string" && b.comment.trim()
      ? b.comment.slice(0, 1000)
      : null;

  const durationSec = Math.max(0, Math.floor(Number(b.durationSec) || 0));
  const NET = new Set(["excellent", "good", "poor", "lost", "unknown"]);
  const networkQuality =
    typeof b.networkQuality === "string" && NET.has(b.networkQuality)
      ? b.networkQuality
      : null;

  const platform = b.platform === "desktop" ? "desktop" : "web";

  // Session Replay Lite: the client's diagnostics timeline (plain text), attached
  // only with an "issues" rating and only when the user left the attach checkbox
  // on. Hard-capped at 100KB — it's a bounded event trail, never media.
  const diagnostics =
    feedbackType === "issues" &&
    typeof b.diagnostics === "string" &&
    b.diagnostics.trim()
      ? b.diagnostics.slice(0, 100_000)
      : null;

  try {
    const { id } = await db.callFeedback.create({
      userId,
      kind,
      callId: kind === "call" ? (b.callId ? String(b.callId) : null) : null,
      meetingId:
        kind === "meeting" ? (b.meetingId ? String(b.meetingId) : null) : null,
      feedbackType,
      categories,
      comment,
      durationSec,
      networkQuality,
      platform,
      os: typeof b.os === "string" ? b.os : null,
      browser: typeof b.browser === "string" ? b.browser : null,
      appVersion: typeof b.appVersion === "string" ? b.appVersion : null,
      buildNumber: typeof b.buildNumber === "string" ? b.buildNumber : null,
      diagnostics,
    });
    res.json(ok({ id }));
  } catch (e) {
    // Feedback is best-effort; a store failure must not surface as a scary error
    // in the client (the leave flow already completed). Report a soft failure.
    res
      .status(500)
      .json(fail("FEEDBACK_STORE_FAILED", "Couldn't save your feedback."));
  }
});

export default router;
