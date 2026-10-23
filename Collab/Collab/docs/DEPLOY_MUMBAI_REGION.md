# Move the call-media engine to a region near users (e.g. Mumbai)

**Why:** an SFU is not peer-to-peer — every call's audio/video flows
`client → SFU → client`. With the SFU + TURN in **us-east** and users in **India**,
even two people in the same room get the full transcontinental round trip
(~200–300 ms). Moving **only the media engine** (LiveKit SFU + coturn TURN) to a
GCP region near the users (`asia-south1` / Mumbai) drops that to ~20–40 ms.

**No application code changes** — the app routes LiveKit + TURN entirely through
env/config. This is a config + new-box job.

## What moves vs what stays
ONE self-contained media server moves; the stable US-East stack is untouched. No
duplicate LiveKit/TURN copies across regions — exactly one of each, in Mumbai.
```
   US-East (17 server) — UNCHANGED            Mumbai — NEW media server
  ┌─────────────────────────────────┐       ┌─────────────────────────────┐
  │ nginx · frontend · backend       │       │ LiveKit (SFU)               │
  │ database · messages · files      │  ───▶ │ coturn (TURN)               │
  │ app Redis (huddleStore)          │ signal│ Redis (LiveKit room state)  │
  └─────────────────────────────────┘ /livekit└────────────▲───────────────┘
                                                call MEDIA goes here directly
                                                (the ~250ms → ~30ms win)
```
- **Media** (RTP/ICE) → client ↔ **Mumbai** directly. ← the fix.
- **Signalling** (`/livekit`) stays on `collab.resulticks.com` (17's nginx proxies
  it to the Mumbai SFU — a one-time setup hop, not latency-critical), so you reuse
  the existing cert and keep coturn's `:443` free.
- **Untouched on US-East:** frontend, backend, **database, authentication,
  messaging, file storage, and the app's own Redis** — all the currently-stable
  pieces. You only relocate the media engine.
- **Two Redises, each next to its user:** the Mumbai Redis is LiveKit's room state
  (+ future multi-node SFU scaling); the US-East Redis is the app's huddleStore.
  Do NOT move the app's — that would make group-call/hand ops cross-region.

## Prerequisites
- A GCP VM in `asia-south1` with a **real inbound external IP** (1:1, not egress
  Cloud NAT). Note its **public IP** and **NIC IP**.
- This repo checked out on the Mumbai VM (only the `infrastructure/`,
  `docker-compose.mumbai.yml`, `.env.mumbai` are needed there).
- The 17 server's `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (copy them over).

---

## Part A — Stand up the Mumbai media box

**A1. Files.** On the Mumbai VM, in the repo root, you need:
`docker-compose.mumbai.yml`, `.env.mumbai`, `infrastructure/livekit/livekit.mumbai.yaml`,
`infrastructure/coturn/turnserver.conf`, and `infrastructure/coturn/certs/` (empty, certs go in A4).
The compose also starts a small internal Redis (LiveKit room state) — no setup needed.

**A2. GCP firewall (ingress / allow) — scope the Target to THIS VM (network tag):**
| Ports | Source | Why |
|---|---|---|
| `udp:7532`, `tcp:7531` | `0.0.0.0/0` | SFU media (browsers connect here) |
| `udp/tcp:3478`, `tcp:5349`, `tcp:443`, `udp:49152-49251` | `0.0.0.0/0` | TURN |
| `tcp:7534` | **the 17 server's IP only** | SFU signalling (17's nginx proxies here) |

**A3. DNS.** Re-point `turncollab.resulticks.com` → the **Mumbai public IP**.
(Leave `collab.resulticks.com` as-is — signalling still goes through the 17 nginx.)

**A4. TLS cert for coturn** (for `turns:5349/443`). On the Mumbai box (port 80 free):
```bash
sudo certbot certonly --standalone -d turncollab.resulticks.com
sudo cp /etc/letsencrypt/live/turncollab.resulticks.com/fullchain.pem infrastructure/coturn/certs/fullchain.pem
sudo cp /etc/letsencrypt/live/turncollab.resulticks.com/privkey.pem  infrastructure/coturn/certs/privkey.key
```

**A5. coturn config.** In `infrastructure/coturn/turnserver.conf`, set the relay
target to this box (it's co-located with the SFU now):
```
# was: allowed-peer-ip=10.200.3.17  (the old us-east SFU)
allowed-peer-ip=<MUMBAI_BIND_IP>
```
(If the SFU advertises only its public IP via `use_external_ip`, the public IP is
allowed by default — but setting this keeps the private-candidate path working too.)

**A6. Fill `.env.mumbai`** with `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` (same as 17)
and `COTURN_PUBLIC_IP`/`COTURN_BIND_IP` (this box). Then bring it up:
```bash
docker compose --env-file .env.mumbai -f docker-compose.mumbai.yml up -d
```

**A7. Verify the box advertises the Mumbai IP:**
```bash
docker logs colab-livekit | grep -i candidate    # must show host  <MUMBAI_PUBLIC_IP>:7532
docker logs colab-coturn  | tail                 # coturn listening on 3478/5349/443
```
From an off-network machine: `Test-NetConnection <MUMBAI_PUBLIC_IP> -Port 7531` → True.

---

## Part B — Point the 17 server at Mumbai

**B1. nginx upstream** — `infrastructure/nginx/nginx.conf`, line 3:
```nginx
# was: upstream livekit_signal { server livekit:7534; }
upstream livekit_signal { server <MUMBAI_PUBLIC_IP>:7534; }
```

**B2. `.env.live`** — point the backend's server-side LiveKit URL (used by host
controls: mute/remove) at Mumbai, and re-point TURN by DNS (no value change):
```
LIVEKIT_SERVER_URL=ws://<MUMBAI_PUBLIC_IP>:7534
# LIVEKIT_WS_URL stays  wss://collab.resulticks.com/livekit   (nginx proxies to Mumbai)
# TURN_URLS / TURN_USERNAME / TURN_PASSWORD unchanged (turncollab DNS now points to Mumbai)
```

**B3. Stop the 17 server's now-unused media services and reload nginx:**
```bash
docker compose --env-file .env.live -f docker-compose.live.yml stop livekit coturn
# reload nginx with the new upstream WITHOUT restarting its dependencies:
docker compose --env-file .env.live -f docker-compose.live.yml up -d --no-deps --force-recreate nginx
```
(Optional cleanup: you can now close `udp:7532`/`tcp:7531` on the **17** box — the
SFU no longer runs there.)

---

## Part C — End-to-end verify
1. From an **off-network** device (4G), make a call with `?calldebug=1`.
2. In the panel: **ICE → connected**, candidate pair **succeeded**, and the
   **latency (rtt)** should now read **~20–40 ms** (was ~250 ms).
3. Test **host controls** (mute/remove in a meeting) — these use
   `LIVEKIT_SERVER_URL`, so they confirm B2 is correct.

## Rollback (fast)
On the 17 server, revert `nginx.conf` upstream to `server livekit:7534;` and
`LIVEKIT_SERVER_URL` to `ws://livekit:7534`, then:
```bash
docker compose --env-file .env.live -f docker-compose.live.yml up -d livekit
docker compose --env-file .env.live -f docker-compose.live.yml up -d --no-deps --force-recreate nginx
```
Re-point `turncollab` DNS back. You're on the old us-east media path again.

---

### Multi-region note
If users will span regions (India + US + EU), one Mumbai SFU is still far for
someone. For that, run an SFU node per region (or LiveKit Cloud, which auto-routes
each user to the nearest node). For an India-primary user base, this single Mumbai
box is the fix.
