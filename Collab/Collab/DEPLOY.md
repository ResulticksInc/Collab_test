#testlineadded

# CoLab — LIVE deployment (collab.resulticks.com · resul-gitu-svr · 10.200.3.17)

Self-contained runbook. All values are **already filled in `.env.live`** — no
placeholders to edit. Profile: **live DB** (shared corporate MySQL at
`10.101.3.2:3603`, `DB_PROFILE=live`), internal TURN, One API switch **ON**
(see §1b + the note at the end of §5).

Stack: nginx (web entry) · Next.js frontend · Express backend · MySQL · MinIO ·
Redis · LiveKit SFU · coturn TURN relay.

---

## 0. Prerequisites (once)
- Docker + Docker Compose v2 on the server.
- This bundle unzipped on the server; run all commands from its root.
- `.env.live` is present with real values (DB/JWT/LiveKit/TURN secrets). **Treat as sensitive.**

---

## 1. Deploy — clean, from scratch

```bash
# (only if a previous attempt is running) remove old containers — KEEPS the DB:
docker compose --env-file .env.live -f docker-compose.live.yml --profile production down

# build images + start ALL services fresh:
docker compose --env-file .env.live -f docker-compose.live.yml --profile production up -d --build
```

> **Truly blank slate** (also wipes the database): use `down -v` instead of
> `down`. ⚠️ This DELETES all users / meetings / messages. The backend re-runs
> migrations + seed automatically on the next boot, so the DB rebuilds itself.

That second command does everything from scratch — builds the frontend/backend
images, starts db + redis + minio + livekit + coturn + backend + frontend, runs
DB migrations + seed on boot, and brings up **nginx** (`--profile production`),
which proxies `/livekit` with the WebSocket upgrade (required). The corporate LB
forwards `https://collab.resulticks.com` (443) → this server **:3002**. No manual
edits needed — every value in `.env.live` is already filled.

What `.env.live` wires automatically:
- LiveKit uses `infrastructure/livekit/livekit.live.yaml` → **`node_ip 10.200.3.17`**.
- DB = **shared corporate MySQL at `10.101.3.2:3603`** (`DB_PROFILE=live`). The
  bundled `db` container still starts (compose always includes it) but is **unused**
  on this profile. **Migrate your localhost data into prod first — see §1b.**
- TURN relay = **`10.200.3.17:3478`** (internal; see §3).
- One API gateway switch = **ON** (`ONE_API_ENABLED=true`) — inert at runtime;
  see the note at the end of §5.

---

## 1b. Migrate local DB → prod (run ONCE, before first login)

`DB_PROFILE=live` points the app at the corporate MySQL. To carry your accumulated
localhost data into it, run the bundled migration **on the server** after the stack
is up (so the `colab-db` container exists) but **before** users start logging in:

```bash
CONFIRM=yes bash scripts/migrate-local-to-prod.sh
```

It (1) backs up the prod `colab` DB to `./colab-prod-backup-<stamp>.sql`, (2) dumps
the local `colab-db` container, (3) imports that dump into prod — making prod an exact
mirror of local. ⚠️ **Destructive on prod** (`--add-drop-table` replaces prod tables);
the backup it takes first is your rollback. Triggers are skipped (app-layer enforced,
same as `scripts/fresh-prod-migrate.js`). Every mysql call runs through the `colab-db`
container, so the host needs **no** mysql client — only Docker.

> **Network:** the migration and the running backend both reach prod from inside
> Docker via the host's network, so this server (`10.200.3.17`) must be able to
> route to **`10.101.3.2:3603`** — the corporate firewall between them must allow it.

Manual equivalent (if you'd rather run the three steps by hand). The prod DB
username + password live in `.env.live` (`DATABASE_URL_LIVE`) — **never paste
secrets into a runbook or the shell history**. Export them from your secret store
first, then run the commands referencing the env vars:
```bash
# Read these from .env.live / your secret manager — do NOT hard-code them:
export PROD_DB_USER=…   PROD_DB_PASS=…
docker exec colab-db sh -c "exec mysqldump --single-transaction --skip-triggers --no-tablespaces -h10.101.3.2 -P3603 -u\"$PROD_DB_USER\" -p\"$PROD_DB_PASS\" colab" > prod-backup.sql
docker exec colab-db sh -c "exec mysqldump --single-transaction --skip-triggers --add-drop-table --no-tablespaces -ucolab -pcolab colab" > local.sql
docker exec -i colab-db sh -c "exec mysql -h10.101.3.2 -P3603 -u\"$PROD_DB_USER\" -p\"$PROD_DB_PASS\" colab" < local.sql
```

After it completes, restart so the backend serves prod data:
```bash
docker compose --env-file .env.live -f docker-compose.live.yml --profile production up -d
```

> **Want a fresh prod schema instead** (no local data)? Skip the above and run
> `node scripts/fresh-prod-migrate.js` (drops all prod tables + re-applies the 42
> migrations). Don't run both.

---

## 1c. Push secrets for phones (run ONCE per host — UAT *and* production)

Mobile push needs two files in `./keys` next to the compose file (mounted
read-only at `/app/keys`). Only one of them ships in the bundle:

| File | In the bundle? | Carries |
| --- | --- | --- |
| `keys/AuthKey_37PG75SL4U.p8` | yes (tracked) | APNs VoIP — iOS **call rings** only |
| `keys/fcm-service-account.json` | **no** (`keys/*.json` is gitignored) | FCM — **every** message / mention / meeting push, Android *and* iOS |

So a host deployed straight from the bundle rings iOS calls but delivers **no
chat or mention notifications** to phones. That is one cause of the "only call
notifications work" symptom (the others are per-user gates and FCM send
failures — see the checklist at the end of this section). Fix the file once per
host:

```bash
# Firebase console → project collab-7531d → Project settings → Service accounts
# → "Generate new private key" (or copy the file from the UAT host). Then:
install -m 600 /path/to/fcm-service-account.json ./keys/fcm-service-account.json
docker compose --env-file .env.live -f docker-compose.live.yml --profile production restart backend
docker logs "$(docker compose --env-file .env.live -f docker-compose.live.yml ps -q backend)" 2>&1 | grep -E '\[fcm\]|\[apns\]|\[mobile-push\]'
```

Expected:
```
[fcm] configured — mobile push enabled (project collab-7531d)
[apns] VoIP push configured (…, topic com.resulticks.collab.voip)
[mobile-push] enabled — fcm=true apnsVoip=true
```
`[fcm] cannot read service account /app/keys/fcm-service-account.json …` means
the file is still missing on this host. The public probe says the same thing
without log access: `curl -s https://collab.resulticks.com/api/health/ready | jq .checks.push`
must show `"configured": {"fcm": true, …}` and `"degraded": false`.

The `.env.live` values (`FCM_SERVICE_ACCOUNT_FILE`, `FCM_PROJECT_ID`, `APNS_*`)
are already filled; `APNS_ENVIRONMENT` must match how the app build was signed
(see `Backend-Push-Configuration-UAT-and-Production.md`, Step 5).

**"Calls ring, messages/mentions don't" checklist** (iOS calls bypass every gate
below because they go straight to APNs VoIP; everything else goes through FCM
*and* the recipient's own settings):

```bash
# The backend has NO container_name in docker-compose.live.yml, so its container
# is named after the folder (e.g. main-backend-1). `docker logs colab-backend`
# prints "No such container" to stderr, which the grep hides — resolve it instead:
BE="$(docker compose --env-file .env.live -f docker-compose.live.yml ps -q backend)"; echo "backend container: $BE"
# 1. Boot state — fcm=true is required for ANY message push:
docker logs "$BE" 2>&1 | grep -E '\[fcm\]|\[apns\]|\[mobile-push\]|\[web-push\]' | tail -20
# 2. Send a test message from another account, then look for a send failure:
docker logs --since 5m "$BE" 2>&1 | grep -E 'mobile-push\] (fcm|apns) failed|dropped'
#    "fetch failed" / "oauth token failed"  → this host cannot reach *.googleapis.com (firewall)
#    "404 UNREGISTERED"                     → stale device token; sign out/in on the phone
#    "400 INVALID_ARGUMENT … too big"       → fixed 7 Oct 2026 (iOS message size guard)
# 3. Recipient-side gates (replace the email). Any hit here suppresses message
#    pushes for that user while calls still ring:
docker exec -i colab-db mysql -ucolab -pcolab colab -e "
  SELECT u.email, u.manual_presence,
         JSON_EXTRACT(s.data,'$.notifyLevel') notifyLevel, JSON_EXTRACT(s.data,'$.quietHours') quietHours,
         JSON_EXTRACT(s.data,'$.quietStart') quietStart, JSON_EXTRACT(s.data,'$.quietEnd') quietEnd,
         JSON_EXTRACT(s.data,'$.timezone') tz, u.timezone profile_tz
    FROM users u LEFT JOIN user_settings s ON s.user_id=u.id WHERE u.email='RECIPIENT@EMAIL';
  SELECT c.id, c.kind, c.title, cm.muted FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation_id
    JOIN users u ON u.id=cm.user_id WHERE u.email='RECIPIENT@EMAIL' AND cm.muted=1;
  SELECT platform, LEFT(token,12) tok, voip_token IS NOT NULL voip, last_seen_at FROM push_devices pd
    JOIN users u ON u.id=pd.user_id WHERE u.email='RECIPIENT@EMAIL';"
```
`manual_presence = dnd`, `notifyLevel = none`, an active quiet-hours window, or
`muted = 1` on the test conversation each explain the symptom on their own.
`notifyLevel = mentions` used to as well (mentions were never pushed to phones)
— fixed 7 Oct 2026: mention / @channel / reply notifications now push.

---

## 1d. Attachments show "Storage unavailable · Retry" on the web (phone still shows them)

That label is the backend answering **503** for the file: it holds the row but
cannot read the bytes from MinIO. The phone usually keeps showing the image
because it cached it when it was first opened (or it uploaded it); the web app
fetches afresh on every visit and hits the outage. Seen on run on 8 Oct 2026:

```bash
curl -s https://collab.resulticks.com/api/health/ready | jq '.checks.minio, .checks.disk'
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' https://collab.resulticks.com/minio/health/live
```
`checks.minio.error = "timeout"` while `/minio/health/live` answers 200 in well
under a second means **MinIO is up but the backend container cannot reach it**
(nginx can). Check from inside the backend, then the networks:

```bash
BE="$(docker compose --env-file .env.live -f docker-compose.live.yml ps -q backend)"
docker exec "$BE" node -e "fetch('http://minio:9003/minio/health/live').then(r=>console.log('backend→minio',r.status)).catch(e=>console.log('backend→minio FAILED',e.cause&&e.cause.code||e.message))"
docker inspect "$BE" colab-minio colab-nginx --format '{{.Name}} → {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```
The backend and `colab-minio` must share a network. If they don't (a backend
started from a different compose project/folder lands on another network), run
the normal `up -d` from the folder that owns the stack. If they do share one and
the fetch still fails, restart the backend (stale connections) and look at
`docker logs colab-minio`.

**Disk pressure makes it worse.** `checks.disk.usedPct` ≥ `FILE_TIER_PRESSURE_PCT`
(80) switches the cold-tier job to pressure mode. With the default compose both
`files_data` and `colab_minio` are named volumes on the **same host disk**, so
moving files disk → MinIO frees nothing; it just copies the oldest attachments
into a MinIO the backend may not be able to read back from. On such a host set
in `.env.live`:
```
FILE_TIER_PRESSURE_PCT=0            # same disk: pressure tiering can't help
FILE_TIER_PRESSURE_MIN_AGE_DAYS=1   # (default) never move today's attachments
```
and free space on the host instead (old recordings, docker image prune). The
job now also pauses itself when MinIO doesn't answer, and logs
`FILES_TIER_S3_UNREACHABLE` to Admin → Server Logs.

---

## 2. Firewall — open these on the server

Web entry (from the corporate LB):
```bash
firewall-cmd --permanent --add-port=3002/tcp
```

LiveKit media — clients send RTP/ICE straight to these on `10.200.3.17`:
```bash
firewall-cmd --permanent --add-port=7531/tcp        # ICE/TCP
firewall-cmd --permanent --add-port=7532/udp        # ICE/UDP
firewall-cmd --permanent --add-port=7533/udp        # built-in TURN
```

coturn TURN relay — the fallback for VPN / WSL / Docker / virtual-adapter
clients whose browser only offers unreachable `172.x` candidates:
```bash
firewall-cmd --permanent --add-port=3478/udp --add-port=3478/tcp   # TURN control (coturn's plain-TURN port)
firewall-cmd --permanent --add-port=49152-49251/udp                # TURN relay media range
```

Apply:
```bash
firewall-cmd --reload
```

> The same UDP/TCP ports (`3478`, `49152-49251`, `7531-7533`) must also be open on
> any **network firewall** between client subnets and `10.200.3.17`.
> **Relay range:** `49152-49251` (100 ports) is a small default for an easy
> firewall ask. If IT prefers another free range, set `min-port`/`max-port` in
> `infrastructure/coturn/turnserver.conf` to match — they must be identical.

---

## 3. Verify (after deploy)

```bash
docker compose --env-file .env.live -f docker-compose.live.yml --profile production ps   # all Up

# Push legs (no auth needed). push.configured.fcm=false ⇒ phones get call rings
# only — see §1c. degraded:true is that exact state.
curl -s https://collab.resulticks.com/api/health/ready | jq .checks.push

# Signalling reaches LiveKit (expect HTTP 400 "join_request is required"):
curl -sk https://collab.resulticks.com/livekit/rtc/v1/validate -o /dev/null -w '%{http_code}\n'

# SFU advertises the right IP (must be 10.200.3.17, never 127.0.0.1):
docker logs colab-livekit 2>&1 | grep -i publishercandidates | tail -1

# coturn healthy — NO "error resolving"; listening on 3478, relay-ip 10.200.3.17:
docker logs --tail=10 colab-coturn

# LiveKit + backend share the same secret (after any rotation):
docker exec colab-livekit env | grep LIVEKIT_KEYS
```

In the browser on a test call → `chrome://webrtc-internals`: the selected ICE
candidate pair should reach `connected`. VPN/virtual-adapter machines should
show a **`relay`** pair (via `10.200.3.17:3478`); clean LAN machines show a
**`host`** pair (direct to `10.200.3.17:7532`). Either is success.

---

## 4. Redeploy / common ops

**CI/CD — the command to use for a code release** (builds first, then swaps only
the containers whose image or config changed; db / redis / minio / livekit /
nginx keep running, live calls survive, downtime is the few-second container
swap, and the backend still runs its migrations on boot):
```bash
sudo docker compose --env-file .env.live -f docker-compose.live.yml up -d --build backend frontend
```
Do **not** `down` the stack as part of a release. `down` removes EVERY container
(database, MinIO, Redis, LiveKit and nginx included) BEFORE the images are built,
so the site is dark for the whole build; it drops every live call and meeting;
it restarts MinIO under a cold-tier job that may be mid-move; and it recreates
the project network, so anything started under a profile (e.g. `coturn`) that
`down` didn't see is left on the old network. A separate `up --build -d frontend`
before a full `up -d --build` is redundant — the full one builds frontend too.

```bash
# After editing .env.live or any infra config (recreates only what changed):
docker compose --env-file .env.live -f docker-compose.live.yml --profile production up -d

# After a code update (rebuild images):
docker compose --env-file .env.live -f docker-compose.live.yml --profile production up -d --build

# Recreate just the media stack (e.g. after a LiveKit-secret or TURN change):
docker compose --env-file .env.live -f docker-compose.live.yml --profile production up -d coturn backend livekit

# Logs:
docker compose --env-file .env.live -f docker-compose.live.yml --profile production logs -f backend
```

> **Secret rotation:** if you change `LIVEKIT_API_SECRET`, you MUST recreate the
> `livekit` container (`up -d` above does this) so the SFU and backend agree —
> otherwise calls fail with `invalid token / cryptographic primitive`.

---

## 5. Current configuration (reference — already set in `.env.live`)

| Setting | Value |
|---|---|
| Public origin | `https://collab.resulticks.com` (LB → server `:3002`) |
| Server / SFU IP | `10.200.3.17` |
| DB | **shared corporate MySQL `10.101.3.2:3603`** (`DB_PROFILE=live`) |
| One API | switch **ON** (`ONE_API_ENABLED=true`), `http://10.101.1.4:7988/fetch-data` |
| LiveKit signalling | internal `7534`, proxied by nginx at `/livekit` |
| LiveKit media | `7531/tcp`, `7532/udp`, `7533/udp` |
| TURN relay | `turn:10.200.3.17:3478` (udp+tcp), relay `49152-49251/udp` |
| TURN auth | static `lt-cred-mech` — `TURN_USERNAME`/`TURN_PASSWORD` in `.env.live` |

**Scope:** this serves **internal + corporate-VPN** clients (the box has no
public IP). Public-internet callers would need a separately-hosted public TURN.

**One API note:** the switch is ON and the client (`database/src/oneApiClient.ts`)
is aligned to the gateway's structured payload contract. **But it is inert at
runtime** — CoLab's SQL executor connects **directly** to the prod DB and does not
route runtime queries through the gateway (the structured format can't express the
FULLTEXT / window-function / upsert / `FOR UPDATE` queries CoLab needs). So leaving
it ON is safe and does nothing until a specific call is wired through the client.
"Live DB" (`10.101.3.2:3603`, direct) and "One API" (`10.101.1.4:7988`) are two
**separate** endpoints — One API is not required to reach the live DB.

---

## 6. LiveKit subdomain — what IT must provision

A DNS subdomain for LiveKit (e.g. `livekit.collab.resulticks.com`) fixes the
**signalling** URL but **does NOT fix media** by itself. Here is exactly what IT
needs and what each step enables:

### What a subdomain alone does

| Network | Without subdomain | With subdomain only |
|---|---|---|
| Internal LAN / office VPN | Works | Works (no change) |
| Home / mobile / hotel | Signalling may work; media (UDP) fails | Same — still fails |

A DNS name pointing to an internal IP (`10.200.3.17`) is unreachable from outside
the corporate network. Media (RTP/UDP) is a separate problem from signalling (WSS).

### What IT must actually provision for calls to work on ALL networks

**Step A — Public IP on the SFU box** (or on a separate TURN host)

```
Request a public IP and assign it to 10.200.3.17 (or a new box).
Call it PUBLIC_SFU_IP in the steps below.
```

**Step B — DNS records** (both are needed)

```
livekit.collab.resulticks.com  A  PUBLIC_SFU_IP   # signalling (WSS)
turncollab.resulticks.com     A  PUBLIC_SFU_IP   # TURN relay
```

**Step C — TLS certificate** on `livekit.collab.resulticks.com` (Let's Encrypt / corporate CA). The browser requires WSS (not WS) on public hostnames.

**Step D — Firewall rules** on `PUBLIC_SFU_IP` (in addition to the existing LAN rules in §2):

```
7532/udp   # LiveKit media (ICE/RTP)
7531/tcp   # LiveKit ICE/TCP fallback
443/tcp    # TURN-over-TLS (for hotel / strict corporate firewalls that only allow 443)
3478/udp   # TURN control (already open internally; open externally too)
3478/tcp
49152-49251/udp   # TURN relay media
```

> **Port 443:** if the same IP serves the app LB on 443, the TURN-over-TLS relay
> needs a **second public IP** — a single IP can only have one process listening on
> 443. Without TURN-over-TLS-443, hotel and locked-down corporate clients (who can
> only reach port 443) will still fail.

**Step E — Update `.env.live`** after IT assigns the public IP:

```env
# Replace with the actual public IP / subdomain:
LIVEKIT_WS_URL=wss://livekit.collab.resulticks.com/livekit
TURN_URLS=turn:turncollab.resulticks.com:3478?transport=udp,turn:turncollab.resulticks.com:3478?transport=tcp,turns:turncollab.resulticks.com:443?transport=tcp
```

Then update `infrastructure/livekit/livekit.live.yaml`:
```yaml
# Change node_ip to the public IP so the SFU advertises it in ICE candidates:
rtc:
  use_external_ip: false
  node_ip: PUBLIC_SFU_IP      # was 10.200.3.17
```

Rebuild and restart after env/yaml changes:
```bash
docker compose --env-file .env.live -f docker-compose.live.yml --profile production up -d --build
```

### Coverage matrix after full provisioning

| Client network | Mechanism | Expected result |
|---|---|---|
| Office LAN | Direct ICE (host) | Works — direct to SFU |
| Corporate VPN | Direct ICE (host/srflx) | Works |
| Home broadband | STUN → srflx | Works — SFU sees public IP |
| Mobile (4G/5G) | STUN → srflx | Works |
| Hotel / cafe (UDP blocked) | TURN relay UDP/TCP 3478 | Works |
| Strict corporate (443 only) | TURN-over-TLS 443 | Works (needs Step D port 443) |
| Different continent | Same as above, but ~200ms RTT | Works — quality depends on geography |

**Bottom line:** DNS subdomain + public IP + UDP open + TURN-over-TLS-443 = calls
work from any network worldwide. Subdomain alone = no change for external users.
