import { asyncRouter } from "../asyncRouter";
import { ok, fail } from "../platform";
import { rateLimit, clientIp } from "../middleware/rateLimit";
import { describeLink, joinAsGuest, looksLikeDeviceId } from "../services/guestMeetingService";

// NO-AUTH endpoints behind a meeting's public link. Mounted at
// /api/public/meetings (see app.ts) — the same unauthenticated posture as the
// avatar routes, so they are throttled per IP:
//   • lookup  — cheap, but it is a token oracle, so cap guessing hard,
//   • join    — creates a user row + session, so cap it tighter still.
// Tokens are 192-bit, so guessing is not a practical attack; the limits exist to
// stop row-spam from the join endpoint and scraping from the lookup.
const router = asyncRouter();

const lookupLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: "Too many requests. Please wait a moment and try again.",
});
const joinLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 20,
  message: "Too many join attempts. Please wait a few minutes and try again.",
});

// Responses must never be cached by an intermediary: the link can be revoked.
router.use((_req: any, res: any, next: any) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// `?device=<id>` is the lobby's persistent browser-profile id: when this browser
// has already joined the meeting, the response names the guest identity it will
// rejoin as. Malformed ids are ignored (treated as a first visit).
const deviceParam = (v: unknown) => (looksLikeDeviceId(v) ? v : null);

router.get("/:token", lookupLimit, async (req, res) => {
  const info = await describeLink(req.params.token, deviceParam(req.query.device));
  if (!info)
    return res
      .status(404)
      .json(fail("NOT_FOUND", "This meeting link isn't valid or was turned off."));
  res.json(ok(info));
});

router.post("/:token/join", joinLimit, async (req, res) => {
  try {
    const out = await joinAsGuest({
      token: req.params.token,
      name: (req.body || {}).name,
      deviceId: deviceParam((req.body || {}).deviceId),
      ip: clientIp(req),
      userAgent: String(req.headers["user-agent"] || "").slice(0, 512),
    });
    res.json(ok(out));
  } catch (e: any) {
    // Service errors carry a status + stable code; anything else is a real
    // failure and goes to the central error handler (generic 500 body).
    if (e && e.status && e.status < 500)
      return res.status(e.status).json(fail(e.code || "BAD_REQUEST", e.message));
    throw e;
  }
});

export default router;
