# Enabling E2EE on LIVE — safety verdict + rollout runbook

**Verdict: GO** (data‑safe; the two cutover blockers are fixed). Audited adversarially against the live‑user scenario (real users incl. CEO/CTO).

---

## Data safety — confirmed, no wipe
Enabling E2EE (`NEXT_PUBLIC_E2EE_ENABLED=true`) is **purely additive**. No existing data is lost/altered/corrupted:
- **Migrations are additive** (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN DEFAULT`). `0053_e2ee_history_sync` only adds a table. Nothing backfills/rewrites/deletes rows in messages/conversations/contacts/files/users. The run‑once idempotent runner no‑ops applied migrations; `promoteIfNeeded` refuses to clobber a DB with users>0.
- The flip is a **frontend env var** — no backend boot change. Every server write is **INSERT/UPSERT‑only** on the 4 E2EE tables; the only `DELETE`s are confined to `e2ee_history_sync` (ack + hourly TTL purge).
- **Existing plaintext history renders verbatim** (the per‑message decrypt guard requires `m.encrypted` truthy; legacy rows fall through). The server never nulls a legacy body on the flip.
- The client `wipeForUserSwitch` clears **only local IndexedDB crypto state**, only on a *different*‑user login, never on first login or same‑user — **provably unreachable for the CEO/CTO on their own device**. Messages/contacts/files are server‑sourced and survive total client loss.

## Reversibility
Flipping back **off** is safe: legacy plaintext keeps rendering; messages that were encrypted while on go **dormant** (🔒 placeholder) until re‑enabled — **rows intact, never lost**. No migration is reversed; keep the E2EE tables/columns in place across an off‑toggle.

---

## The two cutover blockers — FIXED (required before any flip)
- **B1 — progressive‑rollout plaintext fallback.** Sending a DM to a colleague who hasn't logged in since the flip (zero E2EE devices) used to **fail‑closed**. Now `encryptForUser` returns a `null` sentinel for the *genuine zero‑remote‑devices* case → the sender transparently sends **plaintext** and does **not** pin the conversation; the next send after the peer publishes a device encrypts automatically. A real **changed/MITM identity stays strictly fail‑closed** (throws).
- **B2 — `pinnedAt` time‑anchor.** Once a conversation went E2EE, all its legacy plaintext used to re‑render as "[Unencrypted — rejected]". Now the pin records the first encrypted message's server `createdAt`; the downgrade guard rejects plaintext **only if newer than the pin**. Pre‑cutover history renders verbatim; post‑pin plaintext injection is still rejected; missing anchor (legacy) → exempt (render old history).
- **C (groups, deferred):** a member with no device yet is silently skipped from the epoch (readable‑history gap for them, not data loss). Hold groups for a later wave or add epoch backfill.

---

## Rollout runbook (staged — do NOT flip global‑blind)
1. **Backup.** `mysqldump` the **live prod MySQL on `10.200.3.17`** (the bundled container that holds the real signups/messages — not the empty corporate DB) + volume snapshot + MinIO. Verify the dump restores into a scratch DB. (`scripts/dump-colab-live.sh`.)
2. **Verify migrations** are applied (`schema_migrations`): `0022/0050/0051/0053`. Confirm zero row rewrites.
3. **Ship the fixes** (B1 + B2 — done) + Mechanism A. Build green, tsc‑clean.
4. **Staged enable.** Turn `NEXT_PUBLIC_E2EE_ENABLED=true` for a **small pilot first** (2–3 internal accounts). Keep FS/ratchet sub‑flags (`useOpk`, `E2EE_RATCHET`) **OFF** in the first window (nothing client‑only). Have each pilot user **log in once** so a device is minted/approved before they're messaged.
5. **Verify pilot:** plaintext history still shows; messaging a not‑yet‑migrated peer falls back to plaintext (B1); old history visible in now‑E2EE chats (B2); same‑device restart/logout seamless; new‑device sync works (Mechanism A); calls unaffected.
6. **Expand gradually → all.**
7. **Rollback:** flip `false` (reversible; encrypted‑while‑on dormant, not lost).

> Per‑account staged rollout with a single global build‑time flag means a pilot **deploy/cohort**, not a per‑user toggle. A runtime/server‑driven E2EE flag (small addition, fits `lib/platform.ts`) would enable true per‑cohort flipping if wanted.
