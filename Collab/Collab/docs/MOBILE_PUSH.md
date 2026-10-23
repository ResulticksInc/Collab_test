# Mobile push (Collab_mobile — Android + iOS)

How the backend reaches the Flutter app when it is **backgrounded or
terminated** (the socket only covers a live process), and how the app reports
notification taps back.

## Flow

```
 socket.io  ──────────────────────────────►  app alive: in-app + native notification
 webPush.sendToUser(s) ─┬─► VAPID ──────────►  browsers (unchanged)
                        └─► mobilePushService
                               ├─ FCM HTTP v1 ─► Android (data-only, app renders)
                               │               ► iOS alert (OS renders; taps → app)
                               └─ APNs VoIP ───► iOS incoming call → CallKit ring
```

Every existing `sendToUser(s)` call site (messages, mentions/replies via
`pushNotif`, calls, huddle rings, invites, reminders, tasks, meetings) reaches
phones with **no call-site change**: `webPushService.sendToUsers` fans out to
`mobilePushService.sendToUsers` after the same quiet-hours / notify-level /
per-conversation-mute gates. `isReady()` is true when *either* channel is
configured, so a deployment without VAPID keys still pushes to phones.

Two mobile-only additions live in `realtime/socket.ts`:

- `sendCallCancel(peerId, call, reason)` on `call:cancel`, `call:decline`,
  hang-up-while-ringing and the two missed-call timeouts, so a native ring
  raised by push is retracted when the caller gives up or the call is handled
  on another device (the terminated phone has no socket to hear `call:*`).
- Call and message payloads carry optional enrichment (`callKind`, `senderId`,
  `senderName`, `senderAvatar`, `conversationKind`, `conversationTitle`,
  `messageId`, `huddle`). The web service worker ignores these.

## Endpoints (all under `/api/push`, auth required)

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/devices` | `{ platform: "android"\|"ios", token, voipToken?, deviceId?, appVersion? }` | Register / refresh an FCM token (+ PushKit token on iOS). Idempotent on `token`; omit `voipToken` to keep the stored one, send `null` to clear. Response `channels: { fcm, voip }` tells the app what can reach it. |
| DELETE | `/devices` | `{ token }` | Sign-out: stop pushing to this install (a shared phone must not ring for the previous account). |
| GET | `/devices` | — | The caller's registrations (token hints only). |
| POST | `/events` | `{ events: [{ eventId, kind: "click", notificationType, tag, conversationId?, targetType?, targetId?, source, appState, action, clickedAt, platform }] }` | Notification click ledger. **Idempotent on `eventId`** — the app queues on disk and retries, so replays are a no-op. Also bumps the aggregated counter `push.click.<type>` (telemetry_events). |
| GET | `/events` | — | The caller's recent click events. |

Calls (under `/api/calls`, auth required) — for a phone with no socket
(killed-state shade / CallKit action on Android):

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/direct/:callId/accept` | — | Mirror of the `call:accept` socket event: marks the call connected, emits `call:accepted` to both parties, retracts the ring on the callee's other phones. Callee only (403 otherwise; 409 if not ringing). |
| POST | `/direct/:callId/decline` | `{ reason? }` | Mirror of `call:decline`: emits `call:declined`, retracts the ring, posts the call-log line. The caller stops hearing ringback immediately instead of at `CALL_MISSED_MS`. |

Tables: `push_devices`, `push_click_events` (migration `0124`); `0125` adds
`push_devices.session_jti`. Both are global (no `organization_id`), like
`push_subscriptions`.

`POST /devices` records the caller's session id (`jti`) on the row. When that
session ends server-side — revoke, "sign out other sessions", admin evict,
idle/expiry GC, logout, account deletion, admin password reset — the row is
retired (`pushDevices.removeBySession` / `removeForUser`), so a phone never
keeps receiving pushes for a session it can only 401 on. A daily sweep
(inside the session GC) retires rows not seen for `PUSH_DEVICE_STALE_DAYS`
(default 60).

## Wire contract with the app

Per device, `mobilePushService.buildFcmMessage` produces:

- **Android**: `data` only (every value a string), `android.priority: high`,
  `ttl` = `FCM_MESSAGE_TTL_SEC` (calls: `FCM_CALL_TTL_SEC`, plus a
  `collapse_key` per call). The app's background isolate renders
  MessagingStyle / CallStyle notifications itself; a `notification` block
  would make the OS draw a plain banner and the Dart handler bail out.
- **iOS**: the same `data` plus an APNs alert (`aps.alert`, `sound`,
  `thread-id: conv-<conversationId>`, `category: COLLAB_MESSAGE|COLLAB_CALL|
  COLLAB_MEETING|COLLAB_GENERIC`, `mutable-content`, time-sensitive for
  `meeting_started`/`meeting_reminder`) and `apns-collapse-id` = the **same
  FNV-1a id the app uses for its local notification** (`stableId`, pinned by
  shared vectors in `backend/app/test/mobile-push.test.ts` and
  `Collab_mobile/test/push_payload_test.dart`), so opening the chat clears the
  remote alert too. Extra top-level keys (`NotificationId`, `present*`,
  `payload`) mimic flutter_local_notifications' userInfo shape so that plugin
  routes taps and Reply / Mark-as-read actions to the app's existing Dart
  handlers with the full payload; `present*` are false so a foreground arrival
  is not drawn by the OS (the socket path presents while the app is open).
  `call_cancel` on iOS is a silent `background` push.
- **iOS calls** (`call_incoming`, `call_cancel`) go to APNs directly as a VoIP
  push when the device has a PushKit token and APNs is configured:
  `{ action: ring|cancel, callId, callerName, callerAvatar?, conversationId?,
  kind: audio|video, huddle, reason? }` (see `AppDelegate.swift`). Without
  APNs config they fall back to an FCM alert (no CallKit ring while
  terminated).

- **iOS badge** (`aps.badge`): message-class alerts carry the recipient's
  unread-conversation count (`db.conversations.unreadConversationCount`, the
  sidebar's dot count, muted chats excluded) so a terminated app's icon badge
  stays honest. Calls and meetings leave the badge alone.

Dead tokens are pruned on `UNREGISTERED` / 404 (FCM) and 410 /
`BadDeviceToken` (APNs).

### Message push enrichment (`realtime/socket.ts`)

Every closed-app message push carries, besides the web-push shape:
`messageId`, `senderId`, `senderName`, `senderAvatar`, `senderInitials`,
`senderColor` (initials-on-colour disc for photo-less senders, exact for
group senders the phone hasn't cached), `conversationKind`,
`conversationTitle`.

- **Preview** (`pushPreview`): stripped text, else `📎 <file name>` /
  `🎤 Voice message` / `📅 Meeting` — the same hints the app shows on the
  socket path. Encrypted messages stay `Sent a message`.
- **E2EE body is plain text** (product decision, 22 Sep 2026): the server
  has no plaintext for an encrypted message, so the **sending client**
  attaches `pushPreview` (≤140 chars, tags stripped; caption / `📎 name` /
  `🎤 Voice message` for attachments — `frontend/app/src/lib/pushPreview.ts`)
  to `MESSAGE_SEND` and `POST /conversations/:id/messages`. The server
  sanitises it again (`sanitizePushPreview`) and uses it **only** as the push
  `body`: it is never persisted, never in `message:new`, never in the debug
  ledger. Missing (older client, mobile app until it adds the field) →
  "Sent a message". Gate: `PUSH_E2EE_PLAINTEXT_PREVIEW` (default on).
  **Mobile app: send `pushPreview` alongside `encrypted` on both send paths**
  so messages sent from a phone get a readable body on the other phone.
- **E2EE** (`e2eePushFields`): an encrypted message always pushes
  `encrypted: "true"`.
  With `PUSH_E2EE_CIPHERTEXT` on (the default; set `false` to disable) the
  push also carries `ciphertext` = the JSON of exactly what
  `message:new` carries — for a DM only the **recipient's** device envelopes
  (the sender's are dead weight), for a group the shared envelope. The server
  never reads it; the phone holds the keys and decrypts in its handlers so a
  killed app shows the real text. `mobilePushService.fitDataMap` drops
  `ciphertext` (only that field) when the FCM `data` map would exceed
  3.5 KB (the 4 KB wire limit) — the phone then falls back to the generic
  body. The iOS `payload` JSON mirrors the trimmed map.

### Rings and retractions

- 1:1 calls: `retractRing` sends `call_cancel` (tag `colab-call-<id>`) on
  missed timeout, decline / **accept** on another device (`reason:
  answered`), caller cancel and caller hang-up. The VoIP `ring` payload
  carries `callerId` (the caller's user id) so CallKit's accept bridge has
  the identity before `call:accepted` arrives.
- Group calls (huddles): `HUDDLE_RING` records every rung user
  (`huddleStore.huddleRung*`, Redis-backed when configured). When a rung user
  joins from any device, or the huddle empties, they get `call_cancel` on
  `colab-huddle-<conversationId>` (`huddle: true`, `reason: ended`) — on iOS
  a VoIP `cancel`. A terminated phone therefore no longer rings out and posts
  "Missed call" for a group call answered on desktop or already over.
- `CALL_MISSED_MS` is **clamped to 40 000 ms** (phones ring for 45 s and must
  out-ring the server; a higher value is logged and ignored).
  `CALL_MISSED_BYPASS_QUIET_HOURS=true` lets the server's `call_missed`
  notification (now the phone's only missed-call signal) bypass quiet hours
  on the push path; default off = same as web.

### Suppression on the push path

`notify.suppressWebPush` gates every closed-app push except rings:
`notifyLevel: none`, `mentions` (plain messages only), quiet hours in the
recipient's zone, per-conversation mute (applied at the call site) and the
user's **Do not disturb** status (`users.manualPresence === "dnd"`).

## Configuration

See `.env.example` (section "Mobile push"): `FCM_SERVICE_ACCOUNT_JSON` or
`FCM_SERVICE_ACCOUNT_FILE` (Firebase service account for the project that
owns the app's `google-services.json` / `GoogleService-Info.plist`);
`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`/`APNS_KEY_FILE`,
`APNS_BUNDLE_ID`, `APNS_ENVIRONMENT` (sandbox for Xcode/dev-profile builds).
No new npm dependency: FCM v1 is an OAuth2 JWT-bearer grant signed with
`jsonwebtoken` + `fetch`; APNs is Node's `http2` with an ES256 provider
token.

Boot logs: `[fcm] configured — mobile push enabled`, `[apns] VoIP push
configured`, or the corresponding "not set" warnings.

## Verifying

```
npm run test:unit -- backend/app/test/mobile-push.test.ts   # builders + repos
curl -H "Authorization: Bearer $T" -X POST localhost:4000/api/push/devices \
  -H 'content-type: application/json' \
  -d '{"platform":"android","token":"<fcm token from the app log>","appVersion":"1.0.2+9"}'
```
Then send yourself a DM from the web client with the phone's app killed.
