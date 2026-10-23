# CoLab — Deploy Runbook (Test + Live)

**One build runs everywhere.** The app derives its own URLs from the address the
browser loads, so the *same* image runs on localhost, the test server, and the
live server. Nothing is rebuilt per environment. Only **infrastructure** differs,
and only in a few small values below.

Messaging works over plain HTTP already. **Calls/meetings/screen-share need
HTTPS** (browsers block camera/mic without it) **plus** the LiveKit media server
reachable. That's the whole job.

---

## Per-server values (the ONLY differences)

| | Test ("teams") | Live |
|---|---|---|
| User-facing URL | `https://collab.resul.com:3002` | `https://collab.resulticks.com:7524` |
| Server IP (internal) | `10.205.11.8` | `10.200.3.17` |
| TLS cert | self-signed OK for now | real (trusted) cert |
| LiveKit config file | `infrastructure/livekit/livekit.test.yaml` | `infrastructure/livekit/livekit.live.yaml` |
| `.env` → `LIVEKIT_CONFIG_FILE` | `./infrastructure/livekit/livekit.test.yaml` | `./infrastructure/livekit/livekit.live.yaml` |
| `.env` → `PUBLIC_HOST` | `collab.resul.com:3002` | `collab.resulticks.com:7524` |

> The LiveKit config files differ in exactly **one line** — `node_ip` (each
> server's own internal IP). They are already written; just select the right one
> via `LIVEKIT_CONFIG_FILE`.

---

## Keep these env values BLANK (this is what makes it "dynamic")
Filling any of these in bakes a host/port into the build and breaks portability:
- `NEXT_PUBLIC_API_BASE_URL` = *(blank)*
- `NEXT_PUBLIC_SOCKET_URL` = *(blank)*
- `LIVEKIT_WS_URL` = *(blank on test)*  ← backend auto-derives `wss://<host>/livekit`
  - **On LIVE, pin it** for determinism behind the corporate load balancer (one
    fixed domain, so no downside, and it removes the dependency on the LB
    forwarding `X-Forwarded-Proto`):
    `LIVEKIT_WS_URL=wss://collab.resulticks.com/livekit` (add `:7524` if served on that port).

Fill in real secrets: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `AUTH_JWT_SECRET`,
DB + MinIO creds. **`LIVEKIT_API_KEY`/`SECRET` must MATCH between the backend and
the LiveKit service** on that server (a mismatch rejects every call token).

> ⚠️ **Production refuses to boot with default credentials.** The backend now
> fails fast (like the JWT guard) if `AUTH_JWT_SECRET`, `LIVEKIT_API_SECRET`, the
> `DATABASE_URL` password (must not be `colab`/empty), or the S3/MinIO creds are
> the bundled defaults. So set ALL of these to strong values in the live `.env`:
> `AUTH_JWT_SECRET` (≥32 random chars), `DATABASE_URL` + `MYSQL_PASSWORD` +
> `MYSQL_ROOT_PASSWORD` (matching strong password), `MINIO_ROOT_USER` +
> `MINIO_ROOT_PASSWORD` (+ matching `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`),
> `LIVEKIT_API_KEY`/`SECRET`. Never publish ports 3306/9000 on a routable interface.

---

## Steps (per server)

1. **DNS** — confirm the domain resolves to the server's internal IP (table above).
2. **Env** — copy `.env`, set `PUBLIC_HOST` + `LIVEKIT_CONFIG_FILE` (table), fill secrets, leave the BLANK list blank.
3. **TLS** — if using the bundled Caddy: it makes a self-signed cert automatically (test). For live, set a real cert (Let's Encrypt via `CADDY_ACME_EMAIL`, or terminate TLS at your own proxy).
4. **Bring up the stack** —
   ```
   docker compose --env-file .env -f docker-compose.production.yml up -d --build
   ```
5. **Reverse proxy routing** — whatever serves the user-facing port (3002 / 7524) **must** route (bundled Caddy already does all of this):
   - `/livekit*` → LiveKit `:7534`  *(WebSocket upgrade ON)*
   - `/api/*` and `/socket.io/*` → backend `:4000`
   - everything else → frontend
   - **forward `X-Forwarded-Proto: https` and the `Host` header** (without these, calls can't find the media server)
6. **Firewall** — open, reachable from client devices:
   - the web port: **3002** (test) / **7524** (live)
   - LiveKit media: **7531/tcp, 7532/udp, 7533/udp**

---

## Data safety — never lose user data (P0)

**Deploys carry CODE, not data.** Local/test DB rows live in that machine's own
Docker volume — they do NOT travel with images or to live. Live keeps its own
data. The only things that touch the live DB on deploy are **schema migrations
(structure only)** and an idempotent seed-if-empty.

Hard rules:
- ✅ **Always back up the live DB right before deploying/migrating:**
  ```
  docker exec colab-db mysqldump -u colab -pcolab --single-transaction --routines --triggers colab > backup_$(date +%F_%H%M).sql
  ```
- 🚫 **Never** run `docker compose down -v` (the `-v` deletes the data volume = total loss). Use `down` (no `-v`) or just `up -d --build`.
- 🚫 **Never** run `scripts/migrate-db.ts` against a test/live DB — it TRUNCATES every table and replaces it from a local JSON dump. It is a local-dev import only (now guarded to refuse non-loopback targets).
- 🚫 **Never** run `npm run db:seed` / `scripts/db.sh` against a live `DATABASE_URL` — the standalone seeder overwrites the fixed demo accounts (resets their passwords) and injects demo data. It is now guarded to refuse unless `DEMO_MODE=yes` **and** the DB is empty. The production container boot path is safe (guarded `seedIfNeeded`); only the manual CLI was the risk.
- 🚫 **Never** copy `database/dumps/*` or local data onto live. Schema goes via migrations; data is created by real users on live.
- ✅ The MySQL **named volume `colab_mysqldata` persists** across `up --build` / `down`; `initdb/*.sql` runs only on a fresh empty volume (`CREATE … IF NOT EXISTS`), so a redeploy can't wipe an existing DB.
- ✅ Schema changes go **only** through proper migrations (additive `CREATE`/`ALTER`), applied once, tracked.

## Migration safety — avoid a stuck / crash-looping live deploy

Migrations are **additive only** (no data is ever deleted — verified). The runner
now applies each file **statement-by-statement and swallows "already exists"
errors**, so a migration that *fails halfway* and re-runs on the next boot
**resumes from the real failure point instead of crash-looping** on an
already-applied `ADD COLUMN` (verified against all 41 files). This removes the
former crash-loop hazard. Still do the following as defense-in-depth (no
iterate-on-live):

- ✅ **Dry-run migrations on a RESTORED COPY of the live DB before promoting.**
  Restore today's `mysqldump` into a throwaway DB and run `npm run db:migrate`
  against it. If every file applies cleanly there, it will on live. This catches
  a bad/partial migration *offline*, before the gated promotion.
- ✅ **Backup immediately before deploy** (see Data safety) — a half-applied file
  is recoverable only by restore.
- 🛠 **If a deploy DOES crash-loop on a migration:** the DB is half-migrated, not
  lost. Recover by either (a) hand-running the file's remaining statements then
  `INSERT INTO schema_migrations(filename) VALUES('<file>');`, or (b) dropping the
  half-applied objects, before letting it re-run. Then restart the backend.
- ℹ️ New migrations: keep one logical change per file and make each statement
  idempotent (guard `ADD COLUMN` via `INFORMATION_SCHEMA`, like
  `0041_calls_active_idx.sql` does for indexes) so a re-run is harmless.

## Live deploy — pre-flight (what the TEAMS test does NOT prove)

Promotion is **localhost → teams → (manager approval) → live**, and there is no
"iterate on live." Teams validates the *application*, but the items below are
**per-server infra** that teams cannot exercise — clear each on the LIVE host
*before* the approval/deploy window so the live cutover is a non-event:

- [ ] `LIVEKIT_CONFIG_FILE` → `livekit.live.yaml` (node_ip **10.200.3.17**), and that IP is what live clients actually reach.
- [ ] Live firewall opens **7531/tcp, 7532/udp, 7533/udp** + the web port (different network zone than teams).
- [ ] Live's reverse proxy / load balancer routes **`/livekit`** (WS upgrade) and forwards **`X-Forwarded-Proto: https` + `Host`** — OR pin `LIVEKIT_WS_URL` (above) to sidestep it.
- [ ] Real TLS cert valid for `collab.resulticks.com` (on its port); full chain present.
- [ ] Migrations run cleanly on the **live** DB; DB user can create triggers (`--log-bin-trust-function-creators=ON`).
- [ ] `LIVEKIT_API_KEY`/`SECRET` match between backend and LiveKit on live; all BLANK-list values correct.

If teams is fronted by direct Caddy but live sits behind a corporate LB, the LB
is the most likely thing to differ — get its `/livekit` route + headers confirmed
first (or just pin `LIVEKIT_WS_URL`).

## Validation (after deploy)

Open the site over **HTTPS** on two devices, log in as two users, then test:

- [ ] Audio call (A ↔ B)
- [ ] Video call (A ↔ B)
- [ ] Screen share
- [ ] Group call (huddle)
- [ ] Meeting join / leave
- [ ] Cross-network (two different networks/VPN)

## Troubleshooting (F12 console during a call)
- No `wss://…/livekit` connection → **step 5** (proxy `/livekit` route or missing `X-Forwarded-Proto`).
- Connects but "connecting media…" / no audio-video → **node_ip wrong** or **media ports closed** (steps in table + firewall).
- Cert warning blocks the page → **step 3** (TLS).

---

### Note on very locked-down networks
The built-in TURN relay is UDP-only (port 7533). Normal networks (LAN, VPN,
home, mobile) fall back fine to TCP 7531. A *highly* restricted network that
allows only 443 has no media path — this is a rare edge case and an **optional**
later add-on (TURN-over-TLS/443); it requires no app change.
