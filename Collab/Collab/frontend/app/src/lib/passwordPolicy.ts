// Client-side mirror of the backend credential policy
// (backend/app/src/services/credentialPolicy.ts). Used for live signup UX:
// the strength meter and pre-submit validation. The SERVER re-validates and is
// the security authority — this is purely for fast, friendly feedback.

export const PASSWORD_MIN = 9;

const DISPOSABLE_DOMAINS = new Set([
  "tempmail.com", "temp-mail.org", "tempmail.dev", "tempmailo.com",
  "mailinator.com", "guerrillamail.com", "guerrillamail.info", "guerrillamail.biz",
  "10minutemail.com", "10minutemail.net", "20minutemail.com",
  "throwawaymail.com", "throwawaymailbox.com", "trashmail.com", "trashmail.net",
  "getnada.com", "nada.email", "dispostable.com", "yopmail.com", "yopmail.fr",
  "maildrop.cc", "mailnesia.com", "mailcatch.com", "fakeinbox.com",
  "sharklasers.com", "grr.la", "spam4.me", "mintemail.com", "mohmal.com",
  "emailondeck.com", "tempinbox.com", "tempr.email", "discard.email",
  "burnermail.io", "fakemailgenerator.com", "spambox.us", "incognitomail.org",
  "mytemp.email", "tmpmail.org", "tmpmail.net", "moakt.com", "mailtemp.net",
  "1secmail.com", "1secmail.org", "1secmail.net", "luxusmail.org",
  "wegwerfmail.de", "einrot.com", "fakemail.net", "tempmail.plus",
]);

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "password1234", "passw0rd",
  "p@ssw0rd", "p@ssword", "passw0rd!", "password!", "qwerty", "qwerty123",
  "qwertyuiop", "1234567890", "123456789", "12345678", "111111", "000000",
  "letmein", "welcome", "welcome1", "welcome123", "admin", "admin123",
  "administrator", "iloveyou", "monkey", "dragon", "sunshine", "princess",
  "football", "baseball", "abc123", "abcd1234", "trustno1", "superman",
  "batman", "master", "michael", "shadow", "ashley", "qazwsx", "zaq12wsx",
  "changeme", "changeme123", "default", "secret", "test1234", "temp1234",
  "colab123", "colabcolab", "samplepass", "passwordpassword",
]);

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

export function normalizeEmail(email: string): string {
  return (email || "").trim().toLowerCase();
}

// Returns an error string, or null when the email is acceptable.
export function emailError(rawEmail: string): string | null {
  const email = normalizeEmail(rawEmail);
  if (!email) return "Enter your email address.";
  if (email.length > 254 || !EMAIL_RE.test(email)) return "Enter a valid email address.";
  const domain = email.split("@")[1] || "";
  if (domain.includes("..") || domain.startsWith(".") || domain.endsWith("."))
    return "Enter a valid email address.";
  if (DISPOSABLE_DOMAINS.has(domain))
    return "Temporary / disposable email providers aren't allowed.";
  return null;
}

export interface PasswordRule {
  id: string;
  label: string;
  ok: boolean;
}

// The individual requirements (used to render the checklist in the form).
export function passwordRules(pw: string): PasswordRule[] {
  return [
    { id: "len", label: `At least ${PASSWORD_MIN} characters`, ok: pw.length >= PASSWORD_MIN },
    { id: "lower", label: "A lowercase letter", ok: /[a-z]/.test(pw) },
    { id: "upper", label: "An uppercase letter", ok: /[A-Z]/.test(pw) },
    { id: "num", label: "A number", ok: /[0-9]/.test(pw) },
    { id: "special", label: "A special character", ok: /[^A-Za-z0-9]/.test(pw) },
  ];
}

// Returns the first blocking error, or null when the password meets policy.
// Mirrors the server rules so the form blocks before the round-trip.
export function passwordError(pw: string, opts: { email?: string; name?: string } = {}): string | null {
  if (pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (pw.length > 200) return "Password is too long.";
  if (!/[a-z]/.test(pw)) return "Add a lowercase letter.";
  if (!/[A-Z]/.test(pw)) return "Add an uppercase letter.";
  if (!/[0-9]/.test(pw)) return "Add a number.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Add a special character (e.g. ! @ # $ %).";
  const lower = pw.toLowerCase();
  const alnum = lower.replace(/[^a-z0-9]/g, "");
  if (COMMON_PASSWORDS.has(lower) || (alnum.length >= 6 && COMMON_PASSWORDS.has(alnum)))
    return "That password is too common. Choose something less guessable.";
  // NOTE: containing your email name or display name is NOT blocked — it's only a
  // strength-meter tip (see passwordStrength → containsIdentity). e.g. for
  // mark@gmail.com, "Mark@123456789" is allowed and rated Strong, with a hint
  // suggesting not to include "mark". This keeps the rules predictable instead of
  // mysteriously rejecting an otherwise-strong password.
  return null;
}

// True when the password embeds the user's email local-part or a name token —
// a soft signal (lowers the meter + shows a clear tip), never a hard block.
function containsIdentity(pw: string, opts: { email?: string; name?: string }): string | null {
  const lower = pw.toLowerCase();
  const localPart = normalizeEmail(opts.email || "").split("@")[0] || "";
  if (localPart.length >= 4 && lower.includes(localPart)) return localPart;
  const nameTokens = String(opts.name || "").toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
  const hit = nameTokens.find((t) => lower.includes(t));
  return hit || null;
}

export type StrengthLabel = "Weak" | "Medium" | "Strong" | "Excellent";

export interface Strength {
  score: number; // 0..4
  label: StrengthLabel;
  hint: string; // actionable next step while typing
  pct: number; // 0..100 for the bar
}

// Heuristic strength estimate driving the live meter. Rewards length, character
// diversity and uniqueness; penalises common passwords. Not a security gate —
// passwordError() is — just user-facing guidance.
export function passwordStrength(pw: string, opts: { email?: string; name?: string } = {}): Strength {
  if (!pw) return { score: 0, label: "Weak", hint: `Use ${PASSWORD_MIN}+ characters with a mix of types.`, pct: 0 };

  const rules = passwordRules(pw);
  const missing = rules.filter((r) => !r.ok);
  let points = 0;
  // Composition (max 4)
  if (/[a-z]/.test(pw)) points++;
  if (/[A-Z]/.test(pw)) points++;
  if (/[0-9]/.test(pw)) points++;
  if (/[^A-Za-z0-9]/.test(pw)) points++;
  // Length bonuses
  if (pw.length >= 12) points++;
  if (pw.length >= 16) points++;
  if (pw.length >= 20) points++;
  // Character-variety bonus
  if (new Set(pw).size >= 10) points++;

  const lower = pw.toLowerCase();
  const alnumCore = lower.replace(/[^a-z0-9]/g, "");
  // HARD-weak: genuinely guessable — common words, all-same, obvious sequences.
  // These cap the meter at "Weak".
  const hardWeak =
    COMMON_PASSWORDS.has(lower) ||
    (alnumCore.length >= 6 && COMMON_PASSWORDS.has(alnumCore)) ||
    /^(.)\1+$/.test(pw) || // all same char
    /^(0123456789|1234567890|qwertyuiop|abcdefgh)/.test(lower);
  if (hardWeak) points = Math.min(points, 1);

  // SOFT signal: contains your email/name. NOT treated as weak — the password is
  // otherwise fine — but we nudge with a clear tip and hold it just under the top
  // tier. (Fixes the confusing case where "Mark@123456789" read "Weak" purely
  // because it contained the email name "mark".)
  const identityHit = !hardWeak ? containsIdentity(pw, opts) : null;
  if (identityHit) points = Math.min(points, 6);

  // Anything not meeting the hard rules is capped below "Strong".
  if (missing.length > 0) points = Math.min(points, 3);

  let label: StrengthLabel;
  let score: number;
  if (points <= 2) { label = "Weak"; score = 1; }
  else if (points <= 4) { label = "Medium"; score = 2; }
  else if (points <= 6) { label = "Strong"; score = 3; }
  else { label = "Excellent"; score = 4; }

  let hint: string;
  if (hardWeak) hint = "Avoid common words, repeats and sequences.";
  else if (missing.length) hint = "Add " + missing.map((m) => m.label.toLowerCase().replace(/^a(t)? /, "")).slice(0, 2).join(" and ") + ".";
  else if (identityHit) hint = `Strong — but for extra safety, avoid putting “${identityHit}” (your name/email) in your password.`;
  else if (pw.length < 16) hint = "Longer is stronger — try a memorable passphrase.";
  else hint = "Great password.";

  return { score, label, hint, pct: Math.round((score / 4) * 100) };
}
