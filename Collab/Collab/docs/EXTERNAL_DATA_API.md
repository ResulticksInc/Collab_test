# External Data API — read CoLab's MySQL data from another platform

> **Full integrator guide (start here): [`docs/EXTERNAL_DATA_API.html`](EXTERNAL_DATA_API.html).**
> This page is the short engineering reference for the same feature.

Other platforms (a CRM, a BI tool, a reporting job, a partner system) **read** a
CoLab organization's data and **act** in it (send / receive messages, calls,
meetings) over HTTPS with an **API key** instead of a person's session. Reads
are JSON, paginated, and pinned to the key's organization before they reach
MySQL. Writes run *as* a CoLab user (the key's actor) through the app's own
services, so realtime, push, notifications and outgoing webhooks all fire.

| | |
| --- | --- |
| Base URL | `https://<colab-host>/api/external/v1` |
| Auth | `X-API-Key: colab_…` (or `Authorization: ApiKey colab_…` / `Bearer colab_…`) |
| Discovery | `GET /api/external/v1/openapi.json` (public), `GET /health` (public) |
| Who am I | `GET /ping` → key, organization, scopes |
| Envelope | `{ ok:true, data, meta? }` / `{ ok:false, error:{ code, message } }` |
| Paging | `limit` (default 100, max 500), `offset`; `meta.hasMore`, `meta.nextOffset` |
| Dates | ISO-8601 UTC in and out |

## Endpoints

| Path | Scope | Filters |
| --- | --- | --- |
| `GET /users`, `/users/{id}` | `users:read` | `q`, `since` |
| `GET /conversations`, `/conversations/{id}`, `/conversations/{id}/members` | `conversations:read` | `kind`, `since` |
| `GET /conversations/{id}/messages`, `GET /messages` | `messages:read` | `conversationId`, `senderId`, `since`, `until`, `order` |
| `GET /meetings`, `/meetings/{id}` | `meetings:read` | `from`, `to`, `status` |
| `GET /tasks`, `/tasks/{id}` | `tasks:read` | `status`, `priority`, `assigneeId`, `reporterId`, `projectId`, `parentTaskId`, `updatedSince`, `dueBefore` |
| `GET /files`, `/files/{id}` | `files:read` | `conversationId`, `uploaderId`, `since` (metadata only) |
| `GET /tables`, `GET /tables/{name}` | `tables:read` | `columns`, `filter[col]`, `since`, `until`, `orderBy`, `order` |

### Write endpoints (act as the key's actor, or `asUserId` / `asUserEmail`)

| Path | Scope | Body |
| --- | --- | --- |
| `POST /messages` | `messages:write` | `conversationId \| userId \| email`, `text`, `parentMessageId?`, `important?` — a person target opens/reuses the actor's DM |
| `POST /conversations/{id}/messages` | `messages:write` | `text`, `parentMessageId?`, `important?` |
| `GET/POST /webhooks`, `POST /webhooks/{id}/test`, `GET /webhooks/{id}/deliveries`, `DELETE /webhooks/{id}` | `webhooks:write` | `conversationId \| userId \| email`, `targetUrl`, `events?`, `name?` → outgoing chat-webhook subscription owned by the actor (secret returned once; payload/signature per `docs/CHAT_WEBHOOKS.md`) |
| `POST /calls` | `calls:write` | `userId \| email \| peerId`, `kind? audio\|video`, `conversationId?` → rings the callee via the real call signalling; returns `{ call, join:{token,wsUrl,room} }`; `409 BUSY` |
| `GET /calls`, `GET /calls/{id}`, `POST /calls/{id}/accept\|decline\|hangup\|token`, `POST /conversations/{id}/call-token` | `calls:write` | accept/decline default to the callee, hangup to the caller; tokens are LiveKit room tokens |
| `POST /meetings`, `POST /meetings/{id}/token` | `meetings:write` | `title`, `startsAt`, `durationMin?`, `attendees[]` (ids or emails), `conversationId?`, `description?`, `location?`, `timeZone?` → invites + host join token; `/token` honours lock / eject / lobby |

`/tables/{name}` reads raw rows from an **allow-list** of tables/columns
(`TABLES` in `externalApiService.ts`): organizations, organization_members,
teams, team_members, users, conversations, conversation_members, messages,
meetings, meeting_attendees, tasks, task_projects, task_assignees,
task_comments, files, reminders, calls. Secrets, ciphertext, blobs and
soft-deleted rows are never readable.

## Keys

| | Org admin (session + `org:manage`) | Admin portal (admin token) |
| --- | --- | --- |
| List | `GET /api/orgs/current/api-keys` | `GET /api/admin/api-keys?organizationId=…` / `?platform=true` |
| Create | `POST /api/orgs/current/api-keys` `{ name, scopes?, expiresAt? }` | `POST /api/admin/api-keys` `{ name, organizationId?, scopes?, expiresAt? }` |
| Rotate | `POST /api/orgs/current/api-keys/{id}/rotate` | `POST /api/admin/api-keys/{id}/rotate` |
| Revoke | `DELETE /api/orgs/current/api-keys/{id}` | `DELETE /api/admin/api-keys/{id}` |

- The raw key is returned **once** (`data.key`); the table stores a sha256 hash
  and a 6-char hint (`external_api_keys`, migration `0130`).
- `organizationId` omitted on the admin route → a **platform key** that sees
  every organization and narrows per request with `X-Org-Id`.
- `EXTERNAL_API_KEYS` (env) = static platform keys for bootstrap only.
- Scopes: `read` (all reads), `write` (all writes), `all`, or any of
  `users:read`, `conversations:read`, `messages:read`, `meetings:read`,
  `tasks:read`, `files:read`, `tables:read`, `messages:write`, `calls:write`,
  `meetings:write`, `webhooks:write`.
- `userId` at mint = the key's default **actor** for writes (must be a live
  user and, for an org key, an active member). Per request `asUserId` /
  `asUserEmail` override it under the same rule (`403 ACTOR_NOT_IN_ORG`,
  `400 ACTOR_REQUIRED` / `ACTOR_NOT_FOUND`).
- Org-admin create/rotate/revoke is audited as `org.api_key.*`.

## Tenant rules

- An **org key** is pinned to its organization: every SQL predicate carries
  `organization_id = ?`; other tenants' ids 404. Rows with a NULL organization
  (pre-organization data) are *not* visible to an org key.
- A **platform key** sees everything (including NULL-org rows) unless it sends
  `X-Org-Id`.
- Unknown / revoked / rotated-away / expired keys all 401 identically. Verified
  keys are cached for 30 s per process; revoke/rotate clears the cache locally.

## Errors

`400 BAD_REQUEST | INVALID_COLUMN | INVALID_FILTER | INVALID_ORDER | INVALID_SCOPE`,
`401 UNAUTHORIZED`, `403 FORBIDDEN_SCOPE` (`error.details.required`),
`403 ACTOR_NOT_IN_ORG | BLOCKED | FORBIDDEN | CALL_ENDED | MEETING_LOCKED | MEETING_EJECTED | MEETING_LOBBY`,
`404 NOT_FOUND`, `409 BUSY`, `429 RATE_LIMITED` (+ `Retry-After`), `503 UNAVAILABLE`
(no MySQL pool, e.g. `DATABASE_DRIVER=json`).

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `EXTERNAL_API_ENABLED` | `true` | Master switch; `false` → every route 404s. |
| `EXTERNAL_API_KEYS` | — | Comma-separated static platform keys. |
| `EXTERNAL_API_RATE_MAX` | `300` | Requests / minute / key. |
| `EXTERNAL_API_PAGE_SIZE` | `100` | Default `limit`. |
| `EXTERNAL_API_MAX_PAGE_SIZE` | `500` | Cap on `limit`. |
| `PUBLIC_API_URL` | — | Base URL advertised in `openapi.json`. |

## Code map

| File | Role |
| --- | --- |
| `backend/app/src/routes/external.ts` | Routes, per-key rate limit, OpenAPI document. |
| `backend/app/src/middleware/apiKeyAuth.ts` | Key resolution, tenant pinning, `requireScope`. |
| `backend/app/src/services/externalApiService.ts` | Key CRUD + all SQL readers + table allow-list. |
| `backend/app/src/routes/orgs.ts` / `admin.ts` | Key management endpoints. |
| `database/migrations/0130_external_api_keys.sql`, `0131_external_api_keys_actor.sql` | Key table + actor column. |
| `backend/app/src/realtime/socket.ts` `requestDirectCall` / `hangupDirectCall` | Socket-less mirrors of the call ring / hangup flow used by the API. |
| `backend/app/test/external-api.test.ts` | HTTP-level suite (tenant isolation, scopes, E2EE, allow-list, rotate/revoke). |
| `docs/colab-external-api.postman_collection.json` | Postman collection. |

Run the tests: `TEST_DATABASE_URL=mysql://root:colab@127.0.0.1:3306/colab_test node --import tsx --test backend/app/test/external-api.test.ts`.
