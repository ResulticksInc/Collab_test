# CoLab — End-to-End Encryption (E2EE) Assessment & Roadmap

*Grounded audit of the actual codebase (frontend, backend, Socket.IO, LiveKit, MySQL, Redis, MinIO) + adversarial verification. Not theoretical.*

---

## 1. Current E2EE Readiness Score — **8 / 100**

E2EE is globally **OFF** in every env file (`E2EE_ENABLED` / `NEXT_PUBLIC_E2EE_ENABLED = false`). The only live path is **plaintext storage**, so user-facing protection today is effectively **zero**. The 8 points are for non-zero scaffolding that shortens future work:

- Correct **server posture** — `e2eeService` stores only key/device *metadata*, never plaintext.
- **DB schema present** — `e2ee_devices`, `e2ee_one_time_prekeys`, `e2ee_conversation_keys`, plus `messages.ciphertext_json` and `files.ciphertext_meta` columns.
- Dormant-but-correct `/api/e2ee/*` routes.
- Message send path already accepts an `encrypted` / `ciphertext` field.
- A working **AES-GCM-256 blob primitive** (`lib/e2ee/media.ts`).

## Production Readiness (full platform: DM+group+attachments+calls) — **12 / 100**

The path is **engineering-bounded, not research-bounded** (data model, routes, server posture, and one AES-GCM primitive are production-shaped). But there is no functional browser crypto core, identity trust is MITM-open, and several server-side plaintext sinks would defeat E2EE even if messages were encrypted.

---

## 2. What's Readable Today (plaintext exposure)

| Layer | Exposure |
|---|---|
| **Messages** | `messages.body` stored as raw rich-text HTML, no column/field encryption. Readable by backend, MySQL, dumps. |
| **Search** | `MATCH(m.body) AGAINST(...)` full-text index runs over **plaintext** bodies server-side. |
| **AI summaries** | `aiService` forwards `m.body` to an **external LLM** in cleartext. |
| **Notifications** | `notifications.body` stores plaintext message excerpts. |
| **Attachments** | Files/voice notes/voicemails uploaded as **raw plaintext** to MinIO/S3. |
| **Calls/Meetings** | LiveKit Room created with **no key provider** → media is SFU/DTLS-hop encrypted only, readable at the SFU. Egress recordings are plaintext on S3. |

---

## 3. The Critical Finding

A **complete-but-dormant Signal-Protocol E2EE module exists** (`lib/e2ee/manager.ts`, `SignalStore.ts`, recovery/epoch/rotation engines) — **but it does not work and cannot be simply switched on**:

- It's built on `@signalapp/libsignal-client`, which uses **native NAPI bindings that cannot run in a browser**. It's already webpack-aliased to `false` in `next.config.js`.
- **Most dangerous behavior:** if you flipped `E2EE_ENABLED=true` today, `encryptForUser()` returns `null` on crypto-load failure and the caller **silently sends plaintext** (fail-open). That's worse than off.
- `isTrustedIdentity()` returns `true` unconditionally — **no MITM protection** even if the core worked.
- Recovery/epoch/revocation state lives only in IndexedDB/localStorage (lost on cache-clear, not synced).
- Post-quantum (kyber) prekey store is stubbed `{}` — any PQ claim is unfounded.

The team's own `E2EE_PROTOCOL_SPEC.md v3` already pivoted to a "Native WebCrypto Edition" to replace libsignal — **but that WebCrypto core was never written.**

---

## 4. Required Architecture Changes

- **Frontend crypto core:** Rewrite `manager.ts` on **Web Crypto (AES-GCM-256, HKDF-SHA-256, ECDH) + `@noble/curves` (X25519/Ed25519)** — keep the `SignalStore` IndexedDB layout and the public API (`initE2EE`/`encryptForUser`/`decryptMessageList`/`encryptBlob`) so call sites don't churn. Remove `@signalapp/libsignal-client` + its alias. Add real TOFU identity (safety numbers + key-change alerts) and a Devices panel backed by a server registry.
- **Backend:** server-enforced OPK consumption; a **device session registry** so `revokeDevice` actually blocks auth (bind `deviceId` into the JWT + check in auth middleware); conversation-key epoch versioning; membership-change hooks that bump the epoch.
- **Socket:** broadcast **only ciphertext envelopes** (stop serializing plaintext `body`).
- **Search/AI/Notifications:** disable server-side full-text search, AI summaries, and notification-body copies **for E2EE conversations** (move search client-side).
- **LiveKit:** add `ExternalE2EEKeyProvider` + worker to the Room; distribute the room media key over the existing E2EE message channel; rotate on join/leave.
- **Storage:** wire `encryptBlob` before **every** upload path; enable MinIO SSE as defense-in-depth for non-E2EE content.

---

## 5. Recommended Primitive

**Web Crypto + `@noble/curves`** (light, hardware-accelerated, browser-native). **Do NOT use `@signalapp/libsignal-client`** (NAPI-only). `libsodium.js` is a viable alternative but adds a ~200KB WASM blob duplicating Web Crypto.

- **DM:** device IK (X25519) → X3DH → HKDF root → symmetric ratchet → per-message AES-GCM key deleted after use (forward secrecy). One ciphertext envelope per recipient device → `messages.ciphertext_json`, `encryption_version ≥ 1`, `body = NULL`.
- **Groups:** Sender Keys; rotate on **every** join AND leave (removed device can't read future; new device can't read past).
- **Attachments:** per-file random CEK → AES-GCM encrypt → upload ciphertext only; CEK+IV travel **wrapped inside the message envelope** (never a server-readable column). `decryptMessageList` already supports the `{type:'file', key, iv}` shape.

---

## 6. Scalability Impact

- Messaging fan-out is **O(devices)** per message — fine for DMs/small-medium groups; batch the sender-key fanout (currently sequential) before large groups.
- Group rekey on join/leave: O(remaining members), bursty on churn.
- **LiveKit E2EE** (insertable streams, per-frame AES-GCM in a worker): negligible at 2–10, key-distribution-bound at ~50, **past LiveKit's comfortable envelope at 100–150** (CPU/jitter + heavy rekey). For 100+, prefer audio-only E2EE + dynacast pruning. *(For reference, WhatsApp caps E2EE calls ~32, Teams ~50 — 150-participant browser E2EE media is beyond what the incumbents do.)*
- Redis/MinIO scale unchanged (carry only ciphertext after the change).

---

## 7. Top Security Risks (current)

1. **Fail-open to plaintext** if E2EE is naively enabled (most dangerous).
2. **No MITM protection** — `isTrustedIdentity()` always true.
3. **Server-side plaintext sinks** — full-text search, AI→external LLM, notification excerpts.
4. **Non-binding revocation** — revoked/stolen device keeps full access (JWT has no device binding).
5. **Committed secrets** in `.env.server` (DB/JWT/LiveKit) — a live finding regardless of E2EE.
6. **Calls not E2EE** — readable at the SFU; recordings plaintext.
7. Recovery/epoch state client-only → silent decryption failures.
8. **Metadata remains server-visible by design** (sender, recipients, timestamps, membership, file names/sizes) — must be stated honestly to users (same as Signal/WhatsApp).

---

## 8. Implementation Roadmap (realistic: ~5–6 months, one senior eng, for WhatsApp-parity DM+group+attachments)

- **Phase 0 — Hygiene + decommission dead path (1–2 wks):** rotate/remove committed secrets; delete `@signalapp/libsignal-client` + alias; agree the threat model (content-from-operator, NOT metadata). *No false "Signal" claim.*
- **Phase 1 — DM messaging E2EE (4–6 wks, highest value):** Web Crypto + noble X25519 X3DH + symmetric ratchet (same public API); real TOFU + safety-number verification + key-change alerts; OPK/SPK rotation schedulers; device-bound JWT + working revocation. Enable for DMs behind a per-conversation flag. **Fail-closed, never fail-open.**
- **Phase 2 — Group messaging + rotation (3–4 wks):** wire sender-key distribution from UI; epoch hooks on add/remove; server-persist epoch state.
- **Phase 3 — Attachments (2–3 wks):** extend `encryptBlob` to all upload paths; CEK via message envelope; disable plaintext search/AI/notification copies for E2EE convos.
- **Phase 4 — LiveKit media E2EE (3–4 wks):** key provider + worker; key over E2EE channel; disable Egress when E2EE on. Solid 2–10, best-effort ~50.
- **Phase 5 — Device mgmt + recovery (3–4 wks):** multi-device enrollment with existing-device approval; passphrase-wrapped encrypted key backup; recovery APIs.

---

## 9. Compliance (honest)

E2EE strengthens GDPR data-minimization/confidentiality (Art. 5/32) and shrinks breach blast-radius — but it is **not** a certification. Encrypted content is still personal data; **metadata stays in scope**; right-to-erasure still needs ciphertext+key deletion (current soft-deletes leave rows). SOC 2 / ISO 27001 cryptography controls (A.10 / CC6.x) require documented key management, rotation, and revocation — **most of which are missing today**. The committed `.env.server` secrets and the AI-plaintext path are findings to remediate regardless.

**Do not market "end-to-end encrypted" until Phase 1 lands** (working core + MITM protection + fail-closed) — otherwise the claim is misleading.
