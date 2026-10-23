# E2EE — Automatic history recovery

**Status:** implemented (2026-09-22). Applies when `NEXT_PUBLIC_E2EE_ENABLED=true`.

## The problem it fixes

A message this device could not decrypt rendered as **"Message unavailable on
this device"** with a **Try again** button, and a locked attachment rendered as
**"Not available on this device"** with its own Try again. Both were dead ends:

- the sibling-device heal only works while another device is online;
- the server-blind backup could only be opened with a secret the client had in
  memory — the sign-in password at a *password* login. Every other sign-in path
  (SSO, a saved session, a desktop reinstall whose keychain token survived, a
  cleared IndexedDB, the Settings › Security "reset device" escape hatch) had
  no password, so nothing automatic could ever run;
- the backup itself covered only a recent window (500 messages per
  conversation, 8 000 in total, conversations active in the last year), skipped
  voice notes, and was **rebuilt from scratch** on every refresh from whatever
  *this* device could still read — so messages another device had contributed
  fell out of it, and a device holding a stale key could overwrite the backup
  for everyone;
- every existence / capability check downloaded the *entire* backup to read
  one field.

## What happens now

Recovery is a single orchestrated routine, `autoRecoverHistory()` in
`frontend/app/src/lib/e2ee/manager.ts`. It opens every source the device can
open **without asking the user**, cheapest first, and publishes its state:

| # | Source | Covers |
|---|--------|--------|
| 1 | Backup key already cached on this device | same device, keys intact; a device that reset itself (the key now survives a reset) |
| 2 | Desktop OS-keychain copy of the backup secret (`tokenStore.ts`, slot `e2eeRecoverySecret`, tagged with the user id) | desktop reinstall, cleared app data, any restored desktop session |
| 3 | **Server-escrowed account key** (`GET /api/e2ee/account-key`, wrap kind `account`) | **any** signed-in device: SSO, saved session, brand-new browser, no password needed |
| 4 | A sibling device's sync bundle already waiting on the relay | another device already pushed history |
| 5 | Live ask to every sibling that is online (`requestAllHistoryHeal`) | any other device online, any conversation, however old |

### The account key (source 3)

The server keeps one random 32-byte key per user in `e2ee_account_key`
(migration 0124), sealed with AES-256-GCM under an HKDF key derived from
`E2EE_ESCROW_SECRET` (fallback `AUTH_JWT_SECRET`). It is returned, unsealed,
only to that user's authenticated sessions. The client wraps the recovery
secret under it exactly like the password and passphrase wraps
(`ensureAccountWrap`, re-published whenever the secret is created or restored)
and any device unwraps it in `restoreWithAccountKey`. An account with no backup
at all (SSO-only users who never had a password login) gets one created
silently at init (`ensureAutoBackup`).

**Trade-off, decided 2026-09-22:** an operator with the database and the
escrow secret can open users' history *backups*. Live messages stay end-to-end
encrypted per device. `E2EE_AUTO_RECOVERY=false` returns to the strictly
server-blind model; turning Chat Backup off deletes the account key with the
backup. The Security panel says this in plain words.

It runs, awaited, inside `initE2EE` (so the first thread render already sees
restored plaintext where a key was found), again on socket reconnect, and again
whenever `decryptMessageList` hits any gap — no envelope for this device, a
consumed one-time key, a missing group epoch, a wrong-key decrypt. Runs are
throttled (`backupPlan.shouldRunRecovery`) and never overlap.

The **password** path is unchanged and still automatic: a password sign-in
unwraps the backup, and now also stores the secret in the desktop keychain so
the *next* reinstall needs nothing.

### Coverage: the backup now holds the whole history

- Bounded by **bytes** (40 MB of plaintext JSON, oldest dropped first;
  server ceiling raised to 64 MB / 96 chunks) instead of a short count.
- The backup gather ignores the activity window and walks every DM, group and
  channel (`gatherHistoryEntries({ allTime: true })`, up to 5 000 messages per
  conversation).
- **Voice notes are included.** They are encrypted attachments; leaving them
  out meant every voice note was silently missing on a restored device.
- Refresh is **incremental and merging**: decrypt what the server holds, gather
  only messages newer than the watermark, merge by message id (a fresh entry
  replaces the old one, so an edit is carried), trim, re-upload. An empty or
  partial gather can no longer shrink the backup; a backup with an unreadable
  chunk is never re-published.
- **Stale-key guard**: before publishing, the device proves its cached key
  opens the server backup (one AES-GCM decrypt of a probe chunk). If it does
  not, the key is dropped locally and nothing is uploaded, instead of
  corrupting the backup for every other device.

Media follows automatically: a file or voice message's backup entry *is* its
`{type:"file", key, iv, …}` envelope, so once the entry is merged the
attachment's AES key is attached on render and the ciphertext is fetched from
the server and decrypted on demand, exactly like a same-device attachment.

### Cheaper checks

`GET /api/e2ee/recovery-backup?meta=1` returns salt, version, wraps, chunk
count, byte length and a one-chunk **probe** — no ciphertext. Every capability,
existence and key-verification check uses it; the full body is downloaded only
to restore or to merge.

## What the UI shows

| State | Message row | Attachment card | Thread banner |
|-------|-------------|-----------------|---------------|
| a pass is running / a key is held and rows are filling in | spinner **Restoring…** | spinner **Restoring…** | quiet **Restoring your messages…** line, no buttons |
| every automatic source tried, no key, a backup exists | lock **Encrypted message** | lock **Encrypted file** + one-line hint | **Unlock** (one time; password, passphrase or recovery key in one field) and **Later** |
| every automatic source tried, no backup, but another device exists | lock **Encrypted message** | same | "These messages appear automatically once one of your other devices is online" — no spinner, no buttons |
| no backup and no other device (the key exists nowhere) | **Message can't be recovered on this device** | same | honest terminal text, no buttons |

The last row is shown only when the backup and device lookups both *succeeded*
and found nothing (`E2EERecoveryPaths.verified`). A failed lookup (429, offline,
expired token) is "unknown" and keeps the neutral row, re-checked every ~8 s,
and a row with an open sender re-delivery ask is never terminal either.

There is no "Try again" anywhere. The periodic re-decrypt of the open thread
(`useCoLab1`, every 90 s while rows are pending) and the reconnect handler keep
retrying on the user's behalf.

## When can a typed credential still be needed?

Only when the server has `E2EE_AUTO_RECOVERY=false`, or a backup predates any
device publishing an account wrap (the wrap is published the first time any
device holding the secret runs this code — one password login on any device is
enough). Then the device is asked **once**; the key is cached (and kept in the
desktop keychain) so it never asks again.

## Files

- `frontend/app/src/lib/e2ee/manager.ts` — orchestrator, keychain restore,
  incremental refresh, stale-key guard, coverage limits, meta-based checks.
- `frontend/app/src/lib/e2ee/backupPlan.ts` — pure merge / trim / watermark
  helpers and the recovery state machine (tested in
  `backend/app/test/e2ee-backup-plan.test.ts`).
- `frontend/app/src/lib/tokenStore.ts` — desktop-keychain slot for the secret.
- `frontend/app/src/components/chat/E2EEBanners.tsx`,
  `FileAttachment.tsx` — state-driven rows and banner.
- `backend/app/src/services/e2eeService.ts`, `routes/e2ee.ts`,
  `database/src/drivers/mysql.ts` — `?meta=1`, raised backup ceiling.
