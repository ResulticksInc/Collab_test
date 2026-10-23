<#
.SYNOPSIS
  Render .env.live from .env.live.template, filling ${KEY} placeholders from
  environment variables (supplied by an Azure DevOps Variable Group).

  This is the repo half of "env via Azure": it removes every manual .env.live edit
  on the server. Change a value in the Azure UI -> re-run the release -> done.

.PIPELINE  (Azure DevOps release, one-time wiring by whoever owns the pipeline)
  1. Pipelines > Library > + Variable Group  named  colab-live-env
     Add ONE variable per .env.live key (72 of them). Mark secrets with the lock:
       AUTH_JWT_SECRET, SSO_CLIENT_SECRET, SSO_JWE_PRIVATE_KEY, LIVEKIT_API_SECRET, MINIO_ROOT_PASSWORD,
       DATABASE_URL / DATABASE_URL_LIVE (they embed the DB password), LLM_API_KEY,
       NEXT_PUBLIC_VAPID_PRIVATE_KEY, etc. Non-secrets (ports, hosts, flags) stay plain.
  2. Link the group to the release stage.
     NOTE: Azure does NOT expose SECRET variables as env vars automatically. In the
     render step, map each secret explicitly, e.g.:
        - task: PowerShell@2
          inputs: { filePath: scripts/render-env-live.ps1 }
          env:
            AUTH_JWT_SECRET:      $(AUTH_JWT_SECRET)
            SSO_CLIENT_SECRET:    $(SSO_CLIENT_SECRET)
            SSO_JWE_PRIVATE_KEY:  $(SSO_JWE_PRIVATE_KEY)
            LIVEKIT_API_SECRET:   $(LIVEKIT_API_SECRET)
            MINIO_ROOT_PASSWORD:  $(MINIO_ROOT_PASSWORD)
            DATABASE_URL:         $(DATABASE_URL)
            DATABASE_URL_LIVE:    $(DATABASE_URL_LIVE)
            # ...one line per secret. Non-secret group vars are already in env.
  3. Then deploy as usual:
        pwsh -File scripts/render-env-live.ps1
        docker compose --env-file .env.live -f docker-compose.live.yml up -d --build

.NOTES
  Exits non-zero if any ${KEY} has no environment variable, so a missing / typo'd /
  unmapped Variable Group entry FAILS THE RELEASE LOUDLY instead of shipping a
  half-empty .env.live. Empty-string values are allowed (some keys are intentionally
  blank); only a truly-unset variable counts as missing.
#>
[CmdletBinding()]
param(
  [string]$Template = ".env.live.template",
  [string]$Out      = ".env.live"
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Template)) {
  Write-Error "render-env-live: template not found: $Template"; exit 1
}

$lines   = Get-Content -LiteralPath $Template
$missing = [System.Collections.Generic.List[string]]::new()
$keys    = 0
$result  = foreach ($line in $lines) {
  $m = [regex]::Match($line, '^([A-Z_][A-Z0-9_]*)=\$\{([A-Z_][A-Z0-9_]*)\}\s*$')
  if ($m.Success) {
    $keys++
    $var = $m.Groups[2].Value
    $val = [Environment]::GetEnvironmentVariable($var)
    if ($null -eq $val) { $missing.Add($var) }
    "$($m.Groups[1].Value)=$val"
  } else {
    $line   # section headers / blank lines pass through unchanged
  }
}

if ($missing.Count -gt 0) {
  Write-Error ("render-env-live: no environment value for: " + ($missing -join ", ") +
    " -- add/map them in the colab-live-env Variable Group.")
  exit 1
}

# UTF-8 WITHOUT BOM -- docker compose / dotenv mis-parse a leading BOM.
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllLines([System.IO.Path]::GetFullPath($Out), $result, $utf8)
Write-Host "render-env-live: wrote $Out ($keys keys)."
