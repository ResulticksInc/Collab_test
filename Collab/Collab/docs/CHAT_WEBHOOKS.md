# Chat webhooks — incoming and outgoing

> Wire a chat conversation to the outside world. An **incoming** webhook lets an
> external system post into one DM or group; an **outgoing** webhook POSTs every
> matching chat event to a URL you control, signed so you can prove it came from
> CoLab.
>
> Everything is scoped to **one conversation** — a direct message with a
> particular person, or a group. A webhook is never more privileged than the
> member who created it.

---

## 1. The model in one paragraph

A DM _is_ a conversation, so "a webhook for a particular user" and "a webhook for
a group" are the same thing with a different `conversations.kind`. The API
accepts either `conversationId` (any conversation you're in) or `userId` (your
existing DM with that person, which it resolves for you). Every operation —
create, list, manage, and each individual incoming post — re-checks that the
webhook's **owner** is still a member of that conversation. Leave the group, and
the webhook stops working the same second.

|                     | Incoming                             | Outgoing                                    |
| ------------------- | ------------------------------------ | ------------------------------------------- |
| Direction           | external system → CoLab              | CoLab → your URL                            |
| Credential          | a secret token in the URL            | an HMAC signing secret                      |
| Auth on the wire    | none — the token _is_ the credential | your endpoint decides; verify the signature |
| Message attribution | posted as the webhook's owner        | n/a                                         |
| Delivery            | synchronous                          | queued, at-least-once, retried              |

---

## 2. Getting your token

There are **two different credentials**, and only one of them is an `Authorization`
header:

| What you are doing | Header | Credential |
|---|---|---|
| **Managing** webhooks — create, list, rotate, delete | `Authorization: Bearer <token>` | Your normal user session. Expires. |
| **Posting into a chat** — `/api/webhooks/in/:token` | *none* | The token already in the URL. Does not expire. |
| **Receiving from a chat** | n/a — we call you | Verify the signature we send. |

**You need the bearer token once, not on every request.** Create the webhook with it,
keep the URL it returns, and your unattended system posts to that URL forever with no
`Authorization` header and nothing to refresh. A script sending a bearer token on every
post is calling the wrong endpoint.

### Where the bearer token comes from

Sign in over the API with the same email and password you use in the app:

```bash
curl -X POST https://colab.example.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-password"}'
```

```json
{ "ok": true, "data": {
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "user": { "id": "u_you", "email": "you@example.com", "role": "owner" },
  "sessionId": "18db94f2-abd6-4218-9127-952781ca129d",
  "refreshToken": "rt_9c1f…"
}}
```

`data.token` is the header value: `Authorization: Bearer eyJhbGciOiJIUzI1…`.

### If your account signs in with SSO

**`/api/auth/login` will never work for an SSO account.** It is created with no password
at all, and the login route rejects any account without one — so it answers
`401 "Invalid email or password."` whatever you send. That is the design, not a
misconfiguration.

The token comes from the end of the SSO round-trip instead, and it is the *same* token:

```
1. GET  /api/auth/sso/start        → 302 to your identity provider
2. you authenticate there            ← needs a real browser
3. the IdP redirects back to the app with ?code&state
4. POST /api/auth/sso/callback     { code, state }
5. → { token, user, sessionId, refreshToken }   ← identical shape
```

**Why curl cannot do this alone.** The PKCE verifier is sealed inside the signed `state`
the server minted at step 1, and the IdP session is ended on app logout (`/api/auth/sso/logout`) — which deliberately
pushes you through the provider's login and second factor on every sign-in. Steps 1–3 need
a browser and a human. There is no password grant to fall back on.

**So take the token out of the browser once.** Sign in with SSO as normal, then in the
developer console on that tab:

```js
localStorage.getItem("clb_token")    // → your Bearer value
localStorage.getItem("clb_refresh")  // → keep this, it renews the above
```

Or DevTools → Network → `POST /api/auth/sso/callback` → Response → `data.token`. On the
desktop app the refresh token may live in the OS keychain, but `clb_token` always keeps a
`localStorage` mirror.

**Then you never need the browser again** — `POST /api/auth/refresh` renews with no
identity-provider round-trip, so one SSO sign-in keeps a script running indefinitely as
long as it stores each rotated refresh token. And for webhooks you need a token *once,
ever*: create the webhook, then the ingest URL is the credential.

### For a fully unattended script

Don't scrape a person's SSO session. Have an org admin put a local password on a dedicated
automation account, which turns `/api/auth/login` back on for that one account:

```bash
# admin, once — requires [members:manage]
curl -X POST https://colab.example.com/api/orgs/current/members/u_ci_bot/reset-password \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"password":"a-long-generated-password"}'
```

Add that account only to the conversations it needs — a webhook can never reach further
than its creator can, so a narrow automation account is a real boundary.

### Using Postman

The repository ships a ready collection, so you don't have to build these by hand:

```
docs/colab-webhooks.postman_collection.json    # 18 requests, in the order you run them
docs/colab.postman_environment.json            # the variables they share
```

Import both (Postman → Import → Files), select the environment top-right, and set `baseUrl`
to your deployment **including `/api`** — e.g. `https://colab.example.com/api`.

Collection auth is already `Bearer {{colabToken}}`, and each request saves what the next one
needs (user id, conversation id, webhook id, ingest token), so you can work straight down the
list. Two requests are deliberately set to **No Auth**: signing in, and posting through the
webhook.

**If you sign in with email:** set `colabEmail` and `colabPassword`, then Send
*0 · Get a token / Sign in*. Everything else works immediately.

**If you sign in with SSO:** "Sign in" cannot work for you (no password exists). Instead, in
the browser console on a signed-in CoLab tab, copy `localStorage.getItem("clb_token")` and
`localStorage.getItem("clb_refresh")` into `colabToken` and `colabRefresh`. From then on,
Send *Renew the token* whenever anything returns 401 — no browser again.

**"Renew the token" is the request that keeps you working**, for both account types. It needs
no browser and no identity provider. Refresh tokens are single-use; the collection stores the
rotated one for you.

**Gotcha — the session limit.** CoLab allows a limited number of simultaneous sessions per
account (five by default), and every Send of "Sign in" opens another. Once you hit the limit,
signing in returns your list of sessions instead of a token. The collection handles it: it
marks the least-recently-used session to be replaced, so you just press Send once more. Using
"Renew the token" instead of repeatedly signing in avoids this entirely.

### Lifetime and renewal

The access token is a JWT valid for **7 days** by default (`AUTH_TOKEN_TTL`); after that
management calls return `401`. Exchange the refresh token rather than signing in again —
it is single-use, so store the new one that comes back:

```bash
curl -X POST https://colab.example.com/api/auth/refresh \
  -H 'Content-Type: application/json' -d '{"refreshToken":"rt_9c1f…"}'
# → { "token": "…", "refreshToken": "…", "user": {…} }
```

`GET /api/auth/me` with the header confirms a token is still valid.

### If MFA is on

`/api/auth/login` answers `{ "mfaRequired": true, "challengeId": "…", "methods": ["totp"] }`
with no token. POST `{ challengeId, code }` to `/api/auth/mfa/verify` to get the normal
`{ token, user, refreshToken }` response.

### There are no API keys

The bearer token is always a real person's session, so it expires and carries exactly that
person's access — which is why a webhook can never reach a conversation its creator cannot.
For an unattended system, **the incoming webhook URL is the long-lived credential**. Don't
park a login password in a CI job to mint tokens; create the webhook once by hand and give
the job only its URL.

---

## 3. Quick start — incoming (post into a chat)

Create it (as any member of the conversation):

```bash
# into a GROUP
curl -X POST https://colab.example.com/api/webhooks \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"direction":"in","conversationId":"conv_product","name":"CI Bot"}'

# into your DM with a PARTICULAR USER
curl -X POST https://colab.example.com/api/webhooks \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"direction":"in","userId":"u_emily","name":"Alerts for Emily"}'
```

The response carries the token **once** — it is stored only as a SHA-256 hash and
can never be read back:

```json
{ "ok": true, "data": {
  "webhook": { "id": "…", "scope": "group", "tokenHint": "9Ibh06", … },
  "token": "whin_P5xYiuJAe69EaR_0DTeva18hxu9Ibh06",
  "url": "https://colab.example.com/api/webhooks/in/whin_P5xYiuJAe69EaR_0DTeva18hxu9Ibh06"
}}
```

Then post to it from anywhere, with no authentication header:

```bash
curl -X POST "$URL" -H 'Content-Type: application/json' \
     -d '{"text":"Build #412 failed on main"}'
```

**Body shapes accepted.** So you can point existing tooling at it unchanged:

| Shape             | Example                                 | Result                      |
| ----------------- | --------------------------------------- | --------------------------- |
| CoLab / Slack     | `{"text":"hello"}`                      | `hello`                     |
| Teams-style card  | `{"title":"Deploy","text":"v2 live"}`   | `**Deploy**` then `v2 live` |
| Slack attachments | `{"attachments":[{"text":"…"}]}`        | the attachment text         |
| Aliases           | `message`, `content`, `body`, `summary` | treated as above            |

A body with no usable text is a `400` — it never posts an empty message. Text is
capped at 8000 characters.

The message appears in the conversation as an ordinary message from the webhook's
**owner** (the person who created it). That is deliberate: `messages.sender_id`
is a real user, so a webhook message inherits every normal rule — unread counts,
socket fan-out, push notifications, retention — rather than becoming a second
class of message with its own semantics.

---

## 4. Recipe: a button in another app

Your other product has a "Message on CoLab" button. Someone clicks it and a particular
person gets a chat message.

**How the recipient signs in makes no difference.** SSO or email-and-password, they receive
the message identically — receiving has nothing to do with how you authenticate. Sign-in
method only affects the identity your integration sends *as*, and the answer there is:
neither. Give it its own account.

### Send as the integration, not as the person clicking

Don't post as whoever clicked — it means holding every user's credentials, which is
impossible for SSO accounts anyway (§2). Name the person in the text instead:

```json
{ "title": "Ticket #412",
  "text": "Rajaram asked you to look at this. https://tracker.example.com/t/412" }
```

Same attribution, one account, no user credentials anywhere.

### Once, ever — the integration account

A dedicated account, not a person's. It needs a password, because SSO cannot be automated.
If self-service sign-up is off, an admin creates the member and sets a password with
`POST /api/orgs/current/members/:userId/reset-password`.

```bash
TOKEN=$(curl -s -X POST https://colab.example.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"tracker-bot@example.com","password":"…"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")
```

### Once per recipient — wire them up lazily

All three use the integration account's token.

```bash
# 1. find the CoLab user by the email your apps already share
GET  /api/users/search?q=priya@example.com
     → { "id": "u_priya", "email": "priya@example.com", "name": "Priya Nair" }

# 2. make sure a direct message exists; its id comes straight back
POST /api/invites            { "toUserId": "u_priya" }
     → { "conversationId": "748fbba4-c466-…" }

# 3. create the webhook and STORE ITS URL against that person
POST /api/webhooks           { "direction":"in", "conversationId":"748fbba4-c466-…",
                               "name":"Tracker → Priya" }
     → { "token":"whin_oSze1PpZ…", "url":"https://colab.example.com/api/webhooks/in/whin_…" }
```

### Every click — one POST, no auth

```bash
curl -X POST "$STORED_URL_FOR_PRIYA" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Ticket #412","text":"Rajaram asked you to look at this. https://tracker.example.com/t/412"}'
# → {"ok":true,"data":{"posted":true,"messageId":"215665a3-…"}}
```

### What differs between the two kinds of recipient

Nothing. Find them, create the DM, create the webhook, post on click, they receive it —
identical for an SSO user and an email user. The only place sign-in method matters is the
integration's *own* account, which must be a password account either way.

### Three things to expect

| Behaviour | What to do |
|---|---|
| The first message arrives as a **connection request** (Accept / Decline) if the integration account isn't connected to that person yet. | Expected — the same courtesy gate a person gets. Ask your team to accept "Tracker" once; after that its messages land as ordinary chat. |
| Until accepted, the integration can send **text only**. | Nothing — incoming webhooks only ever send text. |
| The integration account's token expires (7 days). | Only the wiring-up steps use it, once per person. The click path has no token at all. Renew with `/api/auth/refresh`. |

**Add the integration account only where it belongs.** A webhook can never reach further
than the account that created it, so an integration confined to its own DMs cannot read or
post anywhere else even if a webhook URL leaks. Don't make it an org owner for convenience.

---

## 5. Quick start — outgoing (chat to your URL)

```bash
curl -X POST https://colab.example.com/api/webhooks \
  -H "Authorization: Bearer $YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"direction":"out","conversationId":"conv_product",
       "name":"Ops bridge","targetUrl":"https://ops.example.com/colab",
       "events":["message.created"]}'
```

The response carries the signing `secret` once. Every delivery then arrives as:

```
POST /colab HTTP/1.1
Content-Type: application/json
User-Agent: CoLab-Webhooks/1.0
X-CoLab-Event: message.created
X-CoLab-Delivery: a6a80364-f93d-41e9-bcc4-509ebf7ad545
X-CoLab-Webhook-Id: 0ad97ef1-e60a-49ec-a48f-621bf2734881
X-CoLab-Signature: t=1772539134,v1=9f2c…
```

```json
{
  "event": "message.created",
  "timestamp": "2026-09-03T11:58:54.428Z",
  "webhook": { "id": "0ad97ef1-…", "name": "Ops bridge" },
  "conversation": {
    "id": "conv_product",
    "kind": "group",
    "title": "Product Pod"
  },
  "message": {
    "id": "1179ffb2-…",
    "text": "Ship it.",
    "type": "text",
    "createdAt": "2026-09-03T11:58:54.356Z",
    "encrypted": false,
    "sender": { "id": "u_you", "name": "You" },
    "parentMessageId": null,
    "file": null
  }
}
```

`encrypted: true` means the conversation is end-to-end encrypted and the server
holds no readable plaintext — `text` will be `null`. That is stated explicitly
rather than silently shipping an empty message.

### Verifying the signature

The signature covers `"{timestamp}.{exact request body bytes}"`, so verify
against the **raw** body — not a re-serialized parse.

```js
const crypto = require("crypto");

function verify(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=")),
  );
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(parts.v1 || "", "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  // Reject replays of a captured delivery.
  return Math.abs(Date.now() / 1000 - Number(parts.t)) < toleranceSec;
}
```

```python
import hmac, hashlib, time

def verify(raw_body: bytes, header: str, secret: str, tolerance=300) -> bool:
    parts = dict(kv.split("=", 1) for kv in header.split(","))
    expected = hmac.new(secret.encode(), f"{parts['t']}.".encode() + raw_body,
                        hashlib.sha256).hexdigest()
    if not hmac.compare_digest(parts.get("v1", ""), expected):
        return False
    return abs(time.time() - int(parts["t"])) < tolerance
```

### Delivery semantics

- **At-least-once.** De-duplicate on `X-CoLab-Delivery` if a repeat would matter.
- **Retries.** A `5xx`, a `408`/`429`, a timeout, or a connection failure is
  retried with exponential backoff — roughly 30s, 2m, 8m, 32m, then the delivery
  is marked permanently `failed` (`WEBHOOKS_MAX_ATTEMPTS`, default 5).
- **No retry on 4xx.** Any other `4xx` means "this request is wrong", and
  re-sending an identical body will not fix it. It fails immediately and the
  reason lands in the delivery log.
- **Respond fast.** The per-delivery timeout is 8s (`WEBHOOKS_TIMEOUT_MS`).
  Acknowledge with a `2xx` and do your work asynchronously.
- **No redirects.** A `3xx` is not followed — it would sidestep the SSRF check.

---

## 6. API reference

All management routes require a normal session (`Authorization: Bearer …`).

| Method   | Path                             | Purpose                                                   |
| -------- | -------------------------------- | --------------------------------------------------------- |
| `GET`    | `/api/webhooks`                  | Every webhook you own, in conversations you can still see |
| `GET`    | `/api/webhooks?conversationId=…` | Webhooks on that conversation                             |
| `GET`    | `/api/webhooks?userId=…`         | Webhooks on your DM with that person                      |
| `GET`    | `/api/webhooks/events`           | Supported event names + whether the feature is on         |
| `POST`   | `/api/webhooks`                  | Create — returns the credential **once**                  |
| `PATCH`  | `/api/webhooks/:id`              | `{ name?, enabled?, events? }`                            |
| `POST`   | `/api/webhooks/:id/rotate`       | New credential, same id and history                       |
| `POST`   | `/api/webhooks/:id/test`         | Queue a synthetic delivery (outgoing only)                |
| `GET`    | `/api/webhooks/:id/deliveries`   | Recent delivery log with status and error                 |
| `DELETE` | `/api/webhooks/:id`              | Remove                                                    |
| `POST`   | `/api/webhooks/in/:token`        | **The ingest endpoint — no auth**                         |

**Events.** `message.created` (a new message), `message.updated` (an edit — the
payload carries the new text), and `message.deleted` (a soft-delete tombstone;
`text` is cleared, the id lets you match it to what you already received). A
webhook subscribes to any combination; the default is `message.created` alone. An
unrecognised event name is dropped, falling back to `message.created` rather than
leaving the webhook subscribed to nothing.

**Who may manage a webhook.** Its creator, or an `owner`/`admin` of the
conversation — so a group is not held hostage by an integration whose author has
moved on.

---

## 7. Security model

**Incoming tokens are bearer credentials in a URL.** 24 random bytes from
`crypto.randomBytes`, stored only as a SHA-256 hash (a database dump yields no
working endpoint), returned exactly once, and displayed thereafter only as a
6-character hint. Treat the URL like a password: anything that can read it can
post to that conversation. Rotate with `POST /:id/rotate` — the old token dies
immediately and the webhook keeps its id and history.

**Guessing a token tells an attacker nothing.** An unknown token, a disabled
webhook, and a deleted webhook all return an identical `404`.

**A webhook can never exceed its owner's access.** Creation requires membership,
and every single incoming post re-checks it. If the owner leaves or is removed,
the webhook returns `403` from that moment. The same check gates outgoing
deliveries — the payload carries message text, so a hook whose owner has left
stops being fed.

**SSRF.** An outgoing `targetUrl` is a user-supplied URL that the _server_
fetches, which on a corporate network is an SSRF primitive. The host is DNS-
resolved and refused if it lands in loopback, link-local (including
`169.254.169.254`), RFC1918, or CGNAT space — **on every delivery attempt**, not
just at creation, because DNS is mutable. `https` is required in production, and
redirects are never followed. An on-prem deployment whose integration endpoints
genuinely are internal must opt in with `WEBHOOKS_ALLOW_PRIVATE_TARGETS=true`,
which is never the default.

**Rate limits.** Each incoming webhook has a per-minute message budget
(`WEBHOOKS_INGEST_PER_MINUTE`, default 60), the ingest endpoint has a per-IP
ceiling on top, and each conversation caps its total webhooks
(`WEBHOOKS_MAX_PER_CONVERSATION`, default 10) so one member cannot turn a busy
group into an outbound amplifier.

**Loop safety.** A message that _arrived_ through an incoming webhook is **not**
re-emitted to that conversation's outgoing webhooks. Without this, pointing a
conversation's outgoing hook back at its own incoming hook — directly, or via two
systems that bridge each other — is an infinite message loop. If you are building
a genuine two-way bridge, the far side must originate its own messages rather
than echoing what it receives.

---

## 8. Operational shape

Sending a chat message must never wait on someone else's HTTP endpoint. So the
send path does exactly one thing for webhooks: `INSERT` a row into
`chat_webhook_deliveries`. A leader-elected background worker drains that queue
(an enqueue also nudges it, so a healthy endpoint sees the event in about a
second), claims rows atomically so two replicas can never double-send, and
applies the backoff. A dead endpoint therefore costs a chat message nothing.

Housekeeping runs hourly: deliveries left mid-flight by a crashed or redeployed
process are re-armed, and the delivery log — which embeds message text — is
pruned past `WEBHOOKS_DELIVERY_RETENTION_DAYS` (default 30).

Health is visible without reading the log: each webhook carries `lastStatus`,
`lastDeliveryAt`, and a `failureCount` that climbs on failure and resets on the
first success.

### Where the code lives

| Concern                                   | File                                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| Schema                                    | `database/migrations/0115_chat_webhooks.sql`                    |
| Persistence                               | `database/src/drivers/mysql.ts` (`webhooks`), `drivers/json.ts` |
| Authorization, SSRF, signing, queue drain | `backend/app/src/services/webhookService.ts`                    |
| HTTP surface                              | `backend/app/src/routes/webhooks.ts`                            |
| Send-path hook                            | `backend/app/src/services/messageService.ts` (`send`)           |
| Drain + sweep timers                      | `backend/app/src/index.ts`                                      |
| Tests                                     | `backend/app/test/webhooks.test.ts`                             |

### Configuration

Every knob, with defaults, is documented in `.env.example` under
**Chat webhooks**. The master switch is `WEBHOOKS_ENABLED`; setting it false
makes the feature dormant — the ingest endpoint `404`s and no outbound request is
ever made — without removing any code.

---

## 9. Troubleshooting

| Symptom                                         | Cause                                                                      | Fix                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Ingest returns `404`                            | Wrong/rotated/deleted token, webhook disabled, or `WEBHOOKS_ENABLED=false` | Check `GET /api/webhooks`; rotate and re-copy the URL                               |
| Ingest returns `403`                            | The owner is no longer a member of the conversation                        | Re-add them, or recreate the webhook as a current member                            |
| Ingest returns `400`                            | The body had no usable text                                                | Send `{"text":"…"}`                                                                 |
| Ingest returns `429`                            | Past the per-minute budget                                                 | Batch your posts, or raise `WEBHOOKS_INGEST_PER_MINUTE`                             |
| Create rejects the target URL                   | It resolves to private/loopback space, or isn't `https` in production      | Use a public `https` endpoint, or set `WEBHOOKS_ALLOW_PRIVATE_TARGETS=true` on-prem |
| Deliveries stay `pending`                       | Endpoint is down, or the backoff hasn't elapsed                            | Check `GET /:id/deliveries` for the recorded `error`                                |
| Deliveries go straight to `failed` with a `4xx` | Your endpoint rejected the body                                            | 4xx is not retried by design; fix the endpoint, then `POST /:id/test`               |
| Signature never validates                       | Verifying a re-serialized body                                             | Sign the **raw** bytes, and include the `t=` timestamp in the signed string         |
| A bridge floods the conversation                | Your far side echoes what it receives                                      | Only originate; CoLab's own loop guard covers the CoLab side                        |
