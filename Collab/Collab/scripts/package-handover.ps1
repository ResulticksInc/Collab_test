# =============================================================================
# package-handover.ps1 - build a clean ZIP of CoLab for the deployment team.
#
# Env files use an ALLOWLIST (see $envAllow): ONLY the placeholder templates ship;
# every other .env* and any *.bak is stripped, so a newly-created env file (e.g.
# .env.production.bak, .env.dev.bak) can never leak real secrets into the handover.
# Also excludes: VCS (.git), agent notes (.claude), build artifacts (node_modules,
# .next, dist), test artifacts, data dumps, and dev/diagnostic noise.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\package-handover.ps1
# =============================================================================
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$staging = Join-Path $env:TEMP "colab-handover-$stamp"
$zip = Join-Path $root "CoLab-handover-$stamp.zip"

Write-Host "Staging clean copy at $staging ..."
New-Item -ItemType Directory -Force -Path $staging | Out-Null

# Directories excluded anywhere in the tree
$xd = @("node_modules", ".next", ".git", "dist", "test-results", ".claude", "dumps")
# Files excluded anywhere (exact names + patterns). No source media uses these
# extensions, so the globs only strip dev noise.
$xf = @(".env", ".env.local", ".env.server", "npm",
        "*.log", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webm", "*.wav", "*.mp3", "*.docx",
        "*.tsbuildinfo")

# Remove any handover zip from a previous run so only the latest remains.
Get-ChildItem $root -Filter "CoLab-handover-*.zip" -ErrorAction SilentlyContinue | Remove-Item -Force

robocopy $root $staging /E /XD $xd /XF $xf /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed (code $LASTEXITCODE)" }
$global:LASTEXITCODE = 0   # robocopy uses 1-7 for normal success

# Prune scripts/ down to the operational keepers (drop diagnostics/repros/tests)
$keep = @("predev.cjs", "migrate-db.ts", "gen-help-content.cjs", "db.sh", "dev.sh", "package-handover.ps1")
$scriptsDir = Join-Path $staging "scripts"
if (Test-Path $scriptsDir) {
  Get-ChildItem $scriptsDir -File | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Force
}

# Authoritative env rule: ship ONLY these placeholder templates. Strip every other
# .env* file (.env, .env.local, .env.server, .env.dev.bak, ...) and any *.bak.
$envAllow = @(".env.example", ".env.demo", ".env.production")
Get-ChildItem $staging -Recurse -Force -File | Where-Object {
  ($_.Name -like ".env*" -and $envAllow -notcontains $_.Name) -or ($_.Extension -eq ".bak")
} | Remove-Item -Force

# Safety net: refuse to build a zip if any secret/noise file slipped through.
$bad = Get-ChildItem $staging -Recurse -Force -File | Where-Object {
  ($_.Name -like ".env*" -and $envAllow -notcontains $_.Name) -or
  ($_.Extension -in @(".log", ".docx", ".webm", ".png", ".bak"))
}
if ($bad) {
  Write-Host "ABORTING - these should not be in the handover:" -ForegroundColor Red
  $bad | ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Red }
  Remove-Item $staging -Recurse -Force
  throw "secret/noise files present"
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -Force
Remove-Item $staging -Recurse -Force

$sizeText = "{0} MB" -f ([math]::Round((Get-Item $zip).Length / 1MB, 1))
Write-Host ""
Write-Host "Handover package ready:" -ForegroundColor Green
Write-Host "  $zip  ($sizeText)" -ForegroundColor Green
Write-Host "Deliver real credentials (DB password, JWT/LiveKit secrets) separately, not in this zip."
