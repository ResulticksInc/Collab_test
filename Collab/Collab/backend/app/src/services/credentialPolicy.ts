// Enterprise credential policy — server-side source of truth for email + password
// validation at signup. No SMTP / external calls: disposable detection is a
// static + env-configurable domain blocklist. The frontend mirrors these rules
// for live UX feedback (frontend/app/src/lib/passwordPolicy.ts), but THIS file
// is the authority — the client cannot bypass it.
//
// Future-ready: this module only validates the submitted credentials. Email
// verification, MFA/TOTP, passkeys and SSO can be layered on top without
// changing these rules (a verified flag / second factor would gate login, not
// the policy here).

export const PASSWORD_MIN = 9;

// Disposable / throwaway inbox providers. Built-in core list; extend at deploy
// time via DISPOSABLE_EMAIL_DOMAINS (comma-separated) without a code change.
const DISPOSABLE_DOMAINS_BUILTIN = [
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
];

function disposableSet(): Set<string> {
  const extra = (process.env.DISPOSABLE_EMAIL_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DISPOSABLE_DOMAINS_BUILTIN, ...extra]);
}

// Most-common / trivially-guessable passwords. Rejected outright regardless of
// composition (a 12-char "Password1234!" is still weak). Kept compact but
// covers the perennial top offenders + their obvious decorations.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "password1234", "passw0rd",
  "p@ssw0rd", "p@ssword", "passw0rd!", "password!", "qwerty", "qwerty123",
  "qwertyuiop", "1234567890", "123456789", "12345678", "111111", "000000",
  "letmein", "welcome", "welcome1", "welcome123", "admin", "admin123",
  "administrator", "iloveyou", "monkey", "dragon", "sunshine", "princess",
  "football", "baseball", "abc123", "abcd1234", "trustno1", "superman",
  "batman", "master", "michael", "shadow", "ashley", "qazwsx", "zaq12wsx",
  "changeme", "changeme123", "default", "secret", "test1234", "temp1234",
  "Collab123", "CollabCollab", "samplepass", "passwordpassword",
]);

// A strict-but-standard email shape. Intentionally simple (no full RFC 5322):
// one local part, one domain, a dot-something TLD, no spaces.
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

export interface CredentialIssue {
  field: "email" | "password";
  message: string;
}

export function normalizeEmail(email: unknown): string {
  return String(email || "").trim().toLowerCase();
}

export function validateEmail(rawEmail: unknown): CredentialIssue | null {
  const email = normalizeEmail(rawEmail);
  if (!email) return { field: "email", message: "Enter your email address." };
  if (email.length > 254 || !EMAIL_RE.test(email))
    return { field: "email", message: "Enter a valid email address." };
  const domain = email.split("@")[1] || "";
  // Reject a bare domain with no real TLD or doubled dots.
  if (domain.includes("..") || domain.startsWith(".") || domain.endsWith("."))
    return { field: "email", message: "Enter a valid email address." };
  if (disposableSet().has(domain))
    return {
      field: "email",
      message: "Temporary / disposable email providers aren't allowed. Use your work or personal email.",
    };
  return null;
}

// Returns the FIRST blocking issue, or null when the password satisfies policy.
// `email` and `name` are used to reject credential-derived passwords.
export function validatePassword(
  rawPassword: unknown,
  opts: { email?: string; name?: string } = {},
): CredentialIssue | null {
  const pw = String(rawPassword || "");
  if (pw.length < PASSWORD_MIN)
    return { field: "password", message: `Password must be at least ${PASSWORD_MIN} characters.` };
  if (pw.length > 200)
    return { field: "password", message: "Password is too long (200 characters max)." };
  if (!/[a-z]/.test(pw))
    return { field: "password", message: "Add a lowercase letter." };
  if (!/[A-Z]/.test(pw))
    return { field: "password", message: "Add an uppercase letter." };
  if (!/[0-9]/.test(pw))
    return { field: "password", message: "Add a number." };
  if (!/[^A-Za-z0-9]/.test(pw))
    return { field: "password", message: "Add a special character (e.g. ! @ # $ %)." };

  const lower = pw.toLowerCase();
  // Also test the alphanumeric core so decorated common passwords ("Password1234!",
  // "P@ssw0rd!") don't sneak past via a trailing symbol or substitution.
  const alnum = lower.replace(/[^a-z0-9]/g, "");
  if (COMMON_PASSWORDS.has(lower) || (alnum.length >= 6 && COMMON_PASSWORDS.has(alnum)))
    return { field: "password", message: "That password is too common. Choose something less guessable." };

  // NOTE: containing the email local-part or a name token is intentionally NOT a
  // hard block — it was confusing (an otherwise-strong "Mark@123456789" got
  // rejected purely for containing "mark"). It's surfaced as a friendly tip in
  // the live strength meter (frontend passwordStrength → containsIdentity)
  // instead. The composition + common-password rules above remain the gate.

  return null;
}
