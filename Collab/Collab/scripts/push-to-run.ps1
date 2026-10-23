# =============================================================================
# push-to-run.ps1 — SEAMLESS one-command deploy to the Azure DevOps `run` branch.
#
# `run` is the live-deployment branch: pushing to it triggers the RUN build
# pipeline, which auto-triggers the Release → the change goes live. No manual
# release step.
#
# Auth is seamless (Windows Credential Manager holds your Azure credential — no
# PAT/header needed). The ONE special step this handles: your local history is a
# different lineage than `run`, so a plain `git push …:run` would be rejected as
# non-fast-forward. This stacks your whole project as ONE commit on top of the
# current `run` tip (a clean fast-forward, nothing on run is rewritten).
#
# USAGE:
#   # you've already committed your work:
#   .\scripts\push-to-run.ps1
#
#   # or let it commit your pending changes first:
#   .\scripts\push-to-run.ps1 -Commit -Message "what changed"
# =============================================================================
param(
  [string]$Message = "Deploy: sync project onto run for live deployment",
  [switch]$Commit   # also `git add -A` + commit pending changes before deploying
)
# NOT "Stop": in Windows PowerShell 5.1, git writes normal progress ("From
# https://…", "Committed…") to STDERR, and Stop-mode wraps any native stderr in a
# terminating NativeCommandError — which aborted this script MID-DEPLOY even when
# the fetch/commit/push had actually SUCCEEDED. Use Continue so benign git stderr
# doesn't kill the run; the git output (and the final ls-remote) still shows the
# real result, and a genuine failure surfaces there.
$ErrorActionPreference = "Continue"
$RepoUrl = "https://devops.resulticks.team/Websites-Collection/CoLab/_git/CoLab"

# Ensure the 'azure' remote exists (credential-free URL; auth via cred manager).
if ((git remote) -notcontains "azure") { git remote add azure $RepoUrl }

# Optionally commit pending work so it's in the deployed tree.
if (git status --porcelain) {
  if ($Commit) {
    git add -A
    git commit -m $Message | Out-Null
    Write-Host "Committed pending changes." -ForegroundColor Cyan
  } else {
    Write-Warning "You have uncommitted changes; they will NOT be deployed."
    Write-Warning "Commit them (or pass -Commit), then re-run."
    if ((Read-Host "Deploy only what's already committed? (y/N)") -ne "y") { exit 1 }
  }
}

Write-Host "Fetching current run tip..." -ForegroundColor Cyan
git fetch azure run

# Stack the current committed project (HEAD tree) on top of run's tip.
$tree   = (git rev-parse "HEAD^{tree}").Trim()
$parent = (git rev-parse azure/run).Trim()
$new    = (git commit-tree $tree -p $parent -m $Message).Trim()
git branch -f run-deploy $new | Out-Null
Write-Host ("Sync commit {0} onto run {1}" -f $new.Substring(0,7), $parent.Substring(0,7)) -ForegroundColor Cyan

Write-Host "Pushing to run (seamless auth, fast-forward)..." -ForegroundColor Cyan
git push azure "run-deploy:run"

Write-Host "`nDone. run is now:" -ForegroundColor Green
git ls-remote azure refs/heads/run
Write-Host "`nThe RUN build pipeline will build + auto-trigger the release." -ForegroundColor Yellow
Write-Host "Watch it: Azure DevOps > Pipelines > Builds (latest #)." -ForegroundColor Yellow
