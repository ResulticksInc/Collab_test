import { asyncRouter } from "../asyncRouter";
import { ok, fail, db } from "../platform";
import { rateLimit } from "../middleware/rateLimit";
import authMiddleware from "../middleware/auth";
import * as authService from "../services/authService";
import * as telemetry from "../services/telemetryService";

const router = asyncRouter();

// Heavy, dedicated rate limit so a buggy client (or an abuser) can't flood the
// error pipeline — independent of the global API limiter. A batch carries up to
// MAX_BATCH grouped errors, so 60 batches/min/IP is generous for a real client
// (which dedupes + throttles before it ever reaches here) yet caps the write
// pressure. Tune with TELEMETRY_RATE_MAX / TELEMETRY_RATE_WINDOW_MS.
const telemetryLimiter = rateLimit({
  windowMs: Number(process.env.TELEMETRY_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.TELEMETRY_RATE_MAX) || 60,
  message: "Too many telemetry reports. Slow down.",
});

// POST /api/telemetry/error — accept a small batch of client errors.
// Auth is OPTIONAL (errors must be captured pre-login too); if a valid Bearer
// token is present we attach its userId, otherwise the error is stored
// anonymously. The fingerprint is computed SERVER-SIDE. Returns 204 No Content.
router.post("/error", telemetryLimiter, async (req, res) => {
  // Optional auth: best-effort token decode, never reject on a missing/bad token.
  let userId: string | null = null;
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (token) {
    try {
      const p: any = authService.verify(token);
      userId = p && p.sub ? String(p.sub) : null;
    } catch {
      /* anonymous — capture the error anyway */
    }
  }

  const body = req.body || {};
  // Accept either { errors: [...] } (batch) or a single object for convenience.
  const items = Array.isArray(body.errors)
    ? body.errors
    : Array.isArray(body)
      ? body
      : body && typeof body === "object"
        ? [body]
        : [];
  if (!items.length) return res.status(204).end();
  // Reject an oversize batch outright (defense in depth alongside the rate limit
  // and the per-item size caps in the service).
  if (items.length > telemetry.MAX_BATCH)
    return res
      .status(413)
      .json(fail("PAYLOAD_TOO_LARGE", `At most ${telemetry.MAX_BATCH} errors per request.`));

  // The error reporter must NEVER 500 — a 500 here makes the client report *that*
  // failure, which 500s again → an error-reporting-the-error storm (exactly the
  // telemetry/error 500 loop seen in the field). Swallow everything; it's
  // fire-and-forget. recordBatch already guards per-item, this is defense in depth.
  try {
    // Server-authoritative location from the CDN/proxy geo headers (Cloudflare /
    // Vercel / generic). Present in production behind the edge; absent locally.
    const hdr = (...keys: string[]) => {
      for (const k of keys) {
        const v = req.headers[k];
        if (v) return String(Array.isArray(v) ? v[0] : v).slice(0, 80);
      }
      return null;
    };
    const ip = String((req.headers["x-forwarded-for"] as string) || "").split(",")[0].trim() || (req.ip as string) || null;
    await telemetry.recordBatch(items, {
      userId,
      userAgent: (req.headers["user-agent"] as string) || null,
      ip: ip ? ip.slice(0, 64) : null,
      country: hdr("cf-ipcountry", "x-vercel-ip-country", "x-geo-country", "x-country-code"),
      city: hdr("cf-ipcity", "x-vercel-ip-city", "x-geo-city"),
    });
  } catch (_) {
    /* never surface a telemetry failure to the client */
  }
  // 204: telemetry is fire-and-forget; the client ignores the body.
  res.status(204).end();
});

// GET /api/telemetry/errors — operator dashboard. ADMIN-ONLY: requires a valid
// token (authMiddleware) AND role==='admin' on the user record. There is no
// separate admin system in this app; the user's `role` column (default 'member')
// is the gate, matching how the rest of the product treats elevated access.
// §9.2: usage-event batch — {"events": ["view.switch.speaker", ...]}. Same
// posture as /error: rate-limited, auth OPTIONAL (pre-login screens count too),
// content-free by construction (a strict name vocabulary, no payloads), 204.
router.post("/events", telemetryLimiter, async (req, res) => {
  await telemetry.recordEvents((req.body || {}).events);
  res.status(204).end();
});

// §9.2 readout: aggregated counters for the last N days (auth required).
router.get("/events", authMiddleware, async (req, res) => {
  const days = Number(req.query.days) || 7;
  res.json(ok(await telemetry.eventSummary(days)));
});

router.get("/errors", authMiddleware, async (req, res) => {
  const user = await db.users.getById(req.user.userId);
  if (!user || user.role !== "admin")
    return res.status(403).json(fail("FORBIDDEN", "Admin access required."));
  const limit = Number(req.query.limit) || 100;
  const sinceHours = Number(req.query.sinceHours) || 24;
  const errors = await telemetry.listRecent({ limit, sinceHours });
  res.json(ok({ errors }));
});

export default router;
