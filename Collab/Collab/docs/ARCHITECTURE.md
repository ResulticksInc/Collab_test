# CoLab V1 — Architecture

## Business-boundary monorepo

```
colab/
  config/          # the ONLY place process.env is read; frozen config object
  shared/          # contracts shared by FE + BE: socket events, http envelope, enums
  database/        # SQL schema + migrations + seeds; MySQL driver + bootstrap
  backend/         # Express + Socket.IO; services/routes/realtime; consumes config + db
  frontend/        # Next 14 app; the root page IS the V1 shell
  mcp/             # MCP capability registry (scaffold — not a running server)
  agents/          # AI Workspace Companion (scaffold — methods throw "not implemented")
  infrastructure/  # docker / deployment assets
  e2e/             # Playwright specs (smoke, a11y, responsive)
  scripts/         # dev.sh, db.sh
  docs/
```

Top-level folders are business boundaries — no `src/`, `services/`, `components/`, `packages/` as repo roots. Cross-boundary imports are enforced by `.dependency-cruiser.cjs` (e.g. frontend may not import backend/database; backend→database is allowed).

## Configuration flow

`.env` → `config/` → application. `config/src/env.ts` is the single boundary where
`process.env` is read; every other module imports the assembled, frozen object from
`@colab/config`. Change ports, URLs, secrets, DB selection, or demo mode via env only.

## Database — MySQL only, self-provisioning

There is **one** driver (`database/src/drivers/mysql.ts`). There is no in-memory
adapter and no `DATABASE_DRIVER` switch; an earlier swappable-driver design was removed.

- `database/src/index.ts` is the factory (returns a single MySQL-backed store) and
  re-exports `ensureDatabase` + `migrate` from `database/src/bootstrap.ts`.
- On boot, `backend/app/src/index.ts` calls `ensureDatabase(url)` (creates the database
  if missing) then `migrate(url)` (applies `database/migrations/*.sql`, all idempotent),
  then `seedIfNeeded()`. The app comes up against a bare MySQL with no manual setup.
- `DEMO_MODE` selects which database the single driver connects to:
  - `DEMO_MODE=yes` → `DEMO_DATABASE_URL` (seeded demo workspace)
  - otherwise → `DATABASE_URL` (live; empty until real data exists — never fabricated)

## Realtime contract (`shared/src/events.ts`)

One source of truth for socket event names, imported by both FE and BE.

- **Messaging:** `conversation:join`, `message:send` → server persists → broadcasts
  `message:new` (`message:updated` / `message:deleted` on edit/delete); `typing` relay;
  `presence:update` on connect/disconnect; per-member unread via `bumpUnread`.
- **Calls (signalling/control plane only — see "Not built"):** a guarded state machine
  over `call:request / accept / decline / cancel / hangup` ↔ `call:incoming / ringing /
accepted / declined / cancelled / ended / missed`. This rings, accepts, and records
  history. **It carries no media.**
- **Invites:** `invite:new` / `invite:updated`; connection requests with
  pending → accepted/declined/blocked, DM membership created only on acceptance.

## Error handling

Routes are created via `backend/app/src/asyncRouter.ts`, which forwards both synchronous
throws and rejected promises to the Express error middleware. A failing handler returns a
JSON error (4xx for known constraint violations) instead of hanging the request. A
process-level `unhandledRejection` / `uncaughtException` net logs and keeps serving.

## Status (honest)

**Real, full-stack, persisted:**

- Password auth (scrypt + per-user salt + constant-time compare + JWT).
- Messaging (send / edit / delete / reactions / bookmarks / paginated history / scoped
  search / typing / presence / unread), broadcast over Socket.IO.
- Invites workflow (state machine above), verified end-to-end over sockets + MySQL.
- Per-user settings; reminders & tasks & meetings CRUD.

**Built but NOT verified here / NOT complete:**

- **Calls media (LiveKit) is built but unverified here.** Room-token issuance, membership
  gating, and the ringing flow are real and committed-tested; the browser media path
  (`getUserMedia`, LiveKit client, screen share, device switch) is wired but cannot be
  exercised in a sandbox (no browser/devices/UDP/SFU). See the Media plane section.
- **Authorization / IDOR is open.** `messageService.history` and others do not check
  conversation membership; `tasks.list()` is global; `role` is never read; logout does not
  revoke the JWT. This is the top blocker and is not yet addressed.
- Attachments are client-built data-URL references (no upload route / object storage).
- Notifications: no table (ephemeral socket events only). `audit_log` exists but nothing
  writes to it. Reminders have no scheduler/recurrence. MCP/agents are scaffolds.
- Business-logic test coverage is thin (Playwright smoke/a11y/responsive only).

## Media plane — all calls via the LiveKit SFU

One media path for everything: 1:1 audio, 1:1 video, group audio/video, and screen share
all run through a self-hosted **LiveKit** SFU (MIT, Docker), coordinated by **Redis**.
Mesh P2P is not used — it cannot do group calls or screen share.

- **Signalling vs media.** Ringing/control (request → incoming → accept/decline/cancel/
  hangup) stays on Socket.IO. Media negotiation (SDP/ICE) happens inside LiveKit; the app
  does not relay SDP/ICE.
- **Room tokens, gated.** The backend mints a LiveKit access token (a JWT signed with the
  API secret) per user via `POST /api/calls/token`, **gated by membership**: a 1:1 token
  (`call_<id>`) requires being a participant in that call; a group token (`conv_<id>`)
  requires conversation membership. This closes the call IDOR — you cannot obtain a token
  for a conversation you are not in. (`services/livekitService.ts` + `routes/calls.ts`;
  tests in `backend/app/test/calls-signalling.test.ts`.)
- **TURN/STUN via coturn.** Self-hosted **coturn** (free, one container) provides TURN so
  calls connect across NAT/VPN/firewalls/WFH, with TURN-over-TLS on 443 for locked-down
  networks. Configured on the LiveKit server side, not per client.
- **Frontend.** `CallModal` connects a LiveKit `Room`, publishes real `getUserMedia`
  tracks, attaches remote tracks to real `<video>`/`<audio>`, shares the screen via
  `getDisplayMedia`, and wires mic/cam/screen toggles + device selection + active-speaker
  indication to actual SDK calls.

**Honest scope boundary.** This delivers the full call feature set and works reliably on
normal networks once TURN is running. It does NOT by itself guarantee carrier-grade
quality for users worldwide — that requires TURN/SFU capacity in multiple regions, a
scaling/bandwidth cost added later as real global traffic justifies it. Regional
scale-out is a documented next phase, not a present claim.

**Not verifiable in this sandbox.** Real media flow (including the relayed TURN path)
needs a reachable LiveKit + coturn + Redis deployment and two browsers on different
networks. By the "proven real before claimed" rule, none of the four media steps (1:1
audio → 1:1 video → group → screen share) are marked done here; that verification is on
deployment. What IS verified here: token issuance, membership gating, ringing signalling,
plus the full gate (typecheck, lint, committed unit tests, build, secrets, security).

## Run

```
cp .env.example .env
npm install
npm run dev            # backend :4000 + frontend :3000  (DEMO_MODE defaults on)
```

MySQL is provisioned and migrated automatically on backend boot. For an explicit
migrate against a chosen database:

```
DEMO_MODE=yes  npm run db:migrate    # demo database
DEMO_MODE=no   npm run db:migrate    # live database
```
