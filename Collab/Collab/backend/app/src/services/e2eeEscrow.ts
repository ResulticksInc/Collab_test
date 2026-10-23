// E2EE account-key ESCROW — the server-side half of automatic history recovery.
//
// Each user gets one random 32-byte account key. It is stored sealed
// (AES-256-GCM under an HKDF-derived key) and handed, unsealed, only to that
// user's authenticated sessions. The client wraps its recovery secret under the
// account key (wrap kind 'account'), so ANY device that can authenticate can
// unwrap the secret and restore the user's history backup with no prompt.
//
// PURE (no db, no config import) so it can be unit-tested directly: the caller
// passes the escrow secret in. Same seal format as mfaService:
// base64(iv(12) | tag(16) | ciphertext).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

export const ACCOUNT_KEY_BYTES = 32;
const HKDF_SALT = "colab/e2ee-account-key/v1";
const HKDF_INFO = "seal";

function escrowKey(secret: string): Buffer {
  if (!secret) throw new Error("E2EE escrow secret is not configured");
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from(HKDF_SALT), Buffer.from(HKDF_INFO), 32),
  );
}

export function newAccountKey(): Buffer {
  return randomBytes(ACCOUNT_KEY_BYTES);
}

export function sealAccountKey(raw: Buffer, secret: string): string {
  if (!raw || raw.length !== ACCOUNT_KEY_BYTES) throw new Error("account key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", escrowKey(secret), iv);
  const ct = Buffer.concat([cipher.update(raw), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

// Throws on a wrong secret or a tampered blob (GCM auth failure).
export function openAccountKey(sealed: string, secret: string): Buffer {
  const buf = Buffer.from(String(sealed || ""), "base64");
  if (buf.length < 12 + 16 + ACCOUNT_KEY_BYTES) throw new Error("sealed account key is malformed");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", escrowKey(secret), iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  if (out.length !== ACCOUNT_KEY_BYTES) throw new Error("account key has the wrong length");
  return out;
}
