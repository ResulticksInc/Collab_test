# Environment Profiles — local / teams / live

CoLab promotes through three environments. Each has a ready-made profile file you
copy to `.env`. **One build runs everywhere** — only these env values differ.

## Switch profile (one command)

```bash
# pick ONE, copy it to .env, then run/deploy
cp .env.local  .env     # your machine (dev)
cp .env.teams  .env     # teams test server
cp .env.live   .env     # live / production
```
(Windows: `copy .env.local .env`)

A tiny helper is also provided: `scripts/use-profile.sh local|teams|live`
(and `scripts/use-profile.ps1`).

## At a glance

| | **local** | **teams** (test) | **live** (prod) |
|---|---|---|---|
| Profile file | `.env.local` | `.env.teams` | `.env.live` |
| Domain | localhost | `collab.resul.team` | `collab.resulticks.com` |
| Server IP | — | `10.205.11.8` | `10.200.3.17` |
| **Frontend port** | `3002` | **`7520`** | **`7524`** |
| NODE_ENV | development | production | production |
| Database | bundled local MySQL (`colab:colab`) | live DB as **`res_apdev2945`** | live DB as **`res_apdev2945`** |
| LiveKit node_ip | localhost | `10.205.11.8` (`livekit.test.yaml`) | `10.200.3.17` (`livekit.live.yaml`) |
| One API gateway | **off** | **off** | **off** |
| Secrets | dev values (fine) | must be real (guard enforces) | must be real (guard enforces) |

The frontend port is honoured by `docker-compose.yml` via `FRONTEND_PORT`, so
changing profiles changes the port automatically.

## Fill these before teams/live boot (`CHANGE_ME_*`)

Production refuses to start on default/placeholder secrets (the boot guard). In
`.env.teams` / `.env.live` set:
- `DATABASE_URL` / `DEMO_DATABASE_URL` — the DBA-provisioned user **`res_apdev2945`**
  password + the live DB host. Grants already in place:
  `GRANT ALL PRIVILEGES ON colab.*` and `ON colab_demo.*` to `res_apdev2945@'%'`.
- `AUTH_JWT_SECRET` — strong random (≥32 chars; live should be unique).
- `LIVEKIT_API_SECRET` — the real LiveKit secret (must match the LiveKit service).
- `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` (+ matching `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`).
- `FILE_STORAGE_ORDER` / `FILE_STORAGE_DIR` / `FILE_STORAGE_MIN_FREE_BYTES` and `FILE_TIER_*` — upload tier chain (disk → MinIO → MySQL ≤ 8 MB) and the cold-tier job; see `docs/FILE_UPLOAD_STORAGE_CHAIN.md`.

## DB target rule

- **local** → bundled local MySQL. (Switch to the live DB by editing `DATABASE_URL`.)
- **teams / live** → the **live DB** as `res_apdev2945`, never localhost data.

## One API gateway switch

`ONE_API_ENABLED=false` in every profile by default — the DB team flagged the
gateway as a performance hit, and it's a **structured-JSON helper, not the primary
data path** (it can't express CoLab's FULLTEXT/window/upsert/transaction queries).
CoLab's own data always uses the direct MySQL connection. Flip `ONE_API_ENABLED=true`
only to use the explicit structured helper for specific calls. See
[docs/ONE_API.md](ONE_API.md).

## Calls/HTTPS reminder

Calls/meetings need a **secure context (HTTPS)** + the `/livekit` route. Plain
`http://IP:PORT` serves chat fine but blocks camera/mic. For calls on teams/live,
front the app with the HTTPS/Caddy path (see [docs/DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md)).
