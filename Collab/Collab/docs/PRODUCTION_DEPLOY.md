# CoLab — Production Deployment (HTTPS, works on any network)

## Why the previous deploy's calls failed

The app was served over **plain HTTP at a bare IP** (`http://10.205.11.8:3002`).
Browsers expose the microphone/camera (`getUserMedia`) and allow secure
WebSockets **only from a secure context** — i.e. **HTTPS** (or `localhost`).
On a plain-HTTP origin, `navigator.mediaDevices` is `undefined`, so the first
media step throws and the call dies as *"Unable to connect to media server"*.
That's why **messaging worked but calls/meetings didn't**, and why it worked on
`localhost` but not the LAN IP. A secondary issue handed the browser
`ws://localhost:7534` for LiveKit, which no remote machine can reach.

**The fix is to serve the whole app over HTTPS.** This stack does that with a
single command and adapts to any network with no per-host edits.

## What's in the box

- **`docker-compose.production.yml`** — full stack with **Caddy** as the only
  public web entrypoint (443/80). Caddy terminates TLS and proxies everything:
  page, `/api`, `/socket.io`, `/livekit` (SFU signalling), `/minio`.
- **`infrastructure/caddy/Caddyfile`** — auto-TLS. Self-signed by default (works
  on ANY network instantly); one line switches it to Let's Encrypt for a domain.
- **`.env.production`** — every value filled in. The only optional setting is
  `PUBLIC_HOST`.
- **Self-configuring LiveKit URL** — the backend derives `wss://<your-host>/livekit`
  from each request, so the LiveKit URL can never be wrong again, on any host.

## Deploy

```bash
# from the repo root, on the server
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

Then open **`https://<server-ip-or-domain>`** (note **https**, not http).

- Leaving `PUBLIC_HOST` blank → Caddy uses a **self-signed** cert. The browser
  shows a one-time *"Your connection is not private → Proceed"* — click through
  once and calls/meetings work. To remove the warning fleet-wide, install Caddy's
  root CA on client machines: `docker exec colab-caddy caddy trust` (run on the
  server, then distribute `/data/caddy/pki/authorities/local/root.crt`).

### For a browser-trusted cert (no warning) — optional, recommended for real prod
1. Point a DNS record (e.g. `collab.resulticks.com`) at the server; open 80 + 443.
2. In `.env.production` set `PUBLIC_HOST=collab.resulticks.com` and
   `CADDY_ACME_EMAIL=you@resulticks.com`.
3. In `infrastructure/caddy/Caddyfile`, delete the single `tls internal` line and
   uncomment the `email` global option.
4. Redeploy. Caddy fetches a free Let's Encrypt cert automatically.

## Firewall / ports

Open on the server:

| Port | Proto | Purpose |
|------|-------|---------|
| 443  | tcp + udp | HTTPS + HTTP/3 (the app, API, realtime, LiveKit signalling) |
| 80   | tcp | HTTP→HTTPS redirect + Let's Encrypt challenge |
| 7531 | tcp | LiveKit ICE/TCP media fallback (UDP-blocked networks) |
| 7532 | udp | LiveKit ICE/UDP media |
| 7533 | udp | LiveKit built-in TURN relay (cross-network media) |

LiveKit signalling (7534) stays **internal** — Caddy proxies it at `/livekit`.

## Cross-network media (different offices / home / mobile data)

The LiveKit prod config (`infrastructure/livekit/livekit.prod.yaml`) already sets
`use_external_ip: true` (advertises a reachable IP in ICE candidates), a **TCP
fallback** (7531) for UDP-blocked networks, and the **built-in TURN relay** (7533)
that relays media when a direct peer↔SFU path can't be established. That covers
the large majority of corporate/NAT/firewall situations.

- If your server is behind NAT/a load balancer and STUN can't detect the right
  address, set an explicit `node_ip: <reachable-ip>` in `livekit.prod.yaml`.
- The strictest networks (only 443 outbound) need a **TURN-over-TLS on 443**
  relay, which requires a second IP or hostname (443 is taken by the web tier).
  That's a standard WebRTC constraint, not a CoLab limitation.

## Verify calls work (2-minute smoke test)

1. Open `https://<host>` in two different browsers/devices, sign in as two users.
2. Confirm the page padlock / "Proceed" (secure context) — **not** plain http.
3. Start a 1:1 audio call A→B → accept → both hear each other.
4. Repeat with video, a group huddle, and a meeting room.
5. (Cross-network) repeat with one user on a different network / mobile hotspot.

If a call still can't connect media across networks, it's almost always a blocked
TURN/media port — re-check the firewall table above.
