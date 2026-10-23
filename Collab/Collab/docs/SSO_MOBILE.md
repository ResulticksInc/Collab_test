# CoLab SSO for the mobile app — integration guide

Audience: the mobile (Flutter) developer wiring AgenXchange SSO into the CoLab app.
Backend counterpart: `docs/SSO.md`. Client-facing overview: `sso-Integration-guidev3.html`.

The mobile app talks to **two** systems. It signs the user in at the **IdP** itself
(OpenID Connect, Authorization Code + PKCE, in the system browser) and then hands the
IdP's tokens to the **CoLab backend**, which verifies them and mints the CoLab session
the app uses for every other API call.

```
App ──(1) /authorize in system browser──▶ IdP  https://stgoa.re.cx
App ◀─(2) redirect  <scheme>://…?code&state ── IdP
App ──(3) POST /token  code + code_verifier ──▶ IdP   → id_token, access_token
App ──(4) POST /api/auth/sso/token  id_token, access_token, nonce, deviceId ──▶ CoLab backend
App ◀─(5) { token, user, refreshToken }  ── CoLab backend   (Bearer token from here on)
```

## 0. Before you code — two registrations

| What | Who does it | Value |
| --- | --- | --- |
| Mobile client on the IdP | AgenXchange SSO team | Ask for a **public** client (no secret; token auth `none`) with your **custom-scheme redirect URI**, e.g. `com.resulticks.collab://sso/callback`, and scope `openid profile email`. Do **not** embed the web client's secret in the app. |
| Accept that client's id_tokens | CoLab backend team | The client id you receive goes into `SSO_EXTRA_CLIENT_IDS` on the backend (`aud` check). Until then the backend answers `401 id_token rejected: jwt audience invalid`. |

If the SSO team instead adds your redirect URI to the existing web client `collab`, note that
`collab` is confidential: the `/token` call then needs the client secret, which must not
ship in an app. Ask for the public client.

## 1. Backend base URLs

| Env | API base | Notes |
| --- | --- | --- |
| local (this Mac, same Wi-Fi) | `http://10.64.5.146:4000/api` | plain HTTP: allow cleartext for this host (Android network config / iOS ATS exception) |
| teams (UAT) | `https://collab-uat.resulticks.com/api` | |
| run (production) | `https://collab.resulticks.com/api` | |

Every backend response is `{ ok: true, data: … }` or `{ ok: false, error: { code, message } }`.

## 2. IdP facts (same for every environment)

- Discovery: `https://stgoa.re.cx/.well-known/openid-configuration`
- `authorization_endpoint` `https://stgoa.re.cx/authorize`, `token_endpoint` `…/token`,
  `userinfo_endpoint` `…/userinfo`, `end_session_endpoint` `…/logout`, `jwks_uri` `…/jwks`
- `issuer` `https://stgoa.re.cx`, id_token alg `RS256`, PKCE `S256` only
- Scope: `openid profile email`
- The id_token may carry **no email**. PII arrives as `claims_jwe` (RSA-encrypted) via
  `/userinfo`, or as Fernet `*_enc` fields. **The backend handles all of that** — the app
  only forwards the tokens. That is why `access_token` must be sent along.

## 3. The authorize request

Send exactly these parameters (AppAuth builds most of them for you):

```
https://stgoa.re.cx/authorize
  ?response_type=code
  &client_id=<your mobile client id>
  &redirect_uri=com.resulticks.collab://sso/callback
  &scope=openid+profile+email
  &state=<random>                       # verify it on the redirect
  &nonce=<random>                       # keep it — you send it to the backend
  &code_challenge=<S256(code_verifier)>
  &code_challenge_method=S256
  &claims={"id_token":{"email":null,"email_verified":null,"name":null,"picture":null,
           "department":null,"employee_id":null,"claims_jwe":null,"products":null,"entitlements":null},
           "userinfo":{same keys}}      # asks the IdP for the full profile pack
  &login_hint=user@example.com          # optional (prefill)
```

Use the system browser (`ASWebAuthenticationSession` / Chrome Custom Tabs — AppAuth does
this), never a WebView. The IdP shows its own "Sign In" page.

## 4. Exchange the code at the IdP

`POST https://stgoa.re.cx/token` (form-encoded):

```
grant_type=authorization_code
code=<from redirect>
redirect_uri=com.resulticks.collab://sso/callback
client_id=<your mobile client id>
code_verifier=<the PKCE verifier you generated>
```

Response: `{ id_token, access_token, token_type, expires_in, … }`. Keep `id_token`,
`access_token` and the `nonce` from step 3.

## 5. Turn the IdP tokens into a CoLab session

`POST <API base>/auth/sso/token`

```json
{
  "id_token":     "<from step 4>",
  "access_token": "<from step 4>",
  "nonce":        "<the nonce you sent in step 3>",
  "deviceId":     "<stable per-install UUID>"
}
```

- `id_token` **required**. `access_token` strongly recommended (the backend needs it to
  fetch `/userinfo` when the id_token has no PII). `nonce` optional but recommended: when
  present it must equal the id_token's `nonce`. `deviceId` binds the session to this
  install (needed for encrypted history); generate once, store in secure storage.

**Responses**

| Status | Body | Meaning / action |
| --- | --- | --- |
| 200 | `{ ok:true, data:{ token, user, sessionId, refreshToken } }` | Signed in. Store `token` and `refreshToken` in secure storage. |
| 200 | `{ ok:true, data:{ mfaRequired:true, challengeId, methods:["totp"] } }` | User has app-level MFA. Ask for the code, then `POST /auth/mfa/verify { challengeId, code }` → same `{ token, user, … }`. |
| 400 | `id_token is required (compact JWS).` | Body missing/invalid. |
| 400 | `SSO identity has no usable email claim. Claims received: […]` | IdP released no PII for this client. Send the message to the backend team. |
| 401 | `id_token rejected: jwt audience invalid …` | Your client id is not in `SSO_EXTRA_CLIENT_IDS` yet. |
| 401 | `id_token rejected: invalid signature / jwt expired / …` | Token not from stgoa.re.cx, or stale. Re-run the flow. |
| 401 | `id_token nonce mismatch.` | You sent a different nonce than the one in the authorize request. |
| 429 | `Too many attempts…` | 30 attempts per 15 minutes per IP. Back off. |
| 502 | `Fetching JWKS failed … / SSO request … timed out` | Backend could not reach the IdP. Retry later. |

## 6. Use the session

- Every call: `Authorization: Bearer <token>`. Access tokens last 7 days.
- `GET /auth/me` → the current user.
- When a call returns 401: `POST /auth/refresh { refreshToken, deviceId }` →
  `{ token, refreshToken, user }` (rotating — always store the new pair). `409 REFRESH_RETRY`
  = a refresh is already in flight, retry once. Any other failure → run SSO again.
- Push: `POST /push/devices { platform: "android" | "ios", token }` after sign-in.

## 7. Sign out (both sessions)

1. `POST /auth/logout` with the Bearer token (revokes the CoLab session and this device).
2. Clear `token`, `refreshToken` from secure storage (keep `deviceId`).
3. End the IdP session too, in the system browser:
   `https://stgoa.re.cx/logout?post_logout_redirect_uri=<your registered post-logout URI>&client_id=<your client id>`.
   Skipping this means the next SSO sign-in silently re-authenticates.

## 8. Flutter sketch (flutter_appauth)

```dart
final appAuth = FlutterAppAuth();
final nonce = randomUrlSafe(22);
final claims = jsonEncode({
  "id_token":  {"email":null,"email_verified":null,"name":null,"picture":null,
                "department":null,"employee_id":null,"claims_jwe":null,"products":null,"entitlements":null},
  "userinfo":  {"email":null,"email_verified":null,"name":null,"picture":null,
                "department":null,"employee_id":null,"claims_jwe":null,"products":null,"entitlements":null},
});

final r = await appAuth.authorizeAndExchangeCode(AuthorizationTokenRequest(
  clientId, 'com.resulticks.collab://sso/callback',
  discoveryUrl: 'https://stgoa.re.cx/.well-known/openid-configuration',
  scopes: ['openid', 'profile', 'email'],
  additionalParameters: {'claims': claims, 'nonce': nonce},   // PKCE S256 is automatic
));

final res = await http.post(Uri.parse('$apiBase/auth/sso/token'),
  headers: {'Content-Type': 'application/json'},
  body: jsonEncode({
    'id_token': r!.idToken, 'access_token': r.accessToken,
    'nonce': nonce, 'deviceId': await deviceId(),
  }));
final data = jsonDecode(res.body)['data'];
if (data['mfaRequired'] == true) { /* prompt for code → POST /auth/mfa/verify */ }
else { await secure.write('token', data['token']); await secure.write('refresh', data['refreshToken']); }
```

## 9. Debugging

- With `API_DEBUG_LOG=true` (on for the local backend) every request and response is
  printed in the backend terminal with secrets redacted — ask the backend developer for
  the lines matching your request id (`X-Request-Id` response header).
- SSO step logs are prefixed `[sso]`: they say whether the id_token verified, which claim
  keys arrived, whether `/userinfo` was fetched, and whether `claims_jwe` decrypted.
- A quick smoke test without the app:
  `curl -X POST <API base>/auth/sso/token -H 'Content-Type: application/json' -d '{}'`
  must answer `400 id_token is required` — proves the route and base URL.

## Checklist

- [ ] Mobile client id + custom-scheme redirect registered on the IdP (public client)
- [ ] Backend has that client id in `SSO_EXTRA_CLIENT_IDS`
- [ ] Authorize request carries PKCE S256, `state`, `nonce`, `claims`
- [ ] `state` verified on redirect; code exchanged at the IdP with `code_verifier`
- [ ] `POST /auth/sso/token` with `id_token`, `access_token`, `nonce`, `deviceId`
- [ ] MFA branch handled (`mfaRequired` → `/auth/mfa/verify`)
- [ ] Tokens in secure storage; refresh rotation stores the new pair
- [ ] Sign-out revokes the CoLab session **and** opens the IdP `/logout`
