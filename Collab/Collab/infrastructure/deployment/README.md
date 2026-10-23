# CoLab Production Deployment

## Port Architecture

Only 4 ports exposed on the firewall in the 753x range:

| Host Port | Service      | Protocol | Purpose                    |
|-----------|--------------|----------|----------------------------|
| 7530      | nginx        | TCP      | Reverse proxy (all HTTP/WS) |
| 7531      | LiveKit ICE  | TCP      | WebRTC media fallback      |
| 7532      | LiveKit ICE  | UDP      | WebRTC media transport     |
| 7533      | LiveKit TURN | UDP      | NAT traversal relay        |

All other services (MySQL 3306, MinIO 9000-9001, backend 4000, frontend 3002)
use default ports but are **not exposed on the firewall** — they are accessed
through the nginx reverse proxy or Docker internal network.

## Routing

```
Browser → http://collab.resul.team:7530
                ↓
       nginx (port 7530)
                ↓
    ┌──────┬──────┬───────┬──────┬──────┐
    /api  /socket /livekit /minio  /
    │      │       │       │      │
    ▼      ▼       ▼       ▼      ▼
 backend backend livekit minio frontend
 :4000   :4000   :7534   :9000  :3000
         (WS)    (WS)             (SSR)
```

## Deploy

```bash
# 1. Configure environment
cp .env.production .env
# Edit .env: set secrets (JWT, LiveKit, DB, MinIO passwords)
# UPDATE CORS_ORIGINS to match the actual deployment hostname:
#   CORS_ORIGINS=http://localhost:7530,http://collab.resul.team:7530,https://collab.resul.team

# 2. Fix LiveKit node_ip for production
sed -i 's/^node_ip: 127.0.0.1/# node_ip: 127.0.0.1/' infrastructure/livekit/livekit.yaml

# 3. Build and deploy with production profile
docker compose --profile production up -d --build

# 4. Verify — API health + page loads
curl -s http://localhost:7530/api/health | head -c 200
curl -o /dev/null -s -w "%{http_code}\n" http://localhost:7530
```

## Firewall Rules

Open these ports in the server firewall:

| Port | Protocol | Allow From     | Purpose            |
|------|----------|----------------|--------------------|
| 7530 | TCP      | VPN / proxy    | HTTP + WebSocket   |
| 7531 | TCP      | Any (0.0.0.0)  | WebRTC TCP fallback|
| 7532 | UDP      | Any (0.0.0.0)  | WebRTC media       |
| 7533 | UDP      | Any (0.0.0.0)  | TURN relay         |

## URLs

| Endpoint                          | Description       |
|-----------------------------------|-------------------|
| http://collab.resul.team:7530     | Main application  |
| http://collab.resul.team:7530/api/health | Health check  |
| http://collab.resul.team:7530/minio/    | MinIO admin       |

## Environment Variables

See `.env.production` for all required variables.

Key variables that must match production:
- `CORS_ORIGINS` — must include the actual browser origin (update if hostname differs)
- `LIVEKIT_WS_URL=ws://collab.resul.team:7530/livekit` — goes through nginx at `/livekit`
- `S3_PUBLIC_ENDPOINT=https://collab.resul.team`
