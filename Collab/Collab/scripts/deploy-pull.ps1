# =============================================================================
# deploy-pull.ps1 — COST-FREE, SECRET-FREE pull-based deploy (PowerShell sibling
# of scripts/deploy-pull.sh, for a Windows Docker host).
#
# Run this ON THE SERVER after the release-images workflow has pushed new
# backend/frontend images to ghcr (.github/workflows/release-images.yml). It
# PULLS the pre-built images and recreates only the chosen services — no local
# `--build`, so the box doesn't recompile the Next.js bundle every deploy.
#
# Why it's safe:
#   * Default services are `backend frontend` only -> it NEVER recreates the
#     media plane (livekit/coturn) or the db, so live calls are not dropped.
#   * --no-deps keeps dependencies (db/redis/minio/livekit) running untouched.
#   * Idempotent: re-running with the same images is a no-op.
#
# PREREQUISITES (one-time, on the box):
#   1. Tell compose WHICH images to pull -- add to .env.live:
#        COLAB_IMAGE_BACKEND=ghcr.io/<owner>/<repo>-backend:<tag>
#        COLAB_IMAGE_FRONTEND=ghcr.io/<owner>/<repo>-frontend:<tag>
#      (<tag> = `latest`, a `sha-xxxxxxx`, or a `vX.Y.Z` version tag.)
#   2. If the ghcr packages are PRIVATE (the default), log Docker in once:
#        $env:GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
#      (Make the packages PUBLIC in the repo's package settings to skip this.)
#
# USAGE:
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-pull.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-pull.ps1 frontend
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-pull.ps1 backend frontend nginx
#
# Override files via env vars (defaults match the live stack):
#   $env:COMPOSE_FILE='docker-compose.live.yml'; $env:ENV_FILE='.env.live'
# =============================================================================
[CmdletBinding()]
param(
    # Services to deploy. Default = the two app images CD publishes. Keeping the
    # media plane (livekit/coturn) OUT of the default is deliberate — recreating
    # it drops every in-progress call (see docs/ENTERPRISE_DEPLOYMENT.md §5).
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Services
)

$ErrorActionPreference = "Stop"

$composeFile = if ($env:COMPOSE_FILE) { $env:COMPOSE_FILE } else { "docker-compose.live.yml" }
$envFile     = if ($env:ENV_FILE)     { $env:ENV_FILE }     else { ".env.live" }

if (-not $Services -or $Services.Count -eq 0) {
    $Services = @("backend", "frontend")
}

# Run from the repo root regardless of the invocation directory.
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($msg) { Write-Host "`n[deploy-pull] $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "`n[deploy-pull] FATAL: $msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $composeFile)) { Die "compose file '$composeFile' not found (run from the repo root, or set `$env:COMPOSE_FILE)." }
if (-not (Test-Path $envFile))     { Die "env file '$envFile' not found (set `$env:ENV_FILE, or create it)." }

$dc = @("compose", "--env-file", $envFile, "-f", $composeFile)

Say "Pulling pre-built images for: $($Services -join ' ')"
& docker @dc pull @Services
if (-not $?) { Die "pull failed — check the COLAB_IMAGE_* tags in $envFile and that Docker is logged in to ghcr (see this script's header)." }

# --no-deps: do NOT touch db/redis/minio/livekit/coturn — only the named
# services are recreated, so nothing else restarts.
Say "Recreating $($Services -join ' ') from the pulled images (no rebuild, no media restart)"
& docker @dc up -d --no-deps @Services
if (-not $?) { Die "compose up failed." }

# Reclaim disk from the now-dangling old image layers (only untagged images).
Say "Pruning dangling images"
try { & docker image prune -f | Out-Null } catch {}

Say "DONE. Deployed: $($Services -join ' '). Now run the §5 calls/meetings smoke test."
