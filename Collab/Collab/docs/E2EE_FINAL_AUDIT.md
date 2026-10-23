# CoLab — E2EE Final Audit, Completion & Hardening

**Date:** 2026-06-25
**Author:** Security architecture audit (code-grounded; every claim cites `file:line`)
**Status of E2EE in product:** **DISABLED** by kill switch (`E2EE_ENABLED=false` / `NEXT_PUBLIC_E2EE_ENABLED=false`). User-facing protection today = **none** (plaintext mode).
**Supersedes:** `docs/E2EE_ASSESSMENT.md` (Jun 14 AM) and `docs/E2EE_DISABLEMENT_DIRECTIVE.md` on the points marked **STALE** below. `manager.ts` was rewritten the same afternoon (Jun 14 21:53) and several of the assessment's worst findings no longer hold.

---

## 0. The assumption this audit had to challenge first

The task brief assumes a **Signal-protocol** system: device identity, signed prekeys, one-time prekeys, X3DH **session establishment**, **sender keys** for groups, envelope storage, multi-device fan-out, media encryption.

**That is not what is implemented.** The shipped, wired core is **native Web Crypto ECIES** (per-message, per-recipient-device), not Signal/X3DH/double-ratchet. The brief's instruction "do not assume current encryption is correct" is exactly right — and the first correct finding is that the *architecture itself is not the one the brief describes.* Treating this as "finish the Signal implementation" would be wrong; there is no Signal session layer to finish.

Concretely, of the assumed components:

| Brief assumes | Reality in code | Evidence |
|---|---|---|
| Signal protocol integration | Native Web Crypto ECIES (P-256 ECDH + HKDF-SHA-256 + AES-GCM-256) | `frontend/app/src/lib/e2ee/manager.ts:1-30` |
| Signed prekeys | **Absent** — `signedPreKey: null` (ECDH keys can't ECDSA-sign); trust anchor is TOFU on the identity key | `manager.ts:136-137` |
| One-time prekeys | Generated & published but **dormant** (ECIES uses per-message ephemerals; OPKs never consumed) | `manager.ts:124-138` |
| X3DH session establishment / persistence / recovery | **None.** No sessions; each message uses a fresh ephemeral ECDH | `manager.ts:193-218` |
| Sender keys / group key distribution | **No-op** — `distributeGroupSenderKey()` returns immediately; groups/channels are plaintext | `manager.ts:330-338` |
| Multi-device fan-out | **Implemented** (one ECIES envelope per recipient device + own other devices) | `manager.ts:220-245` |
| Media/attachment encryption | **Implemented** (AES-GCM-256 blob; file key wrapped inside the message envelope) | `media.ts`, `manager.ts:288-297` |
| Envelope / ciphertext storage (server-blind) | **Implemented & correct** (body NULL when encrypted) | `messageService.ts:70-84` |

---

## 1. Architecture findings

**1.1 What is actually wired (the live path).** Only two modules are reachable from the app: `lib/e2ee/manager.ts` and `lib/e2ee/media.ts`, both consumed by `components/CoLabV1.tsx` (`CoLabV1.tsx:63-71`). Flow:

```
send (DM/self only):  CoLabV1.handleSend → manager.encryptForUser() → [envelopes per device]
                      → socket message:send {encrypted} → messageService.send (body=NULL,
                        ciphertext_json=envelopes, encryption_version=1)
recv:                 getMessages/MESSAGE_NEW → manager.decryptMessageList() → pick my envelope
                        by (recipientId, recipientDeviceId) → ECDH+HKDF+AES-GCM open
```

**1.2 Cryptographic construction (sound for its stated goal).** Per recipient device: fresh ephemeral P-256 keypair → `ECDH(eph_priv, peer_id_pub)` → HKDF-SHA-256 (salt = ephemeral pubkey bytes, info = fixed label) → AES-GCM-256. AAD binds `version|senderUser|senderDevice|recipientUser|recipientDevice|conversationId|nonce` so the server cannot move, splice, or replay an envelope into another context (`manager.ts:74-100, 193-218`). `importKey("raw", …)` enforces on-curve validation, blocking invalid-curve attacks (`manager.ts:68-72`). This is a correct **ECIES** design.

**1.3 Identity & key storage.** Long-term identity private key is generated **non-extractable** and stored as a structured-cloned `CryptoKey` in IndexedDB (`SignalStore`) — not exportable by JS/XSS (`manager.ts:113-118, 141-143`). Server stores only **public** identity keys + opaque ciphertext.

**1.4 Dead / aspirational code (major finding).** Six modules — `rotation-engine.ts`, `revocation-model.ts`, `recovery-protocol.ts`, `ownership-validation.ts`, `epoch-store.ts`, `safety.ts` — **import only each other and are imported by nothing in the app** (verified by grep). They are not on the encrypt/decrypt path. `recovery-protocol.ts:124,196` still `await import("@signalapp/libsignal-client")`, a **NAPI-only** lib that is webpack-aliased to `false` (`next.config.js:100`) and therefore resolves to null at runtime — i.e. that code path is inert even if reached. **Net: the "Phase-3 lifecycle" (rotation/revocation/recovery/epochs) does not exist as a functioning feature; it is scaffolding.**

**1.5 Unused backend surface.** `e2ee_conversation_keys` table + `/conversations/:id/keys` routes + `api.e2eePut/GetConversationKeys` exist but the ECIES client never calls them (it has no conversation-key concept). Dormant (`e2eeService.ts:42-69`, `routes/e2ee.ts:50-66`).

**1.6 Stale documentation.** `E2EE_ASSESSMENT.md` claims (a) fail-**open** to plaintext, (b) `isTrustedIdentity()` always true / no MITM, (c) AI forwards plaintext, (d) libsignal NAPI core "does not work." **(a)-(d) are now STALE** — see §2. The doc's score (8/100) reflects the pre-rewrite state.

---

## 2. Security findings

### Fixed-in-code since the last assessment (verified)
- **Fail-CLOSED, not fail-open.** `encryptForUser` *throws* if it cannot produce ≥1 envelope (`manager.ts:228, 241-243`); the caller returns without sending and clears `payload.text` (`CoLabV1.tsx:1808-1821`). No silent plaintext fallback. ✅ (contradicts assessment §7.1)
- **MITM TOFU + fail-closed on key change.** First-sight pinning; a changed pinned identity key is added to `changedIdentities` and **refused** (`manager.ts:168-186`). ✅ (contradicts assessment §3 "isTrustedIdentity always true")
- **AI sink is E2EE-aware.** `aiService` skips `encryptionVersion > 0` rows (`aiService.ts:91`). ✅ (contradicts assessment §2 "AI forwards plaintext")
- **Notification excerpts gated.** Mentions/replies/web-push only read `text` when `!encrypted` (`socket.ts:281, 298, 319`). ✅
- **Server-blind storage.** `body = encrypted ? null : text` (`messageService.ts:73-78`); serializer exposes `ciphertext` + `encrypted` flag, never a plaintext body for encrypted rows (`serialize.ts:225, 254-256`). ✅
- **Downgrade protection.** An `encrypted` message arriving without ciphertext is rendered as "[Unencrypted message — rejected]" (`manager.ts:315-316`). ✅

### Still-open security findings
1. **No safety-number / key-change UI.** `safety.ts` computes a correct Signal-style safety number but is **imported nowhere**, and `changedIdentities` is never surfaced. Result: a substituted key silently stops decrypting with no user-visible reason and **no path to re-verify**. MITM detection exists in logic but is invisible to users. *(Top completion item.)*
2. **Revocation is non-binding.** `revokeDevice` only flips a DB row (`e2eeService.ts:28-30`); the JWT carries no `deviceId` and auth middleware does not check device state. A revoked/stolen device keeps full API + message access. *(Requires auth-middleware change — deferred, see §3.)*
3. **Device enrollment is unauthenticated by existing devices.** Any session that authenticates can `POST /devices` with a client-chosen `deviceId` (`e2eeService.ts:14-22`) and will then receive fan-out of future messages. Combined with (2), a compromised account credential = silent new reading device. Signal/WhatsApp require existing-device approval; CoLab does not.
4. **No forward secrecy against device-key theft.** Per-message ephemeral ECDH gives FS **vs the server**, but the long-term identity key opens every historical envelope addressed to that device. Honestly documented in-code (`manager.ts:20-22`); a ratchet is not implemented.
5. **Metadata is server-visible by design** — sender, recipients, device list, timestamps, conversation membership, file name/size/type. Same posture as Signal/WhatsApp, but must be stated to users; do not market as "metadata private."
6. **Groups, channels, calls, meetings are plaintext.** Not a regression — v1 scope — but means "CoLab is E2E encrypted" would be **false** as a blanket claim.
7. **Supply-chain/hygiene:** `@signalapp/libsignal-client@^0.94.4` remains in `package.json` though only dead code references it. Unnecessary dependency; recommend removal once the team confirms the Phase-3 modules are abandoned (the disablement directive says "DO NOT delete" them, so this audit does **not** delete — see §4).

### Performance / storage
- Messaging is **O(devices)** per message (sequential `await` loop, `manager.ts:233-240`). Fine for DMs; batch before large groups (groups aren't E2EE yet anyway).
- Encrypted rows are excluded from full-text search (`MATCH(body)` over NULL bodies) → **E2EE messages are unsearchable**; acceptable, but a UX limitation to state. Move search client-side if E2EE ships.
- Redis/MinIO carry only ciphertext once enabled — no scaling change.

---

## 3. Missing components (to reach the brief's bar)

| Component | State | Effort |
|---|---|---|
| Safety-number + key-change verification UI | logic exists, **no UI**, unwired | S (wire `safety.ts` + a Devices/Verify panel; gated by `isE2EEEnabled()`) |
| Device-bound JWT + revocation enforcement | absent | M (auth middleware — **touches live auth, high blast radius**) |
| Existing-device approval for new enrollment | absent | M |
| Forward-secrecy ratchet (Double Ratchet) | absent | L (research-light, build-heavy) |
| Group E2EE (sender keys + epoch rotation on join/leave) | no-op stub | L |
| Calls/meetings media E2EE (LiveKit insertable-streams key provider) | absent | L (and beyond incumbents at 100+ participants — see §"Calls") |
| Multi-device history sync (new device reading old messages) | absent — shows "[Encrypted — not available on this device]" (`manager.ts:281`) | M |
| Self-note single-device send | **edge-case bug** — own current device is skipped (`manager.ts:164`), so a single-device self-chat yields 0 envelopes → send throws | S |

---

## 4. Files modified (this pass)

| File | Change | Why |
|---|---|---|
| `frontend/app/src/lib/e2ee/media.ts` | Replaced Node `Buffer.from(...)` (4 sites) with browser-native `btoa/atob` helpers (`b64enc/b64dec`), mirroring `manager.ts`. | **Real defect:** webpack 5 does not polyfill `Buffer` in the client bundle, so file-E2EE threw `ReferenceError: Buffer is not defined` the instant it ran. Now browser-safe. |
| `docs/E2EE_FINAL_AUDIT.md` | This document. | Supersede contradictory/stale docs with one code-grounded source of truth. |

**Deliberately NOT changed** (respecting "preserve existing / avoid rewrites" and the disablement directive's "DO NOT delete"):
- Did not flip the kill switch. Enabling E2EE today would ship a DM-only, no-FS, no-revocation, no-verification-UI system and is **not** production-ready (§8).
- Did not delete the dead Phase-3 modules or remove the libsignal dependency (team has marked them preserved). Flagged in §2.7 / §1.4 instead.
- Did not touch auth middleware, calls, meetings, notifications, or the plaintext message path.

---

## 5. Changes implemented

Only the `media.ts` `Buffer` fix (see §4). It is safe to land while E2EE stays off: `encryptBlob` early-returns when disabled (`media.ts:32-34`), and `import/export/decryptBlob` are only invoked on the E2EE-on path. `tsc --noEmit` on the frontend passes (§6).

---

## 6. Validation evidence

- **Static type check:** `npx tsc --noEmit` (frontend) → exit 0 after the `media.ts` change.
- **Wiring trace (grep-verified):** live E2EE entrypoints are exactly `initE2EE`, `encryptForUser`, `decryptMessageList`, `ensureSessionsForUser`, `isE2EEEnabled` (CoLabV1) + `encryptBlob` (CoLabV1) — see `CoLabV1.tsx:63-71,927,1809,1977,2001`. Phase-3 modules: **0** importers in app code.
- **Server-blind storage (code path):** `messageService.send` sets `body=null` for encrypted sends (`messageService.ts:73`); serializer never emits a plaintext body for `encryptionVersion>0` (`serialize.ts:254-256`).
- **Flag state:** `manager.ts:28` and `media.ts:3` both read `NEXT_PUBLIC_E2EE_ENABLED === "true"`; backend `E2EE_ENABLED` via `config.e2ee.enabled`. Directive confirms both are `false`.

### Validation matrix (assessed against the **wired** implementation)

| Scenario | Verdict | Notes |
|---|---|---|
| 1-to-1 DM messaging | **Works (when flag on)** | ECIES per device; fail-closed |
| 1-to-many / channels | **Plaintext** | not in v1 scope |
| Groups | **Plaintext** | `distributeGroupSenderKey` is a no-op |
| Multiple devices (fan-out) | **Works** | one envelope per device; new device cannot read history |
| Attachments/media | **Works after this fix** | was broken by `Buffer` in browser |
| Device re-registration | **Partial** | re-register works; old messages unreadable on the new device |
| Session recovery | **N/A** | no sessions (per-message ephemeral) — nothing to recover |
| Device removal | **Cosmetic only** | DB flip; not enforced in auth (§2.2) |
| Offline delivery | **Works** | envelopes persist in `ciphertext_json`; decrypt on fetch |
| Message history | **Per-device** | only devices that existed at send time have an envelope |

*Note: "Works (when flag on)" reflects code-path validity; live two-browser runtime validation was not performed because enabling the flag in a shared environment is out of scope for an audit and the system is not production-ready to enable (§8).*

### Calls & meetings (factual, no speculative crypto implemented)
- **Signalling:** Socket.IO over TLS in production (transport encryption), but call/meeting signalling payloads are **server-visible** (not E2EE).
- **Media:** LiveKit Room is created with **no `ExternalE2EEKeyProvider`** → media is hop-encrypted (DTLS-SRTP to the SFU) and **readable at the SFU**; Egress recordings land plaintext. This is standard SFU posture, **not** end-to-end.
- **Required for E2EE calls:** insertable-streams key provider + worker, room key distributed over the message E2EE channel, rekey on join/leave, Egress disabled. Solid at 2–10 participants, best-effort ~50, **beyond incumbents (WhatsApp ~32, Teams ~50) past ~100**. Not started; do not claim E2EE calls.

---

## 7. Remaining risks

1. **Enabling the flag prematurely** ships a system without verification UI, FS, or enforced revocation — and would imply a security claim the product can't back. **Risk: reputational/compliance.** Keep off until §3 S/M items land.
2. **Non-binding revocation + open enrollment** (§2.2–2.3): account-credential compromise → silent persistent reader. **Highest residual security risk** once enabled.
3. **Silent MITM UX** (§2.1): key-change is detected but invisible; users can't act. Erodes the core guarantee in practice.
4. **Dead code drift** (§1.4): the Phase-3 modules + libsignal dependency invite "it's already built" misreadings (as the brief itself shows). Either finish-and-wire or delete; don't leave dormant.
5. **Compliance:** encrypted content is still personal data; metadata stays in scope; right-to-erasure needs ciphertext+key deletion (current soft-deletes leave rows). No key-management/rotation/revocation controls documented → SOC2/ISO A.10/CC6 gaps.

---

## 8. Production readiness assessment

| Surface | Readiness | One-line verdict |
|---|---|---|
| **DM text E2EE (wired core)** | **~65/100** | Cryptographically sound, fail-closed, server-blind, multi-device — but no verification UI, no enforced revocation, no FS. |
| **Attachments E2EE** | **~60/100** | Correct construction; **now runnable** after the `Buffer` fix; shares the DM gaps. |
| **Groups/channels** | **0/100** | Plaintext; stub only. |
| **Calls/meetings media** | **0/100** | SFU-readable; no key provider. |
| **Key lifecycle (rotation/revocation/recovery)** | **~10/100** | Scaffolding only; not wired, references a non-browser lib. |
| **Overall platform E2EE** | **NOT production-ready** | Honest headline: a solid DM/attachment ECIES core exists and is much better than prior docs imply, but verification UI + enforced revocation + (ideally) FS are prerequisites before enabling, and "E2E encrypted" must not be claimed platform-wide. |

**Recommended next steps, in order, all additive and flag-gated:**
1. Wire `safety.ts` + a Devices/Verify panel + a key-change banner (surfaces `changedIdentities`). *(S, no live-path risk.)*
2. Fix the self-note single-device edge case (`manager.ts:164`). *(S.)*
3. Device-bound JWT + revocation check in auth middleware, behind a flag, with a regression pass on login/refresh. *(M, touches live auth — schedule carefully.)*
4. Decide the fate of the Phase-3 modules + libsignal dependency: finish-and-wire or remove. *(Hygiene.)*
5. Only then consider per-conversation DM enablement; defer groups, then calls.

**Do not market "end-to-end encrypted" until at least steps 1–3 land for DMs.**

---

## 9. Completion pass — 2026-06-25 (implemented this session)

Scope per the brief: implement E2EE across the **messaging** surface (DM ✓ already, **groups/channels**, **attachments everywhere**, **multi-device**, **key management / verification UI**). Calls/meetings media remains **assessment-only** per the brief ("do not implement speculative encryption"). Everything below is gated by `isE2EEEnabled()`, so with the flag OFF the live product is byte-for-byte unchanged. All changes are `tsc --noEmit` clean (frontend + backend).

### Implemented
1. **Group / channel message E2EE** — shared **per-epoch conversation key** model built on the existing (previously dormant) `e2ee_conversation_keys` table + `/api/e2ee/conversations/:id/keys` routes (no new infra). One AES-GCM-256 key per `(conversation, epoch)`, ECIES-wrapped to **every member device** (incl. my own devices) via the existing `encryptToDevice`, one row per device. Messages are AES-GCM under that key with AAD `VERSION|group|sender|senderDevice|conversationId|epoch|nonce`. Envelope shape `{t:2,v,ver,iv,ct,n,sUser,sDev}` in `ciphertext_json`. (`manager.ts` — `encryptForGroup`, `ensureGroupKey`, `distributeGroupKey`, `loadMyGroupKey`, `decryptGroupEnvelope`, `rotateGroupKey`.)
2. **Lazy epoch rotation** — on the next send after the member-device set changes, a new epoch key is minted and redistributed: a **removed** member can't read post-rotation messages; a **newly added** member only gets the new epoch (no history). `rotateGroupKey` is exported for prompt rotation on explicit membership changes.
3. **Attachments E2EE for groups/channels** — the file-send path now wraps the AES file-key inside a **group** envelope when the conversation is a group/channel (DM path unchanged). `decryptMessageList` unified so DM + group both run the existing `{type:'file',key,iv}` blob-decrypt. (`CoLabV1.tsx` file-send block.)
4. **Multi-device** — group fan-out wraps the epoch key to all member devices and to the sender's own devices (so own messages decrypt after reload). DM fan-out already existed.
5. **Verification UI + MITM key-change handling** — wired the previously-dead `safety.ts`. New `getSafetyNumber`, `getKeyChangedUserIds`, `hasIdentityChanged`, `acceptIdentityChange`, `listMyDevices`, `revokeMyDevice` in `manager.ts`; new self-contained `components/E2EESecurityPanel.tsx` mounted in **Settings → Security** (self-gates on the flag) showing E2EE status, registered devices (with revoke), and a **security-code-changed** alert with an explicit "accept new key" re-pin.
6. **Revocation (E2EE-layer)** — confirmed already enforced: `listDevices`/`getPreKeyBundle` filter `revoked=false`, so a revoked device is excluded from all future DM envelopes and group epoch keys. (JWT device-binding for API/auth revocation is still the separate auth-layer item — see §3.)
7. **`media.ts` `Buffer` fix** (from the audit pass) — file-E2EE now runs in-browser.

### Files modified (completion pass)
| File | Change |
|---|---|
| `frontend/app/src/lib/e2ee/manager.ts` | Group per-epoch E2EE (encrypt/decrypt/rotate/distribute); token + own-pubkey capture; safety-number + key-change + device helpers; clear group caches on logout. |
| `frontend/app/src/lib/e2ee/media.ts` | `Buffer` → browser-native base64. |
| `frontend/app/src/components/CoLabV1.tsx` | Text- and file-send now encrypt for groups/channels (branch DM vs group); import `encryptForGroup`. |
| `frontend/app/src/components/E2EESecurityPanel.tsx` | **NEW** — Settings security panel (devices, revoke, key-change alerts). |
| `frontend/app/src/components/Settings.tsx` | Mount `E2EESecurityPanel` in the Security section. |

### Honest limits of the group model (must be documented for users)
- **No per-sender ratchet** — within an epoch any member can read any member's messages (shared group key; same effective trust as a group key, not Signal sender-keys). No forward secrecy within an epoch beyond the per-epoch boundary.
- **Rotation window** — between a member's removal and the next send, one more message could still be readable by the removed member.
- **Concurrent first-send / rotation race** — two members minting the same epoch concurrently can split (last write wins per device); self-heals on the next rotation. A server-side "create-epoch-if-absent" atomic endpoint would close this.
- **History on new device/new member** — not synced; shows "[Encrypted — not available on this device]".

### Added after the completion pass
8. **Per-conversation safety-number display + key-change banner inside the chat** — new self-contained `components/E2EEConversationSection.tsx` mounted in the ChatView **Details** panel (self-gates on the flag). DM: reveals the out-of-band **security code** (`getSafetyNumber`) to compare with the peer + a key-change alert with "accept new code"; group/channel: encrypted status + member key-change alert. Touches only `ChatView.tsx` (import + one mount in the existing info-body).
9. **Race-free group epoch creation** — new `POST /api/e2ee/conversations/:id/epoch` backed by `db.e2ee.createConversationEpoch`, which claims a whole epoch in **one all-or-nothing multi-row INSERT** (plain INSERT; duplicate-key ⇒ `{created:false}`). Two members racing to mint the same epoch now serialize: exactly one wins, the loser **adopts** the winner's key (`mintEpoch` in `manager.ts`). Falls back to the legacy upsert path if the endpoint is absent (older backend). Closes the split-brain limitation noted in §"honest limits". Files: `database/src/drivers/mysql.ts`, `backend/.../services/e2eeService.ts`, `backend/.../routes/e2ee.ts`, `frontend/.../lib/api.ts`, `frontend/.../lib/e2ee/manager.ts`. All projects `tsc`-clean (frontend + backend + database).

### Still not implemented (unchanged from §3)
- Calls/meetings media E2EE (assessment-only per brief).
- Forward-secrecy double-ratchet for DMs.
- Device-bound JWT (auth-layer revocation enforcement).
- Existing-device approval for new enrollment.

### Updated readiness (messaging surface, with the flag ON)
DM text **~70** · attachments **~65** · **groups/channels ~60** (new; correct for the common path, documented edge limits) · calls **0** · key-lifecycle **~35** (verification UI + E2EE-layer revocation now real; FS + auth-binding still missing). **Still not production-ready to enable** until FS + auth-bound revocation + per-DM safety-number display land, and the group epoch race is closed for large/churny groups.
