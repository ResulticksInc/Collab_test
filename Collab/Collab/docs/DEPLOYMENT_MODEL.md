# CoLab — Web vs Desktop Deployment Model

How to ship changes to **web only**, **app only**, or **both** — keeping the two
safe from each other, **at zero extra cost**, and **never breaking calls/meetings**.

This is the *decision + safety* layer. For the mechanics of an actual deploy use
the existing runbooks: [`DEPLOY_RUNBOOK.md`](DEPLOY_RUNBOOK.md),
[`PRODUCTION_DEPLOY.md`](PRODUCTION_DEPLOY.md), [`ENV_PROFILES.md`](ENV_PROFILES.md),
[`LIVEKIT_ARCHITECTURE.md`](LIVEKIT_ARCHITECTURE.md).

---

## 1. What CoLab actually is (the one fact that drives everything)

```
            ┌──────────── one Git repo ────────────┐
 Browser ──►│  frontend (Next.js)  ◄── shared ──►   │◄── Electron shell
            │  backend  (Express)  ◄── shared       │     (main.js/preload)
            │  livekit / db / minio                 │
            └───────────────────────────────────────┘
```

- The **Electron app does not bundle the frontend** — it **loads the hosted web
  app** over a URL (`desktop/config.js → cfg.webUrl`). So the desktop's UI *is*
  the frontend deployment.
- There are **two independently-shippable units**, not three:
  1. **Native shell** — `main.js`, `preload.js`, window chrome, IPC, native
     features → ships as a **new installer** (`latest.json` auto-update). **No
     web deploy needed.**
  2. **Frontend deploy** — the React app both the browser and the shell render.
- The **backend, LiveKit, DB, MinIO are shared** by everyone.

---

## 2. The three isolation layers (how web & app stay safe from each other)

Use the **smallest** gate that fits. All three live in
`frontend/app/src/lib/platform.ts`.

| Layer | Tool | When | Effect |
|---|---|---|---|
| **1. Runtime capability** | `isDesktopApp` / `isWeb` (JS), `body.has-desktop-chrome` (CSS) | A feature only *works* on one platform (native APIs) | App-only code is **inert in the browser** → safe to ship in the shared bundle |
| **2. Build target** | `BUILD_TARGET` (`NEXT_PUBLIC_BUILD_TARGET`) | You need **hard code isolation** (freeze web while desktop iterates) | Web build and desktop build are **different artifacts**; desktop-only code is absent from the web build |
| **3. Feature flag** | `flag("x")` (`NEXT_PUBLIC_FLAGS`) | A feature is **in progress** | OFF until you flip it; never reaches web prod |

```ts
import { isDesktopApp, feature } from "@/lib/platform";

if (feature("desktop")) { /* native-only UI — gone on web */ }
if (feature("all", "remoteControlV2")) { /* both, but only when flag is on */ }
```

> **Rule:** native-only ⇒ layer 1. In-progress ⇒ layer 1 (or 3) so the browser
> ignores it. Only reach for layer 2 when you genuinely need the web frozen.

---

## 3. The deploy decision matrix — *run this for every change*

| The change lives in… | Audience | Where to deploy | Web prod affected? |
|---|---|---|---|
| Shared frontend UI both platforms see | **both** | Frontend deploy | ✅ yes (intended) |
| Frontend, behind `isDesktopApp` / `feature("desktop")` | **app only** | Frontend deploy | ❌ no (inert in browser) |
| Native shell (`main.js`/`preload`/window) | **app only** | **New installer only** | ❌ no |
| Backend (REST/socket/services) | **both** | Backend deploy | ✅ yes (shared) |
| `infra/` (nginx, caddy, compose) | infra | Infra apply | depends |
| **Calls / meetings / LiveKit / TURN / SFU / ICE** | **both** | ⛔ **See §6 — protected path** | ✅ yes — highest risk |

**Read it as:** *if every line of your change is behind layer-1/2/3 gating for
one platform, the other platform is untouched even if you deploy the shared
frontend.* If any line is ungated shared code, both platforms get it.

---

## 4. Cost‑free topology (uses only what you already self-host)

You do **not** need new infrastructure. Two modes:

### Mode A — Shared deploy + gating *(default, simplest)*
One frontend container behind nginx (as today). Web & app load the same build;
gating (§2) keeps app-only/unfinished features invisible to the browser.
- **Ship app-only or in-progress work to `main`** freely — it's gated off for web.
- To **"freeze" web**: simply **don't redeploy the frontend**. The shell's
  features that are native-only already work without a frontend redeploy.
- ✅ Zero extra cost, zero new infra.

### Mode B — Separate desktop frontend *(when web must stay frozen while the desktop frontend iterates)*
Add a **second frontend container on the same host** (free) built with
`NEXT_PUBLIC_BUILD_TARGET=desktop`, and point the shell at it.

```yaml
# docker-compose.live.yml  — add alongside the existing `frontend:` service
  frontend-desktop:
    image: ${FRONTEND_IMAGE}          # same image, or a desktop-tagged build
    environment:
      NEXT_PUBLIC_BUILD_TARGET: desktop
      NEXT_PUBLIC_FLAGS: ${DESKTOP_FLAGS:-}
    # no host port — nginx/caddy proxies a desktop hostname/path to it
```
- Route a host (e.g. `desktop.collab.…`) or path (`/desktop-app`) to
  `frontend-desktop` in nginx/caddy.
- Set the shell's `cfg.webUrl` (or `COLLAB_WEB_URL`) to that target — see
  `desktop/config.js`. The browser keeps hitting the frozen `frontend`.
- Deploy a new frontend image to **`frontend-desktop` only**; `frontend` (web)
  stays on its old image → **web frozen, desktop iterating, one codebase.**
- ✅ Still zero extra cost — one more container on the same machine.

> Start in **Mode A**. Adopt **Mode B** the first time you must hold web on an
> old version while shipping desktop frontend changes.

---

## 5. Deploy commands (cost-free, your existing stack)

- **App only — native change** (window/IPC/native feature): build a new
  installer, bump `desktop/package.json` + `latest.json`, upload, users
  auto-update. **No server deploy.** (Build locally or via free GitHub Actions.)
- **App only — frontend change:** Mode B → deploy the new image to
  `frontend-desktop` only.
- **Web only / both — frontend:** `docker compose --env-file .env.live -f
  docker-compose.live.yml up -d --build frontend` (see `DEPLOY_RUNBOOK.md`).
- **Backend (shared):** rebuild/redeploy `backend`. Migrations are additive +
  idempotent and auto-apply on boot (`DB_MIGRATION_RUNBOOK.md`).

CI is free: GitHub Actions free tier (push the repo) **or** local builds. No paid
service is required anywhere in this model.

---

## 6. ⛔ Calls / meetings safety gate — non-negotiable

Calls/meetings are **platform-agnostic** (same WebRTC/LiveKit path on web and
app) and the **highest-risk surface**. They must **never** be coupled to the
gating above.

**Hard rules**
1. **Never** put `isDesktopApp` / `feature(...)` / a flag around call, meeting,
   LiveKit, SFU, TURN, or ICE code. That path runs identically on both.
2. **Don't touch the media plane** (`docker-compose.*` livekit/coturn, node_ip,
   `use_external_ip`, ports 7531-7534/3478) without `LIVEKIT_ARCHITECTURE.md` +
   `DEPLOY_LIVE_CALLS_FIX.md`.
3. **Pre-deploy gate** (must pass): `npm run typecheck`, the Playwright e2e
   (`e2e/*.spec.ts`), then a **manual call smoke**: 1:1 call, group call, meeting
   join, screen-share, on **two devices / off-network**. If any regress → stop.
4. **Post-deploy smoke**: place a real call after every deploy that touched the
   frontend or backend, even if "unrelated."

This is the guard that lets you move fast on everything else.

---

## 7. Rollback (each unit independently)

| Unit | Rollback |
|---|---|
| Frontend (web or desktop) | Redeploy the **previous image** to that container |
| Backend | Redeploy previous image; migrations are additive (no down-migration needed) |
| Desktop shell | Point `latest.json` back at the **previous installer**; users get it on next check |

---

## 8. ✅ Per-change checklist — *copy this into every PR*

```
[ ] Audience: web-only / app-only / both?  (pick one)
[ ] Gated correctly?  layer-1 capability / layer-2 build-target / layer-3 flag
[ ] Does it touch SHARED frontend code the browser will also run?  (y/n)
[ ] Does it touch the backend? (shared — affects everyone)
[ ] Does it touch calls / meetings / LiveKit / TURN?  → if yes: §6 gate REQUIRED
[ ] typecheck + e2e green?
[ ] Deploy target chosen from the §3 matrix
[ ] Post-deploy: call smoke test passed
[ ] Rollback plan known (§7)
```

**Default answer to "where do I deploy this?":** run the §3 matrix. If it's
gated to one platform, the other is safe; if it's shared, both get it; if it
touches calls, §6 is mandatory.
