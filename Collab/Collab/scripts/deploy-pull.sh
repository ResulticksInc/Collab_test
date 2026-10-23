#!/usr/bin/env bash
# =============================================================================
# deploy-pull.sh — COST-FREE, SECRET-FREE pull-based deploy.
#
# Run this ON THE SERVER after the release-images workflow has pushed new
# backend/frontend images to ghcr (.github/workflows/release-images.yml). It
# PULLS the pre-built images and recreates only the chosen services — no local
# `--build`, so the box doesn't recompile the Next.js bundle every deploy.
#
# Why it's safe:
#   • Default services are `backend frontend` only → it NEVER recreates the
#     media plane (livekit/coturn) or the db, so live calls are not dropped.
#   • `--no-deps` keeps dependencies (db/redis/minio/livekit) running untouched.
#   • Idempotent: re-running with the same images is a no-op (compose only
#     recreates a container when its image/config actually changed).
#
# PREREQUISITES (one-time, on the box):
#   1. Tell compose WHICH images to pull — add to .env.live:
#        COLAB_IMAGE_BACKEND=ghcr.io/<owner>/<repo>-backend:<tag>
#        COLAB_IMAGE_FRONTEND=ghcr.io/<owner>/<repo>-frontend:<tag>
#      (<tag> = `latest`, a `sha-xxxxxxx`, or a `vX.Y.Z` version tag.)
#   2. If the ghcr packages are PRIVATE (the default), log Docker in once with a
#      GitHub token that has read:packages:
#        echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
#      (Make the packages PUBLIC in the repo's package settings to skip this.)
#
# USAGE:
#   bash scripts/deploy-pull.sh                  # pull+recreate backend frontend
#   bash scripts/deploy-pull.sh frontend         # one service only
#   bash scripts/deploy-pull.sh backend frontend nginx
#
# Override files/env via env vars (defaults match the live stack):
#   COMPOSE_FILE=docker-compose.live.yml ENV_FILE=.env.live \
#     bash scripts/deploy-pull.sh
# =============================================================================
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.live.yml}"
ENV_FILE="${ENV_FILE:-.env.live}"

# Services to deploy. Default = the two app images CD publishes. Keeping the
# media plane (livekit/coturn) OUT of the default is deliberate — recreating it
# drops every in-progress call for ~60s (see docs/ENTERPRISE_DEPLOYMENT.md §5).
if [ "$#" -gt 0 ]; then
  SERVICES=("$@")
else
  SERVICES=(backend frontend)
fi

# Run from the repo root regardless of where the script is invoked from.
cd "$(dirname "$0")/.."

say() { printf '\n\033[36m[deploy-pull]\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m[deploy-pull] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$COMPOSE_FILE" ] || die "compose file '$COMPOSE_FILE' not found (run from the repo root, or set COMPOSE_FILE)."
[ -f "$ENV_FILE" ]     || die "env file '$ENV_FILE' not found (set ENV_FILE, or create it)."

DC=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

say "Pulling pre-built images for: ${SERVICES[*]}"
"${DC[@]}" pull "${SERVICES[@]}" \
  || die "pull failed — check the COLAB_IMAGE_* tags in $ENV_FILE and that Docker is logged in to ghcr (see this script's header)."

# --no-deps: do NOT touch db/redis/minio/livekit/coturn — only the named
# services are recreated, so nothing else restarts.
say "Recreating ${SERVICES[*]} from the pulled images (no rebuild, no media restart)"
"${DC[@]}" up -d --no-deps "${SERVICES[@]}" \
  || die "compose up failed."

# Reclaim disk from the now-dangling old image layers. Safe: only untagged
# (dangling) images are removed.
say "Pruning dangling images"
docker image prune -f >/dev/null 2>&1 || true

say "DONE. Deployed: ${SERVICES[*]}. Now run the §5 calls/meetings smoke test."
