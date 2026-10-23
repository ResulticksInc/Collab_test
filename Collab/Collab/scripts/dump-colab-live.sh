#!/usr/bin/env bash
# =============================================================================
# dump-colab-live.sh  —  RUN ON THE LIVE SERVER
#
# Produces a COMPLETE, zero-data-loss mysqldump of the bundled CoLab MySQL
# (container 'colab-db', db 'colab', user colab / pass colab) into
# ./colab-live-data.sql, then prints the file size and a per-table row-count
# BASELINE (from the SOURCE) so the load can be proven complete afterward.
#
# READ-ONLY on the source: --single-transaction takes a consistent InnoDB
# snapshot without locking the live app; nothing here writes to the source DB.
#
# All mysql/mysqldump calls run THROUGH the colab-db container, so the host
# needs no mysql client — only Docker + a running 'colab-db' (matches the
# existing scripts/migrate-local-to-prod.sh convention).
#
# USAGE (on the server, from the bundle root):
#   bash scripts/dump-colab-live.sh
# Override defaults via env if needed:
#   SRC_CONTAINER=colab-db SRC_DB=colab SRC_USER=colab SRC_PASS=colab \
#   OUT_FILE=colab-live-data.sql BASELINE_FILE=colab-source-counts.txt \
#   bash scripts/dump-colab-live.sh
# =============================================================================
set -euo pipefail

# ── Config (defaults match the bundled local container) ──────────────────────
SRC_CONTAINER="${SRC_CONTAINER:-colab-db}"
SRC_DB="${SRC_DB:-colab}"
SRC_USER="${SRC_USER:-colab}"
SRC_PASS="${SRC_PASS:-colab}"
OUT_FILE="${OUT_FILE:-colab-live-data.sql}"
BASELINE_FILE="${BASELINE_FILE:-colab-source-counts.txt}"

say()  { printf '\n\033[36m[dump]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m[dump] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

# Canonical CoLab table set — enumerated from every CREATE TABLE in
# database/migrations/0001..0045 PLUS the two control tables. 36 total.
# Do NOT derive this from schema.sql (incomplete, ~21 tables) or by grepping
# the driver (misses deploy_state). This list is the verification baseline.
TABLES=(
  users conversations conversation_members messages message_deletions
  audit_log bookmarks meetings meeting_attendees meeting_presence
  meeting_lobby meeting_ejected meeting_recordings meeting_messages folders
  reminders calls voicemails user_settings user_blocks
  user_reports tasks task_activity task_deps task_comments
  invites files file_shares scheduled_messages notifications
  e2ee_devices e2ee_one_time_prekeys e2ee_conversation_keys deploy_state
  schema_migrations
)

# ── 0. Preflight: the source container must be running ───────────────────────
command -v docker >/dev/null 2>&1 || die "docker not found on PATH."
docker ps --format '{{.Names}}' | grep -qx "${SRC_CONTAINER}" \
  || die "container '${SRC_CONTAINER}' is not running. Start it first:
  docker compose --env-file .env.live -f docker-compose.live.yml up -d db"

say "Source: container=${SRC_CONTAINER} db=${SRC_DB} user=${SRC_USER}"
say "Output: ${OUT_FILE}   Baseline: ${BASELINE_FILE}"

# Helper: run a mysql command inside the container, password fed via env so it
# never appears in the process list. -N = no column headers (raw values).
src_mysql() {
  docker exec -e MYSQL_PWD="${SRC_PASS}" "${SRC_CONTAINER}" \
    mysql -N -u"${SRC_USER}" "${SRC_DB}" "$@"
}

# Connectivity check (also proves the password works) before the long dump.
src_mysql -e "SELECT 1" >/dev/null 2>&1 \
  || die "cannot connect to '${SRC_DB}' inside '${SRC_CONTAINER}' as '${SRC_USER}'. Check creds."

# ── 1. The dump ──────────────────────────────────────────────────────────────
# Flags (every one justified by the audit):
#   --single-transaction --skip-lock-tables : consistent InnoDB snapshot, no
#       app lock-out, READ-ONLY on source.
#   --default-character-set=utf8mb4 : emoji / non-ASCII names / JSON / HTML
#       message bodies / data-URL avatars survive (DB is utf8mb4_0900_ai_ci).
#   --hex-blob : files.data LONGBLOB + voicemail audio emitted as 0x.. hex so
#       the .sql is ASCII-safe through shells/transfer and reloads byte-exact.
#   --triggers --routines --events : archival completeness (0009 meeting-past +
#       0018 audit-append-only triggers captured; no routines/events exist today
#       so those are harmless no-ops and future-proof).
#   --no-tablespaces : avoid the PROCESS privilege the app user lacks.
#   --set-gtid-purged=OFF : do not emit GTID_PURGED (errors on a GTID target).
#   --column-statistics=0 : suppress histogram query that breaks mismatched
#       clients.
#   --max-allowed-packet=1G : single rows are multi-MB (LONGBLOB files, base64
#       avatars, recording metadata); default 16-64M can abort mid-dump.
#   --add-drop-table : clean, idempotent reload (DROP TABLE IF EXISTS per table).
#   --ignore-table=<db>.deploy_state : deploy_state is promotion CONTROL state
#       (PK = phase). The loader stamps it 'existing' itself; copying the source's
#       row would leave the target with TWO deploy_state rows and promoteIfNeeded's
#       'LIMIT 1' would read an arbitrary one. So we never copy it as data.
# mysqldump already wraps the file with FOREIGN_KEY_CHECKS=0 / UNIQUE_CHECKS=0
# and restores them at the end, and emits AUTO_INCREMENT=<n> on audit_log.
DUMP_FLAGS="--single-transaction --skip-lock-tables \
--default-character-set=utf8mb4 --hex-blob \
--triggers --routines --events \
--no-tablespaces --set-gtid-purged=OFF --column-statistics=0 \
--max-allowed-packet=1G --add-drop-table \
--ignore-table=${SRC_DB}.deploy_state"

say "1/3  Dumping '${SRC_DB}' (schema + data + triggers, hex-blob, utf8mb4) ..."
# Run mysqldump inside the container; stream stdout to the host file. Password
# via MYSQL_PWD so it never hits the arg list. 'exec' so signals pass through.
if ! docker exec -e MYSQL_PWD="${SRC_PASS}" "${SRC_CONTAINER}" \
       sh -c "exec mysqldump ${DUMP_FLAGS} -u'${SRC_USER}' '${SRC_DB}'" \
       > "${OUT_FILE}"; then
  rm -f "${OUT_FILE}"
  die "mysqldump failed. Source DB was NOT modified. Nothing written."
fi

# ── 2. Integrity checks on the artifact ──────────────────────────────────────
[ -s "${OUT_FILE}" ] || die "dump file is empty — aborting."
# mysqldump writes '-- Dump completed on ...' as its final line only on success.
# Its ABSENCE means the dump was TRUNCATED mid-stream (the #1 silent-loss trap).
if ! tail -n 5 "${OUT_FILE}" | grep -q -- "-- Dump completed"; then
  die "dump is missing the '-- Dump completed' trailer — it was TRUNCATED. Re-run; do NOT load this file."
fi
BYTES=$(wc -c < "${OUT_FILE}" | tr -d ' ')
SHA=$(sha256sum "${OUT_FILE}" 2>/dev/null | cut -d' ' -f1 || echo "n/a")
say "      dump OK — ${OUT_FILE}  size=${BYTES} bytes  sha256=${SHA}"
echo "${SHA}  ${OUT_FILE}" > "${OUT_FILE}.sha256" || true

# ── 3. SOURCE row-count baseline (the proof-of-completeness reference) ────────
# Real COUNT(*) per table (NOT information_schema.table_rows, which is an
# InnoDB estimate). Written as 'table<TAB>count' to BASELINE_FILE and echoed.
say "2/3  Capturing SOURCE row-count baseline -> ${BASELINE_FILE}"
: > "${BASELINE_FILE}"
TOTAL=0
printf '\n  %-28s %10s\n' "TABLE" "ROWS"
printf '  %-28s %10s\n' "----------------------------" "----------"
for t in "${TABLES[@]}"; do
  # If a table somehow does not exist on the source, record -1 and continue
  # (the dump captures whatever exists; the verifier flags any real mismatch).
  if cnt=$(src_mysql -e "SELECT COUNT(*) FROM \`${t}\`" 2>/dev/null); then
    cnt=$(echo "${cnt}" | tr -d '[:space:]')
    printf '  %-28s %10s\n' "${t}" "${cnt}"
    printf '%s\t%s\n' "${t}" "${cnt}" >> "${BASELINE_FILE}"
    TOTAL=$((TOTAL + cnt))
  else
    printf '  %-28s %10s\n' "${t}" "MISSING"
    printf '%s\t%s\n' "${t}" "-1" >> "${BASELINE_FILE}"
  fi
done
printf '  %-28s %10s\n' "----------------------------" "----------"
printf '  %-28s %10s\n\n' "TOTAL (counted tables)" "${TOTAL}"

# audit_log AUTO_INCREMENT high-water mark — the only AUTO_INCREMENT table.
# Captured so the load can be proven to preserve the counter.
AI=$(src_mysql -e "SELECT AUTO_INCREMENT FROM information_schema.tables WHERE table_schema='${SRC_DB}' AND table_name='audit_log'" 2>/dev/null | tr -d '[:space:]' || echo "")
say "3/3  audit_log AUTO_INCREMENT (source) = ${AI:-unknown}  (recorded in baseline)"
printf '__audit_log_auto_increment\t%s\n' "${AI:-0}" >> "${BASELINE_FILE}"

say "DONE. Transfer BOTH files to the load host:"
echo "  - ${OUT_FILE}        (the data)"
echo "  - ${BASELINE_FILE}   (source counts for PASS/FAIL verification)"
echo
echo "Next:  bash scripts/load-colab-target.sh   (loads into the chosen MySQL 8 target)"
echo "Then:  node scripts/verify-colab-target.cjs ${BASELINE_FILE}   (proves zero loss)"