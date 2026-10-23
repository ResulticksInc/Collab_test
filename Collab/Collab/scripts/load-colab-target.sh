#!/usr/bin/env bash
# =============================================================================
# load-colab-target.sh  —  load colab-live-data.sql into the TARGET MySQL 8
#
# Default target = the corporate MySQL at 10.101.3.2:3603/colab, with creds read
# from .env.live (DATABASE_URL_LIVE) so the password is NEVER inlined. You can
# override any field via env or by passing a full DATABASE URL as $1.
#
# SAFETY:
#   • Takes a TIMESTAMPED BACKUP of the target FIRST (rollback path) and aborts
#     if that backup is empty.
#   • Requires CONFIRM=yes  (the load uses --add-drop-table => DESTRUCTIVE replace).
#   • Refuses to load a truncated dump (checks the '-- Dump completed' trailer).
#   • Wraps the import in SET FOREIGN_KEY_CHECKS=0 / UNIQUE_CHECKS=0 /
#     sql_mode='NO_AUTO_VALUE_ON_ZERO', restored at the end — so FK order and the
#     audit_log AUTO_INCREMENT are handled regardless of mysqldump's own guards.
#   • Raises max_allowed_packet on the client so multi-MB blob/avatar rows load.
#   • Confirms target is MySQL 8.0+ (utf8mb4_0900_ai_ci collation requirement).
#
# It can run either via a local `mysql` client (if present) or THROUGH the
# colab-db container (set USE_CONTAINER=colab-db) exactly like the source dump.
#
# USAGE (target = default corporate DB, creds from .env.live):
#   CONFIRM=yes bash scripts/load-colab-target.sh
# USAGE (explicit target URL):
#   CONFIRM=yes bash scripts/load-colab-target.sh mysql://user:pass@host:3603/colab
# USAGE (route through the container, no host mysql client):
#   CONFIRM=yes USE_CONTAINER=colab-db bash scripts/load-colab-target.sh
# =============================================================================
set -euo pipefail

IN_FILE="${IN_FILE:-colab-live-data.sql}"
ENV_FILE="${ENV_FILE:-.env.live}"
USE_CONTAINER="${USE_CONTAINER:-}"           # set to a container name to route mysql through Docker
STAMP="$(date +%Y%m%d-%H%M%S)"

say()  { printf '\n\033[36m[load]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[33m[load] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[31m[load] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Resolve target connection (priority: $1 URL > $DATABASE_URL_TARGET > .env.live) ──
TGT_HOST=""; TGT_PORT=""; TGT_USER=""; TGT_PASS=""; TGT_DB=""

parse_url() {  # $1 = mysql://user:pass@host:port/db  -> sets TGT_* (URL-decoded)
  local url="$1"
  local rest="${url#mysql://}"          # strip scheme
  local creds="${rest%%@*}"
  local hostpart="${rest#*@}"
  local user="${creds%%:*}"
  local pass="${creds#*:}"
  local hostport="${hostpart%%/*}"
  local db="${hostpart#*/}"
  db="${db%%\?*}"                        # drop any ?query
  TGT_HOST="${hostport%%:*}"
  TGT_PORT="${hostport#*:}"; [ "${TGT_PORT}" = "${TGT_HOST}" ] && TGT_PORT=3306
  TGT_USER="${user}"
  TGT_PASS="${pass}"
  TGT_DB="${db}"
  # URL-decode percent escapes (the live password's '#' is stored as %23).
  TGT_PASS="$(printf '%b' "${TGT_PASS//%/\\x}")"
  TGT_USER="$(printf '%b' "${TGT_USER//%/\\x}")"
}

if [ "${1:-}" != "" ]; then
  say "Using target URL from \$1"
  parse_url "$1"
elif [ -n "${DATABASE_URL_TARGET:-}" ]; then
  say "Using target URL from \$DATABASE_URL_TARGET"
  parse_url "${DATABASE_URL_TARGET}"
else
  # Default: read DATABASE_URL_LIVE from .env.live (never printed).
  [ -f "${ENV_FILE}" ] || die "${ENV_FILE} not found and no target URL given. Pass a mysql:// URL as \$1."
  URL_LINE="$(grep -E '^DATABASE_URL_LIVE=' "${ENV_FILE}" | head -n1 | cut -d= -f2-)"
  [ -n "${URL_LINE}" ] || die "DATABASE_URL_LIVE not found in ${ENV_FILE}."
  say "Using target from ${ENV_FILE} (DATABASE_URL_LIVE) — credential not printed."
  parse_url "${URL_LINE}"
fi

# Allow discrete env overrides on top of whatever was parsed.
TGT_HOST="${TGT_HOST_OVERRIDE:-${TGT_HOST}}"
TGT_PORT="${TGT_PORT_OVERRIDE:-${TGT_PORT}}"
TGT_USER="${TGT_USER_OVERRIDE:-${TGT_USER}}"
TGT_DB="${TGT_DB_OVERRIDE:-${TGT_DB}}"
[ -n "${TGT_PASS_OVERRIDE:-}" ] && TGT_PASS="${TGT_PASS_OVERRIDE}"

[ -n "${TGT_HOST}" ] && [ -n "${TGT_DB}" ] && [ -n "${TGT_USER}" ] \
  || die "incomplete target connection (host=${TGT_HOST} db=${TGT_DB} user=${TGT_USER})."

say "Target: ${TGT_USER}@${TGT_HOST}:${TGT_PORT}/${TGT_DB}   (password hidden)"

# ── mysql / mysqldump runners (host client OR through a container) ────────────
# Password passed via MYSQL_PWD env so it never appears in the process list.
run_mysql() {      # stdin allowed; extra args forwarded
  if [ -n "${USE_CONTAINER}" ]; then
    docker exec -i -e MYSQL_PWD="${TGT_PASS}" "${USE_CONTAINER}" \
      mysql --max-allowed-packet=1G --default-character-set=utf8mb4 \
            -h"${TGT_HOST}" -P"${TGT_PORT}" -u"${TGT_USER}" "${TGT_DB}" "$@"
  else
    MYSQL_PWD="${TGT_PASS}" mysql --max-allowed-packet=1G --default-character-set=utf8mb4 \
            -h"${TGT_HOST}" -P"${TGT_PORT}" -u"${TGT_USER}" "${TGT_DB}" "$@"
  fi
}
run_mysqldump() {  # used for the safety backup
  if [ -n "${USE_CONTAINER}" ]; then
    docker exec -e MYSQL_PWD="${TGT_PASS}" "${USE_CONTAINER}" \
      sh -c "exec mysqldump --single-transaction --skip-lock-tables --skip-triggers \
             --no-tablespaces --default-character-set=utf8mb4 --hex-blob \
             --set-gtid-purged=OFF --column-statistics=0 --max-allowed-packet=1G \
             --add-drop-table -h'${TGT_HOST}' -P'${TGT_PORT}' -u'${TGT_USER}' '${TGT_DB}'"
  else
    MYSQL_PWD="${TGT_PASS}" mysqldump --single-transaction --skip-lock-tables --skip-triggers \
             --no-tablespaces --default-character-set=utf8mb4 --hex-blob \
             --set-gtid-purged=OFF --column-statistics=0 --max-allowed-packet=1G \
             --add-drop-table -h"${TGT_HOST}" -P"${TGT_PORT}" -u"${TGT_USER}" "${TGT_DB}"
  fi
}

# ── Preflight ────────────────────────────────────────────────────────────────
[ -f "${IN_FILE}" ] || die "input dump '${IN_FILE}' not found (run dump-colab-live.sh first)."
[ -s "${IN_FILE}" ] || die "input dump '${IN_FILE}' is empty."
# Refuse a truncated dump.
if ! tail -n 5 "${IN_FILE}" | grep -q -- "-- Dump completed"; then
  die "'${IN_FILE}' is missing the '-- Dump completed' trailer (TRUNCATED). Do NOT load it."
fi

# Connectivity + version gate (collation utf8mb4_0900_ai_ci is MySQL-8-only).
run_mysql -N -e "SELECT 1" >/dev/null 2>&1 \
  || die "cannot reach ${TGT_HOST}:${TGT_PORT}/${TGT_DB} as ${TGT_USER}. On corporate net/VPN? Creds OK?"
VER="$(run_mysql -N -e "SELECT VERSION()" 2>/dev/null | tr -d '[:space:]')"
say "Target server version: ${VER}"
case "${VER}" in
  8.*|9.*) : ;;  # MySQL 8/9 — utf8mb4_0900_ai_ci exists.
  *) warn "Target is NOT MySQL 8/9 (got '${VER}'). The dump uses utf8mb4_0900_ai_ci which may not exist; CREATE TABLE could fail. Consider rewriting COLLATE before loading." ;;
esac

if [ "${CONFIRM:-}" != "yes" ]; then
  cat <<EOF

This will REPLACE the contents of ${TGT_DB} at ${TGT_HOST}:${TGT_PORT}
(the dump uses --add-drop-table => existing tables are DROPPED + recreated).
A timestamped backup of the target is taken FIRST.

Re-run with:  CONFIRM=yes bash scripts/load-colab-target.sh
EOF
  exit 1
fi

# ── 1. Back up the target first (rollback path) ──────────────────────────────
BACKUP="./colab-target-backup-${STAMP}.sql"
say "1/3  Backing up target ${TGT_DB} -> ${BACKUP}"
if ! run_mysqldump > "${BACKUP}"; then
  rm -f "${BACKUP}"
  die "target backup FAILED — refusing to load. Target unchanged."
fi
[ -s "${BACKUP}" ] || die "target backup is EMPTY — refusing to load. (Is the DB reachable / does it exist?)"
say "      target backup OK ($(wc -c < "${BACKUP}" | tr -d ' ') bytes). Roll back with:  run_mysql < ${BACKUP}"

# ── 2. Load the source dump ──────────────────────────────────────────────────
# Wrap the stream: disable FK/UNIQUE checks + permissive sql_mode around the
# dump, restore at the end. mysqldump already emits its own guards, but this is
# belt-and-braces and neutralizes an unusually strict target sql_mode.
WRAP_PRE="$(cat <<'SQL'
SET @COLAB_OLD_FK=@@FOREIGN_KEY_CHECKS, @COLAB_OLD_UQ=@@UNIQUE_CHECKS, @COLAB_OLD_MODE=@@SESSION.sql_mode;
SET FOREIGN_KEY_CHECKS=0;
SET UNIQUE_CHECKS=0;
SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO';
SET NAMES utf8mb4;
SQL
)"
WRAP_POST="$(cat <<'SQL'
SET FOREIGN_KEY_CHECKS=@COLAB_OLD_FK;
SET UNIQUE_CHECKS=@COLAB_OLD_UQ;
SET SESSION sql_mode=@COLAB_OLD_MODE;
SQL
)"

say "2/3  Loading ${IN_FILE} into ${TGT_DB} (FK/UNIQUE checks off, utf8mb4, packet=1G) ..."
if ! { printf '%s\n' "${WRAP_PRE}"; cat "${IN_FILE}"; printf '%s\n' "${WRAP_POST}"; } | run_mysql; then
  die "IMPORT FAILED. Target may be partially written. Roll back with:
  ${USE_CONTAINER:+docker exec -i -e MYSQL_PWD=*** ${USE_CONTAINER} }mysql -h${TGT_HOST} -P${TGT_PORT} -u${TGT_USER} ${TGT_DB} < ${BACKUP}"
fi
say "      import completed."

# ── 3. Post-load housekeeping ────────────────────────────────────────────────
# Realign audit_log AUTO_INCREMENT to MAX(id)+1 (defensive; mysqldump usually
# preserves it via the CREATE TABLE counter, but a re-load can drift it).
say "3/3  Realigning audit_log AUTO_INCREMENT and stamping deploy_state ..."
run_mysql -N -e "
  SET @mx := (SELECT IFNULL(MAX(id),0)+1 FROM audit_log);
  SET @sql := CONCAT('ALTER TABLE audit_log AUTO_INCREMENT=', @mx);
  PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
" 2>/dev/null || warn "could not realign audit_log AUTO_INCREMENT (non-fatal)."

# Stamp deploy_state so the app's promoteIfNeeded() never re-imports the bundled
# dump over this data on next boot (it returns immediately when a phase row
# exists and COLAB_FORCE_REIMPORT is unset). Idempotent.
run_mysql -N -e "
  INSERT IGNORE INTO deploy_state (phase, notes)
  VALUES ('existing', 'data loaded externally via load-colab-target.sh on ${STAMP}');
" 2>/dev/null || warn "could not stamp deploy_state (table absent?) — set it manually if you rely on promoteIfNeeded."

say "DONE. Target ${TGT_DB} loaded. Backup kept at ${BACKUP} (rollback)."
echo
echo "VERIFY NOW (required):"
echo "  node scripts/verify-colab-target.cjs colab-source-counts.txt"
echo "  -> must print PASS for every table before go-live."