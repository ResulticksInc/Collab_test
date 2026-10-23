// Unified Connector Engine — credential sealing.
//
// Platform tokens (Slack bot token, Graph client secret, WhatsApp system-user
// token, Google service-account private key) are stored SEALED: AES-256-GCM
// under a key derived (HKDF-SHA256) from CONNECTORS_SECRET. A database dump
// therefore yields no usable credential, and the API never returns one —
// only the non-secret `hint` built here.
//
// Same seal format as e2eeEscrow / mfaService: base64(iv(12) | tag(16) | ct).
// PURE (secret passed in) so it is unit-testable without config.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

const HKDF_SALT = "colab/connectors/credentials/v1";
const HKDF_INFO = "seal";

function sealKey(secret: string): Buffer {
  if (!secret) throw new Error("connector credential secret is not configured");
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(HKDF_SALT), Buffer.from(HKDF_INFO), 32),
  );
}

export function sealCredentials(creds: Record<string, any>, secret: string): string {
  const plain = Buffer.from(JSON.stringify(creds || {}), "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

// Throws on a wrong secret or a tampered blob (GCM auth failure).
export function openCredentials(sealed: string | null | undefined, secret: string): Record<string, any> {
  if (!sealed) return {};
  const buf = Buffer.from(String(sealed), "base64");
  if (buf.length < 12 + 16) throw new Error("sealed credentials are malformed");
  const decipher = createDecipheriv("aes-256-gcm", sealKey(secret), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const out = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  const parsed = JSON.parse(out.toString("utf8"));
  return parsed && typeof parsed === "object" ? parsed : {};
}

// A short, non-secret description of WHICH credential is configured, for the
// management UI ("xoxb-…Q7Z2", "svc@proj.iam.gserviceaccount.com").
export function credentialHint(platform: string, creds: Record<string, any>): string | null {
  const tail = (v: any) => {
    const s = String(v || "");
    return s.length > 4 ? "…" + s.slice(-4) : s ? "…" : "";
  };
  switch (platform) {
    case "slack":
      return creds.botToken ? "xoxb" + tail(creds.botToken) : null;
    case "teams":
    case "outlook_calendar":
      return creds.clientId ? `app ${String(creds.clientId).slice(0, 8)}…` : null;
    case "whatsapp":
      return creds.phoneNumberId ? `phone ${creds.phoneNumberId}` : null;
    case "google_chat":
    case "google_calendar": {
      const sa = parseServiceAccount(creds.serviceAccountJson);
      if (sa?.client_email) return String(sa.client_email);
      return creds.refreshToken ? "oauth refresh token" + tail(creds.refreshToken) : null;
    }
    default:
      return null;
  }
}

// Service-account JSON may arrive as the object, the raw JSON string, or
// base64 of it (how secret stores like to hand it over).
export function parseServiceAccount(v: any): { client_email?: string; private_key?: string; project_id?: string; token_uri?: string } | null {
  if (!v) return null;
  if (typeof v === "object") return v;
  const s = String(v).trim();
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(Buffer.from(s, "base64").toString("utf8"));
    } catch {
      return null;
    }
  }
}

// Merge a credential PATCH onto the existing set: blank/undefined fields keep
// the stored value, so an admin can rotate one secret without re-typing all.
export function mergeCredentials(existing: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const out = { ...(existing || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}
