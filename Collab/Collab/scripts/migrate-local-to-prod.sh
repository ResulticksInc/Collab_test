#!/usr/bin/env bash
# =============================================================================
# migrate-local-to-prod.sh — promote the bundled LOCAL MySQL data into the
# shared corporate PROD MySQL (DATABASE_URL_LIVE in .env.live).
#
# WHAT IT DOES (in order):
#   1. Backs up the PROD `colab` DB to ./colab-prod-backup-<stamp>.sql  (safety net)
#   2. Dumps the LOCAL `colab-db` container (schema + data) to ./colab-local-<stamp>.sql
#   3. Imports that dump into PROD — this REPLACES prod's `colab` contents
#      (mysqldump uses --add-drop-table) so prod becomes an exact mirror of local.
#
# It runs every mysql/mysqldump call THROUGH the `colab-db` container, so the host
# needs no mysql client — only Docker + a running `colab-db`. The container reaches
# prod (10.101.3.2:3603) outbound through Docker's NAT, so the host must be able to
# route to that address (corporate-network firewall must allow it).
#
# ⚠️ DESTRUCTIVE on prod. Triggers are skipped (--skip-triggers); CoLab enforces
#    those rules at the app layer (same as scripts/fresh-prod-migrate.js). Run this
#    ONCE, BEFORE the first user logs in on the live site. Re-running re-mirrors.
#
# USAGE (on the server, from the bundle root):
#   CONFIRM=yes bash scripts/migrate-local-to-prod.sh
#
# Override any default via env, e.g.:
#   PROD_HOST=10.101.3.2 PROD_PORT=3603 LOCAL_CONTAINER=colab-db \
#   CONFIRM=yes bash scripts/migrate-local-to-prod.sh
# =============================================================================
set -euo pipefail

# ── Config (defaults match .env.live) ───────────────────────────────────────
LOCAL_CONTAINER="${LOCAL_CONTAINER:-colab-db}"
LOCAL_DB="${LOCAL_DB:-colab}"
LOCAL_USER="${LOCAL_USER:-colab}"
LOCAL_PASS="${LOCAL_PASS:-colab}"

PROD_HOST="${PROD_HOST:-10.101.3.2}"
PROD_PORT="${PROD_PORT:-3603}"
PROD_DB="${PROD_DB:-colab}"
PROD_USER="${PROD_USER:-res_apdev2945}"
# Prod password MUST come from the environment (.env.live / secret store) — never
# baked into a tracked script. Fails fast if unset (raw form, NOT URL-encoded).
PROD_PASS="${PROD_PASS:?Set PROD_PASS from .env.live / your secret store}"

STAMP="$(date +%Y%m%d-%H%M%S)"
PROD_BACKUP="./colab-prod-backup-${STAMP}.sql"
LOCAL_DUMP="./colab-local-${STAMP}.sql"

DUMP_FLAGS="--single-transaction --skip-triggers --add-drop-table --no-tablespaces --default-character-set=utf8mb4"

say() { printf '\n\033[36m[migrate]\033[0m %s\n' "$*"; }
die() { printf '\n\033[31m[migrate] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "${CONFIRM:-}" != "yes" ]; then
  cat <<EOF

This will REPLACE the PROD database '${PROD_DB}' at ${PROD_HOST}:${PROD_PORT}
with the data from the LOCAL container '${LOCAL_CONTAINER}'. A prod backup is taken
first (${PROD_BACKUP}), but this is destructive.

Re-run with:  CONFIRM=yes bash scripts/migrate-local-to-prod.sh
EOF
  exit 1
fi

# Sanity: the local container must be up.
docker ps --format '{{.Names}}' | grep -qx "${LOCAL_CONTAINER}" \
  || die "container '${LOCAL_CONTAINER}' is not running (start it: docker compose --env-file .env.live -f docker-compose.yml up -d db)"

# ── 1. Back up PROD first (so the cutover is reversible) ─────────────────────
say "1/3  Backing up PROD '${PROD_DB}' -> ${PROD_BACKUP}"
docker exec "${LOCAL_CONTAINER}" sh -c \
  "exec mysqldump ${DUMP_FLAGS} -h'${PROD_HOST}' -P'${PROD_PORT}' -u'${PROD_USER}' -p'${PROD_PASS}' '${PROD_DB}'" \
  > "${PROD_BACKUP}" \
  || die "prod backup failed — check network route to ${PROD_HOST}:${PROD_PORT} and prod credentials. Nothing was changed."
[ -s "${PROD_BACKUP}" ] || die "prod backup is empty — aborting before touching prod."
say "      prod backup OK ($(wc -c < "${PROD_BACKUP}") bytes). Keep this file to roll back."

# ── 2. Dump LOCAL (schema + data) ────────────────────────────────────────────
say "2/3  Dumping LOCAL '${LOCAL_DB}' from ${LOCAL_CONTAINER} -> ${LOCAL_DUMP}"
docker exec "${LOCAL_CONTAINER}" sh -c \
  "exec mysqldump ${DUMP_FLAGS} -u'${LOCAL_USER}' -p'${LOCAL_PASS}' '${LOCAL_DB}'" \
  > "${LOCAL_DUMP}" \
  || die "local dump failed."
[ -s "${LOCAL_DUMP}" ] || die "local dump is empty — aborting."
say "      local dump OK ($(wc -c < "${LOCAL_DUMP}") bytes)."

# ── 3. Import LOCAL dump into PROD (replaces prod tables) ─────────────────────
say "3/3  Importing local dump into PROD '${PROD_DB}' (this replaces prod tables)"
docker exec -i "${LOCAL_CONTAINER}" sh -c \
  "exec mysql -h'${PROD_HOST}' -P'${PROD_PORT}' -u'${PROD_USER}' -p'${PROD_PASS}' '${PROD_DB}'" \
  < "${LOCAL_DUMP}" \
  || die "import into prod failed. Prod may be partially written — restore with:
  docker exec -i ${LOCAL_CONTAINER} sh -c \"exec mysql -h'${PROD_HOST}' -P'${PROD_PORT}' -u'${PROD_USER}' -p'<pass>' '${PROD_DB}'\" < ${PROD_BACKUP}"

# ── Verify ───────────────────────────────────────────────────────────────────
say "Verifying prod row counts (users / messages):"
docker exec "${LOCAL_CONTAINER}" sh -c \
  "exec mysql -N -h'${PROD_HOST}' -P'${PROD_PORT}' -u'${PROD_USER}' -p'${PROD_PASS}' '${PROD_DB}' \
   -e \"SELECT CONCAT('users=', (SELECT COUNT(*) FROM users)), CONCAT('messages=', (SELECT COUNT(*) FROM messages));\"" \
  || say "(verify query skipped — table names differ? data still imported.)"

say "DONE. Prod '${PROD_DB}' now mirrors local. Backup: ${PROD_BACKUP}"
echo
echo "Next: restart the stack so the backend (DB_PROFILE=live) serves prod data:"
echo "  docker compose --env-file .env.live -f docker-compose.yml --profile production up -d"
