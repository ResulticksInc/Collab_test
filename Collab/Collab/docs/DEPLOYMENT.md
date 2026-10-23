# CoLab — Deployment Guide

This guide is for the team deploying CoLab. Pick **one** of the three paths below
based on your infrastructure. All three use Docker Compose.

| Path | Best when | Media | Public access |
|---|---|---|---|
| **A. Cloud + Tunnel** | Fastest; no public server/domain on hand | LiveKit Cloud | Cloudflare Tunnel |
| **B. Self-hosted, public server** | You have a server with a public IP + domain | self-hosted LiveKit + coturn | your TLS reverse proxy |
| **C. Self-hosted, internal/LAN** | Internal-only tool, all users on the corporate network | self-hosted LiveKit + coturn | direct, TLS still required |

> **Two hard rules that apply to every path:**
> 1. **The app must be served over HTTPS.** Browsers block camera / microphone /
>    screen-share on any non-`localhost` page served over plain HTTP. The app's own
>    pre-call Connection Check enforces this.
> 2. **If the page is HTTPS, the LiveKit URL must be `wss://`** (an HTTPS page cannot
>    open an insecure `ws://` socket — browsers block mixed content).

---

## Prerequisites (all paths)

- Docker Engine + Docker Compose v2 on the host.
- **Generate secrets** (do not reuse the placeholders):
  - `AUTH_JWT_SECRET` — 32+ random chars. `openssl rand -hex 32`. The backend
    **refuses to boot in production** if this is short or a known placeholder.
  - LiveKit API key + secret (from LiveKit Cloud, or your own for self-hosted).
- **Database credentials.** A local MySQL container is included (fast, zero-setup).
  To use an existing MySQL, see [Database](#database). Production DB credentials are
  delivered out of band — they are not in this package.

### Container images — two things not to miss

- **Build with the deploy `.env`.** The `frontend` image bakes all `NEXT_PUBLIC_*`
  values (app name, signup flag, etc.) at **build time**. Always `docker compose
  build` on the server (or in CI) *after* placing the production `.env`, so the
  right values are baked in. The `backend` reads everything from env at runtime —
  no rebuild needed for env changes there. Rebuild both whenever source changes:
  `docker compose build backend frontend` (or `up -d --build`).
- **Image versions are pinned for reproducibility.** `mysql:8`, `redis:7-alpine`,
  `livekit:v1.9`, `coturn:4.6` are tag-pinned; `minio` is pinned to
  `RELEASE.2025-09-07T16-13-09Z` (do NOT move to `:latest` — newer MinIO removed the
  admin console the `/minio` route uses); `nginx` is digest-pinned. Bump any of
  these only deliberately, after testing.

---

## Path A — Cloud + Cloudflare Tunnel

Works for users on any network (office, home, mobile) with no public IP, no open
ports, no VPN. The tunnel agent dials *out* to Cloudflare's edge.

1. **LiveKit Cloud** (https://cloud.livekit.io): create a project → Settings → Keys.
   Copy the `wss://<project>.livekit.cloud` URL, API key, and API secret.
2. **Cloudflare Tunnel** (Zero Trust → Networks → Tunnels → create, Cloudflared type):
   copy the tunnel token. Under **Public Hostnames**, add a hostname on your
   Cloudflare domain and set its **Service** to `http://frontend:3000`.
3. **Configure & launch:**
   ```bash
   cp .env.demo .env
   # set in .env: CORS_ORIGINS=https://<your-cf-url>, the LiveKit values, AUTH_JWT_SECRET,
   #              and CLOUDFLARE_TUNNEL_TOKEN
   docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build \
       db redis minio backend frontend cloudflared
   ```
   Listing the services explicitly starts only what LiveKit Cloud needs and skips
   the bundled self-hosted livekit/coturn. (Omitting the list still works — they
   just start unused.)

> No Cloudflare domain? Quick test URL (random, ephemeral, no account):
> `docker run --rm --network colab_default cloudflare/cloudflared tunnel --url http://frontend:3000`
> Update `CORS_ORIGINS` to the printed URL each run.

---

## Path B — Self-hosted on a public server (production)

You have a server with a **public IP** and a **domain**, and you'll terminate TLS
with your own reverse proxy (nginx, Caddy, ALB, etc.).

1. **LiveKit node IP** — edit `infrastructure/livekit/livekit.prod.yaml`:
   keep `use_external_ip: true` (STUN auto-detect, good for cloud VMs with a public
   IP), or replace it with `node_ip: <reachable-ip>` for a NAT'd / private-IP server.
2. **Environment** — `cp .env.example .env`, then set:
   ```ini
   NODE_ENV=production
   AUTH_JWT_SECRET=<generated>
   CORS_ORIGINS=https://app.yourdomain.com
   LIVEKIT_WS_URL=wss://livekit.yourdomain.com    # browser-facing, via your TLS proxy
   LIVEKIT_SERVER_URL=ws://livekit:7534           # internal (backend→SFU)
   LIVEKIT_API_KEY=<key>
   LIVEKIT_API_SECRET=<secret>
   ```
3. **Reverse proxy / TLS** — terminate HTTPS and route:
   - `https://app.yourdomain.com`     → `frontend:3000`  (this proxies `/api` + `/socket.io` to the backend itself)
   - `wss://livekit.yourdomain.com`   → `livekit:7534`   (WebSocket signalling)
   Minimal Caddy example (auto Let's Encrypt):
   ```
   app.yourdomain.com     { reverse_proxy frontend:3000 }
   livekit.yourdomain.com { reverse_proxy livekit:7534 }
   ```
   (A ready-made nginx single-port config is at `infrastructure/nginx/nginx.conf`,
   used by the `production` compose profile — it fronts everything on port 7530.)
4. **Firewall / security group** — open: `443/tcp` (app + livekit signalling via proxy),
   `7531/tcp`, `7532/udp`, `7533/udp` (LiveKit media + built-in TURN). For locked-down
   client networks also expose TURN over TLS on `443` via coturn
   (`infrastructure/coturn/turnserver.conf` — set `external-ip`/`relay-ip` first).
5. **Launch** (the server override mounts `livekit.prod.yaml` with the 753x ports;
   add `--profile production` to also run the nginx single-port reverse proxy):
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build
   ```

---

## Path C — Self-hosted, internal / LAN only

Same as Path B, but `node_ip` is the server's LAN IP and the domain/TLS can be an
internal CA. **HTTPS is still required** (browsers treat a private IP over HTTP as
insecure → no camera/mic). Users not on the corporate network won't be able to reach it.

---

## Database

The included `db` service is MySQL 8, wired to the backend as
`mysql://colab:colab@db:3306/colab` (and a seeded `colab_demo`). It's local to the
host = fast, and isolated. Data persists in the `colab_mysqldata` Docker volume.
Both databases and the app user are created on first container init by
`database/initdb/01-create-databases.sql`.

**Migrations** (41 files in `database/migrations/`) apply **automatically** every time
the backend boots — idempotent, run-once, tracked in a `schema_migrations` table. No
manual step needed. To run them by hand against any DB:
```bash
npm run db:migrate        # reads DATABASE_URL from .env
```

**Using an existing/external MySQL instead of the container:** set `DATABASE_URL`
(and `DEMO_DATABASE_URL`) in `.env` to the external server, and don't start the `db`
service. The app self-provisions the database and schema on first boot if the user
has rights; otherwise create the `colab` database and grant access first. A
non-SUPER user on a binlog-enabled MySQL will skip two defense-in-depth triggers
(migrations 0009, 0018) — harmless, the same checks run in the app layer.

**Seeding:** in live mode (`DEMO_MODE=no`) the workspace starts empty; the first
user signs up and invites others. A populated DB is never re-seeded or overwritten.

---

## Pre-launch verification checklist

```bash
docker compose ... logs -f backend       # "[backend] CoLab V1 API on ... env=production"
docker compose ... logs -f cloudflared   # (Path A) "Registered tunnel connection"
```

Then, from a device on a **different network** (e.g. a phone on mobile data), open the
public URL and:
1. Sign up / log in.
2. Run the in-app **Connection Check** — every row should pass, especially **Secure
   context** and **Media server**. If media passes from mobile data, calls will hold.
3. Send a message, place a 1:1 call, start a meeting, share a screen, swap mic/camera.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Backend exits: "refusing to start … weak/default secrets" | `AUTH_JWT_SECRET` too short or placeholder | Set a 32+ char random value |
| "Calls need HTTPS" in Connection Check | Served over `http://` or by IP | Serve over HTTPS (reverse proxy / tunnel) |
| Camera/mic prompt never appears | Not a secure context | Same as above |
| Call connects but no audio/video across networks | LiveKit `node_ip` wrong, or page is HTTPS but LiveKit is `ws://` | Set correct public `node_ip`; use `wss://` for LiveKit |
| Messages only appear after refresh | Socket.IO handshake rejected by CORS | Set `CORS_ORIGINS` to the exact public URL |
| `cloudflared`: "no ingress rules" | Tunnel public hostname not set | Point its Service at `http://frontend:3000` |
| Large file upload fails | Cloudflare free plan caps uploads at 100 MB | Use a paid plan or Path B for large files |
| Backend stuck "waiting for MySQL" | DB still initializing on first boot | Wait ~60s; check `docker compose logs db` |
