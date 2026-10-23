// ── Multi-factor auth (TOTP) — Phase 1 Enterprise Identity ──────────────────
// Real second-factor enrollment + login step-up, built on the existing durable
// session / refresh-rotation engine. This module is the single seam the rest of
// auth depends on (authService calls requiresStepUp / readChallenge / verifyCode).
//
// DORMANT until MFA_ENABLED=true: enrollmentStatus reports disabled and
// requiresStepUp returns null, so login/refresh behaviour is unchanged. The TOTP
// seed is sealed with AES-256-GCM under a key derived from AUTH_JWT_SECRET (HKDF),
// so no additional secret is needed to switch it on and the raw seed never sits
// in the DB in plaintext.
import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "crypto";
import { db, config } from "../platform";
import { generateSecret, verifyTotpCounter, otpauthUri, base32Encode } from "./totp";

export interface MfaEnrollment {
  enabled: boolean; // a CONFIRMED second factor is active
  methods: string[]; // e.g. ["totp"]
  pending: boolean; // enrollment begun but not yet verified
  backupCodesRemaining: number;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // a step-up challenge is valid for 5 min
const ISSUER = "Collab";

function mfaErr(message: string, status = 400): Error {
  const e = new Error(message);
  (e as any).status = status;
  return e;
}

// Purpose-separated 256-bit keys derived from the JWT secret (never the JWT secret
// itself). Distinct `info` per use so the seed-encryption key and the challenge-
// signing key are cryptographically independent.
function mfaKey(info: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(config.auth.jwtSecret, "utf8"), Buffer.from("colab/mfa/v1"), Buffer.from(info), 32),
  );
}

// Seal/open the raw TOTP seed with AES-256-GCM → base64(iv | tag | ciphertext).
function seal(raw: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mfaKey("totp-seed"), iv);
  const ct = Buffer.concat([cipher.update(raw), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}
function open(sealed: string): Buffer {
  const buf = Buffer.from(sealed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", mfaKey("totp-seed"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── One-time backup (recovery) codes ────────────────────────────────────────
function normalizeCode(code: string): string {
  return String(code || "").toLowerCase().replace(/[\s-]/g, "");
}
// Backup codes are hashed with a KEYED HMAC (key derived from AUTH_JWT_SECRET,
// out-of-DB) rather than a bare SHA-256 — so a leaked mfa_backup_codes table can't
// be brute-forced offline without the key. (createHash import kept for challenge
// payloads elsewhere if needed.)
function hashCode(code: string): string {
  return createHmac("sha256", mfaKey("backup")).update(normalizeCode(code)).digest("hex");
}
// (createHash intentionally not imported — all MFA hashing is keyed HMAC.)
function generateBackupCodes(n = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    // 10 base32 chars (50 bits), shown grouped xxxxx-xxxxx for readability.
    const c = base32Encode(randomBytes(7)).toLowerCase().slice(0, 10);
    codes.push(c.slice(0, 5) + "-" + c.slice(5));
  }
  return codes;
}
async function persistBackupCodes(userId: string, codes: string[]): Promise<void> {
  await db.mfa.replaceBackupCodes(
    userId,
    codes.map((c) => ({ id: randomUUID(), codeHash: hashCode(c) })),
  );
}

// ── Step-up challenge token (stateless, HMAC-signed, short-TTL) ──────────────
// Proves "this user cleared password auth and now owes a second factor". It grants
// NOTHING on its own — the session is only minted once a valid code is presented.
function signChallenge(userId: string, deviceId?: string): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, d: deviceId || "", iat: Date.now() })).toString("base64url");
  const sig = createHmac("sha256", mfaKey("challenge")).update(payload).digest("base64url");
  return payload + "." + sig;
}
function parseChallenge(token: string): { userId: string; deviceId?: string } | null {
  const [payload, sig] = String(token || "").split(".");
  if (!payload || !sig) return null;
  const expect = createHmac("sha256", mfaKey("challenge")).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let data: any;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data.u !== "string" || typeof data.iat !== "number") return null;
  if (Date.now() - data.iat > CHALLENGE_TTL_MS) return null;
  return { userId: data.u, deviceId: data.d || undefined };
}

// Verify a code (6-digit TOTP OR a single-use backup code) for an ENROLLED user.
// Backup codes are consumed atomically. Returns true iff the factor is satisfied.
export async function verifyCode(userId: string, code: string): Promise<boolean> {
  // Fail CLOSED: a lookup error returns null → the factor is NOT satisfied (deny).
  const enr = await db.mfa.getEnrollment(userId, "totp").catch(() => null);
  if (!enr || !enr.confirmedAt) return false;
  const cleaned = String(code || "").replace(/\s/g, "");
  if (/^\d{6}$/.test(cleaned)) {
    try {
      const counter = verifyTotpCounter(open(enr.secretEnc), cleaned);
      // Anti-replay (RFC 6238 §5.2): accept ONLY if this step advances past the
      // last one used. The atomic compare-and-set makes each code single-use
      // across every endpoint (login, disable, backup regen) even concurrently.
      if (counter !== null) return await db.mfa.bumpTotpStep(userId, counter, "totp");
    } catch {
      /* corrupt seal → fall through to the backup-code path */
    }
  }
  return db.mfa.consumeBackupCode(userId, hashCode(cleaned)).catch(() => false);
}

// ── Public API ──────────────────────────────────────────────────────────────

// Whether MFA is enrolled for a user (for the client's Security settings + the
// status endpoint). Short-circuits to "disabled" when the feature flag is off.
export async function enrollmentStatus(userId: string): Promise<MfaEnrollment> {
  if (!config.mfa.enabled) return { enabled: false, methods: [], pending: false, backupCodesRemaining: 0 };
  const enr = await db.mfa.getEnrollment(userId, "totp").catch(() => null);
  const confirmed = !!(enr && enr.confirmedAt);
  const backup = confirmed ? await db.mfa.countUnusedBackupCodes(userId).catch(() => 0) : 0;
  return {
    enabled: confirmed,
    methods: confirmed ? ["totp"] : [],
    pending: !!(enr && !enr.confirmedAt),
    backupCodesRemaining: backup,
  };
}

// Begin TOTP enrollment: mint a fresh secret, store it PENDING, and return the
// provisioning material (base32 secret + otpauth:// URI the client renders as a QR).
export async function beginTotpEnroll(
  userId: string,
  accountName: string,
): Promise<{ secret: string; otpauthUri: string }> {
  if (!config.mfa.enabled) throw mfaErr("MFA is not enabled.", 403);
  // Never silently clobber a CONFIRMED factor: overwriting the secret + nulling
  // confirmed_at would let a hijacked session downgrade/replace MFA with no code.
  // Force the user through /mfa/disable (which requires a current code) first.
  // Re-running begin on a still-PENDING enrollment is fine (normal restart).
  const existing = await db.mfa.getEnrollment(userId, "totp").catch(() => null);
  if (existing && existing.confirmedAt) {
    throw mfaErr("MFA is already enabled. Turn it off first to re-enroll.", 409);
  }
  const { raw, base32 } = generateSecret();
  await db.mfa.upsertPending(userId, seal(raw), "totp");
  return {
    secret: base32,
    otpauthUri: otpauthUri({ secretBase32: base32, accountName: accountName || userId, issuer: ISSUER }),
  };
}

// Confirm enrollment with the first valid code. On success the factor goes live
// and a fresh set of one-time backup codes is returned ONCE (never retrievable
// again — the DB stores only hashes).
export async function confirmTotpEnroll(
  userId: string,
  code: string,
): Promise<{ confirmed: boolean; backupCodes: string[] }> {
  if (!config.mfa.enabled) throw mfaErr("MFA is not enabled.", 403);
  const enr = await db.mfa.getEnrollment(userId, "totp");
  if (!enr) throw mfaErr("Start MFA setup first.", 400);
  if (enr.confirmedAt) throw mfaErr("MFA is already enabled.", 409);
  let secret: Buffer;
  try {
    secret = open(enr.secretEnc);
  } catch {
    throw mfaErr("Enrollment is corrupted — restart setup.", 400);
  }
  const counter = verifyTotpCounter(secret, code);
  if (counter === null) {
    throw mfaErr("That code isn't valid. Check your authenticator and try again.", 400);
  }
  // Persist backup codes BEFORE flipping the factor live, so MFA can never be
  // enforced at login without a usable recovery code set.
  const backupCodes = generateBackupCodes(10);
  await persistBackupCodes(userId, backupCodes);
  await db.mfa.confirm(userId, "totp");
  // Consume the confirming step so the same code can't be replayed at login.
  await db.mfa.bumpTotpStep(userId, counter, "totp");
  return { confirmed: true, backupCodes };
}

// Turn MFA off (route requires re-proving the factor first).
export async function disable(userId: string): Promise<{ disabled: true }> {
  await db.mfa.remove(userId);
  return { disabled: true };
}

// Issue a fresh set of backup codes (invalidating the old set). Requires a
// confirmed enrollment.
export async function regenerateBackupCodes(userId: string): Promise<{ backupCodes: string[] }> {
  if (!config.mfa.enabled) throw mfaErr("MFA is not enabled.", 403);
  const enr = await db.mfa.getEnrollment(userId, "totp");
  if (!enr || !enr.confirmedAt) throw mfaErr("Enable MFA first.", 400);
  const backupCodes = generateBackupCodes(10);
  await persistBackupCodes(userId, backupCodes);
  return { backupCodes };
}

// Step-up policy at login. Returns null = no step-up (feature off, or user not
// enrolled → unchanged behaviour). When enrolled, returns a challenge the client
// must satisfy at /auth/mfa/verify before a session is minted.
export async function requiresStepUp(
  userId: string,
  deviceId?: string,
): Promise<null | { method: string; challengeId: string }> {
  if (!config.mfa.enabled) return null;
  // Fail CLOSED: do NOT swallow a lookup error here. If we can't determine whether
  // the user is enrolled, the read throws and the caller (login) must refuse to
  // mint a session rather than silently skip the second factor. Only a definitive
  // "no confirmed enrollment" row returns null (proceed without step-up).
  const enr = await db.mfa.getEnrollment(userId, "totp");
  if (!enr || !enr.confirmedAt) return null;
  return { method: "totp", challengeId: signChallenge(userId, deviceId) };
}

// Parse + validate a step-up challenge token WITHOUT consuming a factor, returning
// the bound identity (or null if forged/expired). The caller runs verifyCode()
// separately so it can do cheap pre-checks (e.g. the device-session cap) before
// consuming a one-time code.
export function readChallenge(challengeId: string): { userId: string; deviceId?: string } | null {
  return parseChallenge(challengeId);
}
