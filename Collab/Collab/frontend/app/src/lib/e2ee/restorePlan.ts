// Which credential should a "restore my history" attempt try, and in what order?
//
// An account can hold up to three ways into the same server-blind backup:
//   • the PASSWORD wrap  — made automatically on a password sign-in (the common
//     case, and the one a new device usually needs),
//   • the PASSPHRASE wrap — a recovery passphrase the user set deliberately,
//   • the RECOVERY KEY   — the 32-byte key shown once when the backup was made.
//
// The restore box asks for one field, because people do not know or care which
// of the three they are holding. This module decides what to try against it.
//
// Pure and dependency-free: the manager does the crypto, this owns the ordering,
// and backend/app/test exercises it directly.

export type RestoreMethod = "recoveryKey" | "password" | "passphrase";

export interface BackupCapabilities {
  /** A backup with content exists on the server. Nothing can be restored without it. */
  hasBackup: boolean;
  /** The automatic sign-in-password wrap is present. */
  hasPasswordWrap: boolean;
  /** A user-set recovery passphrase wrap is present. */
  hasPassphraseWrap: boolean;
}

// A recovery key is base32 (A–Z, 2–7) in dash-separated groups, and decodes to
// at least 32 bytes — 52 base32 characters. Anything shorter, or carrying a
// character outside the alphabet, is a password or passphrase, not a key.
const B32_ONLY = /^[A-Z2-7]+$/;
const RECOVERY_KEY_MIN_CHARS = 52;

export function looksLikeRecoveryKey(input: string): boolean {
  const clean = String(input || "").replace(/[\s-]/g, "").toUpperCase();
  return clean.length >= RECOVERY_KEY_MIN_CHARS && B32_ONLY.test(clean);
}

/**
 * The ordered list of methods to attempt for this input.
 *
 * Shape decides the FIRST guess: a string that can only be a recovery key is
 * tried as one immediately, so a user pasting their key never pays for two
 * failed PBKDF2 unwraps first. Everything else leads with the password wrap,
 * because that is the one almost every account has and almost nobody knows they
 * have. A key is still appended as a last resort for a mistyped/partial key, and
 * a method whose wrap does not exist is never attempted at all.
 *
 * Empty when there is nothing to restore FROM — the caller must say so rather
 * than reporting a wrong credential.
 */
export function planRestore(
  input: string,
  caps: BackupCapabilities,
): RestoreMethod[] {
  if (!caps || !caps.hasBackup) return [];
  if (!String(input || "").trim()) return [];
  const keyFirst = looksLikeRecoveryKey(input);
  const order: RestoreMethod[] = [];
  const add = (m: RestoreMethod) => {
    if (!order.includes(m)) order.push(m);
  };
  if (keyFirst) add("recoveryKey");
  if (caps.hasPasswordWrap) add("password");
  if (caps.hasPassphraseWrap) add("passphrase");
  if (!keyFirst) add("recoveryKey");
  return order;
}

/**
 * What to tell someone whose input matched nothing. It names only the
 * credentials their account actually has, so nobody hunts for a recovery
 * passphrase they never set.
 */
export function wrongCredentialMessage(caps: BackupCapabilities): string {
  if (!caps || !caps.hasBackup)
    return "No encrypted backup was found for your account, so there is nothing to restore here.";
  const names: string[] = [];
  if (caps.hasPasswordWrap) names.push("sign-in password");
  if (caps.hasPassphraseWrap) names.push("recovery passphrase");
  names.push("recovery key");
  const list =
    names.length === 1
      ? names[0]
      : names.slice(0, -1).join(", ") + " or " + names[names.length - 1];
  return `That didn't match your ${list}. Check it and try again.`;
}

/** Placeholder/help text for the single input, based on what exists. */
export function credentialPrompt(caps: BackupCapabilities): string {
  if (!caps || !caps.hasBackup) return "No backup found";
  if (caps.hasPasswordWrap && caps.hasPassphraseWrap)
    return "Your sign-in password, recovery passphrase, or recovery key";
  if (caps.hasPasswordWrap) return "Your sign-in password (or recovery key)";
  if (caps.hasPassphraseWrap) return "Your recovery passphrase (or recovery key)";
  return "Your recovery key";
}
