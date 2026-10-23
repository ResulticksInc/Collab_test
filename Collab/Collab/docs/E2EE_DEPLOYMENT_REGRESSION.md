# E2EE — "messages from the last N days unavailable after a deployment"

**Symptom (2026-09-22):** a deployment ten days earlier left everything
readable. Today's deployment, on the *same* devices with no user or device
change, shows **"Message unavailable on this device"** for messages from the
last ten days; older messages still render.

## How the client gets into that state

The row text comes from `decryptMessageList` in
`frontend/app/src/lib/e2ee/manager.ts` when a message cannot be decrypted:
no envelope for this device id, a consumed one-time key with no cached
plaintext, a missing group epoch key, or a wrong-key decrypt. Messages that
were decrypted once are served from the local plaintext cache without touching
any key at all, so on an unchanged device the placeholder can only appear for
messages that **never made it into that cache** or after the cache was
**wiped**.

The pattern "older readable, recent unavailable" is the signature of two things
combining:

1. **Local E2EE state was replaced or wiped on a device that had not changed.**
   Every message ever sealed to the old identity key becomes unreadable at once.
2. **The device restored its history from the backup, and the backup was stale.**
   Everything the backup held came back readable; everything newer than its
   last successful refresh stayed on the placeholder. The width of the gap is
   the age of the backup, not the age of the deployment.

Same-device triggers for (1) that a deployment can cause, in the code that was
running:

| Trigger | Where | What happened |
|---|---|---|
| Server no longer lists this device (restored/rebuilt DB, reset `e2ee_devices`, device rows re-created during a stack rebuild) | `_initE2EEImpl` "mismatch guard" | The client **wiped every IndexedDB store** (keys, plaintext cache, backup key), removed its device id, reloaded and **minted a brand-new identity**. Nothing it had could read anything sealed before. |
| A device-bound token dropped as "foreign/unknown" in permissive auth mode | `middleware/auth.ts` | The claim is dropped, not rejected; harmless by itself, but the next init hits the guard above. |
| Device not "seen" for `E2EE_DEVICE_STALE_DAYS` (60) | `e2eeService.bundleFor` | Senders stop encrypting to it. `last_seen_at` was only stamped when the token carried a device id; a device on an **unbound token** (first session after enrolment, or a failed rebind) was never stamped and fell back to `created_at`, so an actively used device could be pruned on day 60. |

Causes of (2), the stale backup, in the code that was running:

- The refresh **full-replaced** the backup from whatever this device could
  read, and a "refuse to shrink" guard skipped the upload whenever the gather
  came back smaller than the server's count — which it did permanently once
  the server held entries this device could not reproduce. From then on the
  backup froze at its last publish.
- Refresh ran **only at init**, gated by a 5-minute floor and a watermark, so
  a long-lived tab or desktop session never refreshed at all.
- The backup covered a window (500 per conversation, 8 000 total, one year of
  activity) rather than the history.

The local live stack shows the mechanism end to end: after yesterday's stack
rebuild every device row was re-created (`e2ee_devices.created_at` = the
rebuild time) and the client telemetry recorded 13 hits of
`E2EE: no envelope for this device` in the following minutes.

## What changed so this cannot recur

**Never throw keys away on a same-user device.**
- `_initE2EEImpl` mismatch guard: when the server does not list our device, the
  client now **re-registers the same device id with the same identity key**
  (`registerDevice` is an upsert) and re-approves it, then republishes its
  one-time prekeys. Every old envelope stays readable. Only if the id genuinely
  belongs to another account (the server now answers 409) does it re-mint.
- Even a re-mint uses `SignalStore.wipeIdentityOnly()`: identity, prekeys,
  sessions and ratchet state go; the **plaintext cache, backup key, secret,
  conversation pins and peer pins stay**. History does not disappear behind a
  placeholder while a new identity is minted.
- `resetE2EEDevice` (Settings › Security) also keeps the backup key.
- Server: `registerDevice` refuses an id owned by another account instead of
  silently overwriting that account's device key.

**Never let the backup fall days behind.**
- Refresh is now **incremental and merging** (`backupPlan.mergeEntries`): it
  decrypts what the server holds, gathers only messages newer than the
  watermark, merges by id, and re-uploads. An empty or partial gather can no
  longer shrink or freeze the backup.
- Refresh is scheduled **three minutes after new activity** (a sent message, a
  freshly decrypted incoming message, a sibling bundle), not only at init.
- A cached backup key that no longer opens the server backup is dropped rather
  than used to publish over it (stale-key guard).
- Coverage is full history, bounded by bytes, voice notes included.

**Never prune a device that is in use.**
- Every authenticated request carries `X-CoLab-Device-Id`; the auth middleware
  stamps `last_seen_at` for that device when it provably belongs to the caller,
  even while the token is still unbound.

**Even if state is lost anyway, recovery is automatic.**
- `autoRecoverHistory()` opens the cached key, the desktop keychain copy, the
  server-escrowed account key and sibling devices with no prompt (see
  `E2EE_AUTO_RECOVERY.md`).

## Deployment checklist

- Migrations only. Never restore `e2ee_devices`, `e2ee_conversation_keys`,
  `e2ee_recovery_backup` or `e2ee_recovery_wrap` from an older snapshot while
  `messages` moves forward; the promote step in `database/src/bootstrap.ts`
  already refuses to import a dump over a populated database.
- Keep `AUTH_JWT_SECRET` and `E2EE_ESCROW_SECRET` stable across deploys.
- Keep the web origin stable: IndexedDB and localStorage are per origin, so a
  new hostname or port *is* a new device for every user.
- Rebuild the frontend image with the same `NEXT_PUBLIC_E2EE_*` values.
- After deploying, check the Observatory for `no-envelope` / `decrypt-failed`
  E2EE incidents and for a burst of new `e2ee_devices` rows; the new
  `device-reclaimed` incident kind marks a device that repaired a lost server
  row without losing keys.

## 2026-09-24 — "older messages re-encrypted", new messages readable

**Symptom:** on a device that had not changed, every message older than a
day or two shows **Encrypted message** (or, in the chat list preview,
**Message unavailable on this device**), while messages from the last day
render normally. The user reads it as the old messages having been
"re-encrypted".

**What actually happened.** Nothing was re-encrypted; the ciphertext on the
server never changes. The device lost the keys those envelopes were sealed
to, and nothing could give the plaintext back:

1. The build running on the live host until the 2026-09-24 merge of `UAT`
   into `run` (`0badea24` and earlier) still had the destructive mismatch
   guard described above: whenever `GET /api/e2ee/devices` did not list the
   device (a device row lost, revoked or overwritten — the old backend's
   `registerDevice` upsert also let another account's freshly minted random
   id overwrite an existing row), the client called `wipeForUserSwitch()`.
   That wiped the identity keys, the **plaintext cache**, the backup key and
   the backup secret, then minted a new device. Everything sealed to the old
   identity became unreadable in one step; messages received after the
   re-mint are sealed to the new identity and read fine — hence "old
   unreadable, new readable".
2. That build had no automatic recovery. Its only restore path was the
   password-wrapped backup, which is created and opened during a *password*
   login. This deployment signs users in through SSO (`SSO_ENABLED=true`), so
   no backup had ever been created and no restore could run. Recovery reached
   `exhausted` and the row copy fell to **Encrypted message**.

The build merged on 2026-09-24 removes cause 1 (reclaim, `wipeIdentityOnly`,
409 on foreign ids) and cause 2 (`autoRecoverHistory` with the escrowed
account key, `ensureAutoBackup` for SSO-only accounts). It cannot undo a wipe
that already happened: the plaintext for those messages now exists only on
the user's *other* devices that kept their keys.

**The gap that kept those devices from helping, fixed today.** With the new
build, the first device of a user to boot creates the account's backup from
what *it* can read (`ensureAutoBackup`). When that device is the one that had
been wiped, the backup is seeded with only the recent messages. Every other
device then restored that backup, cached its key, and — because the refresh
resumed from the backup's newest entry as soon as the backup held anything —
contributed **nothing older** than that entry. The phone that could still
read years of history never put it into the backup, and the wiped laptop
stayed on **Encrypted message** for all of it, with a backup and a sibling
both present.

`refreshRecoveryBackup` now makes every device walk its **entire** readable
history once per backup (`planRefreshGather` in `backupPlan.ts`, marker
`e2ee_recovery_full_walk` = the backup salt; cleared with the other backup
markers, set by the two backup creators). No floor or watermark holds that
first walk back; after it, gathers are incremental as before. A device that
minted a new random id colliding with another account's (409) now re-mints
the id instead of ending up with keys and no server row.

**What to expect on the live host after deploying this build:** each device
runs one full walk on its next boot (paginated, bounded by the existing
per-conversation and byte limits) and merges into the backup. Devices that
were wiped pick the merged entries up on their next automatic recovery pass
(init, reconnect, or the next decrypt gap) and the placeholders fill in.
Messages that no remaining device can read — every device of the user was
wiped, and the peer's copy is sealed to the peer — cannot come back.

### Reproduced with real browsers (2026-09-24, `scripts/e2ee-recovery-check.cjs`)

Running two users through the local live-profile stack showed the mechanism
that keeps the placeholder on screen **even with the merged build**:

1. **E2EE init fired a request storm.** For every sibling device row the
   account had ever registered (each browser profile, each reinstall, each
   automation run is a row — the test account had 29), the client ran a
   separate `ensureSessionsForUser` bundle fetch and a **separate full
   history walk** (`gatherHistoryEntries`: the conversation list plus up to
   100 message pages per conversation) to build that sibling's bundle. One
   init produced several hundred API calls in a few seconds.
2. **The global API throttle answered 429 to everything.** `apiLimiter` allows
   600 requests per minute *per source IP*. Behind the corporate LB and nginx
   every user arrives from the same address, so that bucket was shared by the
   whole company. Once it tripped, the thread's own `/messages` fetch, the
   device list, `recovery-backup?meta=1`, `account-key` and the history-sync
   relay all returned 429 for the rest of the minute.
3. **The client read 429 as "nothing to restore".** Every recovery helper
   swallowed errors (`.catch(() => null)`), so a rate-limited
   `recovery-backup?meta=1` looked exactly like "no backup", the run finished
   as `exhausted`, and the rows switched from "Restoring…" to the lock
   **Encrypted message** — for a history that was fully recoverable.

Telemetry from the failing run (one init of each user):

| Call | 429s | 200s |
|---|---|---|
| `GET /api/e2ee/users/<self>/bundle` | 36 | 12 |
| `GET /api/conversations` | 34 | — |
| `GET /api/e2ee/recovery-backup?meta=1` | 4 | 6 |
| `GET /api/e2ee/devices` | 2 | — |
| `GET /api/conversations/<id>/messages` | 2 per thread | — |

**Fixed:**

- `pushHistoryToSiblings`: the init gathers history **once** and pushes it to
  at most `MAX_PROACTIVE_SYNC_TARGETS` (3) of the most recently seen unsynced
  siblings; `buildHistoryBundleForDevice` accepts pre-gathered entries and
  skips the repeated session establishment. Other siblings still get history
  when they ask for it (`requestAllHistoryHeal`).
- Recovery distinguishes *unreachable* from *empty*: a 429 / 5xx / network
  failure on any recovery call marks the run `transient`; the reducer returns
  to `idle` (the UI keeps "Restoring…") and `scheduleRecoveryRetry` re-runs
  with backoff (15 s → 5 min). "Exhausted" is only reported when every source
  answered and none had a key.
- `apiLimiter` is keyed per signed-in user (`apiClientKey`: JWT `sub`, falling
  back to the client IP for unauthenticated traffic). The per-endpoint
  brute-force limiters on login / signup / SSO are unchanged.

**Check on the live host:** `TRUST_PROXY_HOPS` (default 1) must equal the
number of proxies that append to `X-Forwarded-For` in front of the backend.
With the corporate LB *and* nginx both appending, it is 2; with 1 the
"client IP" the auth limiters see is the LB address, so 30 login attempts per
15 minutes are shared by everyone in the building. Verify with
`docker compose ... logs nginx | grep -o '"[0-9., ]*"$'` on a request from a
known client, or by echoing `req.headers["x-forwarded-for"]`.

### Plaintext fallback (2026-09-24)

A message that was **not encrypted properly** — the sender's client stored a
plain body, the envelope set was stripped, or an envelope exists but cannot be
opened here — now renders its plaintext, tagged **Not encrypted** in the
bubble, whenever any source still has it. "Message unavailable on this device"
is shown only when there is nothing to show.

- The server row's own body is tried first (`serverPlaintextOf` in
  `frontend/app/src/lib/e2ee/plaintextFallback.ts`; placeholders are never
  mistaken for content).
- The app can register a further source with `setPlaintextFallback(cb)` in
  `manager.ts`: the callback gets the raw message and returns text or null.
- `pendingRow` routes every undecryptable branch (no envelope, consumed
  one-time key, missing group key, ratchet key gone, wrong key, transient
  fetch failure) and the stripped-envelope case through it. The heal /
  recovery the branch scheduled still runs; a readable fallback never cancels
  the attempt to open the real envelope.
- Scenario 4 of `scripts/e2ee-recovery-check.cjs` posts a plain body straight
  to the API into the encrypted DM and asserts the peer renders the text.

### Sender re-delivery (2026-09-24)

The backup and the sibling sync can only return what one of the **reader's**
devices once decrypted. A message the reader never opened anywhere — sent
while their only device had the wrong key, or before a fresh device existed,
with no sibling online — has exactly one remaining source: the **sender's**
device, which still holds the plaintext of what it sent. This is the Signal
"retry receipt" idea.

- Requester (`requestRedelivery` in `manager.ts`, called from `pendingRow` for
  every undecryptable per-device envelope from another user, at most once per
  message per 2 minutes): `POST /api/e2ee/messages/:id/redeliver`. The server
  checks membership and device ownership and relays
  `E2EE_REDELIVER_REQUEST` to the sender's devices. Nothing is stored; the
  periodic re-decrypt re-asks while the row is pending.
- Sender (`redeliverMessage`, wired in `useCoLab2` next to the epoch re-key
  handler with the same own-roster membership guard): looks the message up in
  its plaintext cache, seals it to the requesting device with identity-only
  ECIES (no one-time key, so the copy stays re-decryptable from the row) and
  `PUT /api/e2ee/messages/:id/envelope`. The server accepts an envelope only
  from the message's sender, only for a non-revoked device of a current
  member, appends it to the existing envelope set without touching `edited`
  or the other devices' envelopes, and emits `E2EE_REDELIVERED` to the
  requester's devices, which refetch the thread.
- The signature model is unchanged: the new envelope is signed by the
  sender's current device and verified against that device's published key.
  Group messages keep using `requestEpochRekey`.
- Row copy: a row with a re-delivery in flight keeps the calm "Restoring…"
  state even when the shared backup/sibling pass is exhausted, and the
  preview text (`E2EE_PENDING_TEXT`) is now "Encrypted message" — it names
  what the row is, never a failure.
- `scripts/e2ee-recovery-check.cjs --mode redeliver` closes the reader's only
  device before its backup refresh, signs the reader in on a fresh device with
  the sender online, and asserts the message appears and that the sender
  re-delivered an envelope.

**Backup refresh after activity (found by the check script, 2026-09-24).**
The debounced refresh three minutes after new activity was silently a no-op:
`refreshRecoveryBackup`'s five-minute session floor was longer than the
three-minute debounce, so a message received shortly after boot never reached
the backup until the next boot, and a device restored from that backup lacked
it. The activity-triggered run now passes `afterActivity: true` and skips the
floor (the debounce already spaces it out); the watermark gate still applies.

### Durable, member-answered re-delivery + diagnostics (2026-09-24, later)

A live screenshot after the first re-delivery build still showed a device in
the exhausted state: own messages behind the lock, the peer's rows waiting on
re-delivery, and the peer last online the day before. Two gaps remained, and
one blind spot.

- **Asks were live-only.** A re-delivery ask relayed over the socket was lost
  when the other side was offline, and only repeated while the reader kept
  the thread open. Asks are now stored (`e2ee_redeliver_requests`, migration
  0126, 7-day TTL) and every member's device answers the stored asks for
  conversations it belongs to at init and on reconnect
  (`processPendingRedeliveries`, `GET /api/e2ee/redeliver-requests`). An
  answered ask is deleted when the envelope is stored.
- **Only the original sender could answer.** A reader's OWN messages had no
  source at all when no sibling was online. Any current member may now
  re-deliver: the peer who read a message still holds its plaintext. An
  envelope added by someone other than the original sender carries
  `redeliveredBy {userId, deviceId}`; the reader verifies it against that
  device's signing key (`decryptMessageList`, `recoverPlaintextForSync`) and
  the row still shows the original sender. Membership is enforced on the
  server for both the ask and the answer.
- **Nothing said which source was missing.** Settings › Security now has a
  *Recovery diagnostics* card (`e2eeDiagnostics()` +
  `GET /api/e2ee/diagnostics`): recovery phase and sources tried, whether
  this device holds the backup key / secret, the chat-backup setting, and the
  server's view — automatic recovery on/off, account key state (ok,
  not-minted, unsealable, not-configured), backup presence / size / wrap
  kinds, whether this device row exists and is trusted, sync bundles and
  open asks. *Copy report* puts it on the clipboard. A support screenshot of
  this card replaces guessing.
- A device that just created the account's first backup re-runs recovery so
  the UI leaves "exhausted" without a reload.

`scripts/e2ee-recovery-check.cjs --mode redeliver-late` proves the stored
path: both users offline when the fresh device asks, then the peer signs in
and both the peer's message and the reader's own reply appear.

**Incremental gather watermark (found by the check script, 2026-09-24).** The
refresh resumed from the *backup's* newest entry. When another device had
contributed a newer entry first (a sibling's walk that ran before it received
the message), every older message only this device could read was skipped
forever, and a device restored from that backup stayed on "Restoring…" for
them. The watermark is now strictly this device's own (never advanced by a
restore), and conversations in which an OLD message became readable late (a
sibling bundle, a re-delivered envelope) are marked dirty and re-walked in
full on the next refresh (`markBackupDirty`).

## Migrating EXISTING messages into the backup (2026-09-24)

The backup shipped after the messages already existed, and the server cannot
build it: `messages.ciphertext_json` holds one envelope per recipient device
(DMs) or a message sealed under a group epoch key whose per-device wraps sit in
`e2ee_conversation_keys`; both open only with a device's private identity key,
which never leaves the device. So the migration is done BY the devices, and it
is automatic. Three paths run together; every one of them needs nothing from
the user except signing in.

| Path | Who does it | What it covers |
|---|---|---|
| **Full walk** (`refreshRecoveryBackup`, first publish per backup) | every device that still holds its keys, at its first sign-in on this build | every message that device can read → its owner's backup → any of that owner's devices, now or later, via the escrowed account key |
| **Sibling sync** (`requestAllHistoryHeal`, relay bundles) | a user's other devices when online | the same, device to device, without waiting for a backup refresh |
| **Migration sweep** (`auditUnreadableHistory` → `POST /api/e2ee/messages/redeliver/bulk`) | a device that is MISSING history, once per session, at most every 12 h | walks every conversation, asks for every per-device message it still cannot open; the other members' devices (sender or reader) answer from their plaintext at their next sign-in (`processPendingRedeliveries`), without anyone opening a thread |

What this means for the live roll-out:

1. Deploy both images. Nothing else to run: migration 0126 applies at boot.
2. As each user signs in, their device backs up everything it can read
   (full walk) and asks for everything it cannot (sweep). The asks are stored
   for 7 days.
3. As each *other* user signs in, their device answers the stored asks for
   the conversations they share. Old messages then appear on the asking
   device without it being open.
4. Coverage is complete when every active user has signed in once on the new
   build. A message that no device of either party can read any more (keys
   lost on both sides before this build) has no plaintext anywhere and cannot
   be migrated — that set is visible per user as "re-delivery asks open" in
   Settings › Security › Recovery diagnostics, and shrinks as peers sign in.

`scripts/e2ee-recovery-check.cjs --mode sweep` proves path 3: the reader
signs in and never opens the thread, the peer signs in later, and the message
is readable the first time the thread is opened.

### "Restoring…" that never ends (2026-09-24, live screenshot after the sweep)

Every API answered 200, the sweep and the backup walk ran, and the old rows
still spun. That state means: this device holds a key, the backup does not
contain those messages, and the asks are waiting on another device. Whether
they will ever be answered depends on whether any member device still holds
the plaintext — which the row could not say. Three changes:

- `GET /api/e2ee/redeliver-requests/status?conversationId=` reports, for the
  caller's own open asks, how many candidate devices (every non-revoked device
  of every member, own siblings included) have NOT yet been online since the
  ask. When all of them have (with a grace for the hourly last-seen stamp) and
  the ask is older than five minutes and still open, the row switches from
  "Restoring…" to **No device has this message any more**. That is the honest
  end state for a message encrypted for keys that were lost on every side.
- A recovery run that could not reach a source is reported as *transient*
  only while retries remain; once they are used up it is *exhausted*, so the
  one-time Unlock banner (which keys on "exhausted") can still offer a typed
  credential where a password-wrapped backup exists.
- A device that stays online now re-checks the stored asks every 10 minutes
  (`startPendingRedeliveryPolling`), not only at init and reconnect.

**Load of the recovery machinery (2026-09-24).** The full backup body was
downloaded up to 18 times per session (every recovery pass, refresh and
restore fetched it); it is now cached for a minute and invalidated on every
publish or key drop — one download per device. The migration sweep no longer
walks history a second time: the backup's full walk collects the unreadable
ids on the way and asks in bulk. The walk itself is paced (~460 pages/min,
under the 600/min per-user throttle) and a throttled page is retried after the
window instead of truncating that conversation's contribution. If live
accounts carry very long histories, `API_RATE_MAX=1200` in `.env.live` is a
reasonable ceiling; the limiter is per signed-in user, so this is not a
per-company budget any more.

### 1:1 rows still "Restoring…" with the peer online (2026-09-25)

**What `e2ee_conversation_keys` holds for a 1:1 chat.** Those rows are the
per-conversation **call media** keys minted by `getCallMediaKey` when the two
people call each other (LiveKit E2EE). 1:1 *text* is never sealed with them:
`useCoLab3` sends DM/self text through `encryptForUser` (one ECIES envelope
per recipient device in `messages.ciphertext_json`); only group/channel text
uses `encryptForGroup` and the epoch keys in that table. And each row there
is itself a key wrapped to one device, openable only by that device's private
identity key. Neither table can decrypt a 1:1 message on the server.

**Why the online peer did not answer.** An asked device answered only from
its local plaintext cache. A sender whose keys survived but whose cache was
cleared (an old wipe, cleared site data) holds a readable copy on the server —
the self-envelope every send seals to the sender's own device without a
one-time key — and never looked at it. Fixed:

- `POST /api/e2ee/messages/own-envelopes` returns, for up to 200 message ids,
  only the envelope addressed to the caller's device (members only).
- `redeliverMany` answers asks from the cache first, then opens this device's
  own server copies in one batch (`openOwnServerCopies`), caches what it
  opens, and re-delivers. The socket handler and the stored-ask poll both go
  through it.
- Messages this device already failed to open are remembered for a day
  (`e2ee_unopenable_msgs`, cleared by a device reset), so reconnects and the
  poll do not refetch them. With 850 stale test asks in the table, the
  scenario went from 251 rate-limited calls and 60 s to none and 11 s.
- The "who could still answer" count now considers only devices seen in the
  last 14 days; dead device rows (old browsers, reinstalls) kept rows spinning.

`scripts/e2ee-recovery-check.cjs --mode nocache` clears the sender's
plaintext cache (keys kept), signs the reader in on a fresh device, and
asserts the message arrives from the sender's server copy.

### Old rows appeared only when a NEW message arrived (2026-09-25)

Reported on live: the old rows stayed on "Restoring…" and all appeared the
moment the peer sent a new message. That means the envelopes were already on
the server; only the redraw was missing. Three client gaps can produce it:

- `loadMessages` (useCoLab0) returned early whenever a load was running —
  **even for a forced reload**. A re-delivery burst sends one refresh event per
  message; the first started a reload that fetched the thread mid-burst, and
  every later forced reload was dropped. Forced reloads that arrive during a
  load are now queued and run once when it finishes (`pendingForceReloadRef`;
  `loadingNowRef` closes the one-render lag of the status ref).
- `onRedelivered` refreshed once per message. It now coalesces a burst per
  conversation and refreshes 1.5 s after the last event.
- The 90 s pending-row safety net (useCoLab1) stopped for good after five
  tries. It now keeps checking every ~7.5 min after that.

Locally a 25-message burst passed before and after the change (a short local
reload finishes before the burst does), so this is a fix for a proven race,
not a reproduction of the live timing. `--mode burst` in the check script
exercises it.

### Password users vs SSO users (2026-09-25)

Password sign-ins run extra E2EE code that SSO sign-ins never touch
(`ensurePasswordBackup`, the password wrap, the Unlock banner). Two defects
lived only there:

- **Unlock never worked.** `E2EERestoreBanner` read the session token from
  `localStorage["token"]`; the app stores it as `clb_token`, so every Unlock
  attempt failed with "Authentication token missing". The banner is only shown
  for backups with a password/passphrase wrap — i.e. password users. It now
  uses the token E2EE runs with (`getE2EEToken()`), falling back to `clb_token`.
- **A password sign-in could shrink the backup.** When the device held the
  backup key but not the secret (any device enrolled before the secret was
  stored locally) and no current password wrap existed, `ensurePasswordBackup`
  fell through to `createBackupWithPasswordWrap`, which minted a new secret and
  REPLACED the backup with only what that one device could read. Now a
  populated backup is rotated only by a device whose key opens it, and its
  existing entries are merged into the new backup; a device that cannot open
  it leaves it untouched. Verified: a device with key kept, secret and cache
  cleared and no password wrap signed in with its password; the backup was
  rotated (new password wrap, new version) and kept its full size (19 200 →
  19 200 bytes) instead of collapsing to that device's own envelopes.

`scripts/e2ee-user-health.sql` (read-only) lists every user with login type,
active/total devices, backup presence and size, wrap kinds, account key and
open re-delivery asks, plus a per-type summary — the way to confirm on live
whether password users are the ones stuck.

**Answer retries.** When a device holds the plaintext for a stored ask but
cannot deliver it (throttled, a blip, the peer's key bundle unreachable), it
now retries after 30 s, 60 s, 2 min and 4 min (`scheduleRedeliveryRetry`)
instead of waiting for the 10-minute poll.

**Test note.** A burst "failure" under heavy load turned out to be the test:
25 rapid sends from an account whose chat partner had 17 automation devices
exceeded the per-user API limit, so the last sends were refused while the
sender's optimistic bubbles still appeared. The check now paces sends and
only expects the messages the original reader actually received; with the
same load every delivered message was restored.
