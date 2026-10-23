# Mobile app links — scan the web QR, the Collab app opens and joins

The meeting-info popover and the 1:1 / group call info popover on the web show a
QR code. The QR encodes the same deep link the web already handles on load:

| QR / link            | URL                                                   | Web behaviour                          |
|----------------------|-------------------------------------------------------|----------------------------------------|
| Meeting              | `https://<host>/?meeting=<uuid>`                      | opens pre-join for that meeting        |
| 1:1 / group call     | `https://<host>/?conversation=<conversationId>`       | opens the chat where the call banner is|
| Guest (public link)  | `https://<host>/join/<token>`                         | guest join, no account                 |

With Android App Links and iOS Universal Links, a phone that has the
**Collab_mobile** app installed opens the app instead of the browser for the
first two shapes. The guest link is excluded on purpose and stays in the browser.

Hosts: `collab.resulticks.com` (prod) and `collab-uat.resulticks.com` (UAT).

## What this repo serves

Next.js serves `frontend/app/public/` at the site root (nginx `location /` →
frontend container), so the two OS verification files live there:

- `frontend/app/public/.well-known/assetlinks.json` — Android. Lists the
  package `com.resulticks.collab` and the SHA-256 of every signing certificate
  that may sign the APK.
- `frontend/app/public/.well-known/apple-app-site-association` — iOS. Lists the
  App ID `9G6WTL8BCF.com.resulticks.collab` and the URL components the app
  claims (`/?meeting=*`, `/?conversation=*`; `/join/*` excluded).
- `frontend/app/next.config.js` `headers()` and `frontend/app/public/_headers`
  (Cloudflare static build) force `Content-Type: application/json` on the AASA
  file, which has no extension.

Both files must be reachable over HTTPS, with a 200 and **no redirect**, on
every host the app claims. Check after each deploy:

```sh
curl -sI https://collab-uat.resulticks.com/.well-known/apple-app-site-association | grep -i -E 'HTTP/|content-type'
curl -s  https://collab-uat.resulticks.com/.well-known/assetlinks.json | python3 -m json.tool
```

If a host-level nginx (outside this repo) owns `/.well-known/` for ACME
challenges, make sure only `/.well-known/acme-challenge/` is intercepted and the
rest still proxies to the frontend.

## Signing fingerprints (Android)

`assetlinks.json` currently lists the **debug** keystore fingerprint
(`~/.android/debug.keystore`, which is what every build signs with until
`android/key.properties` exists in Collab_mobile):

```
4C:B1:41:97:9F:BD:50:F8:F3:4A:30:C4:32:27:9C:42:4D:AC:B7:87:F0:8F:97:7C:C4:82:AC:0F:F1:38:64:BC
```

Before a Play release, add the release certificate(s) to the array:

```sh
keytool -list -v -keystore <release.jks> -alias <alias> | grep SHA256
```

If Play App Signing is on, also add the "App signing key certificate" SHA-256
from Play Console → Setup → App integrity. Keep the debug fingerprint only for
as long as debug builds need verified links. Invalid entries make Android reject
the whole statement, so never commit placeholders.

## iOS checklist (outside this repo)

1. Developer portal → App ID `com.resulticks.collab` → enable **Associated
   Domains**, regenerate the provisioning profiles.
2. `ios/Runner/Runner.entitlements` in Collab_mobile already lists
   `applinks:collab.resulticks.com` and `applinks:collab-uat.resulticks.com`.
3. iOS fetches the AASA through Apple's CDN at install time. After the web
   deploy, delete and reinstall the app on the test device.

## Android verification

```sh
adb shell am start -a android.intent.action.VIEW \
  -d "https://collab-uat.resulticks.com/?meeting=<uuid>" com.resulticks.collab
adb shell pm get-app-links com.resulticks.collab      # expects "verified" per host
adb shell pm verify-app-links --re-verify com.resulticks.collab   # force a re-check
```

Intent filters cannot match a query string, so the manifest claims the exact
root path `/` on each host. Side effect: tapping the bare site root also opens
the app, which then just shows Home. Every other path (`/join/…`, `/_next/…`,
`/site/…`) still opens in the browser.
