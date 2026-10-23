// RFC 6238 TOTP + RFC 4648 Base32, implemented on Node's crypto — NO external
// dependency (keeps the supply-chain / CVE surface at zero, which matters given
// the dependency-audit findings). Used by mfaService for authenticator-app 2FA.
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648

// Encode bytes as unpadded Base32 (what authenticator apps expect in the secret).
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Decode a Base32 string (padding + lowercase + spaces tolerated) back to bytes.
export function base32Decode(input: string): Buffer {
  const clean = String(input || "").toUpperCase().replace(/[=\s]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// A fresh 20-byte (160-bit) secret — the RFC-recommended size for HMAC-SHA1 TOTP.
export function generateSecret(): { raw: Buffer; base32: string } {
  const raw = randomBytes(20);
  return { raw, base32: base32Encode(raw) };
}

// HOTP (RFC 4226): dynamic-truncation of HMAC-SHA1(counter) to `digits` digits.
function hotp(key: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (write the low 32 bits; hi 32 stay 0 well past year 9999).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

export interface TotpOpts {
  step?: number; // seconds per code (default 30)
  digits?: number; // code length (default 6)
  t?: number; // unix ms "now" (injectable for tests)
}

// The current TOTP code for a secret.
export function totp(key: Buffer, opts: TotpOpts = {}): string {
  const step = opts.step || 30;
  const digits = opts.digits || 6;
  const t = opts.t ?? Date.now();
  return hotp(key, Math.floor(t / 1000 / step), digits);
}

// Verify a code, tolerating ±`window` steps of skew, and return the ABSOLUTE
// time-step counter that matched (or null). The counter is what the caller
// persists for anti-replay (RFC 6238 §5.2): reject any counter <= the last one
// accepted. Constant-time compare per candidate step.
export function verifyTotpCounter(
  key: Buffer,
  token: string,
  opts: TotpOpts & { window?: number } = {},
): number | null {
  const step = opts.step || 30;
  const digits = opts.digits || 6;
  const window = opts.window ?? 1;
  const t = opts.t ?? Date.now();
  const cleaned = String(token || "").replace(/\s/g, "");
  if (!/^\d+$/.test(cleaned) || cleaned.length !== digits) return null;
  const counter = Math.floor(t / 1000 / step);
  const provided = Buffer.from(cleaned);
  for (let w = -window; w <= window; w++) {
    const candidate = Buffer.from(hotp(key, counter + w, digits));
    if (candidate.length === provided.length && timingSafeEqual(candidate, provided)) {
      return counter + w;
    }
  }
  return null;
}

// Boolean convenience wrapper (used where the matched step isn't needed).
export function verifyTotp(
  key: Buffer,
  token: string,
  opts: TotpOpts & { window?: number } = {},
): boolean {
  return verifyTotpCounter(key, token, opts) !== null;
}

// The otpauth:// provisioning URI an authenticator app scans (as a QR) or imports.
export function otpauthUri(params: {
  secretBase32: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const qs = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${qs.toString()}`;
}
