// Plaintext fallback for a message this device cannot decrypt.
//
// A row is normally EITHER end-to-end encrypted (ciphertext envelopes, no body
// on the server) OR plaintext. A message that was "not encrypted properly" —
// the sender's client fell back to a plain body, an envelope set was stripped
// or malformed, or an envelope exists for this device but cannot be opened —
// may still carry readable plaintext, either on the server row itself or from
// a source the app registers (setPlaintextFallback). When it does, showing that
// text tagged "Not encrypted" is strictly more useful than "Message unavailable
// on this device", which is only honest when there is nothing to show.
//
// Pure and dependency-free so backend/app/test can exercise it directly.

/** Placeholder strings that must never be mistaken for real content. */
const PLACEHOLDER_PREFIXES = ["[Encrypted", "[Unencrypted", "[Replayed", "[Forged"];

/**
 * The readable plaintext a server row carries for a message, or null.
 * `pendingText` is the client's own "unavailable" placeholder, which an
 * earlier decrypt pass may already have written into `text`.
 */
export function serverPlaintextOf(m: any, pendingText: string): string | null {
  if (!m) return null;
  const candidates = [m.text, m.body, m.plainText, m.plaintext];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = c.trim();
    if (!t) continue;
    if (t === pendingText) continue;
    if (PLACEHOLDER_PREFIXES.some((p) => t.startsWith(p))) continue;
    return c;
  }
  return null;
}

/** A row that will render as readable plaintext, tagged as not encrypted. */
export function plaintextRow(m: any, text: string, why: string): any {
  return {
    ...m,
    text,
    encrypted: false,
    ciphertext: null,
    notEncrypted: true,
    _plaintextFallback: why,
  };
}
