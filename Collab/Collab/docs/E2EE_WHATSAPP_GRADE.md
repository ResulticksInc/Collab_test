# WhatsApp‑grade E2EE for CoLab — the cost‑free path

**TL;DR:** WhatsApp does **not** achieve "seamless everywhere with zero user action." It uses three mechanisms, each with a trade‑off. CoLab **already has two of them**; only one piece is missing, and it can be closed on the existing stack for **$0**. The single unavoidable cost (which WhatsApp also charges) is a one‑time **recovery key** for the *sole‑device‑reinstall* case.

---

## 1. The honest principle
If the server is truly blind (real E2EE), a **brand‑new device with no shared secret cannot decrypt old ciphertext** — period. A secret must travel to the new device somehow. Every E2EE product (WhatsApp, Signal, iMessage) solves this with **one of two** carriers, never magic:
- **(A) Device‑link sync** — an existing logged‑in device re‑encrypts history to the new device.
- **(B) Encrypted backup** — history/keys encrypted under a **user passphrase / recovery key**, stored server‑blind.

WhatsApp ships **both**.

---

## 2. Where CoLab already is (verified in code)
| WhatsApp mechanism | CoLab today | Status |
|---|---|---|
| Local decrypted store → instant same‑device reads | Plaintext cache + key retention + user‑switch wipe (`manager.ts` `decryptMessageList`/`clearSessions`, `SignalStore` deviceOwner) | ✅ **Shipped** |
| Per‑device sender fan‑out → multi‑device *new* messages | `encryptForUser` fans out one envelope per recipient device; ratchet envelopes ride the same array; `registerDevice`/`approveMyDevice`/`revokeMyDevice` | ✅ **Already exists** |
| New device gets *old* history | ❌ none — `manager.ts:856` "No envelope for this device — sent before this device existed" | ❌ **The only gap** |

**So CoLab is ~90% of the way to WhatsApp.** The remaining 10% is new‑device history recovery.

---

## 3. Closing the gap — two cost‑free mechanisms

### Mechanism A — Device‑link history sync *(recommended first; no passphrase)*
Reuses the **existing device‑approval flow** (`e2eeApproveDevice`). When a user approves a new device on an *existing* one:
1. The existing (trusted, online) device reads the recent plaintext history from its local cache.
2. It **re‑encrypts** that bundle to the **new device's published key** (same `encryptForUser` fan‑out path already in code).
3. It uploads the ciphertext bundle; the server **relays** it (stores opaque ciphertext keyed by `newDeviceId`, TTL‑expiring) — **server stays blind**.
4. The new device, on first run, fetches + decrypts the bundle with its own key → history appears.

- **Cost:** $0 — reuses fan‑out + device keys; the server adds one TTL ciphertext‑relay table. No new infra.
- **UX:** zero passphrase — approving the device *is* the authorization (WhatsApp's QR‑link model).
- **Limit:** needs an existing device **online** to sync from. Covers the common "add my desktop / second device" case.

### Mechanism B — Server‑blind encrypted backup *(completeness; the sole‑device‑reinstall case)*
For when there is **no other device** (fresh install / cleared storage):
1. User sets a **recovery key** once (generate a 64‑char key *or* a passphrase → `Argon2id`/PBKDF2 → 256‑bit KEK).
2. The client encrypts its **identity/ratchet keys + a rolling plaintext bundle** under the KEK (AES‑256‑GCM) and uploads **ciphertext only** to the existing DB/MinIO. Server never sees the KEK.
3. New device: user enters the recovery key → derives the KEK → downloads + decrypts → full restore.
- **Cost:** $0 — one `e2ee_backups` table/bucket for the encrypted blob. **WhatsApp's HSM** (which only rate‑limits password guessing) is replaced free by **server‑side rate‑limiting** on the backup‑fetch endpoint + requiring a **strong generated recovery key** (Signal/WhatsApp offer the same 64‑char key).
- **UX cost (unavoidable):** the user must keep the recovery key. **Lose it → lose the backup** — *exactly* WhatsApp's E2EE‑backup behavior. This cannot be removed without trusting the server (not E2EE).

---

## 4. Recommended rollout (all $0)
1. **Done:** same‑device seamless + per‑device fan‑out (already shipped/exists).
2. **Next (small):** Mechanism **A** — device‑link history sync. Reuses approval + fan‑out; biggest UX win, no passphrase. Covers "I added another device."
3. **Then (medium):** Mechanism **B** — server‑blind recovery backup. Covers "I reinstalled / lost my only device." One recovery‑key step, like WhatsApp.

After A+B, CoLab matches WhatsApp's *actual* behavior 1:1 — seamless on known devices, recoverable on new ones via link‑sync or recovery key — on your existing self‑hosted stack, for **$0**.

---

## 5. Hard guarantees to preserve while building
- **Never weaken new‑message encryption** — it stays gated on `isE2EEEnabled()`.
- **Server stays blind** — A relays ciphertext; B stores ciphertext; neither ever sees a plaintext key.
- **Do NOT touch calls/meetings/LiveKit** — E2EE never covered the media plane; the call e2e tests remain the guard.
- **Same‑device retention trade‑off** (keys at rest after logout) is already documented; B's recovery‑key flow is what extends safety to new devices.

---

## 6. What "no compromise" really costs
The only thing standing between "seamless on a *new* device" and "server‑blind E2EE" is **a secret the user carries** (a recovery key) **or** an **existing device to sync from**. WhatsApp requires the same. There is no fourth option — and CoLab can deliver both carriers for free.
