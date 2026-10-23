# Deploy: Public TURN — make calls work on ANY network (4G / home / hotel)

Goal: an off-corporate-network browser can complete a call/meeting. Today it can't,
because the SFU **and** the TURN relay only live at the private IP `10.200.3.17`
(see [CEO_DEMO_IT_VALIDATION.md](CEO_DEMO_IT_VALIDATION.md)). This adds a **public**
relay so external clients have a reachable media path.

The code/config edits are already done. The IT team only **provisions network/DNS/cert,
fills ONE value, and deploys.**

## Applies to every deployed tier (not just live)

The same change is in place for **both** server tiers; `local` needs no TURN (localhost media).
All tiers share one `infrastructure/coturn/turnserver.conf` (it allow-lists both SFU IPs) and the
ports udp/tcp **3478**, tls **5349**, tls **443**.

| Tier | env file | compose file | TURN DNS name → public IP | `COTURN_BIND_IP` (NIC) | SFU node_ip |
|---|---|---|---|---|---|
| **live** | `.env.live` | `docker-compose.live.yml` | `turncollab.resulticks.com` | `10.200.3.17` | `10.200.3.17` |
| **teams** | `.env.teams` | `docker-compose.live.yml` | `turn.collab.resul.team` | `10.205.11.8` | `10.205.11.8` |
| local | `.env` | `docker-compose.yml` | — (n/a, localhost) | `127.0.0.1` (default) | localhost |

For each deployed tier, the **only** value to fill is that tier's `COTURN_PUBLIC_IP`, plus its
DNS A record + TLS cert (Part 0). Everything below uses live's names — substitute the teams row
when deploying teams (`--env-file .env.teams`, `turn.collab.resul.team`, bind `10.205.11.8`).

---

## Part 0 — What the network team must provide (only they can)

1. **A public IPv4** that routes to the live box (`10.200.3.17`): either assigned to the
   NIC, or a **1:1 NAT / port-forward** from a public IP to the box.
2. **DNS A record:** `turncollab.resulticks.com` → that public IP.
3. **TLS cert** valid for `turncollab.resulticks.com` (Let's Encrypt is fine). Place the
   files at `infrastructure/coturn/certs/fullchain.pem` and `.../privkey.key`.
4. **Firewall — open INBOUND from the public internet** to that IP. The live box is on
   **Google Cloud**, so this is a **VPC firewall rule** on the instance behind `34.74.165.103`
   (ingress, source `0.0.0.0/0`):
   - `3478/udp`, `3478/tcp` (TURN/STUN)
   - `5349/tcp` (TURN over TLS)
   - `443/tcp` (TURN over TLS — the one that survives locked-down hotel/guest/4G networks)
   - `49152-49251/udp` (the relay media port range — **required**, calls fail silently without it)
   - For the demo, the **plain `turn:` on 3478 (raw IP)** is enough — open 3478/udp+tcp and the
     relay range first; DNS+cert+5349/443 can follow for restrictive networks.

> **443 note:** the app's public 443 is owned by the corporate LB (→ nginx). So
> `turncollab.resulticks.com` should get **its own public IP**, or the LB must pass 443
> through for that hostname. If neither is possible, drop the `:443` entry from `TURN_URLS`
> in `.env.live` and rely on `5349` — most networks still work; only the most restrictive fail.

---

## Part 1 — The single value to fill (everything else is done)

**LIVE is already filled** — the box's Google Cloud external IP is set:

```ini
COTURN_PUBLIC_IP=34.74.165.103   # live box's GCP external IP (1:1 NAT -> 10.200.3.17)
COTURN_BIND_IP=10.200.3.17       # the box's real NIC IP — do not change
```

`TURN_URLS` is a hybrid: plain `turn:` points at the raw IP `34.74.165.103` (works the
moment the firewall opens — no DNS/cert needed), and `turns:` (TLS) uses
`turncollab.resulticks.com` (active once DNS+cert are in place). For the **teams** tier,
fill its own `COTURN_PUBLIC_IP` in `.env.teams` the same way.

Already updated for you in `.env.live` / `docker-compose.live.yml`:
- `TURN_URLS` now advertises the **public FQDN** over the full ladder (udp/tcp 3478, tls 5349, tls 443).
- coturn now runs `--external-ip=<public>/<bind>` `--relay-ip=<bind>` so it **advertises the
  public IP but binds the private NIC** (the 1:1-NAT case).
- `turnserver.conf` already has the right ports, cert paths, and the SFU peer allow-list.

---

## Part 2 — ⚠️ Data safety FIRST (do not skip)

The live app currently stores users in its **bundled MySQL container** (`colab-db` on the
box), because the running deploy used the default `DB_PROFILE=local`. **`.env.live` ships
`DB_PROFILE=live`, which points at the corporate DB `10.101.3.2:3603` — currently EMPTY.**
So deploying `.env.live` as-is would make the office signups (Raghuram, Balaji, Madhan…)
**disappear from the app.** Pick ONE:

**Recommended (durable):** migrate the data into the corporate DB first, then deploy.
```bash
# On the live box (10.200.3.17), repo dir:
# 1) Back up the bundled container DB
docker exec colab-db mysqldump -ucolab -pcolab --single-transaction --routines colab \
  > colab-live-$(date +%Y%m%d-%H%M).sql
# 2) Load it into the (empty) corporate DB. Password is in .env.live (DATABASE_URL_LIVE).
docker exec -i colab-db mysql -h10.101.3.2 -P3603 -ures_apdev2945 -p'<corp-pass>' colab \
  < colab-live-$(date +%Y%m%d-%H%M).sql
# 3) Verify counts match
docker exec colab-db mysql -h10.101.3.2 -P3603 -ures_apdev2945 -p'<corp-pass>' colab \
  -e "SELECT COUNT(*) FROM users;"
# Then deploy with .env.live as-is (DB_PROFILE=live → corporate, now populated).
```

**Demo-safe (quick, defer migration):** keep using the bundled container for now —
override the DB profile at deploy time so the data stays put:
```bash
# Back up anyway (above step 1), then deploy with DB_PROFILE forced to local:
DB_PROFILE=local docker compose --env-file .env.live -f docker-compose.live.yml up -d --build
```
Do the migration after the demo.

> **NEVER** run `docker compose ... down -v` — the `-v` deletes the volume and wipes signups.
> Always back up first regardless of path.

---

## Part 3 — Deploy

```bash
# On the live box, in the repo directory, after Part 0 + filling COTURN_PUBLIC_IP:
docker compose --env-file .env.live -f docker-compose.live.yml up -d --build
# (or the demo-safe variant from Part 2)

# Recreate just the relay + backend if the rest is already up:
docker compose --env-file .env.live -f docker-compose.live.yml up -d --force-recreate coturn backend
```
The **backend must be recreated** so it advertises the new `TURN_URLS` to browsers.

Confirm coturn started clean (no "error resolving", shows "Relay ... allocated"):
```bash
docker logs --tail=60 colab-coturn
```

---

## Part 4 — Verify it actually works off-network

1. **From OUTSIDE the corporate network** (a laptop on a phone hotspot):
   ```bash
   nc -vzu turncollab.resulticks.com 3478
   nc -vz  turncollab.resulticks.com 5349
   nc -vz  turncollab.resulticks.com 443
   turnutils_uclient -v -t -u collab-turn -w '<TURN_PASSWORD>' turncollab.resulticks.com -p 3478
   ```
   Expect a successful allocation. If these fail → firewall/DNS/cert not done (Part 0).
2. **Real call test, Office ↔ 4G:** open the call on both, then open the **WebRTC debug panel**
   (add `?calldebug=1` to the URL, or `localStorage.setItem('colab_call_debug','1')` + reload).
   You want to see:
   - `TURN advertised? ` → yes (not "NONE")
   - `TURN used? ` → **YES (relay)** on the 4G side
   - `ice` → **connected**
   - Console (filter `CALLDIAG`) shows `ICE Connected`, not `ICE Failed`.
3. Hold the call **5 minutes** to confirm stability.

If the 4G side shows `TURN used? no` and `ICE Failed → no relay candidate`, the relay isn't
publicly reachable yet — re-check Part 0 (firewall ports incl. the `49152-49251/udp` range,
DNS, cert) and `docker logs colab-coturn`.
