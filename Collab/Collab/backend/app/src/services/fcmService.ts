// Firebase Cloud Messaging — HTTP v1 sender.
//
// Deliberately dependency-free: the v1 API is one HTTPS POST per device with
// an OAuth2 bearer token, and that token is a plain JWT-bearer grant signed
// with the service account's RSA key — `jsonwebtoken` (already a backend dep)
// signs it and Node's global fetch does the rest. firebase-admin would pull
// in ~40 packages for exactly this.
//
// Contract with the Flutter app (Collab_mobile,
// lib/features/notifications/data/services/push/fcm_service.dart):
//   * ANDROID gets DATA-ONLY messages. The app's background isolate renders
//     them natively (MessagingStyle / CallStyle); a `notification` block would
//     make the OS draw a plain banner AND make the Dart handler bail out.
//   * iOS gets an APNs ALERT (aps.alert) + the same data, so the OS displays it
//     with the app terminated. The extra flutter_local_notifications-shaped
//     keys (NotificationId / present* / payload) make that plugin treat the
//     remote alert as its own, so taps + Reply/Mark-read actions reach the
//     app's existing Dart handlers with the full payload.
//   * `apns-collapse-id` = the SAME stable id the app computes for its local
//     notifications, so opening a chat clears the remote alert too.
import fs from "fs";
import jwt from "jsonwebtoken";
import { config } from "../platform";
import { record as logError } from "./logService";

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

let account: ServiceAccount | null = null;
let ready = false;
// Why init() left `ready` false — surfaced by status() so GET /api/health/ready
// can show it from outside (production has no log access from the office).
let lastError = "";
let cachedToken: { value: string; expiresAt: number } | null = null;
let tokenInflight: Promise<string> | null = null;

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export function isConfigured(): boolean {
  return !!(config.fcm.serviceAccountJson || config.fcm.serviceAccountFile);
}

function loadAccount(): ServiceAccount | null {
  const { serviceAccountJson, serviceAccountFile } = config.fcm;
  lastError = "";
  if (!serviceAccountJson && !serviceAccountFile) {
    lastError = "FCM_SERVICE_ACCOUNT_JSON/FILE not set";
    return null;
  }
  let raw = "";
  try {
    if (serviceAccountJson) {
      raw = serviceAccountJson.trim();
      // Accept base64 (the easy way to put JSON in an env var) or raw JSON.
      if (!raw.startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8");
    } else if (serviceAccountFile) {
      raw = fs.readFileSync(serviceAccountFile, "utf8");
    }
  } catch (e: any) {
    // The common production miss: FCM_SERVICE_ACCOUNT_FILE points at
    // /app/keys/fcm-service-account.json but the file was never copied onto
    // THIS host (keys/*.json is gitignored, so it is not in the deploy bundle).
    lastError = `cannot read service account ${serviceAccountJson ? "(FCM_SERVICE_ACCOUNT_JSON)" : serviceAccountFile}: ${e?.message}`;
    return null;
  }
  if (!raw) {
    lastError = "service account is empty";
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key) {
      lastError = "service account JSON is missing client_email/private_key";
      return null;
    }
    // Env files often escape newlines in the PEM block.
    parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
    parsed.project_id = config.fcm.projectId || parsed.project_id;
    if (!parsed.project_id) {
      lastError = "no project id (service account project_id / FCM_PROJECT_ID)";
      return null;
    }
    return parsed;
  } catch (e: any) {
    lastError = `service account JSON is not valid JSON: ${e?.message}`;
    return null;
  }
}

export function init(): boolean {
  account = loadAccount();
  ready = !!account;
  if (ready) {
    console.log(`[fcm] configured — mobile push enabled (project ${account!.project_id})`);
  } else if (isConfigured()) {
    // Configured but unusable is a deployment FAULT, not the "mobile push is
    // optional" case below: phones will get NO message / mention / meeting
    // pushes, while iOS calls may still ring through APNs VoIP — which makes
    // it look like "only call notifications work".
    console.warn(`[fcm] ${lastError} — mobile push DISABLED: phones get no message/mention/meeting pushes (iOS calls still ring only via APNs VoIP)`);
    // Admin → Insights & Governance → Server Logs reads the error ledger, not
    // the container stdout — so a host that boots in this state shows up there.
    logError({
      source: "process",
      severity: "error",
      code: "PUSH_FCM_UNAVAILABLE",
      message: `[fcm] ${lastError} — mobile push DISABLED: phones get no message/mention/meeting pushes (iOS calls still ring only via APNs VoIP)`,
      context: { serviceAccountFile: config.fcm.serviceAccountFile || null, inlineJson: !!config.fcm.serviceAccountJson, projectId: config.fcm.projectId || null },
    });
  } else {
    console.warn("[fcm] FCM_SERVICE_ACCOUNT_JSON/FILE not set — mobile push disabled (web push unaffected)");
  }
  return ready;
}

export function isReady() { return ready; }

/** Config-presence status for the readiness probe (no network call). */
export function status(): { ready: boolean; configured: boolean; error?: string } {
  return { ready, configured: isConfigured(), ...(ready ? {} : { error: lastError || "not configured" }) };
}

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.value;
  if (tokenInflight) return tokenInflight;
  tokenInflight = (async () => {
    const assertion = jwt.sign(
      { iss: account!.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
      account!.private_key,
      { algorithm: "RS256" },
    );
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new Error(`oauth token failed (${res.status}): ${json.error_description || json.error || "unknown"}`);
    }
    cachedToken = { value: json.access_token, expiresAt: now + (Number(json.expires_in) || 3600) };
    return cachedToken.value;
  })();
  try {
    return await tokenInflight;
  } finally {
    tokenInflight = null;
  }
}

type FcmSendResult = {
  ok: boolean;
  /** The token is dead (UNREGISTERED / invalid) — the caller should forget it. */
  stale: boolean;
  status: number;
  error?: string;
};

/** POST one message. Never throws; classifies dead tokens for cleanup. */
export async function send(message: Record<string, any>): Promise<FcmSendResult> {
  if (!ready) return { ok: false, stale: false, status: 0, error: "fcm not configured" };
  try {
    const token = await accessToken();
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account!.project_id}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { ok: true, stale: false, status: res.status };
    const json: any = await res.json().catch(() => ({}));
    const err = json?.error || {};
    const details: any[] = Array.isArray(err.details) ? err.details : [];
    const fcmCode = details.find((d) => d && d.errorCode)?.errorCode || "";
    // 404 UNREGISTERED: app uninstalled / token rotated. 400 INVALID_ARGUMENT
    // with a token-related message: malformed or foreign-project token.
    const stale =
      fcmCode === "UNREGISTERED" ||
      res.status === 404 ||
      (res.status === 400 && /registration token|token/i.test(String(err.message || "")));
    if (res.status === 401) cachedToken = null; // force a fresh OAuth token next time
    return { ok: false, stale, status: res.status, error: `${err.status || res.status} ${fcmCode || ""} ${err.message || ""}`.trim() };
  } catch (e: any) {
    return { ok: false, stale: false, status: 0, error: e?.message || String(e) };
  }
}
