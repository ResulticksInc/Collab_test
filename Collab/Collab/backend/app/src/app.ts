import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { config, fail } from "./platform";
import { corsOrigin } from "./cors";
import healthRoutes from "./routes/health";
import authRoutes from "./routes/auth";
import sessionRoutes from "./routes/sessions";
import conversationRoutes from "./routes/conversations";
import bookmarkRoutes from "./routes/bookmarks";
import searchRoutes from "./routes/search";
import meetingRoutes from "./routes/meetings";
import userRoutes from "./routes/users";
import reminderRoutes from "./routes/reminders";
import callRoutes from "./routes/calls";
import settingsRoutes from "./routes/settings";
import taskRoutes from "./routes/tasks";
import inviteRoutes from "./routes/invites";
import fileRoutes from "./routes/files";
import aiRoutes from "./routes/ai";
import auditRoutes from "./routes/audit";
import logsRoutes from "./routes/logs";
import concernRoutes from "./routes/concerns";
import { record as logError } from "./services/logService";
import { apiDebugLog } from "./middleware/apiDebugLog";
import livekitRoutes from "./routes/livekit";
import e2eeRoutes from "./routes/e2ee";
import opsRoutes from "./routes/ops";
import notificationRoutes from "./routes/notifications";
import linkPreviewRoutes from "./routes/linkPreview";
import publicRoutes from "./routes/public";
import publicMeetingRoutes from "./routes/publicMeetings";
import pushRoutes from "./routes/push";
import remoteControlRoutes from "./routes/remoteControl";
import telemetryRoutes from "./routes/telemetry";
import feedbackRoutes from "./routes/feedback";
import debugRoutes from "./routes/debug";
import orgRoutes from "./routes/orgs";
import mediaRoutes from "./routes/media";
import adminRoutes from "./routes/admin";
import webhookRoutes, { ingestRouter as webhookIngestRoutes } from "./routes/webhooks";
import connectorRoutes, { inboundRouter as connectorInboundRoutes } from "./routes/connectors";
import externalRoutes from "./routes/external";
import { rateLimit, apiClientKey } from "./middleware/rateLimit";
function createApp() {
  const app = express();
  // Don't advertise Express. Trust the proxy hop so client IPs (for rate
  // limiting) reflect X-Forwarded-For rather than the LB address.
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  // OBSERVABILITY: stamp every request with a unique ID so errors in the ledger,
  // console logs, and the X-Request-Id response header all share one correlation key.
  // Uses native crypto.randomUUID — zero new dependencies.
  app.use((req: any, res, next) => {
    (req as any).id = randomUUID();
    res.setHeader("X-Request-Id", (req as any).id);
    next();
  });
  // Baseline security headers. The API serves JSON (not the app HTML, which Next
  // serves), so a CSP isn't applicable here; these are the safe, high-value ones.
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-DNS-Prefetch-Control", "off");
    res.setHeader("Permissions-Policy", "geolocation=(), payment=(), usb=()");
    if (config.env === "production")
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
  app.use(cors({ origin: corsOrigin(config.backend.corsOrigins), credentials: true }));
  const p = config.constants.api.prefix;
  // Throttle the brute-force surface: login + signup, 30 attempts / 15 min / IP.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: "Too many attempts. Please wait a few minutes and try again.",
  });
  app.use(`${p}/auth/login`, authLimiter);
  app.use(`${p}/auth/signup`, authLimiter);
  // Native/mobile SSO token sign-in mints sessions from a posted id_token — same
  // brute-force limiter as the other credential endpoints.
  app.use(`${p}/auth/sso/token`, authLimiter);
  // SECURITY: /sessions/evict also verifies email+password — apply the same
  // brute-force limiter as login/signup so it can't be used as a faster oracle.
  app.use(`${p}/auth/sessions/evict`, authLimiter);
  // The admin portal password login is a brute-force surface — rate limit it.
  app.use(
    `${p}/admin/auth/login`,
    rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: "Too many admin login attempts. Please wait a few minutes." }),
  );
  // The engineering-portal password login is a brute-force surface — cap it hard.
  app.use(
    `${p}/ops/auth`,
    rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: "Too many attempts. Please wait a few minutes and try again." }),
  );
  // The SSO callback runs a per-hit IdP token-exchange + JWKS fetch — expensive AND
  // unauthenticated. Cap it tightly so it can't be hammered under the generous
  // global API budget (the generic 600/min alone would allow a costly-request flood).
  app.use(
    `${p}/auth/sso/callback`,
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      message: "Too many sign-in attempts. Please wait a few minutes and try again.",
    }),
  );
  // Global API throttle: a GENEROUS per-client ceiling (default 600/min) so a
  // single hot loop / buggy retry-storm can't saturate the DB pool and degrade
  // everyone — the most likely cause of the earlier "load issues". Normal usage
  // (bursty page loads + actions; realtime rides the socket, not REST) stays well
  // under it. Tune with API_RATE_MAX / API_RATE_WINDOW_MS; raise for heavy use.
  // Keyed per SIGNED-IN USER (falling back to IP): behind the corporate LB +
  // nginx every user shares one source address, so a per-IP bucket throttled the
  // whole company together (see apiClientKey).
  const apiLimiter = rateLimit({
    windowMs: Number(process.env.API_RATE_WINDOW_MS) || 60_000,
    max: Number(process.env.API_RATE_MAX) || 600,
    message: "Too many requests. Please slow down and try again shortly.",
    key: apiClientKey,
  });
  app.use(p, apiLimiter);
  // LiveKit egress webhook needs the raw body for signature verification, so it
  // is parsed as raw bytes ahead of the JSON body parser.
  app.use(`${p}/livekit/webhook`, express.raw({ type: () => true }));
  // Connector-engine inbound webhooks (Slack / Teams / Google Chat / WhatsApp)
  // verify an HMAC or JWT over the EXACT bytes the platform sent, so they are
  // captured raw here and parsed inside the route after verification.
  app.use(`${p}/connectors/in`, express.raw({ type: () => true, limit: "2mb" }));
  // Global JSON body parser — EXCEPT the streaming file-upload route (POST
  // /files), which reads the raw request stream and pipes it straight to object
  // storage. If express.json ran there it would consume the body: a JSON-typed
  // file (e.g. a .json attachment) would 413 over the 5mb cap, or worse drain
  // the stream and leave an empty 0-byte object. Other /files POSTs (link
  // creation, etc.) still get JSON parsing.
  const jsonParser = express.json({ limit: "5mb" });
  const urlencodedParser = express.urlencoded({ extended: true, limit: "5mb" });
  app.use((req, res, next) => {
    const isMultipart = (req.headers["content-type"] || "").includes("multipart/form-data");
    const isFilesStream = req.method === "POST" && req.path === `${p}/files`;
    if (isMultipart || isFilesStream) {
      return next();
    }
    jsonParser(req, res, (err) => {
      if (err) return next(err);
      urlencodedParser(req, res, next);
    });
  });
  // API_DEBUG_LOG=true → console.log every request/payload/response (after the
  // body parser so payloads are readable; secrets redacted). Off by default.
  if (config.backend.apiDebugLog) {
    // eslint-disable-next-line no-console
    console.log("[api] API_DEBUG_LOG is ON — every request, payload and response is logged (redacted). Do not use in production.");
    app.use(p, apiDebugLog);
  }
  app.use(`${p}/health`, healthRoutes);
  app.use(`${p}/ops`, opsRoutes);
  app.use(`${p}/auth`, authRoutes);
  app.use(`${p}/sessions`, sessionRoutes);
  app.use(`${p}/conversations`, conversationRoutes);
  app.use(`${p}/bookmarks`, bookmarkRoutes);
  app.use(`${p}/search`, searchRoutes);
  app.use(`${p}/meetings`, meetingRoutes);
  app.use(`${p}/users`, userRoutes);
  app.use(`${p}/reminders`, reminderRoutes);
  app.use(`${p}/calls`, callRoutes);
  app.use(`${p}/settings`, settingsRoutes);
  app.use(`${p}/tasks`, taskRoutes);
  app.use(`${p}/invites`, inviteRoutes);
  app.use(`${p}/files`, fileRoutes);
  app.use(`${p}/ai`, aiRoutes);
  app.use(`${p}/audit`, auditRoutes);
  app.use(`${p}/logs`, logsRoutes);
  app.use(`${p}/concerns`, concernRoutes);
  app.use(`${p}/e2ee`, e2eeRoutes);
  app.use(`${p}/notifications`, notificationRoutes);
  app.use(`${p}/link-preview`, linkPreviewRoutes);
  app.use(`${p}/public/meetings`, publicMeetingRoutes); // no-auth guest join link
  app.use(`${p}/public`, publicRoutes); // no-auth avatar serving
  app.use(`${p}/push`, pushRoutes);
  app.use(`${p}/remote-control`, remoteControlRoutes);
  app.use(`${p}/telemetry`, telemetryRoutes);
  app.use(`${p}/feedback`, feedbackRoutes);
  app.use(`${p}/orgs`, orgRoutes);
  app.use(`${p}/media`, mediaRoutes);
  app.use(`${p}/admin`, adminRoutes);
  // Chat webhooks. The INGEST path is mounted FIRST and on the more specific
  // prefix, because it is deliberately unauthenticated (the token in the URL is
  // the credential) while everything else under /webhooks requires a session.
  // Express matches in registration order, so an ingest POST can never fall
  // through into the authenticated router.
  app.use(`${p}/webhooks/in`, webhookIngestRoutes);
  app.use(`${p}/webhooks`, webhookRoutes);
  // Unified Connector Engine — same two-router posture: the public inbound
  // path is mounted first on its more specific prefix.
  app.use(`${p}/connectors/in`, connectorInboundRoutes);
  app.use(`${p}/connectors`, connectorRoutes);
  app.use(`${p}/livekit/webhook`, livekitRoutes);
  // External Data API: other platforms read this org's MySQL data with an API
  // key (X-API-Key), never a user session. Read-only; see routes/external.ts.
  app.use(`${p}/external/v1`, externalRoutes);
  // Debug routes can dump raw DB rows; never expose them in production.
  if (config.env !== "production") app.use(`${p}/debug`, debugRoutes);
  app.use((req, res) =>
    res
      .status(404)
      .json(fail("NOT_FOUND", `No route ${req.method} ${req.path}`)),
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("[error]", err);
    // ERROR LEDGER: persist every request error to the error_logs table (this
    // environment's own DB) so live issues are triageable from data, not from
    // container-log archaeology. Expected client-input rejections (4xx with an
    // app-set status) are recorded as 'warn' so the open-errors view stays
    // signal; everything unexpected is 'error'. record() is fire-and-forget
    // and can never throw or add latency (see logService).
    logError({
      source: "backend",
      severity: err && err.status && err.status < 500 ? "warn" : "error",
      code: err && (err.code || err.errno || (err.status ? "HTTP_" + err.status : null)),
      message: (err && err.message) || String(err),
      stack: err && err.stack,
      requestPath: req.method + " " + (req.baseUrl || "") + (req.path || ""),
      userId: (req as any).user?.userId || null,
      context: {
        status: err?.status || 500,
        requestId: (req as any).id || null,
        // Structured "why" a service attached (e.g. the per-tier outcomes of a
        // failed upload) — shown verbatim on Admin → Server Logs.
        ...(err && err.details && typeof err.details === "object" ? { details: err.details } : {}),
      },
    });
    // Translate common constraint/trigger violations into friendly, client-safe
    // 4xx messages (not an opaque 500). Supports both Postgres SQLSTATE codes
    // (legacy) and MySQL (mysql2) errno/sqlState.
    const pgIntegrity = typeof err.code === "string" && /^23/.test(err.code);
    const myErrno = typeof err.errno === "number" ? err.errno : null;
    // App-raised checks (meeting-in-past, append-only audit) use SIGNAL '45000'.
    const mySignal = err.sqlState === "45000" || myErrno === 1644;
    const myIntegrity =
      err.sqlState === "23000" ||
      [1062, 1451, 1452, 1048, 1264, 1366].includes(myErrno as number);
    const clientErr = pgIntegrity || mySignal || myIntegrity;
    let status = err.status || (clientErr ? 400 : 500);
    let message = err.message;
    if (err.code === "23503" || myErrno === 1452 || myErrno === 1451)
      message = "That item references something that no longer exists.";
    else if (err.code === "23505" || myErrno === 1062)
      message = "That already exists.";
    else if (err.code === "23502" || myErrno === 1048)
      message = "A required field is missing.";
    else if (mySignal && err.sqlMessage) message = err.sqlMessage;
    // 5xx bodies are genericized so internal errors never leak — EXCEPT app-raised
    // errors that opt in with `err.expose` (a curated, user-safe message, e.g. the
    // 503 "file storage unavailable"). Those keep their message so the UI can show a
    // real reason instead of an opaque "Something went wrong."
    if (status >= 500 && !err.expose)
      message = "Something went wrong. Please try again.";
    res
      .status(status)
      .json(fail(status >= 500 ? "INTERNAL" : "BAD_REQUEST", message));
  });
  return app;
}
export { createApp };
