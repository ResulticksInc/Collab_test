# Switch the active environment profile by copying .env.<profile> to .env.
# Usage (from repo root):  ./scripts/use-profile.ps1 local|teams|live
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("local", "teams", "live")]
  [string]$Profile
)
$src = ".env.$Profile"
if (-not (Test-Path $src)) { Write-Error "Missing $src (run from the repo root)"; exit 1 }
Copy-Item $src .env -Force
Write-Host "Active profile -> $Profile   (.env  <-  $src)" -ForegroundColor Green
# Show the key facts of what you just switched to.
foreach ($key in @("PUBLIC_HOST", "FRONTEND_PORT", "DB_PROFILE", "DATABASE_URL", "LIVEKIT_WS_URL")) {
  $m = Select-String -Path .env -Pattern "^$key=" | Select-Object -First 1
  if ($m) { Write-Host ("  " + $m.Line) }
}
if (Select-String -Path .env -Pattern 'REPLACE_WITH|CHANGE_ME' -Quiet) {
  Write-Host "WARNING: fill the REPLACE_WITH_* / CHANGE_ME_* values in .env before deploying (see docs/ENV_PROFILES.md)." -ForegroundColor Yellow
}
