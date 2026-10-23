import { clearMediaCache } from "../mediaCache";

export class SignalStore {
  dbName = "signal-store";
  // v2 adds the TOFU `trustedIdentities` store (pinned peer identity keys for
  // MITM detection). v3 adds `plaintextCache` — locally-cached decrypted message
  // text so forward secrecy can delete one-time prekeys after first decrypt yet
  // still re-render history. v4 adds `convFlags` — a persistent per-conversation
  // "this conversation is E2EE" pin (TOFU for encryption status) so a malicious
  // server can never force a downgrade by serving plaintext after the conversation
  // has carried an authenticated encrypted message. v5 adds `replayLog` — the
  // anti-replay seenMid map persisted to IndexedDB so cross-reload replay is
  // also blocked (V1 hardening; in-memory map alone was cleared on reload).
  // v6 adds `ratchetSessions` — per-peer Double Ratchet session state (RK, CKs,
  // CKr, DH keypair). Keyed by "userId:deviceId:conversationId" so each DM
  // pair has its own ratchet. Persistence is required — losing state would
  // brick the conversation since both sides must agree on chain counters.
  // v7 adds `recoveryKek` (Mechanism B) — the AES-GCM-256 key-encryption-key
  // derived from the user's one-time recovery key, cached as a NON-EXTRACTABLE
  // CryptoKey (structured-clone, never exportable by JS/XSS) so the device can
  // auto-refresh the encrypted history backup without re-prompting for the key.
  // Cleared on user-switch / device-reset (a wiped device then needs the user's
  // recovery key to restore — correct).
  // v8 adds `recoverySecret` (Slice 2) — the 32 RAW bytes the recovery KEK is
  // derived from. Held so the device can add ANOTHER wrap of the SAME secret (e.g.
  // a user-set recovery passphrase) WITHOUT rotating the secret — rotating would
  // invalidate every other wrap. Stored as raw bytes (not a non-extractable
  // CryptoKey) because wrapping needs the plaintext; exposure is bounded since this
  // device already holds the KEK + decrypted history, so a local attacker gains no
  // history they couldn't already read. Cleared on user-switch / device-reset.
  // onupgradeneeded is additive — earlier installs upgrade without losing data.
  dbVersion = 8;
  db: IDBDatabase | null = null;

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.dbVersion);
      req.onupgradeneeded = (e: any) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("identity")) {
          db.createObjectStore("identity", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("prekeys")) {
          db.createObjectStore("prekeys", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("signedPreKeys")) {
          db.createObjectStore("signedPreKeys", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("senderKeys")) {
          db.createObjectStore("senderKeys", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("trustedIdentities")) {
          db.createObjectStore("trustedIdentities", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("plaintextCache")) {
          db.createObjectStore("plaintextCache", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("convFlags")) {
          db.createObjectStore("convFlags", { keyPath: "id" });
        }
        // v5: anti-replay log. Key = mid (message UUID bound in AAD);
        // value = server message id it was first seen under + first-seen ts.
        if (!db.objectStoreNames.contains("replayLog")) {
          db.createObjectStore("replayLog", { keyPath: "id" });
        }
        // v6: Double Ratchet sessions. Key = "userId:deviceId:conversationId";
        // value = the full serialized RatchetState (see lib/e2ee/ratchet.ts).
        if (!db.objectStoreNames.contains("ratchetSessions")) {
          db.createObjectStore("ratchetSessions", { keyPath: "id" });
        }
        // v7: Mechanism B recovery KEK cache. Single record (id "kek") holding the
        // non-extractable AES-GCM CryptoKey derived from the user's recovery key.
        if (!db.objectStoreNames.contains("recoveryKek")) {
          db.createObjectStore("recoveryKek", { keyPath: "id" });
        }
        // v8: Mechanism-B recovery SECRET cache. Single record (id "secret")
        // holding the 32 raw bytes the KEK is derived from, so a new wrap of the
        // same secret can be added without rotating.
        if (!db.objectStoreNames.contains("recoverySecret")) {
          db.createObjectStore("recoverySecret", { keyPath: "id" });
        }
      };
      req.onsuccess = (e: any) => {
        this.db = e.target.result;
        // Best-effort: ask the browser to make this origin's storage PERSISTENT so the
        // decrypted-plaintext cache + ratchet sessions are exempt from eviction under
        // storage pressure. Losing those is the primary cause of a once-readable E2EE
        // message becoming permanently "unavailable" — a consumed ratchet/OPK key can
        // never be re-derived. No-op where unsupported; never blocks the DB open.
        try {
          const st: any = typeof navigator !== "undefined" ? (navigator as any).storage : null;
          if (st && typeof st.persist === "function" && typeof st.persisted === "function") {
            st.persisted().then((already: boolean) => { if (!already) st.persist().catch(() => {}); }).catch(() => {});
          }
        } catch (_) {}
        resolve(this.db);
      };
      req.onerror = reject;
    });
  }

  private async _put(storeName: string, id: string | number, data: any) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.put({ id, ...data });
      req.onsuccess = () => resolve(true);
      req.onerror = reject;
    });
  }

  private async _get(storeName: string, id: string | number): Promise<any> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.get(id);
      req.onsuccess = (e: any) => resolve(e.target.result || null);
      req.onerror = reject;
    });
  }

  async getIdentityKeyPair() {
    const res = await this._get("identity", "keyPair");
    return res ? res.keyPair : null;
  }
  async getLocalRegistrationId() {
    const res = await this._get("identity", "registrationId");
    return res ? res.registrationId : null;
  }
  async putIdentityKeyPair(keyPair: any) {
    return this._put("identity", "keyPair", { keyPair });
  }
  async putLocalRegistrationId(registrationId: number) {
    return this._put("identity", "registrationId", { registrationId });
  }
  // Same-device owner marker. Lets login detect a DIFFERENT user signing in on
  // this browser so we can wipe the prior user's E2EE material (their cached
  // plaintext / sessions / ratchet) instead of leaking it. Reuses the existing
  // `identity` store (no dbVersion bump — _get/_put take an arbitrary id).
  async getDeviceOwner(): Promise<string | null> { const res = await this._get("identity", "deviceOwner"); return res ? res.userId : null; }
  async putDeviceOwner(userId: string) { return this._put("identity", "deviceOwner", { userId }); }
  async wipeForUserSwitch() {
    if (!this.db) await this.init();
    const stores = ["identity","prekeys","signedPreKeys","sessions","senderKeys","trustedIdentities","plaintextCache","convFlags","replayLog","ratchetSessions","recoveryKek","recoverySecret"];
    // Also purge the separate decrypted-media cache (lib/mediaCache) — same at-rest
    // posture as plaintextCache above, so the next user on this device never
    // inherits the prior user's decrypted attachments. Best-effort.
    try { await clearMediaCache(); } catch (_) {}
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(stores, "readwrite");
      stores.forEach((s) => tx.objectStore(s).clear());
      tx.oncomplete = () => resolve(true);
      tx.onerror = reject;
    });
  }
  // SAME-USER re-enrolment: drop only the key material that defines this device's
  // identity (identity/signing/ratchet keys, prekeys, sessions, sender keys) so
  // the next init mints a fresh device — but KEEP everything that belongs to the
  // user rather than to the key pair: decrypted history (plaintextCache), the
  // backup key + secret, the per-conversation E2EE pins, the replay log and the
  // peers' pinned identities. Wiping those too (wipeForUserSwitch) is what turned
  // a healthy device's entire history into placeholders after a re-enrolment.
  async wipeIdentityOnly() {
    if (!this.db) await this.init();
    const stores = ["identity","prekeys","signedPreKeys","sessions","senderKeys","ratchetSessions"];
    const owner = await this.getDeviceOwner().catch(() => null);
    await new Promise((resolve, reject) => {
      const tx = this.db!.transaction(stores, "readwrite");
      stores.forEach((s) => tx.objectStore(s).clear());
      tx.oncomplete = () => resolve(true);
      tx.onerror = reject;
    });
    // `identity` also held the owner marker — put it back so the next init is
    // still recognised as the SAME user (and doesn't run the full user-switch wipe).
    if (owner) await this.putDeviceOwner(owner);
  }
  // B2 — sender authentication: a SECOND keypair per device dedicated to ECDSA
  // signing. Stored alongside the identity ECDH keypair in the same `identity`
  // store under a distinct id; private half is non-extractable.
  async getSigningKeyPair() {
    const res = await this._get("identity", "signingKeyPair");
    return res ? res.keyPair : null;
  }
  async putSigningKeyPair(keyPair: any) {
    return this._put("identity", "signingKeyPair", { keyPair });
  }

  // Double Ratchet Phase 1 — initial DH ratchet keypair. Stored as
  // { priv: JWK, pubB64: string } so the ratchet code can serialize it into
  // session state (the ratchet needs exportable private keys to round-trip
  // through IndexedDB). Distinct from the identity key, which stays
  // non-extractable.
  async getRatchetInitialKeyPair(): Promise<{ priv: JsonWebKey; pubB64: string } | null> {
    const res = await this._get("identity", "ratchetInitial");
    return res ? res.keyPair : null;
  }
  async putRatchetInitialKeyPair(keyPair: { priv: JsonWebKey; pubB64: string }) {
    return this._put("identity", "ratchetInitial", { keyPair });
  }

  async loadPreKey(keyId: number | string) {
    const res = await this._get("prekeys", keyId);
    return res ? res.keyPair : null;
  }
  async storePreKey(keyId: number | string, keyPair: any) {
    return this._put("prekeys", keyId, { keyPair });
  }
  // Forward secrecy: delete a one-time prekey's PRIVATE key after the message
  // that consumed it has been decrypted + locally cached. Once gone, that
  // message can never be re-derived from the long-term identity key.
  async removePreKey(keyId: number | string) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("prekeys", "readwrite");
      const req = tx.objectStore("prekeys").delete(keyId as IDBValidKey);
      req.onsuccess = () => resolve(true);
      req.onerror = reject;
    });
  }
  async countPreKeys(): Promise<number> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("prekeys", "readonly");
      const req = tx.objectStore("prekeys").count();
      req.onsuccess = (e: any) => resolve(e.target.result || 0);
      req.onerror = reject;
    });
  }

  // Local plaintext cache (forward secrecy): decrypted message text/file meta,
  // keyed by server message id, so history re-renders after the decryption key
  // is deleted. Cleared on logout.
  async getCachedPlaintext(id: string): Promise<any | null> {
    const res = await this._get("plaintextCache", id);
    return res ? res.data : null;
  }
  async putCachedPlaintext(id: string, data: any) {
    return this._put("plaintextCache", id, { data });
  }
  async clearPlaintextCache() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("plaintextCache", "readwrite");
      const req = tx.objectStore("plaintextCache").clear();
      req.onsuccess = () => resolve(true);
      req.onerror = reject;
    });
  }

  async loadSignedPreKey(keyId: number | string) {
    const res = await this._get("signedPreKeys", keyId);
    return res ? res.keyPair : null;
  }
  async storeSignedPreKey(keyId: number | string, keyPair: any) {
    return this._put("signedPreKeys", keyId, { keyPair });
  }

  async loadSession(address: string) {
    const res = await this._get("sessions", address);
    return res ? res.record : null;
  }
  async storeSession(address: string, record: any) {
    return this._put("sessions", address, { record });
  }

  async clearSessions() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("sessions", "readwrite");
      const store = tx.objectStore("sessions");
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = reject;
    });
  }

  // Phase 3A: Group Sender Key Storage
  async loadSenderKey(senderKeyName: string) {
    const res = await this._get("senderKeys", senderKeyName);
    return res ? res.record : null;
  }
  
  async storeSenderKey(senderKeyName: string, record: any) {
    return this._put("senderKeys", senderKeyName, { record });
  }

  // TOFU: pinned peer identity keys, keyed by "userId:deviceId". B2 adds an
  // optional pinned ECDSA signing key alongside the ECDH identity key — they
  // travel together (same bundle, same device) and must be pinned atomically so
  // a key-change on either is treated as a re-trust event.
  async loadTrustedIdentity(id: string): Promise<{ identityPubB64: string; signingPubB64?: string; fingerprint?: string; verified?: boolean; verifiedFingerprint?: string | null } | null> {
    const res = await this._get("trustedIdentities", id);
    return res
      ? {
          identityPubB64: res.identityPubB64,
          signingPubB64: res.signingPubB64,
          fingerprint: res.fingerprint,
          verified: !!res.verified,
          verifiedFingerprint: res.verifiedFingerprint || null,
        }
      : null;
  }
  // Preserve the OOB verification fields on re-pin: the verified-state lives
  // on the IDENTITY (identityPubB64). UI compares current fingerprint against
  // verifiedFingerprint to decide whether to show "verified" or "verified but
  // key changed — re-verify". A change to the identity key never silently
  // clears verification; the user is shown the mismatch and re-verifies.
  async storeTrustedIdentity(id: string, identityPubB64: string, fingerprint?: string, signingPubB64?: string) {
    const prev = (await this._get("trustedIdentities", id)) || {};
    return this._put("trustedIdentities", id, {
      identityPubB64,
      signingPubB64,
      fingerprint,
      verified: !!prev.verified,
      verifiedAt: prev.verifiedAt || null,
      verifiedFingerprint: prev.verifiedFingerprint || null,
    });
  }

  // TOFU for ENCRYPTION STATUS: once a conversation has carried an authenticated
  // encrypted message (or we sent one), pin it E2EE so the server cannot later
  // force a plaintext downgrade. Keyed by conversationId. Survives reload; cleared
  // only by clearing the whole store (NOT on logout — the downgrade pin must
  // outlive a session for it to be a defense).
  async getConvE2EE(conversationId: string): Promise<boolean> {
    const res = await this._get("convFlags", conversationId);
    return !!(res && res.e2ee);
  }
  // B2 — time anchor for the downgrade guard. `pinnedAt` is the server-side
  // createdAt of the FIRST encrypted message that pinned this conversation.
  // Plaintext OLDER than this is legitimate pre-cutover history (exempt from the
  // downgrade rejection); plaintext NEWER than this is a post-pin injection
  // (rejected). Returns null when the conversation isn't pinned OR was pinned by
  // an older client that recorded no anchor (caller treats null as fail-open for
  // READABILITY — see isConvE2EERequired/the guard in manager.ts). Stored on the
  // SAME convFlags record (additive field, no dbVersion bump).
  async getConvPinnedAt(conversationId: string): Promise<string | number | null> {
    const res = await this._get("convFlags", conversationId);
    return res && res.pinnedAt != null ? res.pinnedAt : null;
  }
  // Persist the pin. `pinnedAt` (first encrypted message's server createdAt) is
  // written ONCE — never overwrite an existing anchor, so the boundary stays at
  // the genuine cutover point even if a later send re-pins.
  async setConvE2EE(conversationId: string, pinnedAt?: string | number | null) {
    const cur = await this._get("convFlags", conversationId);
    const existingPinnedAt = cur && cur.pinnedAt != null ? cur.pinnedAt : null;
    const nextPinnedAt = existingPinnedAt != null ? existingPinnedAt : (pinnedAt != null ? pinnedAt : null);
    return this._put("convFlags", conversationId, { e2ee: true, pinnedAt: nextPinnedAt });
  }

  // V1 anti-replay (persistent): same mid -> different server id = replay.
  // IndexedDB-backed so a reload can't reset the seen-set; the in-memory cache
  // in manager.ts is just a hot fast-path on top of this.
  async getReplaySeen(mid: string): Promise<string | null> {
    const res = await this._get("replayLog", mid);
    return res ? res.serverId : null;
  }
  async putReplaySeen(mid: string, serverId: string) {
    return this._put("replayLog", mid, { serverId, ts: Date.now() });
  }

  // Out-of-band verification state for a peer identity. `verified` true means
  // the local user compared the safety number out-of-band and confirmed it.
  // verifiedAt + verifiedFingerprint capture WHAT was verified so a later
  // identity change can surface "verified key changed" loudly (UI surfaces it).
  async markIdentityVerified(id: string, fingerprint: string) {
    const cur = (await this._get("trustedIdentities", id)) || {};
    return this._put("trustedIdentities", id, {
      ...cur,
      verified: true,
      verifiedAt: Date.now(),
      verifiedFingerprint: fingerprint,
    });
  }
  async clearIdentityVerified(id: string) {
    const cur = await this._get("trustedIdentities", id);
    if (!cur) return false;
    return this._put("trustedIdentities", id, {
      ...cur,
      verified: false,
      verifiedAt: null,
      verifiedFingerprint: null,
    });
  }
  async isIdentityVerified(id: string): Promise<{ verified: boolean; fingerprint?: string | null }> {
    const res = await this._get("trustedIdentities", id);
    return {
      verified: !!(res && res.verified),
      fingerprint: res ? res.verifiedFingerprint : null,
    };
  }

  // Double Ratchet sessions. The full RatchetState is opaque to the store —
  // it is JSON-serializable per ratchet.ts. Sessions MUST be persistent: losing
  // state mid-conversation desyncs both parties' chain counters, which the v1
  // ratchet (no recovery) cannot heal from.
  async getRatchetSession(id: string): Promise<any | null> {
    const res = await this._get("ratchetSessions", id);
    if (!res || !res.state) return null;
    // Validate the restored state has the expected shape to catch IndexedDB
    // corruption. A session missing its root key is unrecoverable — delete it
    // and force a fresh re-initialization on the next interaction.
    const st = res.state;
    if (!st || typeof st.rk !== "string" || !st.dhsPriv) {
      try { await this.deleteRatchetSession(id); } catch (_) {}
      return null;
    }
    // Ensure skippedKeys survived serialization round-trip. Older sessions
    // (pre-out-of-order support) won't have this field — backfill it.
    if (!st.skippedKeys) st.skippedKeys = {};
    return st;
  }
  async putRatchetSession(id: string, state: any) {
    return this._put("ratchetSessions", id, { state });
  }
  async deleteRatchetSession(id: string) {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("ratchetSessions", "readwrite");
      const req = tx.objectStore("ratchetSessions").delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = reject;
    });
  }
  async clearRatchetSessions() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("ratchetSessions", "readwrite");
      const req = tx.objectStore("ratchetSessions").clear();
      req.onsuccess = () => resolve(true);
      req.onerror = reject;
    });
  }

  // Mechanism B — recovery KEK cache. The AES-GCM-256 key derived (HKDF) from the
  // user's one-time recovery key is stored as a NON-EXTRACTABLE CryptoKey via
  // structured clone; IndexedDB persists the CryptoKey object directly, so the raw
  // bytes are never exposed to JS. Lets the device auto-refresh the backup without
  // re-prompting. Cleared on user-switch / device-reset.
  async getRecoveryKek(): Promise<CryptoKey | null> {
    const res = await this._get("recoveryKek", "kek");
    return res && res.key ? (res.key as CryptoKey) : null;
  }
  async putRecoveryKek(key: CryptoKey) {
    return this._put("recoveryKek", "kek", { key });
  }
  async clearRecoveryKek() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("recoveryKek", "readwrite");
      const req = tx.objectStore("recoveryKek").clear();
      req.onsuccess = () => resolve(true);
      req.onerror = reject;
    });
  }

  // Slice 2 — recovery SECRET (raw 32 bytes). See the dbVersion note. Held so an
  // extra wrap of the SAME secret (recovery passphrase) can be minted without
  // rotating. A COPY of the bytes is stored (structured clone of the ArrayBuffer).
  async getRecoverySecret(): Promise<Uint8Array | null> {
    const res = await this._get("recoverySecret", "secret");
    if (!res || !res.bytes) return null;
    return new Uint8Array(res.bytes);
  }
  async putRecoverySecret(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    return this._put("recoverySecret", "secret", { bytes: copy.buffer });
  }
  async clearRecoverySecret() {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction("recoverySecret", "readwrite");
      const req = tx.objectStore("recoverySecret").clear();
      req.onsuccess = () => resolve(true);
      req.onerror = reject;
    });
  }
}

export const signalStore = new SignalStore();
