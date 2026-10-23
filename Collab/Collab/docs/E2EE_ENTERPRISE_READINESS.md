# CoLab E2EE — Self-Hosted Readiness Assessment

**Date:** 2026-06-25
**Scope:** self-hosted FOSS deployment. Everything in this document is **cost-free** and runnable on commodity hardware — no paid audits, no commercial services, no SaaS dependencies.
**Status:** ready for the operator-run validation in §5. Once that passes, the deployment is appropriate for self-hosted production use.

---

## 1. Scope of "E2EE" in CoLab

CoLab E2EE covers:
- **Messages** — DM, self-note, group, channel
- **Attachments** — DM, self-note, group, channel (file body, not filename)
- **Call media** — 1:1 voice/video, group calls, standalone meetings (LiveKit insertable streams)

It does NOT cover:
- Message metadata (sender, recipient, timestamp, conversation id) — visible to server
- Call signalling (presence, who's in a room) — visible to LiveKit + backend
- File names, sizes, mime types — visible to server
- Push notification text (server-side, only when E2EE is OFF)
- Search (FTS indexes are NULL for E2EE messages — search degrades gracefully)
- AI summarisation, server-side reactions, server-side translation — all explicitly skip E2EE messages

These are documented metadata trade-offs, not bugs. In a self-hosted deployment the "server" IS the operator, so the metadata footprint is whatever the operator chooses to keep — there is no third party seeing this data.

---

## 2. Architecture (one-paragraph)

Native Web Crypto, **no Signal libsignal dependency**, no external crypto service. P-256 ECDH + HKDF-SHA-256 + AES-GCM-256 (ECIES) per recipient device for DM/self-note + key-wrap; AES-GCM-256 per-epoch shared key for groups/channels/calls/meetings, with each member's copy of the epoch key ECIES-wrapped to their device's identity key. Device identity is a **non-extractable** CryptoKey in IndexedDB (JS/XSS cannot read it). Sender authentication: per-device ECDSA P-256 signing keypair, signature over AAD on every envelope. Forward secrecy on text DMs: X3DH-style identity+one-time-prekey DH mix with private-OPK deletion after first decrypt + plaintext cache. The server stores PUBLIC keys + opaque ciphertext only. Every primitive is in the browser's Web Crypto API + a tiny pure-Node verification harness — zero external dependencies.

---

## 3. Closed defences

| ID | Defence | State |
|----|---------|-------|
| **Conf** | Confidentiality vs server/DB/storage/operator | CLOSED |
| **Integ** | AES-GCM AAD bound to sender/recipient/conv/nonce/mid | CLOSED |
| **V1** | Anti-replay (mid in AAD + persistent IndexedDB log) | CLOSED |
| **V2-pin** | TOFU peer-identity pin + key-change refusal | CLOSED |
| **V2-OOB** | Out-of-band safety-number verification + persistent verified state + key-change re-verify prompt | CLOSED |
| **B1** | Forced-downgrade / plaintext-injection guard (persistent conv pin) | CLOSED |
| **B2** | Per-device ECDSA sender authentication (DM + group) | CLOSED |
| **B2-strict** | Strict-mode flag (`NEXT_PUBLIC_E2EE_REQUIRE_SIGNATURES`) to fail-closed once migration window passes | CLOSED |
| **B3** | 1:1 call media E2EE (seed via `ensureGroupKey`) | CLOSED |
| **Atomic-epoch** | Group epoch race resolved server-side (loser adopts winner) | CLOSED |
| **Device-approval** | First-device trusted, subsequent pending until approved | CLOSED |
| **Fail-CLOSED-send** | `encryptForUser` throws rather than silently sending plaintext | CLOSED |
| **Self-multi-device** | `encryptForUser` also encrypts to own current device | CLOSED |
| **Meeting media** | Standalone meetings use B3 pattern | CLOSED |
| **JWT-device-bound** | `E2EE_DEVICE_BOUND_JWT_STRICT` rejects missing/revoked-device tokens | CLOSED |
| **Push-text** | All push paths gate on `text && !encrypted` | CLOSED |

Crypto core verification: `node scripts/verify-e2ee-crypto.cjs` = **19/19 pass**.

---

## 4. Open gaps (honest, self-host-relevant only)

| ID | Gap | Severity (self-host) | How to close — cost-free |
|----|-----|----------------------|-------------------------|
| **GAP-1** | Live runtime validation — actual run | BLOCKING | Operator runs the 2-browser §5 procedure once + `node scripts/e2ee-runtime-validation.cjs`. Harness is in the repo. Cost: ~30 minutes of operator time. |
| **GAP-2** | Forward-secrecy Double Ratchet | MEDIUM | Multi-week implementation, no money required — just engineering time. Current X3DH-OPK gives partial FS for first text DM. Operator can choose to live with partial FS (acceptable for self-hosted teams where the threat model excludes long-term device-key theft) or schedule the implementation. |
| **GAP-5** | First-message TOFU window | LOW | Mitigated by the OOB safety-number verification UI (now wired). Operator policy: tell users to compare codes on first contact with anyone they don't already trust on the LAN. |
| **GAP-6** | New device cannot read history | BY DESIGN | This is the trade-off for true E2EE. Operator-side mitigation: encourage users to keep one always-on device, or accept that history is local-only per device. |

Items I explicitly removed from any "needs-doing" list:
- **Paid third-party audit** — irrelevant for self-hosted FOSS. Replaced by the self-audit toolchain in §6.
- **"Enterprise procurement / compliance certifications"** — only matter if you're selling SaaS. A self-hosted operator decides their own compliance posture.

---

## 5. Path to "ready for self-hosted production"

In order, all free, all runnable on your own box:

1. **Run the runtime validation harness.**
   - Set `NEXT_PUBLIC_E2EE_ENABLED=true` + `E2EE_ENABLED=true`, rebuild + restart.
   - Open 2 browsers (different users), send: a DM text, a group text, a DM file, a group file, place a 1:1 call ≥5s, place a meeting ≥5s.
   - Run `node scripts/e2ee-runtime-validation.cjs`. Exit 0 = pass.
   - Save the output as `docs/runs/e2ee-validation-<date>.txt` for your records.

2. **Run the static-analysis sweep** (see §6 for the toolchain). All free.

3. **Operate in permissive B2 mode for one `AUTH_TOKEN_TTL` window** (7-14 days). Then flip BOTH `NEXT_PUBLIC_E2EE_REQUIRE_SIGNATURES=true` and `E2EE_DEVICE_BOUND_JWT_STRICT=true`. Re-run the harness to confirm no legitimate users get rejected.

4. **Optional / when you have time:** schedule the Double Ratchet sprint (GAP-2). Until then, document in your user-facing docs that "forward secrecy is partial — first message in a thread gets it, subsequent messages do not."

Once steps 1-3 are done, the deployment is ready for self-hosted production use. No external party, no certification, no money required.

---

## 6. Self-hosted security-review toolchain (all free)

These are the cost-free equivalents of paying an audit firm. None replace a human expert with adversarial intent, but together they catch the bulk of what humans would. The operator can run them on their own infrastructure.

| Tool | What it checks | Self-hosted / cost |
|------|----------------|--------------------|
| **`scripts/verify-e2ee-crypto.cjs`** | The 19 crypto-core invariants (round-trip, AAD tamper, replay, B2 forgery, B3 1:1 wrap) | Already in repo. Free. |
| **`scripts/e2ee-runtime-validation.cjs`** | 8 server-blindness invariants (body NULL, ciphertext landings, key publication, push-text gating) | Already in repo. Free. |
| **`semgrep`** (OSS) | Source-pattern security rules (hardcoded secrets, dangerous APIs, missing input validation) | `pip install semgrep` → `semgrep --config p/security-audit`. Self-hosted, free for any repo size. |
| **`eslint` + `eslint-plugin-security`** | JS/TS source-pattern security | Already in the npm dev deps for most projects; add the plugin. Free. |
| **`npm audit`** + **`osv-scanner`** (Google OSS) | Known-CVE dependency scan | Built into npm + standalone OSV CLI. Free. |
| **`gitleaks`** | Pre-commit secret-scan | Single binary, free OSS. |
| **CodeQL** (free for any repo) | Semantic security analysis (taint flow, injection) | Run locally via the CodeQL CLI. Free for open-source AND for private self-hosted CI. |
| **Threat-model review** | Did the team think about the adversary? | Read `docs/E2EE_ADVERSARIAL_AUDIT.md` + the current doc with at least one other person on the team. Free; time-only. |
| **Public source review** | Anyone in the world can read the crypto | The code is in a repo. Invite community review via your issue tracker / forum. Free. |

There is no honest substitute for an experienced human auditor with adversarial mindset, but for a self-hosted FOSS deployment the toolchain above + careful self-review is a reasonable bar. The threshold the operator should hold themselves to: **"I have run all of the above, read the threat model, and can defend every architectural choice to a skeptical user."**

---

## 7. What you can honestly tell your users (with flag ON)

**Defensible:**
- "Message content, attachment content, and call media are encrypted on your devices. The server cannot read them."
- "Encryption keys never leave the device — they live in the browser's non-extractable secure storage."
- "Each message is bound to its sender, recipient, conversation, and timestamp — the server cannot move, replay, or splice messages."
- "Each message is signed by the sender's device — the server cannot forge a message attributed to a colleague."
- "Sender identities can be verified out-of-band by comparing a security code."
- "The full source is open and reviewable. The crypto core has an automated test suite (19 checks) and a server-blindness validation harness (8 checks) anyone can run."

**Honest qualifications (say these clearly):**
- "Metadata — who messaged whom, when — is visible to the server. (In a self-hosted deployment, you ARE the server, so this is your data.)"
- "Forward secrecy is partial: the first message in a thread gets it, subsequent messages do not (we haven't implemented a full Double Ratchet yet)."
- "We have not had a third-party security audit. The toolchain in `docs/E2EE_ENTERPRISE_READINESS.md §6` is what we run instead. Anyone can review and contribute findings."

**Don't claim:**
- "Signal-grade encryption" — CoLab uses ECIES + shared epoch keys, not Signal's Double Ratchet.
- "Perfect forward secrecy" — until the Double Ratchet ships.
- "Zero-knowledge" — metadata is server-visible.

---

## 8. Risk register if flag is flipped without §5

| Skipped step | Likely outcome |
|--------------|----------------|
| Runtime validation | E2EE writes silently fail for some users; "messages disappear" reports |
| Migration window before strict mode | Users get "[Forged or tampered]" or "Device-bound token required — please re-login" on legitimate sessions |
| Static analysis sweep | Easy-to-find bugs ship that semgrep would have caught |

---

## 9. Verdict

**Architecture:** sound.
**Implementation:** thorough, gated, tsc-clean, crypto-core-verified.
**Operational gate:** §5 — runnable in 30-60 minutes by the operator, no external party.
**Cost:** zero. Everything is in-repo or free OSS tooling.

**Recommendation:** run §5, document the result in `docs/runs/`, run the §6 toolchain, then flip the flag for your self-hosted deployment.
