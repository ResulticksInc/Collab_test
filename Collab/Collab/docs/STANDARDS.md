# CoLab V1 — Engineering Standards & Tooling Status

Definition of Done: a feature is done when it **works** — not when it compiles. Architecture stays clean,
no circular deps, no dead code, no unused deps, responsive + dark-mode + visual + performance validated.

## Tool matrix (status in this repository)

| Tool                  | Purpose                                                                             | Command                                                        | Status                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dependency-cruiser    | Architecture boundaries (FE↛BE, MCP↛FE, agents↛UI, shared/config consumable by all) | `npm run lint:arch`                                            | ✅ Runs headless — **GREEN** (0 violations, 54 modules)                                                                                                                                |
| madge                 | Circular dependencies + orphan (dead) files                                         | `npm run lint:circular` / `npm run lint:orphans`               | ✅ Runs headless — **GREEN** (0 circular; orphans are only entry points)                                                                                                               |
| depcheck              | Dependency hygiene (no unused/bloat)                                                | `npm run lint:deps`                                            | ✅ Runs headless — **GREEN** (no issues in any package; `pg` is lazy-loaded, ignored)                                                                                                  |
| knip                  | Dead code / unused exports / files / deps                                           | `npm run lint:dead`                                            | ⚠️ Configured (`knip.json`). Its native `oxc-parser` cannot allocate its buffer in the build sandbox (`RangeError: Array buffer allocation failed`). **Runs on a normal dev machine.** |
| Playwright            | Functional + responsive across desktop/tablet/mobile                                | `npm run test:e2e`                                             | ⚙️ Wired (`playwright.config.js`, `e2e/*.spec.js`). Needs browsers (`npx playwright install`) — not runnable in the sandbox.                                                           |
| Storybook             | Component isolation + docs                                                          | `npm run storybook`                                            | ⚙️ Wired (`.storybook/`, `*.stories.jsx`). Needs a dev server — runs on your machine.                                                                                                  |
| Chromatic             | Visual regression                                                                   | `npm run chromatic`                                            | ⚙️ Wired (script). Needs a project token + network.                                                                                                                                    |
| React Scan            | Render performance                                                                  | `npm run scan` → `npx react-scan@latest http://localhost:3000` | ⚙️ Documented. Runs against the live dev server.                                                                                                                                       |
| @next/bundle-analyzer | Bundle size                                                                         | `npm run analyze`                                              | ⚙️ Wired in `next.config.js` (defensive require). Run with the package installed.                                                                                                      |

## Validation workflow (run after each major feature / before release)

```bash
npm run lint:arch      # dependency-cruiser
npm run lint:circular  # madge --circular
npm run lint:orphans   # madge --orphans (dead files)
npm run lint:dead      # knip (dev machine)
npm run lint:deps      # depcheck (per package)
npm run validate       # all of the above chained
```

## Architecture boundaries (enforced by dependency-cruiser)

- Frontend must not import Backend, Database, MCP, or Agents (talks over HTTP).
- MCP and Agents must not import Frontend; Backend must not import Frontend/MCP/Agents.
- `shared` and `config` may be consumed by all.

## Honest carve-outs (this sandbox)

- **knip** cannot run here (parser memory allocation); it is configured and runs on your machine.
- **Playwright / Storybook / Chromatic / React-Scan / bundle-analyzer** need a browser, a dev server, or network and were **not executed here** — they are wired with configs + scripts and run on your machine.
- **Calls (audio/video)** are scaffolded UI only. Real media needs WebRTC signalling + media + TURN — a dedicated build, not faked.

## Technical-debt actions taken this session

- Removed `database/src/repositories.js` (a no-op `module.exports = {}` imported by nothing — dead code).
- Cleaned stray `socket.io-client` / `esbuild` from backend deps (test-only artifacts).

---

## Stabilization Sprint — Status & Reproduction

### Live mode (DEMO_MODE=false)

Root cause of "live not working": `authService.login` threw 501 outside demo mode, and seeding only ran in demo mode — so live had no users and refused tokens. Fixed:

- `authService.login` issues a JWT for a resolved user (defaults to the owner) in **any** mode. Real credential verification / SSO remains a later sprint.
- `platform.seedIfNeeded()` seeds when `demoMode` **or** the store is empty, so a fresh live/in-memory backend is populated. A populated production DB is left untouched.
- Frontend always authenticates with a real email (`config.userEmail`, env `NEXT_PUBLIC_USER_EMAIL`, default `you@colab.app`). The offline canned-data fallback stays gated to `demoMode` only.
- **Live mode requires the backend running.** `npm run dev` starts backend + frontend together. Running only the frontend leaves live mode with nothing to call.

### Tool gate

- `npm run lint` → next lint (frontend)
- `npm run typecheck` → tsc --noEmit (frontend, JS-aware tsconfig; checkJs off)
- `npm run build` → next build (frontend)
- `npm run validate` → lint:arch (dependency-cruiser, `--config .dependency-cruiser.cjs`) + lint:circular (madge) + lint:dead (knip) + lint:deps (depcheck)
- `npm run gate` → lint && typecheck && build && validate && test:e2e

### Must run on your machine (cannot be done from the delivered zip)

1. **Clean extract + install.** Extract into a _fresh_ folder and `npm install`. A zip extract over your existing folder does **not** delete stale files.
2. **Delete two dead files if they persist on disk:** `database/src/repositories.js` and `frontend/.dependency-cruiser.js`. The stray `frontend/.dependency-cruiser.js` (a `depcruise --init` recommended-preset) is why `npx depcruise .` showed `not-to-dev-dep` / `no-non-package-json` / `no-orphans`. The shipped `.dependency-cruiser.cjs` has none of those rules and excludes `.next`.
3. **Storybook:** stale Storybook 10 in `node_modules` breaks the pinned Storybook 8 config. `rm -rf node_modules package-lock.json && npm install` before `npm run storybook`.
4. **Playwright browsers:** `npx playwright install` (the tablet/mobile failures were a missing webkit binary; desktop already passed).
5. **Analyzer on PowerShell:** `ANALYZE=true npm run build` is POSIX syntax. On PowerShell use `$env:ANALYZE="true"; npm run build`.
