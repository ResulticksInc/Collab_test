// Runtime environment resolution for the Collab desktop client.
//
// The desktop app is a thin shell that loads the HOSTED Collab web app exactly
// like a browser — there is no localhost server in production. Which hosted
// environment it points at is resolved here, with this precedence (highest first):
//
//   1. Environment variables   COLLAB_ENV / COLLAB_WEB_URL / COLLAB_API_URL / …
//      (build-time or set by an MDM/launch script)
//   2. collab.config.json      shipped next to the app (resources) OR dropped in
//      the per-user data dir — lets IT repoint a build with NO rebuild
//   3. Built-in defaults        keyed by COLLAB_ENV (development/staging/production)
//
// Only `webUrl` is functionally required: the hosted web app already derives its
// own API / socket / LiveKit endpoints same-origin (Next.js /api + /socket.io
// rewrites), so loading the right origin is all the desktop shell needs. The
// other URLs are carried for completeness / future use and surfaced to logs.

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

// ── App metadata (single source of truth) ──────────────────────────────────
const APP_INFO = {
  appName: "Collab",
  company: "Resulticks",
  channel: process.env.COLLAB_CHANNEL || "stable",
  supportUrl: "https://collab.resulticks.com/support",
  websiteUrl: "https://collab.resulticks.com",
  updateUrl: "", // resolved per-environment below
  // Window defaults
  window: {
    // Authored against a 1440–1920px baseline; opening at 1200x800 on a hi-DPI
    // panel reads as enlarged/soft ("720p"). Default nearer the design size.
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
  },
  // Timing constants
  startupTimeoutMs: 30000,
  portPollIntervalMs: 500,
  reconnectMinMs: 3000,
  reconnectMaxMs: 30000,
  updateCheckDelayMs: 8000,
  maxRendererRecovery: 3,
};

// ── Environment defaults ──────────────────────────────────────────────────
// authOrigins: SSO/OAuth IdP origins that are allowed to navigate IN-WINDOW so the
// full login → MFA/authenticator → callback round-trip completes inside the app
// instead of being kicked to the system browser (which restarts the flow and asks
// for credentials again). Override per-deployment via collab.config.json
// "authOrigins" or COLLAB_AUTH_ORIGINS (comma-separated) — no rebuild needed.
const DEFAULTS = {
  development: {
    env: "development",
    webUrl: "http://localhost:3002",
    apiUrl: "http://localhost:3002/api",
    socketUrl: "http://localhost:3002",
    livekitUrl: "",
    // Same IdP origins as staging/prod so SSO completes IN-WINDOW when testing a
    // dev desktop build too — without these, will-navigate boots the stgoa.re.cx
    // redirect to the system browser and the desktop never gets the callback,
    // which reads as "keeps redirecting to stgoa.re.cx". Override via
    // COLLAB_AUTH_ORIGINS / collab.config.json if your dev IdP differs.
    authOrigins: ["https://stgoa.re.cx", "https://oa.re.cx", "http://10.200.1.58:7505"],
  },
  staging: {
    env: "staging",
    webUrl: "https://staging.collab.resulticks.com",
    apiUrl: "https://staging.collab.resulticks.com/api",
    socketUrl: "https://staging.collab.resulticks.com",
    livekitUrl: "wss://staging.collab.resulticks.com/livekit",
    authOrigins: ["https://stgoa.re.cx", "https://oa.re.cx", "http://10.200.1.58:7505"],
  },
  production: {
    env: "production",
    webUrl: "https://collab.resulticks.com",
    apiUrl: "https://collab.resulticks.com/api",
    socketUrl: "https://collab.resulticks.com",
    livekitUrl: "wss://collab.resulticks.com/livekit",
    authOrigins: ["https://stgoa.re.cx", "https://oa.re.cx", "http://10.200.1.58:7505"],
  },
};

// Look for an ops-supplied override file. Checked in order; first hit wins.
function readConfigFile() {
  const candidates = [
    process.env.COLLAB_CONFIG,
    process.resourcesPath && path.join(process.resourcesPath, "collab.config.json"),
    (() => { try { return path.join(app.getPath("userData"), "collab.config.json"); } catch { return null; } })(),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        if (parsed && typeof parsed === "object") return { _source: p, ...parsed };
      }
    } catch { /* malformed → ignore */ }
  }
  return null;
}

function resolveAppInfo() {
  let version = "0.0.0";
  let build = "0";
  try {
    version = app.getVersion();
  } catch {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
    if (pkg.buildVersion) build = String(pkg.buildVersion);
  } catch {}
  return {
    ...APP_INFO,
    version,
    build,
    electronVersion: process.versions.electron || "",
    chromiumVersion: process.versions.chrome || "",
    nodeVersion: process.versions.node || "",
  };
}

function resolveConfig({ isDev } = {}) {
  const file = readConfigFile() || {};
  const envName = String(process.env.COLLAB_ENV || file.env || (isDev ? "development" : "production")).toLowerCase();
  const base = DEFAULTS[envName] || DEFAULTS.production;
  const pick = (envKey, fileKey) => process.env[envKey] || file[fileKey] || base[fileKey];

  const cfg = {
    env: envName,
    webUrl: process.env.COLLAB_WEB_URL || file.webUrl || base.webUrl,
    apiUrl: pick("COLLAB_API_URL", "apiUrl"),
    socketUrl: pick("COLLAB_SOCKET_URL", "socketUrl"),
    livekitUrl: pick("COLLAB_LIVEKIT_URL", "livekitUrl"),
    source: file._source || "built-in defaults",
  };

  try { cfg.origin = new URL(cfg.webUrl).origin; }
  catch { cfg.origin = cfg.webUrl; }

  // SSO/OAuth IdP origins allowed to navigate in-window (see DEFAULTS note). Accepts
  // an array (config file) or comma-separated string (env); normalised to origins.
  const rawAuth = process.env.COLLAB_AUTH_ORIGINS || file.authOrigins || base.authOrigins || [];
  const authList = Array.isArray(rawAuth) ? rawAuth : String(rawAuth).split(",");
  cfg.authOrigins = authList
    .map((s) => { try { return new URL(String(s).trim()).origin; } catch { return String(s).trim(); } })
    .filter(Boolean);

  // Release channel along the promotion ladder dev → beta → stable.
  // COLLAB_CHANNEL env wins, then an ops-supplied config file, else the built-in
  // "stable". Stable users are UNCHANGED — they keep fetching /desktop/latest.json.
  // A non-stable channel fetches /desktop/latest-<channel>.json (latest-beta.json,
  // latest-dev.json) so beta testers / devs get pre-release builds without
  // affecting stable. An explicit COLLAB_UPDATE_URL / file.updateUrl still
  // overrides everything (full manual control).
  cfg.channel = String(process.env.COLLAB_CHANNEL || file.channel || "stable").toLowerCase();
  const manifestName =
    cfg.channel && cfg.channel !== "stable" ? `latest-${cfg.channel}.json` : "latest.json";

  cfg.updateUrl =
    process.env.COLLAB_UPDATE_URL ||
    file.updateUrl ||
    cfg.webUrl.replace(/\/+$/, "") + "/desktop/" + manifestName;

  return cfg;
}

module.exports = { resolveConfig, resolveAppInfo, DEFAULTS };
