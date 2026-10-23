import { signalStore } from "./SignalStore";
import { api } from "../api";
import { captureIssue } from "../telemetry";
import { decryptBlob } from "./media";
import { computeSafetyNumber } from "./safety";
import {
  recoveryPathsOf,
  createRecoveryPathsCache,
  type E2EERecoveryPaths,
} from "./recoveryPaths";
import {
  planRestore,
  wrongCredentialMessage,
  type BackupCapabilities,
  type RestoreMethod,
} from "./restorePlan";
import { serverPlaintextOf, plaintextRow } from "./plaintextFallback";
import {
  mergeEntries,
  planRefreshGather,
  trimToBudget,
  newestTs,
  reduceRecovery,
  shouldRunRecovery,
  initialRecoveryState,
  type RecoveryState,
  type RecoveryEvent,
} from "./backupPlan";
import {
  saveRecoverySecret as keychainSaveSecret,
  loadRecoverySecret as keychainLoadSecret,
  clearRecoverySecret as keychainClearSecret,
} from "../tokenStore";
import {
  initiateRatchet,
  respondRatchet,
  ratchetEncrypt,
  ratchetDecrypt,
  type RatchetState,
  type RatchetHeader,
} from "./ratchet";

/**
 * CoLab E2EE — native Web Crypto, ECIES per recipient device. ZERO infra:
 * P-256 ECDH + HKDF-SHA-256 + AES-GCM-256, all in the browser. Device identity
 * private key is a NON-EXTRACTABLE CryptoKey in IndexedDB (never exportable by
 * JS/XSS); the server only ever stores PUBLIC keys + opaque ciphertext, so a DB
 * dump / Redis / admin can never read message content.
 *
 * Security properties (honest):
 *  - Confidentiality vs server/DB/storage/admin: YES (private keys never leave the device).
 *  - Integrity + context binding: AES-GCM with AAD bound to sender/recipient/
 *    conversation + a per-message nonce → server cannot splice/move/forge envelopes.
 *  - MITM: TOFU pinning of peer identity keys + fail-closed on key change
 *    (+ safety-number out-of-band verification in safety.ts).
 *  - Fail-CLOSED: if encryption cannot run for an E2EE conversation, the send is
 *    BLOCKED (we never silently fall back to plaintext).
 *  - Forward secrecy: per-message ephemeral ECDH gives confidentiality vs the
 *    server, but NOT full forward secrecy against theft of a device's long-term
 *    key (that needs a ratchet — Phase 2). Documented, not overclaimed.
 *
 * DM/self only in v1. Groups/channels/calls/meetings are untouched (plaintext as
 * before). Gated entirely by NEXT_PUBLIC_E2EE_ENABLED — OFF by default, so the
 * existing product is byte-for-byte unchanged until the flag is flipped.
 */
const E2EE_ENABLED = process.env.NEXT_PUBLIC_E2EE_ENABLED === "true";
// Read-only legacy decrypt: keeps the new-message ENCRYPT switch OFF
// (isE2EEEnabled stays false) but turns the READ/DECRYPT path back ON so
// existing encrypted messages/files render whenever this device's keys exist.
const E2EE_DECRYPT_LEGACY = process.env.NEXT_PUBLIC_E2EE_DECRYPT_LEGACY === "true";
// B2 strict mode: when ON, an encrypted envelope from a peer that has NOT
// published a signing key is REJECTED rather than rendered. Default OFF so the
// migration window (existing devices that haven't re-registered yet) doesn't
// fail-closed before they republish. Flip to "true" once all devices have
// re-initialized at least once and republished with a signing key.
const E2EE_REQUIRE_SIGNATURES =
  process.env.NEXT_PUBLIC_E2EE_REQUIRE_SIGNATURES === "true";
// Double Ratchet Phase 1 (DH + symmetric chain). Default OFF so the existing
// per-device ECIES path is byte-for-byte unchanged until both sides flip the
// flag. When ON, NEW DM text envelopes use the ratchet (envelope t:3); decrypt
// routes by envelope type, so legacy t:1 envelopes still decrypt with ECIES
// during the migration window. Crypto in lib/e2ee/ratchet.ts.
const E2EE_RATCHET =
  process.env.NEXT_PUBLIC_E2EE_RATCHET === "true";
const VERSION = "CoLab-E2EE-v1";
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
// B2 — sender authentication: a SEPARATE ECDSA P-256 keypair per device. ECDH
// keys (used for confidentiality) cannot sign, so we publish a second public
// key dedicated to authenticating who sent each envelope. Every encrypted DM
// and group message carries an ECDSA-P256-SHA256 signature over the AAD; the
// recipient verifies against the sender's TOFU-pinned signing key. Closes the
// group-member impersonation hole and prevents server-fabricated peer messages.
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SIG = { name: "ECDSA", hash: "SHA-256" } as const;

export function isE2EEEnabled(): boolean {
  return E2EE_ENABLED && typeof window !== "undefined";
}

// Read-capability gate: true when EITHER full E2EE is on OR legacy-decrypt is
// enabled. Used by the decrypt/init paths only — never by the encrypt/publish/
// group-key paths (those stay gated on isE2EEEnabled()).
export function isE2EEDecryptEnabled(): boolean {
  return (E2EE_ENABLED || E2EE_DECRYPT_LEGACY) && typeof window !== "undefined";
}

// Bounded retry for the device-REGISTER publish. A transient blip while registering
// left the user device-less for the rest of the session (init only re-runs on the
// next full load), and a device-less user makes EVERY peer fall back to plaintext
// when messaging them — a leading cause of the "some msgs encrypted, some not"
// inconsistency. A few short retries close that window; if all fail it still throws
// (same terminal behavior as before → clean re-mint on the next init).
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 500): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1)
        await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw lastErr;
}

export let myDeviceId: string | null = null;
export let myUserId: string | null = null;

// Tracks whether we've re-confirmed our device registration with the server
// in this browser session. Reset to false on every page load so a DB-clear
// (server-side wipe) is detected and the device is re-registered via upsert.
let _deviceRegisteredThisSession = false;
// True ONLY when this session's enrollment minted a brand-new identity (the key-
// gen block below). A freshly minted device has NO envelopes for any message older
// than itself, so it must eagerly ask its siblings for history instead of waiting
// for each thread to render "[Encrypted…]" (whose preview decrypt only asks for
// conversations whose LAST message is pending). Set once here, never reused.
let _freshEnrollThisSession = false;

// In-memory caches (per page session).
const pubKeyCache = new Map<string, CryptoKey>(); // "userId:deviceId" -> peer identity pub
const signPubCache = new Map<string, CryptoKey>(); // "userId:deviceId" -> peer ECDSA verify key (B2)
let myIdentityPriv: CryptoKey | null = null;
let myIdentityPubB64: string | null = null; // my raw identity public key (for safety numbers)
let mySigningPriv: CryptoKey | null = null; // my ECDSA sign key (non-extractable) — B2
let myToken: string | null = null; // captured in initE2EE so decrypt can fetch group keys
/** The (device-bound) session token E2EE is running with, for UI actions. */
export function getE2EEToken(): string | null {
  return myToken;
}
// Peer devices whose pinned identity key CHANGED since first sight (possible
// MITM) — we refuse to encrypt to them until the user re-verifies.
export const changedIdentities = new Set<string>(); // "userId:deviceId"

// Establishment side-channel (keyed by remoteUserId) written by
// ensureSessionsForUser and read by encryptForUser. It lets encryptForUser tell
// apart TWO very different "no established devices" situations that used to look
// identical (empty device list):
//   - lastEstablishBundleCount: how many device bundles the server actually
//     returned for the peer. 0 = the peer has genuinely published no devices
//     (the legitimate progressive-rollout plaintext path).
//   - lastEstablishErrored: at least one returned device FAILED to establish
//     (key import/TOFU/IndexedDB error — e.g. the FK-cascade storage bug). This
//     is a TRANSIENT failure, NOT "peer has no device", so the send must
//     fail-closed and retry rather than silently downgrade to plaintext.
const lastEstablishBundleCount = new Map<string, number>();
const lastEstablishErrored = new Map<string, boolean>();

// Mechanism A (server-blind device-link history sync): callback the UI registers
// so a successful restore can drop the affected conversations' cached message
// arrays and force a lazy re-fetch (which now hits the freshly-populated
// plaintext cache — no new render branch).
let onHistoryRestored: ((convIds: string[]) => void) | null = null;
export function setOnHistoryRestored(cb: (convIds: string[]) => void) {
  onHistoryRestored = cb;
}
// Per-(this-device → target-device) idempotency marker so we only build/upload a
// history bundle to a given target once. Scoped to this device id so a different
// local device re-syncs independently.
function syncedMarkerKey(targetDeviceId: string): string {
  return "e2ee_synced:" + String(myDeviceId) + ":" + targetDeviceId;
}
function alreadySyncedTo(targetDeviceId: string): boolean {
  try {
    return localStorage.getItem(syncedMarkerKey(targetDeviceId)) === "1";
  } catch (_) {
    return false;
  }
}
function markSyncedTo(targetDeviceId: string): void {
  try {
    localStorage.setItem(syncedMarkerKey(targetDeviceId), "1");
  } catch (_) { }
}

// Group / channel E2EE state (shared per-epoch conversation key).
const groupKeyCache = new Map<string, { key: CryptoKey; ver: number; setHash: string }>(); // conversationId -> current epoch
const groupKeyByVer = new Map<string, CryptoKey>(); // "conversationId:ver" -> key (for decrypting any epoch)
// Raw bytes (base64) of the CURRENT epoch key per conversation. Kept only so the
// same shared secret can key LiveKit call/meeting media E2EE (getCallMediaKey).
const groupRawByConv = new Map<string, string>();
// Conversations whose current epoch is held under DIFFERENT keys by different
// devices (detected on decrypt). The next send from here opens a fresh epoch.
const splitEpochConvs = new Set<string>();

// Forward secrecy (V4): cached one-time prekey per peer device, learned from the
// bundle. Consumed (atomically, server-side) when used; the recipient deletes its
// private half after one decrypt. "userId:deviceId" -> {keyId, pubB64}.
const opkCache = new Map<string, { keyId: string; pubB64: string }>();
const PREKEY_LOW_WATERMARK = 20;

// ---- base64 helpers (browser-safe; no Node Buffer) -----------------------
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
function utf8(s: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(enc.length);
  out.set(enc);
  return out;
}
// Random bytes guaranteed ArrayBuffer-backed (not SharedArrayBuffer), so the
// result satisfies crypto.subtle's BufferSource<ArrayBuffer> under strict DOM lib.
function randBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n));
  crypto.getRandomValues(out);
  return out;
}

// Import a raw uncompressed P-256 public key (65 bytes, 0x04 prefix). importKey
// performs on-curve validation, blocking invalid-curve attacks.
async function importPub(rawB64: string): Promise<CryptoKey> {
  const raw = b64dec(rawB64);
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("invalid public key");
  return crypto.subtle.importKey("raw", raw, ECDH, false, []);
}

// Same on-curve validation, but imported as an ECDSA verify key (B2).
async function importSignPub(rawB64: string): Promise<CryptoKey> {
  const raw = b64dec(rawB64);
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error("invalid signing key");
  return crypto.subtle.importKey("raw", raw, ECDSA, false, ["verify"]);
}

// Sign / verify the AAD bytes with the device's ECDSA P-256 key (B2). The AAD
// already binds sender/recipient/conversation/nonce/mid + the ciphertext is
// AEAD-tagged under the encryption key, so signing the AAD authenticates the
// envelope's full context. Returns base64 raw IEEE-P1363 signature.
async function signAad(ad: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!mySigningPriv) throw new Error("E2EE signing key missing");
  const sig = await crypto.subtle.sign(ECDSA_SIG, mySigningPriv, ad);
  return b64enc(sig);
}
async function verifyAad(
  signPub: CryptoKey,
  ad: Uint8Array<ArrayBuffer>,
  sigB64: string,
): Promise<boolean> {
  if (!sigB64) return false;
  try {
    return await crypto.subtle.verify(ECDSA_SIG, signPub, b64dec(sigB64), ad);
  } catch (_) {
    return false;
  }
}

// AAD binds the envelope to its full context so the server cannot move/forge it.
// `mid` (a unique per-message id) is bound too: it is the anti-replay anchor —
// the server cannot re-inject an old envelope under a new message id without the
// client noticing the repeated mid (see decryptMessageList).
function aad(
  senderUserId: string,
  senderDeviceId: string,
  recipientUserId: string,
  recipientDeviceId: string,
  conversationId: string,
  nonceB64: string,
  mid: string,
): Uint8Array<ArrayBuffer> {
  return utf8(
    [VERSION, senderUserId, senderDeviceId, recipientUserId, recipientDeviceId, conversationId || "", nonceB64, mid || ""].join("|"),
  );
}

function newMid(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch (_) { }
  return b64enc(crypto.getRandomValues(new Uint8Array(16)));
}

// Forced-downgrade / plaintext-injection guard. Once a conversation has carried
// an authenticated encrypted message (sent or received), it is pinned E2EE
// (persisted in IndexedDB). A malicious server then cannot inject a PLAINTEXT
// text message attributed to a peer — the client rejects plaintext text in a
// pinned conversation. TOFU semantics: the only undefended window is before the
// conversation has ever had a single E2EE message (legacy/transition).
const convE2EEPinned = new Set<string>(); // in-memory hot cache of the persisted pin
const convE2EENegCache = new Set<string>(); // confirmed-not-pinned (avoids per-message IDB reads on legacy convs)
// B2 — in-memory hot cache of each pinned conversation's pinnedAt anchor (the
// server createdAt of the first encrypted message). `undefined` = not loaded
// yet; `null` = pinned but no anchor recorded (legacy client → fail-open).
const convPinnedAt = new Map<string, string | number | null>();
async function pinConvE2EE(conversationId: string, pinnedAt?: string | number | null): Promise<void> {
  if (!conversationId) return;
  // Already pinned in this session — but still backfill the anchor if we now
  // have one and didn't before (setConvE2EE never overwrites an existing one).
  if (convE2EEPinned.has(conversationId)) {
    if (pinnedAt != null && convPinnedAt.get(conversationId) == null) {
      convPinnedAt.set(conversationId, pinnedAt);
      try { await signalStore.setConvE2EE(conversationId, pinnedAt); } catch (_) { }
    }
    return;
  }
  convE2EEPinned.add(conversationId);
  convE2EENegCache.delete(conversationId);
  if (pinnedAt != null) convPinnedAt.set(conversationId, pinnedAt);
  try { await signalStore.setConvE2EE(conversationId, pinnedAt); } catch (_) { }
}
export async function isConvE2EERequired(conversationId: string): Promise<boolean> {
  if (!conversationId) return false;
  if (convE2EEPinned.has(conversationId)) return true;
  if (convE2EENegCache.has(conversationId)) return false;
  let pinned = false;
  try { pinned = await signalStore.getConvE2EE(conversationId); } catch (_) { }
  if (pinned) convE2EEPinned.add(conversationId);
  else convE2EENegCache.add(conversationId);
  return pinned;
}
// B2 — the pinnedAt anchor for a pinned conversation, or null if the conversation
// is pinned but has no recorded anchor (older client). Reads through to IndexedDB
// once, then caches. Returns null for unpinned conversations too (callers gate on
// isConvE2EERequired first).
async function getConvPinnedAt(conversationId: string): Promise<string | number | null> {
  if (!conversationId) return null;
  const cached = convPinnedAt.get(conversationId);
  if (cached !== undefined) return cached;
  let anchor: string | number | null = null;
  try { anchor = await signalStore.getConvPinnedAt(conversationId); } catch (_) { }
  convPinnedAt.set(conversationId, anchor);
  return anchor;
}
// B2 — is `msgCreatedAt` STRICTLY newer than the pin anchor? Both are server
// createdAt values (string or epoch). Returns false (→ EXEMPT, render verbatim)
// when the anchor is missing/unparseable (fail-open for readability) or when the
// message timestamp is missing/unparseable (can't prove it's post-pin → don't
// reject real history). Returns true (→ REJECT) only when we can positively show
// the plaintext arrived AFTER the cutover. A message exactly AT the anchor is the
// pinning message's own moment and is treated as not-newer (exempt).
function toEpoch(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
function isNewerThanPin(msgCreatedAt: any, pinnedAt: string | number | null): boolean {
  const pin = toEpoch(pinnedAt);
  if (pin == null) return false; // no/invalid anchor → exempt (fail-open)
  const msg = toEpoch(msgCreatedAt);
  if (msg == null) return false; // unknown msg time → can't prove post-pin → exempt
  return msg > pin;
}

// Replay guard: maps an AEAD-authenticated message id → the server message id
// it was first seen under. A repeated mid under a DIFFERENT server id means the
// envelope was re-injected (replay); a repeat under the SAME id is just
// re-decryption (pagination/jump) and is allowed.
//
// PERSISTED to IndexedDB (signalStore.replayLog) so a page reload / cold start
// cannot reset the seen-set and let the server replay an old envelope. The
// in-memory map is a hot fast-path on top of the persistent store; bounded to
// 5000 entries (eviction policy: oldest first).
const seenMid = new Map<string, string>();
async function replayCheck(mid: string, serverMsgId: string): Promise<"ok" | "replay"> {
  if (!mid) return "ok";
  // Memory fast-path: same-conversation pagination during this page session
  // never touches IndexedDB.
  const hot = seenMid.get(mid);
  if (hot) return hot !== serverMsgId ? "replay" : "ok";
  // Cold path: check persistent log (covers reload / cross-tab).
  try {
    const cold = await signalStore.getReplaySeen(mid);
    if (cold && cold !== serverMsgId) return "replay";
    if (!cold) await signalStore.putReplaySeen(mid, serverMsgId);
  } catch (_) {
    // IndexedDB failure must not block decrypt; fall through to memory-only.
  }
  seenMid.set(mid, serverMsgId);
  if (seenMid.size > 5000) {
    let n = 0;
    for (const k of seenMid.keys()) { seenMid.delete(k); if (++n >= 1000) break; }
  }
  return "ok";
}

// ECDH(priv, pub) -> HKDF-SHA-256 -> AES-GCM-256 key. Salt = ephemeral pub bytes
// (independent of the GCM IV); info = a fixed protocol label.
async function deriveAesKey(priv: CryptoKey, pub: CryptoKey, saltRaw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: saltRaw, info: utf8(VERSION + "|hkdf") },
    hk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function ecdhBits(priv: CryptoKey, pub: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
}

// Forward-secret key: combine the identity-DH and the one-time-prekey-DH (X3DH
// style) so a message also depends on an OPK whose private half is destroyed
// after decryption — long-term identity-key theft alone can no longer recover it.
// `bIK` = ephemeral×identity, `bOPK` = ephemeral×one-time-prekey (same order both sides).
async function aesFromTwo(bIK: Uint8Array, bOPK: Uint8Array, saltRaw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const cat = new Uint8Array(bIK.length + bOPK.length);
  cat.set(bIK, 0);
  cat.set(bOPK, bIK.length);
  const hk = await crypto.subtle.importKey("raw", cat, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: saltRaw, info: utf8(VERSION + "|hkdf|x3dh") },
    hk,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ------------------------------------------------------------------
// Init / device enrollment
// ------------------------------------------------------------------

// Single-flight guard. React StrictMode double-invokes effects, and a login
// immediately after a session-restore can overlap — two concurrent initE2EE runs
// would BOTH see no identity key, both enter the enroll branch, and both mint a
// DIFFERENT random device id (last-writer-wins on e2ee_device_id), producing two
// server device rows and stranding the user on a pending/orphan device. Coalesce
// concurrent same-user calls into one run; serialize across tabs with the Web
// Locks API (a second tab then sees the enrolled device and skips minting).
let _initInFlight: Promise<void> | null = null;
let _initInFlightUser: string | null = null;
// Module-level fallback for the owner-reset reload guard (used when sessionStorage
// is unavailable, e.g. hardened/private-mode browsers — prevents a reload loop).
let _ownerResetReloaded = false;

// True once an init ran to completion this page session. Until then a decrypt
// can't trust a "no envelope for this device" verdict (it may simply not know
// its own device id yet), so those conversations are remembered and re-decrypted
// the moment init lands instead of sitting on the pending placeholder.
let _initOk = false;
const notReadyConvs = new Set<string>();
// A FAILED init used to be final for the whole page session ("heals on the next
// init" — but nothing ever ran one until a manual reload), so every encrypted
// message stayed on the placeholder. Retry in the background with backoff.
const INIT_RETRY_MS = [5000, 15000, 45000, 120000, 300000];
let _initRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _initRetryCount = 0;
// Who the current app session belongs to (null after logout) — a pending retry
// must never run for a user who has since signed out or been replaced.
let _sessionUser: string | null = null;

export async function initE2EE(token: string, userId: string): Promise<void> {
  if (_initInFlight && _initInFlightUser === userId) return _initInFlight;
  _sessionUser = userId;
  const locks =
    typeof navigator !== "undefined" ? (navigator as any).locks : null;
  const run: Promise<void> =
    locks && locks.request
      ? locks.request("e2ee-init:" + userId, () => _initE2EEImpl(token, userId))
      : _initE2EEImpl(token, userId);
  _initInFlight = run;
  _initInFlightUser = userId;
  try {
    await run;
    _initRetryCount = 0;
    flushNotReadyConvs();
  } catch (e) {
    scheduleInitRetry(token, userId);
    throw e;
  } finally {
    if (_initInFlight === run) {
      _initInFlight = null;
      _initInFlightUser = null;
    }
  }
}

function scheduleInitRetry(token: string, userId: string): void {
  if (_initRetryTimer || _initRetryCount >= INIT_RETRY_MS.length) return;
  const delay = INIT_RETRY_MS[_initRetryCount++];
  _initRetryTimer = setTimeout(() => {
    _initRetryTimer = null;
    // The session may have ended or switched user while we waited.
    if (_sessionUser !== userId) return;
    // Prefer the live (possibly refreshed / device-bound) token over the stale one.
    void initE2EE(myToken || token, userId).catch(() => { });
  }, delay);
}

function cancelInitRetry(): void {
  if (_initRetryTimer) clearTimeout(_initRetryTimer);
  _initRetryTimer = null;
  _initRetryCount = 0;
  _sessionUser = null;
  _initOk = false;
  notReadyConvs.clear();
}

// Re-decrypt every conversation that was decrypted before init completed.
function flushNotReadyConvs(): void {
  if (!_initOk || !notReadyConvs.size) return;
  const ids = [...notReadyConvs];
  notReadyConvs.clear();
  try { onHistoryRestored && onHistoryRestored(ids); } catch (_) { }
}

// TRANSIENT decrypt misses (a key fetch that failed on a network blip) are not
// history gaps: nothing needs restoring, the same decrypt just has to run again.
// Debounced, and capped per conversation so a persistent failure can't loop.
const redecryptAttempts = new Map<string, number>();
const redecryptPending = new Set<string>();
let redecryptTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRedecrypt(conversationId: string | null | undefined): void {
  if (!conversationId) return;
  if ((redecryptAttempts.get(conversationId) || 0) >= 4) return;
  redecryptPending.add(conversationId);
  if (redecryptTimer) return;
  redecryptTimer = setTimeout(() => {
    redecryptTimer = null;
    const ids = [...redecryptPending];
    redecryptPending.clear();
    ids.forEach((c) => redecryptAttempts.set(c, (redecryptAttempts.get(c) || 0) + 1));
    try { onHistoryRestored && onHistoryRestored(ids); } catch (_) { }
  }, 5000);
}

// Make sure a decrypt knows WHO it is before judging a message unreadable. Waits
// (bounded) for an in-flight init, then falls back to the persisted identity so
// a failed/slow init can't turn every row into "no envelope for this device".
async function ensureDecryptReady(): Promise<void> {
  if (_initInFlight) {
    try {
      await Promise.race([
        _initInFlight,
        new Promise((r) => setTimeout(r, 15000)),
      ]);
    } catch (_) { /* init failed — fall through to the persisted identity */ }
  }
  if (!myDeviceId) {
    try { myDeviceId = localStorage.getItem("e2ee_device_id"); } catch (_) { }
  }
  if (!myUserId) {
    try {
      await signalStore.init();
      myUserId = (await signalStore.getDeviceOwner()) || null;
    } catch (_) { }
  }
}

async function _initE2EEImpl(token: string, userId: string): Promise<void> {
  if (!isE2EEDecryptEnabled()) return;
  await signalStore.init();
  myUserId = userId;

  // Same-device user switch: if a DIFFERENT user previously owned this browser's
  // E2EE store, wipe their material (cached plaintext / sessions / ratchet) and
  // drop the device identity so the mint branch below re-creates keys for the
  // new user. A SAME-USER re-login keeps everything → seamless own-history read.
  const prevOwner = await signalStore.getDeviceOwner();
  if (prevOwner && prevOwner !== userId) {
    await signalStore.wipeForUserSwitch();
    // The desktop keychain copy of the backup secret belongs to the PREVIOUS
    // user — it is tagged with their id and could never be applied here, but a
    // switch must leave nothing of theirs behind.
    try { await keychainClearSecret(); } catch (_) { }
    try { localStorage.removeItem("e2ee_device_id"); } catch (_) { }
    try { localStorage.removeItem("e2ee_device_registered"); } catch (_) { }
    _deviceRegisteredThisSession = false;
  }
  await signalStore.putDeviceOwner(userId);

  let registrationId = await signalStore.getLocalRegistrationId();
  let pair = (await signalStore.getIdentityKeyPair()) as CryptoKeyPair | null;
  let signPair = (await signalStore.getSigningKeyPair()) as CryptoKeyPair | null;
  // Double Ratchet Phase 1 — initial DH keypair (extractable JWK, must be
  // round-trippable through IndexedDB because the ratchet state is serialised).
  let ratchetInit = await signalStore.getRatchetInitialKeyPair();

  // Legacy-decrypt-only mode (E2EE_ENABLED=false): a fresh device has nothing to
  // decrypt, and minting+publishing keys while encryption is globally OFF is
  // wrong. So new-device key generation + server registration runs ONLY under
  // full E2EE. Below, init still loads any EXISTING IndexedDB keys + sets myToken.
  if (isE2EEEnabled() && (!registrationId || !pair || !(pair as any).privateKey)) {
    // Long-term identity ECDH keypair — private NON-EXTRACTABLE.
    pair = (await crypto.subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
    // B2 — sender authentication ECDSA keypair, separate from the ECDH identity
    // key (ECDH keys cannot sign). Private NON-EXTRACTABLE.
    signPair = (await crypto.subtle.generateKey(ECDSA, false, ["sign", "verify"])) as CryptoKeyPair;
    registrationId = Math.floor(Math.random() * 16383) + 1;
    await signalStore.putIdentityKeyPair(pair); // structured clone keeps the non-extractable key
    await signalStore.putSigningKeyPair(signPair);
    await signalStore.putLocalRegistrationId(registrationId);

    const idPubRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
    const signPubRaw = await crypto.subtle.exportKey("raw", signPair.publicKey);
    let deviceId = Math.floor(Math.random() * 1_000_000);

    // One-time prekeys for forward secrecy (V4): each is mixed into one message's
    // key, then its private half is deleted after decrypt. Stored locally under a
    // STRING keyId so it matches the bundle's VARCHAR key_id on the way back.
    const preKeys: any[] = [];
    for (let i = 0; i < 100; i++) {
      const pk = (await crypto.subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
      const keyId = String(i + 1);
      await signalStore.storePreKey(keyId, pk as any);
      preKeys.push({ keyId, publicKey: b64enc(await crypto.subtle.exportKey("raw", pk.publicKey)) });
    }

    // Double Ratchet initial keypair — extractable so the priv can be
    // serialised into ratchet session state. The public is published to the
    // bundle so peers can seed the ratchet's first DH ratchet step.
    const ratchetKp = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
    const ratchetPriv = await crypto.subtle.exportKey("jwk", ratchetKp.privateKey);
    const ratchetPubB64 = b64enc(await crypto.subtle.exportKey("raw", ratchetKp.publicKey));
    await signalStore.putRatchetInitialKeyPair({ priv: ratchetPriv, pubB64: ratchetPubB64 });
    ratchetInit = { priv: ratchetPriv, pubB64: ratchetPubB64 };

    // The id is a random number shared across every account, and the server
    // refuses (409) one that already belongs to ANOTHER user rather than
    // overwriting their device row. Retrying the same id can never succeed,
    // and a device that ends up with keys but no server row reads nothing —
    // so on a conflict mint a fresh id and register again (bounded).
    for (let attempt = 0; ; attempt++) {
      try {
        await withRetry(() =>
          api.e2eeRegisterDevice(token, {
            deviceId: String(deviceId),
            identityKey: b64enc(idPubRaw),
            signingKey: b64enc(signPubRaw), // B2
            ratchetInitialKey: ratchetPubB64, // Double Ratchet Phase 1
            signedPreKey: null,
          }),
        );
        break;
      } catch (e: any) {
        if (!(e && e.status === 409) || attempt >= 4) throw e;
        deviceId = Math.floor(Math.random() * 1_000_000);
      }
    }
    // Persist the device id ONLY after a confirmed server row exists. Writing it
    // before register (the old behavior) left an ORPHAN id in localStorage if
    // register threw — the enroll guard is then false on the next init (keys
    // exist), so the orphan id gets sent into the token and the self-heal guard
    // has to wipe/reload to recover. Registering first makes the next init cleanly
    // re-mint instead.
    // Guarded like every sibling write in this file: a storage write that throws
    // (hardened/private browser profiles can reject it) must not abort
    // enrollment here, which would skip self-approve AND prekey publish and
    // leave the device half-registered.
    try { localStorage.setItem("e2ee_device_id", String(deviceId)); } catch (_) { }
    try {
      await withRetry(() => api.e2eeApproveDevice(token, String(deviceId)), 3, 500);
    } catch (_) { /* non-fatal */ }
    await api.e2eePublishPreKeys(token, String(deviceId), preKeys);
    // Mark registration as confirmed (both session-scoped and persisted).
    _deviceRegisteredThisSession = true;
    _freshEnrollThisSession = true;
    try { localStorage.setItem("e2ee_device_registered", "1"); } catch (_) { }
  } else if (isE2EEEnabled() && (!signPair || !(signPair as any).privateKey)) {
    // Migration path: this device enrolled BEFORE B2 shipped — it has an ECDH
    // identity key but no signing key. Generate one, persist it, and re-register
    // so the server learns the new signing pubkey (registerDevice upsert keeps
    // `trusted` unchanged, so an already-approved device stays approved).
    signPair = (await crypto.subtle.generateKey(ECDSA, false, ["sign", "verify"])) as CryptoKeyPair;
    await signalStore.putSigningKeyPair(signPair);
    const signPubRaw = await crypto.subtle.exportKey("raw", signPair.publicKey);
    const deviceId = localStorage.getItem("e2ee_device_id");
    if (deviceId) {
      const idPubRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
      try {
        await api.e2eeRegisterDevice(token, {
          deviceId,
          identityKey: b64enc(idPubRaw),
          signingKey: b64enc(signPubRaw),
          signedPreKey: null,
        });
      } catch (_) { /* best-effort: signing will still happen locally */ }
    }
  }

  // Double Ratchet Phase 1 — independent migration step. Runs whether or not
  // the B2 migration ran above. Devices that pre-dated this column get a fresh
  // initial DH keypair on first init after the upgrade, and re-register so the
  // server learns the new public (registerDevice upsert keeps `trusted` and
  // `signing_key` unchanged via COALESCE).
  if (isE2EEEnabled() && !ratchetInit) {
    const ratchetKp = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
    const ratchetPriv = await crypto.subtle.exportKey("jwk", ratchetKp.privateKey);
    const ratchetPubB64 = b64enc(await crypto.subtle.exportKey("raw", ratchetKp.publicKey));
    await signalStore.putRatchetInitialKeyPair({ priv: ratchetPriv, pubB64: ratchetPubB64 });
    ratchetInit = { priv: ratchetPriv, pubB64: ratchetPubB64 };
    const deviceId = localStorage.getItem("e2ee_device_id");
    if (deviceId && pair) {
      try {
        const idPubRaw = await crypto.subtle.exportKey("raw", pair.publicKey);
        const signPubRaw = signPair ? await crypto.subtle.exportKey("raw", signPair.publicKey) : null;
        await api.e2eeRegisterDevice(token, {
          deviceId,
          identityKey: b64enc(idPubRaw),
          signingKey: signPubRaw ? b64enc(signPubRaw) : null,
          ratchetInitialKey: ratchetPubB64,
          signedPreKey: null,
        });
      } catch (_) { /* best-effort */ }
    }
  }

  // Self-heal enrollment if not yet confirmed this session. The session flag
  // resets on every page load, so a server-side DB wipe (device wiped without
  // clearing localStorage) is caught on next load — the upsert re-adds the
  // device. This block ALSO repairs a device that a PRIOR init left half-enrolled
  // (registered but not approved) after a flaky/401 first login: such a device
  // sits at trusted=0 and is EXCLUDED from every sender's key fan-out, so the
  // user can SEND but never RECEIVE — silently and permanently, because the
  // key-gen block above is skipped once local keys exist. The fix here is
  // re-register + RELIABLY self-approve (not swallowed).
  //
  // We do NOT regenerate/republish one-time prekeys here. The local prekeys live
  // in IndexedDB; the SERVER copy is just the public halves. If we generated new
  // privkeys, we'd overwrite the IndexedDB slots BEFORE the publish; any failure
  // (404, network) would leave local privkeys out of sync with server pubkeys
  // and DECRYPTION would silently fail on every future message. If the server
  // shows opk=0 (publish died during original enrollment), peers using OPK
  // simply fall back to plain-ECIES wrapping — slightly less forward secrecy on
  // the first message, but encryption + decryption still work.
  if (isE2EEEnabled() && !_deviceRegisteredThisSession) {
    const rDeviceId = localStorage.getItem("e2ee_device_id");
    if (rDeviceId && pair) {
      // GUARD: if the localStorage deviceId doesn't actually belong to the user
      // we're logging in as (cross-user contamination from prior testing on the
      // same browser, or a stale id from a server-side wipe whose new device row
      // is owned by someone else), DO NOT re-register/approve under that id —
      // the server would 404/403 every publishPreKeys/history-sync call and the
      // user would silently never receive E2EE messages. Wipe the local crypto
      // state and reload so the enroll block above mints a fresh, owned device.
      let mismatch = false;
      try {
        // Only trust a SUCCESSFUL list (an array). A network error returns null →
        // we must NOT treat that as "not mine" (that would wipe a good device on a
        // blip); leave mismatch=false and retry next init.
        const mine = (await api.e2eeDevices(token).catch(() => null)) as any[] | null;
        if (Array.isArray(mine) && !mine.some((d) => String(d.id) === String(rDeviceId))) {
          // The server doesn't list our device. This used to mean "wipe everything
          // and start over" — which is exactly how a DEPLOYMENT that lost or
          // re-created e2ee_devices (a restored/rebuilt database, a reset table)
          // turned every message on a perfectly healthy device into "Message
          // unavailable on this device": the SAME keys were thrown away, so every
          // envelope ever sealed to them became unreadable, and the device came
          // back with only what its (possibly stale) backup held. This device
          // still HOLDS its keys, so first put the row back under the same id and
          // the same identity key (registerDevice is an upsert; the server refuses
          // an id that belongs to another account). Only if that fails do we
          // re-mint — and even then the plaintext cache and backup key are kept.
          let reclaimed = false;
          try {
            const idPubB64 = b64enc(await crypto.subtle.exportKey("raw", (pair as CryptoKeyPair).publicKey));
            const signPubRaw = signPair
              ? await crypto.subtle.exportKey("raw", (signPair as CryptoKeyPair).publicKey)
              : null;
            const row: any = await withRetry(() =>
              api.e2eeRegisterDevice(token, {
                deviceId: rDeviceId,
                identityKey: idPubB64,
                signingKey: signPubRaw ? b64enc(signPubRaw) : null,
                ratchetInitialKey: ratchetInit?.pubB64 || null,
                signedPreKey: null,
              }),
            );
            reclaimed =
              !!row &&
              String(row.userId || "") === String(userId) &&
              String(row.identityKey || "") === idPubB64;
            if (reclaimed) {
              try { await withRetry(() => api.e2eeApproveDevice(token, rDeviceId), 3, 500); } catch (_) { }
              // The server's copy of our one-time prekeys went with the row —
              // republish so peers keep forward secrecy on their next send.
              try { await republishAllPreKeys(token, rDeviceId); } catch (_) { }
              console.info("[e2ee] re-registered this device under its existing id (server had lost its row)");
              captureIssue("e2ee", "E2EE: device row was missing server-side — re-registered same identity (no key loss)", { kind: "device-reclaimed" });
            }
          } catch (_) { /* fall through to the mismatch path */ }
          if (!reclaimed) mismatch = true;
        }
      } catch { /* network blip → don't wipe, retry next init */ }
      if (mismatch) {
        // Re-mint the IDENTITY only. Decrypted history, the backup key and the
        // per-conversation E2EE pins belong to the user, not to the key pair —
        // wiping them (the old behaviour) is what made every earlier message
        // vanish behind a placeholder after a same-device re-enrolment.
        try { await signalStore.wipeIdentityOnly(); } catch { }
        try {
          localStorage.removeItem("e2ee_device_id");
          localStorage.removeItem("e2ee_device_registered");
        } catch { }
        // Recover by reloading so the enroll block re-mints a fresh, owned device
        // (the in-memory `pair`/`signPair` are now stale — IndexedDB is empty).
        // ONE-SHOT per tab session: if enrollment somehow still produces a
        // mismatch after one reload, fall through WITHOUT reloading so we can
        // never spin in a reload loop (a stuck device beats an unusable app).
        let reloadedOnce = _ownerResetReloaded;
        try { if (sessionStorage.getItem("e2ee_owner_reset") === "1") reloadedOnce = true; } catch { }
        if (!reloadedOnce) {
          _ownerResetReloaded = true; // survives even if sessionStorage throws
          try { sessionStorage.setItem("e2ee_owner_reset", "1"); } catch { }
          try { location.reload(); } catch { }
        }
        return; // stale in-memory keys — bail; fresh enroll fires on next init
      }
      // Device is confirmed ours — clear the one-shot reload guard so a future
      // legitimate user-switch on this tab can self-heal again.
      try { sessionStorage.removeItem("e2ee_owner_reset"); } catch { }
      try {
        const idPubRaw = await crypto.subtle.exportKey("raw", (pair as CryptoKeyPair).publicKey);
        const signPubRaw = signPair
          ? await crypto.subtle.exportKey("raw", (signPair as CryptoKeyPair).publicKey)
          : null;
        await withRetry(() =>
          api.e2eeRegisterDevice(token, {
            deviceId: rDeviceId,
            identityKey: b64enc(idPubRaw),
            signingKey: signPubRaw ? b64enc(signPubRaw) : null,
            ratchetInitialKey: ratchetInit?.pubB64 || null,
            signedPreKey: null,
          }),
        );
        // Self-approve so a non-first device leaves PENDING (trusted=false) and
        // rejoins the fan-out. NOT swallowed: a failure must leave the flags below
        // UNSET so the next init retries — the old silent catch is exactly what
        // stranded devices at trusted=0 forever.
        await api.e2eeApproveDevice(token, rDeviceId);
        _deviceRegisteredThisSession = true;
        localStorage.setItem("e2ee_device_registered", "1");
      } catch (_) { /* backend still unreachable — will retry on next initE2EE */ }
    }
  }

  myDeviceId = localStorage.getItem("e2ee_device_id");
  myToken = token; // ALWAYS — protected file-decrypt fetch needs it even on a key-less device
  // DEVICE-BIND THE TOKEN. A fresh device signs in BEFORE its E2EE device id
  // exists, so the session token carries no deviceId claim — and the server
  // (by design) silently no-ops every /history-sync fetch/upload/ack for an
  // unbound token. That is THE reason a brand-new device sat on
  // "[Encrypted — not available on this device]" until some later login:
  // Mechanism A was built, but this first session could never fetch its
  // bundles. Rotate the token now (the refresh path re-mints WITH deviceId)
  // so the restore below runs bound, in the exact session that needs it.
  if (myDeviceId && isE2EEEnabled()) {
    try {
      const fresh = await api.rebindDeviceToken(token);
      if (fresh) {
        token = fresh;
        myToken = fresh;
      }
    } catch (_) {
      /* keep the unbound token — the next login/refresh binds it */
    }
  }
  if (pair && (pair as CryptoKeyPair).privateKey) {
    myIdentityPriv = (pair as CryptoKeyPair).privateKey;
    if (signPair && (signPair as CryptoKeyPair).privateKey) mySigningPriv = (signPair as CryptoKeyPair).privateKey;
    // Cache my OWN identity public key so group-key fan-out can wrap the epoch key
    // to this device too (needed to read my own group messages after a reload).
    try {
      const myPub = (pair as CryptoKeyPair).publicKey;
      if (myPub && myUserId && myDeviceId) pubKeyCache.set(myUserId + ":" + myDeviceId, myPub);
      if (myPub) myIdentityPubB64 = b64enc(await crypto.subtle.exportKey("raw", myPub));
      // Cache my OWN ECDSA verify key too (we never verify our own messages, but
      // keeping it here keeps the shape symmetric with peer entries).
      if (signPair && myUserId && myDeviceId) {
        signPubCache.set(myUserId + ":" + myDeviceId, signPair.publicKey);
      }
    } catch (_) { }
  }

  // AUTOMATIC recovery — every source this device can open WITHOUT asking the
  // user: its cached backup key, the desktop-keychain copy of the backup secret
  // (survives a reinstall / cleared app data), any sibling sync bundle waiting on
  // the relay, and — while gaps remain — a live ask to the user's other devices.
  // Awaited so the first thread render already sees restored plaintext wherever
  // a key could be found; the published recovery state drives the UI for the
  // rest (a calm "restoring" row, never a dead-end or a retry button).
  try {
    await autoRecoverHistory({ force: true, reason: "init" });
  } catch (_) { }
  // Answer the re-delivery asks other members' devices stored while this
  // device was offline (their history depends on it) — now, and periodically.
  void processPendingRedeliveries(myToken).catch(() => { });
  startPendingRedeliveryPolling();

  void (async () => {
    try {
      const others = await ensureSessionsForUser(myToken, userId);
      await pushHistoryToSiblings(myToken, others);
    } catch (_) { }
  })();

  // (A fresh enrolment's sibling ask now runs inside autoRecoverHistory.)
  const tokenForBackup = myToken;
  void (async () => {
    await refreshRecoveryBackup(tokenForBackup).catch(() => { });
    // No backup at all yet (SSO-only account) → create one silently; then make
    // sure the account wrap exists so every other device opens it automatically.
    await ensureAutoBackup(tokenForBackup).catch(() => { });
    await ensureAccountWrap(tokenForBackup).catch(() => { });
    // Then the migration sweep, once the caches above are warm: ask for every
    // old message this device still cannot open.
    await auditUnreadableHistory(tokenForBackup).catch(() => { });
  })();
  _initOk = true;
}

// Publish the public halves of EVERY one-time prekey still held locally. Used
// when the server's copy is known to be gone (the device row was recreated).
// The private halves stay exactly where they are, so nothing can desync.
async function republishAllPreKeys(token: string, deviceId: string): Promise<void> {
  const keys: any[] = [];
  const n = await signalStore.countPreKeys().catch(() => 0);
  if (!n) return;
  for (let i = 1; i <= 1000 && keys.length < n; i++) {
    const keyId = String(i);
    const kp: any = await signalStore.loadPreKey(keyId).catch(() => null);
    if (!kp || !kp.publicKey) continue;
    keys.push({ keyId, publicKey: b64enc(await crypto.subtle.exportKey("raw", kp.publicKey)) });
  }
  if (keys.length) await api.e2eePublishPreKeys(token, deviceId, keys);
}

async function getMyPriv(): Promise<CryptoKey> {
  if (myIdentityPriv) return myIdentityPriv;
  const pair = (await signalStore.getIdentityKeyPair()) as CryptoKeyPair | null;
  if (!pair || !pair.privateKey) throw new Error("E2EE not initialized on this device");
  myIdentityPriv = pair.privateKey;
  return myIdentityPriv;
}

// B2 — fetch (lazily, with TOFU pinning) the ECDSA verify key for a peer
// device, used to verify the signature on an incoming envelope. Returns null
// only when the peer's device has not yet published a signing key (legacy
// pre-B2 device); callers treat null as "unverified — accept with warning"
// during the migration window, then tighten to fail-closed.
async function getPeerSignKey(remoteUserId: string, remoteDeviceId: string): Promise<CryptoKey | null> {
  const key = remoteUserId + ":" + remoteDeviceId;
  const cached = signPubCache.get(key);
  if (cached) return cached;
  // Try the pinned trusted identity (no network) first.
  try {
    const pinned = await signalStore.loadTrustedIdentity(key);
    if (pinned && pinned.signingPubB64) {
      const k = await importSignPub(pinned.signingPubB64);
      signPubCache.set(key, k);
      return k;
    }
  } catch (_) { }
  // Fall back to a bundle fetch (which also pins on first sight).
  if (myToken) {
    try { await ensureSessionsForUser(myToken, remoteUserId); } catch (_) { }
    const k = signPubCache.get(key);
    if (k) return k;
  }
  return null;
}

// ------------------------------------------------------------------
// Peer key discovery + TOFU
// ------------------------------------------------------------------
export async function ensureSessionsForUser(token: string, remoteUserId: string): Promise<string[]> {
  if (!isE2EEEnabled()) return [];
  const bundles = await api.e2eeBundleFor(token, remoteUserId);
  // Record how many device bundles the peer actually published, and reset the
  // per-user error flag for this establishment pass. encryptForUser reads both to
  // decide whether an empty device list means "peer has no device" (0 bundles →
  // legitimate plaintext) or "establishment failed" (bundles > 0 and/or errored →
  // fail-closed + retry). Signature stays Promise<string[]> so no caller ripples.
  lastEstablishBundleCount.set(remoteUserId, bundles ? bundles.length : 0);
  lastEstablishErrored.set(remoteUserId, false);
  if (!bundles || bundles.length === 0) return [];

  const devices: string[] = [];
  for (const b of bundles) {
    const remoteDeviceId = String(b.id);
    if (remoteUserId === myUserId && remoteDeviceId === String(myDeviceId)) continue; // skip my own device
    if (!b.identityKey) continue;
    const key = remoteUserId + ":" + remoteDeviceId;

    // TOFU: pin on first sight; fail-closed if the pinned key changed (MITM).
    // B2 — the ECDSA signing key is pinned alongside the identity key; a change
    // to EITHER is treated as a re-trust event (the server can't substitute one
    // and not the other without being caught).
    try {
      const pinned = await signalStore.loadTrustedIdentity(key);
      const peerSign = b.signingKey || null;
      if (!pinned) {
        await signalStore.storeTrustedIdentity(key, b.identityKey, undefined, peerSign || undefined);
      } else if (
        pinned.identityPubB64 !== b.identityKey ||
        (peerSign && pinned.signingPubB64 && pinned.signingPubB64 !== peerSign)
      ) {
        changedIdentities.add(key);
        console.warn("[E2EE] identity/signing key changed for", key, "- refusing (verify safety number)");
        continue; // do NOT trust/encrypt to a changed key
      } else {
        // Backfill: a device pinned before B2 has no signingPubB64 — accept the
        // first one the server returns (TOFU-on-augmentation; same trust posture
        // as first-sight). Recorded so a later mismatch is caught.
        if (peerSign && !pinned.signingPubB64) {
          await signalStore.storeTrustedIdentity(key, b.identityKey, pinned.fingerprint, peerSign);
        }
        changedIdentities.delete(key);
      }
      const pub = await importPub(b.identityKey);
      pubKeyCache.set(key, pub);
      // Cache the ECDSA verify key (if the peer published one). Until a peer's
      // device publishes one, its messages cannot be sender-verified.
      if (peerSign) {
        try { signPubCache.set(key, await importSignPub(peerSign)); } catch (_) { }
      }
      // Cache the device's one-time prekey for forward secrecy (consumed on use).
      if (b.oneTimePreKey && b.oneTimePreKey.keyId && b.oneTimePreKey.publicKey) {
        opkCache.set(key, { keyId: String(b.oneTimePreKey.keyId), pubB64: b.oneTimePreKey.publicKey });
      } else {
        opkCache.delete(key);
      }
      devices.push(remoteDeviceId);
    } catch (e) {
      // A returned device failed to establish (key import / TOFU / IndexedDB
      // write error). Flag it so encryptForUser fails CLOSED instead of treating
      // the resulting short device list as "peer has no device" and downgrading
      // to plaintext. This is exactly the FK-cascade storage-failure path that
      // used to mint silent plaintext in an E2EE conversation.
      lastEstablishErrored.set(remoteUserId, true);
      console.error("[E2EE] failed to import/verify peer key", key, e);
    }
  }
  return devices;
}

// ------------------------------------------------------------------
// Encrypt
// ------------------------------------------------------------------
async function encryptToDevice(
  recipientUserId: string,
  recipientDeviceId: string,
  plaintext: string,
  conversationId: string,
  opts?: { token?: string; useOpk?: boolean },
): Promise<any> {
  const cacheKey = recipientUserId + ":" + recipientDeviceId;
  const peerPub = pubKeyCache.get(cacheKey);
  if (!peerPub) throw new Error("no public key for recipient device");
  // Ephemeral keypair — public must be exportable; private is discarded after use.
  const eph = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const epkRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceB64 = b64enc(nonce);
  const mid = newMid();

  // Forward secrecy: if requested AND a one-time prekey is available, atomically
  // CONSUME it and mix its DH into the key. If the claim is lost (race/exhausted),
  // fall back to identity-only (still confidential vs server, just not FS).
  let aesKey: CryptoKey | null = null;
  let opkId: string | null = null;
  if (opts?.useOpk && opts.token) {
    const opk = opkCache.get(cacheKey);
    if (opk) {
      let claimed = false;
      try {
        const r: any = await api.e2eeConsumePreKey(opts.token, recipientDeviceId, opk.keyId);
        claimed = !!(r && r.claimed);
      } catch (_) { claimed = false; }
      if (claimed) {
        try {
          const opkPub = await importPub(opk.pubB64);
          const bIK = await ecdhBits(eph.privateKey, peerPub);
          const bOPK = await ecdhBits(eph.privateKey, opkPub);
          aesKey = await aesFromTwo(bIK, bOPK, epkRaw);
          opkId = opk.keyId;
        } catch (_) { aesKey = null; }
      }
      opkCache.delete(cacheKey); // never reuse a fetched OPK
    }
  }
  if (!aesKey) aesKey = await deriveAesKey(eph.privateKey, peerPub, epkRaw);

  const ad = aad(myUserId!, myDeviceId!, recipientUserId, recipientDeviceId, conversationId, nonceB64, mid);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ad },
    aesKey,
    utf8(plaintext),
  );
  // B2 — sign the AAD with our device's ECDSA key. The AAD binds the full
  // context (sender, recipient, conversation, nonce, mid); a valid signature
  // proves the envelope came from a device that holds our signing private key.
  const sig = await signAad(ad);
  return {
    type: 1,
    body: b64enc(utf8(JSON.stringify({ v: 1, epk: b64enc(epkRaw), iv: b64enc(iv), ct: b64enc(ct), n: nonceB64, mid, opk: opkId, sig }))),
  };
}

// Sentinel returned by encryptForUser ONLY for the progressive-rollout case
// where the recipient has ZERO published/trusted devices yet (they have not
// logged in since E2EE was flipped on). `null` means: "this peer is not set up
// for encryption yet — the caller MUST fall back to a normal plaintext send and
// MUST NOT pin the conversation E2EE." It is NOT returned for any failure that
// could be an attack (changed/untrusted identity / MITM) — those still THROW so
// the send stays fail-closed. See B1 below.
export async function encryptForUser(
  token: string,
  remoteUserId: string,
  plaintext: string,
  conversationId: string,
  opts?: { useOpk?: boolean; useRatchet?: boolean },
): Promise<any[] | null> {
  // FAIL-CLOSED: for an E2EE conversation, never return a value the caller can
  // treat as "send plaintext" UNLESS the peer genuinely has no E2EE device yet
  // (the documented `null` sentinel below). Throw on any condition that would
  // leave 0 envelopes for a peer who DOES have devices (changed identity / MITM).
  if (!isE2EEEnabled()) throw new Error("E2EE disabled");
  // Fetch the peer's device bundles AND my other devices' bundles CONCURRENTLY —
  // they are independent (different users, disjoint cache keys), so serializing
  // them just doubled the pre-send latency (each is an HTTP round-trip to the
  // remote DB). This halves the E2EE encryption delay before the socket emit.
  const [remoteDevices, myOtherDevices] = await Promise.all([
    ensureSessionsForUser(token, remoteUserId),
    remoteUserId === myUserId
      ? Promise.resolve([] as string[])
      : ensureSessionsForUser(token, myUserId!),
  ]);

  // B1 — progressive-rollout fallback. For a DM to ANOTHER user (not a self-note),
  // if that peer published ZERO trusted devices, they simply have not logged in
  // since E2EE was flipped on. Return the `null` sentinel so the caller sends
  // normal plaintext and does NOT pin the conversation. This MUST be checked
  // before the self-echo envelope (appended below for own re-read), which would
  // otherwise make envelopes.length === 1 and mask the not-set-up case.
  //   - hasIdentityChanged(remoteUserId): a present device's pinned identity
  //     CHANGED (MITM / re-trust). ensureSessionsForUser skipped it AND recorded
  //     it, so remoteDevices is empty — but this is an ATTACK, not not-set-up.
  //     Stay FAIL-CLOSED: throw.
  //   - Self-notes (remoteUserId === myUserId) never take this path: we always
  //     want to encrypt to our own devices, never plaintext-fallback to ourselves.
  if (remoteUserId !== myUserId && remoteDevices.length === 0) {
    if (hasIdentityChanged(remoteUserId)) {
      throw new Error("Recipient identity changed — refusing to send (verify safety number)");
    }
    // B2 — the empty device list means one of two very different things. Only the
    // FIRST is a legitimate reason to send plaintext:
    //   (1) the peer published ZERO devices → not enrolled yet → `null` sentinel
    //       (caller sends normal plaintext, does NOT pin the conversation).
    //   (2) the peer HAS devices but establishing sessions FAILED (a returned
    //       bundle errored on import/TOFU/IndexedDB — the FK-cascade storage bug),
    //       so the list is empty for a TRANSIENT reason. Sending plaintext here is
    //       exactly the silent downgrade that minted the hidden rows. FAIL CLOSED:
    //       throw a retryable error so the caller keeps the draft and the user can
    //       resend once key storage recovers — never emit plaintext to a peer who
    //       has E2EE devices.
    const bundleCount = lastEstablishBundleCount.get(remoteUserId) || 0;
    const errored = lastEstablishErrored.get(remoteUserId) === true;
    if (bundleCount > 0 || errored) {
      throw new Error("Couldn't set up encryption for this device yet — message not sent, please retry");
    }
    return null;
  }

  const useRatchet = !!opts?.useRatchet && isRatchetEnabled();
  // Pre-fetch bundle data for the ratchet path (identity pub + ratchetInitialKey per device).
  const bundleByDevice = new Map<string, { idPubB64: string; ratchetInitB64: string | null }>();
  if (useRatchet) {
    try {
      const bundles = await api.e2eeBundleFor(token, remoteUserId).catch(() => []);
      for (const b of bundles || []) {
        if (!b || !b.identityKey) continue;
        // Export the already-cached pub key to b64 (from pubKeyCache, populated by ensureSessionsForUser).
        try {
          const cached = pubKeyCache.get(remoteUserId + ":" + String(b.id));
          const idPubB64 = cached ? b64enc(await crypto.subtle.exportKey("raw", cached)) : b.identityKey;
          bundleByDevice.set(String(b.id), {
            idPubB64,
            ratchetInitB64: b.ratchetInitialKey || null,
          });
        } catch (_) {
          bundleByDevice.set(String(b.id), {
            idPubB64: b.identityKey,
            ratchetInitB64: b.ratchetInitialKey || null,
          });
        }
      }
    } catch (_) {
      // Fall through — individual device encryption will try ratchet and
      // fall back to ECIES when bundle data is unavailable.
    }
  }

  // Forward secrecy (one-time-prekey mixing) applies to TEXT DMs only. File-key
  // wraps pass useOpk=false so the attachment stays re-decryptable from server
  // ciphertext (its blob is not locally cached).
  const eopts = { token, useOpk: !!opts?.useOpk };
  // Encrypt to every recipient device CONCURRENTLY. With useOpk (text DMs) each
  // encryptToDevice does an HTTP one-time-prekey CONSUME round-trip; the old
  // sequential loops made N devices cost N SERIAL round-trips — the reason a plain
  // text message lagged 3-4s while an attachment (whose file-key wrap passes
  // useOpk=false, so no consume) sent instantly. Each device is independent (own
  // OPK, own cache key), so fanning them out is safe and cuts the delay to ~one
  // round-trip regardless of device count.
  const encryptRemote = async (d: string) => {
    if (useRatchet && bundleByDevice.has(d)) {
      const bi = bundleByDevice.get(d)!;
      try {
        const rtEnv = await encryptToDeviceRatchet(
          remoteUserId, d, bi.idPubB64, bi.ratchetInitB64,
          conversationId, plaintext, newMid(),
        );
        return { ...rtEnv, recipientId: remoteUserId, recipientDeviceId: d, senderDeviceId: myDeviceId };
      } catch (_) {
        // Ratchet failed (e.g. peer has no ratchetInitialKey in bundle) —
        // fall back to ECIES below.
      }
    }
    const env = await encryptToDevice(remoteUserId, d, plaintext, conversationId, eopts);
    return { ...env, recipientId: remoteUserId, recipientDeviceId: d, senderDeviceId: myDeviceId };
  };
  const encryptSelfOther = async (d: string) => {
    // Self-other-devices ALWAYS use ECIES (ratchet is per-peer, not self).
    const env = await encryptToDevice(myUserId!, d, plaintext, conversationId, eopts);
    return { ...env, recipientId: myUserId!, recipientDeviceId: d, senderDeviceId: myDeviceId };
  };
  const [remoteEnvs, selfEnvs] = await Promise.all([
    Promise.all(remoteDevices.map(encryptRemote)),
    Promise.all(myOtherDevices.map(encryptSelfOther)),
  ]);
  const envelopes: any[] = [...remoteEnvs, ...selfEnvs];
  // Always include MY OWN current device so I can re-read my own sent message
  // after a reload (the fan-out otherwise skips it). Identity-only (no one-time
  // prekey): the sender keeps a readable local copy of what they sent — the
  // RECIPIENT's envelope still gets forward secrecy. Also makes single-device
  // self-notes work (they would otherwise produce zero envelopes).
  // The self-echo used to be gated on my own public key ALREADY being in the
  // in-memory pubKeyCache. That cache is populated during initE2EE, so a send
  // that raced initialization — or any path where myDeviceId was assigned after
  // the key load — silently produced a message with NO envelope for its own
  // author. The sender could then never read what they had just sent: it
  // rendered as the pending placeholder forever, and on a single-device account
  // there is no other device to heal from, so "waiting to sync" never resolved.
  // The key is derivable locally (it is OUR identity keypair), so warm the cache
  // instead of skipping.
  if (myUserId && myDeviceId && !pubKeyCache.has(myUserId + ":" + myDeviceId)) {
    try {
      const pair = (await signalStore.getIdentityKeyPair()) as CryptoKeyPair | null;
      if (pair && pair.publicKey)
        pubKeyCache.set(myUserId + ":" + myDeviceId, pair.publicKey);
    } catch (_) {
      /* fall through to the guard below */
    }
  }
  if (myUserId && myDeviceId && pubKeyCache.has(myUserId + ":" + myDeviceId)) {
    const env = await encryptToDevice(myUserId, myDeviceId, plaintext, conversationId, { token, useOpk: false });
    envelopes.push({ ...env, recipientId: myUserId, recipientDeviceId: myDeviceId, senderDeviceId: myDeviceId });
  } else {
    // Never ship a message its own author cannot read. Failing the send is
    // recoverable (the composer keeps the text and the user retries); a sent
    // message that is permanently unreadable to the sender is not.
    throw new Error("Encryption isn't ready on this device yet — please try again.");
  }
  if (envelopes.length === 0) {
    // Fail-closed safety net. The B1 "peer not set up yet" case already returned
    // the null sentinel ABOVE (before the self-echo). Reaching here means we had
    // device(s) to encrypt to but produced no envelope (e.g. a self-note on a
    // device whose own key isn't published) — never silently downgrade.
    throw new Error("Recipient is not set up for encryption yet");
  }
  // Pin the conversation E2EE: we just encrypted to it, so any later plaintext
  // the server serves for it is a forced downgrade and must be rejected.
  await pinConvE2EE(conversationId);
  return envelopes;
}

// ------------------------------------------------------------------
// Decrypt
// ------------------------------------------------------------------
async function decryptEnvelope(
  senderUserId: string,
  senderDeviceId: string,
  bodyBase64: string,
  conversationId: string,
): Promise<{ text: string; mid: string; opk: string | null }> {
  const payload = JSON.parse(new TextDecoder().decode(b64dec(bodyBase64)));
  const epk = await importPub(payload.epk);
  const priv = await getMyPriv();
  const salt = b64dec(payload.epk);

  let aesKey: CryptoKey;
  if (payload.opk) {
    // Forward-secret message: needs the one-time prekey's private half.
    const opkPair = await signalStore.loadPreKey(payload.opk);
    if (!opkPair || !opkPair.privateKey) {
      // OPK already deleted after a prior decrypt (forward secrecy). The plaintext
      // lives only in the local cache; if we reached here the cache was cleared.
      throw Object.assign(new Error("forward-secret message no longer available"), { fsGone: true });
    }
    const bIK = await ecdhBits(priv, epk);
    const bOPK = await ecdhBits(opkPair.privateKey, epk);
    aesKey = await aesFromTwo(bIK, bOPK, salt);
  } else {
    aesKey = await deriveAesKey(priv, epk, salt);
  }

  const ad = aad(senderUserId, senderDeviceId, myUserId!, myDeviceId!, conversationId, payload.n, payload.mid || "");
  // B2 — verify the sender's signature over the AAD BEFORE decrypting. This is
  // belt-and-braces (AES-GCM is already authenticated under the message key),
  // but the key was derived by ECDH to OUR identity, so without a signature any
  // party who can supply an ephemeral key + plaintext (the server, in a forged
  // injection scenario) could craft a "valid" envelope. The ECDSA signature
  // binds the AAD to the sender's signing private key.
  if (payload.sig) {
    const signKey = await getPeerSignKey(senderUserId, senderDeviceId);
    if (signKey) {
      const ok = await verifyAad(signKey, ad, payload.sig);
      if (!ok) throw Object.assign(new Error("signature verify failed"), { sigBad: true });
    } else if (E2EE_REQUIRE_SIGNATURES) {
      // Strict mode: a sender claiming to be a peer but with NO published
      // signing key is rejected. Prevents a server from injecting a forged
      // envelope attributed to a victim whose signing key it hasn't published.
      throw Object.assign(new Error("signature required but absent"), { sigBad: true });
    }
    // Permissive (default): signKey null = pre-B2 peer; fall through during
    // migration. Once all devices have re-initialized, flip
    // NEXT_PUBLIC_E2EE_REQUIRE_SIGNATURES=true to close the window.
  } else if (E2EE_REQUIRE_SIGNATURES) {
    // Strict mode: an envelope that carries NO sig field at all is from a
    // pre-B2 client (or forged). Reject — every B2+ envelope is signed.
    throw Object.assign(new Error("unsigned envelope rejected"), { sigBad: true });
  }
  let pt;
  try {
    pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64dec(payload.iv), additionalData: ad },
      aesKey,
      b64dec(payload.ct),
    );
  } catch (decErr) {
    // ECIES is stateless per-message, BUT the AESkey came from ECDH(myPriv, epk).
    // If decrypt fails, the most plausible explanation (excluding tamper) is
    // that our pinned trusted-identity for this peer device is stale (e.g. the
    // sender re-enrolled with a new identity key). Evict the cached pub +
    // signing key for this peer device — the next ensureSessionsForUser call
    // will refetch from the bundle and re-pin, healing the next message.
    try { pubKeyCache.delete(senderUserId + ":" + senderDeviceId); } catch (_) { }
    try { signPubCache.delete(senderUserId + ":" + senderDeviceId); } catch (_) { }
    try { opkCache.delete(senderUserId + ":" + senderDeviceId); } catch (_) { }
    throw decErr;
  }
  return { text: new TextDecoder().decode(pt), mid: payload.mid || "", opk: payload.opk || null };
}

// Top up the one-time prekey pool when it runs low (consumed by forward secrecy).
// Best-effort, single-flight; generates non-extractable keypairs, stores the
// private halves locally and publishes the public halves.
let replenishing = false;
async function maybeReplenishPreKeys(): Promise<void> {
  if (!myToken || !myDeviceId || replenishing) return;
  try {
    const count = await signalStore.countPreKeys();
    if (count >= PREKEY_LOW_WATERMARK) return;
    replenishing = true;
    const toMake = Math.max(0, 100 - count);
    const fresh: any[] = [];
    for (let i = 0; i < toMake; i++) {
      const pk = (await crypto.subtle.generateKey(ECDH, false, ["deriveBits"])) as CryptoKeyPair;
      const keyId = "k" + Date.now().toString(36) + "_" + i;
      await signalStore.storePreKey(keyId, pk as any);
      fresh.push({ keyId, publicKey: b64enc(await crypto.subtle.exportKey("raw", pk.publicKey)) });
    }
    if (fresh.length) await api.e2eePublishPreKeys(myToken, myDeviceId, fresh);
  } catch (_) {
    /* best-effort */
  } finally {
    replenishing = false;
  }
}

// ON-DEMAND HEAL: every time a message renders as restore-pending (no envelope
// for this device / forward-secret key gone), its conversation is queued here
// and — debounced — sent to the server, which relays the request to the user's
// OTHER devices over the socket. Any online sibling device answers with a
// targeted history bundle; restoreSyncBundle merges it and the UI re-renders
// with real text. One request per conversation per page session (reset after a
// successful restore, so remaining gaps can ask again).
const healPending = new Set<string>();
const healRequested = new Set<string>();
// A heal ask used to be remembered for the WHOLE session. A long-lived tab asks
// once (at init / on the first gap), so a LATER message that arrived without an
// envelope for this device (a sender with a stale device list) never re-asked and
// sat on "Encrypted message" until a reload. Remember an ask for a short cooldown
// instead: still no request storm (a re-render can't re-ask inside it), but each
// new gap gets a fresh ask. Failures and explicit "Try again" still clear it early.
const HEAL_COOLDOWN_MS = 60_000;
function markHealRequested(ids: Iterable<string>): void {
  for (const id of ids) {
    healRequested.add(id);
    setTimeout(() => healRequested.delete(id), HEAL_COOLDOWN_MS);
  }
}
let healTimer: ReturnType<typeof setTimeout> | null = null;
// Set the first time THIS session hits any recoverable decrypt gap (missing envelope,
// forward-secret gap, group keyGone, or a decrypt-failed row — all route through
// queueHistoryHeal). Gates the expensive reconnect restores so a HEALTHY device that
// never had a gap pays nothing on reconnect. Reset only by a full reload.
let recoveryNeededThisSession = false;
function queueHistoryHeal(conversationId: string | null | undefined): void {
  if (!conversationId || !isE2EEEnabled()) return;
  recoveryNeededThisSession = true;
  if (healRequested.has(conversationId)) return;
  healPending.add(conversationId);
  if (healTimer) return;
  healTimer = setTimeout(() => {
    healTimer = null;
    const convIds = [...healPending].filter((c) => !healRequested.has(c));
    healPending.clear();
    if (!convIds.length || !myToken || !myDeviceId) return;
    markHealRequested(convIds);
    api.e2eeRequestHistorySync(myToken, convIds, myDeviceId).catch(() => {
      convIds.forEach((c) => healRequested.delete(c)); // let a later render retry
    });
  }, 3000);
}

// PUBLIC restore trigger for a locked "Unavailable on this device" row. The
// decrypt path already queues a heal for pending rows, but the RENDER had no way
// to (re-)fire it or show progress — so a locked card was a dead end. This asks
// the user's OTHER devices to re-push this conversation's history over the sync
// socket; when one answers, onHistoryRestored fires, the app re-decrypts, and the
// row unlocks. Debounced + deduped by queueHistoryHeal (no relay storm); `force`
// clears the dedup so an explicit "Try again" re-requests.
export function requestRestore(
  conversationId: string | null | undefined,
  force = false,
): void {
  if (force && conversationId) healRequested.delete(conversationId);
  queueHistoryHeal(conversationId);
  // A locked attachment is a decrypt gap like any other — run the automatic
  // sources too, not only the sibling ask.
  scheduleSelfRecovery();
}

// EAGER heal for a brand-new / freshly-registered device: ask ALL of the user's
// OTHER devices (via the socket relay) to push targeted history bundles for every
// active conversation, instead of waiting for each thread to render "[Encrypted…]".
// The sidebar's preview decrypt only queues a heal for conversations whose LAST
// message is pending — a conversation with a decryptable latest message (e.g. one
// sent AFTER this device registered) never triggers a heal, leaving its older
// history stuck behind the placeholder. This asks up front, covers them all, and
// chunking respects the server's 100-conversation cap per request (queueHistoryHeal
// batches EVERYTHING into one request, so conversations beyond the cap were marked
// requested but never actually asked). Deduped with the per-message heal via
// healRequested; failures un-mark so a later call retries. Only ever asks — a
// sibling that is offline simply doesn't answer, and the reconnect path re-asks.
export async function requestAllHistoryHeal(): Promise<void> {
  if (!isE2EEEnabled() || !myToken || !myDeviceId) return;
  recoveryNeededThisSession = true;
  let convs: any[] = [];
  try {
    convs = (await api.getConversations(myToken)) || [];
  } catch (_) {
    return; // offline/backend down — the reconnect path will re-ask
  }
  const targets = convs
    .filter(
      (c) =>
        c &&
        c.id &&
        (c.kind === "dm" || c.kind === "group" || c.kind === "channel" || c.kind === "self"),
    )
    .map((c) => c.id)
    .filter((id) => !healRequested.has(id));
  if (!targets.length) return;
  for (let i = 0; i < targets.length; i += 100) {
    const chunk = targets.slice(i, i + 100);
    markHealRequested(chunk);
    api.e2eeRequestHistorySync(myToken, chunk, myDeviceId).catch(() => {
      chunk.forEach((id) => healRequested.delete(id));
    });
  }
  console.info(`[e2ee] requested history sync for ${targets.length} conversation(s)`);
}

// ── Self-recovery for a diverged-identity device (the decrypt-failed case) ──────
// An AES-GCM auth failure on decrypt is almost always a WRONG KEY — this device's
// identity key diverged from the one the envelope was sealed to (e.g. a re-mint under
// the same deviceId) — not tamper. The plaintext of those messages lives in this
// device's OWN server-blind recovery backup, so re-running restoreFromCachedKek
// mid-session recovers them with NO user action, NO sibling device and NO plaintext
// downgrade (it only decrypts the user's own backup with a locally-cached KEK). Runs
// at most once per session because the cached KEK cannot change mid-session, so
// re-running the same restore is pointless; rearmRecovery() re-allows one more attempt
// after a reconnect (when a KEK might have been established elsewhere and synced).
let selfRecoveryDone = false;
let selfRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSelfRecovery(): void {
  if (!isE2EEEnabled() || !myToken || selfRecoveryDone || selfRecoveryTimer) return;
  selfRecoveryTimer = setTimeout(() => {
    selfRecoveryTimer = null;
    if (selfRecoveryDone) return;
    selfRecoveryDone = true;
    // EVERY automatic source, not just the cached KEK: the device hitting these
    // gaps is often one that holds NO key yet (new device, cleared storage,
    // reinstall) — exactly what the keychain / sibling paths exist for.
    void autoRecoverHistory({ reason: "decrypt-gap" }).catch(() => { });
  }, 3000); // debounce: scrolling through many failed rows fires ONE restore
}

// Re-arm the once-per-session recovery throttles so a heal / epoch-rekey / self-
// recovery that went unanswered (no key-holder or sibling online at the first ask) can
// re-fire. Pass a conversationId to re-arm just that thread, or omit for all. The
// caller then re-decrypts the affected thread, which re-hits keyGone/fsGone/decrypt-
// failed and re-issues the requests. Never downgrades or weakens crypto — it only lets
// the SAME recovery requests be sent again.
export function rearmRecovery(conversationId?: string): void {
  try {
    if (conversationId) {
      healRequested.delete(conversationId);
      epochRekeyRequested.delete(conversationId);
    } else {
      healRequested.clear();
      epochRekeyRequested.clear();
    }
    rewrapDone.clear();
    selfRecoveryDone = false; // allow one more own-backup restore attempt
  } catch (_) { }
}

// Called on socket RECONNECT: re-arm ALL recovery (not just the epoch throttle) and
// actively pull anything that would previously only be picked up on a full page
// reload — a sibling sync bundle that landed while the socket was down, and this
// device's own recovery backup. The reconnect handler's active-thread re-decrypt then
// re-hits any remaining gaps and re-requests with the throttles cleared. Supersedes
// resetEpochRekeyThrottle at the reconnect call site.
export function rearmRecoveryOnReconnect(): void {
  rearmRecovery(); // always cheap (in-memory Set clears)
  // Asks stored for THIS device to answer (other members' history) — not gated
  // on this device needing anything itself.
  if (myToken) void processPendingRedeliveries(myToken).catch(() => { });
  // A HEALTHY device that never hit a decrypt gap this session has nothing to restore —
  // skip the network + crypto entirely so a normal reconnect costs nothing.
  if (!recoveryNeededThisSession) return;
  // One orchestrated pass over every automatic source (sibling bundle, cached
  // key, keychain secret, live sibling ask). Not forced: the orchestrator's own
  // interval throttle keeps a flapping connection from re-downloading the whole
  // backup on every reconnect.
  void autoRecoverHistory({ reason: "reconnect" }).catch(() => { });
}

// Live sync choreography — called from the app's socket handlers (CoLabV1).
// A peer device of MINE was just approved: it is brand new and empty — push it
// a full history bundle right now instead of waiting for this device's next
// page load.
export async function onPeerDeviceApproved(deviceId: string): Promise<void> {
  if (!isE2EEEnabled() || !myToken || !myDeviceId) return;
  if (!deviceId || String(deviceId) === String(myDeviceId)) return;
  try { localStorage.removeItem(syncedMarkerKey(String(deviceId))); } catch (_) { }
  await buildHistoryBundleForDevice(myToken, String(deviceId)).catch(() => { });
}
// A bundle addressed to THIS device just landed on the relay — restore it now.
export async function onSyncReady(targetDeviceId: string): Promise<void> {
  if (!isE2EEDecryptEnabled() || !myDeviceId) return;
  if (String(targetDeviceId || "") !== String(myDeviceId)) return;
  await restoreSyncBundle().catch(() => { });
  // Remaining gaps may ask again — the answering device may not have had
  // everything (a third device might).
  healRequested.clear();
}
// A sibling device is staring at unreadable history — push it a targeted
// bundle for exactly those conversations (no activity cutoff).
export async function onSyncRequested(
  requesterDeviceId: string,
  conversationIds: string[],
): Promise<void> {
  if (!isE2EEEnabled() || !myToken || !myDeviceId) return;
  if (!requesterDeviceId || String(requesterDeviceId) === String(myDeviceId)) return;
  await buildHistoryBundleForDevice(myToken, String(requesterDeviceId), {
    convIds: Array.isArray(conversationIds) ? conversationIds : [],
  }).catch(() => { });
}

// Given a decrypted plaintext `text` for message `m`, detect a file-key envelope
// ({type:"file",key,iv,caption}). When present and `m` carries an E2EE file, attach
// the AES key/iv for lazy blob decryption and surface any caption as the display
// text (mutating m.file, matching the surrounding decrypt code's style). Otherwise
// return the text unchanged. Shared by BOTH the cache-first read and the full
// decrypt path so a cached file envelope (e.g. the sender's own attachment, whose
// self-envelope targets other devices) decrypts identically instead of leaking the
// raw envelope JSON as message text.
function applyFileEnvelope(m: any, text: string | null): string | null {
  if (typeof text !== "string") return text;
  let env: any = null;
  try {
    env = JSON.parse(text);
  } catch (_) {
    return text; // not JSON → an ordinary text message; leave as-is
  }
  if (env && env.type === "file" && m.file && m.file.e2ee) {
    const fileMime = m.file.type || m.file.mime || "application/octet-stream";
    const cap =
      typeof env.caption === "string" && env.caption.trim() !== ""
        ? env.caption
        : null;
    m.file = {
      ...m.file,
      type: fileMime,
      mime: fileMime,
      e2ee: true,
      _e2eeKey: env.key,
      _e2eeIv: env.iv,
      // Chunked (streamable) video: the manifest that lets the decrypt-on-play
      // Service Worker decrypt byte-ranges. Present only for chunked videos; a
      // single-blob file carries _e2eeIv instead.
      _e2eeStream: env.stream || m.file._e2eeStream,
      // Persist the caption on a DEDICATED field so the renderer never has to sniff it
      // out of m.text (which can momentarily still be the raw envelope JSON on the
      // cache-first path or before this unwrap runs). This is what keeps a captioned
      // video/image reliably in ONE media bubble instead of degrading to a bare,
      // uncapped attachment with the caption dropped.
      caption: cap,
      // Small first-frame video poster carried in the envelope — shown instantly on
      // the card with no download. Keep whatever the file already had if absent.
      thumb:
        typeof env.thumb === "string" && env.thumb
          ? env.thumb
          : m.file.thumb,
    };
    return cap;
  }
  return text;
}

// opts.skipPin: do NOT establish/advance the conversation's E2EE downgrade
// time-anchor from these messages. Used by conversation-LIST preview decryption,
// which only decrypts the LATEST message — pinning at that (newest) timestamp
// would set the anchor above the true first encrypted message and widen the
// anti-downgrade window. Previews need plaintext, not pinning.
export async function decryptMessageList(
  messages: any[],
  opts?: { skipPin?: boolean },
): Promise<any[]> {
  if (!isE2EEDecryptEnabled()) return messages;
  // Never judge a message unreadable before this device knows its own identity.
  if (!_initOk || !myUserId || !myDeviceId) await ensureDecryptReady();
  const out: any[] = [];
  // Set when at least one message was decrypted from its envelope (not served
  // from the cache) — i.e. history the backup may not hold yet.
  let anyFreshDecrypt = false;
  for (const m of messages) {
    const ct = m.ciphertext;
    const isDm = m.encrypted && Array.isArray(ct);
    const isGroup = m.encrypted && ct && !Array.isArray(ct) && (ct as any).t === 2;
    // Ratchet envelopes ride the same per-device fan-out array as ECIES; the
    // inner envelope's `type:3` marks it as ratchet (see encryptToDeviceRatchet).
    const isRatchet =
      m.encrypted &&
      Array.isArray(ct) &&
      ct.some((e: any) => e && e.type === 3);
    if (isDm || isGroup || isRatchet) {
      try {
        // The current device's envelope body. It is REGENERATED whenever the
        // message is EDITED (an edit replaces the ciphertext in place, reusing the
        // same server message id), so comparing it against the cached copy detects
        // a stale cache entry. Available WITHOUT decrypting — it IS the ciphertext.
        // A per-message ciphertext fingerprint that CHANGES on edit (an edit reuses
        // the server id but replaces the ciphertext). For a DM it's my per-device
        // envelope body; for a GROUP it's the shared epoch ciphertext (`ct.ct`).
        // Used to key the local plaintext cache so an edit invalidates it — and now
        // that we cache EVERY message (not just forward-secret ones), the group case
        // must be non-null or edited group messages would serve stale cached text.
        const myEnvBody = Array.isArray(ct)
          ? (
            (ct as any[]).find(
              (x: any) =>
                x.recipientId === myUserId &&
                String(x.recipientDeviceId) === String(myDeviceId),
            ) || {}
          ).body || null
          : ct && typeof ct === "object"
            ? (ct as any).ct || null
            : null;
        // Forward-secrecy cache-first read: a forward-secret DM's one-time-prekey
        // private half is deleted after the first decrypt, so its plaintext then
        // lives only in this local cache. Use it before touching the envelope —
        // but ONLY when it was cached from the SAME envelope; otherwise an EDIT
        // (which reuses the id) would serve the stale pre-edit plaintext, dropping
        // the edit's text + formatting. `env == null` (pre-fix cache entry) or an
        // indeterminate current body falls back to the old cache-first behavior so
        // forward-secret rows whose OPK is already gone still render.
        const cached = await signalStore.getCachedPlaintext(String(m.id)).catch(() => null);
        if (
          cached &&
          typeof cached.text === "string" &&
          (cached.env == null || myEnvBody == null || cached.env === myEnvBody)
        ) {
          // A cached entry may be a FILE envelope (the sender's own attachment is
          // cached this way so it survives reload — its self-envelope targets other
          // devices and can't be decrypted here). Route it through the same handler
          // as the full path so the file key/caption are applied, never rendered as
          // raw JSON.
          const cachedText = applyFileEnvelope(m, cached.text);
          // A poisoned / caption-only cache entry (an older reconcile stored the
          // bare caption, not the {type,key,iv} envelope) leaves an E2EE file with
          // no key. Don't serve that as the final render — fall through to the real
          // envelope decrypt below, which (with the epoch/self key now present)
          // recovers the file key and re-caches the full envelope. Text messages
          // and files that DID get a key/url still short-circuit here.
          if (!(m.file && m.file.e2ee && !m.file._e2eeKey && !m.file.url)) {
            out.push({ ...m, text: cachedText, encrypted: false, ciphertext: null });
            continue;
          }
        }

        let text: string | null;
        let mid = "";
        let opkUsed: string | null = null;
        if (isDm || isRatchet) {
          const myEnv = (ct as any[]).find(
            (e: any) => e.recipientId === myUserId && String(e.recipientDeviceId) === String(myDeviceId),
          );
          if (!myEnv) {
            // Decrypted before init finished: "no envelope" may only mean this
            // device didn't know its own id yet. Re-decrypt once init lands.
            if (!_initOk && m.conversationId) notReadyConvs.add(m.conversationId);
            // No envelope for this device — typically a message sent before this
            // device existed (history gap), NOT tampering. Queue an on-demand
            // heal: the user's other devices are asked (over the socket) to push
            // this conversation's history; when the bundle lands the UI refreshes
            // and this placeholder is replaced by the real message.
            queueHistoryHeal(m.conversationId);
            // ...and open every automatic backup source this device has (cached
            // key / keychain secret) — a brand-new device has no sibling to answer.
            scheduleSelfRecovery();
            captureIssue("e2ee", "E2EE: no envelope for this device — waiting for device/history sync", { kind: "no-envelope", conversationId: m.conversationId, messageId: m.id });
            out.push(await pendingRow(m, "no-envelope"));
            continue;
          }
          // A re-delivered envelope was sealed (and signed) by the member who
          // restored it, not necessarily by the original sender: verify it
          // against THAT device. The row still shows the original sender.
          const senderId =
            (myEnv.redeliveredBy && myEnv.redeliveredBy.userId) || (m.sender && m.sender.id);
          // Route by envelope type. type:3 = Double Ratchet envelope; legacy
          // (no `type` field, or type:1) = ECIES. Mixed conversations are fine
          // because each envelope carries its own type.
          if (myEnv.type === 3) {
            const dec = await decryptRatchetEnvelope(
              senderId,
              myEnv.senderDeviceId,
              myEnv.body,
              m.conversationId,
            );
            text = dec.text;
            mid = dec.mid;
          } else {
            const dec = await decryptEnvelope(senderId, myEnv.senderDeviceId, myEnv.body, m.conversationId);
            text = dec.text;
            mid = dec.mid;
            opkUsed = dec.opk;
          }
        } else {
          // Group/channel: shared per-epoch key, looked up by epoch (ver).
          const dec = await decryptGroupEnvelope(ct, m.conversationId);
          text = dec.text;
          mid = dec.mid;
        }

        // Anti-replay: a verified mid re-appearing under a DIFFERENT server
        // message id means the server re-injected an old envelope.
        if ((await replayCheck(mid, String(m.id))) === "replay") {
          captureIssue("e2ee", "E2EE: replayed message rejected (server re-injected an old envelope)", { kind: "replayed", conversationId: m.conversationId, messageId: m.id });
          out.push({ ...m, text: "[Replayed message — rejected]", encrypted: false, ciphertext: null });
          continue;
        }

        // Authenticated encrypted message → pin the conversation E2EE so the
        // server can never later force a plaintext downgrade for it. B2 — anchor
        // the pin at THIS message's server createdAt (the first encrypted message
        // seen establishes the cutover boundary; setConvE2EE keeps the earliest).
        if (!opts?.skipPin) void pinConvE2EE(m.conversationId, m.createdAt);

        // File payload: the AES file key was wrapped inside the (DM or group)
        // envelope; fetch + decrypt the blob. (File sends never use a one-time
        // prekey, so opkUsed is null for them — no cache/delete below.)
        //
        // IMPORTANT: backend's serializeFile() returns NO `url` field and uses
        // `mime` (not `type`). The protected download endpoint requires the
        // bearer token. Without these the fetch silently 401'd (or hit
        // undefined), the decrypt branch threw into the catch below, and the
        // bubble fell back to FileAttachment which then loaded the RAW
        // ENCRYPTED bytes and tried to render them as an image — surfacing as
        // a broken image-icon + filename card. Fix: use api.fileLinkUrl + the
        // captured myToken, and pull mime from file.mime as well as file.type.
        // Separate the two failure modes that used to share one silent catch:
        //   (1) JSON.parse throws → an ordinary text message, not a file envelope;
        //       leave `text` as-is (benign).
        //   (2) the file fetch/decrypt throws → a REAL error. Previously it was
        //       swallowed as "not JSON", leaving m.file encrypted, so the bubble fell
        //       back to loading the raw ciphertext as an <img> = broken image (the
        //       re-drag-same-image symptom). Now keep e2ee:true + drop the url so
        //       FileAttachment shows the locked "not available" placeholder, and log
        //       the failing step so the (E2EE-only, 2nd-send) cause can be pinned live.
        // #3 PERF: DEFER the (possibly huge) encrypted-blob fetch + decrypt to the
        // FileAttachment renderer (lazy, per-file). applyFileEnvelope only unwraps +
        // attaches the AES file key/iv (and surfaces any caption); useFileBlob
        // fetches + decrypts on demand when the file actually renders. `_e2eeKey`
        // also marks the file decryptable so FileAttachment skips the "locked"
        // placeholder. Shared with the cache-first read above.
        // ── WhatsApp-style local persistence (decrypt ONCE, keep plaintext) ──────
        // Cache the RAW decrypted plaintext of EVERY successfully-decrypted message
        // the first time we decrypt it, keyed by its ciphertext (`env`) so an edit
        // (which reuses the id but changes the ciphertext) invalidates it. For a
        // FILE this raw text is the {type,key,iv,caption} envelope, so the cache-
        // first read (which runs applyFileEnvelope over the cached text) restores
        // the file key + caption too. After this, the cache-first short-circuit at
        // the top of the loop serves the message WITHOUT re-decrypting — so it stays
        // readable for the life of THIS device's storage even if its keys later
        // diverge (rotated/mismatched identity key, lost epoch key, consumed OPK).
        // THIS is why WhatsApp is seamless whether or not backup is on: it decrypts
        // once and keeps the plaintext in a local DB until uninstall / clear-storage
        // wipes it; the cloud backup only migrates history to a NEW device. (An
        // at-rest opt-out can gate this for the paranoid — default is keep, as WA.)
        // Track whether the durable plaintext write actually succeeded so the OPK
        // cleanup below stays coupled to it — never consume a one-time prekey unless
        // this message's plaintext is durably stored (else a later cache miss would
        // strand it permanently, since the OPK secret can't be re-derived).
        let plaintextCached = false;
        if (typeof text === "string" && text !== "") {
          try {
            await signalStore.putCachedPlaintext(String(m.id), { text, env: myEnvBody });
            plaintextCached = true;
            anyFreshDecrypt = true;
            markBackupDirty(m.conversationId, m.createdAt);
          } catch (_) {
            plaintextCached = false; // durable write failed (quota / txn) — see OPK guard below
          }
        }
        // Forward secrecy: an OPK message ALSO deletes its one-time prekey private
        // half (after the cache above), so it can never be re-derived from the
        // long-term identity key (FS vs device theft). BUT only delete it once the
        // plaintext is durably cached — otherwise, if the cache write failed, deleting
        // the OPK would strand this message permanently on the next cache miss (the
        // same one-shot-consume-without-durable-plaintext bug as the ratchet path).
        // If the write failed, keep the OPK so the envelope stays re-decryptable; FS
        // degrades until a later successful cache write, which is strictly better than
        // losing the message.
        if (opkUsed && plaintextCached) {
          try {
            await signalStore.removePreKey(opkUsed);
            void maybeReplenishPreKeys();
          } catch (_) {
            /* non-fatal */
          }
        }

        text = applyFileEnvelope(m, text);
        if (text === null && !m.file) continue; // control/empty
        out.push({ ...m, text, encrypted: false, ciphertext: null });
      } catch (e: any) {
        if (e && e.transient) {
          // The key FETCH failed (network blip) — not a history gap and not a bad
          // key. Nothing to restore: show the neutral row and simply decrypt again
          // shortly. No incident is recorded; the message is perfectly readable.
          scheduleRedecrypt(m.conversationId);
          out.push(await pendingRow(m, "transient"));
        } else if (e && e.fsGone) {
          // Forward-secret message whose one-time key was consumed and whose
          // local plaintext cache is gone (new device / cleared storage). The
          // ENVELOPE is unrecoverable by design — but a sibling device that
          // decrypted it still holds the plaintext, so the same on-demand heal
          // applies — and so does this device's own backup.
          queueHistoryHeal(m.conversationId);
          scheduleSelfRecovery();
          out.push(await pendingRow(m, "one-time-key-consumed"));
        } else if (e && e.keyGone) {
          // Group epoch key this device never received (minted before the device
          // was trusted, or FK-skipped). The sibling heal (plaintext relay) can't
          // deliver a GROUP epoch key, so ALSO ask the conversation's online
          // MEMBERS to re-wrap the existing epoch key to this device (throttled,
          // once per conversation per session). This is what actually clears a
          // whole-group pending-key without needing a backup.
          queueHistoryHeal(m.conversationId);
          void requestEpochRekey(m.conversationId);
          scheduleSelfRecovery();
          captureIssue("e2ee", "E2EE: missing message key — waiting for device/history sync", { kind: "pending-key", conversationId: m.conversationId, messageId: m.id });
          out.push(await pendingRow(m, "missing-group-key"));
        } else if (e && e.sigBad) {
          // B2 — signature verify failed. Either the server fabricated the
          // envelope or a group member forged it. Refuse to render as authentic.
          console.error("[E2EE] signature verify failed for", m.id);
          captureIssue("e2ee", "E2EE: sender signature invalid (possible forgery/tamper)", { kind: "signature-invalid", conversationId: m.conversationId, messageId: m.id });
          out.push({ ...m, text: "[Forged or tampered — sender signature invalid]", encrypted: false, ciphertext: null });
        } else if (e && e.outOfOrder) {
          // Ratchet-specific, NOT tamper: this message's single-use key was already
          // consumed and its durable plaintext cache was later evicted, so re-decrypting
          // the same ciphertext is now mathematically impossible (the ratchet advanced
          // past it). It is still recoverable OUT of band — a sibling that opened the
          // message still holds the plaintext, and our own server-blind backup holds it
          // too. Recover the same way as a decrypt gap, but label it accurately so the
          // decrypt-failed count isn't polluted with non-tamper rows. (The session is
          // deliberately NOT torn down for this case — see decryptRatchetEnvelope.)
          captureIssue("e2ee", "E2EE: message key unavailable — recovering from sync/backup", { kind: "ratchet-recover", conversationId: m.conversationId, messageId: m.id });
          queueHistoryHeal(m.conversationId);
          scheduleSelfRecovery();
          out.push(await pendingRow(m, "ratchet-key-gone"));
        } else {
          // AES-GCM auth failure here means tamper OR wrong key (not a history gap).
          // In practice it is almost always a WRONG KEY: this device's identity key
          // diverged from the one the envelope was sealed to (a re-mint under the same
          // deviceId). That is RECOVERABLE without any plaintext downgrade — (a) a
          // sibling device that opened this message when it arrived still holds the
          // plaintext (queueHistoryHeal relay), and (b) this device's OWN server-blind
          // backup holds the plaintext sealed under the key it had at the time
          // (scheduleSelfRecovery -> restoreFromCachedKek). Schedule both (throttled)
          // and show the same neutral "unavailable on this device" pending text as the
          // history-gap cases, so the row flips to real text the instant either lands
          // instead of dead-ending on a terminal placeholder until a reload. Telemetry
          // still records the decrypt-failed incident so the count only stops once
          // recovery actually succeeds.
          console.error("[E2EE] decrypt failed for", m.id, e);
          captureIssue("e2ee", "E2EE: decryption failed (wrong key or tamper)", { kind: "decrypt-failed", conversationId: m.conversationId, messageId: m.id });
          queueHistoryHeal(m.conversationId);
          scheduleSelfRecovery();
          out.push(await pendingRow(m, "decrypt-failed"));
        }
      }
    } else {
      // DOWNGRADE / INJECTION PROTECTION.
      // (a) A message that CLAIMS to be encrypted but carries no ciphertext is a
      //     stripped envelope — reject.
      // (b) A PLAINTEXT text message in a conversation we've PINNED as E2EE is a
      //     forced downgrade / server-injected forgery: once a conversation has
      //     carried an authenticated encrypted message, the server must not be
      //     able to serve plaintext text attributed to a peer. Only `text` is
      //     guarded — call/meeting/voice/invite carry plaintext metadata by
      //     design (V8) and legacy conversations (never pinned) are unaffected.
      if (m && m.encrypted && !m.ciphertext) {
        captureIssue("e2ee", "E2EE: message flagged encrypted but has no ciphertext (stripped envelope)", { kind: "stripped-envelope", conversationId: m.conversationId, messageId: m.id, detail: m.me ? "own-message" : "peer-message" });
        // "Not encrypted properly": the envelope set is missing. If the row (or
        // the app's fallback) still has readable text, show it tagged not
        // encrypted; a body-less stripped row has nothing to show.
        const fb = await resolvePlaintextFallback(m);
        if (fb != null) out.push(plaintextRow(m, fb, "stripped-envelope"));
        else out.push({ ...m, text: "[Unencrypted message — rejected]", encrypted: false });
      } else if (m && m.type === "text" && !m.file && !m.voice && !m.ciphertext && (await isConvE2EERequired(m.conversationId))) {
        // A1 — a message carrying a FILE or VOICE blob is genuine content, not a
        // server-injected plaintext-TEXT forgery: exempt it from this text guard
        // so the attachment (and its real caption) render normally. Only pure
        // plaintext TEXT rows reach here.
        //
        // B2 — TIME ANCHOR. Only act on plaintext that is NEWER than the pin's
        // anchor (a genuine post-cutover downgrade). Plaintext OLDER than the
        // anchor is legitimate pre-cutover history and renders verbatim. If no
        // anchor is recorded (older client / pinned by the sender before any
        // server-stamped encrypted message arrived), default to EXEMPT.
        const pinnedAt = await getConvPinnedAt(m.conversationId);
        if (isNewerThanPin(m.createdAt, pinnedAt)) {
          // A2 — post-pin plaintext text. Historically this was a SELF-INFLICTED
          // downgrade: the send path fell back to encryption_version=0 in a pinned
          // conversation after a key-storage failure (fixed at the DB driver +
          // send-path hardening), so the row carries a REAL body. We choose
          // READABILITY over strict downgrade-attack defence (internal single-org
          // deployment, own server): render the real content and TAG it
          // notEncrypted so the UI shows a subtle, non-alarming "Not encrypted"
          // marker — NEVER put a warning into m.text itself. A body-less row has
          // nothing to show and no legitimate reason to exist post-pin, so it
          // stays closed as the minimal residual downgrade defence.
          const hasBody = typeof m.text === "string" && m.text.trim() !== "";
          captureIssue("e2ee", "E2EE: plaintext message in an encrypted conversation (rendered, flagged not-encrypted)", { kind: "unencrypted-rendered", conversationId: m.conversationId, messageId: m.id, detail: m.me ? "own-message" : "peer-message" });
          if (hasBody) {
            out.push({ ...m, encrypted: false, notEncrypted: true });
          } else {
            out.push({ ...m, text: "[Unencrypted message — rejected]", encrypted: false });
          }
        } else {
          out.push(m);
        }
      } else {
        out.push(m);
      }
    }
  }
  if (anyFreshDecrypt) scheduleBackupRefresh();
  return out;
}

// ------------------------------------------------------------------
// Mechanism A — server-blind device-link history sync
//
// When an existing, trusted, online device approves (or first sees) ANOTHER of
// this user's devices, it re-encrypts a bounded window of RECENT plaintext to the
// new device's published identity key (reusing encryptToDevice — ECIES) and
// uploads ONLY opaque ciphertext to the relay. The new device fetches, decrypts
// (decryptEnvelope), and merges plaintext into the local plaintext cache; the
// existing cache-first short-circuit in decryptMessageList then surfaces it with
// NO new render branch. The server only ever sees opaque base64.
// ------------------------------------------------------------------
const HISTORY_SYNC_ALGO = "ecies-p256-aesgcm";
// Widened (was 200/90d/2000): the old window left anything older than 90 days —
// or deeper than 200 messages — permanently unreadable on a new device even
// after a successful sync. Still bounded (relay chunks are capped), but the
// bounds now cover a year of real usage.
// Shown in place of a message this device can't decrypt YET (sent before the
// device existed; a heal or the recovery backup will fill it in). Deliberately
// calm and short: the old copy — "[Encrypted — waiting to sync from your other
// devices]" — read like a system error, leaked implementation detail, and put
// the problem on the reader. It also appears in sidebar previews, where the
// bracketed form was especially jarring. Keep this SHORT for that reason.
// HONESTY: this was "Syncing…", which was a lie for the common case. The heal it
// referred to can ONLY succeed if another of your devices is online, holds the
// plaintext, and answers over the socket. For a single-device user — most people
// here — nothing can ever answer: there is no retry, no timeout and no failure
// state, so "Syncing…" sat there forever describing a process that was not
// running. When a heal DOES succeed the text is replaced outright, so this
// string is only ever seen in the case where it is true.
// The row itself renders the live restore state (E2EEBanners); this text is
// what previews and copies see. It names WHAT the row is, never a failure.
export const E2EE_PENDING_TEXT = "Encrypted message";

// ── Plaintext fallback callback ──────────────────────────────────────────────
// When a message cannot be decrypted on this device, the app may supply its
// plaintext from another source (a local draft/sent log, a server-side copy for
// a conversation that is not really E2EE, an import). The callback receives the
// raw message and returns the text, or null to fall back to the pending row.
// The server row's own body (a message that was NOT encrypted properly and was
// stored in plaintext) is always tried first.
export type PlaintextFallback = (m: any) => string | null | undefined | Promise<string | null | undefined>;
let plaintextFallback: PlaintextFallback | null = null;
export function setPlaintextFallback(cb: PlaintextFallback | null): void {
  plaintextFallback = cb;
}
async function resolvePlaintextFallback(m: any): Promise<string | null> {
  const own = serverPlaintextOf(m, E2EE_PENDING_TEXT);
  if (own != null) return own;
  if (!plaintextFallback) return null;
  try {
    const v = await plaintextFallback(m);
    return typeof v === "string" && v.trim() ? v : null;
  } catch (_) {
    return null;
  }
}
// The row to show for a message this device cannot read RIGHT NOW: readable
// plaintext (tagged "not encrypted") when any source has it, else the pending
// placeholder that the automatic recovery fills in later. The heal / recovery
// scheduling the caller did still stands — a readable fallback never cancels
// the attempt to get the real envelope open.
async function pendingRow(m: any, why: string): Promise<any> {
  const text = await resolvePlaintextFallback(m);
  if (text != null) {
    captureIssue("e2ee", "E2EE: message not decryptable here — rendered its plaintext copy (not encrypted)", { kind: "unencrypted-rendered", conversationId: m.conversationId, messageId: m.id, detail: why });
    return plaintextRow(m, text, why);
  }
  // Ask the original sender to seal this message to THIS device again. The
  // sender's device still holds the plaintext of what it sent, so this works
  // for a message the backup never held and no sibling is online to give.
  const redelivery = why !== "transient" && requestRedelivery(m);
  return {
    ...m,
    text: E2EE_PENDING_TEXT,
    encrypted: false,
    ciphertext: null,
    _pendingRecovery: true,
    ...(redelivery ? { _redeliveryPending: true } : {}),
  };
}

// ── Sender re-delivery (retry receipts) ─────────────────────────────────────
// Requester side. Once per message per REDELIVERY_RETRY_MS: ask the other
// members' devices (through the server relay, and a stored ask for the ones
// that are offline) to encrypt this message to this device again. Only
// per-device (DM-style) envelopes qualify — group messages use the shared epoch
// key and go through requestEpochRekey. Our OWN messages qualify too: the peer
// who read them still holds their plaintext, and a device that lost its keys
// has no other way to get its own words back when no sibling is online.
const REDELIVERY_RETRY_MS = 2 * 60_000;
const redeliveryAskedAt = new Map<string, number>();
export function requestRedelivery(m: any): boolean {
  if (!isE2EEEnabled() || !myToken || !myDeviceId || !myUserId) return false;
  if (!m || !m.id || !Array.isArray(m.ciphertext)) return false;
  const senderId = m.sender && m.sender.id ? String(m.sender.id) : m.senderId ? String(m.senderId) : "";
  if (!senderId) return false;
  const id = String(m.id);
  const now = Date.now();
  const last = redeliveryAskedAt.get(id) || 0;
  if (now - last < REDELIVERY_RETRY_MS) return true; // already asked recently
  redeliveryAskedAt.set(id, now);
  void api.e2eeRequestRedelivery(myToken, id, myDeviceId).catch(() => {
    redeliveryAskedAt.delete(id); // let the next decrypt pass ask again
  });
  return true;
}

// Sender side (E2EE_REDELIVER_REQUEST): another member's device could not open
// our message. If this device still holds the plaintext (its own sent copy, or
// a decrypted copy), seal it to that device and hand the envelope to the
// server. Identity-only ECIES (no one-time key): a re-delivered copy must stay
// re-decryptable from the server row. The caller has already checked, against
// its OWN member list, that the requester belongs to the conversation.
export async function redeliverMessage(
  token: string,
  messageId: string,
  conversationId: string,
  requesterUserId: string,
  requesterDeviceId: string,
): Promise<boolean> {
  if (!isE2EEEnabled() || !myUserId || !myDeviceId) return false;
  if (!messageId || !conversationId || !requesterUserId || !requesterDeviceId) return false;
  if (requesterUserId === myUserId && String(requesterDeviceId) === String(myDeviceId)) return false;
  let text: string | null = null;
  try {
    const cached = await signalStore.getCachedPlaintext(String(messageId));
    if (cached && typeof cached.text === "string" && cached.text) text = cached.text;
  } catch (_) { }
  if (text == null) text = await plaintextFromServerCopy(token, messageId);
  if (text == null) return false; // this device cannot open it — a sibling may
  try {
    await ensureSessionsForUser(token, requesterUserId);
    if (!pubKeyCache.has(requesterUserId + ":" + requesterDeviceId)) return false; // untrusted / unknown device
    const env = await encryptToDevice(requesterUserId, String(requesterDeviceId), text, conversationId, { token, useOpk: false });
    await api.e2eePutRedeliveredEnvelope(token, String(messageId), {
      recipientId: requesterUserId,
      recipientDeviceId: String(requesterDeviceId),
      envelope: { ...env, senderDeviceId: myDeviceId },
    });
    console.info("[e2ee] re-delivered message %s to %s:%s", messageId, requesterUserId, requesterDeviceId);
    return true;
  } catch (e) {
    console.warn("[e2ee] re-delivery failed for", messageId, e);
    return false;
  }
}

// Messages this device has already tried and failed to open from the server
// copy. Persisted for a day so reconnects and the 10-minute poll don't refetch
// the same unanswerable rows; a device whose keys change clears it (reset).
const UNOPENABLE_KEY = "e2ee_unopenable_msgs";
const UNOPENABLE_TTL_MS = 24 * 60 * 60 * 1000;
let unopenable: Map<string, number> | null = null;
function unopenableMap(): Map<string, number> {
  if (unopenable) return unopenable;
  unopenable = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(UNOPENABLE_KEY) || "{}");
    const now = Date.now();
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && now - v < UNOPENABLE_TTL_MS) unopenable.set(k, v);
  } catch (_) { }
  return unopenable;
}
function markUnopenable(ids: string[]): void {
  if (!ids.length) return;
  const m = unopenableMap();
  const now = Date.now();
  ids.forEach((id) => m.set(String(id), now));
  try {
    const obj: Record<string, number> = {};
    for (const [k, v] of m) obj[k] = v;
    localStorage.setItem(UNOPENABLE_KEY, JSON.stringify(obj));
  } catch (_) { }
}
function isUnopenable(id: string): boolean {
  const t = unopenableMap().get(String(id));
  return !!t && Date.now() - t < UNOPENABLE_TTL_MS;
}

// For many asked messages at once: fetch THIS device's own envelope for each
// (one call per 200), open what it can, cache it. Returns the ids now held.
async function openOwnServerCopies(token: string, ids: string[]): Promise<Set<string>> {
  const held = new Set<string>();
  const todo = ids.filter((id) => !isUnopenable(id));
  for (let i = 0; i < todo.length; i += 200) {
    const chunk = todo.slice(i, i + 200);
    let rows: any[] = [];
    try {
      rows = ((await api.e2eeGetOwnEnvelopes(token, chunk, myDeviceId)) as any[]) || [];
    } catch (_) {
      break; // transient — the next pass retries; nothing is memoised
    }
    const failed: string[] = [];
    const got = new Set(rows.map((r) => String(r && r.id)));
    for (const id of chunk) if (!got.has(id)) failed.push(id); // not a member / gone
    for (const r of rows) {
      if (!r || !r.id) continue;
      if (!r.envelope) { failed.push(String(r.id)); continue; }
      const m = {
        id: r.id,
        conversationId: r.conversationId,
        encrypted: true,
        ciphertext: [r.envelope],
        sender: { id: r.senderId },
        type: r.type,
        createdAt: r.createdAt,
      };
      let text: string | null = null;
      try { text = await recoverPlaintextForSync(m); } catch (_) { text = null; }
      if (typeof text === "string" && text) {
        try { await signalStore.putCachedPlaintext(String(r.id), { text }); } catch (_) { }
        held.add(String(r.id));
      } else failed.push(String(r.id));
    }
    markUnopenable(failed);
  }
  return held;
}

// Answer many asks: whatever is cached, plus whatever this device can open from
// its own server copies, fetched in one batch.
export async function redeliverMany(
  token: string,
  asks: Array<{ messageId: string; conversationId: string; requesterUserId: string; requesterDeviceId: string }>,
): Promise<number> {
  if (!isE2EEEnabled() || !myDeviceId) return 0;
  const mine = asks.filter((a) => a && String(a.requesterDeviceId) !== String(myDeviceId));
  const missing: string[] = [];
  for (const a of mine) {
    let cached: any = null;
    try { cached = await signalStore.getCachedPlaintext(String(a.messageId)); } catch (_) { }
    if (!(cached && typeof cached.text === "string" && cached.text)) missing.push(String(a.messageId));
  }
  const opened = missing.length ? await openOwnServerCopies(token, [...new Set(missing)]) : new Set<string>();
  const missingSet = new Set(missing);
  let answered = 0;
  let held = 0;
  for (const a of mine) {
    const id = String(a.messageId);
    if (missingSet.has(id) && !opened.has(id)) continue;
    held++;
    if (await redeliverMessage(token, id, String(a.conversationId), String(a.requesterUserId), String(a.requesterDeviceId))) answered++;
  }
  // This device HAS the plaintext for some asks but could not deliver them
  // (throttled, a blip, the peer's key bundle not reachable yet). Those are
  // not "not mine" — try again in a minute instead of at the 10-minute poll.
  if (held > answered) scheduleRedeliveryRetry(token);
  else redeliveryRetryCount = 0;
  return answered;
}

const REDELIVERY_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000];
let redeliveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
let redeliveryRetryCount = 0;
function scheduleRedeliveryRetry(token: string): void {
  if (redeliveryRetryTimer || redeliveryRetryCount >= REDELIVERY_RETRY_DELAYS_MS.length) return;
  const delay = REDELIVERY_RETRY_DELAYS_MS[redeliveryRetryCount++];
  redeliveryRetryTimer = setTimeout(() => {
    redeliveryRetryTimer = null;
    void processPendingRedeliveries(myToken || token).catch(() => { });
  }, delay);
}

// Cache miss on an asked device: fetch the message's envelope set and try to
// open THIS device's own envelope. The sender always sealed a copy to its own
// device without a one-time key, so a sender whose keys survived can re-deliver
// even after its plaintext cache was cleared. Caches what it opens.
async function plaintextFromServerCopy(token: string, messageId: string): Promise<string | null> {
  if (isUnopenable(messageId)) return null;
  try {
    const r: any = await api.e2eeGetMessageEnvelopes(token, String(messageId));
    if (!r || !r.encrypted || !r.ciphertext) return null;
    const m = {
      id: r.id,
      conversationId: r.conversationId,
      encrypted: true,
      ciphertext: r.ciphertext,
      sender: { id: r.senderId },
      type: r.type,
      createdAt: r.createdAt,
    };
    const text = await recoverPlaintextForSync(m);
    if (typeof text === "string" && text) {
      try { await signalStore.putCachedPlaintext(String(messageId), { text }); } catch (_) { }
      return text;
    }
    markUnopenable([String(messageId)]);
  } catch (_) { }
  return null;
}

// Requester side (E2EE_REDELIVERED): a fresh envelope for this device is on the
// server row. Drop the conversation's cached rows so the thread refetches and
// decrypts it.
// Answer the asks stored on the server (0126) that this device can serve: one
// re-delivery per ask, sequential, bounded. Runs at init and on reconnect.
let redeliveriesInFlight: Promise<void> | null = null;
export async function processPendingRedeliveries(token: string | null): Promise<void> {
  if (!isE2EEEnabled() || !token || !myUserId || !myDeviceId) return;
  if (redeliveriesInFlight) return redeliveriesInFlight;
  redeliveriesInFlight = (async () => {
    try {
      const asks = (await api.e2eeRedeliverRequests(token, myDeviceId).catch(() => [])) as any[];
      const valid = (asks || []).filter(
        (a: any) => a && a.messageId && a.conversationId && a.requesterUserId && a.requesterDeviceId,
      );
      const answered = await redeliverMany(token, valid);
      if (answered) console.info("[e2ee] answered %d stored re-delivery ask(s)", answered);
    } finally {
      redeliveriesInFlight = null;
    }
  })();
  return redeliveriesInFlight;
}

// MIGRATION SWEEP. A backup added after messages already existed only ever
// holds what some device could still read; a device that lost its keys asks
// for the rest one row at a time, as threads are opened. This walks EVERY
// conversation once and asks for every per-device message it cannot open, so
// the other members' devices refill it at their next sign-in without anyone
// opening anything. Runs once per session, only when this device is actually
// missing history, and at most once every 12 hours per device.
const UNREADABLE_AUDIT_KEY = "e2ee_unreadable_audit_at";
const UNREADABLE_AUDIT_MIN_MS = 12 * 60 * 60 * 1000;
let unreadableAuditRan = false;
// Ask (in bulk) for a set of per-device messages this device cannot open, and
// remember that this session has swept so the standalone audit walk is skipped.
async function submitUnreadableAsks(token: string, ids: string[]): Promise<void> {
  if (!ids.length || unreadableAuditRan) return;
  unreadableAuditRan = true; // claim it before the first await: one sweep per session
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await api.e2eeRequestRedeliveryBulk(token, chunk, myDeviceId).catch(() => { });
    const now = Date.now();
    chunk.forEach((id) => redeliveryAskedAt.set(id, now));
  }
  unreadableAuditRan = true;
  try { localStorage.setItem(UNREADABLE_AUDIT_KEY, String(Date.now())); } catch (_) { }
  console.info("[e2ee] migration sweep: asked the other members' devices for %d unreadable message(s)", ids.length);
}
export async function auditUnreadableHistory(token: string | null): Promise<number> {
  if (!isE2EEEnabled() || !token || !myUserId || !myDeviceId || unreadableAuditRan) return 0;
  const missing = recoveryNeededThisSession || _freshEnrollThisSession || recoveryState.phase !== "done";
  if (!missing) return 0;
  try {
    const last = Number(localStorage.getItem(UNREADABLE_AUDIT_KEY) || "0") || 0;
    if (last && Date.now() - last < UNREADABLE_AUDIT_MIN_MS) return 0;
  } catch (_) { }
  unreadableAuditRan = true;
  const unreadable: string[] = [];
  const seen = new Set<string>();
  try {
    await gatherHistoryEntries(token, {
      allTime: true,
      onUnreadable: (m) => {
        const id = String(m.id);
        if (seen.has(id)) return;
        seen.add(id);
        unreadable.push(id);
      },
    });
    await submitUnreadableAsks(token, unreadable);
    if (!unreadable.length) {
      try { localStorage.setItem(UNREADABLE_AUDIT_KEY, String(Date.now())); } catch (_) { }
    }
  } catch (_) {
    unreadableAuditRan = false; // transient — try again next init
  }
  return unreadable.length;
}

// While this device stays online, keep answering the asks the others store —
// the init/reconnect passes alone missed a peer that stays signed in for days.
const PENDING_REDELIVERY_POLL_MS = 10 * 60 * 1000;
let pendingRedeliveryTimer: ReturnType<typeof setInterval> | null = null;
export function startPendingRedeliveryPolling(): void {
  if (pendingRedeliveryTimer || typeof window === "undefined") return;
  pendingRedeliveryTimer = setInterval(() => {
    if (myToken) void processPendingRedeliveries(myToken).catch(() => { });
  }, PENDING_REDELIVERY_POLL_MS);
}

// Per-conversation answer to "is anyone left who could still send me this
// row?" — shared by every pending row of the thread, refreshed every 30 s.
export interface RedeliveryRowStatus {
  unanswerable: boolean;
  candidateDevices: number;
  pendingDevices: number;
}
const redeliveryStatusCache = new Map<string, { at: number; byId: Map<string, RedeliveryRowStatus> }>();
const redeliveryStatusInFlight = new Map<string, Promise<void>>();
const redeliveryStatusSubs = new Set<() => void>();
export function subscribeRedeliveryStatus(cb: () => void): () => void {
  redeliveryStatusSubs.add(cb);
  return () => { redeliveryStatusSubs.delete(cb); };
}
export function getRedeliveryRowStatus(conversationId: string, messageId: string): RedeliveryRowStatus | null {
  const c = redeliveryStatusCache.get(String(conversationId));
  return c ? c.byId.get(String(messageId)) || null : null;
}
export function loadRedeliveryStatus(conversationId: string): Promise<void> {
  const cid = String(conversationId || "");
  if (!cid || !myToken || !myDeviceId || !isE2EEEnabled()) return Promise.resolve();
  const c = redeliveryStatusCache.get(cid);
  if (c && Date.now() - c.at < 30_000) return Promise.resolve();
  const inFlight = redeliveryStatusInFlight.get(cid);
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      const r: any = await api.e2eeRedeliverStatus(myToken!, cid, myDeviceId);
      const byId = new Map<string, RedeliveryRowStatus>();
      for (const a of (r && r.asks) || []) {
        if (a && a.messageId)
          byId.set(String(a.messageId), {
            unanswerable: !!a.unanswerable,
            candidateDevices: Number(a.candidateDevices) || 0,
            pendingDevices: Number(a.pendingDevices) || 0,
          });
      }
      redeliveryStatusCache.set(cid, { at: Date.now(), byId });
      redeliveryStatusSubs.forEach((cb) => { try { cb(); } catch (_) { } });
    } catch (_) {
      /* keep whatever we had */
    } finally {
      redeliveryStatusInFlight.delete(cid);
    }
  })();
  redeliveryStatusInFlight.set(cid, run);
  return run;
}

// One report of everything that decides whether THIS device can show history:
// the local state (keys held, markers, recovery phase, what was tried) and the
// server's view (account key, backup, devices, stored asks). Shown in Settings
// › Security so a support screenshot says exactly which source is missing.
export async function e2eeDiagnostics(): Promise<any> {
  const local: any = {
    e2eeEnabled: isE2EEEnabled(),
    userId: myUserId,
    deviceId: myDeviceId,
    initOk: _initOk,
    freshEnrollThisSession: _freshEnrollThisSession,
    chatBackupEnabled,
    recovery: { ...recoveryState },
    recoveryPaths: getRecoveryPathsCached(),
    holdsBackupKey: false,
    holdsRecoverySecret: false,
    redeliveryAsksThisSession: redeliveryAskedAt.size,
    markers: {} as Record<string, string | null>,
  };
  try { local.holdsBackupKey = !!(await signalStore.getRecoveryKek()); } catch (_) { }
  try { local.holdsRecoverySecret = !!(await signalStore.getRecoverySecret()); } catch (_) { }
  try {
    for (const k of ["e2ee_device_registered", "e2ee_recovery_backup_at", "e2ee_recovery_entry_count", "e2ee_recovery_watermark", FULL_WALK_KEY]) {
      local.markers[k] = localStorage.getItem(k);
    }
  } catch (_) { }
  let server: any = null;
  if (myToken) {
    try {
      server = await api.e2eeDiagnostics(myToken, myDeviceId);
    } catch (e: any) {
      server = { error: (e && e.status ? e.status + " " : "") + String(e && e.message ? e.message : e).slice(0, 160) };
    }
  }
  return { at: new Date().toISOString(), local, server };
}

// Re-deliveries arrive in bursts (one event per message a peer re-sealed).
// Coalesce them per conversation: refresh once, 1.5 s after the LAST one, so
// the thread is refetched after the whole burst has been stored instead of
// once per message in the middle of it.
const redeliveredTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function onRedelivered(conversationId: string, messageId: string): void {
  if (!conversationId) return;
  if (messageId) redeliveryAskedAt.delete(String(messageId));
  const cid = String(conversationId);
  const prev = redeliveredTimers.get(cid);
  if (prev) clearTimeout(prev);
  redeliveredTimers.set(
    cid,
    setTimeout(() => {
      redeliveredTimers.delete(cid);
      try { onHistoryRestored && onHistoryRestored([cid]); } catch (_) { }
    }, 1500),
  );
}

// Persist the plaintext of a message THIS device sent, under the server's id.
// decryptMessageList checks this cache before touching envelopes, so a sender
// can always re-read their own message after a reload even if the self-envelope
// is missing or unreadable. Without it the sender's copy depended entirely on
// the per-device self-echo, and any gap there was unrecoverable — the plaintext
// existed nowhere else on the device.
export async function rememberSentPlaintext(messageId: string, text: string): Promise<void> {
  try {
    if (!messageId || typeof text !== "string" || !text) return;
    await signalStore.putCachedPlaintext(String(messageId), { text });
    scheduleBackupRefresh();
  } catch (_) {
    /* best-effort cache; never block or fail a send */
  }
}

// The backup must never fall DAYS behind. A device that loses its local state
// (a re-enrolment, a reinstall, a deployment that reset the server's device
// rows) restores exactly what the backup held — so a backup last refreshed at
// some boot a week earlier is how "messages from the last N days are
// unavailable" happens on a device that never changed. Refresh a few minutes
// after new messages settle, not only at init; refreshRecoveryBackup's own
// floor + watermark gates keep this from thrashing, and the refresh itself is
// incremental (merge, not a full re-walk).
const BACKUP_REFRESH_DEBOUNCE_MS = 3 * 60_000;
let backupRefreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleBackupRefresh(): void {
  if (!isE2EEEnabled() || !myToken || backupRefreshTimer) return;
  backupRefreshTimer = setTimeout(() => {
    backupRefreshTimer = null;
    if (!myToken) return;
    void refreshRecoveryBackup(myToken, { afterActivity: true }).catch(() => { });
  }, BACKUP_REFRESH_DEBOUNCE_MS);
}
// Coverage. These used to be 500 / 365d / 8000, which quietly meant a new device
// only ever got back a recent WINDOW of history and everything older stayed
// unreadable forever — however well the restore itself worked. The backup is
// now bounded by BYTES (trimmed oldest-first, see RECOVERY_MAX_PLAINTEXT_BYTES)
// rather than by a short count, and the backup gather ignores the activity
// window entirely.
const SYNC_MAX_PER_CONV = 5000; // per-conversation ceiling (pages × 50)
const SYNC_MAX_PAGES_PER_CONV = 100; // server pages of 50 walked per conversation
// The history walk is the one thing here that can fire hundreds of requests in
// a row. Pace it under the API throttle (600/min per user) and, when a page is
// throttled anyway, wait and retry that page instead of dropping the rest of
// the conversation — a partial walk is a partial backup.
const WALK_MIN_GAP_MS = 130; // ≈ 460 pages/min, under the 600/min budget with room for the app
let walkLastAt = 0;
async function pacedGetMessages(token: string, convId: string, before?: string): Promise<any[]> {
  for (let attempt = 0; ; attempt++) {
    const wait = walkLastAt + WALK_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    walkLastAt = Date.now();
    try {
      return (await api.getMessages(token, convId, before ? { before } : undefined)) || [];
    } catch (e: any) {
      const status = e && typeof e.status === "number" ? e.status : 0;
      if (status !== 429 || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); // let the window roll over
    }
  }
}
const SYNC_ACTIVE_DAYS = 365; // device-link FULL sync: only conversations active within this window
const SYNC_MAX_TOTAL = 100_000; // overall entry cap across all conversations
const SYNC_CHUNK_BUDGET = 3_500_000; // keep each chunk's JSON < 4MB ciphertext budget
// Plaintext-JSON budget for the recovery backup. Base64 inflates ×1.37 and the
// server caps the backup at 64MB of ciphertext, so 40MB of JSON stays under it
// with margin. Oldest entries are dropped first when this is exceeded.
const RECOVERY_MAX_PLAINTEXT_BYTES = 40_000_000;

type SyncEntry = {
  convId: string;
  msgId: string;
  senderDeviceId: string;
  ts: any;
  type: any;
  text: string;
};

// Recover the ORIGINAL plaintext (for files: the {type:"file",key,iv} JSON) for a
// single message WITHOUT mutating forward-secrecy state. Prefers the local cache
// (which holds text for OPK/ratchet messages); only re-decrypts plain ECIES /
// group envelopes (which are stateless), so an OPK private half is never needed.
async function recoverPlaintextForSync(m: any): Promise<string | null> {
  // Cache hit (covers OPK/ratchet text already decrypted this device's lifetime).
  try {
    const cached = await signalStore.getCachedPlaintext(String(m.id));
    if (cached && typeof cached.text === "string") return cached.text;
  } catch (_) { }

  const ct = m.ciphertext;
  const isDm = m.encrypted && Array.isArray(ct);
  const isGroup = m.encrypted && ct && !Array.isArray(ct) && (ct as any).t === 2;
  if (!isDm && !isGroup) {
    // Unencrypted (legacy) message — its own `text` is already plaintext.
    return typeof m.text === "string" ? m.text : null;
  }
  try {
    if (isGroup) {
      const dec = await decryptGroupEnvelope(ct, m.conversationId);
      return dec.text;
    }
    const myEnv = (ct as any[]).find(
      (e: any) => e.recipientId === myUserId && String(e.recipientDeviceId) === String(myDeviceId),
    );
    if (!myEnv) return null;
    // type:3 ratchet and OPK-bearing ECIES are stateful — only the cache (checked
    // above) can serve them safely. Re-decrypting plain ECIES is stateless.
    if (myEnv.type === 3) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64dec(myEnv.body)));
    if (payload && payload.opk) return null; // forward-secret: key already gone
    const senderId =
      (myEnv.redeliveredBy && myEnv.redeliveredBy.userId) || (m.sender && m.sender.id);
    const dec = await decryptEnvelope(senderId, myEnv.senderDeviceId, myEnv.body, m.conversationId);
    return dec.text;
  } catch (_) {
    return null;
  }
}

// Shared entry-gathering for BOTH history mechanisms: Mechanism A (device-link
// sync, buildHistoryBundleForDevice) and Mechanism B (recovery backup). Walks the
// same DM/group/channel conversations within the active window, applies the same
// per-conv / total caps, skips the same plaintext-metadata message types, and
// recovers each message's ORIGINAL plaintext (file-message {type,key,iv} JSON
// included, via recoverPlaintextForSync). Extracting this does NOT change
// Mechanism A's behaviour — it is the exact loop A used inline.
async function gatherHistoryEntries(
  token: string,
  opts?: {
    convIds?: string[] | null;
    /** Ignore the activity window: walk EVERY conversation (backup gather). */
    allTime?: boolean;
    /** Incremental: only messages newer than this epoch-ms watermark. */
    sinceTs?: number;
    /** Called for every per-device encrypted message this device cannot read. */
    onUnreadable?: (m: any) => void;
  },
): Promise<SyncEntry[]> {
  const cutoff = Date.now() - SYNC_ACTIVE_DAYS * 24 * 3600 * 1000;
  // Targeted mode (on-demand heal): only the requested conversations, and NO
  // activity cutoff — the requester is literally staring at an unreadable
  // message in them, however old the conversation is.
  const only = opts?.convIds && opts.convIds.length ? new Set(opts.convIds) : null;
  const sinceTs = opts?.sinceTs && opts.sinceTs > 0 ? opts.sinceTs : 0;
  let convs: any[] = [];
  try {
    convs = (await api.getConversations(token)) || [];
  } catch (_) {
    return [];
  }
  const entries: SyncEntry[] = [];
  for (const c of convs) {
    if (entries.length >= SYNC_MAX_TOTAL) break;
    // DM / group / channel only (self-notes and call rooms carry nothing useful
    // to re-key here; group/channel history still re-keys via the shared epoch).
    if (!(c.kind === "dm" || c.kind === "group" || c.kind === "channel")) continue;
    const lastTs = c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : NaN;
    if (only) {
      if (!only.has(c.id)) continue;
    } else if (sinceTs) {
      // Incremental: nothing newer than the watermark → nothing to gather here.
      if (!Number.isNaN(lastTs) && lastTs <= sinceTs) continue;
    } else if (!opts?.allTime) {
      if (!Number.isNaN(lastTs) && lastTs < cutoff) continue; // inactive
    }
    // PAGINATE. api.getMessages returns ONE server page (50), so the advertised
    // SYNC_MAX_PER_CONV window was never actually reached — a "successful"
    // restore on a new device brought back only the last 50 messages per
    // conversation. Walk backwards with the `before` cursor until we have the
    // window, run out of history, reach the watermark, or stop making progress.
    let msgs: any[] = [];
    try {
      let before: string | undefined;
      for (let page = 0; page < SYNC_MAX_PAGES_PER_CONV; page++) {
        const batch = await pacedGetMessages(token, c.id, before);
        if (!batch.length) break;
        // Server returns oldest→newest within a page; prepend older pages.
        msgs = batch.concat(msgs);
        if (msgs.length >= SYNC_MAX_PER_CONV) break;
        const oldest = batch[0];
        // Incremental: this page already reaches back past the watermark.
        const oldestTs = oldest && oldest.createdAt ? new Date(oldest.createdAt).getTime() : NaN;
        if (sinceTs && !Number.isNaN(oldestTs) && oldestTs <= sinceTs) break;
        const nextBefore = oldest && String(oldest.id || "");
        if (!nextBefore || nextBefore === before) break; // no progress → stop
        before = nextBefore;
      }
    } catch (_) {
      if (!msgs.length) continue;
    }
    const recent = msgs.slice(-SYNC_MAX_PER_CONV);
    for (const m of recent) {
      if (entries.length >= SYNC_MAX_TOTAL) break;
      // Skip call/meeting/invite — they carry plaintext metadata by design (V8)
      // and are not E2EE history to re-key. A VOICE note is an encrypted
      // attachment like any other file (its plaintext is the {type,key,iv}
      // envelope), so it IS carried — leaving it out meant every voice note was
      // silently missing from a restored device.
      const mt = m.type;
      if (mt === "call" || mt === "meeting" || mt === "invite") continue;
      if (sinceTs) {
        const t = m.createdAt ? new Date(m.createdAt).getTime() : NaN;
        if (!Number.isNaN(t) && t <= sinceTs) continue;
      }
      const text = await recoverPlaintextForSync(m);
      if (text == null) {
        if (opts?.onUnreadable && Array.isArray(m.ciphertext)) opts.onUnreadable(m);
        continue;
      }
      entries.push({
        convId: c.id,
        msgId: String(m.id),
        senderDeviceId: String(myDeviceId),
        ts: m.createdAt,
        type: mt,
        text,
      });
    }
  }
  return entries;
}

// Build + upload a bounded recent-history bundle, ECIES-encrypted to a single
// target device. Idempotent per target (localStorage marker). Reuses read +
// encrypt primitives only — does NOT alter new-message encryption gating.
// How many sibling devices an init proactively pushes a FULL history bundle to.
// Every push costs one full history walk's worth of upload; the walk itself is
// done once and shared. Siblings beyond this (sorted most-recently-seen first)
// are covered by their own asks (requestAllHistoryHeal) when they actually need
// history — pushing to every device row an account has ever registered (each
// browser profile and every reinstall is a row) is what fired hundreds of
// requests in a few seconds at init and tripped the API rate limiter.
const MAX_PROACTIVE_SYNC_TARGETS = 3;

// Proactive device-link sync at init: ONE history gather, pushed to at most a
// few of the most recently active siblings that have not been synced yet.
async function pushHistoryToSiblings(token: string, siblingIds: string[]): Promise<void> {
  if (!isE2EEEnabled() || !myUserId || !myDeviceId) return;
  const pending = (siblingIds || []).filter(
    (d) => String(d) !== String(myDeviceId) && !alreadySyncedTo(d),
  );
  if (!pending.length) return;
  // Most recently seen first. listDevices carries lastSeenAt/createdAt; a device
  // the list does not know sorts last.
  let seenAt = new Map<string, number>();
  try {
    const devs = (await api.e2eeDevices(token).catch(() => [])) as any[];
    for (const d of devs || []) {
      const t = Date.parse(d?.lastSeenAt || d?.createdAt || "");
      seenAt.set(String(d.id), Number.isNaN(t) ? 0 : t);
    }
  } catch (_) { seenAt = new Map(); }
  const targets = pending
    .sort((a, b) => (seenAt.get(String(b)) || 0) - (seenAt.get(String(a)) || 0))
    .slice(0, MAX_PROACTIVE_SYNC_TARGETS);
  const entries = await gatherHistoryEntries(token, {});
  for (const d of targets) {
    await buildHistoryBundleForDevice(token, d, { entries, established: true }).catch(() => { });
  }
  if (pending.length > targets.length)
    console.info("[e2ee] proactive history sync: pushed to %d of %d unsynced sibling device(s); the rest sync on request", targets.length, pending.length);
}

export async function buildHistoryBundleForDevice(
  token: string,
  targetDeviceId: string,
  opts?: {
    convIds?: string[] | null;
    /** Pre-gathered entries (a full, non-targeted gather) to reuse across targets. */
    entries?: SyncEntry[];
    /** The caller already ran ensureSessionsForUser for this user in this pass. */
    established?: boolean;
  },
): Promise<void> {
  if (!isE2EEEnabled() || !myUserId || !myDeviceId) return;
  if (String(targetDeviceId) === String(myDeviceId)) return;
  const targeted = !!(opts?.convIds && opts.convIds.length);
  // Pin/cache the target device's published identity pubkey. ensureSessionsForUser
  // does NOT skip targetDeviceId (it only skips my OWN device), so on success the
  // target's pubkey lands in pubKeyCache.
  if (!opts?.established || !pubKeyCache.has(myUserId + ":" + targetDeviceId)) {
    try {
      await ensureSessionsForUser(token, myUserId);
    } catch (_) { }
  }
  if (!pubKeyCache.has(myUserId + ":" + targetDeviceId)) return; // not trusted yet

  const entries =
    opts?.entries && !targeted
      ? opts.entries
      : await gatherHistoryEntries(token, { convIds: opts?.convIds || null });
  if (!entries.length) {
    // Targeted heals never mark: this device simply has nothing for those
    // conversations — another device might, and a later full sync must not be
    // suppressed by an empty targeted attempt.
    if (!targeted) markSyncedTo(targetDeviceId); // nothing to send, but don't retry forever
    return;
  }

  // Chunk so each chunk's JSON stays under the relay's 4MB per-chunk ceiling.
  const chunks: SyncEntry[][] = [];
  let cur: SyncEntry[] = [];
  let curBytes = 2;
  for (const e of entries) {
    const sz = JSON.stringify(e).length + 1;
    if (cur.length && curBytes + sz > SYNC_CHUNK_BUDGET) {
      chunks.push(cur);
      cur = [];
      curBytes = 2;
    }
    cur.push(e);
    curBytes += sz;
  }
  if (cur.length) chunks.push(cur);

  const bundleId =
    typeof crypto !== "undefined" && (crypto as any).randomUUID
      ? (crypto as any).randomUUID()
      : "b" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const chunkCount = chunks.length;
  try {
    for (let i = 0; i < chunkCount; i++) {
      const env = await encryptToDevice(
        myUserId,
        targetDeviceId,
        JSON.stringify(chunks[i]),
        "",
        { token, useOpk: false },
      );
      await api.e2eePutHistorySync(
        token,
        targetDeviceId,
        bundleId,
        i,
        chunkCount,
        env.body,
        HISTORY_SYNC_ALGO,
      );
    }
    // Targeted heals stay unmarked — the full-bundle idempotency marker must
    // only ever be set by a FULL sync.
    if (!targeted) markSyncedTo(targetDeviceId);
  } catch (_) {
    // Leave the marker UNSET so a later init retries this target.
  }
}

// On init: fetch any relay chunks addressed to THIS device, decrypt them, merge
// plaintext into the local cache, ack (delete-after-fetch), and notify the UI to
// refresh the touched conversations.
export async function restoreSyncBundle(): Promise<void> {
  if (!isE2EEEnabled() || !myDeviceId || !myToken) return;
  let rows: any[] = [];
  try {
    rows = (await api.e2eeGetHistorySync(myToken)) || [];
  } catch (_) {
    rows = [];
  }
  if (!rows.length) return;

  // Group chunks by bundle, ordered by chunkIndex.
  const byBundle = new Map<string, any[]>();
  for (const r of rows) {
    const arr = byBundle.get(r.bundleId) || [];
    arr.push(r);
    byBundle.set(r.bundleId, arr);
  }
  const touched = new Set<string>();
  for (const [, chunkRows] of byBundle) {
    chunkRows.sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));
    for (const chunk of chunkRows) {
      try {
        const { text } = await decryptEnvelope(
          myUserId!,
          chunk.sourceDeviceId || myDeviceId,
          chunk.ciphertext,
          "",
        );
        const list: SyncEntry[] = JSON.parse(text);
        for (const entry of list) {
          try {
            const existing = await signalStore
              .getCachedPlaintext(String(entry.msgId))
              .catch(() => null);
            if (existing && existing.text != null) continue; // idempotent
            await signalStore.putCachedPlaintext(String(entry.msgId), { text: entry.text });
            // B2 — anchor at the synced message's server createdAt (entry.ts).
            await pinConvE2EE(entry.convId, entry.ts);
            touched.add(entry.convId);
          } catch (_) {
            // one bad entry must never block the rest
          }
        }
      } catch (_) {
        // one bad chunk must never block the rest
      }
    }
  }
  try {
    await api.e2eeAckHistorySync(myToken, null); // delete-after-fetch (all my rows)
  } catch (_) { }
  try {
    onHistoryRestored?.([...touched]);
  } catch (_) { }
  for (const c of touched) markBackupDirty(c); // older than the walk, by definition
  if (touched.size) scheduleBackupRefresh(); // what a sibling gave us belongs in the backup too
}

// ==================================================================
// Mechanism B — server-blind encrypted history RECOVERY BACKUP.
//
// The WhatsApp encrypted-backup model: a user holds a ONE-TIME recovery key
// (32 random bytes, shown once as grouped base32). We derive a KEK via
// HKDF-SHA256(ikm=recoveryKey, salt=16 random bytes, info="colab-e2ee-recovery-v1")
// → a NON-EXTRACTABLE AES-GCM-256 key, AES-GCM encrypt the SAME bounded history
// entries Mechanism A gathers, and upload ONLY opaque base64 ciphertext + iv +
// the (non-secret) salt. A new/reset device, given the recovery key, re-derives
// the KEK from key+salt and decrypts locally. AES-GCM auth-tag failure on restore
// IS the "wrong key" signal — no verifier is stored. The KEK is cached locally
// (IndexedDB recoveryKek store) so this device auto-refreshes the backup without
// re-prompting; user-switch/device-reset clear it (a wiped device then needs the
// user's recovery key — correct).
// ==================================================================

const RECOVERY_INFO = "colab-e2ee-recovery-v1";
const RECOVERY_PAYLOAD_VERSION = 1;
// Keep each per-chunk plaintext JSON under 3MB (well below the 4MB ciphertext
// growth ceiling once base64-expanded) so the server stays within MEDIUMTEXT.
const RECOVERY_CHUNK_BUDGET = 3_000_000;

// Crockford-ish uppercase base32 (RFC 4648 alphabet, no padding). 32 bytes →
// 52 base32 chars, grouped in 4s with dashes for legibility.
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function bytesToBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function groupRecoveryKey(b32: string): string {
  return (b32.match(/.{1,4}/g) || []).join("-");
}
// Parse tolerantly: strip dashes/spaces, uppercase, map back through the base32
// alphabet. Returns the 32 raw bytes, or null if the string can't decode to >=32.
function parseRecoveryKey(input: string): Uint8Array<ArrayBuffer> | null {
  const clean = String(input || "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) return null; // stray char → reject (caller shows "doesn't match")
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length < 32) return null;
  const buf = new Uint8Array(new ArrayBuffer(32));
  buf.set(out.slice(0, 32));
  return buf;
}

// HKDF-SHA256(recoveryKeyBytes, salt, info) → non-extractable AES-GCM-256 key.
async function deriveRecoveryKek(
  recoveryKeyBytes: Uint8Array<ArrayBuffer>,
  saltBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    recoveryKeyBytes,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: utf8(RECOVERY_INFO) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false, // NON-extractable
    ["encrypt", "decrypt"],
  );
}

// Chunk the gathered entries into JSON payloads under the budget, AES-GCM encrypt
// each under the KEK with a fresh 12-byte iv, and return base64 {ciphertext,iv}.
async function buildRecoveryChunks(
  kek: CryptoKey,
  entries: SyncEntry[],
): Promise<{ index: number; count: number; ciphertext: string; iv: string }[]> {
  const groups: SyncEntry[][] = [];
  let cur: SyncEntry[] = [];
  let curBytes = 2;
  for (const e of entries) {
    const sz = JSON.stringify(e).length + 1;
    if (cur.length && curBytes + sz > RECOVERY_CHUNK_BUDGET) {
      groups.push(cur);
      cur = [];
      curBytes = 2;
    }
    cur.push(e);
    curBytes += sz;
  }
  if (cur.length) groups.push(cur);
  // ALWAYS emit at least one chunk, even with zero entries: the server rejects
  // an empty-chunks upload, and a first backup is legitimately empty (a device
  // that set up the backup before any history accrued). A later refresh reuses
  // the same salt + KEK to populate it — but only if the empty backup + its
  // password wrap were stored in the first place.
  if (groups.length === 0) groups.push([]);
  const out: { index: number; count: number; ciphertext: string; iv: string }[] = [];
  for (let i = 0; i < groups.length; i++) {
    const payload = JSON.stringify({ v: RECOVERY_PAYLOAD_VERSION, entries: groups[i] });
    const iv = randBytes(12);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      kek,
      utf8(payload),
    );
    out.push({ index: i, count: groups.length, ciphertext: b64enc(ct), iv: b64enc(iv) });
  }
  return out;
}

// Typed error so the panel can show a friendly "that recovery key doesn't match".
export class WrongRecoveryKeyError extends Error {
  constructor() {
    super("That recovery key doesn't match.");
    this.name = "WrongRecoveryKeyError";
  }
}

// Status for the Settings panel. enabled = a local KEK is cached (this device can
// auto-refresh); hasServerBackup = the server holds rows; lastBackupAt is a
// best-effort local marker of the last successful upload from this device.
export async function recoveryBackupStatus(): Promise<{
  enabled: boolean;
  hasServerBackup: boolean;
  lastBackupAt: number | null;
}> {
  if (!isE2EEEnabled()) return { enabled: false, hasServerBackup: false, lastBackupAt: null };
  let enabled = false;
  try {
    enabled = !!(await signalStore.getRecoveryKek());
  } catch (_) { }
  let hasServerBackup = false;
  try {
    if (myToken) hasServerBackup = backupHasContent(await api.e2eeGetRecoveryBackupMeta(myToken));
  } catch (_) { }
  let lastBackupAt: number | null = null;
  try {
    const v = localStorage.getItem("e2ee_recovery_backup_at");
    lastBackupAt = v ? Number(v) : null;
  } catch (_) { }
  return { enabled, hasServerBackup, lastBackupAt };
}

// Generate a fresh recovery key + salt, derive + cache the KEK, build + encrypt +
// upload the backup, and return the GROUPED recovery-key string for one-time
// display. Never throws a half-state: the KEK is only cached after a successful
// upload (so status stays consistent if the network fails).
export async function enableRecoveryBackup(token: string): Promise<string> {
  if (!isE2EEEnabled()) throw new Error("E2EE disabled");
  invalidateRecoveryPaths();
  const recoveryKeyBytes = randBytes(32);
  const saltBytes = randBytes(16);
  const kek = await deriveRecoveryKek(recoveryKeyBytes, saltBytes);
  const entries = trimToBudget(
    await gatherHistoryEntries(token, { allTime: true }),
    RECOVERY_MAX_PLAINTEXT_BYTES,
  );
  const chunks = entries.length
    ? await buildRecoveryChunks(kek, entries)
    : // Always upload at least one (possibly empty) chunk so the backup exists and
    // can be restored/extended later even before any history accrues.
    await buildRecoveryChunks(kek, []);
  await api.e2eePutRecoveryBackup(token, b64enc(saltBytes), chunks);
  invalidateBackupBody();
  try {
    await signalStore.putRecoveryKek(kek);
  } catch (_) { }
  // Slice 2: retain the raw 32-byte secret so a recovery passphrase can wrap the
  // SAME secret later (a new wrap must not rotate/invalidate the existing backup).
  await persistRecoverySecret(recoveryKeyBytes);
  try {
    localStorage.setItem("e2ee_recovery_backup_at", String(Date.now()));
  } catch (_) { }
  return groupRecoveryKey(bytesToBase32(recoveryKeyBytes));
}

// Opportunistic refresh: if a local KEK is cached, rebuild + re-encrypt + replace
// the server backup. Best-effort — NEVER throws (called from initE2EE). Reuses the
// cached KEK + the server's stored salt (re-derivation isn't possible without the
// recovery key, which we never persist — the cached KEK IS the persisted form).
// WhatsApp-style "Chat backup" toggle. When OFF, the AUTOMATIC backup writers
// (this refresh + ensurePasswordBackup's create/rotate branches) stop uploading
// new history chunks / password wraps. RESTORE of an existing backup, same-device
// decrypt, and device-link sync are ALL untouched — so nothing throws and OFF is
// fully reversible (OFF→ON resumes on the next init/login). Default ON (today's
// behaviour). Driven by the user's `chatBackup` setting via setChatBackupEnabled.
let chatBackupEnabled = true;
export function setChatBackupEnabled(v: boolean): void {
  chatBackupEnabled = v !== false;
}

// localStorage key: the salt of the server backup this device has walked in
// FULL (contributed every message it could read). See planRefreshGather.
const FULL_WALK_KEY = "e2ee_recovery_full_walk";

// The full backup body (every chunk) is the largest thing this module fetches,
// and one session used to download it a dozen times: every recovery pass, the
// refresh, the keychain and account-key restores. Keep the last body for a
// minute; every publish and every key drop invalidates it.
const BACKUP_BODY_TTL_MS = 60_000;
let backupBodyCache: { at: number; token: string; body: any } | null = null;
function invalidateBackupBody(): void {
  backupBodyCache = null;
}
async function fetchRecoveryBackupBody(token: string): Promise<any> {
  if (backupBodyCache && backupBodyCache.token === token && Date.now() - backupBodyCache.at < BACKUP_BODY_TTL_MS)
    return backupBodyCache.body;
  const body = await api.e2eeGetRecoveryBackup(token);
  backupBodyCache = { at: Date.now(), token, body };
  return body;
}

// Conversations in which a message OLDER than this device's walk watermark
// became readable late (a sibling bundle, a re-delivered envelope, a group key
// that arrived after the walk). The incremental gather only looks past the
// watermark, so these are re-walked in full on the next refresh and cleared
// once that publish succeeds.
const backupDirtyConvs = new Set<string>();
function markBackupDirty(conversationId: string | null | undefined, createdAt?: any): void {
  if (!conversationId) return;
  let wm = 0;
  try { wm = Number(localStorage.getItem("e2ee_recovery_watermark") || "0") || 0; } catch (_) { }
  const t = createdAt ? new Date(createdAt).getTime() : 0;
  // Newer than the watermark → the normal incremental gather covers it.
  if (wm && Number.isFinite(t) && t > wm) return;
  backupDirtyConvs.add(String(conversationId));
}

export async function refreshRecoveryBackup(
  token: string,
  opts?: {
    /** The debounced run after new activity. It is already spaced out by
     *  BACKUP_REFRESH_DEBOUNCE_MS, so the session floor must not swallow it —
     *  the floor (5 min) is longer than the debounce (3 min), which meant a
     *  message received right after boot never reached the backup until the
     *  next boot, and a device restored from that backup lacked it. */
    afterActivity?: boolean;
  },
): Promise<void> {
  if (!isE2EEEnabled() || !chatBackupEnabled) return;
  try {
    const kek = await signalStore.getRecoveryKek();
    if (!kek) return; // backup not set up on this device
    // THROTTLE: this walks every active conversation and PAGES through history,
    // so running the full walk on every boot would hammer the server (~100 users
    // reconnecting after a deploy each firing a burst of sequential fetches).
    //
    // It must NOT be a blind timer. A fixed once-a-day throttle meant every
    // message sent since the last backup was missing from the backup for up to
    // 24h — and this backup IS the no-other-device-online restore path, so a new
    // device set up inside that window came back with a hole in its history
    // (exactly the "[Encrypted — not available on this device]" wall this
    // mechanism exists to prevent). "Device-link sync already covers new
    // messages" is only true when another device is actually online.
    //
    // So: gate on CONTENT, not on the clock. The conversation list already
    // carries lastMessageAt, so one cheap request tells us whether anything is
    // newer than what the last backup captured. Nothing new → one request and we
    // stop. Something new → pay for the walk, because the backup is genuinely
    // stale. A short floor still prevents thrash within a single session.
    const FLOOR_MS = 5 * 60 * 1000;
    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    let lastAt = 0;
    let watermark = 0;
    let priorCount = 0;
    // Salt of the backup THIS device has already contributed its whole readable
    // history to (see planRefreshGather). Unset → this device still owes the
    // backup a full walk, and no floor or watermark may hold that back: it is
    // how history that only this device can still read reaches the others.
    let fullWalkSalt: string | null = null;
    try {
      lastAt = Number(localStorage.getItem("e2ee_recovery_backup_at") || "0") || 0;
      watermark = Number(localStorage.getItem("e2ee_recovery_watermark") || "0") || 0;
      priorCount = Number(localStorage.getItem("e2ee_recovery_entry_count") || "0") || 0;
      fullWalkSalt = localStorage.getItem(FULL_WALK_KEY) || null;
    } catch (_) { }
    // An EMPTY backup is worthless as a safety net, so no timer may hold it back.
    // The initial backup is created at enrolment — before the account has any
    // history — and that write starts the throttle clock with entry_count 0. A
    // blind timer therefore froze a brand-new user's backup in its empty state:
    // add a second device inside the window with the first one offline, and the
    // restore brought back NOTHING while reporting success. Always refresh until
    // the backup actually holds something.
    const backupIsEmpty = priorCount <= 0;
    if (!opts?.afterActivity && !backupIsEmpty && fullWalkSalt && lastAt && Date.now() - lastAt < FLOOR_MS) return;
    // Newest message this account can see right now.
    let newest = 0;
    try {
      for (const c of (await api.getConversations(token)) || []) {
        if (!(c.kind === "dm" || c.kind === "group" || c.kind === "channel")) continue;
        const t = c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : 0;
        if (Number.isFinite(t) && t > newest) newest = t;
      }
    } catch (_) {
      // Can't tell whether we're stale — fall through and let the walk decide
      // rather than skipping (never trade correctness for a saved request here).
    }
    const staleByAge = !lastAt || Date.now() - lastAt > MAX_AGE_MS;
    // watermark of 0 = never recorded (or a device from before this field
    // existed) → always refresh once, which self-heals those devices.
    if (!backupIsEmpty && fullWalkSalt && !staleByAge && watermark && newest && newest <= watermark)
      return;
    // Metadata only — the salt and a one-chunk probe. The full backup is
    // downloaded ONLY when there is something to merge into.
    const meta: any = await api.e2eeGetRecoveryBackupMeta(token).catch(() => null);
    const saltB64: string | null = meta && meta.salt ? meta.salt : null;
    if (!saltB64) return; // no server backup to refresh against (salt is the anchor)
    // STALE-KEY GUARD. If this device's cached key no longer opens the server
    // backup (another device rotated the secret), publishing chunks under it
    // would corrupt the backup for every OTHER device while this one kept
    // "refreshing" a backup nobody else could read. Drop the stale key so the
    // automatic recovery re-acquires the current one, and publish nothing.
    if (meta.probe && !(await kekOpensChunk(kek, meta.probe))) {
      await forgetLocalBackupKey("recovery refresh: cached backup key is stale");
      return;
    }
    // INCREMENTAL. Merge what the server backup already holds with only the
    // messages newer than the last watermark — instead of re-walking every
    // conversation and full-replacing the backup with whatever THIS device can
    // still read (which is how messages another device had contributed, or
    // this device had since evicted, silently fell out). A device's FIRST
    // publish walks everything with no activity cutoff: "all previous messages"
    // means all of them.
    const serverHasContent = backupHasContent(meta) && (Number(meta.byteLen) || 0) > 0;
    let existing: SyncEntry[] = [];
    if (serverHasContent) {
      const full = await fetchRecoveryBackupBody(token).catch(() => null);
      if (!full || !Array.isArray(full.chunks) || !full.chunks.length) return; // transient — next boot
      const dec = await decryptBackupEntries(kek, full);
      if (dec.failedChunks > 0) {
        console.warn("[e2ee] recovery refresh SKIPPED — %d backup chunk(s) unreadable", dec.failedChunks);
        return; // never re-publish a backup missing what we couldn't read
      }
      existing = dec.entries;
    }
    // A device's FIRST publish against this backup walks EVERYTHING it can read,
    // however old, and merges it in — even when the backup already holds
    // entries. "Resume from the backup's newest entry" was only right for the
    // device that seeded the backup; for every OTHER device it silently dropped
    // all the history that device alone could still read (the exact history a
    // device that lost its keys is waiting for). After that one walk, gathers
    // are incremental from the watermark.
    const plan = planRefreshGather({
      fullWalkSalt,
      backupSalt: saltB64,
      watermark,
      existingNewest: newestTs(existing),
    });
    const resumeFrom = plan.allTime ? 0 : plan.sinceTs;
    if (plan.allTime && existing.length)
      console.info("[e2ee] backup refresh: first full walk from this device (merging into %d existing entries)", existing.length);
    // A full walk visits every message anyway — collect what this device
    // cannot open on the way and ask for it in bulk, so the migration sweep
    // needs no second walk of its own.
    const unreadable: string[] = [];
    const unreadableSeen = new Set<string>();
    let fresh = await gatherHistoryEntries(
      token,
      plan.allTime
        ? {
            allTime: true,
            onUnreadable: (m) => {
              const id = String(m.id);
              if (!unreadableSeen.has(id)) { unreadableSeen.add(id); unreadable.push(id); }
            },
          }
        : { sinceTs: plan.sinceTs },
    );
    if (plan.allTime && !unreadableAuditRan) void submitUnreadableAsks(token, unreadable).catch(() => { });
    // Conversations where an OLD message became readable since the last walk:
    // re-walk them in full (the incremental gather above stops at the watermark).
    const dirty = plan.allTime ? [] : [...backupDirtyConvs];
    if (dirty.length) {
      const extra = await gatherHistoryEntries(token, { convIds: dirty });
      fresh = mergeEntries(fresh, extra);
    }
    if (!fresh.length) {
      if (!existing.length) return; // nothing to publish yet
      // Nothing new since the watermark (or nothing this device can add) —
      // record the check and stop.
      try {
        localStorage.setItem("e2ee_recovery_backup_at", String(Date.now()));
        localStorage.setItem("e2ee_recovery_entry_count", String(existing.length));
        const wm = Math.max(newest || 0, resumeFrom, newestTs(existing));
        if (wm) localStorage.setItem("e2ee_recovery_watermark", String(wm));
        if (plan.allTime) localStorage.setItem(FULL_WALK_KEY, saltB64);
      } catch (_) { }
      return;
    }
    const merged = trimToBudget(mergeEntries(existing, fresh), RECOVERY_MAX_PLAINTEXT_BYTES);
    const chunks = await buildRecoveryChunks(kek, merged);
    await api.e2eePutRecoveryBackup(token, saltB64, chunks);
    invalidateBackupBody();
    try {
      localStorage.setItem("e2ee_recovery_backup_at", String(Date.now()));
      localStorage.setItem("e2ee_recovery_entry_count", String(merged.length));
      // Watermark = the newest message this backup covers. The next boot compares
      // against it to decide whether another (incremental) walk is warranted.
      const wm = Math.max(newest || 0, newestTs(merged));
      if (wm) localStorage.setItem("e2ee_recovery_watermark", String(wm));
      // This device has now contributed everything it can read to THIS backup.
      if (plan.allTime) localStorage.setItem(FULL_WALK_KEY, saltB64);
    } catch (_) { }
    if (plan.allTime) backupDirtyConvs.clear();
    else for (const c of dirty) backupDirtyConvs.delete(c);
    if (plan.allTime && fresh.length)
      console.info("[e2ee] backup refresh: full walk merged %d entries (%d total)", fresh.length, merged.length);
  } catch (_) {
    /* refresh is best-effort; never block init */
  }
}

// Restore on a new/reset device from the user's recovery key. Fetches the server
// backup; if none → {restored:0,noBackup:true}. Derives the KEK from key+salt,
// AES-GCM-decrypts each chunk (auth-tag failure → WrongRecoveryKeyError), merges
// each entry into the local plaintext cache (idempotent), pins the conversation,
// caches the KEK locally, and notifies the UI. NEVER wipes local plaintext.
export async function restoreFromRecoveryKey(
  token: string,
  recoveryKeyStr: string,
): Promise<{ restored: number; noBackup?: boolean }> {
  if (!isE2EEEnabled()) return { restored: 0 };
  const recoveryKeyBytes = parseRecoveryKey(recoveryKeyStr);
  if (!recoveryKeyBytes) throw new WrongRecoveryKeyError();
  let backup: any = null;
  try {
    backup = await fetchRecoveryBackupBody(token);
  } catch (_) {
    backup = null;
  }
  if (!backup || !backup.salt || !backup.chunks || !backup.chunks.length) {
    return { restored: 0, noBackup: true };
  }
  const saltBytes = b64dec(backup.salt);
  const kek = await deriveRecoveryKek(recoveryKeyBytes, saltBytes);
  const restored = await restoreBackupWithKek(kek, backup);
  // Key proven correct → cache the KEK so this device auto-refreshes the backup.
  try {
    await signalStore.putRecoveryKek(kek);
  } catch (_) { }
  // Slice 2: keep the raw secret so this device can later add a recovery-passphrase
  // wrap of the SAME secret without rotating the backup.
  await persistRecoverySecret(recoveryKeyBytes);
  try {
    localStorage.setItem("e2ee_recovery_backup_at", String(Date.now()));
  } catch (_) { }
  return { restored };
}

// Shared restore core: decrypt every chunk under an already-derived KEK and
// merge the entries into the local plaintext cache (idempotent). Throws
// WrongRecoveryKeyError on the AES-GCM auth-tag failure — zero side effects
// happen before the first successful decrypt. Used by BOTH the manual
// recovery-key restore and the automatic password-unwrap restore.
async function restoreBackupWithKek(kek: CryptoKey, backup: any): Promise<number> {
  const ordered = [...backup.chunks].sort(
    (a: any, b: any) => (a.index || 0) - (b.index || 0),
  );
  let restored = 0;
  let seen = 0;
  let newest = 0;
  const touched = new Set<string>();
  for (const chunk of ordered) {
    let plain: string;
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64dec(chunk.iv) },
        kek,
        b64dec(chunk.ciphertext),
      );
      plain = new TextDecoder().decode(pt);
    } catch (_) {
      throw new WrongRecoveryKeyError(); // auth-tag failure = wrong key
    }
    let parsed: any;
    try {
      parsed = JSON.parse(plain);
    } catch (_) {
      continue; // corrupt chunk → skip, don't fail the whole restore
    }
    const list: SyncEntry[] = (parsed && parsed.entries) || [];
    for (const entry of list) {
      seen++;
      const t = entry && entry.ts != null ? new Date(entry.ts).getTime() : NaN;
      if (Number.isFinite(t) && t > newest) newest = t;
      try {
        const existing = await signalStore
          .getCachedPlaintext(String(entry.msgId))
          .catch(() => null);
        if (existing && existing.text != null) continue; // idempotent — don't clobber
        await signalStore.putCachedPlaintext(String(entry.msgId), { text: entry.text });
        await pinConvE2EE(entry.convId, entry.ts);
        touched.add(entry.convId);
        restored++;
      } catch (_) {
        // one bad entry must never block the rest
      }
    }
  }
  // Record what the backup holds so the refresh throttle knows it is NOT empty
  // (a freshly-restored device otherwise re-walked the backup on every boot) and
  // where an incremental refresh should resume from.
  try {
    const prev = Number(localStorage.getItem("e2ee_recovery_entry_count") || "0") || 0;
    if (seen > prev) localStorage.setItem("e2ee_recovery_entry_count", String(seen));
    // NOT the walk watermark: what the backup holds says nothing about what
    // THIS device has walked (see planRefreshGather). Advancing it here made
    // the next incremental gather skip every older message only this device
    // could read.
    void newest;
  } catch (_) { }
  try {
    onHistoryRestored?.([...touched]);
  } catch (_) { }
  // A restore that ran OUTSIDE the orchestrator (a password login, a typed
  // credential in the unlock box, the Security panel) just gave this device its
  // key: tell the UI so pending rows / the banner leave the "exhausted" state.
  if (recoveryState.phase !== "restoring") {
    setRecoveryState({
      type: "finish",
      at: Date.now(),
      restored,
      tried: ["credential"],
      keyHeld: true,
      credentialCouldUnlock: false,
    });
    invalidateRecoveryPaths();
  }
  return restored;
}

// AUTOMATIC restore from THIS device's OWN server-blind backup using its locally
// CACHED KEK — no sibling device, no password, no user action. This is what brings
// a device's own history back after its identity keypair diverged (the
// decrypt-failed case: old messages were sealed to a key this device no longer has,
// but their PLAINTEXT lives in the encrypted backup). Idempotent (restoreBackupWithKek
// merges, never clobbers), so it's safe to run on every boot. Returns entries merged.
export async function restoreFromCachedKek(token: string): Promise<number> {
  if (!isE2EEEnabled()) return 0;
  try {
    const kek = await signalStore.getRecoveryKek().catch(() => null);
    if (!kek) return 0; // no cached KEK on this device → nothing it can auto-open
    // Metadata first: is there anything, and does OUR key still open it? A
    // cached key that no longer opens the backup (the secret was rotated on
    // another device) must be DROPPED, not retried every boot — once it is gone
    // the other automatic sources (keychain, siblings) can re-acquire the
    // current key, and refreshRecoveryBackup can no longer publish under it.
    const meta: any = await api.e2eeGetRecoveryBackupMeta(token).catch((e) => noteTransient(e));
    if (!backupHasContent(meta)) return 0;
    if (meta.probe && !(await kekOpensChunk(kek, meta.probe))) {
      await forgetLocalBackupKey("cached backup key no longer opens the server backup");
      return 0;
    }
    const backup = await fetchRecoveryBackupBody(token).catch((e) => noteTransient(e));
    if (!backup || !Array.isArray(backup.chunks) || !backup.chunks.length) return 0;
    return await restoreBackupWithKek(kek, backup);
  } catch (_) {
    // A transient blip → skip; the next automatic pass tries again.
    return 0;
  }
}

// True for both the full backup and the ?meta=1 shape.
function backupHasContent(b: any): boolean {
  if (!b || !b.salt) return false;
  if (Array.isArray(b.chunks)) return b.chunks.length > 0;
  return (Number(b.chunkCount) || 0) > 0;
}

// One AES-GCM decrypt of a single chunk: the deterministic "is this the right
// key" test (a wrong key fails the auth tag, a network problem never reaches here).
async function kekOpensChunk(
  kek: CryptoKey,
  chunk: { ciphertext: string; iv: string } | null | undefined,
): Promise<boolean> {
  if (!chunk || !chunk.ciphertext || !chunk.iv) return false;
  try {
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64dec(chunk.iv) },
      kek,
      b64dec(chunk.ciphertext),
    );
    return true;
  } catch (_) {
    return false;
  }
}

// Drop every local copy of a backup key that has been proven stale, so no path
// keeps trying (or publishing under) a key the server backup no longer matches.
async function forgetLocalBackupKey(why: string): Promise<void> {
  console.warn("[e2ee] " + why + " — dropping the local backup key");
  invalidateBackupBody();
  try { await signalStore.clearRecoveryKek(); } catch (_) { }
  try { await signalStore.clearRecoverySecret(); } catch (_) { }
  try { await keychainClearSecret(); } catch (_) { }
  try {
    localStorage.removeItem("e2ee_recovery_backup_at");
    localStorage.removeItem("e2ee_recovery_entry_count");
    localStorage.removeItem("e2ee_recovery_watermark");
    localStorage.removeItem(FULL_WALK_KEY);
  } catch (_) { }
}

// Decrypt every chunk of a server backup into its entries WITHOUT merging them
// into the local cache. `failedChunks` counts chunks that could not be read —
// the incremental refresh must not re-publish a backup that lost those.
async function decryptBackupEntries(
  kek: CryptoKey,
  backup: any,
): Promise<{ entries: SyncEntry[]; failedChunks: number }> {
  const entries: SyncEntry[] = [];
  let failedChunks = 0;
  const ordered = [...((backup && backup.chunks) || [])].sort(
    (a: any, b: any) => (a.index || 0) - (b.index || 0),
  );
  for (const chunk of ordered) {
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64dec(chunk.iv) },
        kek,
        b64dec(chunk.ciphertext),
      );
      const parsed = JSON.parse(new TextDecoder().decode(pt));
      for (const e of (parsed && parsed.entries) || []) if (e && e.msgId) entries.push(e);
    } catch (_) {
      failedChunks++;
    }
  }
  return { entries, failedChunks };
}

// Persist the raw recovery secret everywhere this device keeps it: IndexedDB
// (next to the device keys) and, on desktop, the OS keychain — which is what
// lets a reinstall / cleared-app-data restore its history with no prompt. Then
// (re)publish the ACCOUNT wrap of this secret so every other signed-in device
// of the user can open the backup automatically — forced, because the secret
// may just have been rotated and an older account wrap would be stale.
async function persistRecoverySecret(bytes: Uint8Array): Promise<void> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  try { await signalStore.putRecoverySecret(copy); } catch (_) { }
  if (myUserId) {
    try { await keychainSaveSecret(myUserId, b64enc(copy)); } catch (_) { }
  }
  void ensureAccountWrap(myToken, true).catch(() => { });
}

// ── Server-escrowed ACCOUNT KEY (automatic recovery on any signed-in device) ──
// The server keeps one sealed random key per user and returns it only to that
// user's authenticated sessions (GET /api/e2ee/account-key). The recovery secret
// is wrapped under it as wrap kind 'account', exactly like the password and
// passphrase wraps. Any device that can sign in — SSO, a restored session, a
// reinstall, a brand-new browser — fetches the key, unwraps the secret and
// restores the whole backup with no prompt. Product decision (2026-09-22): the
// operator can open history BACKUPS with this; live messages stay E2EE.
async function unwrapSecretWithAccountKey(
  token: string,
  wrap: any,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const ak: any = await api.e2eeGetAccountKey(token).catch((e) => noteTransient(e));
  if (!ak || !ak.key) return null; // server has automatic recovery off
  try {
    const wrapKey = await derivePasswordWrapKey(
      String(ak.key),
      b64dec(wrap.salt),
      Number(wrap.iterations) || PASSWORD_WRAP_ITERATIONS,
    );
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64dec(wrap.iv) },
      wrapKey,
      b64dec(wrap.ct),
    );
    const out = new Uint8Array(new ArrayBuffer(pt.byteLength));
    out.set(new Uint8Array(pt));
    return out;
  } catch (_) {
    return null; // wrap made under a key the server no longer holds
  }
}

// Restore from the account wrap. Returns entries merged; 0 when no account
// wrap / no account key / the wrap doesn't open.
async function restoreWithAccountKey(token: string): Promise<number> {
  if (!isE2EEEnabled()) return 0;
  const meta: any = await api.e2eeGetRecoveryBackupMeta(token).catch((e) => noteTransient(e));
  if (!backupHasContent(meta)) return 0;
  const wrap = ((meta.wraps || []) as any[]).find((w) => w && w.kind === "account");
  if (!wrap) return 0;
  const secret = await unwrapSecretWithAccountKey(token, wrap);
  if (!secret) return 0;
  const kek = await deriveRecoveryKek(secret, b64dec(meta.salt));
  if (meta.probe && !(await kekOpensChunk(kek, meta.probe))) return 0; // stale wrap
  const backup: any = await fetchRecoveryBackupBody(token).catch((e) => noteTransient(e));
  if (!backup || !Array.isArray(backup.chunks) || !backup.chunks.length) return 0;
  let restored: number;
  try {
    restored = await restoreBackupWithKek(kek, backup);
  } catch (_) {
    return 0;
  }
  try { await signalStore.putRecoveryKek(kek); } catch (_) { }
  // Persist locally + keychain. (This re-publishes the account wrap too — a
  // no-op in effect, since it wraps the same secret under the same key.)
  await persistRecoverySecret(secret);
  try { localStorage.setItem("e2ee_recovery_backup_at", String(Date.now())); } catch (_) { }
  return restored;
}

// Publish (or, when forced, re-publish) the account wrap of THIS device's local
// recovery secret. Only ever wraps a secret that provably opens the current
// server backup, so a stale secret can never be baked into the automatic path.
let accountWrapEnsured = false;
export async function ensureAccountWrap(token: string | null, force = false): Promise<void> {
  if (!isE2EEEnabled() || !token || !chatBackupEnabled) return;
  if (accountWrapEnsured && !force) return;
  try {
    const secret = await signalStore.getRecoverySecret().catch(() => null);
    if (!secret) return; // nothing to wrap yet — a restore / creation calls again
    const meta: any = await api.e2eeGetRecoveryBackupMeta(token).catch(() => null);
    if (!backupHasContent(meta)) return;
    if (!(await localSecretMatchesBackup(secret, meta))) return; // stale — never wrap it
    const ak: any = await api.e2eeGetAccountKey(token).catch(() => null);
    if (!ak || !ak.key) return; // automatic recovery is off server-side
    const existing = ((meta.wraps || []) as any[]).find((w) => w && w.kind === "account");
    if (!force && existing) {
      // Only keep an existing wrap if it still opens under the CURRENT account
      // key — the server re-mints the key when its escrow secret is rotated, and
      // a wrap under the old key would leave every new device unable to restore.
      if (await unwrapSecretWithAccountKey(token, existing)) {
        accountWrapEnsured = true;
        return;
      }
    }
    const wrapSalt = randBytes(16);
    const wrapKey = await derivePasswordWrapKey(String(ak.key), wrapSalt, PASSWORD_WRAP_ITERATIONS);
    const iv = randBytes(12);
    const secretBytes = new Uint8Array(secret);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, secretBytes);
    await api.e2eePutRecoveryWrap(token, {
      kind: "account",
      ct: b64enc(ct),
      iv: b64enc(iv),
      salt: b64enc(wrapSalt),
      iterations: PASSWORD_WRAP_ITERATIONS,
    });
    accountWrapEnsured = true;
    invalidateRecoveryPaths();
  } catch (_) {
    /* best-effort; the next boot / restore tries again */
  }
}

// An account with NO backup at all (never signed in with a password since the
// backup feature shipped — SSO-only users) gets one created silently from this
// device's readable history, wrapped under the account key. Once per session;
// never overwrites an existing backup (re-checked right before the upload).
let autoBackupEnsured = false;
async function ensureAutoBackup(token: string): Promise<void> {
  if (!isE2EEEnabled() || !chatBackupEnabled || autoBackupEnsured) return;
  autoBackupEnsured = true;
  try {
    const meta = await api.e2eeGetRecoveryBackupMeta(token).catch(() => undefined);
    if (meta === undefined) {
      autoBackupEnsured = false; // couldn't tell — try again next boot
      return;
    }
    if (meta) return; // a backup exists — refresh + ensureAccountWrap cover it
    const ak: any = await api.e2eeGetAccountKey(token).catch(() => null);
    if (!ak || !ak.key) return; // feature off → creation stays with the password login
    const recoveryBytes = randBytes(32);
    const saltBytes = randBytes(16);
    const kek = await deriveRecoveryKek(recoveryBytes, saltBytes);
    const entries = trimToBudget(
      await gatherHistoryEntries(token, { allTime: true }),
      RECOVERY_MAX_PLAINTEXT_BYTES,
    );
    const chunks = await buildRecoveryChunks(kek, entries);
    // Another device may have created one while we gathered — never clobber.
    const again = await api.e2eeGetRecoveryBackupMeta(token).catch(() => undefined);
    if (again !== null) return;
    await api.e2eePutRecoveryBackup(token, b64enc(saltBytes), chunks);
  invalidateBackupBody();
    try { await signalStore.putRecoveryKek(kek); } catch (_) { }
    try {
      localStorage.setItem("e2ee_recovery_backup_at", String(Date.now()));
      localStorage.setItem("e2ee_recovery_entry_count", String(entries.length));
      localStorage.setItem(FULL_WALK_KEY, b64enc(saltBytes)); // seeded from a full walk
    } catch (_) { }
    await persistRecoverySecret(recoveryBytes); // also publishes the account wrap
    console.info("[e2ee] created the account's history backup (%d entries)", entries.length);
    // The init pass may already have reported "exhausted" (no key anywhere);
    // this device now holds one, so re-run and let the UI leave that state.
    if (recoveryState.phase === "exhausted")
      void autoRecoverHistory({ force: true, reason: "backup-created" }).catch(() => { });
  } catch (_) {
    /* best-effort */
  }
}

// Desktop: the keychain copy of the backup secret. Re-derives the KEK against
// the server's salt and merges the backup — the reinstall / cleared-storage
// path that used to need the user's password. Returns entries merged.
async function restoreFromKeychainSecret(token: string): Promise<number> {
  if (!isE2EEEnabled() || !myUserId) return 0;
  const b64 = await keychainLoadSecret(myUserId).catch(() => null);
  if (!b64) return 0;
  const secret = b64dec(b64);
  if (secret.length < 32) return 0;
  const backup: any = await fetchRecoveryBackupBody(token).catch((e) => noteTransient(e));
  if (!backupHasContent(backup)) return 0;
  const kek = await deriveRecoveryKek(secret, b64dec(backup.salt));
  let restored: number;
  try {
    restored = await restoreBackupWithKek(kek, backup);
  } catch (e) {
    // The keychain copy predates a secret rotation on another device — it is
    // worthless now; forget it rather than retry it on every boot.
    if (e instanceof WrongRecoveryKeyError) {
      try { await keychainClearSecret(); } catch (_) { }
    }
    return 0;
  }
  try { await signalStore.putRecoveryKek(kek); } catch (_) { }
  try { await signalStore.putRecoverySecret(secret); } catch (_) { }
  try { localStorage.setItem("e2ee_recovery_backup_at", String(Date.now())); } catch (_) { }
  return restored;
}

// ── AUTOMATIC recovery orchestrator ──────────────────────────────────────────
// ONE routine that opens every source this device can open WITHOUT asking the
// user, in order of cost, and publishes what it is doing so the chat can show
// a calm "restoring" row instead of a dead-end placeholder or a retry button:
//   1. the backup key already cached on this device (same device, keys intact);
//   2. the desktop-keychain copy of the backup secret (reinstall / cleared data);
//   3. the server-escrowed account key (ANY signed-in device — SSO, restored
//      session, brand-new browser — with no prompt);
//   4. a sibling device's sync bundle already waiting on the relay;
//   5. while gaps remain, a live ask to every sibling that is online.
// Runs at init (awaited), on reconnect, and whenever a decrypt hits a gap —
// throttled so a thread of pending rows or a flapping socket can't stampede the
// backup endpoint, and never overlapping itself.
//
// Only when the server has automatic recovery OFF (E2EE_AUTO_RECOVERY=false),
// or the backup predates any device publishing an account wrap, can a device
// end up with no key; the state says so (`credentialCouldUnlock`) so the UI
// can offer exactly one typed unlock.
let recoveryState: RecoveryState = { ...initialRecoveryState };
const recoverySubs = new Set<(s: RecoveryState) => void>();
let recoveryInFlight: Promise<number> | null = null;

// A recovery source that could not be REACHED is not a source that was tried
// and found empty. Rate limiting (429), a 5xx and a dropped connection all land
// here; the restore helpers note it, autoRecoverHistory reports the run as
// transient instead of "exhausted", and a retry is scheduled with backoff.
let recoveryTransient = false;
function isTransientErr(e: any): boolean {
  const s = e && typeof e.status === "number" ? e.status : NaN;
  return s === 429 || s === 0 || (s >= 500 && s <= 599) || (e && e.transient === true);
}
function noteTransient<T = null>(e: any, fallback: T = null as T): T {
  if (isTransientErr(e)) recoveryTransient = true;
  return fallback;
}
const RECOVERY_RETRY_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
let recoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryRetryCount = 0;
function scheduleRecoveryRetry(): void {
  if (recoveryRetryTimer || recoveryRetryCount >= RECOVERY_RETRY_MS.length) return;
  const delay = RECOVERY_RETRY_MS[recoveryRetryCount++];
  recoveryRetryTimer = setTimeout(() => {
    recoveryRetryTimer = null;
    void autoRecoverHistory({ force: true, reason: "retry-after-transient" }).catch(() => { });
  }, delay);
}

function setRecoveryState(ev: RecoveryEvent): void {
  recoveryState = reduceRecovery(recoveryState, ev);
  recoverySubs.forEach((cb) => {
    try { cb(recoveryState); } catch (_) { /* a bad subscriber must not break the rest */ }
  });
}
export type { RecoveryState };
export function getRecoveryState(): RecoveryState {
  return recoveryState;
}
export function subscribeRecoveryState(cb: (s: RecoveryState) => void): () => void {
  recoverySubs.add(cb);
  return () => {
    recoverySubs.delete(cb);
  };
}

export async function autoRecoverHistory(opts?: {
  force?: boolean;
  reason?: string;
}): Promise<number> {
  if (!isE2EEEnabled() || !myToken) return 0;
  if (
    !shouldRunRecovery(recoveryState, Date.now(), {
      force: !!opts?.force,
      inFlight: !!recoveryInFlight,
    })
  ) {
    return recoveryInFlight ? recoveryInFlight : 0;
  }
  const token = myToken;
  const run = (async () => {
    setRecoveryState({ type: "start", at: Date.now() });
    recoveryTransient = false;
    const tried: string[] = [];
    let restored = 0;
    let keyHeld = false;
    let credentialCouldUnlock = false;
    try {
      // 1. Already holding the backup key → just merge whatever is new.
      let kek = await signalStore.getRecoveryKek().catch(() => null);
      if (kek) {
        tried.push("cached-key");
        restored += await restoreFromCachedKek(token);
        kek = await signalStore.getRecoveryKek().catch(() => null); // dropped if stale
      }
      // 2. Desktop keychain copy of the secret.
      if (!kek) {
        tried.push("keychain");
        restored += await restoreFromKeychainSecret(token);
        kek = await signalStore.getRecoveryKek().catch(() => null);
      }
      // 3. The server-escrowed account key — any signed-in device, no prompt.
      if (!kek) {
        tried.push("account-key");
        restored += await restoreWithAccountKey(token);
        kek = await signalStore.getRecoveryKek().catch(() => null);
      }
      // 4. A sibling may already have pushed a bundle to the relay.
      tried.push("sibling-bundle");
      await restoreSyncBundle().catch(() => { });
      // 5. Still no key of our own, or known gaps → ask the siblings that are
      //    online. Their bundles arrive later via onSyncReady.
      if (!kek || _freshEnrollThisSession || recoveryNeededThisSession) {
        tried.push("sibling-ask");
        void requestAllHistoryHeal().catch(() => { });
      }
      keyHeld = !!kek;
      if (!keyHeld) {
        const meta: any = await api.e2eeGetRecoveryBackupMeta(token).catch((e) => noteTransient(e));
        credentialCouldUnlock = backupHasContent(meta);
      }
      if (restored > 0)
        console.info("[e2ee] auto-recovery merged", restored, "entries (" + (opts?.reason || "") + ")");
    } catch (e) {
      noteTransient(e);
      /* best-effort; the state below still reflects what was tried */
    } finally {
      recoveryInFlight = null;
      // Transient only while retries remain: once they are used up, an
      // unreachable source is reported as exhausted so the unlock banner (which
      // keys on "exhausted") can still offer the one typed credential.
      const transient =
        !keyHeld && restored === 0 && recoveryTransient && recoveryRetryCount < RECOVERY_RETRY_MS.length;
      if (keyHeld || restored > 0) recoveryRetryCount = 0;
      setRecoveryState({
        type: "finish",
        at: Date.now(),
        restored,
        tried,
        keyHeld,
        credentialCouldUnlock,
        transient,
      });
      if (transient) {
        console.warn("[e2ee] auto-recovery could not reach a source (rate-limited / server error) — retrying shortly");
        scheduleRecoveryRetry();
      }
      invalidateRecoveryPaths();
    }
    return restored;
  })();
  recoveryInFlight = run;
  return run;
}

// ==================================================================
// AUTOMATIC backup keyed to the sign-in password (the WhatsApp model with
// zero ceremony). Called fire-and-forget right after a successful PASSWORD
// login — the only moment the password legitimately exists in client memory.
// The 32-byte recovery secret is AES-GCM-wrapped under a PBKDF2-derived key
// and stored server-side next to the backup; the server can no more open it
// than the backup itself (an offline attacker must brute-force the password
// through 310k PBKDF2 rounds per user). What this buys: a brand-new device —
// with every old device gone — restores the user's full message history the
// moment they sign in. The manual recovery key remains available in the
// Security panel as the password-less fallback.
// ==================================================================
const PASSWORD_WRAP_ITERATIONS = 310_000;

async function derivePasswordWrapKey(
  password: string,
  saltBytes: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// Create (or rotate) the full backup under a fresh secret and wrap that secret
// under the CURRENT password. Gathers from this device — callers gate on this
// device actually being the best available source (see ensurePasswordBackup).
async function createBackupWithPasswordWrap(
  token: string,
  password: string,
  existingBackup?: any,
): Promise<void> {
  // ROTATING A POPULATED BACKUP must carry everything it already holds. The
  // old code rebuilt it from only what THIS device could read and replaced the
  // server copy — every entry the user's OTHER devices had contributed was
  // lost, on an ordinary password sign-in from a device set up on an older
  // build (it holds the backup key but not the secret, so it cannot re-wrap
  // and falls through to here). Now: a populated backup is rotated only by a
  // device whose key opens it, and its entries are merged into the new one.
  // A device that cannot open it leaves it alone — the escrowed account key
  // restores automatically, and that device re-wraps on a later sign-in.
  let carried: SyncEntry[] = [];
  if (backupHasContent(existingBackup)) {
    const localKek = await signalStore.getRecoveryKek().catch(() => null);
    if (!localKek || (existingBackup.probe && !(await kekOpensChunk(localKek, existingBackup.probe)))) {
      console.warn("[e2ee] password-wrap backup SKIPPED — this device cannot open the existing backup; not replacing it");
      return;
    }
    const full = await fetchRecoveryBackupBody(token).catch(() => null);
    if (!full || !Array.isArray(full.chunks) || !full.chunks.length) return; // transient — next sign-in
    const dec = await decryptBackupEntries(localKek, full);
    if (dec.failedChunks > 0) {
      console.warn("[e2ee] password-wrap backup SKIPPED — %d existing chunk(s) unreadable", dec.failedChunks);
      return;
    }
    carried = dec.entries;
  }
  const recoveryBytes = randBytes(32);
  const saltBytes = randBytes(16);
  const kek = await deriveRecoveryKek(recoveryBytes, saltBytes);
  // The first backup is the one a new device restores from: walk EVERYTHING.
  const entries = trimToBudget(
    mergeEntries(carried, await gatherHistoryEntries(token, { allTime: true })),
    RECOVERY_MAX_PLAINTEXT_BYTES,
  );
  // Do NOT rotate the secret and full-replace a POPULATED backup with an empty
  // snapshot: the upload is destructive, and a transient fetch failure (or an
  // evicted local plaintext cache) makes the gather come back empty. Creating a
  // first, empty backup is fine — clobbering a real one is data loss.
  if (!entries.length && backupHasContent(existingBackup) && (Number(existingBackup.byteLen) || 1) > 0) {
    console.warn("[e2ee] password-wrap backup SKIPPED — gathered 0 entries, refusing to overwrite the existing backup");
    return;
  }
  const chunks = await buildRecoveryChunks(kek, entries);
  const wrapSalt = randBytes(16);
  const wrapKey = await derivePasswordWrapKey(password, wrapSalt, PASSWORD_WRAP_ITERATIONS);
  const iv = randBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, recoveryBytes);
  invalidateBackupBody();
  await api.e2eePutRecoveryBackup(token, b64enc(saltBytes), chunks, {
    ct: b64enc(ct),
    iv: b64enc(iv),
    salt: b64enc(wrapSalt),
    iterations: PASSWORD_WRAP_ITERATIONS,
  });
  try {
    await signalStore.putRecoveryKek(kek);
  } catch (_) { }
  // Slice 2: retain the raw secret so a recovery-passphrase wrap of the SAME
  // secret can be added later without rotating (which would break this wrap).
  await persistRecoverySecret(recoveryBytes);
  try {
    localStorage.setItem("e2ee_recovery_backup_at", String(Date.now()));
    localStorage.setItem("e2ee_recovery_entry_count", String(entries.length));
    localStorage.setItem(FULL_WALK_KEY, b64enc(saltBytes)); // created from a full walk
  } catch (_) { }
}

// Re-wrap the EXISTING recovery secret under a (new) password WITHOUT rotating the
// secret or the backup chunks. This is the fix for "a password change silently
// breaks passphrase restore": the old rotate-on-password-change path minted a fresh
// secret, orphaning any recovery-passphrase wrap (which wraps the SAME secret). By
// re-wrapping the stored secret we re-mint only the 'password' wrap and leave the
// 'passphrase' wrap (and the backup chunks) untouched. Returns false when this
// device holds no local secret to re-wrap — the caller then falls back to a full
// create/rotate (legacy pre-Slice-2 devices, or genuine first-time setup).
async function rewrapPasswordWrap(token: string, password: string): Promise<boolean> {
  const secret = await signalStore.getRecoverySecret().catch(() => null);
  if (!secret) return false; // no local secret → caller rotates (legacy device)
  // CRITICAL (data safety): only re-wrap when the local secret STILL opens the
  // current server backup. A stale secret (another device rotated) or a missing
  // backup must NOT be baked into a durable password wrap — that would brick
  // new-device recovery and, unlike a rotate, never self-heal. Return false so the
  // caller rotates + rebuilds from THIS device's history (self-healing, matching
  // the pre-Slice-2 behaviour). On a transient fetch failure we can neither verify
  // nor safely rotate, so leave the wrap as-is this cycle (return true) and let the
  // next login retry.
  let backup: any;
  try {
    backup = await api.e2eeGetRecoveryBackupMeta(token);
  } catch (_) {
    return true; // couldn't reach the server — write nothing, rotate nothing
  }
  if (!(await localSecretMatchesBackup(secret, backup))) return false; // stale/missing → rotate + rebuild
  const wrapSalt = randBytes(16);
  const wrapKey = await derivePasswordWrapKey(password, wrapSalt, PASSWORD_WRAP_ITERATIONS);
  const iv = randBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, secret);
  await api.e2eePutRecoveryWrap(token, {
    kind: "password",
    ct: b64enc(ct),
    iv: b64enc(iv),
    salt: b64enc(wrapSalt),
    iterations: PASSWORD_WRAP_ITERATIONS,
  });
  return true;
}

// Verify a candidate recovery secret actually opens the CURRENT server backup:
// derive its KEK from the backup's salt and decrypt the first chunk. Used before
// wrapping the secret under a passphrase so a STALE local secret (another device
// rotated it) is never baked into a passphrase wrap that would be undecryptable.
async function localSecretMatchesBackup(secret: Uint8Array, backup: any): Promise<boolean> {
  try {
    // Accepts the full backup OR the ?meta=1 shape (whose `probe` is chunk 0).
    if (!backupHasContent(backup)) return false;
    const c = backup.probe || (backup.chunks && backup.chunks[0]);
    // Copy into a fresh ArrayBuffer-backed view (deriveRecoveryKek wants
    // Uint8Array<ArrayBuffer>; the stored secret is Uint8Array<ArrayBufferLike>).
    const secretBytes = new Uint8Array(secret);
    const kek = await deriveRecoveryKek(secretBytes, b64dec(backup.salt));
    return await kekOpensChunk(kek, c);
  } catch (_) {
    return false;
  }
}

// Explicit password restore for a fresh/reset device that has NO cached KEK but
// a password-wrapped backup waiting on the server (used by the auto path below
// AND by a restore prompt on session-restore / SSO logins, where the password is
// not otherwise available). Unwraps the recovery secret with the password, merges
// the backup, and caches the KEK so this device auto-refreshes it from now on.
// Returns { restored, noWrap } — noWrap means there is no password-wrapped backup
// to restore (caller should not treat that as a failure of the password).
export async function restoreWithPassword(
  token: string,
  password: string,
): Promise<{ restored: number; noWrap?: boolean }> {
  if (!isE2EEEnabled() || !password || typeof window === "undefined")
    return { restored: 0, noWrap: true };
  const backup: any = await fetchRecoveryBackupBody(token).catch(() => null);
  const wrap = backup && backup.passwordWrap;
  if (!backup || !backup.salt || !wrap)
    return { restored: 0, noWrap: true };
  const wrapKey = await derivePasswordWrapKey(
    password,
    b64dec(wrap.salt),
    Number(wrap.iterations) || PASSWORD_WRAP_ITERATIONS,
  );
  const secretPt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64dec(wrap.iv) },
    wrapKey,
    b64dec(wrap.ct),
  );
  const recoveryBytes = new Uint8Array(new ArrayBuffer(secretPt.byteLength));
  recoveryBytes.set(new Uint8Array(secretPt));
  const kek = await deriveRecoveryKek(recoveryBytes, b64dec(backup.salt));
  const restored = await restoreBackupWithKek(kek, backup); // throws if the wrap lied
  try {
    await signalStore.putRecoveryKek(kek);
  } catch (_) { }
  // Slice 2: keep the raw secret so this new device can also mint a
  // recovery-passphrase wrap of the SAME secret.
  await persistRecoverySecret(recoveryBytes);
  try {
    localStorage.setItem("e2ee_recovery_backup_at", String(Date.now()));
  } catch (_) { }
  return { restored };
}

export type { BackupCapabilities };

/** What ways into the account's backup exist. Drives the restore box's copy. */
export async function getBackupCapabilities(token?: string): Promise<BackupCapabilities> {
  const t = token || myToken;
  const none: BackupCapabilities = {
    hasBackup: false,
    hasPasswordWrap: false,
    hasPassphraseWrap: false,
  };
  if (!isE2EEEnabled() || !t) return none;
  const backup: any = await api.e2eeGetRecoveryBackupMeta(t).catch(() => null);
  if (!backupHasContent(backup)) return none;
  const wraps = (backup.wraps || []) as any[];
  return {
    hasBackup: true,
    hasPasswordWrap: !!backup.passwordWrap,
    hasPassphraseWrap: wraps.some((w) => w && w.kind === "passphrase"),
  };
}

/**
 * Restore this device's history from ONE typed secret.
 *
 * The user is asked for a single thing because they do not know which of the
 * three credentials their account holds — the automatic password wrap in
 * particular is created silently at sign-in, so most people have one and none of
 * them know it. This tries the wraps that actually exist, in the order
 * ./restorePlan decides, and stops at the first that opens the backup.
 *
 * Before this, the in-chat "Restore Backup" button could only ever try the
 * recovery PASSPHRASE (or a recovery key) — so the commonest case, a new device
 * on an account with only the automatic password wrap, failed with "No recovery
 * passphrase is set for this account" no matter what the user typed.
 */
export async function restoreHistoryWithSecret(
  token: string,
  input: string,
): Promise<{ restored: number; via: RestoreMethod }> {
  if (!isE2EEEnabled()) throw new Error("Encryption is not enabled for this workspace.");
  const secret = String(input || "").trim();
  if (!secret) throw new Error("Enter your password, recovery passphrase, or recovery key.");
  const caps = await getBackupCapabilities(token);
  const plan = planRestore(secret, caps);
  if (!plan.length)
    throw new Error(
      "No encrypted backup was found for your account, so there is nothing to restore here.",
    );
  for (const method of plan) {
    try {
      if (method === "recoveryKey") {
        const r = await restoreFromRecoveryKey(token, secret);
        if (!r.noBackup) return { restored: r.restored, via: method };
      } else if (method === "password") {
        const r = await restoreWithPassword(token, secret);
        if (!r.noWrap) return { restored: r.restored, via: method };
      } else {
        const r = await restoreWithPassphrase(token, secret);
        return { restored: r.restored, via: method };
      }
    } catch (_) {
      // Wrong credential for THIS wrap — try the next one the account has.
      // A genuine failure with nothing left to try falls through to the
      // capability-aware message below, which is more useful than whichever
      // crypto error happened to come last.
    }
  }
  throw new Error(wrongCredentialMessage(caps));
}

/**
 * Does THIS device need a history restore? True when encryption is on, the
 * device holds no recovery key of its own (so it cannot read anything older
 * than itself), and the account has a backup that could fill the gap. Drives the
 * persistent restore button — the login prompt fires once and is gone, which
 * left anyone who dismissed it, or whose automatic restore quietly failed, with
 * no way back to their history.
 */
export async function deviceNeedsHistoryRestore(token?: string): Promise<boolean> {
  if (!isE2EEEnabled()) return false;
  try {
    const kek = await signalStore.getRecoveryKek().catch(() => null);
    if (kek) return false; // this device is already unlocked
    return (await getBackupCapabilities(token)).hasBackup;
  } catch (_) {
    return false;
  }
}

// True when THIS device is fresh (no cached KEK) but the ACCOUNT has a
// password-wrapped backup waiting — i.e. the password-wrap auto-restore cannot
// run on this login path (session-restore / SSO, where no password is in memory)
// and the user should be offered the chance to enter their password to restore.
export async function needsPasswordRestore(): Promise<boolean> {
  if (!isE2EEEnabled() || !myToken) return false;
  try {
    const kek = await signalStore.getRecoveryKek().catch(() => null);
    if (kek) return false; // already unlocked — the auto path already covers it
    const backup: any = await api.e2eeGetRecoveryBackupMeta(myToken).catch(() => null);
    return !!(backup && backup.passwordWrap);
  } catch (_) {
    return false;
  }
}

// Whether a pending "Message unavailable on this device" row has ANY live
// recovery path left: a server-side backup and/or other devices of this user.
// Drives the honest terminal state in the chat row (B3) — if neither exists the
// row is unrecoverable and should say so instead of retrying a sync forever.
export type { E2EERecoveryPaths };

export async function e2eeRecoveryStatus(): Promise<E2EERecoveryPaths> {
  let hasBackup = false;
  let siblingDevices = 0;
  // A lookup that FAILS (429, offline, expired token) says nothing about
  // whether a backup or sibling exists. Only a real answer may count as "none";
  // otherwise the row would call a recoverable message lost.
  let verified = !!myToken;
  if (myToken) {
    try {
      hasBackup = backupHasContent(await api.e2eeGetRecoveryBackupMeta(myToken));
    } catch (_) {
      verified = false;
    }
    try {
      const devs = (await api.e2eeDevices(myToken)) as any[];
      siblingDevices = (devs || []).filter(
        (d) => d && String(d.id) !== String(myDeviceId),
      ).length;
    } catch (_) {
      verified = false;
    }
  }
  return recoveryPathsOf(hasBackup, siblingDevices, verified);
}

// ── Shared, cached view of the above ────────────────────────────────────────
// The consumer is EVERY undecryptable row in a thread, so the two API calls
// behind e2eeRecoveryStatus() are fetched once, shared and cached. Cache
// mechanics live in ./recoveryPaths (pure, and unit-tested).
const recoveryPathsCache = createRecoveryPathsCache(() => e2eeRecoveryStatus());

/** The last known answer, or null if it has never been fetched. Never blocks. */
export function getRecoveryPathsCached(): E2EERecoveryPaths | null {
  return recoveryPathsCache.get();
}

/** Fetch (or reuse) the recovery paths. Concurrent callers share one request. */
export function loadRecoveryPaths(force = false): Promise<E2EERecoveryPaths> {
  return recoveryPathsCache.load(force);
}

export function subscribeRecoveryPaths(cb: (v: E2EERecoveryPaths) => void): () => void {
  return recoveryPathsCache.subscribe(cb);
}

/** Drop the cache — call after anything that CREATES or REMOVES a recovery path
 *  (enabling/disabling the backup, a successful restore, a device change). */
export function invalidateRecoveryPaths(): void {
  recoveryPathsCache.invalidate();
}

export async function ensurePasswordBackup(token: string, password: string): Promise<void> {
  if (!isE2EEEnabled() || !password || typeof window === "undefined") return;
  try {
    const backup = await api.e2eeGetRecoveryBackupMeta(token).catch(() => null);
    const localKek = await signalStore.getRecoveryKek().catch(() => null);
    const wrap = backup && (backup as any).passwordWrap;

    if (wrap && !localKek) {
      // NEW / RESET DEVICE with an auto-backup waiting: unwrap the secret with
      // the password the user just typed and restore everything — silently.
      try {
        await restoreWithPassword(token, password); // throws if the wrap lied
        // The device now holds the key: let the orchestrator pull anything else
        // that is openable (sibling bundles) and publish "done" to the UI.
        void autoRecoverHistory({ force: true, reason: "password-login" }).catch(() => { });
      } catch (_) {
        // The wrap was made under a DIFFERENT password (changed/reset since).
        // Leave the backup alone — device-link sync still heals this device,
        // and once it holds history the rotate branch below re-wraps under the
        // current password on a later sign-in.
      }
      return;
    }

    if (!wrap && (localKek || !backup)) {
      if (!chatBackupEnabled) return; // Chat backup OFF — don't create new backups.
      // No wrap yet. Create the auto-backup from a device that is actually the
      // best available source: either it already refreshes the backup (has the
      // KEK) or no backup exists at all — never clobber a manual backup this
      // device can't read. Prefer re-wrapping the EXISTING secret (keeps any
      // passphrase wrap valid); only a device with no local secret rotates.
      if (!(await rewrapPasswordWrap(token, password)))
        await createBackupWithPasswordWrap(token, password, backup);
      return;
    }

    if (wrap && localKek) {
      // Verify the wrap still opens under THIS password; a password change
      // since the wrap was made would strand the next new device. Rotate on
      // mismatch — this device has the KEK, so it can rebuild everything.
      try {
        const wrapKey = await derivePasswordWrapKey(
          password,
          b64dec(wrap.salt),
          Number(wrap.iterations) || PASSWORD_WRAP_ITERATIONS,
        );
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: b64dec(wrap.iv) },
          wrapKey,
          b64dec(wrap.ct),
        );
        return; // wrap is current
      } catch (_) {
        if (!chatBackupEnabled) return; // Chat backup OFF — don't rotate the wrap.
        // Password changed since the wrap was made. Re-wrap the SAME secret under
        // the new password (keeps any passphrase wrap valid); fall back to a full
        // rotate only when this device has no local secret to re-wrap.
        if (!(await rewrapPasswordWrap(token, password)))
          await createBackupWithPasswordWrap(token, password, backup);
      }
      return;
    }
    // Remaining case: manual-only backup (no wrap) that this device can't open
    // (no KEK) — leave it to the manual recovery-key path in the Security panel.
  } catch (_) {
    /* fully best-effort — sign-in must never notice this */
  }
}

// ==================================================================
// SLICE 2 — Universal Recovery Passphrase. A user (especially an SSO user who has
// no sign-in password we ever see) sets a memorable passphrase that wraps the SAME
// 32-byte recovery secret as the password wrap. A brand-new device then restores
// full history from just the passphrase — no password, no manual recovery key, no
// other device online. The passphrase never leaves the client; the server stores
// only opaque ct/iv + non-secret KDF params (identical server-blind model to the
// password wrap). All wraps wrap ONE stable secret, so adding a passphrase never
// rotates/invalidates the existing backup or password wrap.
// ==================================================================

// True when this device holds the raw recovery secret — i.e. it CAN mint a new
// recovery-passphrase wrap. A device that only synced messages but never set up or
// restored a backup has no secret yet and must sync/restore a backup first.
export async function hasLocalRecoverySecret(): Promise<boolean> {
  try {
    return !!(await signalStore.getRecoverySecret());
  } catch (_) {
    return false;
  }
}

// True when the ACCOUNT has a recovery-passphrase wrap on the server, so a new
// device can be prompted to "enter your recovery passphrase".
export async function accountHasRecoveryPassphrase(token: string): Promise<boolean> {
  try {
    const backup: any = await api.e2eeGetRecoveryBackupMeta(token);
    const wraps = (backup && backup.wraps) || [];
    return wraps.some((w: any) => w && w.kind === "passphrase");
  } catch (_) {
    return false;
  }
}

// Set (or replace) the account's recovery passphrase. Wraps this device's LOCAL
// recovery secret under a PBKDF2(passphrase) key and uploads ONLY that wrap — the
// backup chunks and any password wrap are untouched (same secret). Requires the
// device to already hold the secret (it created or restored a backup).
export async function enrollRecoveryPassphrase(
  token: string,
  passphrase: string,
): Promise<void> {
  if (!isE2EEEnabled()) throw new Error("End-to-end encryption isn't enabled.");
  const pass = (passphrase || "").trim();
  if (pass.length < 8)
    throw new Error("Use a recovery passphrase of at least 8 characters.");
  const secret = await signalStore.getRecoverySecret().catch(() => null);
  if (!secret)
    throw new Error(
      "This device doesn't have your recovery key yet. Open your chats to finish syncing, then set your passphrase.",
    );
  // Guard against baking a STALE secret into the wrap: if another device rotated
  // the secret+salt, this device's local secret would no longer open the current
  // backup, and a passphrase minted from it would be undecryptable. Verify first,
  // and distinguish a transient fetch failure from genuine staleness (both fail
  // closed — we never write a maybe-bad wrap).
  let currentBackup: any;
  try {
    currentBackup = await api.e2eeGetRecoveryBackupMeta(token);
  } catch (_) {
    throw new Error(
      "Couldn't reach the server to verify your backup. Check your connection and try again.",
    );
  }
  if (!(await localSecretMatchesBackup(secret, currentBackup)))
    throw new Error(
      "This device is out of date with your backup. Open your chats to re-sync your history, then set your passphrase.",
    );
  const wrapSalt = randBytes(16);
  const wrapKey = await derivePasswordWrapKey(pass, wrapSalt, PASSWORD_WRAP_ITERATIONS);
  const iv = randBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, secret);
  await api.e2eePutRecoveryWrap(token, {
    kind: "passphrase",
    ct: b64enc(ct),
    iv: b64enc(iv),
    salt: b64enc(wrapSalt),
    iterations: PASSWORD_WRAP_ITERATIONS,
  });
}

// Remove the account's recovery-passphrase wrap (the backup + password wrap stay).
export async function removeRecoveryPassphrase(token: string): Promise<void> {
  if (!isE2EEEnabled()) return;
  try {
    await api.e2eeDeleteRecoveryWrap(token, "passphrase");
  } catch (_) { }
}

// Restore a new/reset device from the account's recovery PASSPHRASE. Fetches the
// backup, unwraps the recovery secret with the passphrase, derives the KEK, and
// decrypts the full history locally. Throws a friendly error on a wrong passphrase
// or when no passphrase wrap exists.
export async function restoreWithPassphrase(
  token: string,
  passphrase: string,
): Promise<{ restored: number }> {
  if (!isE2EEEnabled()) return { restored: 0 };
  const pass = (passphrase || "").trim();
  if (!pass) throw new Error("Enter your recovery passphrase.");
  let backup: any = null;
  try {
    backup = await fetchRecoveryBackupBody(token);
  } catch (_) {
    backup = null;
  }
  const wraps = (backup && backup.wraps) || [];
  const wrap = wraps.find((w: any) => w && w.kind === "passphrase");
  if (!backup || !backup.salt || !backup.chunks || !wrap)
    throw new Error("No recovery passphrase is set for this account.");
  const wrapKey = await derivePasswordWrapKey(
    pass,
    b64dec(wrap.salt),
    Number(wrap.iterations) || PASSWORD_WRAP_ITERATIONS,
  );
  let secretPt: ArrayBuffer;
  try {
    secretPt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64dec(wrap.iv) },
      wrapKey,
      b64dec(wrap.ct),
    );
  } catch (_) {
    throw new Error(
      "That recovery passphrase didn't match. Check it and try again.",
    );
  }
  const recoveryBytes = new Uint8Array(new ArrayBuffer(secretPt.byteLength));
  recoveryBytes.set(new Uint8Array(secretPt));
  const kek = await deriveRecoveryKek(recoveryBytes, b64dec(backup.salt));
  const restored = await restoreBackupWithKek(kek, backup); // throws if wrong
  try {
    await signalStore.putRecoveryKek(kek);
  } catch (_) { }
  await persistRecoverySecret(recoveryBytes);
  try {
    localStorage.setItem("e2ee_recovery_backup_at", String(Date.now()));
  } catch (_) { }
  return { restored };
}

// Turn the backup off: delete the server-side rows and clear the local KEK.
export async function disableRecoveryBackup(token: string): Promise<void> {
  invalidateRecoveryPaths();
  if (!isE2EEEnabled()) return;
  try {
    await api.e2eeDeleteRecoveryBackup(token);
  } catch (_) { }
  try {
    await signalStore.clearRecoveryKek();
  } catch (_) { }
  try {
    await keychainClearSecret();
  } catch (_) { }
  // Slice 2: the raw secret goes with the KEK — turning the backup off leaves no
  // recovery material behind (and clears any passphrase-wrap source).
  try {
    await signalStore.clearRecoverySecret();
  } catch (_) { }
  try {
    localStorage.removeItem("e2ee_recovery_backup_at");
  } catch (_) { }
}

// ------------------------------------------------------------------
// Identity verification (safety numbers) + key-change handling + devices
// ------------------------------------------------------------------

// Out-of-band safety number between me and a peer (compare verbally / by QR to
// rule out a server-substituted key). Uses the peer's FIRST device identity key.
export async function getSafetyNumber(token: string, remoteUserId: string): Promise<string | null> {
  if (!isE2EEEnabled() || !myIdentityPubB64) return null;
  const bundles = await api.e2eeBundleFor(token, remoteUserId).catch(() => []);
  const peer = (bundles || []).find((b: any) => b && b.identityKey);
  if (!peer) return null;
  return computeSafetyNumber(myIdentityPubB64, peer.identityKey);
}

// Peers (userId:deviceId) whose pinned identity key changed since first sight —
// surfaced so the UI can warn and offer re-verification. Returns userIds.
export function getKeyChangedUserIds(): string[] {
  const ids = new Set<string>();
  for (const k of changedIdentities) ids.add(k.split(":")[0]);
  return [...ids];
}

export function hasIdentityChanged(remoteUserId: string): boolean {
  for (const k of changedIdentities) if (k.split(":")[0] === remoteUserId) return true;
  return false;
}

// User reviewed a key change (e.g. peer reinstalled / new device) and accepts it:
// re-pin the peer's current identity key(s) so encryption to them resumes.
export async function acceptIdentityChange(token: string, remoteUserId: string): Promise<void> {
  if (!isE2EEEnabled()) return;
  const bundles = await api.e2eeBundleFor(token, remoteUserId).catch(() => []);
  for (const b of bundles || []) {
    if (!b || !b.identityKey) continue;
    const key = remoteUserId + ":" + String(b.id);
    // Re-pin BOTH identity and signing key atomically (B2 — they travel together).
    await signalStore.storeTrustedIdentity(key, b.identityKey, undefined, b.signingKey || undefined);
    changedIdentities.delete(key);
    try { pubKeyCache.set(key, await importPub(b.identityKey)); } catch (_) { }
    if (b.signingKey) {
      try { signPubCache.set(key, await importSignPub(b.signingKey)); } catch (_) { }
    } else {
      signPubCache.delete(key);
    }
  }
}

// Out-of-band VERIFICATION state for a peer's identity. Closes the TOFU MITM
// window: the safety-number display alone is just trust-on-first-use; the user
// must compare it out of band and explicitly confirm. We persist the verified
// state (per peer device) so subsequent sessions show "Verified" and a later
// identity change can surface "verified key changed — re-verify" loudly.
//
// markIdentityVerified pins the CURRENT identity fingerprint as the verified
// one. If the peer's key later changes, isIdentityVerified will see the
// mismatch (verifiedFingerprint !== current fingerprint) and report
// {verified:true, mismatch:true} so the UI can warn instead of silently
// keeping the green check.
export async function markIdentityVerified(token: string, remoteUserId: string): Promise<boolean> {
  if (!isE2EEEnabled() || !myIdentityPubB64) return false;
  const bundles = await api.e2eeBundleFor(token, remoteUserId).catch(() => []);
  let any = false;
  for (const b of bundles || []) {
    if (!b || !b.identityKey) continue;
    const key = remoteUserId + ":" + String(b.id);
    const fp = await computeSafetyNumber(myIdentityPubB64, b.identityKey).catch(() => null);
    if (!fp) continue;
    await signalStore.markIdentityVerified(key, fp);
    any = true;
  }
  return any;
}
export async function isIdentityVerified(
  token: string,
  remoteUserId: string,
): Promise<{ verified: boolean; mismatch: boolean }> {
  if (!isE2EEEnabled() || !myIdentityPubB64) return { verified: false, mismatch: false };
  const bundles = await api.e2eeBundleFor(token, remoteUserId).catch(() => []);
  let anyVerified = false;
  let anyMismatch = false;
  for (const b of bundles || []) {
    if (!b || !b.identityKey) continue;
    const key = remoteUserId + ":" + String(b.id);
    const v = await signalStore.isIdentityVerified(key);
    if (!v.verified) continue;
    anyVerified = true;
    const curFp = await computeSafetyNumber(myIdentityPubB64, b.identityKey).catch(() => null);
    if (curFp && v.fingerprint && curFp !== v.fingerprint) anyMismatch = true;
  }
  return { verified: anyVerified, mismatch: anyMismatch };
}
export async function clearIdentityVerification(token: string, remoteUserId: string): Promise<void> {
  if (!isE2EEEnabled()) return;
  const bundles = await api.e2eeBundleFor(token, remoteUserId).catch(() => []);
  for (const b of bundles || []) {
    if (!b) continue;
    const key = remoteUserId + ":" + String(b.id);
    await signalStore.clearIdentityVerified(key);
  }
}

// My registered devices (for a Devices/security panel) + revoke.
export async function listMyDevices(token: string): Promise<any[]> {
  if (!isE2EEEnabled()) return [];
  return (await api.e2eeDevices(token).catch(() => [])) || [];
}

export async function revokeMyDevice(token: string, deviceId: string): Promise<void> {
  if (!isE2EEEnabled()) return;
  await api.e2eeRevokeDevice(token, deviceId).catch(() => { });
}

// Approve a pending (untrusted) device so it starts receiving key fan-out.
export async function approveMyDevice(token: string, deviceId: string): Promise<void> {
  if (!isE2EEEnabled()) return;
  await api.e2eeApproveDevice(token, deviceId).catch(() => { });
  // Mechanism A: this (trusted, online) device just approved a new device — push
  // a bounded window of recent plaintext history to it, server-blind.
  void buildHistoryBundleForDevice(token, deviceId).catch(() => { });
}

export function getMyDeviceId(): string | null {
  return myDeviceId;
}

export async function clearSessions(): Promise<void> {
  pubKeyCache.clear();
  signPubCache.clear();
  groupKeyCache.clear();
  groupKeyByVer.clear();
  groupRawByConv.clear();
  opkCache.clear();
  seenMid.clear();
  // Drop the in-memory E2EE-pin caches (re-hydrated from IndexedDB next session);
  // the PERSISTED convFlags pin is deliberately NOT cleared — the forced-downgrade
  // defense must survive logout/login.
  convE2EEPinned.clear();
  convE2EENegCache.clear();
  myToken = null;
  myIdentityPriv = null;
  mySigningPriv = null;
  myUserId = null;
  cancelInitRetry();
  // Retain persisted sessions/ratchet/plaintext so a SAME-USER re-login can read its own history; a DIFFERENT user is wiped at login via the device-owner mismatch guard.
}

// Full LOCAL E2EE reset for THIS device — the Settings → Security escape hatch.
// Unlike clearSessions (logout: retains persisted keys for same-user re-login),
// this WIPES every IndexedDB store + the localStorage device markers, so the next
// init mints a brand-new, freshly-enrolled device. Use when a device is stuck
// (half-enrolled / key desync) and can SEND but not RECEIVE. The caller MUST
// reload immediately after. Server-side device rows are untouched here (revoke
// the current device from the list first if you don't want it lingering as a
// harmless stale entry). Does NOT delete any message — only local crypto state.
export async function resetE2EEDevice(): Promise<void> {
  // A reset repairs a STUCK DEVICE; it must not also forget the user's backup
  // key, or the freshly-enrolled device would come back with every message
  // pending and no automatic way to fill them in. Carry the key + secret across
  // the wipe: the next init's automatic recovery restores the history under the
  // new device identity with no prompt.
  let keepKek: CryptoKey | null = null;
  let keepSecret: Uint8Array | null = null;
  try { keepKek = await signalStore.getRecoveryKek(); } catch (_) { }
  try { keepSecret = await signalStore.getRecoverySecret(); } catch (_) { }
  try { await signalStore.wipeForUserSwitch(); } catch (_) { }
  try { if (keepKek) await signalStore.putRecoveryKek(keepKek); } catch (_) { }
  try { if (keepSecret) await signalStore.putRecoverySecret(keepSecret); } catch (_) { }
  try {
    localStorage.removeItem("e2ee_device_id");
    localStorage.removeItem("e2ee_device_registered");
    localStorage.removeItem("e2ee_prekeys_published");
    // Backup markers: the plaintext cache is gone, so force the next boot to
    // restore + re-check the backup rather than trusting stale local counters.
    localStorage.removeItem("e2ee_recovery_backup_at");
    localStorage.removeItem("e2ee_recovery_entry_count");
    localStorage.removeItem("e2ee_recovery_watermark");
    localStorage.removeItem(FULL_WALK_KEY);
    localStorage.removeItem(UNOPENABLE_KEY);
  } catch (_) { }
  unopenable = null;
  try { sessionStorage.removeItem("e2ee_owner_reset"); } catch (_) { }
  pubKeyCache.clear();
  signPubCache.clear();
  opkCache.clear();
  convE2EEPinned.clear();
  convE2EENegCache.clear();
  myIdentityPriv = null;
  mySigningPriv = null;
  myDeviceId = null;
  _deviceRegisteredThisSession = false;
  _initOk = false;
}

// ------------------------------------------------------------------
// Group / channel E2EE — shared per-epoch conversation key.
//
// One symmetric AES-GCM-256 key per (conversation, epoch). The key is
// ECIES-wrapped to EVERY member device (reusing encryptToDevice) and stored,
// one row per recipient device, in e2ee_conversation_keys. Messages are AES-GCM
// encrypted under that key. The epoch ("keyVersion") rotates LAZILY on the next
// send AFTER the member-device set changes: a removed member cannot read messages
// sent after the rotation; a newly added member only receives the new epoch and
// cannot read history.
//
// Trade-off vs Signal sender-keys: no per-sender ratchet — any member can read
// any member's messages within an epoch (acceptable: they share the group; same
// effective trust as a shared group key). Honest limits: there is a window
// between a removal and the next send; two members rotating concurrently race
// (last write wins per device) and self-heal on the next rotation.
// ------------------------------------------------------------------
function groupAad(
  senderUserId: string,
  senderDeviceId: string,
  conversationId: string,
  ver: number,
  nonceB64: string,
  mid: string,
): Uint8Array<ArrayBuffer> {
  return utf8(
    [VERSION, "group", senderUserId, senderDeviceId, conversationId || "", String(ver), nonceB64, mid || ""].join("|"),
  );
}

// All recipient devices for a group: every member's devices PLUS my own current
// device (ensureSessionsForUser skips it, but I must hold the key to read my own
// messages after a reload).
async function memberDeviceSet(
  token: string,
  memberUserIds: string[],
): Promise<Array<{ userId: string; deviceId: string }>> {
  const out: Array<{ userId: string; deviceId: string }> = [];
  const seen = new Set<string>();
  for (const uid of memberUserIds) {
    const devs = await ensureSessionsForUser(token, uid);
    for (const d of devs) {
      const k = uid + ":" + d;
      if (!seen.has(k)) { seen.add(k); out.push({ userId: uid, deviceId: d }); }
    }
  }
  if (myUserId && myDeviceId) {
    const k = myUserId + ":" + myDeviceId;
    // Guarantee MY OWN device is in the epoch-wrap set so I can re-read my own
    // group messages — and their file keys — after a reload. The gate below used
    // to require my public key to ALREADY be in the in-memory cache, but a mint
    // that raced init (cold cache) then OMITTED my own device: the epoch key was
    // never wrapped to me, so every file I sent in that window locked as "Not
    // available on this device" on reload (loadMyGroupKey finds no row → keyGone).
    // The key is OUR identity keypair, derivable locally, so warm the cache
    // instead of skipping — the same self-heal encryptForUser already does.
    if (!seen.has(k) && !pubKeyCache.has(k)) {
      try {
        const pair = (await signalStore.getIdentityKeyPair()) as CryptoKeyPair | null;
        if (pair && pair.publicKey) pubKeyCache.set(k, pair.publicKey);
      } catch (_) {
        /* fall through to the guard below */
      }
    }
    if (!seen.has(k) && pubKeyCache.has(k)) { seen.add(k); out.push({ userId: myUserId, deviceId: myDeviceId }); }
  }
  return out;
}

function setHashOf(devs: Array<{ userId: string; deviceId: string }>): string {
  return devs.map((d) => d.userId + ":" + d.deviceId).sort().join(",");
}

// Wrap the raw epoch key to each device (ECIES). Returns base envelopes WITHOUT
// keyVersion (callers supply it; the atomic endpoint takes version separately).
async function buildEpochEnvelopes(
  conversationId: string,
  rawKeyB64: string,
  devs: Array<{ userId: string; deviceId: string }>,
): Promise<any[]> {
  const envelopes: any[] = [];
  for (const { userId, deviceId } of devs) {
    try {
      const env = await encryptToDevice(userId, deviceId, rawKeyB64, conversationId);
      envelopes.push({
        deviceId,
        userId,
        encryptedKey: JSON.stringify({ s: myUserId, sd: myDeviceId, e: env.body }),
        algorithm: "ecies-p256-aesgcm",
      });
    } catch (_) {
      /* skip a device we can't wrap to (e.g. changed/untrusted key) */
    }
  }
  return envelopes;
}

// Legacy (non-atomic) upsert distribution — used only as a fallback when the
// race-free epoch endpoint is unavailable (older backend).
async function distributeGroupKey(
  token: string,
  conversationId: string,
  ver: number,
  rawKeyB64: string,
  devs: Array<{ userId: string; deviceId: string }>,
): Promise<void> {
  const base = await buildEpochEnvelopes(conversationId, rawKeyB64, devs);
  const envelopes = base.map((e) => ({ ...e, keyVersion: ver }));
  if (envelopes.length) await api.e2eePutConversationKeys(token, conversationId, envelopes);
}

// Mint a fresh epoch key, wrap it to every device, and claim the epoch
// ATOMICALLY (race-free). If another member won the race, adopt their key so
// the whole group converges on one epoch key instead of splitting.
async function mintEpoch(
  token: string,
  conversationId: string,
  nextVer: number,
  devs: Array<{ userId: string; deviceId: string }>,
  hash: string,
): Promise<{ key: CryptoKey; ver: number }> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const rawB64 = b64enc(rawKey);
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const base = await buildEpochEnvelopes(conversationId, rawB64, devs);

  // AN EXISTING EPOCH IS NEVER OVERWRITTEN. The old code fell back to a plain
  // upsert at `nextVer` whenever the atomic create lost AND this device had no
  // wrap to adopt (a new device, a lost wrap) — or on ANY create error, network
  // blips included. That replaced every other device's wrap for a LIVE version
  // with a different key: devices that reloaded picked up the new key, devices
  // still running kept the old one in memory, and from then on messages in that
  // group decrypted on some devices and showed the pending placeholder on
  // others. When the version is taken and there is nothing to adopt, claim the
  // next FREE version instead; the epochs this device is missing are healed by
  // the epoch re-key request, not by clobbering them.
  let ver = nextVer;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res: any;
    try {
      res = await api.e2eeCreateConversationEpoch(token, conversationId, ver, base);
    } catch (e: any) {
      // Only a backend that genuinely lacks the atomic endpoint may use the
      // legacy upsert, and only for a first epoch. Anything else is transient:
      // fail the send (the composer keeps the text) rather than risk a clobber.
      if (e && (e.status === 404 || e.status === 405) && ver === 1) {
        await distributeGroupKey(token, conversationId, ver, rawB64, devs);
        res = { created: true };
      } else {
        throw e;
      }
    }
    if (res && res.created) {
      groupKeyCache.set(conversationId, { key, ver, setHash: hash });
      groupKeyByVer.set(conversationId + ":" + ver, key);
      groupRawByConv.set(conversationId, rawB64);
      return { key, ver };
    }
    // Lost the race — adopt whatever epoch the winner published for my device.
    const loaded = await loadMyGroupKey(token, conversationId);
    if (loaded) {
      groupKeyCache.set(conversationId, { key: loaded.key, ver: loaded.ver, setHash: hash });
      groupKeyByVer.set(conversationId + ":" + loaded.ver, loaded.key);
      groupRawByConv.set(conversationId, loaded.rawB64);
      return { key: loaded.key, ver: loaded.ver };
    }
    if (res && res.skipped) break; // no backing conversation / no known devices
    // Nothing to adopt: move past every version the server already holds.
    const max = Number(res && res.maxVersion);
    ver = Number.isFinite(max) && max >= ver ? max + 1 : ver + 1;
  }
  throw new Error("Couldn't set up the encryption key for this conversation — please try again.");
}

// Load + unwrap my wrapped epoch key from the server (newest, or a specific ver).
async function loadMyGroupKey(
  token: string,
  conversationId: string,
  ver?: number,
): Promise<{ key: CryptoKey; ver: number; rawB64: string } | null> {
  // A FAILED fetch is not "no key". Swallowing it made a network blip look like a
  // missing epoch: the send path then tried to mint over a live epoch, and the
  // decrypt path rendered a permanent pending row for a message this device can
  // read perfectly well. Let it throw (tagged) so senders retry and the decrypt
  // path schedules a re-decrypt instead of giving up. A 403/404 is a real answer.
  let rows: any[];
  try {
    rows = await api.e2eeGetConversationKeys(token, conversationId);
  } catch (e: any) {
    const st = e && e.status;
    if (st === 403 || st === 404) return null;
    throw Object.assign(new Error("group key fetch failed"), { transient: true });
  }
  if (!rows || !rows.length) return null;
  const mine = rows.filter((r: any) => String(r.deviceId) === String(myDeviceId));
  if (!mine.length) return null;
  const row = ver != null ? mine.find((r: any) => Number(r.keyVersion) === Number(ver)) : mine[0];
  if (!row) return null;
  try {
    const meta = JSON.parse(row.encryptedKey);
    const { text: rawB64 } = await decryptEnvelope(meta.s, meta.sd, meta.e, conversationId);
    const key = await crypto.subtle.importKey("raw", b64dec(rawB64), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return { key, ver: Number(row.keyVersion), rawB64 };
  } catch (_) {
    return null;
  }
}

// Get the current epoch key to encrypt with: reuse cache if the device set is
// unchanged; adopt the server's current epoch on a fresh load; otherwise mint a
// new epoch (membership/device change, or no key exists yet) and distribute it.
async function ensureGroupKey(
  token: string,
  conversationId: string,
  memberUserIds: string[],
): Promise<{ key: CryptoKey; ver: number }> {
  const devs = await memberDeviceSet(token, memberUserIds);
  const hash = setHashOf(devs);
  const cached = groupKeyCache.get(conversationId);
  // A split epoch was detected on decrypt (see decryptGroupEnvelope): don't keep
  // sending under it — open a fresh epoch wrapped to every device. mintEpoch
  // walks past any version that already exists, so this can't clobber one.
  if (splitEpochConvs.has(conversationId)) {
    const base = cached ? cached.ver : ((await loadMyGroupKey(token, conversationId))?.ver ?? 0);
    const minted = await mintEpoch(token, conversationId, base + 1, devs, hash);
    splitEpochConvs.delete(conversationId);
    return minted;
  }
  if (cached && cached.setHash === hash) return { key: cached.key, ver: cached.ver };

  if (!cached) {
    const loaded = await loadMyGroupKey(token, conversationId);
    if (loaded) {
      groupKeyCache.set(conversationId, { key: loaded.key, ver: loaded.ver, setHash: hash });
      groupKeyByVer.set(conversationId + ":" + loaded.ver, loaded.key);
      groupRawByConv.set(conversationId, loaded.rawB64);
      return { key: loaded.key, ver: loaded.ver };
    }
  }

  const nextVer = cached ? cached.ver + 1 : 1;
  return mintEpoch(token, conversationId, nextVer, devs, hash);
}

// Shared media key (base64) for LiveKit call/meeting E2EE: reuses the
// conversation's current epoch key so every participant who can read the
// conversation derives the same media key. Returns null if E2EE is off, or if
// no key could be obtained.
//
// FOR GROUP/CHANNEL conversations: reuses the shared epoch key seeded by the
// first encryptForGroup send (preferred — no extra round-trip).
//
// FOR 1:1 DMs (B3 — closes the prior "1:1 calls have no media E2EE" gap): no
// e2ee_conversation_keys row exists yet (DMs use per-device ECIES, not a shared
// key). When `memberUserIds` is provided, we seed one here via the same
// `ensureGroupKey` + atomic-epoch path used by groups: the AES-GCM-256 raw key
// is ECIES-wrapped per member device and stored in e2ee_conversation_keys, so
// every participating device — and only those — can derive the same media key.
// Subsequent calls in the same DM reuse the row (no round-trip). Both callers
// must call with the same `memberUserIds` (they do — passed from the call
// path). Falling back to null still proceeds with non-E2EE media (best-effort).
export async function getCallMediaKey(
  token: string,
  conversationId: string,
  memberUserIds?: string[],
): Promise<string | null> {
  if (!isE2EEEnabled() || !conversationId) return null;
  const cached = groupRawByConv.get(conversationId);
  if (cached) return cached;
  try {
    const loaded = await loadMyGroupKey(token, conversationId);
    if (loaded) {
      groupKeyCache.set(conversationId, { key: loaded.key, ver: loaded.ver, setHash: "" });
      groupKeyByVer.set(conversationId + ":" + loaded.ver, loaded.key);
      groupRawByConv.set(conversationId, loaded.rawB64);
      return loaded.rawB64;
    }
    // B3 — 1:1 seed path. Mint a fresh epoch and distribute via ECIES-wrap to
    // every member device (self included). This is the SAME mechanism groups
    // use, so call media for 1:1 + group is uniform. Only attempted when the
    // caller supplied a member list (otherwise we'd race with no audience).
    if (memberUserIds && memberUserIds.length > 0) {
      try {
        await ensureGroupKey(token, conversationId, memberUserIds);
        const raw = groupRawByConv.get(conversationId);
        if (raw) return raw;
      } catch (_) {
        /* best-effort: media falls back to non-E2EE if seeding fails */
      }
    }
  } catch (_) { }
  return null;
}

export async function encryptForGroup(
  token: string,
  conversationId: string,
  memberUserIds: string[],
  plaintext: string,
): Promise<any> {
  // FAIL-CLOSED: throw on any failure so the caller never falls back to plaintext.
  if (!isE2EEEnabled()) throw new Error("E2EE disabled");
  const { key, ver } = await ensureGroupKey(token, conversationId, memberUserIds);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const nonceB64 = b64enc(nonce);
  const mid = newMid();
  const ad = groupAad(myUserId!, myDeviceId!, conversationId, ver, nonceB64, mid);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ad }, key, utf8(plaintext));
  // B2 — sign the AAD. Without this, ANY group member (who holds the shared
  // epoch key) could forge a message as any other member. Verification on the
  // recipient side checks this against the sender's TOFU-pinned signing key.
  const sig = await signAad(ad);
  // Pin the conversation E2EE (forced-downgrade defense — see encryptForUser).
  await pinConvE2EE(conversationId);
  return { t: 2, v: 1, ver, iv: b64enc(iv), ct: b64enc(ct), n: nonceB64, sUser: myUserId, sDev: myDeviceId, mid, sig };
}

async function getGroupKeyForVer(token: string, conversationId: string, ver: number): Promise<CryptoKey | null> {
  const ck = groupKeyByVer.get(conversationId + ":" + ver);
  if (ck) return ck;
  const loaded = await loadMyGroupKey(token, conversationId, ver);
  if (loaded) {
    groupKeyByVer.set(conversationId + ":" + ver, loaded.key);
    return loaded.key;
  }
  return null;
}

async function decryptGroupEnvelope(env: any, conversationId: string): Promise<{ text: string; mid: string }> {
  if (!myToken) throw new Error("E2EE token unavailable");
  const key = await getGroupKeyForVer(myToken, conversationId, env.ver);
  // keyGone: this device has no wrap for that epoch (it didn't exist when the
  // epoch was minted) — a HISTORY GAP, healable via device sync, not tamper.
  if (!key) throw Object.assign(new Error("no group key for epoch " + env.ver), { keyGone: true });
  const ad = groupAad(env.sUser, env.sDev, conversationId, env.ver, env.n, env.mid || "");
  // B2 — verify the sender's signature. The group epoch key is shared by every
  // member, so AES-GCM alone cannot authenticate the sender — a member could
  // forge an envelope claiming any sUser/sDev. ECDSA over the AAD prevents that:
  // only the claimed sender's device (which holds the private signing key) can
  // produce a valid signature.
  if (env.sig) {
    const signKey = await getPeerSignKey(env.sUser, env.sDev);
    if (signKey) {
      const ok = await verifyAad(signKey, ad, env.sig);
      if (!ok) throw Object.assign(new Error("group signature verify failed"), { sigBad: true });
    } else if (E2EE_REQUIRE_SIGNATURES) {
      // Strict mode: under shared-epoch-key groups, any member can produce a
      // valid AES-GCM ciphertext under any claimed sender; the signature is the
      // ONLY proof of who actually sent it. Reject when missing.
      throw Object.assign(new Error("group signature required but absent"), { sigBad: true });
    }
    // Permissive (default): signKey null = sender pre-B2; falls through during
    // the migration window. See NEXT_PUBLIC_E2EE_REQUIRE_SIGNATURES.
  } else if (E2EE_REQUIRE_SIGNATURES) {
    // Strict mode: unsigned group envelope = pre-B2 sender or server forgery.
    throw Object.assign(new Error("unsigned group envelope rejected"), { sigBad: true });
  }
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64dec(env.iv), additionalData: ad }, key, b64dec(env.ct));
  } catch (decErr) {
    // Group decrypt failed under the cached per-version key. The most likely
    // cause is a cached key that's been rotated server-side (rare but possible
    // during membership churn) — evict the per-version cache so the next call
    // refetches from /conversations/:id/keys. We keep the current-epoch cache
    // entry alone unless its version matches the failing one.
    try {
      groupKeyByVer.delete(conversationId + ":" + env.ver);
      const cur = groupKeyCache.get(conversationId);
      if (cur && cur.ver === env.ver) {
        groupKeyCache.delete(conversationId);
        groupRawByConv.delete(conversationId);
      }
    } catch (_) { }
    // Retry ONCE with the server's copy right now. Evicting alone left THIS row on
    // the pending placeholder until something else happened to re-decrypt it.
    const freshKey = await getGroupKeyForVer(myToken, conversationId, env.ver);
    if (!freshKey) throw decErr;
    try {
      pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64dec(env.iv), additionalData: ad }, freshKey, b64dec(env.ct));
    } catch (_) {
      // Still the wrong key: this epoch is split (devices hold different keys for
      // the same version — the legacy overwrite bug). Make this device's NEXT send
      // open a fresh epoch so the group converges instead of staying split.
      groupKeyByVer.delete(conversationId + ":" + env.ver);
      splitEpochConvs.add(conversationId);
      throw decErr;
    }
  }
  return { text: new TextDecoder().decode(pt), mid: env.mid || "" };
}

// Force a fresh epoch immediately (call after a membership change for promptness;
// lazy rotation on the next send also covers correctness).
export async function rotateGroupKey(
  token: string,
  conversationId: string,
  memberUserIds: string[],
): Promise<void> {
  if (!isE2EEEnabled()) return;
  const devs = await memberDeviceSet(token, memberUserIds);
  const cached = groupKeyCache.get(conversationId);
  const nextVer = cached ? cached.ver + 1 : 1;
  await mintEpoch(token, conversationId, nextVer, devs, setHashOf(devs));
}

// ── Epoch-key backfill (recovers a whole-group pending-key) ──────────────────
// Requester side: on keyGone, ask the conversation's online MEMBERS (server relays
// to the conversation room) to re-wrap the existing epoch key to this device.
// Throttled to once per conversation per session so a scroll through a broken
// conversation doesn't spam the members.
const epochRekeyRequested = new Set<string>();
export async function requestEpochRekey(conversationId: string): Promise<void> {
  if (!isE2EEEnabled() || !myToken || !conversationId) return;
  if (epochRekeyRequested.has(conversationId)) return;
  epochRekeyRequested.add(conversationId);
  try {
    await api.e2eeRequestEpochRekey(myToken, conversationId);
  } catch (_) {
    // Let a later keyGone retry (e.g. after reconnect) — drop the throttle marker
    // only on a hard failure so a transient blip can try again.
    epochRekeyRequested.delete(conversationId);
  }
}

// Clear the per-session rekey throttles. Called on socket RECONNECT: a device that
// asked for a re-key while NO member was online would otherwise stay pending until
// a full reload (the request marker is session-lived). After reconnect, more
// members are typically online, so let the next keyGone re-ask and let members
// re-answer.
export function resetEpochRekeyThrottle(): void {
  try {
    epochRekeyRequested.clear();
    rewrapDone.clear();
  } catch (_) { }
}

// Member side: re-wrap EVERY epoch key I hold for this conversation to the target
// device and upload it. `myConversationKeys` returns only MY OWN device's wraps, so
// this unwraps with my identity key and re-seals to the target's PUBLISHED identity
// key (via encryptToDevice) — the server never sees plaintext. Idempotent: the PUT
// upserts by (conversation, device, version), so re-wrapping a version the target
// already has is harmless. Best-effort; never throws into the socket handler.
const rewrapDone = new Set<string>();
export async function rewrapEpochsForDevice(
  token: string,
  conversationId: string,
  targetUserId: string,
  targetDeviceId: string,
): Promise<void> {
  try {
    if (!isE2EEEnabled() || !conversationId || !targetUserId || !targetDeviceId) return;
    // Never re-wrap to myself, and answer a given (device, conversation) once per
    // session so N members don't each re-wrap repeatedly.
    if (targetUserId === myUserId && String(targetDeviceId) === String(myDeviceId)) return;
    const rk = conversationId + "|" + targetUserId + "|" + targetDeviceId;
    if (rewrapDone.has(rk)) return;
    // Answer a given (device, conversation) at most once per session — mark it BEFORE
    // the network work so a member who turns out not to hold the key (or fails)
    // doesn't redo the establish + fetch on every repeat of the request. The N-member
    // herd provides the redundancy, so one member skipping a retry is fine.
    rewrapDone.add(rk);
    // Establish a session to the target so its published identity key is cached.
    try {
      await ensureSessionsForUser(token, targetUserId);
    } catch (_) {
      return;
    }
    if (!pubKeyCache.has(targetUserId + ":" + String(targetDeviceId))) return; // untrusted / no key
    const rows: any[] = await api.e2eeGetConversationKeys(token, conversationId).catch(() => []);
    const mine = (rows || []).filter((r: any) => String(r.deviceId) === String(myDeviceId));
    if (!mine.length) return; // I don't hold this conversation's epoch either
    const envelopes: any[] = [];
    for (const row of mine) {
      try {
        const meta = JSON.parse(row.encryptedKey);
        const { text: rawB64 } = await decryptEnvelope(meta.s, meta.sd, meta.e, conversationId);
        const env = await encryptToDevice(targetUserId, String(targetDeviceId), rawB64, conversationId);
        envelopes.push({
          deviceId: String(targetDeviceId),
          userId: targetUserId,
          encryptedKey: JSON.stringify({ s: myUserId, sd: myDeviceId, e: env.body }),
          algorithm: "ecies-p256-aesgcm",
          keyVersion: Number(row.keyVersion) || 1,
        });
      } catch (_) {
        /* skip a version I can't unwrap or re-wrap */
      }
    }
    if (envelopes.length) {
      await api.e2eePutConversationKeys(token, conversationId, envelopes).catch(() => { });
    }
  } catch (_) {
    /* best-effort */
  }
}

// Requester side: new conversation keys arrived (E2EE_KEYS_UPDATED). Drop the
// cached epoch state for this conversation so the next decrypt re-fetches the wrap
// and unwraps it. NOTE: the request throttle is deliberately NOT cleared — every
// online member answers the one request, so re-asking after each member's
// KEYS_UPDATED would loop for a device whose identity key can't unwrap the re-wrap
// (the mismatch case, which needs re-enrollment, not another re-key).
export function onConversationKeysUpdated(conversationId: string): void {
  if (!conversationId) return;
  try {
    groupKeyCache.delete(conversationId);
    groupRawByConv.delete(conversationId);
    for (const k of Array.from(groupKeyByVer.keys()))
      if (k.startsWith(conversationId + ":")) groupKeyByVer.delete(k);
  } catch (_) { }
}

// Back-compat no-op export (was the Phase-2 placeholder; group E2EE now uses the
// shared per-epoch key above). Kept so any dormant import stays valid.
export async function distributeGroupSenderKey(
  _token: string,
  _groupId: string,
  _recipientUserIds: string[],
): Promise<void> {
  return;
}

// ─────────────────────────────────────────────────────────────────────────────
// Double Ratchet Phase 1 — DM text only, gated on NEXT_PUBLIC_E2EE_RATCHET.
// ─────────────────────────────────────────────────────────────────────────────
//
// SCOPE:
//   - DM text payloads only. Files, groups, calls keep the ECIES / shared-epoch
//     paths above.
//   - Per-recipient-device session (mirrors the existing ECIES per-device
//     fan-out). Session key in IndexedDB: "rt:<peerUserId>:<peerDeviceId>:<convId>".
//   - In-order delivery only in v1 (out-of-order rejected with a clear error).
//
// SESSION ESTABLISHMENT:
//   Both sides derive the same initial Root Key (SK) from
//     SK = HKDF(ECDH(my-identity-priv, peer-identity-pub), "DR-init")
//   Sender (initiator) uses the peer's published `ratchetInitialKey` as the
//   first `dhrPub`; recipient (responder) uses their OWN stored ratchet initial
//   keypair as `dhsPriv` until the first DH ratchet step rotates it.
//
// Both sides must have a `ratchetInitialKey` published in their device bundle
// (added by migration 0051 / initE2EE). Peers without one fall back to ECIES.

export function isRatchetEnabled(): boolean {
  return isE2EEEnabled() && E2EE_RATCHET;
}

function ratchetSessionId(
  peerUserId: string,
  peerDeviceId: string,
  conversationId: string,
): string {
  return `rt:${peerUserId}:${peerDeviceId}:${conversationId}`;
}

// Compute the initial Root Key (SK) for a ratchet session via ECDH on the
// long-term identity keys, then HKDF. Both peers compute the same SK.
async function deriveRatchetSeed(peerIdentityPubB64: string): Promise<Uint8Array> {
  if (!myIdentityPriv) throw new Error("ratchet: identity not initialised");
  const peerPub = await importPub(peerIdentityPubB64);
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: peerPub },
    myIdentityPriv,
    256,
  );
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey", "deriveBits"]);
  const out = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8("CoLab-DR-init") },
    hk,
    256,
  );
  return new Uint8Array(out);
}

// Load an existing session from IndexedDB, OR initiate one as the sender. The
// sender path requires the peer's published `ratchetInitialKey` (from their
// bundle) — without it we cannot bootstrap.
async function getOrInitiateRatchetSession(
  peerUserId: string,
  peerDeviceId: string,
  peerIdentityPubB64: string,
  peerRatchetInitialPubB64: string | null,
  conversationId: string,
): Promise<RatchetState | null> {
  const sid = ratchetSessionId(peerUserId, peerDeviceId, conversationId);
  const existing = (await signalStore.getRatchetSession(sid)) as RatchetState | null;
  // Reuse the existing session only if it was bootstrapped from the SAME peer
  // identity + same peer ratchet-initial pub we'd use now. If either has
  // rotated (peer wiped + re-enrolled with new keys, our local cache was
  // stale, etc.) the persisted root/chain keys are derived from dead material
  // and AEAD will fail — drop the session and re-bootstrap. Legacy sessions
  // (no fingerprint fields) are treated as stale on first encounter after
  // this fix ships; one fresh bootstrap heals them.
  const stale =
    !!existing &&
    (existing.bootstrapPeerIdentity !== peerIdentityPubB64 ||
      (peerRatchetInitialPubB64 != null &&
        existing.bootstrapPeerRatchetInitial !== peerRatchetInitialPubB64));
  if (existing && !stale) return existing;
  if (existing && stale) {
    try { await signalStore.deleteRatchetSession(sid); } catch (_) { }
  }
  if (!peerRatchetInitialPubB64) return null; // peer hasn't published — caller falls back
  const sk = await deriveRatchetSeed(peerIdentityPubB64);
  const fresh = await initiateRatchet(sk, peerRatchetInitialPubB64, {
    peerIdentityB64: peerIdentityPubB64,
  });
  await signalStore.putRatchetSession(sid, fresh);
  return fresh;
}

// Load an existing session, OR respond as the receiver of the first message.
// The responder side needs OUR stored ratchet initial keypair (the one whose
// pub we published in our bundle).
async function getOrRespondRatchetSession(
  peerUserId: string,
  peerDeviceId: string,
  peerIdentityPubB64: string,
  conversationId: string,
): Promise<RatchetState | null> {
  const sid = ratchetSessionId(peerUserId, peerDeviceId, conversationId);
  const existing = (await signalStore.getRatchetSession(sid)) as RatchetState | null;
  const myInit = await signalStore.getRatchetInitialKeyPair();
  if (!myInit) return null;
  // Same staleness check as the initiator side: peer identity OR our own
  // ratchet-initial pub rotating invalidates the persisted session because
  // both feed the shared secret / first chain key. Drop + rebuild on mismatch.
  const stale =
    !!existing &&
    (existing.bootstrapPeerIdentity !== peerIdentityPubB64 ||
      existing.bootstrapMyRatchetInitialPub !== myInit.pubB64);
  if (existing && !stale) return existing;
  if (existing && stale) {
    try { await signalStore.deleteRatchetSession(sid); } catch (_) { }
  }
  const sk = await deriveRatchetSeed(peerIdentityPubB64);
  const fresh = await respondRatchet(sk, myInit, {
    peerIdentityB64: peerIdentityPubB64,
  });
  await signalStore.putRatchetSession(sid, fresh);
  return fresh;
}

// Encrypt one DM text plaintext to ONE peer device via the ratchet. Returns the
// full envelope JSON ready to embed in the message's ciphertext_json[].
// Caller (encryptForUser, when ratchet flag is ON and target is DM text) wraps
// this per-device envelope into the existing fan-out structure.
export async function encryptToDeviceRatchet(
  peerUserId: string,
  peerDeviceId: string,
  peerIdentityPubB64: string,
  peerRatchetInitialPubB64: string | null,
  conversationId: string,
  plaintext: string,
  mid: string,
): Promise<any> {
  if (!isRatchetEnabled()) throw new Error("ratchet: flag is OFF");
  if (!myUserId || !myDeviceId) throw new Error("ratchet: identity missing");
  const session = await getOrInitiateRatchetSession(
    peerUserId,
    peerDeviceId,
    peerIdentityPubB64,
    peerRatchetInitialPubB64,
    conversationId,
  );
  if (!session) throw new Error("ratchet: peer has no published ratchet initial key");
  const ad = aad(myUserId, myDeviceId, peerUserId, peerDeviceId, conversationId, mid, mid);
  const ptBytes = utf8(plaintext);
  const out = await ratchetEncrypt(session, ad, ptBytes);
  const sid = ratchetSessionId(peerUserId, peerDeviceId, conversationId);
  await signalStore.putRatchetSession(sid, out.state);
  // B2 sender authentication — sign the AAD with our device signing key. Same
  // shape as the ECIES envelopes so the receiver's verify path is unchanged.
  const sig = await signAad(ad);
  return {
    type: 3, // ratchet envelope (vs 1=ECIES DM, 2=group)
    body: b64enc(
      utf8(
        JSON.stringify({
          v: 1,
          hdr: out.header,
          iv: b64enc(out.iv),
          ct: b64enc(out.ciphertext),
          n: mid,
          mid,
          sig,
        }),
      ),
    ),
  };
}

// Decrypt a ratchet envelope. Triggers a DH ratchet step + persists state.
export async function decryptRatchetEnvelope(
  senderUserId: string,
  senderDeviceId: string,
  envelopeBodyB64: string,
  conversationId: string,
): Promise<{ text: string; mid: string }> {
  if (!isRatchetEnabled()) throw new Error("ratchet: flag is OFF");
  if (!myUserId || !myDeviceId) throw new Error("ratchet: identity missing");
  if (!envelopeBodyB64) throw new Error("ratchet: empty envelope");
  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64dec(envelopeBodyB64)));
  } catch (_) {
    throw new Error("ratchet: malformed envelope");
  }
  const header: RatchetHeader = payload.hdr;
  if (!header || typeof header.dh !== "string" || typeof header.n !== "number") {
    throw new Error("ratchet: invalid header in envelope");
  }
  const iv = b64dec(payload.iv || "");
  const ct = b64dec(payload.ct || "");
  if (!iv.length || !ct.length) throw new Error("ratchet: missing iv or ciphertext in envelope");
  const mid: string = payload.mid;
  const ad = aad(senderUserId, senderDeviceId, myUserId, myDeviceId, conversationId, mid, mid);
  // B2 signature verify (same code as decryptEnvelope)
  if (payload.sig) {
    const signKey = await getPeerSignKey(senderUserId, senderDeviceId);
    if (signKey) {
      const ok = await verifyAad(signKey, ad, payload.sig);
      if (!ok) throw Object.assign(new Error("signature verify failed"), { sigBad: true });
    } else if (E2EE_REQUIRE_SIGNATURES) {
      throw Object.assign(new Error("signature required but absent"), { sigBad: true });
    }
  } else if (E2EE_REQUIRE_SIGNATURES) {
    throw Object.assign(new Error("unsigned ratchet envelope rejected"), { sigBad: true });
  }
  // Need peer's identity pub (b64) to (re-)derive the SK if this is a brand-new
  // ratchet session for us. The in-memory `pubKeyCache` holds the imported
  // CryptoKey, but importPub() makes it non-extractable (correctly — pub keys
  // shouldn't need re-export), so we can't read raw bytes back out of it. Go
  // directly to the bundle (small + only fires on the first decrypt per peer
  // device per conversation; subsequent messages use the persisted ratchet
  // state and never reach this code).
  const bundles = await api.e2eeBundleFor(myToken!, senderUserId).catch(() => []);
  const b = (bundles || []).find((x: any) => String(x.id) === String(senderDeviceId));
  const peerIdentityPubB64: string | null = b ? b.identityKey : null;
  if (!peerIdentityPubB64) throw new Error("ratchet: peer identity key unavailable");
  const session = await getOrRespondRatchetSession(
    senderUserId,
    senderDeviceId,
    peerIdentityPubB64,
    conversationId,
  );
  if (!session) throw new Error("ratchet: no local ratchet initial keypair (re-init)");
  const sid = ratchetSessionId(senderUserId, senderDeviceId, conversationId);
  let out;
  try {
    out = await ratchetDecrypt(session, header, ad, iv, ct);
  } catch (decErr: any) {
    // A genuine AEAD / key-derivation failure means our persisted session is desynced
    // from the sender's — drop it so the NEXT inbound message (or our next outbound)
    // re-bootstraps from current bundle material, and evict the in-memory peer pub
    // cache in case a prior bundle response poisoned it.
    //
    // BUT an `outOfOrder` throw is NOT a desync: it means duplicate / already-consumed
    // / too-far-ahead against an otherwise-VALID session — most commonly a re-decrypt
    // AFTER this message's plaintext cache was evicted (the "became unavailable" path).
    // Tearing down the session there would nuke a healthy DM and desync EVERY later
    // message until re-bootstrap, turning one lost row into a whole-thread outage. Leave
    // the session intact and let the caller route just this row to recoverable-pending.
    if (!(decErr && decErr.outOfOrder)) {
      try { await signalStore.deleteRatchetSession(sid); } catch (_) { }
      try { pubKeyCache.delete(senderUserId + ":" + senderDeviceId); } catch (_) { }
    }
    throw decErr;
  }
  await signalStore.putRatchetSession(sid, out.state);
  // Pin conversation as E2EE (downgrade protection).
  void pinConvE2EE(conversationId);
  return { text: new TextDecoder().decode(out.plaintext), mid };
}
