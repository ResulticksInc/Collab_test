# =============================================================================
# package-deploy-live.ps1 - build a READY-TO-DEPLOY ZIP of CoLab for the LIVE
# site (collab.resulticks.com) with the bundled local-DB profile.
#
# UNLIKE scripts\package-handover.ps1 (which STRIPS every real .env for a
# secrets-free dev handover), this DEPLOY bundle INTENTIONALLY SHIPS the filled
# .env.live so the deployment team can run, verbatim:
#
#   docker compose --env-file .env.live -f docker-compose.live.yml up -d --build
#
# For a REDEPLOY onto an already-running box, deploy app-only so the LiveKit/media
# containers are NOT recreated (a full 'up --build' drops all calls for ~60s):
#
#   docker compose --env-file .env.live -f docker-compose.live.yml up -d --build --no-deps backend frontend nginx
#
# It still strips OTHER profiles' env files, build artifacts, diagnostics, media,
# and the loose investigation dumps (0X-*.txt / *.log) so only the live deploy
# surface ships. Treat the output ZIP as SENSITIVE (it contains real secrets).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\package-deploy-live.ps1
# =============================================================================
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$staging = Join-Path $env:TEMP "colab-live-deploy-$stamp"
$zip = Join-Path $root "CoLab-LIVE-deploy-$stamp.zip"

Write-Host "Staging clean copy at $staging ..."
New-Item -ItemType Directory -Force -Path $staging | Out-Null

# Directories excluded anywhere in the tree.
# NOTE: do NOT exclude "dumps" — `database/dumps/colab_full.sql` is the bundled
# snapshot that the backend auto-imports on first boot (see promoteIfNeeded()).
# Excluding it would silently ship an empty DB.
$xd = @("node_modules", ".next", ".git", "dist", "build", "test-results",
        "playwright-report", ".claude", "coverage")
# Files excluded anywhere: build noise, media, docs binaries, the loose
# investigation dumps (01-..09 .txt) and any *.log/*.zip.
$xf = @("*.log", "*.tsbuildinfo", "*.bak", "*.zip",
        "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webm", "*.wav", "*.mp3", "*.docx",
        "0?-*.txt")

# Remove any deploy zip from a previous run so only the latest remains.
Get-ChildItem $root -Filter "CoLab-LIVE-deploy-*.zip" -ErrorAction SilentlyContinue | Remove-Item -Force

robocopy $root $staging /E /XD $xd /XF $xf /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (code $LASTEXITCODE)" }
$global:LASTEXITCODE = 0   # robocopy uses 1-7 for normal success

# Prune scripts/ down to the operational keepers (drop diagnostics/repros/tests)
$keep = @("predev.cjs", "migrate-db.ts", "gen-help-content.cjs", "db.sh", "dev.sh",
          "use-profile.sh", "use-profile.ps1", "fresh-prod-migrate.js",
          "migrate-local-to-prod.sh",
          # Zero-data-loss migration harness (bundled container -> durable DB) +
          # the read-only live-DB lookup. Ship so IT can run them on the box.
          "dump-colab-live.sh", "load-colab-target.sh", "verify-colab-target.cjs",
          "find-live-users.cjs",
          # E2EE self-audit toolchain (cost-free, self-hostable). Ship so the
          # operator can verify the deployment without paying anyone.
          "verify-e2ee-crypto.cjs", "e2ee-runtime-validation.cjs", "e2ee-self-audit.cjs",
          "package-deploy-live.ps1", "package-handover.ps1")
$scriptsDir = Join-Path $staging "scripts"
if (Test-Path $scriptsDir) {
  Get-ChildItem $scriptsDir -File | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Force
}

# Env rule for the DEPLOY bundle: SHIP the three deployment profiles (.env.live is
# the active/intended target; .env.teams + .env.local enable the use-profile
# toggle) plus .env.example (reference). Strip every OTHER .env* (incl. the
# generated active .env) so stale secrets don't ride along.
$envAllow = @(".env.live", ".env.teams", ".env.local", ".env.example")
Get-ChildItem $staging -Recurse -Force -File | Where-Object {
  ($_.Name -like ".env*" -and $envAllow -notcontains $_.Name)
} | Remove-Item -Force

# Safety net: .env.live MUST be present (it's the whole point), and no stray
# build/media noise should have slipped through.
if (-not (Test-Path (Join-Path $staging ".env.live"))) {
  Remove-Item $staging -Recurse -Force
  throw ".env.live missing from the deploy bundle - aborting."
}
# Safety net: the bundled SQL dump MUST be present and non-trivially sized.
# This is the data that the backend auto-imports on first boot via
# promoteIfNeeded(); shipping a zip without it = empty production DB.
$dumpPath = Join-Path $staging "database/dumps/colab_full.sql"
if (-not (Test-Path $dumpPath)) {
  Remove-Item $staging -Recurse -Force
  throw "database/dumps/colab_full.sql missing from the deploy bundle - the live cutover would lose all signups + messages. Regenerate with: docker exec colab-db sh -c 'exec mysqldump --single-transaction --skip-triggers --no-tablespaces --add-drop-table --default-character-set=utf8mb4 -ucolab -pcolab colab 2>/dev/null' > database/dumps/colab_full.sql"
}
$dumpSize = (Get-Item $dumpPath).Length
if ($dumpSize -lt 100000) {
  Remove-Item $staging -Recurse -Force
  throw "database/dumps/colab_full.sql is suspiciously small ($dumpSize bytes) - looks empty/corrupt. Regenerate (see message above)."
}
Write-Host "  bundled snapshot: database/dumps/colab_full.sql ($([math]::Round($dumpSize/1024,1)) KB)" -ForegroundColor Cyan
# Drop the demo dumps from the bundle — only colab_full.sql is auto-imported.
foreach ($noisy in @("colab.sql", "colab.json", "colab_demo.sql", "colab_demo.json")) {
  $p = Join-Path $staging "database/dumps/$noisy"
  if (Test-Path $p) { Remove-Item $p -Force }
}
$bad = Get-ChildItem $staging -Recurse -Force -File | Where-Object {
  ($_.Extension -in @(".log", ".docx", ".webm", ".bak", ".zip")) -or ($_.Name -like "0?-*.txt")
}
if ($bad) {
  Write-Host "ABORTING - these should not be in the deploy bundle:" -ForegroundColor Red
  $bad | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Red }
  Remove-Item $staging -Recurse -Force
  throw "noise files present"
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -Force
Remove-Item $staging -Recurse -Force

$sizeText = "{0} MB" -f ([math]::Round((Get-Item $zip).Length / 1MB, 1))
Write-Host ""
Write-Host "LIVE deploy package ready:" -ForegroundColor Green
Write-Host "  $zip  ($sizeText)" -ForegroundColor Green
Write-Host ""
Write-Host "Contains the filled .env.live (real secrets) - handle as SENSITIVE." -ForegroundColor Yellow
Write-Host ""
Write-Host "FIRST / cold deploy (brings up the whole stack):" -ForegroundColor Cyan
Write-Host "  docker compose --env-file .env.live -f docker-compose.live.yml up -d --build"
Write-Host ""
Write-Host "REDEPLOY onto a running box (app only - does NOT touch calls/meetings):" -ForegroundColor Cyan
Write-Host "  docker compose --env-file .env.live -f docker-compose.live.yml up -d --build --no-deps backend frontend nginx"
Write-Host ""
Write-Host "WHY: a plain 'up -d --build' can recreate the LiveKit/media containers and drop"
Write-Host "all calls for ~60s. On a redeploy use --no-deps so the SFU stays up (zero call"
Write-Host "disruption). Only restart livekit/coturn when you change THEIR config."
Write-Host ""
Write-Host "After deploy, run the checks in docs/DEPLOY_HEALTHCHECK.md (A-C + a test call)."
Write-Host "Before EXTERNAL calls work, complete docs/DEPLOY_LIVE_CALLS_FIX.md > Ops checklist."
