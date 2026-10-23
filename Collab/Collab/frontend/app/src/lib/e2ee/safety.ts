/**
 * Safety number (a.k.a. security code) for out-of-band identity verification —
 * the defense against a server that substitutes a peer's public key (MITM).
 * Two users compare the same number; if it matches, no one is in the middle.
 * Computed entirely client-side from the two IDENTITY public keys.
 */
function b64dec(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Deterministic, order-independent safety number: SHA-256 over the two raw
 * identity public keys sorted lexicographically, rendered as Signal-style
 * grouped 5-digit blocks (60 digits / 12 groups). Both sides compute the same
 * value regardless of who is "local".
 */
export async function computeSafetyNumber(
  localIdentityPubB64: string,
  remoteIdentityPubB64: string,
): Promise<string> {
  const a = localIdentityPubB64;
  const b = remoteIdentityPubB64;
  const [first, second] = a < b ? [a, b] : [b, a];
  const buf = new Uint8Array([...b64dec(first), ...b64dec(second)]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  // Turn the hash into decimal digit groups (5 digits per 5 bytes-ish chunk).
  let out = "";
  for (let i = 0; i < 30; i += 5) {
    let n = 0;
    for (let j = 0; j < 5; j++) n = (n * 256 + (digest[i + j] || 0)) % 100000;
    out += String(n).padStart(5, "0");
    if (i + 5 < 30) out += " ";
  }
  return out; // e.g. "01234 56789 ..." (6 groups)
}
