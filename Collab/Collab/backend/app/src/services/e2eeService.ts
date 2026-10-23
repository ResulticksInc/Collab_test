import { db, config } from "../platform";
import { newAccountKey, sealAccountKey, openAccountKey } from "./e2eeEscrow";

function bad(message: string, status = 400) {
  const e: any = new Error(message);
  e.status = status;
  return e;
}

function requireString(value, name: string) {
  if (!value || typeof value !== "string") throw bad(`${name} required`);
  return value;
}

async function registerDevice(userId: string, body: any) {
  const deviceId = requireString(body.deviceId || body.id, "deviceId");
  // OWNERSHIP on re-register. The driver's upsert replaces identity_key on a
  // duplicate id WITHOUT checking user_id, so a client re-registering an id that
  // belongs to ANOTHER account (a leftover localStorage id from earlier testing)
  // would overwrite that account's device key and break their decryption. Refuse
  // with 409 so the client falls back to minting a fresh id of its own.
  const existing = await db.e2ee.getDevice(deviceId).catch(() => null);
  if (existing && existing.userId && existing.userId !== userId)
    throw bad("Device id belongs to another account", 409);
  // Auto-approve devices registered by authenticated users so new devices
  // immediately join the sender's E2EE key fan-out without race conditions.
  const trusted = true;
  return db.e2ee.registerDevice({
    id: deviceId,
    userId,
    name: body.name || null,
    identityKey: requireString(body.identityKey, "identityKey"),
    // B2 (sender authentication): each device now publishes a separate ECDSA
    // P-256 signing public key. Nullable for backwards-compat (old clients still
    // register without it; their messages cannot be sender-verified until they
    // re-init and publish one). New clients always send it.
    signingKey: body.signingKey || null,
    // Double Ratchet Phase 1 (DH ratchet seed): an extractable ECDH P-256 public
    // key that becomes the recipient's INITIAL DH for the ratchet's first DH
    // ratchet step. Nullable — clients without it can't be the responder side
    // of a ratchet session yet (sender falls back to ECIES).
    ratchetInitialKey: body.ratchetInitialKey || null,
    signedPreKey: body.signedPreKey || null,
    trusted,
  });
}

async function myDevices(userId: string) {
  return db.e2ee.listDevices(userId);
}

async function revokeDevice(userId: string, deviceId: string) {
  return db.e2ee.revokeDevice({ userId, deviceId });
}

async function approveDevice(userId: string, deviceId: string) {
  return db.e2ee.approveDevice({ userId, deviceId });
}

async function publishPreKeys(userId: string, deviceId: string, keys: any[]) {
  const mine = await db.e2ee.getDevice(deviceId);
  if (!mine || mine.userId !== userId) throw bad("Unknown device", 404);
  return db.e2ee.publishOneTimePreKeys({ deviceId, keys });
}

// Atomically claim a recipient device's one-time prekey for forward secrecy.
// Any authenticated user may consume another device's OPK (that is the point —
// senders consume the recipient's OPKs); the recipient deletes its private half
// after decrypting. Returns { claimed }.
async function consumePreKey(_userId: string, deviceId: string, keyId: string) {
  return db.e2ee.consumeOneTimePreKey({
    deviceId: requireString(deviceId, "deviceId"),
    keyId: requireString(keyId, "keyId"),
  });
}

// Stale-device pruning for the SENDER fan-out (and only there). Devices pile up
// across browsers/logins; every one costs the sender an envelope and, for text
// DMs, a one-time-prekey consume round-trip — dead devices slow every text send
// to that user. A device is "stale" when it hasn't made an authenticated request
// (auth middleware touches last_seen_at) within E2EE_DEVICE_STALE_DAYS (default
// 60; 0 disables pruning). Trade-off: a device dormant longer than the window
// misses envelopes sent while it was away ("[Encrypted — not available on this
// device]" for that gap) and rejoins the fan-out on its next request — the same
// posture as Signal's stale-device expiry.
//
// FAIL-SAFES (do not remove):
//   • NEVER filter down to zero — if every trusted device is stale, keep the most
//     recently seen one. Zero devices = the B1 "peer not set up" sentinel on the
//     client, which falls back to PLAINTEXT — pruning must never cause that
//     downgrade (nor break single-device self-notes).
//   • Missing last_seen_at (pre-migration row) falls back to created_at, so no
//     device is stale merely because it predates the column.
const DEVICE_STALE_DAYS = (() => {
  const n = Number(process.env.E2EE_DEVICE_STALE_DAYS ?? 60);
  return Number.isFinite(n) && n >= 0 ? n : 60;
})();
function lastActivityMs(d: any): number {
  const t = Date.parse(d?.lastSeenAt || d?.createdAt || "");
  return Number.isNaN(t) ? 0 : t;
}
async function bundleFor(userId: string) {
  const bundles = await db.e2ee.getPreKeyBundle(userId);
  if (!DEVICE_STALE_DAYS || !Array.isArray(bundles) || bundles.length <= 1) return bundles;
  const cutoff = Date.now() - DEVICE_STALE_DAYS * 24 * 3600 * 1000;
  const fresh = bundles.filter((d: any) => lastActivityMs(d) >= cutoff);
  if (fresh.length > 0) return fresh;
  // All stale → keep the single most-recently-seen device (see fail-safes above).
  const newest = bundles.reduce((a: any, b: any) => (lastActivityMs(b) > lastActivityMs(a) ? b : a));
  return [newest];
}

// ---- Mechanism A: server-blind device-link history sync --------------------
// ALL authorization lives here. The relay stores opaque ciphertext only; these
// guards ensure a device can only push history to ANOTHER of the SAME user's
// trusted/non-revoked devices, and can only fetch/ack its OWN relay rows (the
// device identity for fetch/ack comes from the JWT, passed by the route, never
// from a body/query id).
const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // 4MB opaque ciphertext per chunk
const MAX_CHUNKS = 64;
const SYNC_TTL_SECONDS = 14 * 24 * 3600; // 14 days

async function uploadHistorySync(
  userId: string,
  sourceDeviceId: string | null,
  body: any,
) {
  // No device-bound token yet (first login before the deviceId binds into the
  // token). History sync is best-effort — skip silently instead of 401-spamming;
  // the client retries on its next session once the token carries a deviceId.
  if (!sourceDeviceId) return { skipped: "no-device-bound-token" };
  const targetDeviceId = requireString(body.targetDeviceId, "targetDeviceId");
  const ciphertext = requireString(body.ciphertext, "ciphertext");
  const bundleId = requireString(body.bundleId, "bundleId");
  const chunkIndex = Number(body.chunkIndex || 0);
  const chunkCount = Number(body.chunkCount || 1);
  // SERVER STAYS BLIND: we measure the opaque base64 length only — never parse
  // or decode it.
  if (Buffer.byteLength(ciphertext, "utf8") > MAX_CHUNK_BYTES)
    throw bad("Sync chunk too large", 413);
  if (chunkCount > MAX_CHUNKS || chunkIndex < 0 || chunkIndex >= chunkCount)
    throw bad("Bad chunk range", 400);
  const src = await db.e2ee.getDevice(sourceDeviceId);
  if (!src || src.userId !== userId) throw bad("Unknown source device", 404);
  if (!src.trusted || src.revoked) throw bad("Source device not trusted", 403);
  const tgt = await db.e2ee.getDevice(targetDeviceId);
  if (!tgt || tgt.userId !== userId) throw bad("Target device is not yours", 403);
  if (tgt.revoked) throw bad("Target device revoked", 410);
  if (targetDeviceId === sourceDeviceId) throw bad("Cannot sync to self", 400);
  return db.e2ee.putHistorySyncChunk({
    targetUserId: userId,
    targetDeviceId,
    sourceDeviceId,
    bundleId,
    chunkIndex,
    chunkCount,
    ciphertext,
    algorithm: body.algorithm || "ecies-p256-aesgcm",
    ttlSeconds: SYNC_TTL_SECONDS,
  });
}

async function fetchHistorySync(userId: string, deviceId: string | null) {
  // No device-bound token yet → nothing to fetch (best-effort, not an error).
  if (!deviceId) return [];
  return db.e2ee.listHistorySyncFor({
    targetUserId: userId,
    targetDeviceId: deviceId,
  });
}

async function ackHistorySync(
  userId: string,
  deviceId: string | null,
  bundleId: string | null,
) {
  // No device-bound token yet → nothing to ack (best-effort, not an error).
  if (!deviceId) return { deleted: 0 };
  return db.e2ee.deleteHistorySyncFor({
    targetUserId: userId,
    targetDeviceId: deviceId,
    bundleId,
  });
}

// On-demand heal: a device that rendered "[Encrypted — not available on this
// device]" asks its sibling devices for targeted history. Validation lives
// here; the ROUTE relays the request over the socket (services stay io-free).
// The requester's identity comes from the device-bound JWT, with a fallback to
// an explicit body deviceId that must belong to the caller — a brand-new
// device's token may not be bound yet, and that is exactly the device that
// needs healing. The relayed ciphertext is ECIES-encrypted to the requester
// device's key, so a forged request gains nothing readable.
async function requestHistorySync(
  userId: string,
  jwtDeviceId: string | null,
  body: any,
) {
  let deviceId = jwtDeviceId || null;
  if (!deviceId && body && body.deviceId) {
    const dev = await db.e2ee.getDevice(String(body.deviceId));
    if (dev && dev.userId === userId && !dev.revoked) deviceId = String(body.deviceId);
  }
  if (!deviceId) throw bad("No device identity", 400);
  const conversationIds = (Array.isArray(body?.conversationIds) ? body.conversationIds : [])
    .filter((x: any) => typeof x === "string" && x)
    .slice(0, 100);
  return { requesterDeviceId: deviceId, conversationIds };
}

// ---- Mechanism B: server-blind encrypted history recovery backup -----------
// ALL authorization lives here. The userId comes ONLY from the JWT (passed by the
// route), never a body field. The server stays BLIND: it stores/serves opaque
// base64 ciphertext + iv + the non-secret salt; it never derives the KEK, never
// decodes ciphertext, and never sees plaintext. We only measure base64 lengths to
// bound storage. One backup per user, fully replaced.
// Raised (was 32MB / 64) so the backup can hold a user's FULL history rather
// than a recent window: the client trims oldest-first to stay under this, so a
// small ceiling silently meant "a new device only ever gets the last N months".
const MAX_RECOVERY_BYTES = 64 * 1024 * 1024; // 64MB opaque ciphertext per backup
const MAX_RECOVERY_CHUNKS = 96;

async function putRecoveryBackup(userId: string, body: any) {
  const salt = requireString(body.salt, "salt");
  const chunks = body.chunks;
  if (!Array.isArray(chunks) || chunks.length === 0)
    throw bad("chunks must be a non-empty array");
  if (chunks.length > MAX_RECOVERY_CHUNKS) throw bad("Too many chunks", 413);
  let totalBytes = 0;
  const clean = chunks.map((c: any, i: number) => {
    const ciphertext = requireString(c && c.ciphertext, "ciphertext");
    const iv = requireString(c && c.iv, "iv");
    // SERVER STAYS BLIND: measure the opaque base64 length only — never decode it.
    totalBytes += Buffer.byteLength(ciphertext, "utf8");
    return {
      index: Number(c.index ?? i) || 0,
      count: Number(c.count) || chunks.length,
      ciphertext,
      iv,
    };
  });
  if (totalBytes > MAX_RECOVERY_BYTES) throw bad("Backup too large", 413);
  const res = await db.e2ee.putRecoveryBackup({ userId, salt, chunks: clean });
  // Optional RECOVERY WRAPS (auto-restore): the recovery secret wrapped
  // client-side under a password- OR passphrase-derived key. Opaque to us — we
  // store verbatim with basic shape/size guards only, and NEVER see the
  // password/passphrase or the secret. An absent field leaves existing wraps
  // untouched (opportunistic refreshes hold no key material). Legacy callers send
  // a single { passwordWrap }; Slice-2 callers send a `wraps` array so a user can
  // have BOTH a password wrap and a recovery-passphrase wrap.
  await storeRecoveryWrap(userId, body.passwordWrap, "password");
  if (Array.isArray(body.wraps))
    for (const w of body.wraps) await storeRecoveryWrap(userId, w, "passphrase");
  return { ok: true, version: res.version };
}

// 'account' = the recovery secret wrapped under the user's server-escrowed
// account key (getOrCreateAccountKey) — the automatic, prompt-free restore path.
const VALID_WRAP_KINDS = new Set(["password", "passphrase", "legacy-password", "account"]);
async function storeRecoveryWrap(userId: string, w: any, defaultKind: string) {
  if (!w || typeof w !== "object") return;
  const kind = VALID_WRAP_KINDS.has(w.kind) ? w.kind : defaultKind;
  const ct = requireString(w.ct, "wrap.ct");
  const iv = requireString(w.iv, "wrap.iv");
  const kdfSalt = requireString(w.salt, "wrap.salt");
  if (ct.length > 512 || iv.length > 64 || kdfSalt.length > 64)
    throw bad("Recovery wrap too large", 413);
  const iterations = Number(w.iterations) || 310000;
  if (iterations < 100000 || iterations > 5_000_000)
    throw bad("Recovery wrap iterations out of range");
  await db.e2ee.putRecoveryWrap({ userId, kind, ct, iv, kdfSalt, iterations });
}

// Add/replace a SINGLE recovery wrap (e.g. a recovery-passphrase wrap of the same
// secret) without touching the backup chunks. Opaque to us — shape/size guarded.
async function putRecoveryWrap(userId: string, body: any) {
  await storeRecoveryWrap(userId, body, "passphrase");
  return { ok: true };
}

// Remove a single recovery-wrap kind (e.g. the user clears their recovery
// passphrase) without deleting the backup itself or the other wraps.
async function deleteRecoveryWrap(userId: string, kind: string) {
  const k = VALID_WRAP_KINDS.has(kind) ? kind : "passphrase";
  return db.e2ee.deleteRecoveryWrap(userId, k);
}

async function getRecoveryBackup(userId: string) {
  return (await db.e2ee.getRecoveryBackup(userId)) || null;
}

// Backup METADATA (salt, version, wraps, size, and the first chunk as a probe)
// without the chunk ciphertext. Every "is there a backup / which wraps exist /
// what's the salt / does my key still open it" check used to download the whole
// backup — tens of MB once it covers full history — to read one field. Still
// blind: the probe is one opaque chunk the client may try to decrypt locally.
async function getRecoveryBackupMeta(userId: string) {
  if (typeof db.e2ee.getRecoveryBackupMeta === "function")
    return (await db.e2ee.getRecoveryBackupMeta(userId)) || null;
  // Driver without the dedicated query → derive the same shape from the full row set.
  const full: any = await db.e2ee.getRecoveryBackup(userId);
  if (!full) return null;
  const chunks = Array.isArray(full.chunks) ? full.chunks : [];
  return {
    salt: full.salt,
    version: full.version,
    chunkCount: chunks.length,
    byteLen: chunks.reduce((n: number, c: any) => n + Buffer.byteLength(String(c.ciphertext || ""), "utf8"), 0),
    passwordWrap: full.passwordWrap || null,
    wraps: full.wraps || [],
    probe: chunks.length ? { ciphertext: chunks[0].ciphertext, iv: chunks[0].iv } : null,
  };
}

async function deleteRecoveryBackup(userId: string) {
  return db.e2ee.deleteRecoveryBackup(userId);
}

// ---- Automatic recovery: the user's ACCOUNT KEY ---------------------------
// One random 32-byte key per user, sealed at rest (e2eeEscrow) and returned
// unsealed ONLY to that user's authenticated session. The client wraps the
// recovery secret under it (wrap kind 'account'); any signed-in device can then
// unwrap and restore its history with no prompt. userId comes from the JWT.
// Gated by E2EE_AUTO_RECOVERY so the strictly server-blind model stays one
// flag away.
function escrowSecret(): string {
  return config.e2ee.escrowSecret || config.auth.jwtSecret || "";
}

async function getOrCreateAccountKey(userId: string): Promise<{ key: string }> {
  if (!config.e2ee.autoRecovery) throw bad("Automatic recovery is disabled", 404);
  const secret = escrowSecret();
  if (!secret) throw bad("Automatic recovery is not configured", 503);
  let sealed = await db.e2ee.getAccountKey(userId);
  if (!sealed) {
    await db.e2ee.putAccountKeyIfAbsent({ userId, sealed: sealAccountKey(newAccountKey(), secret) });
    sealed = await db.e2ee.getAccountKey(userId); // the winner's row, whichever device won
  }
  if (!sealed) throw bad("Could not establish an account key", 500);
  try {
    return { key: openAccountKey(sealed, secret).toString("base64") };
  } catch (_) {
    // The escrow secret was ROTATED (or the JWT-secret fallback changed) since
    // this key was sealed, so it can never be opened again. Mint a fresh one
    // rather than 500-ing forever: the existing 'account' wrap becomes stale, but
    // every device that holds the recovery secret re-wraps under the new key on
    // its next init (the client verifies the wrap opens), so the automatic path
    // heals itself after one boot of any such device.
    console.warn("[e2ee] account key for %s cannot be unsealed (escrow secret changed) — re-minting", userId);
    await db.e2ee.deleteAccountKey(userId);
    await db.e2ee.putAccountKeyIfAbsent({ userId, sealed: sealAccountKey(newAccountKey(), secret) });
    const fresh = await db.e2ee.getAccountKey(userId);
    if (!fresh) throw bad("Could not establish an account key", 500);
    return { key: openAccountKey(fresh, secret).toString("base64") };
  }
}

async function putConversationKeys(
  actorId: string,
  conversationId: string,
  envelopes: any[],
) {
  if (!(await db.conversations.isMember(conversationId, actorId)))
    throw bad("You are not a member of this conversation", 403);
  // Same guard as createConversationEpoch: skip synthetic "meeting:<id>"
  // conversations with no backing row, which would violate the FK on insert.
  if (!(await db.conversations.getById(conversationId)))
    return { count: 0, memberUserIds: [] as string[] };
  // Store key rows ONLY for devices belonging to CURRENT MEMBERS. Previously only
  // the ACTOR was gated, so a member could create rows for (or notify) arbitrary
  // non-member userIds. Confidentiality already held (rows are sealed to the
  // target's key and reads are member-gated), but this closes the row-injection +
  // cross-user KEYS_UPDATED disclosure and scopes the notify to real members.
  const memberOf = new Map<string, boolean>();
  const storedUsers = new Set<string>();
  let count = 0;
  for (const env of envelopes || []) {
    const uid = requireString(env.userId, "userId");
    let isMem = memberOf.get(uid);
    if (isMem === undefined) {
      isMem = await db.conversations.isMember(conversationId, uid);
      memberOf.set(uid, isMem);
    }
    if (!isMem) continue; // never store a key row for a non-member
    await db.e2ee.putConversationKey({
      conversationId,
      deviceId: requireString(env.deviceId, "deviceId"),
      userId: uid,
      keyVersion: Number(env.keyVersion) || 1,
      encryptedKey: requireString(env.encryptedKey, "encryptedKey"),
      algorithm: env.algorithm || "x25519-aes-gcm",
    });
    storedUsers.add(uid);
    count++;
  }
  return { count, memberUserIds: Array.from(storedUsers) };
}

async function myConversationKeys(userId: string, conversationId: string) {
  if (!(await db.conversations.isMember(conversationId, userId)))
    throw bad("You are not a member of this conversation", 403);
  return db.e2ee.listConversationKeys({ conversationId, userId });
}

// Epoch-key backfill authz gate. A device that can't decrypt a GROUP conversation
// asks members to re-wrap the epoch key to it. Only a MEMBER may trigger this (the
// route then relays to the conversation room). Throws 403 otherwise. The device
// identity that gets re-keyed is taken from the caller's JWT in the route, never a
// body, so a member can only ever request a re-key for THEIR OWN device.
async function requestEpochRekey(actorId: string, conversationId: string) {
  if (!(await db.conversations.isMember(conversationId, actorId)))
    throw bad("You are not a member of this conversation", 403);
  return { requested: true };
}

// Atomically claim a new group-key epoch (race-free; see driver). Returns
// { created } so the client adopts the winner's key when it loses the race.
async function createConversationEpoch(
  actorId: string,
  conversationId: string,
  version: number,
  envelopes: any[],
) {
  if (!(await db.conversations.isMember(conversationId, actorId)))
    throw bad("You are not a member of this conversation", 403);
  // A meeting can use a SYNTHETIC "meeting:<id>" conversation that has no row in
  // the conversations table. Writing an epoch key for it violated the
  // e2ee_conversation_keys → conversations FK — a 500 and heavy error-log spam
  // (POST /epoch was the loudest live error). Group epoch keys apply only to
  // persisted conversations, so skip gracefully when there's no backing row; a
  // meeting with a REAL backing conversation still keys normally.
  if (!(await db.conversations.getById(conversationId)))
    return { created: false, skipped: "no-conversation" };
  const clean = (envelopes || []).map((env) => ({
    deviceId: requireString(env.deviceId, "deviceId"),
    userId: requireString(env.userId, "userId"),
    encryptedKey: requireString(env.encryptedKey, "encryptedKey"),
    algorithm: env.algorithm || "ecies-p256-aesgcm",
  }));
  return db.e2ee.createConversationEpoch({
    conversationId,
    version: Number(version) || 1,
    envelopes: clean,
  });
}

// ---- Member re-delivery of a single DM message --------------------------
// A device that cannot open its envelope for a message (it did not exist when
// the message was sent, its one-time key is gone, its identity changed) asks
// the OTHER MEMBERS' devices — which still hold the plaintext of what they
// sent or read — to seal the message to it again. The server never sees
// plaintext: it stores the ask (0126, so an offline member answers on its next
// sign-in), relays it to the conversation, and appends the new opaque envelope
// next to the existing ones. Authorization: the requester must be a member of
// the message's conversation and own the device; only a current member may
// add an envelope, and only for a non-revoked device of a current member. An
// envelope added by someone other than the original sender is tagged
// `redeliveredBy`, so the reader verifies it against THAT device's signing key
// and can show who restored it.
const REDELIVER_TTL_SECONDS = 7 * 24 * 3600;

async function requestRedelivery(
  userId: string,
  jwtDeviceId: string | null,
  messageId: string,
  body: any,
) {
  const msg: any = await db.messages.getById(messageId);
  if (!msg) throw bad("Message not found", 404);
  if (!(await db.conversations.isMember(msg.conversationId, userId)))
    throw bad("You are not a member of this conversation", 403);
  if (!Array.isArray(msg.ciphertext)) throw bad("Not a per-device encrypted message", 400);
  let deviceId = jwtDeviceId || null;
  if (!deviceId && body && body.deviceId) {
    const dev = await db.e2ee.getDevice(String(body.deviceId));
    if (dev && dev.userId === userId && !dev.revoked) deviceId = String(body.deviceId);
  }
  if (!deviceId) throw bad("No device identity", 400);
  try {
    await db.e2ee.putRedeliverRequest({
      messageId: String(msg.id),
      conversationId: String(msg.conversationId),
      requesterUserId: userId,
      requesterDeviceId: deviceId,
      ttlSeconds: REDELIVER_TTL_SECONDS,
    });
  } catch (_) {
    /* pre-0126 database: the live relay below still works */
  }
  return {
    senderId: msg.senderId ? String(msg.senderId) : null,
    conversationId: String(msg.conversationId),
    messageId: String(msg.id),
    userId,
    deviceId,
  };
}

// MIGRATION sweep: a device asks for EVERY per-device message it cannot open
// in one go (the audit walk at init), not only the rows on screen. Same
// authorization as the single ask, applied per message; unknown ids and
// non-member conversations are skipped, never fatal.
async function requestRedeliveryBulk(userId: string, jwtDeviceId: string | null, body: any) {
  let deviceId = jwtDeviceId || null;
  if (!deviceId && body && body.deviceId) {
    const dev = await db.e2ee.getDevice(String(body.deviceId));
    if (dev && dev.userId === userId && !dev.revoked) deviceId = String(body.deviceId);
  }
  if (!deviceId) throw bad("No device identity", 400);
  const ids = (Array.isArray(body?.messageIds) ? body.messageIds : [])
    .filter((x: any) => typeof x === "string" && x)
    .slice(0, 200);
  const memberOf = new Map<string, boolean>();
  const byConv = new Map<string, string[]>();
  for (const id of ids) {
    const msg: any = await db.messages.getById(id).catch(() => null);
    if (!msg || !Array.isArray(msg.ciphertext)) continue;
    const cid = String(msg.conversationId);
    let isMem = memberOf.get(cid);
    if (isMem === undefined) {
      isMem = await db.conversations.isMember(cid, userId);
      memberOf.set(cid, isMem);
    }
    if (!isMem) continue;
    try {
      await db.e2ee.putRedeliverRequest({
        messageId: String(msg.id),
        conversationId: cid,
        requesterUserId: userId,
        requesterDeviceId: deviceId,
        ttlSeconds: REDELIVER_TTL_SECONDS,
      });
    } catch (_) { /* pre-0126 database: live relay only */ }
    const list = byConv.get(cid) || [];
    list.push(String(msg.id));
    byConv.set(cid, list);
  }
  return {
    userId,
    deviceId,
    conversations: [...byConv.entries()].map(([conversationId, messageIds]) => ({ conversationId, messageIds })),
  };
}

// For the rows the caller is waiting on in one conversation: which asks are
// still open, and whether any device is left that has not yet had a chance to
// answer. A device "had its chance" once it was seen after the ask (plus a
// grace for the hourly last-seen stamp). When every candidate device has had
// its chance and the ask is still open, nobody holds that message any more —
// the client shows that instead of "Restoring…" forever.
const REDELIVER_GRACE_MS = 2 * 60 * 1000;
const REDELIVER_MIN_AGE_MS = 5 * 60 * 1000;
const REDELIVER_ACTIVE_DAYS = 14;
async function redeliverStatus(userId: string, jwtDeviceId: string | null, query: any) {
  const conversationId = requireString(query && query.conversationId, "conversationId");
  const deviceId = jwtDeviceId || (query && query.deviceId ? String(query.deviceId) : null);
  if (!deviceId) throw bad("No device identity", 400);
  if (!(await db.conversations.isMember(conversationId, userId)))
    throw bad("You are not a member of this conversation", 403);
  let st: any;
  try {
    st = await db.e2ee.listRedeliverStatus({ userId, conversationId, requesterDeviceId: deviceId });
  } catch (_) {
    return { asks: [] }; // pre-0126 database
  }
  const now = Date.now();
  const seenMs = (d: any) => {
    const t = Date.parse(d.lastSeenAt || d.createdAt || "");
    return Number.isNaN(t) ? 0 : t;
  };
  // Only devices used recently can realistically answer. Every browser profile,
  // reinstall and wiped device leaves a row behind; counting those dead rows as
  // "might still answer" kept a row on "Restoring…" forever.
  const ACTIVE_MS = REDELIVER_ACTIVE_DAYS * 24 * 3600 * 1000;
  const candidates = st.devices.filter((d: any) => now - seenMs(d) < ACTIVE_MS);
  return {
    asks: st.asks.map((a: any) => {
      const askedAt = Date.parse(a.askedAt) || now;
      const pendingDevices = candidates.filter((d: any) => seenMs(d) < askedAt + REDELIVER_GRACE_MS).length;
      const oldEnough = now - askedAt > REDELIVER_MIN_AGE_MS;
      return {
        messageId: a.messageId,
        askedAt: a.askedAt,
        candidateDevices: candidates.length,
        pendingDevices,
        // Nobody left to answer: every active device that could hold it has been
        // online since the ask (or there is none), and the ask is still open.
        unanswerable: oldEnough && (candidates.length === 0 || pendingDevices === 0),
      };
    }),
  };
}

// Pending asks a member's device can answer: every live request in a
// conversation the caller belongs to, except the caller's own device's.
async function listRedeliverRequests(userId: string, jwtDeviceId: string | null, query: any) {
  const excludeDeviceId = jwtDeviceId || (query && query.deviceId ? String(query.deviceId) : null);
  try {
    return await db.e2ee.listRedeliverRequestsFor({ userId, excludeDeviceId, limit: 500 });
  } catch (_) {
    return []; // pre-0126 database
  }
}

async function putRedeliveredEnvelope(userId: string, messageId: string, body: any) {
  const msg: any = await db.messages.getById(messageId);
  if (!msg) throw bad("Message not found", 404);
  if (!Array.isArray(msg.ciphertext)) throw bad("Not a per-device encrypted message", 400);
  if (!(await db.conversations.isMember(msg.conversationId, userId)))
    throw bad("Only a member of this conversation can re-deliver a message", 403);
  const recipientId = requireString(body && body.recipientId, "recipientId");
  const recipientDeviceId = requireString(body && body.recipientDeviceId, "recipientDeviceId");
  const env = body && body.envelope;
  const envBody = requireString(env && env.body, "envelope.body");
  const senderDeviceId = requireString(env && env.senderDeviceId, "envelope.senderDeviceId");
  if (!(await db.conversations.isMember(msg.conversationId, recipientId)))
    throw bad("Recipient is not a member of this conversation", 403);
  const dev = await db.e2ee.getDevice(recipientDeviceId);
  if (!dev || dev.userId !== recipientId || dev.revoked)
    throw bad("Recipient device is unknown or revoked", 400);
  const own = await db.e2ee.getDevice(senderDeviceId);
  if (!own || own.userId !== userId || own.revoked)
    throw bad("Re-delivering device is unknown or revoked", 400);
  const bySender = String(msg.senderId || "") === String(userId);
  const entry: any = {
    type: Number(env.type) || 1,
    body: envBody,
    recipientId,
    recipientDeviceId,
    senderDeviceId,
  };
  if (!bySender) entry.redeliveredBy = { userId, deviceId: senderDeviceId };
  const others = (msg.ciphertext as any[]).filter(
    (e) => !(e && String(e.recipientId) === recipientId && String(e.recipientDeviceId) === recipientDeviceId),
  );
  if (others.length + 1 > 512) throw bad("Too many envelopes on this message", 413);
  await db.messages.update(messageId, {
    ciphertext: [...others, entry],
    encryptionVersion: Number(msg.encryptionVersion) || 1,
  });
  try {
    await db.e2ee.deleteRedeliverRequest({ messageId: String(msg.id), requesterDeviceId: recipientDeviceId });
  } catch (_) { /* pre-0126 database */ }
  return { messageId: String(msg.id), conversationId: String(msg.conversationId), recipientId, recipientDeviceId };
}

// One encrypted message's envelope set, for a member's device that is asked to
// re-deliver it but no longer has the plaintext cached: it may still be able to
// open its OWN envelope (the sender's self-copy, or a non-one-time-key copy).
async function getMessageEnvelopes(userId: string, messageId: string) {
  const msg: any = await db.messages.getById(messageId);
  if (!msg) throw bad("Message not found", 404);
  if (!(await db.conversations.isMember(msg.conversationId, userId)))
    throw bad("You are not a member of this conversation", 403);
  return {
    id: String(msg.id),
    conversationId: String(msg.conversationId),
    senderId: msg.senderId ? String(msg.senderId) : null,
    type: msg.type || "text",
    createdAt: msg.createdAt,
    encrypted: Number(msg.encryptionVersion) > 0,
    ciphertext: msg.ciphertext || null,
  };
}

// Batched form for the answering device: for up to 200 messages, only the
// envelope addressed to the CALLER'S device (small payload, one round-trip).
async function getOwnEnvelopesBulk(userId: string, jwtDeviceId: string | null, body: any) {
  let deviceId = jwtDeviceId || null;
  if (!deviceId && body && body.deviceId) {
    const dev = await db.e2ee.getDevice(String(body.deviceId));
    if (dev && dev.userId === userId && !dev.revoked) deviceId = String(body.deviceId);
  }
  if (!deviceId) throw bad("No device identity", 400);
  const ids = (Array.isArray(body?.messageIds) ? body.messageIds : [])
    .filter((x: any) => typeof x === "string" && x)
    .slice(0, 200);
  const memberOf = new Map<string, boolean>();
  const out: any[] = [];
  for (const id of ids) {
    const msg: any = await db.messages.getById(id).catch(() => null);
    if (!msg || !Array.isArray(msg.ciphertext)) continue;
    const cid = String(msg.conversationId);
    let isMem = memberOf.get(cid);
    if (isMem === undefined) {
      isMem = await db.conversations.isMember(cid, userId);
      memberOf.set(cid, isMem);
    }
    if (!isMem) continue;
    const env = (msg.ciphertext as any[]).find(
      (e) => e && String(e.recipientId) === String(userId) && String(e.recipientDeviceId) === String(deviceId),
    );
    out.push({
      id: String(msg.id),
      conversationId: cid,
      senderId: msg.senderId ? String(msg.senderId) : null,
      type: msg.type || "text",
      createdAt: msg.createdAt,
      envelope: env || null,
    });
  }
  return out;
}

// ---- Recovery diagnostics for the caller ----------------------------------
// Everything the SERVER can say about why a device might not be able to restore
// history, in one call, so a support screenshot is conclusive. No secrets, no
// ciphertext: only presence, counts, kinds and timestamps.
async function recoveryDiagnostics(userId: string, jwtDeviceId: string | null, query: any) {
  const deviceId = jwtDeviceId || (query && query.deviceId ? String(query.deviceId) : null);
  const out: any = {
    serverTime: new Date().toISOString(),
    e2eeEnabled: !!config.e2ee.enabled,
    autoRecovery: !!config.e2ee.autoRecovery,
    escrowConfigured: !!escrowSecret(),
    accountKey: "unknown",
    backup: null as any,
    devices: [] as any[],
    thisDevice: null as any,
    pendingSyncBundles: null as any,
    pendingRedeliverRequests: null as any,
    tokenBoundToDevice: !!jwtDeviceId,
  };
  if (!config.e2ee.autoRecovery) out.accountKey = "disabled";
  else if (!escrowSecret()) out.accountKey = "not-configured";
  else {
    try {
      const sealed = await db.e2ee.getAccountKey(userId);
      if (!sealed) out.accountKey = "not-minted-yet";
      else {
        try {
          openAccountKey(sealed, escrowSecret());
          out.accountKey = "ok";
        } catch (_) {
          out.accountKey = "unsealable (escrow secret changed)";
        }
      }
    } catch (e: any) {
      out.accountKey = "error: " + String(e && e.message ? e.message : e).slice(0, 120);
    }
  }
  try {
    const meta: any = await getRecoveryBackupMeta(userId);
    out.backup = meta
      ? {
          exists: true,
          version: meta.version,
          chunkCount: meta.chunkCount,
          byteLen: meta.byteLen,
          wraps: (meta.wraps || []).map((w: any) => w.kind),
        }
      : { exists: false };
  } catch (e: any) {
    out.backup = { error: String(e && e.message ? e.message : e).slice(0, 120) };
  }
  try {
    const devs: any[] = await db.e2ee.listDevices(userId);
    out.devices = devs.map((d) => ({
      id: String(d.id),
      trusted: !!d.trusted,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt || null,
    }));
    if (deviceId) {
      const mine = devs.find((d) => String(d.id) === String(deviceId));
      out.thisDevice = mine
        ? { id: String(deviceId), known: true, trusted: !!mine.trusted, lastSeenAt: mine.lastSeenAt || null }
        : { id: String(deviceId), known: false };
    }
  } catch (e: any) {
    out.devices = { error: String(e && e.message ? e.message : e).slice(0, 120) };
  }
  if (deviceId) {
    try {
      const rows = await db.e2ee.listHistorySyncFor({ targetUserId: userId, targetDeviceId: deviceId });
      out.pendingSyncBundles = new Set((rows || []).map((r: any) => r.bundleId)).size;
    } catch (_) { out.pendingSyncBundles = "error"; }
  }
  try {
    out.pendingRedeliverRequests = await db.e2ee.countRedeliverRequestsBy({ userId });
  } catch (_) {
    out.pendingRedeliverRequests = "table missing (migration 0126 not applied)";
  }
  return out;
}

export {
  requestRedelivery,
  requestRedeliveryBulk,
  listRedeliverRequests,
  redeliverStatus,
  getMessageEnvelopes,
  getOwnEnvelopesBulk,
  putRedeliveredEnvelope,
  recoveryDiagnostics,
  registerDevice,
  myDevices,
  revokeDevice,
  approveDevice,
  publishPreKeys,
  consumePreKey,
  bundleFor,
  putConversationKeys,
  myConversationKeys,
  requestEpochRekey,
  createConversationEpoch,
  uploadHistorySync,
  fetchHistorySync,
  ackHistorySync,
  requestHistorySync,
  putRecoveryBackup,
  getRecoveryBackup,
  getRecoveryBackupMeta,
  deleteRecoveryBackup,
  getOrCreateAccountKey,
  putRecoveryWrap,
  deleteRecoveryWrap,
};
