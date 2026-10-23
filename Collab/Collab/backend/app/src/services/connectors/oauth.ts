// Unified Connector Engine — OAuth 2.0 token acquisition.
//
//   Microsoft (Graph, Bot Framework)  client-credentials against Entra ID
//   Google (Chat, Calendar)           service-account JWT bearer grant, with
//                                     optional domain-wide-delegation subject;
//                                     or a stored OAuth refresh token
//   Slack / WhatsApp                  long-lived tokens, no exchange needed
//
// Tokens are cached in-process per (credential, scope, subject) until a minute
// before expiry. The cache is keyed by a hash of the credential, never the
// credential itself, so a heap dump of the key set reveals nothing.
import { createHash, createSign } from "crypto";
import { callJson, expectOk, form } from "./http";
import { parseServiceAccount } from "./credentials";
import { PlatformError } from "./types";

type Cached = { token: string; expiresAt: number };
const cache = new Map<string, Cached>();

const keyOf = (...parts: any[]) =>
  createHash("sha256").update(parts.map((p) => String(p ?? "")).join("|"), "utf8").digest("hex");

function fresh(k: string): string | null {
  const c = cache.get(k);
  return c && c.expiresAt > Date.now() + 60_000 ? c.token : null;
}
function remember(k: string, token: string, expiresInSec: number) {
  cache.set(k, { token, expiresAt: Date.now() + Math.max(60, Number(expiresInSec) || 3600) * 1000 });
  if (cache.size > 2000) {
    const now = Date.now();
    for (const [key, v] of cache) if (v.expiresAt <= now) cache.delete(key);
  }
}

// ── Microsoft Entra client credentials ──────────────────────────────────────
export async function getMicrosoftToken(
  platform: string,
  creds: { tenantId?: string; clientId?: string; clientSecret?: string },
  scope: string,
  timeoutMs: number,
): Promise<string> {
  const tenant = String(creds.tenantId || "").trim();
  const clientId = String(creds.clientId || "").trim();
  const clientSecret = String(creds.clientSecret || "");
  if (!tenant || !clientId || !clientSecret)
    throw new PlatformError(platform, "Microsoft credentials incomplete (tenantId, clientId, clientSecret)", {
      status: 400,
      retryable: false,
    });
  const k = keyOf("ms", tenant, clientId, clientSecret, scope);
  const hit = fresh(k);
  if (hit) return hit;
  const r = await callJson(platform, `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope }),
    timeoutMs,
  });
  expectOk(platform, r, "Microsoft token");
  if (!r.json?.access_token) throw new PlatformError(platform, "Microsoft token response had no access_token", { status: 502 });
  remember(k, r.json.access_token, r.json.expires_in);
  return r.json.access_token;
}

// Bot Framework (Teams bot replies) uses the SAME app registration but a
// different authority + scope.
export async function getBotFrameworkToken(
  creds: { clientId?: string; clientSecret?: string },
  timeoutMs: number,
): Promise<string> {
  return getMicrosoftToken(
    "teams",
    { tenantId: "botframework.com", clientId: creds.clientId, clientSecret: creds.clientSecret },
    "https://api.botframework.com/.default",
    timeoutMs,
  );
}

// ── Google ──────────────────────────────────────────────────────────────────
const b64url = (b: Buffer | string) =>
  (typeof b === "string" ? Buffer.from(b, "utf8") : b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Service-account JWT bearer grant (RS256, signed locally with the account's
// private key). `subject` = the Workspace user to impersonate under
// domain-wide delegation (required to write someone's calendar).
export async function getGoogleServiceAccountToken(
  platform: string,
  serviceAccountJson: any,
  scopes: string[],
  subject: string | null,
  timeoutMs: number,
): Promise<string> {
  const sa = parseServiceAccount(serviceAccountJson);
  if (!sa?.client_email || !sa?.private_key)
    throw new PlatformError(platform, "Google service account JSON is missing client_email/private_key", {
      status: 400,
      retryable: false,
    });
  const k = keyOf("gsa", sa.client_email, sa.private_key, scopes.join(" "), subject || "");
  const hit = fresh(k);
  if (hit) return hit;
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const claims: Record<string, any> = {
    iss: sa.client_email,
    scope: scopes.join(" "),
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };
  if (subject) claims.sub = subject;
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  let signature: Buffer;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signature = signer.sign(sa.private_key);
  } catch (e: any) {
    throw new PlatformError(platform, "Google service account private key is invalid: " + (e?.message || e), {
      status: 400,
      retryable: false,
    });
  }
  const assertion = `${unsigned}.${b64url(signature)}`;
  const r = await callJson(platform, tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    timeoutMs,
  });
  expectOk(platform, r, "Google token");
  if (!r.json?.access_token) throw new PlatformError(platform, "Google token response had no access_token", { status: 502 });
  remember(k, r.json.access_token, r.json.expires_in);
  return r.json.access_token;
}

// OAuth refresh-token grant (a user-consented Google account, no delegation).
async function getGoogleRefreshedToken(
  platform: string,
  creds: { clientId?: string; clientSecret?: string; refreshToken?: string },
  timeoutMs: number,
): Promise<string> {
  const clientId = String(creds.clientId || "").trim();
  const clientSecret = String(creds.clientSecret || "");
  const refreshToken = String(creds.refreshToken || "");
  if (!clientId || !clientSecret || !refreshToken)
    throw new PlatformError(platform, "Google OAuth credentials incomplete (clientId, clientSecret, refreshToken)", {
      status: 400,
      retryable: false,
    });
  const k = keyOf("grt", clientId, refreshToken);
  const hit = fresh(k);
  if (hit) return hit;
  const r = await callJson(platform, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }),
    timeoutMs,
  });
  expectOk(platform, r, "Google token refresh");
  if (!r.json?.access_token) throw new PlatformError(platform, "Google token response had no access_token", { status: 502 });
  remember(k, r.json.access_token, r.json.expires_in);
  return r.json.access_token;
}

// Pick the Google auth path the account was configured with.
export async function getGoogleToken(
  platform: string,
  creds: Record<string, any>,
  scopes: string[],
  subject: string | null,
  timeoutMs: number,
): Promise<string> {
  if (creds.serviceAccountJson) return getGoogleServiceAccountToken(platform, creds.serviceAccountJson, scopes, subject, timeoutMs);
  return getGoogleRefreshedToken(platform, creds, timeoutMs);
}
