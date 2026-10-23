# CoLab

Enterprise team-collaboration platform (Slack/Teams-class): real-time messaging,
1:1 and group calls, meetings with screen-share, file sharing, tasks, calendar,
and reminders. Monorepo: Next.js 14 frontend + Express/Socket.IO backend + MySQL,
with LiveKit for media and MinIO/S3 for file storage.

> **Deploying this?** Go straight to **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — it has
> step-by-step instructions for every hosting option. This page is an overview.

---

## What's in this package

| Path | What it is |
|---|---|
| `frontend/` | Next.js 14 app (App Router) |
| `backend/` | Express + Socket.IO API server (TypeScript) |
| `database/` | MySQL schema — 41 migrations, applied automatically on boot |
| `shared/`, `config/` | Shared contracts + centralized config (all env reads live here) |
| `mcp/`, `agents/` | AI/MCP integration seams (optional, off by default) |
| `docker/` | Backend + frontend Dockerfiles |
| `infrastructure/` | LiveKit + coturn configs (for self-hosted media) |
| `docker-compose.yml` | Base stack: MySQL, Redis, MinIO, backend, frontend |
| `docker-compose.cloud.yml` | Override: LiveKit Cloud + Cloudflare Tunnel (public demo) |
| `docker-compose.server.yml` | Override: self-hosted media on a public server |
| `.env.example` / `.env.demo` | Environment templates (fill these in — see below) |
| `docs/` | Architecture, deployment, and readiness reports |

## Status: production-ready core

Messaging, 1:1 calls, group meetings, screen-share, file sharing, tasks, calendar,
reminders, presence, notifications, and search are **implemented and stable**.
Self-service sign-up and AI summaries are feature-flagged (off by default).
See [docs/ENTERPRISE_READINESS_REPORT.md](docs/ENTERPRISE_READINESS_REPORT.md) for a
feature-by-feature assessment.

---

## Configuration & secrets

**No real credentials ship in this package.** `.env.example` and `.env.demo` are
templates containing placeholders (`CHANGE_ME`). Before deploying you must provide:

- `AUTH_JWT_SECRET` — generate a fresh 32+ char random string (the server refuses
  to boot in production with a weak/placeholder value)
- Database credentials — see DEPLOYMENT.md (a local MySQL container is included)
- LiveKit credentials — LiveKit Cloud project **or** self-hosted keys
- (If using Cloudflare Tunnel) the tunnel token

Production DB credentials are provided **separately, out of band** — they are not in this zip.

## Quick start (local evaluation, Docker)

```bash
cp .env.example .env          # then set AUTH_JWT_SECRET + LiveKit values
docker compose up -d --build  # MySQL + Redis + MinIO + LiveKit + coturn + backend + frontend
```

Frontend on http://localhost:3002, backend API on http://localhost:4000.
Migrations apply automatically on first boot.

For a **public, cross-network deployment** (the real target), follow
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — plain HTTP by IP will block
camera/mic/screen-share in browsers, so HTTPS is required.

## Local development (without Docker)

```bash
npm install
cp .env.example .env
docker compose up -d db redis minio   # infra only
npm run dev                           # backend + frontend with hot reload
```

## Useful commands

```bash
npm run typecheck     # full monorepo type check
npm run db:migrate    # apply migrations to DATABASE_URL
npm run build         # production frontend build
```
