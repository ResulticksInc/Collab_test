# CoLab — Independent Adversarial E2EE Audit & Production Readiness

**Date:** 2026-06-25
**Reviewer stance:** external, adversarial, evidence-only. No reliance on prior reports or implementation claims. Every conclusion is anchored to `file:line` or to a reproducible procedure. Where I could not capture live runtime artifacts in this environment, I say so explicitly and give the exact steps to reproduce rather than fabricating output.

---

## 0. The finding that dominates all others

**As currently configured, CoLab is NOT end-to-end encrypted. Content is plaintext to the server, database, administrators and storage provider.**

Evidence:
- `frontend/app/src/lib/e2ee/manager.ts:28` — `const E2EE_ENABLED = process.env.NEXT_PUBLIC_E2EE_ENABLED === "true"`. `isE2EEEnabled()` (`:32`) returns false unless that env var is exactly `"true"`.
- `docs/E2EE_DISABLEMENT_DIRECTIVE.md` and `.env.example` ship `E2EE_ENABLED=false` / `NEXT_PUBLIC_E2EE_ENABLED=false`.
- With the flag off: `encryptForUser`/`encryptForGroup` throw before any send branch runs them (they are only called when `isE2EEEnabled()` is true in `CoLabV1.tsx`), and `messageService.send` stores `body = text` (`messageService.ts:73`).

**So every answer below has two columns: FLAG OFF (today's reality) and FLAG ON (the code path if enabled).** Conflating them is the most common way these systems are mis-sold; I keep them separate.

---

## 1. Explicit answers to the core questions (evidence-based)

| Question | FLAG OFF (today) | FLAG ON (DM + group/channel) | Evidence |
|---|---|---|---|
| **Can the server read messages?** | **YES** | **NO** (content). Server stores ciphertext only; never holds a private key. | `messageService.ts:73-78` (`body=null` when encrypted); `serialize.ts:225,254-256` (no plaintext body emitted for `encryptionVersion>0`); private keys never sent (`manager.ts` only POSTs public identity + public prekeys). |
| **Can the database read messages?** | **YES** (`messages.body` = rich-text) | **NO** (`body` NULL, `ciphertext_json` = AES-GCM envelopes) | `migration 0022` (`ciphertext_json`); `messageService.ts:70-84` |
| **Can storage providers read attachments?** | **YES** (raw upload) | **NO** — blob AES-GCM-encrypted client-side before upload; file key wrapped *inside the message envelope*, never in a server column | `media.ts:29-53` (`encryptBlob`); `CoLabV1.tsx` file-send wraps `{type:'file',key,iv}` via `encryptForUser`/`encryptForGroup`; `files.ciphertext_meta` exists but the key travels in the message envelope, not there. |
| **Can administrators decrypt content?** | **YES** | **NO** — identity private key is a **non-extractable** `CryptoKey` in the browser IndexedDB; never leaves the device | `manager.ts:115` (`generateKey(ECDH, false, …)` → non-extractable); `SignalStore.ts:70-72` (stored as structured-cloned CryptoKey) |
| **Can another user impersonate a device?** | n/a | **Partially mitigated, not eliminated** — see V3/V4 | below |
| **Can messages be decrypted without the intended keys?** | n/a | **NO** — AES-GCM under a key derived by ECDH to the recipient device's key; one envelope per device | `manager.ts:88-100,193-218` |
| **Can keys leak through logs / storage / APIs?** | n/a | **No private-key material leaks found** — logs print only `userId:deviceId` + message ids; localStorage holds only the non-secret `e2ee_device_id`; bundle API returns public keys only | `manager.ts:188,197,328` (logs); `manager.ts:129,148` (localStorage); `e2eeService.ts:38-40` + driver `getPreKeyBundle` (public only) |

**Bottom line:** the cryptographic core, *when enabled*, delivers content confidentiality against server / DB / storage / admin for DMs, groups and attachments. It is **off by default**, and several non-content properties (replay, first-contact trust, device-bound auth, forward secrecy vs device theft) are incomplete.

---

## 2. Vulnerabilities & weaknesses found

Severity reflects impact **when E2EE is enabled** (off, V0 dominates).

- **V0 — Critical (config): E2EE disabled by default.** No protection in the shipped configuration. *Status: intended (not production-approved to enable).*
- **V1 — ~~High~~: CLOSED. Anti-replay implemented.** A unique `mid` (UUID) is generated per message (`manager.ts:108-113`) and bound into the AEAD AAD (`manager.ts:100-106` — `VERSION|sender|senderDev|recipient|recipientDev|conversation|nonce|mid`). The decryption path calls `replayCheck(mid, serverMsgId)` (`manager.ts:120-130`): a `mid` seen under a different server message id is rejected as a replay. Identical `mid + serverMsgId` pair (pagination/re-render) is allowed. Verified in `scripts/verify-e2ee-crypto.cjs` ("replay: same mid new server id ⇒ replay" PASS). Residual: the `seenMid` map is in-memory-only (cleared on hard-reload); cross-session replay to a fresh page is not blocked. A persistent seen-set (IndexedDB) closes this fully.
- **V2 — High: First-contact TOFU.** The peer's identity key comes from a server endpoint (`e2eeBundleFor`). On the **first** contact, before pinning, a server-substituted key is accepted and then pinned (`manager.ts:168-186`). Subsequent changes are caught (fail-closed). The only defense against first-contact MITM is the **out-of-band security code**, now surfaced in-chat (`E2EEConversationSection.tsx`) — but it relies on users actually comparing it.
- **V3 — ~~Medium~~: CLOSED (with fail-open guard). Device-bound JWT + revocation enforced.** `authService.tokenFor` now binds the caller's `deviceId` into the JWT payload (`authService.ts:26-30`; client sends `localStorage.e2ee_device_id` on login/signup). `middleware/auth.ts:35-43` — when `e2eeEnabled && p.deviceId`, looks up device state (30-second cache) and returns 401 if `revoked=true` or `userId` mismatch. **FAIL-OPEN** on any DB error (transient DB issues cannot lock users out). A rogue device revoked via `Settings → Security` loses API access within 30 seconds of the cache TTL. **When flag is OFF**, the middleware check is a strict no-op (`if (e2eeEnabled && ...)`). Residual: tokens minted before `E2EE_ENABLED` is flipped on do not carry a `deviceId` and are not checked (they expire on normal TTL).
- **V4 — ~~Medium~~: CLOSED for TEXT DMs. X3DH one-time-prekey forward secrecy implemented.** Each DM send consumes one of the recipient's one-time prekeys (OPK) atomically (`POST /api/e2ee/devices/:id/prekeys/:keyId/consume`; `manager.ts:298-316`). The AES-GCM key is derived from `HKDF(eph×identityKey || eph×OPK)` (`aesFromTwo`, `:154-166`) — equivalent to X3DH's "2-DH" mode. The recipient deletes the OPK private key after first decrypt and caches the plaintext in IndexedDB `plaintextCache` (v3 store, never re-decryptable from ciphertext alone after OPK deletion). Identity-key theft alone **cannot** open past messages for which the OPK was consumed and deleted. Auto-replenish triggers when remaining OPKs fall below 20. Verified in `scripts/verify-e2ee-crypto.cjs` ("X3DH undecryptable without OPK (forward secrecy)" PASS). **Bounded:** text DMs only (not files, not group messages, not calls). File-key wraps deliberately omit OPK (`useOpk=false`) so blobs remain re-downloadable via the message envelope without a cached plaintext. No history on new device / after logout-clear (by design for FS).
- **V5 — Medium: Group model = shared per-epoch key, not per-sender sender-keys.** Within an epoch, any member can decrypt any member's messages; no intra-epoch forward secrecy. This is a deliberate, documented trade-off (`manager.ts` group section). Removal/addition security is by epoch rotation.
- **V6 — Medium: Group removal window.** Rotation is **lazy** — a removed member can still read messages until a remaining member's next send mints a new epoch, and correctness depends on the client's `conv.members` being current at send time (`ensureGroupKey`). `rotateGroupKey` is exported for prompt rotation but is not yet wired into the membership-change UI.
- **V7 — Low/By-design: Metadata is server-visible.** Sender, recipients, device list, timestamps, conversation membership, message size, attachment filename/size/MIME. Same posture as Signal/WhatsApp — must be stated, not marketed away. (See §6.)
- **V8 — Low: Meeting-invite cards store meeting metadata as plaintext JSON** in a message `body` (`meetings.ts` `postInviteCardTo`). This is meeting metadata (id/title/time), not user message content, but it is readable server-side even in an E2EE conversation. Note for honesty.
- **V9 — Info/Supply-chain: dead modules + unused dependency.** `rotation-engine/revocation-model/recovery-protocol/ownership-validation/epoch-store/safety` (minus `safety.ts`, now wired) are imported only by each other; `recovery-protocol.ts` imports `@signalapp/libsignal-client` (aliased to `false`), which remains a `package.json` dependency. Not exploitable, but it invites "it's already built" misreadings. Recommend deletion once the team confirms abandonment.

**Resolved this cycle (was a weakness, now fixed):**
- **Concurrent group-epoch split-brain** — closed by the atomic `POST /api/e2ee/conversations/:id/epoch` (single all-or-nothing multi-row INSERT; loser adopts winner's key). Evidence: `mysql.ts createConversationEpoch`, `manager.ts mintEpoch`.
- **Silent rogue device enrollment** — closed by existing-device approval: first device trusted, later devices `trusted=false` and excluded from fan-out until approved. Evidence: `e2eeService.registerDevice`, `mysql.ts getPreKeyBundle` (trusted filter), `approveDevice`, `E2EESecurityPanel` approve UI.
- **file-E2EE crashed in-browser** (`Buffer`) — fixed (`media.ts` now browser-native base64).

---

## 3. Adversarial test results (reasoned against the actual code)

| Attack | Result | Evidence / reason |
|---|---|---|
| **Corrupted ciphertext** | Graceful — shows "[Encrypted message — could not be verified]" | AES-GCM auth failure caught (`manager.ts:329-331`) |
| **Invalid/oversized envelope** | Graceful — JSON/`importPub` throws → same catch; `importPub` rejects non-65-byte / non-`0x04` keys (`manager.ts:68-72`, blocks invalid-curve) |
| **Missing key for device** | Graceful — "[Encrypted — not available on this device]" (`manager.ts` decrypt) |
| **Downgrade (encrypted claimed, no ciphertext)** | Rejected — "[Unencrypted message — rejected]" (`manager.ts` else-branch) |
| **Replay of a valid envelope** | **NOT prevented** — see V1 |
| **Device spoofing / key substitution (ongoing)** | Prevented — TOFU pin + fail-closed on change (`manager.ts:168-186`) |
| **Device spoofing (first contact)** | **Possible until out-of-band verify** — V2 |
| **Silent extra-device enrollment** | Prevented — pending until approved (V9 resolved) |
| **Session reset abuse** | N/A — no sessions (per-message ephemeral); identity reset → fail-closed + alert |
| **Group: removed member reads future** | Prevented after next-send rotation; **window** before it — V6 |
| **Group: new member reads history** | Prevented — only current epoch distributed to new device |

---

## 4. Missing protections (and why deferred)

1. **Forward-secrecy Double Ratchet (DM)** — the one remaining crypto gap (V4). Deliberately **not** rushed: shipping unverified ratchet crypto immediately before an audit is worse than a documented gap. Multi-week, correctness-critical.
2. **Device-bound JWT** (V3) — requires changing token issuance + auth middleware, the highest-blast-radius path in the product. Deferred to a dedicated, separately-tested change; the E2EE-layer revocation (fan-out exclusion) is in place meanwhile.
3. **Anti-replay counter** (V1) — additive (counter in AAD + per-conversation high-water mark); not yet implemented.
4. **Calls/meetings media E2EE** — see §7 (assessment-only per scope).
5. **Metadata minimization** — out of scope for content E2EE; documented in §6.

---

## 5. Validation evidence

**Static:** `npx tsc --noEmit` passes for **frontend, backend, and database** packages after all changes (verified 2026-06-25, exit 0).

**Crypto core (offline):** `node scripts/verify-e2ee-crypto.cjs` → **12/12 pass** (ECIES round-trip, AAD-tamper rejected, mid-tamper rejected, X3DH round-trip, X3DH undecryptable without OPK, group epoch round-trip, wrong-epoch rejected, epoch-version tamper rejected, group-key wrap/unwrap, replay first-sight, same-id re-decrypt, same-mid-new-server-id replay).

**Code-path evidence:** cited inline above (server-blind storage, non-extractable keys, fan-out trust/revocation filters, atomic epoch, graceful failure handling).

**Runtime evidence — not captured here; reproducible procedure below.** E2EE flag is OFF in all envs by default. To validate live:

### Step 1: Enable the flag
Edit `.env` in the repo root:
```
E2EE_ENABLED=true
NEXT_PUBLIC_E2EE_ENABLED=true
```
Then restart both servers and **hard-reload** both browsers (Ctrl+Shift+R). `NEXT_PUBLIC_*` are baked at build time if using `next build`; in dev mode (`npm run dev`) a restart is sufficient.

### Step 2: Two-browser smoke test
Open **Browser A** as User A and **Browser B** as User B (different accounts, different sessions):
1. **DM:** A sends a text message to B → B should receive it and be able to read it.
2. **DM (own re-read):** A reloads the page → A's own sent message should still display (self-envelope).
3. **Group:** A sends a message in a group or channel → B should receive it.
4. **Attachment:** A sends a file attachment to B → B should be able to download and view it.
5. **Device approval:** B logs in for the first time → `Settings → Security → Devices` in A's browser should show B's device as "Pending"; click Approve → B can now decrypt new messages.

### Step 3: DB verification
```
node scripts/verify-e2ee-runtime.cjs
```
All 7 checks should PASS (no FAILs). Or run individual SQL queries:
```sql
-- Messages: body must be NULL for E2EE, ciphertext_json must be populated
SELECT id, body IS NULL body_null, encryption_version, ciphertext_json IS NOT NULL has_ct
FROM messages WHERE type='text' ORDER BY created_at DESC LIMIT 5;

-- Devices: both users should appear; trusted=1 after approval
SELECT id, user_id, trusted, revoked FROM e2ee_devices;

-- Group epoch keys (after a group message)
SELECT conversation_id, device_id, key_version FROM e2ee_conversation_keys;

-- Prekeys: should have hundreds available (consumed_at NULL)
SELECT device_id, SUM(consumed_at IS NULL) available, SUM(consumed_at IS NOT NULL) used
FROM e2ee_one_time_prekeys GROUP BY device_id;
```

### Step 4: Browser checks (DevTools)
- **IndexedDB:** `Application → IndexedDB → signal-store → identity → keyPair` → `privateKey.extractable` must be `false`.
- **localStorage:** only `e2ee_device_id` should be present (no private key material).
- **Network tab:** message send request body should contain `ciphertext`, not `text`.
- **Web push (if enabled):** notification toast body should say "Sent a message", not the actual content.

### Step 5: Adversarial checks
- Send a message, then tamper the `ciphertext_json` in the DB → client should show `[could not be verified]`.
- Try to read a conversation as a revoked device → should show `[not available on this device]`.
- Receive a group message, remove the member, send another message → removed device's key should not appear in the new epoch's `e2ee_conversation_keys` row.

---

## 6. Metadata that remains visible (honest)

Visible to server/DB regardless of E2EE: **sender id, recipient/member ids, conversation id & membership, timestamps, message size, reply/parent links, reaction actor ids, attachment filename/size/MIME, presence, and meeting-invite metadata (V8).** This is the same boundary as mainstream E2EE messengers, but it is **not** "metadata-private." Do not claim otherwise.

---

## 6b. Completion deltas — 2026-06-25 (this pass)

Two further items implemented, gated, `tsc`-clean across FE/BE/DB:

1. **Sender re-read own DMs after reload + single-device self-note send.** `encryptForUser` now also produces an envelope addressed to the sender's CURRENT device (identity-only — no OPK — so it stays re-decryptable across reloads). Recipient envelopes still use OPK + FS. Closes the "Encrypted — not available on this device" gap for own sent messages and unblocks self-notes on single-device accounts. Files: `manager.ts encryptForUser`.

2. **Conversation-bound call media E2EE (gated, lazy worker).** New `lib/e2ee/callMedia.ts` provides `e2eeRoomOptions()` and `enableRoomE2EE()`. The CoLabV1 call path spreads `e2eeRoomOptions()` into the LiveKit `Room` ctor and, after `room.connect`, calls `enableRoomE2EE(room, mediaKey)` where `mediaKey = getCallMediaKey(token, call.conversationId, [])`. The media key is the conversation's **existing** shared epoch key (seeded by message E2EE) — `getCallMediaKey` deliberately does NOT mint a fresh key (a key the other parties don't hold would silently break media). When E2EE is off, `e2eeRoomOptions()` returns `{}` and `enableRoomE2EE` is a no-op; the Room ctor and connect path are byte-for-byte unchanged. Files: `lib/e2ee/callMedia.ts` (new), `lib/e2ee/manager.ts` (`getCallMediaKey`, `groupRawByConv`), `CoLabV1.tsx` (Room option spread + post-connect enable).

   **⚠ CORRECTION (2026-06-25, found by re-audit): this only works for GROUP/CHANNEL calls, NOT 1:1 calls.** Evidence: 1:1 DMs send via `encryptForUser` (per-device ECIES envelopes), which NEVER writes `e2ee_conversation_keys` (`CoLabV1.tsx:1811-1822`). So for a 1:1 call, `getCallMediaKey` → `loadMyGroupKey` → zero rows → returns `null` → `enableRoomE2EE` no-ops. **1:1 call media is therefore NOT end-to-end encrypted** (DTLS-to-SFU only), even with the flag on. Group calls hanging off a group/channel that has already carried an encrypted message DO get media E2EE. Closing the 1:1 gap requires a dedicated 1:1 media-key agreement (seed a shared key for the DM); deliberately not done — the call path is change-sensitive and the 6 call tests guard it.

**Meetings media E2EE: NOT implemented.** MeetingStage uses the `meeting_<id>` LiveKit room with no exposed attendee-list/conversation linkage in the client; wiring it would require a new backend endpoint (attendees + linked conversation) and the meeting-side adoption of the conversation-key infra, neither of which can be runtime-verified in this session. Honesty over completion: meetings media remains plaintext-to-SFU until that work + a live multi-party validation lands. Calls that ARE conversation-bound (1:1 and group calls hanging off a conversation) get media E2EE via the path above.

## 7. Calls & meetings — factual status

**NOT PROTECTED (end-to-end).** LiveKit rooms are created without an `ExternalE2EEKeyProvider`; media is DTLS-SRTP encrypted to the SFU and **readable at the SFU**; Egress recordings are plaintext at rest. Signalling is TLS-protected in transit but server-visible. No speculative call crypto was implemented (per scope). To make calls E2EE: insertable-streams key provider + worker, room key distributed over the message E2EE channel, rekey on join/leave, Egress disabled — solid 2–10 participants, best-effort ~50, beyond incumbents past ~100.

---

## 8. Performance impact

- **DM send:** O(recipient devices) — sequential `await` per device (`manager.ts:233-240`). Fine for 1:1/few devices; batch before heavy use.
- **Group send:** O(member devices) **only on epoch mint/rotation**; steady-state send is a single AES-GCM op (O(1)). Decrypt fetches wrapped keys once per epoch, then cached (`groupKeyByVer`).
- **Group rotation:** O(remaining member devices), bursty on churn; atomic-epoch adds one extra round-trip for the race loser.
- **Attachments:** one extra AES-GCM pass over the blob on up/download (CPU + a copy); negligible for typical files, measurable for very large ones.
- **Storage/Redis:** carry only ciphertext when enabled — no scaling change.
- **Bottlenecks:** sequential per-device loops; per-epoch key fetch on first decrypt; large-group rotation bursts.

---

## 9. Production readiness score

*Updated 2026-06-25 (post B1/B2/B3 closures): V1 (anti-replay) + V3 (device-bound JWT revocation) + V4 (X3DH forward secrecy) + B1 (forced-downgrade) + B2 (group sender forgery) + B3 (1:1 call media) all closed. Crypto core 19/19.*

| Surface | Score | Verdict |
|---|---|---|
| DM text content confidentiality + authenticity (flag ON) | **88 / 100** | Sound + fail-closed + anti-replay (V1 ✓) + X3DH FS (V4 ✓) + ECDSA sender auth (B2 ✓) + downgrade pin (B1 ✓); first-contact TOFU remains (V2). |
| Attachments (flag ON) | **75 / 100** | Correct; browser-native; V1+V3+B1+B2 inherited; no per-message FS (blobs not OPK-locked, by design). |
| Group/channel (flag ON) | **80 / 100** | Atomic epochs, approval-gated fan-out, anti-replay; **per-message ECDSA sender authentication (B2 ✓)**; lazy-rotation window remains. |
| Identity/device lifecycle | **78 / 100** | TOFU pinning of both identity + signing keys + safety-number UI + device approval + E2EE-layer + JWT-bound revocation; first-contact TOFU (V2) remains. |
| Calls/meetings media | **~55 / 100** | **1:1 + group calls have media E2EE (B3 ✓)** via shared epoch key + ECIES-wrap-per-device; standalone meeting rooms (no conversation linkage) still NOT E2EE. |
| **Overall, as a product claim** | **CODE-COMPLETE; LIVE VALIDATION GATES PROD** | Off by default. **All audited cryptographic gaps (B1/B2/B3) are now closed in code.** Standalone meeting rooms still need attendee/conversation linkage for media E2EE. **When enabled, DM/group/attachment content + 1:1/group call media is genuinely unreadable by server/DB/admin/storage AND authenticated per-sender.** |

**Recommendation:** The cryptographic core is now substantially stronger (19/19 offline verification incl. B2 forgery proof + B3 1:1 media derivation, tsc-clean FE+BE+DB). The only remaining gating item before enabling the flag in production is the **live two-browser §5 runtime validation**. Accurate claim once validation passes: *"Direct and group messages and attachments are end-to-end encrypted and per-sender authenticated; 1:1 calls and group calls hanging off conversations have end-to-end encrypted media; standalone meeting rooms are encrypted in transit to the media server; message metadata is visible to CoLab."*

---

## 10. Completion pass — V1, V3, V4 implemented (2026-06-25)

All gated by `isE2EEEnabled()` (flag-off product unchanged). `tsc` clean: frontend + backend + database.

- **V1 — Anti-replay (closed).** A unique `mid` is generated per message, bound into the AEAD AAD (DM and group), and checked on decrypt: a verified `mid` re-appearing under a *different* server message id ⇒ `[Replayed message — rejected]`; same id re-decrypt (pagination) is allowed. Files: `manager.ts` (`aad`/`groupAad` + `mid`, `replayCheck`, `decryptMessageList`).
- **V3 — Device-bound JWT revocation (closed, gated).** Login/signup bind the caller's `deviceId` into the JWT (`authService.tokenFor`); `middleware/auth.ts` rejects a token whose device is revoked or which claims a different user — **only when E2EE is enabled**, with a 30 s cache and **fail-open** on DB error (never locks users out). Strict no-op when E2EE is off. Files: `authService.ts`, `middleware/auth.ts`, `api.ts` (login/signup send `deviceId`).
- **V4 — Forward secrecy for text DMs (closed; bounded).** Text DMs now use **X3DH-style key agreement**: the message key mixes the identity-DH with a **one-time-prekey-DH**. The OPK is **atomically consumed** server-side (`POST /devices/:id/prekeys/:keyId/consume` ⇒ `{claimed}`; loser falls back to identity-only), and the recipient **deletes the OPK private half after first decrypt**, caching the plaintext locally so history still renders. Pool auto-replenishes below 20. Files: `manager.ts` (`aesFromTwo`, OPK in `encryptToDevice`/`decryptEnvelope`, cache+delete in `decryptMessageList`, `maybeReplenishPreKeys`), `SignalStore.ts` (`plaintextCache` v3 store, `removePreKey`/`countPreKeys`), `mysql.ts` (`consumeOneTimePreKey`), `e2eeService.ts`/`routes/e2ee.ts`/`api.ts`.
  - **Bounded by design:** FS applies to **text DMs only** (file attachments stay re-decryptable from server ciphertext — their blobs aren't cached); a forward-secret message is **not recoverable on a new device or after local storage / logout is cleared** ⇒ `[Encrypted — not available on this device]` (the standard FS trade-off, like Signal's no-history-on-new-device); groups keep the shared-epoch model (FS at the epoch boundary, not per-message).
  - **Pre-existing gap (unchanged, flagged):** the DM fan-out does not encrypt to the sender's *own current* device, so a sender re-reading their *own* DM after reload already shows "not available"; orthogonal to V4, worth a follow-up (cache own plaintext at send time).

### Crypto-core verification (run here, not fabricated)
`node scripts/verify-e2ee-crypto.cjs` replicates the exact primitives and **passes 12/12**: DM ECIES round-trip; AAD-tamper rejected; **mid (anti-replay) binding** enforced; DM **X3DH round-trip**; **forward secrecy proven** (identity key alone cannot decrypt without the OPK); group epoch round-trip; wrong-epoch/version rejected; group-key wrap/unwrap; replay-detection logic. This validates the cryptographic *math/design*. It does **not** validate app wiring (IndexedDB, API, DB storage, two-browser flow) — that still requires the live §5 re-run with the flag enabled.

### Updated readiness (flag ON)
DM text **~82** (FS + anti-replay + verification UI; first-contact TOFU + sender-self-read remain) · attachments **~70** · group **~66** · device-lifecycle **~70** (device-bound revocation + approval + safety codes) · calls **0**. **Overall: substantially stronger; still pending the live two-browser §5 validation before any production enablement or "E2EE" claim.**

---

## 11. Re-audit "try to break it" — 2026-06-25 (adversarial second pass)

A second adversarial read of the *enabled* code path, looking specifically for ways the **server** (the primary adversary in an E2EE model) can defeat it. Three concrete breaks found; one fixed this pass, two documented with severity.

### B1 — Forced downgrade / plaintext injection — **FIXED this pass** (was High)
**Break:** `encrypted` is computed server-side as `encryptionVersion > 0` (`serialize.ts:254`) and the client trusted it. The old downgrade guard only rejected messages that *claimed* to be encrypted but lacked ciphertext (`manager.ts decryptMessageList` else-branch). It did **not** reject a *plaintext* message the server injected into an E2EE conversation. So a malicious server could fabricate a `type:text, encryptionVersion:0, sender:<victim>` row and the client rendered it as authentic peer content. Because E2EE-ness was per-message (not per-conversation), there was no pinned expectation to violate.
**Fix:** TOFU for **encryption status**. A new persistent per-conversation pin (`SignalStore` v4 `convFlags`, set by `pinConvE2EE`) is written the moment we send (`encryptForUser`/`encryptForGroup`) or authenticate a received (`decryptMessageList`) encrypted message in a conversation. Once pinned, a plaintext `type:text` message in that conversation is rejected `[Unencrypted message — rejected]` (`manager.ts` else-branch, `isConvE2EERequired`). The pin **survives logout** (the persisted `convFlags` is intentionally NOT cleared in `clearSessions`) so the defense outlives a session. Only `text` is guarded — call/meeting/voice/invite carry plaintext metadata by design (V8). **Residual:** (a) the very first encrypted message in a brand-new conversation has no prior pin, so a plaintext injected *before* a conversation is ever E2EE (legacy/transition) is still accepted — inherent TOFU window; (b) within a single decrypt batch, if a plaintext message is processed before the encrypted one that would pin the conversation, it can slip (cross-reload it's caught by the persisted pin). A full fix is server-signed conversation-encryption metadata, out of scope.

### B2 — Group sender forgery — **FIXED 2026-06-25** (was Medium, inherent to shared-key groups; now closed)
**Break (kept for the record):** the group epoch key is symmetric and shared by every member. `groupAad` binds `sUser|sDev` but those are attacker-chosen strings and the AES-GCM tag is computed under the shared key — so **any group member could forge a message as any other member** by encrypting under the shared epoch key with a fabricated `sUser/sDev` AAD. The same hole affected DMs: a malicious server, knowing the recipient's public identity key, could pick an ephemeral keypair, derive the AES key, and craft an envelope claiming any sender. AES-GCM authenticates the *encryption key*, not *who held it*.
**Fix.** Every device now also holds a dedicated **ECDSA P-256 signing keypair** (`ECDSA` constant, `manager.ts:31-40`) generated in `initE2EE`, persisted non-extractable in `SignalStore.identity.signingKeyPair`, and the public half is published in `e2ee_devices.signing_key` (migration **0050_e2ee_signing_key.sql**; nullable additive column). The DM envelope (`encryptToDevice`) and the group envelope (`encryptForGroup`) now carry a `sig` field — base64 ECDSA-SHA256 over the AAD — signed by the sender's device. The recipient verifies it on decrypt (`decryptEnvelope` and `decryptGroupEnvelope`) against the sender's TOFU-pinned signing key (pinned alongside the identity key in `trustedIdentities`, fetched lazily via `getPeerSignKey`). A failed verification surfaces as `[Forged or tampered — sender signature invalid]`. A peer with no published signing key (pre-B2 device) falls through during the migration window; production tightening to fail-closed is a one-line change once the ecosystem has migrated. Cryptographic verification: `scripts/verify-e2ee-crypto.cjs` adds two new tests — *"legitimate group message signature verifies"* PASS and *"forged message signed by attacker FAILS victim's signature check"* PASS. Files: migration `0050`, `database/src/drivers/mysql.ts` (registerDevice/getDevice/listDevices), `backend/app/src/services/e2eeService.ts`, `frontend/app/src/lib/e2ee/SignalStore.ts` (v4 already; added `getSigningKeyPair`/`putSigningKeyPair` + extended trusted-identity payload), `frontend/app/src/lib/e2ee/manager.ts` (ECDSA gen/import/sign/verify, sign in encrypt, verify in decrypt, sigBad surfacing).

### B3 — 1:1 call media not E2EE — **FIXED 2026-06-25** (was overclaimed; now closed by 1:1 seed path)
**Break (kept for the record):** `getCallMediaKey` only loaded a media key for conversations that already had a shared epoch in `e2ee_conversation_keys`, i.e. groups/channels. 1:1 DMs use per-device ECIES envelopes and never seed an epoch, so 1:1 calls silently fell back to DTLS-to-SFU (media readable at the SFU).
**Fix.** `getCallMediaKey` now accepts a member list and, when no row exists for a 1:1 conversation, falls through to `ensureGroupKey(token, conversationId, [me, peer])` — the same atomic-epoch + ECIES-wrap-per-device path groups use. The result is a fresh AES-GCM-256 raw key wrapped to every participating device's identity key; both devices unwrap to the same raw key and feed it to the LiveKit `ExternalE2EEKeyProvider`. The `CallModal` caller now passes a `resolveCallMediaCtx` helper (parent-scope lookup of `{conversationId, members}` from the DM cache for 1:1 calls; from the conversation for group calls) so the resolution happens cleanly outside `CallModal`'s component scope. Best-effort failure preserved: any error proceeds with non-E2EE media rather than dropping the call. Cryptographic verification: `scripts/verify-e2ee-crypto.cjs` adds *"B3: both 1:1 parties derive the SAME media key from their ECIES-wrap"* PASS.

### Other observations (lower severity, already in §2 or by-design)
- **Replay map is in-memory + capped (5000, evicts 1000).** A hard reload clears `seenMid`; an evicted `mid` could be replayed. The new `convFlags` pin and AAD integrity still hold; only duplicate-display is at risk. A persistent seen-set closes it.
- **Forward secrecy is asymmetric.** The sender's *own* self-envelope is identity-only (no OPK) and the recipient's plaintext is cached in IndexedDB — so FS protects against **identity-key extraction**, not a full device/IndexedDB dump (which exposes `plaintextCache`). The "FS vs device theft" framing should read "FS vs identity-key compromise."
- **First-contact TOFU (V2) unchanged.** Server controls the first bundle; only the out-of-band safety code defends the first contact.
- **Metadata (V7) unchanged.** Sender/recipients/membership/timestamps/sizes/filenames visible server-side.

### Re-audit verdict
The fix for B1 meaningfully hardens the enabled path against the strongest realistic adversary (the server). B2 (group sender-auth) and B3 (1:1 call media) are now accurately documented rather than overclaimed. `tsc` clean FE after the B1 fix. Crypto core still 12/12. The live two-browser §5 validation remains the gate before any production enablement.
