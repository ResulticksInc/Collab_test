# CoLab — CEO Demo Production Plan (Calls & Meetings)

> **⚠️ Historical (CEO-demo) plan.** For the live launch: TURN is a public relay `turncollab.resulticks.com` → `34.74.165.103` on port **3478** (not 3479); DB is `DB_PROFILE=live` started fresh (`COLAB_FRESH_START=yes`); One API off. See `.env.live` + [DEPLOY_PUBLIC_TURN.md](DEPLOY_PUBLIC_TURN.md) for current values.

**Audience:** IT team (deploy-only — no code changes) + decision-makers.
**Goal:** Calls and meetings work from ANY device on ANY network for the CEO demo tomorrow.
**Two production stacks exist — pick ONE up front:**

- `docker-compose.production.yml` — Caddy terminates TLS, auto-derives the LiveKit URL. Use when the server has a **public IP / internet-facing DNS**.
- `docker-compose.live.yml` — behind a corporate nginx LB (the configured Resulticks topology: `collab.resulticks.com` → LB → host `:3002`, SFU pinned to `10.200.3.17`). Use for the **internal/VPN** deployment. This is what `.env.live` is wired for.

> The rest of this doc assumes the **`.env.live` / `docker-compose.live.yml`** path (already configured), and flags where `production.yml` differs.

---

## 1. Why calls fail today

Calls do not fail because of application/call-logic bugs — the token mint, reconnect, and track handling are healthy. They fail when the **transport/security plane is misconfigured at deploy time**: the browser blocks `getUserMedia` outside a secure context, the LiveKit WebSocket must be `wss://` on an HTTPS page, the SFU advertises a private `node_ip` (`10.200.3.17`) that off-LAN browsers cannot reach, and a working TURN relay is required to bridge those browsers to the SFU. Every one of these is an env/infra setting, not code.

- **Secure context required.** `getUserMedia` is undefined on `http://<LAN-IP>`; the app refuses to connect and shows the insecure-origin message. Ref: `frontend/app/src/lib/mediaSupport.ts:15-49`. Must be served over HTTPS (or `http://localhost` on the box itself).
- **WSS, not WS.** An HTTPS page cannot open `ws://`. The backend derives `wss://<host>/livekit` from `X-Forwarded-Proto: https` + `X-Forwarded-Host` when `LIVEKIT_WS_URL` is loopback/blank. Ref: `backend/app/src/routes/calls.ts:38-47`. `.env.live:56` already pins `LIVEKIT_WS_URL=wss://collab.resulticks.com/livekit`.
- **Proxy must strip `/livekit`.** nginx rewrite `^/livekit/?(.*)$ /$1` → `livekit:7534`; without it the SFU returns 404. Ref: `infrastructure/nginx/nginx.conf:49-62` (Caddy equivalent: `handle_path /livekit*`, `infrastructure/caddy/Caddyfile:33-51`).
- **SFU node_ip is private.** `node_ip: 10.200.3.17`, `use_external_ip: false` — off-LAN clients can't reach it directly. Ref: `infrastructure/livekit/livekit.live.yaml:16`. → makes TURN mandatory for any client not on the LAN/VPN.
- **TURN relay must match auth + reach the SFU.** coturn uses static `lt-cred-mech`; creds must match `TURN_USERNAME`/`TURN_PASSWORD` byte-for-byte, and `allowed-peer-ip` must whitelist `10.200.3.17` before the RFC1918 deny. Ref: `infrastructure/coturn/turnserver.conf:48-107`, `.env.live:94-105`. Wrong auth mode → 401, no relay.
- **Internal-TURN limitation (current `.env.live`).** This box has **no public IP**; coturn relays at `10.200.3.17`, so it serves **LAN/VPN clients only**. True public-internet (4G/home) clients need a **separately-hosted public TURN**. Ref: `.env.live:86-93`.

---

## 2. The non-negotiables for any-device / any-network

For a client on an arbitrary outside network (CEO on 4G / hotel WiFi) to connect, ALL of these must exist:

1. **Public DNS A record** for the app host (e.g. `collab.resulticks.com` → public IP the CEO can resolve).
2. **Valid TLS cert** on that host (Let's Encrypt via Caddy `PUBLIC_HOST`+`CADDY_ACME_EMAIL`, or a corporate cert at the LB). Self-signed works only if clients trust the root.
3. **HTTPS-served app** (secure context) — padlock visible, not "insecure".
4. **WSS LiveKit signalling** at `wss://<host>/livekit` (proxy strips prefix, forwards to `:7534`).
5. **A TURN server reachable from the public internet** on **`3478` (UDP/TCP)**, **`5349` (TLS)**, and **`443` (TLS, for strict/proxy-only networks)**, with `external-ip`/`relay-ip` = a **real public IP**, static creds matching the backend, and `allowed-peer-ip` to the SFU.
6. **Firewall open** for media: `7531/tcp`, `7532/udp`, `7533/udp` (LiveKit) + the TURN ports above + relay range `49152-49251/udp`.

> ⚠️ **Demo gating decision:** the current `.env.live` TURN is **internal-only** (`10.200.3.17`). If the CEO joins from **outside the corporate LAN/VPN**, you MUST either (a) stand up a public-IP TURN box and set `COTURN_PUBLIC_IP` + `TURN_URLS` + DNS + cert for it, or (b) put the CEO on the VPN, or (c) deploy `docker-compose.production.yml` on a public-IP host. Decide this **first** — it determines the whole runbook.

---

## 3. IT team checklist (deploy-only)

No code is written. IT edits env files and runs compose. Order matters.

### 3a. Files IT touches
| File | Purpose |
|---|---|
| `.env.live` | All runtime secrets/URLs (already filled with real values — verify, don't blank). |
| `infrastructure/coturn/certs/fullchain.pem` + `privkey.key` | TURN TLS cert (only if using `turns:`/5349/443). |
| `docker-compose.live.yml` | The stack to bring up (no edits needed). |

### 3b. Env fields to confirm/set in `.env.live` (current real values shown)
| Field | Value / action | Line |
|---|---|---|
| `PUBLIC_HOST` | `collab.resulticks.com` | 9 |
| `WEB_PORT` / `NGINX_PORT` | `3002` (LB forwards 443→3002) | 13-14 |
| `DB_PROFILE` | `live` (→ corporate MySQL) | 27 |
| `DATABASE_URL_LIVE` | `mysql://res_apdev2945:…%23@10.101.3.2:3603/colab` | 29 |
| `AUTH_JWT_SECRET` | set (32+ hex) | 41 |
| `CORS_ORIGINS` | `https://collab.resulticks.com` | 39 |
| `LIVEKIT_WS_URL` | `wss://collab.resulticks.com/livekit` | 56 |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `colab-prod` / 64-hex (shared with SFU) | 58-62 |
| `LIVEKIT_TOKEN_TTL_SEC` | `3600` (SFU auto-refreshes; OK) | 71 |
| `LIVEKIT_CONFIG_FILE` | `./infrastructure/livekit/livekit.live.yaml` | 73-74 |
| `TURN_URLS` | `turn:10.200.3.17:3479?transport=udp,…tcp` (**internal-only**) | 94 |
| `TURN_USERNAME` / `TURN_PASSWORD` | `collab-turn` / `'8V$kR2!…'` (must match coturn `user=`) | 98-99 |
| `COTURN_PUBLIC_IP` | `10.200.3.17` (**change to a real public IP for outside clients**) | 105 |
| `MINIO_ROOT_USER` / `_PASSWORD` | `colab` / `colabminio123` | 110-111 |
| `REDIS_URL` | `redis://redis:6379` | 107 |

**If the CEO is OFF-LAN**, also change (public-TURN box):
```
COTURN_PUBLIC_IP=<PUBLIC_IPv4_OF_TURN_BOX>
TURN_URLS=turns:turncollab.resulticks.com:5349,turn:turncollab.resulticks.com:3478,turns:turncollab.resulticks.com:443
```
and add DNS `turncollab.resulticks.com → <PUBLIC_IPv4>` + drop the TURN cert into `infrastructure/coturn/certs/`.

### 3c. Bring up
```
docker compose --env-file .env.live -f docker-compose.live.yml up -d --build
```
(For the public-IP path: `docker compose --env-file .env.production -f docker-compose.production.yml up -d --build` and set `PUBLIC_HOST`+`CADDY_ACME_EMAIL`.)

---

## 4. Production bring-up runbook

1. **DNS.** Confirm app host resolves: `getent hosts collab.resulticks.com` → the LB/server IP. (Off-LAN path: also `getent hosts turncollab.resulticks.com` → TURN public IP.)
2. **TLS.** LB terminates 443 with a valid cert (or Caddy `tls internal` self-signed if clients trust root). For `turns:`, place `fullchain.pem`/`privkey.key` in `infrastructure/coturn/certs/`.
3. **Env.** Verify `.env.live` per §3b (real values, nothing blank/CHANGE-ME).
4. **Compose up.** `docker compose --env-file .env.live -f docker-compose.live.yml up -d --build`. Confirm: `docker ps` shows `livekit`, `coturn`, `backend`, `frontend`, `nginx`, `redis`, `minio`, `db` healthy.
5. **Verify signalling.** `docker logs colab-livekit | grep -i candidates` → must show `10.200.3.17`, **never `127.0.0.1`**. Hit `https://collab.resulticks.com/livekit` (expect a WS-upgrade/426, not 404 — proves the proxy prefix-strip works).
6. **Verify TURN.** `docker logs colab-coturn` shows it listening on `3479` (+`5349/443` if TLS). For a real allocation test:
   `docker exec colab-coturn turnutils_uclient -y -u collab-turn -w '8V$kR2!mQ9#zL4@xT7^nP1&cY6*Wj3HgF5sD' 10.200.3.17` → expect successful allocation. Confirm `allowed-peer-ip 10.200.3.17` is present (`turnserver.conf:88-107`).
7. **Secrets in sync.** `docker exec colab-livekit env | grep LIVEKIT_KEYS` matches `LIVEKIT_API_KEY:LIVEKIT_API_SECRET` from `.env.live` (token validation fails otherwise).
8. **External device test.** From a phone on **4G (cellular, not office WiFi)** open `https://collab.resulticks.com`, sign in as a 2nd user, place a 1:1 video call to a laptop user. In `chrome://webrtc-internals` confirm a **`relay` candidate pair with DTLS `connected`**. If DTLS times out → TURN unreachable (recheck firewall `3478/5349/443`, DNS, creds). *(On the internal-TURN config this test only passes on LAN/VPN — see §2 gating.)*

---

## 5. Pre-demo validation (T-12h) — 10-minute outside-network proof

Do this from a device **NOT on the corporate network** (personal phone on cellular) + one laptop.

1. **Open** `https://collab.resulticks.com` on both. **Observe:** browser padlock, no "insecure" banner. (If insecure → §1 secure-context; stop and fix.)
2. **Sign in** as two different users.
3. **1:1 audio call** A→B, accept. **Observe:** both hear audio within ~3s.
4. **Upgrade to video** mid-call (camera button) and **1:1 video**. **Observe:** both see video; local tile appears.
5. **Group huddle** (3rd user) — **Observe:** all tiles render, audio crosses.
6. **Schedule a meeting**, copy the Meeting link (`?meeting=<id>`), **join from the phone**. **Observe:** PreJoin device check → joins (or lobby "Waiting to be admitted" if enabled).
7. **`chrome://webrtc-internals` on the phone:** confirm **`relay` candidate pair, DTLS `connected`** (proves TURN works off-network). This is the single most important signal.
8. **Stream logs during the test:** `docker compose --env-file .env.live -f docker-compose.live.yml logs -f livekit coturn backend` — watch for SFU "participant joined", coturn "allocation", no backend token errors.
9. **Long-call sanity:** leave a call up ~3 min; confirm no drop (token auto-refresh, `.env.live:64-70`).
10. **Fallback ready:** if step 7 fails and the CEO is off-LAN, switch the CEO onto VPN OR (pre-staged) the public-IP `production.yml` host. Decide and rehearse this NOW, not during the call.

**Go/No-Go:** steps 1, 3, 4, and 7 must pass. If 7 fails off-network and no VPN fallback, the demo must run on-LAN/VPN only.

---

## 6. Scalability verdict

**Current ceiling:** the client **subscribes to and decodes every remote track** — no selective subscription, cap, or pagination (`MeetingStage.tsx:238-240,461-470,700-706`; `CoLabV1.tsx:6050-6068`). Simulcast (h180/h360), `adaptiveStream`, and `dynacast` are ON (`MeetingStage.tsx:295-312`), which controls bandwidth but **not CPU decode**. Realistic wall: **~15-20 video tiles** on a typical laptop before VP9 decode pegs CPU and the grid janks; hard failure ~25-30. **Not Teams-scale today.** For tomorrow's demo this is fine (keep meetings ≤ ~12 video tiles); the work below is the post-demo path.

**Changes to reach Teams-level, ranked by effort (low → high):**

| # | Change | Effort | Risk | Where |
|---|---|---|---|---|
| 1 | Switch publish codec VP9 → **H.264** (hardware-accel decode, 2-3× cheaper) | S | low | `MeetingStage.tsx:308`, `CoLabV1.tsx:5894` |
| 2 | **Auto speaker-view** when participants > 15 (decode 4-5 streams, not N) | S | low | `MeetingStage.tsx:72` (viewMode) + effect on `participants.length` |
| 3 | Drop 180p simulcast layer for meetings (save encode CPU) | S | low | `MeetingStage.tsx:307`, `CoLabV1.tsx:5893` |
| 4 | Add bitrate/decode **telemetry** (correlate "froze" with stream count) | S | low | `MeetingStage.tsx:482-495` |
| 5 | Server-side per-room participant **warning/cap** | S | low | `backend/app/src/services/meetingService.ts` (enterRoom) |
| 6 | **Visible-tiles-only subscription** (IntersectionObserver → `setSubscribed(false)` off-screen) — keeps decode constant regardless of N | M | med | `MeetingStage.tsx:672-707` |
| 7 | **Cap decoded streams (~25)** w/ active-speaker priority queue (filter screen-share source separately) | M | med | `MeetingStage.tsx:508-514` (ActiveSpeakersChanged) |
| 8 | **Paginated gallery** (16/page, hide not destroy `<video>`) for 50-100p | L | med | `MeetingStage.tsx:100-120,703` |
| 9 | **Multi-node SFU** (Redis + room affinity) for 100+ concurrent — single node bottlenecks ~80-100 | L | high | `livekit.*.yaml`, infra |

**Recommendation:** ship #1-#5 (all S, low-risk) before any large meeting; #6-#7 unlock real 30-50p meetings; #8-#9 are the true Teams-scale lift (not needed for the demo).

---

## 7. Data migration (localhost → prod DB) — zero-data-loss runbook

The bundled local MySQL (`colab-db` Docker container) holds accumulated demo data. Promote it into the corporate prod DB (`10.101.3.2:3603/colab`) **once, BEFORE the first user logs in on live.** Script: `scripts/migrate-local-to-prod.sh` (backs up prod first → dumps local → imports, `--add-drop-table`). `DB_PROFILE=live` flips the backend to prod (`config/src/index.ts:59-76`).

> ⚠️ **Critical:** zero user activity during the window. The dump is a point-in-time snapshot; signups between dump (T1) and import (T3) are LOST. Put the site in maintenance / stop traffic first.

**Ordered steps (run on the server, from bundle root):**

1. **Pre-checks.**
   - Export the prod DB password from `.env.live` / your secret store first (never paste it inline): `export PROD_DB_PASS=…` — every command below references `$PROD_DB_PASS`.
   - `docker ps --format '{{.Names}}' | grep colab-db` (local container up).
   - Test prod creds: `docker exec colab-db mysql -h10.101.3.2 -P3603 -ures_apdev2945 -p"$PROD_DB_PASS" -e 'SELECT 1;'`
   - Record LOCAL baseline counts: `docker exec colab-db mysql -ucolab -pcolab colab -e 'SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM messages; SELECT COUNT(*) FROM conversations;'`
   - `df -h` (need ~400MB+ free for dumps/backups).
2. **Freeze traffic.** Maintenance page at the LB / stop the frontend so no new signups land on local OR prod.
3. **Schema-drift guard.** On prod: `… colab -e 'SELECT COUNT(*) FROM schema_migrations;'` — should match the file count in `database/migrations/`. If prod has FEWER, run `node scripts/fresh-prod-migrate.js` once first. If prod has MORE (newer schema), **STOP** — pull latest code before migrating.
4. **Run the safe migration:**
   ```
   CONFIRM=yes bash scripts/migrate-local-to-prod.sh
   ```
   It writes `./colab-prod-backup-<stamp>.sql` (**keep this — it's the rollback**), dumps local, imports into prod, and prints `users=`/`messages=` counts. Exit 0 = success.
5. **Verify counts match baseline:**
   ```
   docker exec colab-db mysql -N -h10.101.3.2 -P3603 -ures_apdev2945 -p"$PROD_DB_PASS" colab \
     -e "SELECT CONCAT('users=',(SELECT COUNT(*) FROM users)), CONCAT('messages=',(SELECT COUNT(*) FROM messages)), CONCAT('conversations=',(SELECT COUNT(*) FROM conversations));"
   ```
   Counts MUST equal the step-1 baseline. If not → **do not restart backend**; roll back (step 8).
6. **Cutover env flip.** Ensure `.env.live:27` `DB_PROFILE=live` and `DATABASE_URL_LIVE` point at prod (already set). Restart the stack so the backend serves prod:
   ```
   docker compose --env-file .env.live -f docker-compose.live.yml up -d
   ```
   On boot the backend asserts `DB_PROFILE`/`DATABASE_URL_LIVE` (`backend/app/src/index.ts:68-82`), runs pending migrations (`database/src/bootstrap.ts:217-301`), and `promoteIfNeeded()` sets `deploy_state` so it does **not** re-import (`bootstrap.ts:303-477`).
7. **Smoke test.** Log in as an existing user, open a conversation, send a new message, confirm it persists (read+write). `docker compose --env-file .env.live logs backend | grep -i migrate` should be quiet.
8. **Re-enable traffic.** Remove maintenance page. Keep `colab-prod-backup-<stamp>.sql` for 7 days.

**Rollback (if import fails or counts mismatch):**
```
docker exec -i colab-db mysql -h10.101.3.2 -P3603 -ures_apdev2945 \
  -p"$PROD_DB_PASS" colab < colab-prod-backup-<stamp>.sql
```
Re-verify counts against baseline, then investigate before retrying. Do **not** restart the backend against a half-imported prod.

---

### Appendix — open decisions to lock before the demo
- **Will the CEO be on the corporate network/VPN, or fully outside?** (Determines internal-TURN vs public-TURN / `production.yml`.) — §2.
- **Is there a public IP + DNS + cert for a TURN box?** If not and CEO is off-LAN, the only safe path is VPN. — §2/§3b.
- **Has the local→prod migration already run on this prod DB?** Check `deploy_state` / `schema_migrations` before re-running. — §7 step 3.
