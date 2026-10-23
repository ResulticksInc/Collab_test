# Unified Connector Engine

> Bridge CoLab conversations with **Slack**, **Microsoft Teams**, **Google Chat** and the
> **WhatsApp Cloud API**, and mirror CoLab meetings onto **Google Calendar** and
> **Outlook (Microsoft 365) Calendar**. One engine, one canonical message format,
> one job queue, one set of loop-prevention rules.

This document is the implementation of the _Unified Connector Engine Architecture
Specification_ on CoLab's stack. Where the spec names PostgreSQL, RabbitMQ/Kafka and
a dedicated Redis lock, CoLab uses what it already runs: MySQL, a DB-backed job queue
with an atomic claim (the same design as chat webhooks), and Redis `SET NX` when
`REDIS_URL` is configured (with an in-process fallback for single-instance
deployments). Nothing new to deploy.

---

## 1. The model in one paragraph

An **account** is one platform credential an organization registers (a Slack app's
bot token, an Entra app registration, a Google service account, a WhatsApp phone
number). A **mapping** links one platform channel to one CoLab conversation; several
mappings on the same conversation is how a Slack channel and a Teams channel end up
bridged to each other _through_ CoLab. Every message that crosses a mapping is
recorded in the **message mapping** table with its platform id and thread, which is
what makes replies thread correctly, edits/deletes find their counterpart, and echoes
get dropped. Calendar accounts need no mapping: every meeting of the organization is
mirrored automatically. All platform calls go through the **job queue**; the chat
send path and the meeting save path only ever INSERT a row.

| Spec concept        | CoLab table                                        |
| ------------------- | -------------------------------------------------- |
| `tenants`           | `organizations` (`organization_id` columns)        |
| `channel_mappings`  | `connector_channel_mappings`                       |
| `thread_mappings`   | `connector_message_mappings`                       |
| `meeting_mappings`  | `connector_meeting_mappings`                       |
| message broker      | `connector_jobs` (atomic claim + backoff)          |
| Redis `SET NX` lock | `services/connectors/idempotency.ts` + UNIQUE keys |

Schema: `database/migrations/0129_connector_engine.sql`.

---

## 2. Architecture

```
 Slack Events API ──┐
 Teams (Graph notifications / Bot Framework) ──┤   POST /api/connectors/in/:platform/:accountId
 Google Chat app endpoint ──┤        (raw body kept for signature verification)
 WhatsApp Cloud webhook ──┘                 │
                                            ▼
                              connectorIngestService.handleInbound
   verify signature → adapter.parseInbound → loop guard → idempotency (Redis NX)
   → mapping lookup → echo guard → messageService.send/edit/remove AS the mapping owner
                                            │
                                            ▼  (socket fan-out: message:new / message:updated)
                              CoLab conversation
                                            │
   messageService.send/edit/remove ─────────┴──► connectorService.dispatch
   meetingService.create/update/cancel/remove ──► connectorService.dispatchMeeting
                                            │ INSERT connector_jobs (dedupe_key UNIQUE)
                                            ▼
                     drain() worker (leader-elected, atomic claim, exponential backoff)
                                            │
            ┌───────────────┬───────────────┼────────────────┬───────────────┐
            ▼               ▼               ▼                ▼               ▼
        Slack Web API   Graph / Bot FW   Google Chat API   WhatsApp Graph   Calendar APIs
```

### Code map

| Path                                                             | Role                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `backend/app/src/services/connectorService.ts`                   | accounts, mappings, outbound dispatch, meeting dispatch, worker, calendar jobs |
| `backend/app/src/services/connectorIngestService.ts`             | inbound pipeline (verify → parse → filter → post)                              |
| `backend/app/src/services/connectors/types.ts`                   | `NormalizedMessage`, `InboundEvent`, adapter interfaces, platform catalog      |
| `backend/app/src/services/connectors/transformer.ts`             | canonical ↔ Slack mrkdwn / Teams HTML / WhatsApp / Google Chat                 |
| `backend/app/src/services/connectors/loopGuard.ts`               | `verifyEventOrigin` (the spec's middleware)                                    |
| `backend/app/src/services/connectors/idempotency.ts`             | Redis `SET NX PX` with in-memory fallback                                      |
| `backend/app/src/services/connectors/credentials.ts`             | AES-256-GCM sealing of stored credentials                                      |
| `backend/app/src/services/connectors/oauth.ts`                   | Entra client-credentials, Google service-account JWT / refresh token           |
| `backend/app/src/services/connectors/adapters/*.ts`              | one adapter per platform                                                       |
| `backend/app/src/routes/connectors.ts`                           | public inbound router + authenticated management router                        |
| `database/src/drivers/mysqlConnectors.ts`, `jsonConnectors.ts`   | persistence (both drivers)                                                     |
| `backend/app/test/connectors-pure.test.ts`, `connectors.test.ts` | unit + DB suites                                                               |

---

## 3. Loop prevention (echo mitigation)

Three independent lines of defence; each is sufficient on its own.

1. **Origin filter** (`loopGuard.verifyEventOrigin`). Every account stores the
   identities the platform assigns to _our_ app (`bot_ids`). An inbound event whose
   sender or bot id is one of them is dropped. `POST /accounts/:id/test` fills these
   in from the platform (Slack `auth.test`), and a Teams bot activity teaches the
   engine its own id from `recipient`.
2. **Message mapping** (`connector_message_mappings`, UNIQUE on `(mapping,
external id)`). Every message we post outward is recorded; an inbound event for an
   id we already know is our own echo. This catches the cases where a platform omits
   its bot flag (Slack `message_changed`, WhatsApp status callbacks).
3. **Source exclusion** (`dispatch({ viaConnectorMappingId })`). A message that
   arrived through mapping X is never dispatched back out through X. It still goes
   to every _other_ mapping on the conversation; that is the multi-platform bridge.

Messages from _other_ bots on the platform are dropped by default; set
`settings.bridgeOtherBots = true` on the account to bridge them.

---

## 4. Payload normalization

The canonical form is CoLab's markdown subset: `**bold**`, `_italic_`, `~~strike~~`,
`` `code` ``, fenced code, `[text](url)`, `> quote`. Adapters convert at the edge:

| Target                | Conversion                                                       |
| --------------------- | ---------------------------------------------------------------- | --------------------------- |
| Slack                 | mrkdwn: `*bold*`, `~strike~`, `<url                              | text>`, `&`/`<`/`>` escaped |
| Teams (Graph)         | HTML body: `<b>`, `<i>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<br>` |
| Teams (Bot Framework) | Markdown (strike removed)                                        |
| WhatsApp              | `*bold*`, `~strike~`, ` ```code``` `, links as `text (url)`      |
| Google Chat           | `*bold*`, `~strike~`, `<url                                      | text>`                      |

The spec's `{ text, boldPhrases }` shape is supported through
`transformer.fromSpecShape` + `toPlatformFormat`.

**Attribution.** A bridged message is posted by the mapping owner on the CoLab side
(a message needs a sender) and by our bot on the platform side, so the original
author rides in the text: `**Sam** _(via Slack)_` / `*Priya* _(via CoLab)_`. A message
that hops twice (Slack → CoLab → Teams) keeps its first header. Slack accounts with
`chat:write.customize` can set `settings.customizeSender = true` to post under the
author's name instead.

---

## 5. Idempotency and delivery guarantees

- **Inbound**: the platform event id is locked with `SET key NX PX` (Redis) or an
  in-process map (`CONNECTORS_DEDUPE_TTL_SEC`, default 24h). Redelivered events are
  dropped. The durable guard is the UNIQUE `(mapping, external_message_id)` key.
- **Outbound**: `connector_jobs.dedupe_key` is UNIQUE. `message.created` and
  `message.deleted` key on `(event, message, mapping)`; `message.updated` also hashes
  the text so each real edit enqueues once. Calendar upserts hash the meeting state.
- **Worker**: `UPDATE … SET status='running', claim_token=? … LIMIT n` is the claim,
  so replicas can never run the same job twice; the leader gate makes that rare, the
  claim makes it correct. Backoff: ~20s, 80s, 5m, 21m, 1h, then permanently failed
  (`CONNECTORS_MAX_ATTEMPTS`). 4xx responses (other than 408/429) fail immediately.
  A crash mid-flight is re-armed by the hourly sweep (`requeueStaleJobs`).
- **Send path cost**: one SELECT and N cheap INSERTs; the HTTP call never happens on
  the request.

---

## 6. Setting up each platform

All management calls need a normal session (`Authorization: Bearer …`). Accounts
require `org:manage` (or the platform `admin` role on a deployment with no
organizations). Mappings follow the chat-webhook rules: any member of the
conversation can create one; only the creator or a conversation admin can manage it.

`GET /api/connectors/platforms` returns the catalog (labels, required credential
fields, where to point the platform). Credentials are write-only: they are sealed
with `CONNECTORS_SECRET` and the API only ever returns a short hint.

### 6.1 Slack

1. Create a Slack app → **OAuth & Permissions**: bot scopes `chat:write`,
   `channels:history`, `groups:history`, `users:read` (and `chat:write.customize` for
   author impersonation). Install to the workspace.
2. **Event Subscriptions** → request URL = the account's `inboundUrl`
   (`/api/connectors/in/slack/<accountId>`); subscribe to `message.channels`,
   `message.groups`. Slack's `url_verification` challenge is answered automatically
   (and only when signed).
3. Register the account:

```bash
curl -X POST $BASE/api/connectors/accounts -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
  "platform": "slack", "name": "Acme Slack",
  "credentials": { "botToken": "xoxb-…", "signingSecret": "…" }
}'
curl -X POST $BASE/api/connectors/accounts/$ACCOUNT/test -H "Authorization: Bearer $TOKEN"
```

4. Map a channel (invite the bot to it first):

```bash
curl -X POST $BASE/api/connectors/mappings -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{
  "accountId": "'$ACCOUNT'", "conversationId": "'$CONV'",
  "externalChannelId": "C0123ABCD", "externalChannelName": "#eng"
}'
```

### 6.2 Microsoft Teams

Credentials: `tenantId`, `clientId`, `clientSecret` of an Entra app registration;
`clientState` (any random string) for Graph change notifications. Two inbound paths
are supported on the same URL:

- **Graph change notifications** (application permissions `ChannelMessage.Read.All`
  / `Chat.Read.All`). Create a subscription whose `notificationUrl` is the account's
  `inboundUrl` and whose `clientState` equals the stored one. The validation
  handshake (`?validationToken=`) is answered automatically. Each notification is
  verified by `clientState`, then the message is fetched.
- **Bot Framework** messaging endpoint (a Teams bot). Activities are verified with
  the Bot Connector JWT (audience = `clientId`). The engine learns the
  `serviceUrl` from the first activity and replies through it; the mapping then
  carries `externalMeta.serviceUrl`.

Outbound uses the Bot Framework when the mapping has a `serviceUrl`, otherwise
Graph: `POST /teams/{team}/channels/{channel}/messages` (HTML body, the spec's
payload), with `externalMeta.teamId` on the mapping. Set `settings.preferGraph =
true` to always use Graph. Scopes from the spec: `ChannelMessage.Read.All`,
`ChannelMessage.Send`, `Chat.ReadWrite`, `Calendars.ReadWrite`.

### 6.3 Google Chat

Credentials: `serviceAccountJson` (the Chat app's service account) and
`projectNumber`. In the Google Cloud console configure the Chat app as an **HTTP
endpoint** pointing at the account's `inboundUrl`. Inbound requests are verified
against Google's JWKS (`chat@system.gserviceaccount.com`, audience = project number).
Outbound posts with the `chat.bot` scope; replies thread with
`messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`. A mapping's channel id is
the space name (`spaces/AAAA`).

### 6.4 WhatsApp Cloud API

Credentials: `accessToken` (system user), `phoneNumberId`, `appSecret`,
`verifyToken`. In the Meta app's WhatsApp → Configuration, set the callback URL to
the account's `inboundUrl` and the verify token; subscribe to `messages`. The GET
handshake answers `hub.challenge`; every POST is verified with
`X-Hub-Signature-256`.

A mapping's channel id is the **counterpart's phone number** (wa_id). A mapping with
channel id `*` is a catch-all inbox: every unmapped number lands in that
conversation (inbound only). WhatsApp has no edit/delete API; those jobs complete as
`unsupported`.

### 6.5 Google Calendar

Credentials: either `serviceAccountJson` (with domain-wide delegation; set
`impersonate` to the organizer mailbox) or `clientId` + `clientSecret` +
`refreshToken`. Optional `calendarId` (default `primary`). Settings:

| Setting                | Default                          | Meaning                                                              |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `autoSyncMeetings`     | `true`                           | mirror every meeting of the org                                      |
| `actAsOrganizer`       | `false`                          | impersonate the meeting host's email instead of `impersonate`        |
| `createMeetLink`       | `true`                           | request a Google Meet link (`conferenceData.createRequest`)          |
| `conferenceType`       | `hangoutsMeet`                   | conference solution key                                              |
| `pullEnabled`          | `true`                           | run the delta pull (`CONNECTORS_CALENDAR_PULL_MINUTES`)              |
| `applyExternalChanges` | `false`                          | write external reschedules/cancellations back onto the CoLab meeting |
| `joinUrlTemplate`      | `<PUBLIC_API_URL>/meetings/{id}` | CoLab link placed in the event description                           |

### 6.6 Outlook Calendar (Microsoft 365)

Credentials: `tenantId`, `clientId`, `clientSecret` (application permission
`Calendars.ReadWrite`), `organizerEmail` (the mailbox events are created on; with
`settings.actAsOrganizer = true` the meeting host's mailbox is used). Events are
created with `isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness"` (a
Teams link comes back as `joinUrl`). Same settings table as Google Calendar minus the
Meet-specific ones. Delta uses `calendarView/delta` with a stored delta link.

---

## 7. Calendar sync semantics

- `meetingService.create / update / cancel / remove` call `dispatchMeeting`, which
  enqueues `calendar.upsert` / `calendar.delete` for every enabled calendar account
  of the meeting's organization. Identical meeting state never enqueues twice.
- The worker re-reads the meeting at run time (fresh data), builds the event (title,
  description + CoLab join link, location, UTC start/end, organizer, attendee
  emails), and creates or patches the external event. `connector_meeting_mappings`
  stores the external id, join URL and the times we pushed.
- Recurring series are mirrored as their anchor occurrence (no RRULE yet).
- **Delta pull** (`calendar.pull`, every `CONNECTORS_CALENDAR_PULL_MINUTES`, or
  `POST /api/connectors/accounts/:id/pull`): the platform's changes are compared
  against the mapping's stored times (the spec's compare-before-write). By default
  drift is only _recorded_ (`lastStatus = drifted | removed_externally`); with
  `applyExternalChanges = true` the CoLab meeting is rescheduled/cancelled to match.
- `GET /api/connectors/meetings/:meetingId/mappings` shows where a meeting landed.

---

## 8. API reference

| Method & path                                           | Auth                         | Purpose                                                                                                       |
| ------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `POST/GET /api/connectors/in/:platform/:accountId`      | none (verified per platform) | platform webhook                                                                                              |
| `GET /api/connectors/platforms`                         | session                      | catalog + required fields                                                                                     |
| `GET/POST /api/connectors/accounts`                     | org admin                    | list / create (credentials write-only)                                                                        |
| `GET/PATCH/DELETE /api/connectors/accounts/:id`         | org admin                    | detail (+ job counts) / update (rotate one secret at a time) / remove                                         |
| `POST /api/connectors/accounts/:id/test`                | org admin                    | live credential check; learns bot ids                                                                         |
| `GET /api/connectors/accounts/:id/mappings`             | org admin                    | every mapping on the account                                                                                  |
| `GET /api/connectors/accounts/:id/jobs?status=`         | org admin                    | job log (metadata only)                                                                                       |
| `POST /api/connectors/accounts/:id/pull`                | org admin                    | calendar delta pull now                                                                                       |
| `POST /api/connectors/jobs/:id/retry`                   | org admin                    | re-arm a failed job                                                                                           |
| `GET /api/connectors/mappings?conversationId=\|userId=` | member                       | mappings on a conversation / my DM / all mine                                                                 |
| `POST /api/connectors/mappings`                         | member                       | `{ accountId, conversationId \| userId, externalChannelId, externalChannelName?, externalMeta?, direction? }` |
| `PATCH/DELETE /api/connectors/mappings/:id`             | creator / conv admin         | update (`enabled`, `direction`, meta) / remove                                                                |
| `POST /api/connectors/mappings/:id/test`                | creator / conv admin         | queue a synthetic post                                                                                        |
| `GET /api/connectors/meetings/:meetingId/mappings`      | host / invitee               | external calendar events of a meeting                                                                         |

`direction` on a mapping is `both` (default), `inbound` or `outbound`.

---

## 9. Security posture

- **Credentials** are sealed (HKDF → AES-256-GCM) under `CONNECTORS_SECRET`
  (fallback `AUTH_JWT_SECRET`); a DB dump yields no usable token; the API never
  returns one; `PATCH` merges so a single secret can be rotated.
- **Inbound** is fail-closed: Slack HMAC (5-minute replay window), Graph
  `clientState` (constant-time compare), Bot Framework and Google Chat JWTs against
  the vendors' JWKS, WhatsApp HMAC over the raw body. `CONNECTORS_INSECURE_SKIP_VERIFY`
  exists for local fixtures only. Unknown/disabled accounts and wrong platforms are
  all a 404 so probes learn nothing.
- **Authorization** mirrors chat webhooks: a mapping is never more privileged than
  its owner, whose membership is re-checked on every bridged message in both
  directions; accounts are tenant-scoped and admin-only.
- **E2EE conversations are never bridged** (no server-readable plaintext).
- **Outbound targets are fixed vendor hosts** (no user-supplied URLs), every call has
  a hard timeout, redirects are not followed, query strings are stripped from logs.
- **Logs** carry ids and statuses, not message text; the job log endpoint strips
  payloads; finished jobs are pruned after `CONNECTORS_JOB_RETENTION_DAYS`.
- **Rate limits**: per-IP on the public endpoint (`CONNECTORS_INBOUND_IP_RATE_MAX`),
  per-account per minute (`CONNECTORS_INBOUND_PER_MINUTE`), per-conversation mapping
  cap.

---

## 10. Operating it

- `CONNECTORS_ENABLED=false` makes the whole feature dormant without removing code.
- Health: `connector_accounts.last_status / failure_count` and the same on mappings;
  `GET /accounts/:id` includes job counts by status. `lastStatus` values worth
  knowing: `bad_signature`, `bad_credentials`, `owner_not_member`, `HTTP 4xx`.
- Multi-replica: set `REDIS_URL` (already required in production) so the inbound
  dedupe is shared; the queue claim is correct regardless.
- Tests: `node --import tsx --test backend/app/test/connectors-pure.test.ts` (no DB)
  and `backend/app/test/connectors.test.ts` (MySQL, every platform call stubbed).

### Not in this iteration

- A settings UI (the API is complete; the admin console does not render it yet).
- File/attachment transfer across platforms (names and links are relayed, bytes are not).
- Recurring meetings as native recurrences on the external calendar.
- Reactions and read receipts.
