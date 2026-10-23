# Collab Mobile ↔ Backend — Push Notification Integration

**Hand-off, verification results and change requests for the backend team**

| | |
|---|---|
| Date | 2026-09-22 (rev. 2 — adds the on-device results from UAT) |
| From | Collab mobile (Flutter, Android + iOS) |
| Mobile code reviewed | `Collab_mobile` branch `feature/fcm-push-from-fcmintegration` (7 commits on top of `develop`, plus the 22 Sep fixes in §7) |
| Backend code reviewed | `UAT/CoLab` checkout — `backend/app/src/services/{mobilePushService,fcmService,apnsVoipService}.ts`, `routes/push.ts`, `realtime/{socket,notify}.ts`, `database/migrations/0124_push_devices.sql`, `config/src/index.ts`, `docs/MOBILE_PUSH.md`, `backend/app/test/mobile-push.test.ts` |
| Status | **Verified on a real device against UAT (22 Sep): device registration, killed-state FCM delivery, cold-start tap → chat, and encrypted shade replies all work. One visible gap remains that only the backend can close — K7 (encrypted messages arrive as "Sent a message" while the app is killed). K1/K2 still apply to the first terminated-state call.** |

---

## 0. Summary

1. The backend's mobile push layer is complete and matches what the app expects — endpoints, payload fields, FCM/APNs message shapes, VoIP payload, cancel semantics and the shared notification-id hash all line up.
2. **UAT is live for Android.** On 22 Sep a Galaxy Note 10+ registered (`channels={fcm:true, voip:false}`), received FCM pushes with the app swiped away, cold-started into the right chat on tap, and sent an encrypted reply from the shade. §4 has the details. The iOS leg (APNs alert + VoIP) is still unexercised — it needs an iOS tester with a dev build.
3. **What testers see wrong today, and who owns it** (§6):
   - **K7 · P1** — an E2EE message received while the app is killed shows **"Sent a message"** instead of its text. The push carries no ciphertext; the phone has the keys and already decrypts on every other path. One-line backend change; mobile side is done.
   - **K1 · P0 / K2 · P0** — the first terminated-state *call* on iOS (caller id in the VoIP payload) and the ring-timeout alignment on both platforms. Unchanged from rev. 1.
   - **K3 / K4 · P1** — group-call rings never retracted; device rows survive session eviction.
4. Mobile has shipped its own fixes (§7), including two found on the device on 22 Sep that were mobile's fault (avatar-less senders rendered as the app logo; a shade reply wiped the avatars). One assumption still stands: **the phone rings for 45 s, so `CALL_MISSED_MS` must stay ≤ 40 000 ms** (default 35 000).

---

## 1. How the mobile app consumes pushes

This section describes the consumer so the payload rules in §3 make sense.

### 1.1 Two transports, one presenter

While the app process is alive it listens on the socket (`message:new`, `notification:new`, `huddle:rung`, `call:*`) and renders **native** notifications itself (Android `MessagingStyle` / `CallStyle`, iOS Communication Notifications via `INSendMessageIntent`). When the process is gone, FCM / APNs carry the **same JSON payload** to the same presenters. Because both paths converge, the backend does **not** need to know whether a user is online — it may push to everyone; the app dedupes.

### 1.2 Delivery matrix

| App state | Messages — Android | Messages — iOS | 1:1 calls — Android | 1:1 calls — iOS |
|---|---|---|---|---|
| Foreground | socket → local `MessagingStyle`; FCM arrival is a no-op (tag already claimed) | socket → Communication Notification; remote APNs alert is **not drawn** (app sets `present*` false + `setForegroundNotificationPresentationOptions(alert:false)`) | socket → in-app ringing screen | same |
| Background, process alive | socket → local notification; FCM data goes to a background isolate and is deduped through a file-backed message store | socket suspended by iOS within seconds → the **APNs alert** is what the user sees | socket → CallKit full-screen UI; an FCM ring for the same call shares the same CallKit UUID → one ring | socket → CallKit; VoIP push → same UUID → one ring |
| Terminated | FCM data → background isolate → `MessagingStyle` with Reply / Mark-read (both run headless, incl. E2EE encryption of the reply) | APNs alert, enriched by the Notification Service Extension into a Communication Notification (sender avatar, group title) | FCM `call_incoming` → `CallStyle` full-screen ring from the background isolate | APNs **VoIP** → PushKit → CallKit |
| Caller hangs up / answered elsewhere / timeout | FCM `call_cancel` → ring retracted **only if the app's call cubit is idle** (a live socket-owned call is never torn down by a stale cancel) | VoIP `action: cancel` → ring retracted | | |

### 1.3 Device registration lifecycle (`PushDeviceRegistrar`)

- `POST /api/push/devices` on: every FCM token (initial + refresh), the iOS PushKit token, login, socket (re)connect, app resume.
- A signature `userId|fcmToken|voipToken|appVersion` of the last **acknowledged** registration is stored; if unchanged the app sends nothing. Expect one POST per login/app update/token rotation per device, not one per resume.
- Failure → retries at 5 s, 30 s, 2 min, 10 min, then waits for the next trigger. `401`/`403` → stops until next login.
- Token rotation → `DELETE /api/push/devices {token: <old>}` (best-effort) then `POST` with the new one.
- Sign-out → `DELETE` **before** the access token is cleared (5 s time-box), so a shared phone never rings for the previous account.
- The `channels` object in the POST response is logged at startup (`device registered (android) channels={fcm:true, voip:false}`) — the quickest way to confirm a device is reachable.

### 1.4 Dedup rules the backend can rely on

- Every notification carries a `tag` in the `colab-*` scheme (§3.2). The app claims tags synchronously; the same tag from socket + FCM = one notification.
- Message notifications key on `messageId` per conversation in a file-backed store shared across isolates.
- iOS: the app's local notification identifier equals the backend's `apns-collapse-id` (§3.8), so a remote alert and a local one for the same conversation replace each other, and opening the chat cancels both.
- Taps reported twice within 3 s (two plugins can both surface one iOS tap) navigate once.

### 1.5 Click ledger (`NotificationClickLogger`)

Every tap, CallKit accept/decline, Reply, Mark-read and Join is written to disk **before** navigation, then flushed to `POST /api/push/events` in batches of ≤ 50 (flushed on record, socket connect, app resume). Each event has a client UUID `eventId`; the server's `INSERT IGNORE` on `event_id` makes replays a no-op. Body per event:

```json
{ "eventId": "uuid-v4", "kind": "click", "platform": "android|ios",
  "source": "fcm|local|callkit", "action": "tap|accept|decline|reply|mark_read|join",
  "appState": "foreground|background|terminated", "notificationType": "<type>",
  "tag": "colab-msg-…", "conversationId": "…", "targetType": "…", "targetId": "…",
  "clickedAt": "2026-09-21T10:15:30.123Z" }
```

---

## 2. Endpoints (as implemented, `routes/push.ts`, all behind `authMiddleware`)

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/api/push/devices` | `{ platform: "android"\|"ios", token, deviceId?, appVersion?, voipToken? }` — `voipToken` absent = keep, `""`/`null` = clear | `{ id, registered: true, channels: { fcm: bool, voip: bool } }` |
| `DELETE` | `/api/push/devices` | `{ token }` (body or `?token=`) | `{ unregistered: true }` |
| `GET` | `/api/push/devices` | — | rows with `tokenHint` (last 8 chars), never full tokens |
| `POST` | `/api/push/events` | `{ events: [ …§1.5… ] }` ≤ 50, rate-limited 120/min | `{ stored, duplicates }` |
| `GET` | `/api/push/events?limit=` | — | recent rows for the user |

Table: `push_devices` (migration `0124`; unique on `token`, soft-delete via `deleted`), `push_click_events`.

---

## 3. Wire contract (verified on both sides)

### 3.1 Common payload (`MobilePushPayload` ⇄ app `PushPayload`)

| Field | Required | Populated by | App use |
|---|---|---|---|
| `title` | yes | all call sites | notification title / caller name fallback |
| `body` | | all | body / preview |
| `tag` | yes | all | dedup key + local id (§3.8) |
| `type` | yes | all | presentation kind, channel, category, routing |
| `url` | | `pushNotif` | ignored on mobile (routes by type) |
| `conversationId` | | most | thread / collapse / suppression when that chat is open |
| `targetType`, `targetId` | | most | routing (meeting, task, call id) |
| `messageId`, `senderId`, `senderName`, `senderAvatar`, `conversationKind`, `conversationTitle` | | message push (`socket.ts` ~L611) | `MessagingStyle` person/avatar, DM-vs-group title, per-conversation history |
| `callKind` (`audio`\|`video`) | | 1:1 + huddle ring | CallKit/CallStyle video flag, mic vs mic+camera permission |
| `huddle` (bool) | | huddle ring | group-call presentation |
| `reason` (`cancelled`\|`declined`\|`missed`\|`ended`) | | `sendCallCancel` | logged only |

Every field is optional on the wire; the web-push shape alone still renders.

### 3.2 Tag scheme

`colab-msg-<messageId>` · `colab-call-<callId>` · `colab-huddle-<conversationId>` · `colab-invite-<inviteId>` · `colab-<type>-<notificationId>` (everything through `pushNotif`).

### 3.3 Types the app handles

`message mention reply call_incoming call_cancel call_missed meeting_invite meeting_started meeting_reminder meeting_updated meeting_cancelled meeting_declined task_assigned task_completed task_mention task_watch task_due reminder invite invite_accepted file_shared reaction`. Unknown types render generically and route to the Chats tab.

### 3.4 Android — FCM v1 message (`buildFcmMessage`, platform `android`)

```json
{ "message": {
    "token": "<fcm token>",
    "data": { "title": "Alice", "body": "hello", "tag": "colab-msg-9f…", "type": "message",
              "conversationId": "c1", "targetType": "message", "targetId": "9f…",
              "messageId": "9f…", "senderId": "u2", "senderName": "Alice",
              "senderAvatar": "https://…", "conversationKind": "dm", "conversationTitle": "Alice" },
    "android": { "priority": "high", "ttl": "86400s",
                 "collapse_key": "colab-call-<id>"   /* calls only */ } } }
```

**Rules:** data-only, all values strings (`huddle: "true"` — the app parses `true/1`). **Never add a `notification` block for Android** — the app's Dart handler bails out when one is present and the OS draws a plain banner on the default channel instead. TTL: `FCM_MESSAGE_TTL_SEC` (24 h) / `FCM_CALL_TTL_SEC` (45 s).

### 3.5 iOS — FCM → APNs alert (platform `ios`, every type except `call_incoming` / `call_cancel` when VoIP is available)

```json
"apns": {
  "headers": { "apns-priority": "10", "apns-push-type": "alert",
               "apns-expiration": "<now+ttl>", "apns-collapse-id": "1454630857" },
  "payload": {
    "aps": { "alert": { "title": "Alice", "body": "hello" }, "sound": "default",
             "thread-id": "conv-c1", "category": "COLLAB_MESSAGE", "mutable-content": 1,
             "interruption-level": "time-sensitive"   /* meeting_started, meeting_reminder, call_incoming */ },
    "NotificationId": 1454630857, "title": "Alice",
    "presentAlert": false, "presentSound": false, "presentBadge": false, "presentBanner": false, "presentList": false,
    "payload": "<JSON of the full MobilePushPayload>" } }
```

- The `NotificationId` / `present*` / `payload` keys are the shape `flutter_local_notifications` expects in `userInfo`; they make the plugin treat the remote alert as its own, so taps and the **Reply / Mark-as-read** actions of category `COLLAB_MESSAGE` reach the app's Dart handlers with the full payload. `present*` false only affects a foreground arrival (the app is already presenting via the socket); background/terminated alerts are always drawn by the OS.
- `category` ⇄ app-registered categories: `COLLAB_MESSAGE` (Reply, Mark as read), `COLLAB_CALL`, `COLLAB_MEETING` (Join), `COLLAB_GENERIC`.
- `call_cancel` on iOS without a VoIP token is dropped (nothing to retract). With VoIP it goes out as `apns-push-type: background` `content-available: 1` — fine, the app ignores it.

### 3.6 iOS — APNs VoIP push (`buildVoipPayload` → `AppDelegate.swift`)

```json
{ "action": "ring",            // or "cancel"
  "callId": "<backend call id>", "callerName": "Alice", "callerAvatar": "https://…",
  "conversationId": "c1", "kind": "audio|video", "huddle": false, "reason": "missed" }
```

Sent to `/3/device/<voipToken>` with `apns-topic: com.resulticks.collab.voip`, `apns-push-type: voip`, `.p8` token auth (no VoIP certificate needed). The app derives the CallKit UUID as UUIDv5(URL namespace, `callId`) — identical to the Dart side, so a socket ring and a VoIP ring for the same call collapse. **Apple rule (already honoured):** every VoIP push results in a CallKit report or an `endAllCalls`; never send a VoIP push for any other purpose.

### 3.7 `call_cancel` semantics

`retractRing()` in `socket.ts` sends `call_cancel` (same `colab-call-<id>` tag) on: server missed-timeout (`CALL_MISSED_MS`, plus the stale-ringing sweep), decline on another device, caller cancel before answer, caller hang-up. The app calls `endAllCalls()` **only while its call cubit is idle** — a ring that the socket delivered and the cubit owns is ended by the socket's own `call:cancelled` / `call:missed`, never by a push.

### 3.8 Shared notification ids (must stay byte-identical on both sides)

FNV-1a 32-bit over the key, masked to a positive Java int:

| Key | Value | Pinned in |
|---|---|---|
| `conv:abc` | `1454630857` | `mobile-push.test.ts` L56 / `test/push_payload_contract_test.dart` L15 |
| `colab-msg-1` | `1987154032` | same |
| `colab-call-test-call-123` | `1940074718` | same |
| `colab-huddle-c1` | `1619455312` | same |

Rule: `message` / `mention` / `reply` with a `conversationId` → `stableId("conv:<conversationId>")` (one alert per conversation); everything else → `stableId(tag)`.

### 3.9 Configuration (`config/src/index.ts`)

| Env | Default | Notes |
|---|---|---|
| `FCM_SERVICE_ACCOUNT_JSON` / `FCM_SERVICE_ACCOUNT_FILE` | — | Firebase **service account** for project `collab-7531d` (the one behind the app's `google-services.json` / `GoogleService-Info.plist`). Base64 or raw JSON; `\n` in the PEM is un-escaped. |
| `FCM_PROJECT_ID` | from the JSON | |
| `FCM_MESSAGE_TTL_SEC` / `FCM_CALL_TTL_SEC` | 86400 / 45 | |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8` / `APNS_KEY_FILE` | — | APNs Auth Key (.p8). Also upload the same key in Firebase → Cloud Messaging → APNs for the iOS alert leg. |
| `APNS_BUNDLE_ID` | `com.resulticks.collab` | |
| `APNS_ENVIRONMENT` | `sandbox` unless `NODE_ENV=production` | **`sandbox`** for Xcode / development-profile builds, **`production`** for TestFlight / App Store. A mismatch = `400 BadDeviceToken` and the token is forgotten. |
| `CALL_MISSED_MS` | 35000 | See K2 — keep ≤ 40000. |

---

## 4. Verification performed

| Check | Result |
|---|---|
| Endpoints `POST/DELETE/GET /devices`, `POST/GET /events` | ✅ present, auth-gated, idempotent, tokens never echoed |
| `db.pushDevices.*`, `db.pushClickEvents.*`, migration `0124` | ✅ present (MySQL + JSON drivers) |
| FCM v1 sender (JWT-bearer OAuth, `UNREGISTERED`/404 → forget token) | ✅ |
| APNs VoIP sender (HTTP/2, `.p8` ES256, 410 / `BadDeviceToken` → forget) | ✅ |
| Fan-out reaches every existing push call site with the existing quiet-hours / `notifyLevel` / per-conversation-mute gates | ✅ (`webPushService.sendToUsers` → `mobilePush.sendToUsers`) |
| Message enrichment fields | ✅ `socket.ts` ~L611 |
| Call enrichment (`callKind`, `senderId/Name/Avatar`) | ✅ 1:1 (~L855) and huddle (~L1145, `huddle: true`) |
| `call_cancel` on missed / declined / cancelled / ended | ✅ `retractRing` at ~L881, 963, 1016, 1044, 1475 |
| FNV-1a vectors | ✅ identical in both test files |
| iOS category / thread-id / userInfo shape | ✅ matches the app's registered categories and `threadIdentifier: conv-<id>` |
| Compose forwards `FCM_*` / `APNS_*` from `.env.live` | ✅ `docker-compose.live.yml` L234–245 |
| Backend test `mobile-push.test.ts` | ⚠️ could not run (no `node_modules` in the checkout) — please run in CI |
| Mobile test suite | ✅ 748/748, `flutter analyze` clean |
| Live UAT / prod probe | ⚠️ inconclusive: `/api/push/*` returns 401 for every path (router-level auth), so route presence can't be confirmed unauthenticated |

### 4.1 On-device, against UAT (22 Sep 2026 — Samsung Galaxy Note 10+, Android 12, debug build, account `u_v_keerthivasan_resulticksmail_com`)

| What | Observed | Verdict |
|---|---|---|
| `POST /api/push/devices` on login | `device registered (android) channels={fcm: true, voip: false}` | ✅ FCM configured on UAT |
| Killed-state DM (app swiped away 14:14:18) | `Start proc … FlutterFirebaseMessagingReceiver` at 14:15:07, MessagingStyle notification with Reply / Mark as read | ✅ FCM leg works end to end |
| Tap on that notification (cold start) | Process started, Rajaram's chat opened directly with history loaded | ✅ |
| Reply from the shade, app killed | `sendReply … posting reply encrypted=true … ok=true`; reply visible on the web | ✅ E2EE works in the background isolate |
| Body of the received E2EE message | **"Sent a message"** — the push has `body` only, no `ciphertext` | ❌ **K7** |
| Sender without a photo | App logo in the shade (mobile bug, fixed: initials disc, §7) | ✅ mobile |
| Socket path with the app alive (foreground / background) | All of: sender + preview + group title, stacking per chat, tap → correct chat / replace / Back → Chats, Mark-as-read, mentions-only + quiet-hours gates, voice/video ring with Decline, caller cancel → ring retracted, 45 s ring-out with no `call:decline` and no duplicate missed-call | ✅ (driven with synthetic socket packets — `tool/push/README.md`) |
| Not exercised | iOS entirely; Answer → LiveKit join; huddle ring; anything needing a second real caller | — |

---

## 5. UAT enablement checklist (ops)

1. `.env.live` on the UAT host: `FCM_SERVICE_ACCOUNT_JSON` (or `_FILE`), `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8` (or `_FILE`), `APNS_ENVIRONMENT=sandbox` (while testers use dev-profile builds).
2. Migration `database/migrations/0124_push_devices.sql` applied.
3. Firebase console → project `collab-7531d` → Cloud Messaging → APNs auth key uploaded (needed for the iOS **alert** leg; the VoIP leg uses the key from the env directly).
4. Backend boot log must show:
   ```
   [fcm] configured — mobile push enabled (project collab-7531d)
   [apns] VoIP push configured (sandbox, topic com.resulticks.collab.voip)
   [mobile-push] enabled — fcm=true apnsVoip=true
   ```
   Anything else means the env isn't reaching the container.
5. On a phone: log in, watch for `PushDeviceRegistrar: device registered (ios) channels={fcm:true, voip:true}` (Android: `voip:false`). `GET /api/push/devices` should list the row. *(Android: confirmed on UAT 22 Sep.)*
6. Smoke test without the app open: kill the app, send a DM from the web → Android shows a `MessagingStyle` notification; iOS shows an alert. Place a 1:1 call → Android full-screen ring; iOS CallKit ring. Hang up before answer → ring disappears on both. *(Android DM leg: confirmed 22 Sep; the body is generic until K7.)*
7. Failure triage: `[mobile-push] fcm failed user=… : 404 UNREGISTERED` = stale token (auto-forgotten); `[mobile-push] apns voip failed … 400 BadDeviceToken` = `APNS_ENVIRONMENT` mismatch or wrong team/bundle; `403 InvalidProviderToken` = wrong `APNS_KEY_ID`/`TEAM_ID`.

---

## 6. Backend change requests

Priority: **P0** = testers hit it in the first session · **P1** = visible in normal use · **P2** = quality.

### K1 · P0 · Add `callerId` to the VoIP payload

- **Symptom:** an iOS user who accepts a call from CallKit while the app was terminated gets an in-call screen with no caller identity until `call:accepted` arrives; the app's accept bridge needs the caller's user id up front.
- **Cause:** `buildVoipPayload` (`mobilePushService.ts` ~L156) forwards `senderName`/`senderAvatar` but not `senderId`, which the call site already supplies.
- **Change:**
  ```ts
  ...(p.senderId ? { callerId: p.senderId } : {}),
  ```
- Mobile side: the AppDelegate will read `callerId` when present (shipping in mobile Phase 1) and otherwise fall back to `call.initiatorId` from `call:accepted`.

### K2 · P0 · Ring timeout alignment (and a decision on missed calls)

- **Symptom today:** the phone's native ring is 30 s, `CALL_MISSED_MS` is 35 s. On a backgrounded phone the plugin times out first and the app currently reports `call:decline(reason: "timeout")`, so the server records the call as **declined** — the caller sees "Call declined" and no `call_missed` notification is generated. When the server does win, the user gets **two** missed-call notifications (the plugin's own + the server's `call_missed`).
- **Mobile is changing:** ring → **45 s** on all three presenters, plugin missed-call notification **off**, native timeout no longer sends `call:decline`. The server's `call_missed` becomes the single source of the missed-call notification.
- **Backend asks:**
  1. Keep `CALL_MISSED_MS` **≤ 40 000** in every environment and tell mobile before changing it (the phone must out-ring the server).
  2. **Decision needed:** `call_missed` goes through `pushNotif` → `suppressWebPush` → quiet hours / `notifyLevel: none`. After the mobile change, a user in quiet hours will get **no** missed-call notification at all (today the plugin's own one still appeared). This matches web behaviour; if product wants missed calls exempt from quiet hours, bypass the gate for `type === "call_missed"` in `notify.ts` ~L169.

### K3 · P1 · Retract group-call (huddle) rings

- **Symptom:** a terminated phone rings for the full duration and posts "Missed call" for a group call the user joined from desktop or that already ended.
- **Cause:** `retractRing` is wired only for 1:1 calls; `HUDDLE_JOIN` / `HUDDLE_LEAVE` / `HUDDLE_STATE` send nothing to phones.
- **Change:** on `HUDDLE_JOIN` by the rung user (answered elsewhere) and when a huddle ends, call
  ```ts
  mobilePush.sendToUsers([userId], { title: "Call ended", type: "call_cancel",
    tag: `colab-huddle-${conversationId}`, conversationId, huddle: true, reason: "ended" });
  ```
  On iOS this must still go out as a VoIP `cancel` (already handled by `deliver()` since `type` is `call_cancel`).
- Mobile mitigation meanwhile: Android will present push-delivered huddle rings as a full-screen **notification** (like the socket path) instead of a CallKit ring, so there is nothing to retract; iOS keeps CallKit (Apple rule) with no missed notification.

### K4 · P1 · Remove device rows when a session ends server-side

- **Symptom:** after `/sessions/evict`, a session revoke, or account deletion, the phone keeps receiving pushes for a dead session (every action then 401s).
- **Cause:** `db.pushDevices.removeForUser` exists (`mysql.ts` ~L7892) but nothing calls it; `push_devices` has no link to the session, so `disconnectSession()` can't target the right row. `/logout` is fine — the app DELETEs its own token first.
- **Change:** store `req.user.jti` on the row at `POST /devices` (new nullable `session_jti` column); delete by jti wherever a session is revoked/evicted; call `removeForUser` on account soft-delete (the FK cascade doesn't fire for soft deletes). Also consider a nightly sweep of rows whose `last_seen_at` is > 60 days.

### K5 · P1 · `aps.badge` on iOS alerts

- **Symptom:** the iOS app icon badge never increments while the app is terminated (no code runs for a remote alert). The app can only manage the badge while alive.
- **Change:** in `buildFcmMessage` set `aps.badge` = unread-conversation count for the recipient (the value already exists for the web sidebar). Omit for `call_*` and `meeting_*` if the count is expensive; messages are what matter.

### K6 · P2 · REST accept/decline for direct calls

- **Symptom:** declining a killed-state ring on Android can't reach the server (no socket in the background isolate); the caller hears ringback until `CALL_MISSED_MS`.
- **Change:** `POST /api/calls/direct/:callId/decline` (and `/accept` for symmetry) mirroring the `CALL_DECLINE` socket handler (~L954), incl. `retractRing`. `routes/calls.ts` already has `direct/:callId/controls/*` to copy from.

### K7 · P1 · `ciphertext` in encrypted-message pushes (enables E2EE previews)

- **Symptom (seen on UAT, 22 Sep):** with the app killed, an encrypted DM arrives as "Rajaram — Sent a message". The body is generic because the server cannot read E2EE content (correct), but the phone *can* — the notification handler already restores this device's keys without any network call (the shade-reply path does the same) — it just never receives the ciphertext.
- **Mobile is ready:** the Android background handler and the in-app FCM handler now decrypt `data.ciphertext` when present and show the real text (file/voice messages show their caption, else the push body). Absent, undecryptable, or malformed → the generic body stands; nothing leaks and nothing errors.
- **Change:** in `socket.ts` (~L613, the closed-tab message push) add to `enrich` for `encrypted` messages:
  ```ts
  ...(encrypted && ciphertext ? { ciphertext: JSON.stringify(ciphertext) } : {}),
  ```
  where `ciphertext` is exactly what the `message:new` socket event carries (the per-device envelope list for DMs, the shared group envelope for groups). For a DM, filter the list to the **recipient's** devices before serialising — the sender's own envelopes are dead weight. Skip the field when the `data` map would exceed ~3.5 KB (FCM/APNs limit is 4 KB); the phone falls back to "Sent a message". Also carry `encrypted: "true"` so the app can tell the cases apart in its click ledger.
- iOS: same field in the APNs `payload` JSON; the Notification Service Extension can adopt it later — until then the alert body is what iOS shows.

### K7b · Nit · `senderColor` / `senderInitials` in the message enrichment

- Users without a photo (`avatarUrl: null`) used to render as the app logo in the shade. The app now draws the same initials-on-colour disc as its lists: for a DM it takes the peer's colour/initials from its cached conversation row; for a **group** sender that colour is not cached on the phone, so it hashes one from the user id. Adding `senderColor` (`#0891B2`) and `senderInitials` to `enrich` would make group senders match the app exactly. Optional; the app ignores unknown keys today and will prefer these when present.

### K8 · P2 · Attachment preview hints

- Message push body uses stripped `text` or "Sent a message"; the app's socket path shows `📎 <file name>` / `🎤 Voice message` / `📅 Meeting`. Mirror that at `socket.ts` ~L608 so terminated-state previews match.

### K9 · P2 · Honour "Do not disturb" on the push path

- **Symptom:** a user whose status is Do not disturb gets no in-app / socket-path notifications (web `dispatchNotif.shouldPush`, and now the mobile app) but still receives every push while the app is terminated.
- **Cause:** `suppressWebPush` (`notify.ts` ~L104) checks `notifyLevel` and quiet hours but not `users.manualPresence`.
- **Change:** `if ((await db.users.getById(userId))?.manualPresence === "dnd") return true;` alongside the quiet-hours check (the user row is already loaded there when quiet hours is on). Rings stay exempt, as today.

### Nits (no action required unless convenient)

- `thread-id` for notifications **without** a `conversationId`: backend `collab-<type>` (e.g. `collab-meeting_started`) vs app `collab-<kind>` (`collab-meeting`) → separate iOS threads for a remote vs local meeting alert. Harmless.
- A `settings:updated` socket event would let the app refresh notification preferences without polling `GET /api/settings` (mobile is adding the polling in Phase 3).

---

## 7. What mobile is changing independently (FYI — no backend action)

| Phase | Change | Backend interaction |
|---|---|---|
| 1 | Ring 45 s, plugin missed notification off, native timeout ≠ decline | **Assumes `CALL_MISSED_MS` ≤ 40 s (K2)** |
| 1 | AppDelegate forwards `callerName` / `callerAvatar` / `kind` (and `callerId` when K1 lands) into CallKit | K1 |
| 1 | Late PushKit token registration (`DidUpdateDevicePushTokenVoip`) | more `POST /devices` with `voipToken` after login — idempotent |
| 1 | Android: push-delivered huddle ring → full-screen notification instead of CallKit | K3 mitigation |
| 2 | Logout: stop coordinator, cancel all notifications, clear local history, badge 0 | the existing `DELETE /devices` stays |
| 2 | Notification-permission recovery UI; Android 14 full-screen-intent prompt | — |
| 3 | Apply `GET /api/settings` (`notifyLevel`, `quietHours`, `quietStart/End`, `notifSound`, `notifBadge`) on the socket path, same rules as `suppressWebPush`; a Settings → Notifications screen writing `PUT /api/settings` | polls `/api/settings` on start/resume/10 min |
| 4 | Badge = unread total while alive (gated on `notifBadge`); iOS Notification Service Extension (`com.resulticks.collab.NotificationService`) turns remote message alerts into Communication Notifications using the `mutable-content: 1`, `payload`, `senderAvatar` and `conversationTitle` you already send | K5 (badge while terminated), K7 (E2EE bodies) |
| 22 Sep | **E2EE previews from pushes:** every presenter (socket, in-app FCM, background FCM isolate) decrypts `data.ciphertext` when present and shows the real text; malformed / undecryptable → "Sent a message" | **K7** — the field just has to be sent |
| 22 Sep | **Sender avatars:** users without a photo get the same initials-on-colour disc as the app's lists (from the event's `initials`/`color`, else the cached DM peer, else name + hashed colour); discs pre-rendered to disk so the killed-state isolates only read a file; every face in a thread — including "You" — is resolved on every (re)post, so a shade reply no longer wipes them | K7b (nit) — `senderColor`/`senderInitials` would make group senders exact |
| 22 Sep | Android group summary kept while ≥ 1 thread remains (cancelling it at "one left" made Android delete the last chat's notification too); per-isolate temp files for the shade-history store; store reconciled against the live shade on start/resume | — |
| 22 Sep | Call type ("Incoming voice/video call") shown under the caller's name; notification-permission banner fixed (unreadable button) and now deep-links to the app's notification toggle | — |

---

## 8. Joint QA matrix

Run after §5 is green. Each cell: notification shown? correct style? tap lands correctly? ring retracted? one entry, not two?

Android column: ✅ = validated 22 Sep on Android 12 (UAT); blank = still to run.

| Scenario | Android 13 / 14 / 15 | iOS 15 / 17 / 18 |
|---|---|---|
| DM · foreground / background / killed / **force-quit** | ✅ fg / bg / killed (body generic until K7) | |
| Group message · same four states | ✅ fg / bg (socket) | |
| @mention in a muted group (must still notify) | | |
| 1:1 audio call · background / killed / force-quit | | |
| 1:1 video call (camera permission path) | | |
| Caller cancels before answer → ring gone | ✅ (socket) | |
| Answered on desktop → phone ring gone | | |
| Unanswered → exactly one "Missed call" | ✅ ring-out at 45 s, no decline sent, no plugin missed-call (server's `call_missed` not tested — synthetic call) | |
| Group-call ring · killed | | |
| Reply from the shade (plain + E2EE DM) | ✅ E2EE DM, app killed | |
| Mark as read from the shade → web unread cleared | ✅ (`POST …/read` 200) | |
| Tap on cold start lands in the right chat / Calls tab | ✅ chat (killed-state DM) | |
| Token rotation (reinstall) → old row gone | | |
| Sign-out → no further pushes | | |
| Quiet hours on → no message pushes, calls still ring | ✅ (socket path) | |

Note: iOS **force-quit** (swipe-up) stops FCM data/background delivery by design; VoIP pushes and APNs alerts still arrive.

---

## 9. Open questions for the backend team

1. Which environments have the FCM / APNs env vars today (UAT? prod?), and who owns the Firebase service account and the APNs `.p8` key?
2. Decision on K2.2 — should `call_missed` bypass quiet hours?
3. Is `CALL_MISSED_MS` overridden anywhere from the 35 s default?
4. For K4 — is `session_jti` on `push_devices` acceptable, or is there an existing sessions↔devices mapping we should reuse?
5. Any objection to the app polling `GET /api/settings` every 10 min while in the foreground (Phase 3), or should we wait for a `settings:updated` event?
6. For K7 — how large is a DM envelope per device on UAT today? If a recipient with several devices routinely pushes the `data` map past 4 KB, we'd rather the backend send the ciphertext for the **target device only** (the row in `push_devices` already identifies it) than drop the field.

---

## Appendix A — Example payloads per type (the `data` map / logical payload)

```jsonc
// message (DM)
{ "title": "Alice", "body": "See you at 3", "tag": "colab-msg-m1", "type": "message",
  "conversationId": "c1", "targetType": "message", "targetId": "m1",
  "messageId": "m1", "senderId": "u2", "senderName": "Alice", "senderAvatar": "https://…/a.png",
  "conversationKind": "dm", "conversationTitle": "Alice" }

// message (E2EE DM) — after K7. body stays generic; the app decrypts `ciphertext`.
{ "title": "Alice", "body": "Sent a message", "tag": "colab-msg-m2", "type": "message",
  "conversationId": "c1", "targetType": "message", "targetId": "m2",
  "messageId": "m2", "senderId": "u2", "senderName": "Alice",
  "conversationKind": "dm", "conversationTitle": "Alice",
  "encrypted": "true",
  "ciphertext": "[{\"deviceId\":\"d-recipient\",\"ek\":\"…\",\"iv\":\"…\",\"ct\":\"…\"}]",   // JSON string of the socket envelope, recipient's devices only
  "senderInitials": "A", "senderColor": "#0891B2" }                                       // K7b, optional

// mention (from pushNotif — no enrichment today)
{ "title": "Alice mentioned you in Design", "body": "@you can you check…", "tag": "colab-mention-n7",
  "type": "mention", "url": "/chat/c9", "conversationId": "c9", "targetType": "message", "targetId": "m8" }

// 1:1 call ring
{ "title": "Alice is calling", "body": "Tap to answer", "tag": "colab-call-k1", "type": "call_incoming",
  "conversationId": "c1", "targetType": "call", "targetId": "k1",
  "callKind": "video", "senderId": "u2", "senderName": "Alice", "senderAvatar": "https://…/a.png" }

// group-call (huddle) ring
{ "title": "Alice is calling", "body": "Group call — tap to join", "tag": "colab-huddle-c9",
  "type": "call_incoming", "conversationId": "c9", "huddle": true, "callKind": "audio",
  "senderId": "u2", "senderName": "Alice" }

// ring retraction
{ "title": "Call ended", "tag": "colab-call-k1", "type": "call_cancel", "conversationId": "c1",
  "targetType": "call", "targetId": "k1", "reason": "cancelled" }

// missed call (from pushNotif)
{ "title": "Missed call from Alice", "tag": "colab-call_missed-n9", "type": "call_missed",
  "conversationId": "c1", "targetType": "call", "targetId": "k1" }

// meeting started
{ "title": "Sprint review started", "body": "Tap to join", "tag": "colab-meeting_started-n3",
  "type": "meeting_started", "targetType": "meeting", "targetId": "mt5" }
```

## Appendix B — File index

**Backend (`UAT/CoLab`)**
`backend/app/src/routes/push.ts` · `services/mobilePushService.ts` · `services/fcmService.ts` · `services/apnsVoipService.ts` · `services/webPushService.ts` (fan-out) · `realtime/socket.ts` (`retractRing`, message ~L585–640, 1:1 call ~L845–880, huddle ~L1126–1160, `CALL_DECLINE` ~L954) · `realtime/notify.ts` (`pushNotif` ~L150, `suppressWebPush` ~L104) · `database/migrations/0124_push_devices.sql` · `database/src/drivers/mysql.ts` ~L7846–7935 · `config/src/index.ts` L179, L337–363 · `docs/MOBILE_PUSH.md` · `backend/app/test/mobile-push.test.ts` · `.env.example` L250–272 · `docker-compose.live.yml` L234–245

**Mobile (`Collab_mobile`)**
`lib/features/notifications/data/services/push/` — `push_payload.dart` (contract, ids), `fcm_service.dart` (background handler, CallStyle ring), `push_coordinator.dart` (orchestration, cancel/accept bridge), `push_device_registrar.dart`, `notification_click_logger.dart`, `notification_tap_router.dart`, `local_notification_service.dart` (channels `collab_messages_v2` / `collab_calls_v2` / `collab_meetings_v1` / `collab_general_v1`, iOS categories) · `lib/features/active_call/presentation/cubit/active_call_cubit.dart` (`acceptFromPush`) · `lib/features/active_call/data/services/callkit_service.dart` · `ios/Runner/AppDelegate.swift` (PushKit → CallKit, communication notifications) · `android/app/src/main/AndroidManifest.xml` · `MOBILE_PUSH_NOTIFICATIONS.md` (mobile-side design doc) · tests `test/push_payload_contract_test.dart`, `test/push_device_registrar_test.dart`, `test/notification_click_logger_test.dart`
