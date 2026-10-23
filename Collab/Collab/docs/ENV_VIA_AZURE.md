# Env via Azure — stop editing `.env.live` on the server by hand

**Goal:** change any live environment value (SSO, DB, E2EE, LiveKit…) from the Azure
UI and have the next release apply it — no SSH, no manual `.env.live` edit, and **no
secrets committed to git**.

## Why this is needed
The live stack reads env at deploy time via `docker compose --env-file .env.live`.
That `.env.live` lives **on the server** and is gitignored, so `git push run` ships
**code, not env** — which is exactly why an SSO/env change previously needed a manual
server edit. Committing `.env.live` is not an option: it would put DB / JWT / SSO /
LiveKit **secrets in the shared repo** and can collide with the server's existing file
on `git pull`.

The fix is to let the **release pipeline** materialize `.env.live` from an Azure-managed
source at deploy time.

## Repo half (already in the repo)
- **`.env.live.template`** — every key as `KEY=${KEY}` (placeholders only; no values).
- **`scripts/render-env-live.ps1`** — fills the placeholders from environment
  variables and writes `.env.live` (UTF-8, no BOM). Fails the release if any value is
  missing, so a typo can't ship a half-empty env.

## Pipeline half (one-time, ~5 min — needs Azure DevOps access)
1. **Pipelines → Library → + Variable Group** named **`colab-live-env`**.
   Add one variable per `.env.live` key (72). Copy the current server values in once.
   Mark these 🔒 **secret**: `AUTH_JWT_SECRET`, `SSO_CLIENT_SECRET`, `SSO_JWE_PRIVATE_KEY`
   (the PEM base64-encoded on one line — see docs/SSO.md),
   `LIVEKIT_API_SECRET`, `MINIO_ROOT_PASSWORD`, `DATABASE_URL`, `DATABASE_URL_LIVE`,
   `LLM_API_KEY`, `NEXT_PUBLIC_VAPID_PRIVATE_KEY`. Non-secrets (ports, hosts, flags,
   `NEXT_PUBLIC_*`) stay plain.
2. **Link the group** to the release stage.
3. Add a step **before** `docker compose … up` (secret vars must be mapped explicitly —
   Azure does not auto-expose secrets as env vars):
   ```yaml
   - task: PowerShell@2
     inputs:
       filePath: scripts/render-env-live.ps1
     env:
       AUTH_JWT_SECRET:              $(AUTH_JWT_SECRET)
       SSO_CLIENT_SECRET:            $(SSO_CLIENT_SECRET)
       SSO_JWE_PRIVATE_KEY:          $(SSO_JWE_PRIVATE_KEY)
       LIVEKIT_API_SECRET:           $(LIVEKIT_API_SECRET)
       MINIO_ROOT_PASSWORD:          $(MINIO_ROOT_PASSWORD)
       DATABASE_URL:                 $(DATABASE_URL)
       DATABASE_URL_LIVE:            $(DATABASE_URL_LIVE)
       LLM_API_KEY:                  $(LLM_API_KEY)
       NEXT_PUBLIC_VAPID_PRIVATE_KEY: $(NEXT_PUBLIC_VAPID_PRIVATE_KEY)
   ```
   then the existing deploy line:
   ```
   docker compose --env-file .env.live -f docker-compose.live.yml up -d --build
   ```

## After setup
Change any value in **Library → colab-live-env → Save → run the release**. That's it —
no server login, no git, no manual `.env.live`. To rotate a secret, edit it in Azure and
re-run.

> Tip: for stronger secret hygiene, back the group with **Azure Key Vault** instead of
> inline secret variables — same script, secrets never leave the vault.
