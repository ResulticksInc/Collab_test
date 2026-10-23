/**
 * CoLab Double Ratchet — DH + symmetric chain with skipped-key caching.
 *
 * Implements the core of Signal's Double Ratchet algorithm:
 *   1. DH RATCHET  — every direction change rotates the root key (RK) via a
 *      fresh ECDH(my new DH priv, peer's last DH pub). Gives post-compromise
 *      security: an attacker who steals the current chain key cannot decrypt
 *      messages once the next DH ratchet step has happened.
 *   2. SYMMETRIC CHAIN — within a sending direction, each message derives a
 *      fresh AES-GCM key via HMAC-SHA256(chain_key, 0x01) and ratchets the
 *      chain forward via HMAC-SHA256(chain_key, 0x02). Old chain keys are
 *      discarded; an attacker who steals the current chain key cannot decrypt
 *      earlier messages in the same chain.
 *   3. SKIPPED KEY CACHE — when messages arrive out of order (e.g. UDP-style
 *      delivery, network reordering), intermediate message keys are cached so
 *      they can be decrypted later without ratchet desync. Gated by MAX_SKIP
 *      to prevent DoS via malicious skip-flooding.
 *
 * SCOPE:
 *   - DM text payloads only. Files, groups, calls use ECIES / shared-epoch-key.
 *   - In-cleartext header (sender DH pub + counters).
 *   - Single-recipient (no fan-out). Multi-device: one session per recipient device.
 *
 * STATE SERIALISATION:
 *   The whole RatchetState is a plain JSON object. DH private keys are
 *   extractable JWKs (required for IndexedDB round-trip). Identity keys
 *   remain non-extractable.
 *
 * REFERENCES:
 *   https://signal.org/docs/specifications/doubleratchet/
 */

const DR_VERSION = "CoLab-DR-v1";
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const AES_GCM = { name: "AES-GCM", length: 256 } as const;
const HMAC = { name: "HMAC", hash: "SHA-256" } as const;
const HKDF_HASH = { name: "HKDF", hash: "SHA-256" } as const;
// Maximum number of skipped messages per receiving chain. Prevents an attacker
// from flooding the skipped-key map by sending messages with enormous counters.
const MAX_SKIP = 1000;

// ─── base64 helpers (browser-safe, no Node Buffer) ──────────────────────────
function b64enc(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64dec(s: string): Uint8Array<ArrayBuffer> {
  if (!s) return new Uint8Array(0);
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) {
    return new Uint8Array(0);
  }
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ─── State shape ───────────────────────────────────────────────────────────
//
// All bytes are base64-encoded. JWK is the standard JOSE form Web Crypto uses
// for importKey/exportKey with format "jwk".
export interface RatchetState {
  ver: 1;
  // Root key — 32 bytes.
  rk: string;
  // Sending chain key — 32 bytes, or null pre-first-send.
  cks: string | null;
  // Receiving chain key — 32 bytes, or null pre-first-receive.
  ckr: string | null;
  // My current DH ratchet keypair.
  dhsPriv: JsonWebKey;
  dhsPub: string;
  // Peer's last seen DH ratchet public key. null on responder's initial state.
  dhrPub: string | null;
  // Sending counter — number of messages sent in the current sending chain.
  ns: number;
  // Receiving counter — number of messages received in the current receiving chain.
  nr: number;
  // Previous sending chain length — sent in every header.
  pn: number;
  // Skipped message keys — base64-encoded MKs keyed by message index (nr value).
  // Persisted so out-of-order messages can be decrypted after a page reload.
  // record<"nr", "mkBase64">
  skippedKeys: Record<string, string>;
  // Bootstrap fingerprints — the peer/own key bytes the SK was derived from.
  // Used by manager.ts to detect when the underlying identity has rotated
  // (e.g. device wipe + re-enrol with a different identity pub) and force a
  // fresh re-bootstrap. Optional + backwards-compatible: legacy sessions
  // without them are treated as stale and rebuilt on next use.
  bootstrapPeerIdentity?: string;       // peer identity pub b64 (both sides)
  bootstrapPeerRatchetInitial?: string; // peer's ratchet initial pub b64 (initiator only)
  bootstrapMyRatchetInitialPub?: string; // my own ratchet initial pub b64 (responder only)
}

// Header sent in cleartext alongside the ciphertext (bound into AAD).
export interface RatchetHeader {
  dh: string; // sender's current DH ratchet public key (raw, b64)
  pn: number; // previous sending chain length
  n: number;  // this message's counter within the current sending chain
}

// ─── Web Crypto helpers ─────────────────────────────────────────────────────

async function genDh(): Promise<{ priv: JsonWebKey; pub: string }> {
  const kp = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { priv, pub: b64enc(pubRaw) };
}

async function importPrivJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ECDH, true, ["deriveBits"]);
}
async function importPubRaw(b: string): Promise<CryptoKey> {
  const raw = b64dec(b);
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("invalid DH public key");
  return crypto.subtle.importKey("raw", raw, ECDH, false, []);
}

// Raw ECDH output (256 bits).
async function dh(privJwk: JsonWebKey, peerPubB64: string): Promise<Uint8Array> {
  const priv = await importPrivJwk(privJwk);
  const pub = await importPubRaw(peerPubB64);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  return new Uint8Array(bits);
}

// HKDF-SHA256 → variable-length output bytes.
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const hk = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ ...HKDF_HASH, salt: salt as BufferSource, info: info as BufferSource }, hk, length * 8);
  return new Uint8Array(bits);
}

// KDF_RK(RK, dh_out) → (new_RK, new_CK). Both 32 bytes.
async function kdfRk(rk: Uint8Array, dhOut: Uint8Array): Promise<{ rk: Uint8Array; ck: Uint8Array }> {
  const out = await hkdf(rk, dhOut, utf8(DR_VERSION + "|RK"), 64);
  return { rk: out.slice(0, 32), ck: out.slice(32, 64) };
}

// KDF_CK(CK) → (new_CK, MK). Both 32 bytes.
async function kdfCk(ck: Uint8Array): Promise<{ ck: Uint8Array; mk: Uint8Array }> {
  const key = await crypto.subtle.importKey("raw", ck as BufferSource, HMAC, false, ["sign"]);
  const mk = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array([0x01])));
  const next = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array([0x02])));
  return { ck: next, mk };
}

// ─── AEAD with the message key ──────────────────────────────────────────────
// The message key MK is 32 bytes (HMAC output truncated/used as-is). For
// AES-GCM-256 we use MK directly as the key. IV is RANDOM 12 bytes per message
// and carried in the envelope (the message key is never reused so deterministic
// IV would also be safe, but random is more robust to implementation bugs).
async function aeadEncrypt(
  mk: Uint8Array,
  iv: Uint8Array,
  ad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", mk as BufferSource, AES_GCM, false, ["encrypt"]);
  return new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: ad as BufferSource }, k, plaintext as BufferSource),
  );
}
async function aeadDecrypt(
  mk: Uint8Array,
  iv: Uint8Array,
  ad: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", mk as BufferSource, AES_GCM, false, ["decrypt"]);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: ad as BufferSource }, k, ciphertext as BufferSource),
  );
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize a Double Ratchet session as the INITIATOR (the side sending the
 * very first message). Conceptually: Alice has just completed X3DH and has a
 * shared secret SK with Bob; Bob's signed prekey public is `peerInitialDhPubB64`.
 *
 * Output state has CKs seeded (we can encrypt straight away) and CKr=null
 * (we'll seed it on first receive when Bob's first reply carries his new DH pub).
 */
export async function initiateRatchet(
  sharedSecret: Uint8Array,
  peerInitialDhPubB64: string,
  bootstrapMeta?: { peerIdentityB64?: string },
): Promise<RatchetState> {
  if (sharedSecret.length !== 32) throw new Error("shared secret must be 32 bytes");
  const dhs = await genDh();
  // First RK seed = KDF_RK(SK, DH(my-fresh-DH, peer-initial-DH))
  const dh1 = await dh(dhs.priv, peerInitialDhPubB64);
  const { rk, ck } = await kdfRk(sharedSecret, dh1);
  return {
    ver: 1,
    rk: b64enc(rk),
    cks: b64enc(ck),
    ckr: null,
    dhsPriv: dhs.priv,
    dhsPub: dhs.pub,
    dhrPub: peerInitialDhPubB64,
    ns: 0,
    nr: 0,
    pn: 0,
    skippedKeys: {},
    bootstrapPeerIdentity: bootstrapMeta?.peerIdentityB64,
    bootstrapPeerRatchetInitial: peerInitialDhPubB64,
  };
}

/**
 * Initialize a Double Ratchet session as the RESPONDER (Bob). At this point Bob
 * has the X3DH shared secret SK and his own DH keypair (whose public was
 * advertised in his bundle). He has not yet received anything from Alice.
 *
 * Output state has CKs=CKr=null. The first incoming message from Alice carries
 * her DH pub and triggers a DH ratchet step that seeds CKr; Bob's first reply
 * triggers another DH ratchet step that seeds CKs.
 */
export async function respondRatchet(
  sharedSecret: Uint8Array,
  myInitialDhKeypair: { priv: JsonWebKey; pubB64: string },
  bootstrapMeta?: { peerIdentityB64?: string },
): Promise<RatchetState> {
  if (sharedSecret.length !== 32) throw new Error("shared secret must be 32 bytes");
  return {
    ver: 1,
    rk: b64enc(sharedSecret),
    cks: null,
    ckr: null,
    dhsPriv: myInitialDhKeypair.priv,
    dhsPub: myInitialDhKeypair.pubB64,
    dhrPub: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skippedKeys: {},
    bootstrapPeerIdentity: bootstrapMeta?.peerIdentityB64,
    bootstrapMyRatchetInitialPub: myInitialDhKeypair.pubB64,
  };
}

/**
 * Encrypt one message. Returns the new state (caller persists), the header
 * to embed in the envelope, the random IV, and the ciphertext.
 *
 * `ad` is the application-level associated data (e.g. the existing AAD that
 * binds sender/recipient/conversation/mid). The header bytes are concatenated
 * into the AEAD so a header-tamper invalidates the GCM tag.
 */
export async function ratchetEncrypt(
  state: RatchetState,
  ad: Uint8Array,
  plaintext: Uint8Array,
): Promise<{
  state: RatchetState;
  header: RatchetHeader;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}> {
  if (!state.cks)
    throw new Error("ratchet: cannot encrypt — no sending chain (call dhStepSender first or be the initiator)");
  // Symmetric chain step
  const { ck: nextCk, mk } = await kdfCk(b64dec(state.cks));
  const header: RatchetHeader = { dh: state.dhsPub, pn: state.pn, n: state.ns };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Bind the header into the AEAD: tampering with dh / pn / n breaks decrypt.
  const fullAd = concat(ad, utf8(JSON.stringify(header)));
  const ct = await aeadEncrypt(mk, iv, fullAd, plaintext);
  return {
    state: { ...state, cks: b64enc(nextCk), ns: state.ns + 1 },
    header,
    iv,
    ciphertext: ct,
  };
}

/**
 * Try to decrypt using a previously-cached skipped message key.
 * Returns plaintext if found, null otherwise.
 */
async function tryCachedKey(
  state: RatchetState,
  ad: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  n: number,
  pn: number,
): Promise<Uint8Array | null> {
  const mkB64 = state.skippedKeys[String(n)];
  if (!mkB64) return null;
  try {
    const mk = b64dec(mkB64);
    const fullAd = concat(ad, utf8(JSON.stringify({ dh: state.dhrPub || "", pn, n })));
    const pt = await aeadDecrypt(mk, iv, fullAd, ciphertext);
    return pt;
  } catch (_) {
    return null;
  }
}

/**
 * Decrypt one message. If the message's header carries a new DH pub, performs
 * a DH ratchet step (rotates root key + seeds new receiving chain).
 *
 * Handles out-of-order delivery: if header.n > state.nr, intermediate message
 * keys are cached in skippedKeys for later decryption. If header.n < state.nr,
 * looks up the cached key from a prior out-of-order arrival. Gated by MAX_SKIP.
 */
export async function ratchetDecrypt(
  state: RatchetState,
  header: RatchetHeader,
  ad: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<{ state: RatchetState; plaintext: Uint8Array }> {
  let st = { ...state, skippedKeys: { ...state.skippedKeys } };

  // DH ratchet step: peer's DH pub changed.
  if (st.dhrPub !== header.dh) st = await dhRatchetStep(st, header.dh);

  // Message arrived earlier than expected — check cached skipped key.
  if (header.n < st.nr) {
    const pt = await tryCachedKey(st, ad, iv, ciphertext, header.n, header.pn);
    if (pt !== null) {
      // Delete from skipped keys on success (single-use message key).
      const nextSkipped = { ...st.skippedKeys };
      delete nextSkipped[String(header.n)];
      return { state: { ...st, skippedKeys: nextSkipped }, plaintext: pt };
    }
    // Not in cache and before nr — duplicate or too old.
    const err: any = new Error("ratchet: message already processed or key expired");
    err.outOfOrder = true;
    err.expected = st.nr;
    err.got = header.n;
    throw err;
  }

  // Too far ahead — would exceed MAX_SKIP.
  if (header.n > st.nr + MAX_SKIP) {
    const err: any = new Error("ratchet: message counter too far ahead (possible attack)");
    err.outOfOrder = true;
    err.skip = header.n - st.nr;
    throw err;
  }

  if (!st.ckr) throw new Error("ratchet: receiving chain not initialised");

  // Derive and cache intermediate message keys for skipped messages.
  let ck = b64dec(st.ckr);
  for (let i = st.nr; i < header.n; i++) {
    const ckBytes = new Uint8Array(ck.length);
    ckBytes.set(ck);
    const key = await crypto.subtle.importKey("raw", ckBytes as BufferSource, HMAC, false, ["sign"]);
    const mk = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array([0x01])));
    const nextCk = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array([0x02])));
    st.skippedKeys[String(i)] = b64enc(mk);
    ck = nextCk;
  }

  // Derive message key for the current message and decrypt.
  const ckBytes = new Uint8Array(ck.length);
  ckBytes.set(ck);
  const ckKey = await crypto.subtle.importKey("raw", ckBytes as BufferSource, HMAC, false, ["sign"]);
  const mk = new Uint8Array(await crypto.subtle.sign("HMAC", ckKey, new Uint8Array([0x01])));
  const nextCk = new Uint8Array(await crypto.subtle.sign("HMAC", ckKey, new Uint8Array([0x02])));
  const fullAd = concat(ad, utf8(JSON.stringify(header)));
  const pt = await aeadDecrypt(mk, iv, fullAd, ciphertext);

  // Prune skipped keys exceeding MAX_SKIP to prevent unbounded growth.
  if (Object.keys(st.skippedKeys).length > MAX_SKIP) {
    const pruned: Record<string, string> = {};
    const entries = Object.entries(st.skippedKeys)
      .sort(([a], [b]) => Number(a) - Number(b))
      .slice(-MAX_SKIP);
    for (const [k, v] of entries) pruned[k] = v;
    st.skippedKeys = pruned;
  }

  return {
    state: { ...st, ckr: b64enc(nextCk), nr: header.n + 1 },
    plaintext: pt,
  };
}

/**
 * DH ratchet step (Signal §3.5). Called when a peer sends a message whose
 * header.dh differs from our pinned state.dhrPub:
 *   1. Save the previous sending chain length (so the receiver can derive
 *      skipped keys in Phase 2; here we just record it).
 *   2. RK, CKr = KDF_RK(RK, DH(old-DHs, new-peer-DH))
 *   3. Generate a fresh DHs keypair.
 *   4. RK, CKs = KDF_RK(RK, DH(new-DHs, new-peer-DH))
 */
async function dhRatchetStep(state: RatchetState, newPeerDhPubB64: string): Promise<RatchetState> {
  // Receiving side: derive new RK + CKr from DH(my-current-priv, new-peer-pub)
  const dhOut1 = await dh(state.dhsPriv, newPeerDhPubB64);
  const step1 = await kdfRk(b64dec(state.rk), dhOut1);
  // Sending side: rotate my DH, derive next RK + CKs.
  const newDhs = await genDh();
  const dhOut2 = await dh(newDhs.priv, newPeerDhPubB64);
  const step2 = await kdfRk(step1.rk, dhOut2);
  return {
    ...state,
    rk: b64enc(step2.rk),
    ckr: b64enc(step1.ck),
    cks: b64enc(step2.ck),
    dhrPub: newPeerDhPubB64,
    dhsPriv: newDhs.priv,
    dhsPub: newDhs.pub,
    pn: state.ns, // previous sending chain length
    ns: 0,
    nr: 0,
    skippedKeys: {}, // fresh receiving chain → old skipped keys no longer valid
  };
}

// ─── Test-only helpers (exposed for verify-e2ee-crypto.cjs) ────────────────
// Visible only because the verification harness needs to assert key-rotation
// has actually happened; the app code only uses initiate/respond/encrypt/decrypt.
export const __test = {
  b64enc,
  b64dec,
  utf8,
  genDh,
  kdfCk,
  kdfRk,
  DR_VERSION,
};
