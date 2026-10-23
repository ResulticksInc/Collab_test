# Backend Push Configuration — UAT & Production

Sep 23, 2026 · @Resulticks

## Current state

iOS push has never worked, on any build. Two independent Apple links carry iOS notifications and both are misconfigured. The notifications that do appear while the app is open or recently backgrounded come from the Socket.IO connection, not from Apple.

| Channel | Path | Blocker |
| --- | --- | --- |
| Messages, mentions, meetings | backend → FCM → APNs | Firebase project `collab-7531d` has no APNs key or certificate uploaded |
| Incoming calls (CallKit ring) | backend → APNs directly (VoIP) | Backend appears to have no APNs key configured at all, so it never attempts a VoIP push — see the correction below |

**Correction, 24 Sep 2026.** This document first attributed the missing CallKit ring to an environment mismatch — a development-signed app holding sandbox tokens while the backend targeted the production APNs host. **A TestFlight build disproved that.** A distribution-signed build has a production VoIP token and UAT targets the production host, so they match, and the call still arrived as a time-sensitive banner rather than a native ring.

The likely cause is simpler and was never checked: `apnsVoipService.init()` sets `ready` only when `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` and a readable `.p8` are all present, and `deliver()` attempts a VoIP push only when `apns.isReady()`. With no key configured the backend skips VoIP entirely and falls through to the FCM alert — for every build, whatever its signing. The plugin's own warning says exactly this: `"APNS_KEY_ID/TEAM_ID/KEY_P8 not set — iOS calls fall back to FCM alerts (no CallKit ring when terminated)"`.

**Credentials verified, 25 Sep 2026.** The backend's own `apnsVoipService` was pointed at this key and sent a VoIP push to a deliberately invalid token on both hosts. Sandbox and production each answered `400 BadDeviceToken`, which Apple returns only after the provider token (Key ID `37PG75SL4U`, Team ID `9G6WTL8BCF`, topic `com.resulticks.collab.voip`) has authenticated. Wrong credentials would have returned `403 InvalidProviderToken`. The local live stack now boots with `[apns] VoIP push configured (sandbox, topic com.resulticks.collab.voip)`.

Uploading the `.p8` to the Firebase console does **not** cover this. That key lets Firebase reach Apple for message alerts; the backend needs its own copy for VoIP, because it talks to Apple directly and Firebase cannot send VoIP pushes at all. Same file, two places.

So **Step 4 is the operative fix.** Once the key is configured and `apns.isReady()` is true, the backend starts attempting VoIP pushes — and at that point **Step 5 matters again**, because the host it sends to has to match how the app was signed. Until then the environment setting changes nothing, because no VoIP push is sent at all.

Android is unaffected. It goes backend → FCM → device and never touches Apple, which is why the same UAT server works there.

Evidence, verified 23 Sep 2026:

- Firebase console, Cloud Messaging tab for `com.resulticks.collab`: all four slots empty — no development or production APNs auth key, no development or production APNs certificate.
- App installed on the test iPhone 13, `com.resulticks.collab` 1.0.4 (11), is signed `aps-environment: development` with `get-task-allow: true` under "iOS Team Provisioning Profile". A Flutter `--release` build is still development-signed; build mode does not set the APNs environment.
- `GET https://collab-uat.resulticks.com/api/health` returns `env: production`, and `APNS_ENVIRONMENT` is unset, so the backend resolves the production APNs host.

## Step 1 — Create the APNs auth key at Apple

One `.p8` auth key serves everything: Firebase, the UAT backend and the production backend. An auth key is not environment-specific, so the same file authenticates to both the sandbox and production APNs hosts.

Requires Account Holder or Admin access at developer.apple.com.

1. **Certificates, Identifiers & Profiles** → **Keys**.
2. Check the existing list first. If a key with APNs enabled already exists and the `.p8` file is still available, reuse it and skip to Step 2. Apple allows only two APNs keys per team, and a lost `.p8` cannot be re-downloaded — it must be revoked and recreated.
3. Click **+**, name it `Collab APNs Key`, tick **Apple Push Notifications service (APNs)**. If prompted for Environment choose **Sandbox & Production**; for Key Restriction choose **All Topics**.
4. **Continue** → **Register** → **Download**. Apple allows this download once. Store the file in the secret manager both environments read from.
5. Record the **Key ID** (10 characters, also in the filename `AuthKey_XXXXXXXXXX.p8`). The **Team ID** is `9G6WTL8BCF`, confirmed from the app's provisioning profile.

**The key now exists (24 Sep 2026).** Use these values wherever the steps below say `APNS_KEY_ID` / `APNS_TEAM_ID`:

| Field | Value |
| --- | --- |
| Key name | Collab APNs Key |
| Key ID | `37PG75SL4U` |
| Team ID | `9G6WTL8BCF` |
| Service | Apple Push Notifications service (APNs) |

The `.p8` file itself is **not** in this document and must not be pasted into it. It is the private key: put it in whatever secret store the deployment already uses, and reference it from `APNS_KEY_FILE` (a path) or `APNS_KEY_P8` (its contents). Apple allows it to be downloaded once, so if it is lost the key has to be revoked and recreated — and every environment using it re-pointed.

### App ID capabilities to confirm

Under **Identifiers**. These are required for distribution signing later, and the notification extension will fail to sign without them.

| Identifier | Capabilities |
| --- | --- |
| `com.resulticks.collab` | Push Notifications, App Groups (`group.com.resulticks.collab`), Communication Notifications, Time Sensitive Notifications |
| `com.resulticks.collab.NotificationService` | App Groups (`group.com.resulticks.collab`) |

The VoIP topic `com.resulticks.collab.voip` is derived automatically from the bundle ID. Nothing separate is registered for it.

## Step 2 — Upload the key to Firebase

This fixes iOS message, mention and meeting notifications. It is a single change in the Firebase console and covers both UAT and production, because both environments use the same Firebase project and the same bundle ID.

1. Firebase Console → project **Collab** (`collab-7531d`) → gear icon → **Project settings**.
2. **Cloud Messaging** tab → *Apple app configuration* → select **Collab iOS** (`com.resulticks.collab`).
3. **APNs Authentication Key** → **Upload**. Supply the `.p8`, the Key ID, and Team ID `9G6WTL8BCF`.
4. Upload the same file to both the development and production rows the console shows.

**Done — confirmed 24 Sep 2026.** The same `Collab APNs Key` (`37PG75SL4U`) is uploaded in the Firebase console for `com.resulticks.collab`. No action left in this step. Devices are already receiving remote message notifications through it, which is the observable proof: the payloads arriving on the test iPhone carry `gcm.message_id` and `google.c.sender_id`, so they came via Firebase rather than the socket.

No app rebuild and no server restart are needed. Devices already hold valid FCM tokens, so message notifications begin working on builds that are already installed.

Firebase selects the sandbox or production APNs host automatically from the token type, so one auth key serves development-signed builds and TestFlight or App Store builds at the same time. `APNS_ENVIRONMENT` does not apply to this path.

## Step 3 — UAT server

This fixes incoming-call rings on UAT. The values live in the deployment's env file on the UAT host, typically `.env.live`, because every compose file reads them from the host as `${APNS_ENVIRONMENT:-}` and similar. They are not in either Git repository.

```
APNS_KEY_ID=37PG75SL4U
APNS_TEAM_ID=9G6WTL8BCF
APNS_KEY_FILE=/app/keys/AuthKey_37PG75SL4U.p8
APNS_BUNDLE_ID=com.resulticks.collab
APNS_ENVIRONMENT=sandbox

FCM_SERVICE_ACCOUNT_FILE=/app/keys/fcm-service-account.json
FCM_PROJECT_ID=collab-7531d
```

Notes on each:

- `APNS_KEY_FILE` is a path **inside the container**. Every compose file mounts the host's `./keys` at `/app/keys` (read-only), so copy `AuthKey_37PG75SL4U.p8` into `./keys` on the host next to the compose file. Use `APNS_KEY_P8` with the file's contents inline instead if mounting a file is awkward; set one or the other, not both.
- `APNS_ENVIRONMENT=sandbox` is correct **while UAT serves development-signed builds**, which is the case today. See Step 5 before changing it.
- `APNS_BUNDLE_ID` already defaults to `com.resulticks.collab`, so it is optional. The backend appends `.voip` to it for the VoIP topic.
- `FCM_SERVICE_ACCOUNT_JSON` accepts the raw or base64 JSON as an alternative to `FCM_SERVICE_ACCOUNT_FILE`.

Restart the API service, then confirm these two lines in the boot log:

```
[mobile-push] enabled — fcm=true apnsVoip=true
[apns] VoIP push configured (sandbox, topic com.resulticks.collab.voip)
```

If you instead see `[apns] APNS_KEY_ID/TEAM_ID/KEY_P8 not set — iOS calls fall back to FCM alerts`, the values did not reach the container. Check that the env file is the one the compose stack actually loads.

## Step 4 — Production server

Identical variables, one different value. Production serves App Store and TestFlight builds, which are distribution-signed and hold production APNs tokens.

```
APNS_KEY_ID=37PG75SL4U
APNS_TEAM_ID=9G6WTL8BCF
APNS_KEY_FILE=/app/keys/AuthKey_37PG75SL4U.p8
APNS_BUNDLE_ID=com.resulticks.collab
APNS_ENVIRONMENT=production

FCM_SERVICE_ACCOUNT_FILE=/app/keys/fcm-service-account.json
FCM_PROJECT_ID=collab-7531d
```

Differences from UAT:

| Item | UAT | Production |
| --- | --- | --- |
| `APNS_ENVIRONMENT` | `sandbox` | `production` |
| APNs host reached | `api.sandbox.push.apple.com` | `api.push.apple.com` |
| Builds served | development-signed, from Xcode or VS Code | distribution-signed, TestFlight and App Store |
| `.p8` key file | same key | same key |
| Firebase project | `collab-7531d` | `collab-7531d` |

The same `.p8` and the same Firebase project are used by both environments. Only `APNS_ENVIRONMENT` differs.

Expected boot log on production:

```
[apns] VoIP push configured (production, topic com.resulticks.collab.voip)
```

**Production report, 7 Oct 2026 — "only call notifications arrive" on `run`.** The code is identical on both hosts and the run host *does* have `keys/fcm-service-account.json` (verified by listing `./keys` there), so it is not the missing-file case. iOS calls bypass every gate (APNs VoIP, direct), while messages and mentions go through FCM **and** the recipient's settings — so the symptom means one of: an FCM send failure on that host (`[mobile-push] fcm failed …` in the log — firewall to `*.googleapis.com`, stale token, or the oversized-iOS-message bug below), or a recipient-side gate (`manual_presence = dnd`, `notifyLevel = none|mentions`, quiet hours, muted conversation). DEPLOY.md §1c has the three commands that tell these apart. Two code defects that produce exactly this symptom were fixed the same day: (1) the iOS FCM message carried the E2EE ciphertext twice (data map + `apns.payload.payload`), so a DM envelope under the 3.5 KB data budget still pushed the message past FCM's 4096-byte limit → `400 INVALID_ARGUMENT`, no notification — now guarded on the assembled message; (2) mention / @channel / reply notifications from the socket send path were only emitted live, never pushed, so a "mentions only" user or a muted group got nothing on a killed app — they now go through `pushNotif`. `GET /api/health/ready` → `checks.push` additionally reports the configured legs so a missing key is visible without log access.

If `APNS_ENVIRONMENT` is left unset on production it resolves to `production` anyway, because the fallback derives from `NODE_ENV`. Set it explicitly regardless, so the value is visible rather than implied.

## Step 5 — The environment matching rule

Apple runs two separate push systems with separate token namespaces. A token minted in one is rejected in the other with `BadDeviceToken`, silently, with no signal to the app or the user. `APNS_ENVIRONMENT` must match how the app that registered the token was signed.

| App signing | `aps-environment` | Token type | Required `APNS_ENVIRONMENT` |
| --- | --- | --- | --- |
| Development profile — Xcode run, `flutter build ios --release`, `flutter run --release` | `development` | sandbox | `sandbox` |
| Distribution profile — TestFlight, App Store, `flutter build ipa --export-method app-store` | `production` | production | `production` |

Flutter's build mode does not affect this. A `--release` build is still development-signed unless it is exported with a distribution profile, so it still produces sandbox tokens.

### The constraint to plan around

`APNS_ENVIRONMENT` is one value per server, so a single environment cannot serve both build types at once. The moment testers are on TestFlight while developers run local builds against the same backend, one group loses calls.

**OPEN — decide this before applying Steps 3 and 4.** Which build type each environment actually serves has not been confirmed. The values written in those steps (`sandbox` for UAT, `production` for production) assume UAT serves development-signed builds — which is what has been tested on device so far — and that production serves TestFlight and App Store builds.

If UAT will also serve TestFlight builds, `sandbox` is wrong for it, and the two cannot both work: `APNS_ENVIRONMENT` is a single value per server. Getting it wrong is silent — Apple answers `BadDeviceToken` and drops the push, so calls simply never ring, with nothing in the app to say why. That is the failure this whole document exists to prevent, so it is worth settling explicitly rather than inheriting a default.

Two ways out:

- **Keep them separated.** UAT stays on `sandbox` for development builds; production stays on `production` for TestFlight and App Store. Workable as long as no TestFlight build is ever pointed at UAT.
- **Route per device.** The app sends `apnsEnvironment: "sandbox" | "production"` alongside its token on `POST /api/push/devices`, the column is stored on `push_devices`, and `apnsVoipService.sendVoip` picks the host per device rather than from a global setting. This removes the constraint entirely and is the durable fix. It needs a migration plus a mobile release, so it is not a prerequisite for the steps above.

The Firebase path is exempt from all of this. With a `.p8` auth key, Firebase picks the host from the token type on its own.

## Verification and troubleshooting

Test with the app **force-quit**. That is the only state that exercises the Apple path. While the app is running or recently backgrounded, notifications arrive over Socket.IO and prove nothing about push.

1. Launch the app and sign in, so the device re-registers its FCM and VoIP tokens.
2. Force-quit it from the app switcher.
3. Send a message from another account — a banner should appear. This validates Step 2.
4. Place a call — a full-screen CallKit ring should appear on the lock screen. This validates Steps 3 to 5.
5. Wait out the ring without answering — it should stop on its own, from the backend's cancel push.

### Reading the logs

| Log line | Cause | Fix |
| --- | --- | --- |
| `[mobile-push] apns voip failed ... BadDeviceToken` | `APNS_ENVIRONMENT` does not match the app's signing | Step 5 |
| `[mobile-push] apns voip failed ... 403` or `DeviceTokenNotForTopic` | Wrong Key ID, Team ID or bundle ID | Step 3 or 4 |
| `[mobile-push] fcm failed ... ios` with an auth error | Firebase has no APNs key for this bundle ID | Step 2 |
| `[apns] APNS_KEY_ID/TEAM_ID/KEY_P8 not set` | Backend key not configured; calls silently degrade to FCM alerts | Step 3 or 4 |
| No `[mobile-push]` line at all | Backend never attempted a send | Check the device has a row in `push_devices` for the signed-in user |

### Notes for whoever runs this

- Step 2 is independent of the servers and unblocks the larger half of the problem. It can be done first, on its own.
- A device registers its token on sign-in. After any change here, sign out and back in on the test device before concluding it did not work.
- `push_devices` rows are never removed on sign-out or session revoke, so stale rows accumulate. Harmless for these steps, worth cleaning up separately.
