# Cloudflare edge deployment (`colab-edge`)

The Worker serves the CoLab SPA and fronts the CoLab application API that runs on
**https://collab-uat.resulticks.com**. It holds **no database connectivity**: no MySQL driver, no DB gateway,
no tunnel, no VPC binding and no backend container. All data comes from the application API, either
reverse-proxied as-is or read through the [External Data API](../docs/EXTERNAL_DATA_API.html).

| Piece | Where | Notes |
|---|---|---|
| Static SPA | Cloudflare Workers Assets | built from `frontend/app` with `npm run build:web` → `frontend/app/out` |
| Reverse proxy | `src/upstream.ts` | `/api/*`, `/socket.io/*` (incl. WebSocket upgrades), `/uploads/*` → `API_ORIGIN` |
| Worker-side API | `src/edgeApi.ts` + `src/externalApi.ts` | `/api/edge/*`, answered in the Worker from `<API_ORIGIN>/api/external/v1` with the key `COLAB_API_KEY` |
| Application API + MySQL | `API_ORIGIN` (UAT) | not part of this deployment |

```
browser ──► Worker (collabedg.resulticks.com)
              ├─ assets            frontend/app/out
              ├─ /api/edge/*       External Data API  (X-API-Key)      ─┐
              └─ /api, /socket.io, /uploads   reverse proxy            ─┴─► https://collab-uat.resulticks.com
```

Public URL: https://collabedg.resulticks.com (custom domain route). Account: Resulticks Global Companies Pte Limited.

## Configuration

| Name | Kind | Where | Meaning |
|---|---|---|---|
| `API_ORIGIN` | var | `wrangler.jsonc` | Application API host. Proxy target and External Data API host. Default in code: `https://collab-uat.resulticks.com`. |
| `COLAB_API_KEY` | **secret** | dashboard (Workers & Pages → colab-edge → Settings → Variables and Secrets) or `wrangler secret put COLAB_API_KEY` | External Data API key (`colab_…`). Needs the read scopes `users:read`, `conversations:read`, `messages:read`, `tables:read` (= `read`). Mint it as an org admin: `POST /api/orgs/current/api-keys` (docs §02). |
| `COLAB_ORG_ID` | var | `wrangler.jsonc` (optional) | Only for a *platform* key: sent as `X-Org-Id` so `/api/edge/*` reads one organization. An org key is already pinned. |

`keep_vars: true` means a deploy does **not** delete variables added in the dashboard; a var in
`wrangler.jsonc` overrides the dashboard value of the same name. Never put the key in the tracked file.

Variables that used to feed the backend container (`AUTH_JWT_SECRET`, `LIVEKIT_*`, `SSO_*`, `DB_API_*`, …)
are no longer read by the Worker; they belong to the deployment that runs the application API.

## Deploy

```bash
# prerequisites: `wrangler whoami` shows the Resulticks account (Node 24, cloudflare/node_modules installed)
cd cloudflare
npm install
npm run build:web              # rebuild the SPA (skip if frontend/app/out is current)
npx wrangler deploy --keep-vars
```

No Docker is involved any more. The first deploy after this change also runs the Durable Object migration
`v2` (`deleted_classes: ["BackendContainer"]`) that removes the old backend-container object.

## Verify

```bash
curl -s https://collabedg.resulticks.com/api/health/ready | python3 -m json.tool   # proxied from API_ORIGIN
curl -s https://collabedg.resulticks.com/api/edge/health | python3 -m json.tool    # Worker → External Data API
```

`/api/edge/health` answers `ok: true` with the key's organization and scopes when `COLAB_API_KEY` is valid.
`ok: false` + `error.code`:

* `MISCONFIGURED` — the secret is missing, or the External API rejected it (unknown / revoked / expired key).
* `UPSTREAM_UNREACHABLE` / `external.ok: false` — `API_ORIGIN` is down (the proxy routes answer `502 UPSTREAM_UNAVAILABLE` then).
* `FORBIDDEN_SCOPE` on a route — the key lacks one of the read scopes above.

Logs: `npx wrangler tail colab-edge --format pretty` (`[proxy]` and `[edge-api]` lines; never the key).

## Worker-side API: `/api/edge/*`

Every route runs as the signed-in CoLab user: send the app's bearer token (`Authorization: Bearer …`).
The Worker validates it against the application API (`GET /api/auth/me`, so revoked/expired sessions are
rejected) and caches the answer for 30 s. Responses use CoLab's envelope `{ ok, data, meta? }` /
`{ ok:false, error:{ code, message } }`.

| Method | Path | Source | What |
|---|---|---|---|
| GET | `/api/edge/health` | External API `/health` + `/ping` | reachability, key, organization, scopes |
| GET | `/api/edge/me` | `GET /users/{id}` | caller's profile (External API user object) |
| PATCH | `/api/edge/me` | app API `PATCH /api/users/me` as the caller | `about`, `name`, `title`, `pronouns`, `phone`, `timezone`, `avatarUrl` (no profile write exists in the External API) |
| GET | `/api/edge/users?q=&limit=&offset=` | `GET /users` | directory search; never password hashes or avatars |
| GET | `/api/edge/conversations` | `GET /tables/conversation_members?filter[user_id]=` joined with `GET /conversations` | caller's memberships with `memberRole`, `lastReadAt`, `memberCount`, `lastMessageAt`, newest activity first |
| GET | `/api/edge/conversations/:id/messages?limit=&before=` | `GET /conversations/{id}/members` (membership check + sender names), `GET /tables/messages` (cursor), `GET /conversations/{id}/messages?order=desc&until=` | newest first, keyset paged (`meta.nextBefore`); E2EE messages arrive with `encrypted: true` and `body: null` |
| POST | `/api/edge/conversations/:id/read` | app API `POST /api/conversations/{id}/read` as the caller | mark read; the backend fans the receipt out over Socket.IO |

Column-level fields that the External API does not expose (unread counters, starred/muted/hidden flags,
avatars) are not available on these routes; the SPA keeps using the proxied `/api/*` for those.

## Local development

```bash
cd cloudflare
cp .dev.vars.example .dev.vars        # API_ORIGIN + COLAB_API_KEY (gitignored)
npm run dev                           # http://127.0.0.1:8787 — SPA + proxy + /api/edge/*
npm run typecheck
```

`wrangler dev` runs the Worker locally against the real `API_ORIGIN`; nothing else needs to run on this
machine. The last full check (2026-10-14) exercised every `/api/edge/*` route against a stand-in of the
External API, then the proxy against the live UAT host: `/api/health/ready`, `POST /api/auth/login`,
the Socket.IO polling handshake and a WebSocket upgrade all passed through unchanged.
