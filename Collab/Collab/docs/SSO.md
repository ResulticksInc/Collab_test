# SSO — Single Sign-On (OpenID Connect)

CoLab supports **OpenID Connect, Authorization Code + PKCE** against the shared
AgenXchange Identity Provider (IdP). The old Google button was removed; **SSO is the
social sign-in path**. Everything is self-hosted and cost-free — no managed auth
service, no extra infrastructure (PKCE + JWK→PEM use Node's built-in `crypto`;
signatures reuse `jsonwebtoken`; the encrypted PII claims are opened with `jose`).

**IdP base URL: `https://stgoa.re.cx/`** (AgenXchange staging). One env var,
`SSO_BASE_URL`, drives every endpoint; see below.

## Environments (redirect URIs to register on the IdP)

| Env | Env file | App host = `SSO_REDIRECT_URI` |
| --- | --- | --- |
| local | `.env` | `http://localhost:3002` |
| teams (UAT) | `.env.teams` | `https://collab-uat.resulticks.com` |
| run (production) | `.env.live` | `https://collab.resulticks.com` |

Each host must be registered on the IdP for the `collab` client **byte-for-byte** (no
trailing slash). The IdP rejects an unregistered `redirect_uri` with HTTP 400 before
showing its login page. Client-facing guide for the SSO team: `sso-Integration-guidev3.html`.

## What you must provide (per deployment)

All teams share **one** IdP, so you only register **this app** on it and set four
things. Everything else is auto-derived or discovered.

| Env var | Meaning | Example |
| --- | --- | --- |
| `SSO_BASE_URL` | The IdP host. `/authorize`, `/token`, `/jwks`, `/logout` hang off it. | `https://stgoa.re.cx/` |
| `SSO_CLIENT_ID` | Your registered client id | `collab` |
| `SSO_CLIENT_SECRET` | Only for a **confidential** client. Blank = **public** (PKCE-only). | `…` or blank |
| `SSO_REDIRECT_URI` | **Exact** redirect URI registered on the IdP — the app **root** | `https://collab.resulticks.com/` |
| `SSO_JWE_PRIVATE_KEY_FILE` (or `SSO_JWE_PRIVATE_KEY`) | RSA private key that opens the IdP's **encrypted PII claims** — see [Encrypted PII claims](#encrypted-pii-claims-claims_jwe) | `keys/collab_private.pem` |

The redirect URI is the **app root** (`https://<origin>/`), matching the reference
project's convention. The IdP redirects the browser back there with `?code&state`;
the SPA reads them off its own URL and POSTs them to the backend to exchange. It
must match the IdP registration byte-for-byte (scheme, host, trailing slash).

## Shared IdP settings (keep as-is)

```
SSO_ENABLED=true
SSO_BASE_URL=https://stgoa.re.cx/
SSO_IDP_URL=                                   # blank: go straight to <base>/authorize
SSO_SCOPE=openid profile email
NEXT_PUBLIC_SSO_ENABLED=true                   # shows the "Continue with SSO" button
```

Each endpoint (**authorize**, **token**, **JWKS**, **logout**) is resolved in this order:

1. Explicit env (`SSO_AUTHORIZE_URL`, `SSO_TOKEN_URL`, `SSO_JWKS_URL`, `SSO_USERINFO_URL`,
   `SSO_LOGOUT_URL`, `SSO_ISSUER`).
2. Derived from `SSO_BASE_URL` — `https://stgoa.re.cx/authorize`, `…/token`, `…/jwks`, `…/logout`.
3. OIDC discovery — `GET <base>/.well-known/openid-configuration` (cached 1h).
4. Derived from the authorize URL's origin.

Set the explicit vars only if the base-URL derivation doesn't match your IdP. The
id_token `iss` is accepted if it matches `SSO_ISSUER` **or** any configured origin
(base URL, authorize/token/idp origins) — the old IdP stamped an internal address
(`http://10.200.1.58:7505`); if staging stamps something else, the login error names
the value verbatim so you can set `SSO_ISSUER` to it.

## Encrypted PII claims (`claims_jwe`)

The AgenXchange IdP does **not** put the user's PII in the id_token in the clear. The
(signed) id_token carries a `claims_jwe` claim: a compact **JWE** whose plaintext is a
JSON object — `{ email, department, employee_id, picture }` — encrypted to **CoLab's
RSA public key**. CoLab decrypts it with the matching private key, and the decrypted
`email` becomes the account key (it overrides any plaintext `email` claim).

### 1. Generate the key pair (once per deployment)

```
scripts/gen-sso-keys.sh            # or, by hand:
openssl genrsa -out keys/collab_private.pem 2048
openssl rsa -in keys/collab_private.pem -pubout -out keys/agenxchange_public.pem
```

- `keys/agenxchange_public.pem` → **hand to the AgenXchange team**. They encrypt with it.
- `keys/collab_private.pem` → **stays on the CoLab server**. Both `.pem` files are
  git-ignored; never commit the private one.

### 2. Configure the private key

Either a path (Docker: `./keys` is mounted read-only at `/app/keys` in every compose file):

```
SSO_JWE_PRIVATE_KEY_FILE=/app/keys/collab_private.pem      # keys/collab_private.pem when running from source
```

or the PEM inline for secret stores that can't hold multi-line values (raw PEM or
base64 of the whole file are both accepted):

```
SSO_JWE_PRIVATE_KEY=$(base64 -i keys/collab_private.pem | tr -d '\n')
```

For the Azure-rendered live env, add `SSO_JWE_PRIVATE_KEY` as a 🔒 secret to the
`colab-live-env` group (see `docs/ENV_VIA_AZURE.md`) and leave
`SSO_JWE_PRIVATE_KEY_FILE` blank.

### 3. What the backend does

`completeSsoCallback` in `backend/app/src/services/ssoService.ts` — **after** the
id_token signature/iss/aud/exp/nonce check — sees `claims_jwe`, calls
`decryptClaimsJwe`, and merges the PII over the plaintext claims. It is the Node twin
of the IdP team's reference snippet:

```python
from authlib.jose import JsonWebEncryption
jwe = JsonWebEncryption()
private_pem = open("collab_private.pem", "rb").read()
data = jwe.deserialize_compact(id_token_claims["claims_jwe"], private_pem)
pii = json.loads(data["payload"])
email = pii["email"]          # decrypted PII: email, department, employee_id, picture
```

Rules:

- Accepted key-wrap algorithms: `RSA-OAEP`, `RSA-OAEP-256/384/512`. `RSA1_5` is refused.
- Both `openssl` PEM formats work (`BEGIN RSA PRIVATE KEY` from OpenSSL 1.x/LibreSSL,
  `BEGIN PRIVATE KEY` from OpenSSL 3.x).
- **Fails closed.** A `claims_jwe` that can't be decrypted (no key configured, wrong
  key, tampered, non-JSON payload) rejects the sign-in with a reason that names the
  problem — it never falls back to plaintext claims.
- `picture` seeds a **new** user's avatar; `department` / `employee_id` are carried on
  the profile for future use and are not persisted yet.

### Profile resolution order (guide v3)

1. Signature-verified **id_token** claims.
2. If those yield no email, **`/userinfo`** (with the access token) is fetched and
   merged underneath the id_token claims.
3. **Fernet `*_enc`** copies (`email_enc`, `name_enc`, `picture_enc`, `department_enc`,
   `employee_id_enc`) are decrypted with `SSO_PROFILE_ENC_SECRET` (the SSO team's
   shared secret; key = base64url(SHA256(secret))). Node implementation in
   `fernetDecrypt`, cross-checked against Python `cryptography` in the tests. Blank
   secret = `*_enc` ignored.
4. **`claims_jwe`** is decrypted last. Decrypted values always win over plaintext.

A login that still has no email fails with a message listing the claim keys received
and the likely cause (public key not registered → no `claims_jwe`; `*_enc` present but
no `SSO_PROFILE_ENC_SECRET`; no profile claims at all → client scope/profile settings).

## The flow

```
Browser                Frontend (Next proxy)         Backend                         IdP
  | click "Continue with SSO"                          |                               |
  |----- GET /api/auth/sso/start ------------------->  |  make verifier/challenge,     |
  |                                                    |  state (HMAC), nonce          |
  |  302 → https://stgoa.re.cx/authorize?…  (or <idp>/login?return_to=… if SSO_IDP_URL)─>|
  |                                       user signs in at the IdP …                   |
  |  302 → https://<origin>/?code&state  (the app ROOT) <───────────────────────────────|
  |  SPA boots, reads ?code&state off its URL                                           |
  |----- POST /api/auth/sso/callback {code,state} -->  |  verify state (recover PKCE    |
  |                                                    |  verifier + nonce),            |
  |                                                    |  POST /token (code+verifier) ->|
  |                                                    |  validate id_token (JWKS,      |
  |                                                    |  iss/aud/exp/nonce), decrypt   |
  |                                                    |  claims_jwe (RSA) → email      |
  |                                                    |  find-or-create user, mint JWT |
  |  { token, user }  <--------------------------------|  (returned in the JSON body)   |
  |  app stores token (localStorage / keychain), signed in, strips ?code&state          |
```

The app JWT is returned in the **POST response body**, never in a URL. The
single-use `code` is stripped from the address bar immediately after exchange.

## Endpoints (backend, under `/api/auth`)

- `GET  /sso/status` → `{ enabled, configured }` (for the client to show/hide the button)
- `GET  /sso/start[?login_hint=<email>]` → 302 straight to the IdP `/authorize` (or `/?sso_error=not_configured` if unconfigured). No pre-login logout hop.
  The authorize request carries PKCE, `nonce`, the OIDC `claims` request for the full
  profile pack (`email, name, picture, department, employee_id, claims_jwe, …`) and, when
  given, `login_hint`.
- `POST /sso/callback` `{ code, state }` → `{ token, user }` (verifies + exchanges server-side; 400 on bad/expired state)
- `POST /sso/token` `{ id_token, access_token?, nonce?, deviceId? }` → `{ token, user, refreshToken }`.
  **Native / mobile sign-in**: the Flutter app runs the OIDC + PKCE exchange itself and
  posts the IdP tokens. The backend verifies the id_token (JWKS signature, `iss`, `aud` =
  `SSO_CLIENT_ID` or one of `SSO_EXTRA_CLIENT_IDS`, `exp`, `nonce` when supplied) and runs
  the same profile pipeline (userinfo → `*_enc` → `claims_jwe`) before minting the
  session. Rate-limited like login. 400 without an id_token, 401 on any verification failure.
- `GET  /sso/logout` → 302 to the IdP end-session endpoint with the app root as
  `post_logout_redirect_uri`. The SPA navigates here **after** its own `POST /logout`
  when the session was made by SSO (it remembers `colab.authMethod=sso` in localStorage),
  so the IdP cookie is cleared too and the next SSO sign-in asks for credentials.

### IdP app launcher (`login_hint`)

When a user already signed in on the IdP dashboard clicks CoLab, the IdP opens the app
root with `?login_hint=<email>` and **no code**. The SPA (`useCoLab1.tsx` boot effect)
sees the hint, and if this browser has no saved session, navigates straight to
`/api/auth/sso/start?login_hint=…` instead of showing the password form. The backend
validates the hint as an email (anything else is dropped) and forwards it to `/authorize`.

## Security posture

- **PKCE S256** on every sign-in (even with a client secret).
- **State** is HMAC-signed (`SSO_STATE_SECRET`, falls back to `AUTH_JWT_SECRET`) with
  a 10-minute TTL, carrying the PKCE verifier + nonce — no shared server storage, so
  it works across multiple backend instances and survives the redirect round-trip.
- **id_token** is validated: JWKS signature + `aud` (= client id) + `iss` (when known)
  + `exp` (60s clock tolerance) + `nonce`.
- **PII** (`claims_jwe`) is decrypted only from an already-verified id_token, with
  RSA-OAEP only, and only with the configured private key — otherwise the sign-in fails.
- Fails **closed**: if the signature can't be verified (JWKS unreachable) the callback
  rejects. `SSO_INSECURE_SKIP_VERIFY=true` decodes without verification — **dev only**,
  and it is refused outright in production.
- New SSO users are created **passwordless** (no password hash) — they can only sign
  in via SSO. An existing account (password or invited) is reused, never clobbered.

## Local dev

The shared IdP (`stgoa.re.cx`) may not be reachable from a laptop, so SSO is typically
tested on `teams`/`live`. To hide the button locally set `NEXT_PUBLIC_SSO_ENABLED=0`;
email/password login is unchanged. If you do test locally, register
`http://localhost:3002/` as a redirect URI on the IdP.

## Files

- `config/src/index.ts` — the `sso` config block.
- `backend/app/src/services/ssoService.ts` — PKCE, signed state, discovery, token
  exchange, id_token verification, `claims_jwe` decryption.
- `scripts/gen-sso-keys.sh` + `keys/` — the RSA pair for the encrypted PII claims.
- `backend/app/src/services/authService.ts` — `ssoLogin()` (find-or-create).
- `backend/app/src/routes/auth.ts` — `/sso/status`, `/sso/start`, `/sso/callback`.
- `frontend/app/src/components/LoginScreen.tsx` — the "Continue with SSO" button.
- `frontend/app/src/components/colab/session/useCoLab1.tsx` — the boot-time `?code&state` exchange and the `?login_hint` launcher path.
- `frontend/app/src/components/colab/session/useCoLab0.tsx` — `doLogout` → `/api/auth/sso/logout` for SSO sessions.
- `backend/app/test/sso.test.ts` — pure-logic tests (PKCE, signed state, JWE decrypt).
