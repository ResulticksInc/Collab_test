# CoLab — Enterprise Deployment Runbook

The **practical, cost-free** way to release **web** and the **desktop app**
*independently*, with **release channels**, on the existing self-hosted Docker +
GitHub-Actions stack — without ever breaking calls/meetings.

This runbook is the *how*. For the *why / decision model* read
[`DEPLOYMENT_MODEL.md`](DEPLOYMENT_MODEL.md) first; for raw deploy mechanics see
[`DEPLOY_RUNBOOK.md`](DEPLOY_RUNBOOK.md), [`PRODUCTION_DEPLOY.md`](PRODUCTION_DEPLOY.md),
[`ENV_PROFILES.md`](ENV_PROFILES.md).

> **Everything in this runbook is ADDITIVE and OPT-IN.** The current
> `docker compose --env-file .env.live -f docker-compose.live.yml up -d --build`
> behaves **exactly as before** — the new `frontend-desktop` service is
> profile-gated (`--profile desktop`) and the new nginx desktop block is
> commented out.

---

## 1. The web / app / both decision matrix

Run this for **every** change (full version: `DEPLOYMENT_MODEL.md` §3).

| Change lives in… | Audience | Deploy | Web prod affected? |
|---|---|---|---|
| Shared frontend UI both see | both | Frontend image | ✅ yes |
| Frontend behind `isDesktopApp` / `feature("desktop")` | app only | Frontend image (inert in browser) | ❌ no |
| Native shell (`desktop/main.js`/`preload`/window) | app only | **New installer only** | ❌ no |
| Backend (REST/socket/services) | both | Backend image | ✅ yes (shared) |
| `infra/` (nginx, compose) | infra | Infra apply | depends |
| **Calls / meetings / LiveKit / TURN** | both | ⛔ **§5 protected path** | ✅ highest risk |

---

## 2. Cost-free topology — Mode A vs Mode B

No new infrastructure: one extra container on the **same host**, GitHub Actions
free tier (or local builds). Two modes (detail: `DEPLOYMENT_MODEL.md` §4):

- **Mode A — shared deploy + gating (default).** One `frontend` container; web &
  app load the same build; platform/flag gating keeps app-only/unfinished work
  invisible to the browser. To "freeze" web, just don't redeploy `frontend`.

- **Mode B — separate desktop frontend (opt-in).** A second container
  `frontend-desktop` (built with `NEXT_PUBLIC_BUILD_TARGET=desktop`) lets the
  desktop frontend iterate while the browser-facing `frontend` stays frozen on
  its old image. **Wired in this repo and OFF by default:**
  - `docker-compose.live.yml` → service `frontend-desktop`, `profiles: ["desktop"]`
    (only starts with `--profile desktop`; no host port).
  - `infrastructure/nginx/nginx.conf` → commented `frontend_desktop` upstream +
    `/desktop-app` location (and a hostname-based variant). **Keep both commented
    until Mode B is live** — nginx refuses to boot if an upstream points at a
    not-running container.
  - Desktop shell points at it via **`COLLAB_WEB_URL`** (already supported in
    `desktop/config.js`).

### Enabling Mode B (when web must stay frozen while desktop iterates)

```bash
# 1. Build + start ONLY the desktop frontend (web/frontend untouched):
docker compose --env-file .env.live -f docker-compose.live.yml \
  --profile desktop up -d --build frontend-desktop

# 2. Uncomment in infrastructure/nginx/nginx.conf:
#      - the `upstream frontend_desktop { server frontend-desktop:3000; }` line
#      - the `/desktop-app/` location  (OR add a desktop hostname server block)
#    then reload nginx:
docker compose --env-file .env.live -f docker-compose.live.yml \
  exec nginx nginx -s reload

# 3. Point the desktop build at it (build-time env or collab.config.json):
#      COLLAB_WEB_URL=https://collab.resulticks.com/desktop-app
#    (or the desktop hostname, e.g. https://desktop.collab.resulticks.com)
```

Now deploying a new frontend image to **`frontend-desktop` only** leaves web
frozen on its old `frontend` image — one codebase, two release cadences.

---

## 3. Deploy commands (cost-free, your existing stack)

> Always `--env-file .env.live -f docker-compose.live.yml`. Naming a **service**
> rebuilds/restarts only that one — the rest keep running.

**Web only OR both — frontend:**
```bash
docker compose --env-file .env.live -f docker-compose.live.yml up -d --build frontend
```

**Backend (shared by web + app):**
```bash
docker compose --env-file .env.live -f docker-compose.live.yml up -d --build backend
```
Migrations are additive + idempotent and auto-apply on boot (`DB_MIGRATION_RUNBOOK.md`).

**App only — frontend change (Mode B):**
```bash
docker compose --env-file .env.live -f docker-compose.live.yml \
  --profile desktop up -d --build frontend-desktop
```

**App only — native shell change:** no server deploy. Build a new installer
(§4), bump `desktop/package.json` version + the `latest.json` manifest, upload;
users auto-update.

**Full stack (unchanged from today — Mode B does NOT start):**
```bash
docker compose --env-file .env.live -f docker-compose.live.yml up -d --build
```

---

## 3b. CI/CD pipeline ($0, no secrets beyond `GITHUB_TOKEN`)

A clear **CI (verify) → CD (ship)** pipeline on the **free** GitHub Actions tier,
the **free** GitHub Container Registry (`ghcr.io`) and **free** GitHub Releases.
**Cost is $0** and the **only** credential is the auto-provided
`${{ secrets.GITHUB_TOKEN }}` — no PAT, no registry password, no invented secret.
Everything here is **additive**: the manual `docker compose … up -d --build` still
works exactly as before (the Dockerfiles are unchanged; the images CD pushes are
just an *alternative* way to deploy).

> ⚠️ **The calls/meetings safety gate (§5) and the E2EE rollout (§6) are
> unchanged and still apply** — pulling a pre-built image is the same risk
> surface as building one. Run the §5 smoke test after any backend/frontend
> deploy, pull-based or not.

### The flow

```
            ┌─────────────────────── CI (verify gate) ───────────────────────┐
 push / PR  │  web-build.yml: npm ci → typecheck:fe → typecheck:be → lint     │
 ─────────▶ │  → next build   (concurrency-cancels superseded runs)           │
            └────────────────────────────────────────────────────────────────┘
                                     │ green
                                     ▼
            ┌─────────────────────── CD (ship images) ───────────────────────┐
 push main  │  release-images.yml: build backend + frontend from the REAL      │
 / tag v*   │  Dockerfiles → push to ghcr.io (tags: latest / vX.Y / sha-xxxx)  │
 ─────────▶ │                                                                 │
            └────────────────────────────────────────────────────────────────┘
                          │                                   │
        operator pulls    │           OR  optional SSH job    │ (only if
        on the box        ▼               auto-deploys        ▼  DEPLOY_SSH_HOST set)
        scripts/deploy-pull.sh        ssh → docker compose pull && up -d --no-deps

 desktop-v* tag ─▶ desktop-build.yml: build Win/mac/Linux installers
                   → GitHub Release with installers attached
                   → (manual) bump latest.json / latest-<channel>.json to the
                     new version + release-asset URLs, redeploy frontend
```

### CI — `web-build.yml` (verify gate, push + PR)

`npm ci` → `typecheck:fe` → `typecheck:be` → frontend `lint` (`next lint`) →
`next build`. A **concurrency group** cancels superseded runs so only the latest
commit on a ref spends minutes. It ships **nothing** — it only proves the commit
is green before any deploy. (The 6 call/meeting Playwright tests still run
locally per §5 — they need a running stack and stay out of this lightweight gate.)

### CD (web/backend) — `release-images.yml`

On **push to `main`** and on **`v*` tags**, builds the **backend** and **frontend**
images from `docker/Dockerfile.backend` / `docker/Dockerfile.frontend` (the same
files compose uses, with the same build args — `NEXT_PUBLIC_BUILD_TARGET=all`,
blank same-origin URLs, `BACKEND_INTERNAL_URL`/`LIVEKIT_INTERNAL_URL`) and pushes
to **ghcr** with a GHA layer cache (free). Login uses `docker/login-action` with
`${{ github.actor }}` + `${{ secrets.GITHUB_TOKEN }}` — **no extra secret**.
`permissions: { contents: read, packages: write }`.

**Images land at** (`<owner>`/`<repo>` are auto-derived, lowercased):

| Image | ghcr path |
|---|---|
| Backend | `ghcr.io/<owner>/<repo>-backend` |
| Frontend (web/shared `all` target) | `ghcr.io/<owner>/<repo>-frontend` |

**Tags pushed:** `:latest` (main only), `:vX.Y.Z` (on a `v*` tag), and
`:sha-<short>` (always, for an exact-commit pin / rollback).

> The **desktop frontend** variant (`NEXT_PUBLIC_BUILD_TARGET=desktop`, Mode B) is
> **not** built in CD — a second full Next.js bundle per push doubles the minutes
> for a rarely-used image. Build it on demand and push by hand if you adopt Mode B:
> ```bash
> docker build -f docker/Dockerfile.frontend \
>   --build-arg NEXT_PUBLIC_BUILD_TARGET=desktop \
>   -t ghcr.io/<owner>/<repo>-frontend-desktop:latest .
> docker push ghcr.io/<owner>/<repo>-frontend-desktop:latest
> ```
> then set `COLAB_IMAGE_FRONTEND_DESKTOP` in `.env.live` (see below).

#### ghcr packages are PRIVATE by default

Newly-pushed ghcr packages are **private**. Either:
- **Make them public** — repo → *Packages* → the package → *Package settings* →
  *Change visibility* → Public. Then `docker pull` needs no login. **OR**
- **Keep them private** and log Docker in on the box once with a token that has
  `read:packages`:
  ```bash
  echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
  ```

### Deploy the pulled images (cost-free, secret-free — the default path)

The CD job only *publishes* images; the operator deploys them. Point compose at
the ghcr images by adding to **`.env.live`**:

```bash
COLAB_IMAGE_BACKEND=ghcr.io/<owner>/<repo>-backend:latest     # or :vX.Y.Z / :sha-xxxx
COLAB_IMAGE_FRONTEND=ghcr.io/<owner>/<repo>-frontend:latest
# Mode B only (optional): COLAB_IMAGE_FRONTEND_DESKTOP=ghcr.io/<owner>/<repo>-frontend-desktop:latest
```

Then on the box:

```bash
# Pull + recreate ONLY backend+frontend (media plane untouched → no call drop):
bash scripts/deploy-pull.sh                 # Linux host
# powershell -ExecutionPolicy Bypass -File scripts\deploy-pull.ps1   # Windows host
```

`deploy-pull.sh` runs `docker compose --env-file .env.live -f docker-compose.live.yml
pull backend frontend && up -d --no-deps backend frontend` — **no `--build`**, and
`--no-deps` keeps db/redis/minio/livekit/coturn running. Pin a **specific tag**
(`:sha-xxxx` or `:vX.Y.Z`) to roll back instantly: change the `.env.live` tag and
re-run. The compose `image:` keys default to `colab-{backend,frontend}:local`, so
if you **don't** set `COLAB_IMAGE_*` the old `up -d --build` path is unchanged.

### Optional SSH auto-deploy (off unless you add the secret)

`release-images.yml` has a `deploy` job that **only runs when the
`DEPLOY_SSH_HOST` secret is present**. (A small `gate` job reads the secret into
an output and `deploy` gates on that — the working pattern, since Actions forbids
the `secrets` context in a job `if:`.) With no secrets it is **skipped entirely**
— the $0/secret-free guarantee holds. When enabled it SSHes to the box and runs
the same pull-based deploy (`pull` → `up -d --no-deps backend frontend`).
**To enable**, add these **repo secrets**
(Settings → Secrets and variables → Actions):

| Secret | Purpose |
|---|---|
| `DEPLOY_SSH_HOST` | server host/IP — **presence of THIS enables the job** |
| `DEPLOY_SSH_USER` | SSH user with docker permissions |
| `DEPLOY_SSH_KEY`  | private key (PEM) for that user |
| `DEPLOY_PATH`     | *(optional)* repo dir on the box (default `~/CoLab`) |

All optional. Prefer the manual `deploy-pull.sh` if you don't want CI to hold SSH
keys.

### CD (desktop) — `desktop-build.yml` + GitHub Releases

`workflow_dispatch` (with the `channel` input: stable/beta/dev) and a
**`desktop-v*` tag** both build the Win/mac/Linux installers (unchanged). On a
**`desktop-v*` tag**, a new `release` job now **publishes a GitHub Release** with
the built installers attached (`softprops/action-gh-release`, `contents: write`
via `GITHUB_TOKEN` — no extra secret). The assets get **stable, permanent URLs**:

```
https://github.com/<owner>/<repo>/releases/download/<desktop-vX.Y.Z>/<file>
```

so `latest.json` can point at release assets instead of expiring artifacts.
**Installers stay UNSIGNED** (no certs — see §4 *Code-signing*); the Release body
repeats the SmartScreen/Gatekeeper note.

**Manual post-release step (by design):** bump
`frontend/app/public/desktop/latest.json` (or `latest-<channel>.json`) to the new
`version` + the new release-asset `url`s, then **redeploy `frontend`** so the
manifest serves at `/desktop/<file>`. Follow the §4 ladder
(`latest-dev` → `latest-beta` → `latest`) and the §5 gate before promoting to
stable.

### The $0 / no-secret guarantee — at a glance

| Capability | Service | Cost | Secret |
|---|---|---|---|
| CI verify gate | GitHub Actions | free | `GITHUB_TOKEN` (auto) |
| Backend/frontend images | ghcr.io | free (public **or** private) | `GITHUB_TOKEN` (auto) |
| Desktop installers + Release | GitHub Releases | free | `GITHUB_TOKEN` (auto) |
| Pull-based deploy | your existing box | free | none |
| SSH auto-deploy | your existing box | free | **optional**, gated, off by default |

---

## 4. Desktop builds + release channels (Dev → Beta → Stable)

### The three-tier promotion ladder
Experimental desktop features flow through three rings, each a wider audience.
A build is **promoted** by copying its manifest values up the ladder — it never
skips a ring, so nothing reaches everyone until a small group has lived on it.

| Channel (`COLLAB_CHANNEL`) | Manifest fetched | Audience | Purpose |
|---|---|---|---|
| `dev` | `<webUrl>/desktop/latest-dev.json` | just the devs (your daily builds) | bleeding edge; breaks are fine |
| `beta` | `<webUrl>/desktop/latest-beta.json` | Product Head, CEO, BA, QA, senior devs | validate with trusted insiders before company-wide |
| `stable` (default) | `<webUrl>/desktop/latest.json` | everyone in the company | only proven builds |

```
   dev  ──promote──▶  beta  ──promote──▶  stable
 (devs)            (PH/CEO/BA/QA/srs)   (everyone)
 daily, risky       real-world soak      proven only
```

Stable users are **unchanged** — they keep fetching `latest.json`. A non-stable
channel fetches `latest-<channel>.json`, so dev/beta builds never touch anyone
who didn't opt in. `COLLAB_UPDATE_URL` / a `collab.config.json` `updateUrl` still
override everything for full manual control.

The manifests are static files served by the frontend from
`frontend/app/public/desktop/` → `latest.json` (stable), `latest-beta.json`,
`latest-dev.json` (all present). `desktop/config.js` resolves any channel name to
`latest-<channel>.json` automatically — no code change to add a ring.

### Who opts into a ring
A user joins a ring by running the app with that channel set — env
`COLLAB_CHANNEL=beta` (or `dev`), or `"channel": "beta"` in their
`collab.config.json`. Everyone else stays on stable. Typical setup: ship the
beta cohort (PH/CEO/BA/QA/seniors) a `collab.config.json` with `"channel":
"beta"`; devs export `COLLAB_CHANNEL=dev` on their own machines.

### Build a new installer
- **Locally:** `cd desktop && npm run dist:win` (or `dist:mac` / `dist:linux`;
  Mac must build on macOS). Output in `desktop/dist/`.
- **CI (free):** Actions → **Desktop installers** → *Run workflow*. The
  `channel` input (stable / beta / dev, default stable) is baked in as
  `COLLAB_CHANNEL`. A `desktop-v*` tag push also builds (stable). Installers
  upload as artifacts.

### Publish + promote a desktop build (manual — by design, no invented secrets)
1. Bump `version` in `desktop/package.json`.
2. Build the installers (above).
3. Upload them to where the manifest URLs point (the host's
   `frontend/app/public/desktop/` so they serve at `/desktop/<file>`).
4. **Publish to the lowest ring first — `latest-dev.json`** (`version`, `url`,
   `notes`, `channels.*`), redeploy `frontend`. Only devs see it.
5. **Promote up the ladder** once a ring is happy — copy the validated values:
   - Dev soak OK → paste into `latest-beta.json` (PH/CEO/BA/QA/seniors get it).
   - Beta soak OK → paste into `latest.json` (everyone). This is the only step
     that reaches the whole company — gate it on the calls/E2EE checks in §6.
6. Users on a ring get the update prompt on next check; they install over the old
   build (NSIS upgrade preserves data + sign-in).

> Promotion is intentionally a copy-the-manifest action, not a rebuild — the
> exact binary that passed dev/beta is the one that ships to stable.

### Code-signing — TODO (user supplies certs)
Installers are **unsigned today** → Windows SmartScreen "unknown publisher" +
macOS Gatekeeper block on first open (right-click → Open to bypass). Linux is
unaffected. To sign, add these **repo secrets** (Settings → Secrets → Actions)
and remove `CSC_IDENTITY_AUTO_DISCOVERY: "false"` in
`.github/workflows/desktop-build.yml`:

- **Windows:** `CSC_LINK` (base64 .pfx), `CSC_KEY_PASSWORD`.
- **macOS:** `CSC_LINK` (base64 "Developer ID Application" .p12),
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
  — and set `notarize: true` in `desktop/electron-builder.yml`.

electron-builder picks these up automatically; no further config change.

---

## 5. ⛔ Calls / meetings safety gate — NON-NEGOTIABLE

Calls/meetings run the **identical** WebRTC/LiveKit path on web and app and are
the highest-risk surface (full rules: `DEPLOYMENT_MODEL.md` §6).

**Before AND after every deploy that touches frontend or backend:**
1. `npm run typecheck` (the web CI gate `web-build.yml` also runs this on push/PR).
2. `npm run test:e2e` — Playwright incl. the **6 call/meeting tests** (the guard;
   needs a running stack, so it is local/manual, not in the lightweight CI gate).
3. **Manual call smoke on two devices / off-network:** 1:1 call, group call,
   meeting join, screen-share. If any regress → **STOP, roll back (§7).**
4. **Post-deploy:** place a real call even if the change looked "unrelated."

Never gate call/meeting/LiveKit/TURN/ICE code behind `isDesktopApp` / `feature()`
/ a flag, and don't touch the media plane (`docker-compose.*` livekit/coturn,
node_ip, ports 7531-7534/3478) without `LIVEKIT_ARCHITECTURE.md`.

---

## 6. E2EE live rollout

Enabling DM E2EE on live is **additive + reversible** but has its own staged
runbook — **follow it, don't freelance**: [`E2EE_LIVE_ROLLOUT.md`](E2EE_LIVE_ROLLOUT.md).
Short form: **backup the DB → flip `NEXT_PUBLIC_E2EE_ENABLED=true`
(+ `E2EE_ENABLED=true`) → staged rollout → verify** with the runtime checklist.
Flipping back off is safe (legacy plaintext keeps rendering; encrypted rows go
dormant, never lost). Do **not** couple the E2EE flip to a frontend deploy that
also touched calls — keep §5 separate and clean.

---

## 7. Rollback (each unit independently)

| Unit | Rollback |
|---|---|
| Frontend (web) | Redeploy the **previous `frontend` image** (`up -d frontend` on the old tag/commit) |
| Frontend (desktop, Mode B) | Redeploy the previous `frontend-desktop` image (`--profile desktop up -d frontend-desktop`) |
| Backend | Redeploy previous `backend` image; migrations are additive (no down-migration) |
| Desktop shell | Point the channel's manifest (`latest.json` / `latest-beta.json` / `latest-dev.json`) back at the **previous installer** `version`/`url`; users get it on next check. A bad **stable** promotion = revert `latest.json` to the prior values (the demoted build still lives on in beta/dev for diagnosis) |
| nginx Mode B route | Re-comment the `frontend_desktop` upstream + `/desktop-app` block, `nginx -s reload` |
| E2EE | Flip `NEXT_PUBLIC_E2EE_ENABLED` / `E2EE_ENABLED` back to `false`, redeploy `frontend`; rows intact (`E2EE_LIVE_ROLLOUT.md`) |

---

## 8. Per-release checklist

```
[ ] Audience decided from §1 matrix (web / app / both)
[ ] Correctly gated? layer-1 capability / layer-2 build-target / layer-3 flag
[ ] Touches calls/meetings/LiveKit/TURN? → §5 gate REQUIRED
[ ] typecheck green (web-build.yml on push/PR) + e2e green (local) + call smoke
[ ] Deploy command from §3 for the chosen unit only
[ ] Desktop: version bumped + published to lowest ring first (latest-dev), then
    promoted up (latest-dev → latest-beta → latest) only as each ring soaks OK
[ ] Post-deploy call smoke passed
[ ] Rollback plan known (§7)
```
