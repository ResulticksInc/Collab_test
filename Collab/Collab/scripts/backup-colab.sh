#!/usr/bin/env bash
# Cost-free, dependency-free backup of the LIVE CoLab data: the MySQL database
# (consistent dump) + the MinIO object store (attachments/recordings). Uses only
# Docker + mysqldump + tar — no cloud SDK, no paid service.
#
# Run on the box that hosts the Docker stack. Schedule it (see scripts/BACKUP.md).
# IMPORTANT: a backup that only lives on the SAME box as the data is NOT a real
# backup — copy $BACKUP_DIR off-box (NAS / another disk / a bucket). See BACKUP.md.
#
# Config via env (defaults = docker-compose service names / local creds — OVERRIDE
# for live, e.g. DB_USER/DB_PASS/DB_NAME from .env.live):
#   DB_CONTAINER (default colab-db)  DB_NAME/DB_USER/DB_PASS (default colab/colab/colab)
#   MINIO_CONTAINER (default colab-minio)  MINIO_DATA_DIR (default /data)
#   BACKUP_DIR (default ./backups)   RETAIN_DAYS (default 14)
set -euo pipefail

DB_CONTAINER="${DB_CONTAINER:-colab-db}"
DB_NAME="${DB_NAME:-colab}"
DB_USER="${DB_USER:-colab}"
DB_PASS="${DB_PASS:-colab}"
MINIO_CONTAINER="${MINIO_CONTAINER:-colab-minio}"
MINIO_DATA_DIR="${MINIO_DATA_DIR:-/data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
DB_OUT="$BACKUP_DIR/colab-db-$TS.sql.gz"
MINIO_OUT="$BACKUP_DIR/colab-minio-$TS.tar.gz"

echo "[backup] $TS — DB=$DB_CONTAINER/$DB_NAME  MinIO=$MINIO_CONTAINER  -> $BACKUP_DIR"

# ── 1. MySQL: consistent dump (single-transaction = no table locks on InnoDB) ──
echo "[backup] dumping database..."
docker exec "$DB_CONTAINER" sh -c \
  "exec mysqldump -u'$DB_USER' -p'$DB_PASS' --single-transaction --quick \
   --routines --triggers --events --no-tablespaces '$DB_NAME'" \
  | gzip > "$DB_OUT"

# Fail loudly if the dump is suspiciously small (creds wrong / DB empty).
DB_BYTES=$(wc -c < "$DB_OUT")
if [ "$DB_BYTES" -lt 1000 ]; then
  echo "[backup] ERROR: db dump is only ${DB_BYTES} bytes — aborting (check DB_USER/DB_PASS/DB_NAME)." >&2
  rm -f "$DB_OUT"
  exit 1
fi
echo "[backup]   db dump: $DB_OUT ($((DB_BYTES/1024)) KB)"

# ── 2. MinIO: tar the object-store data via a throwaway container ─────────────
echo "[backup] archiving MinIO object store..."
docker run --rm --volumes-from "$MINIO_CONTAINER" -v "$(cd "$BACKUP_DIR" && pwd)":/backup \
  alpine sh -c "tar czf /backup/$(basename "$MINIO_OUT") -C / '${MINIO_DATA_DIR#/}'" \
  || { echo "[backup] WARN: MinIO archive failed (continuing — DB dump is safe)." >&2; }
[ -f "$MINIO_OUT" ] && echo "[backup]   minio: $MINIO_OUT ($(( $(wc -c < "$MINIO_OUT")/1024/1024 )) MB)"

# ── 3. Retention: prune backups older than RETAIN_DAYS ───────────────────────
echo "[backup] pruning backups older than ${RETAIN_DAYS}d..."
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'colab-*' -mtime "+$RETAIN_DAYS" -print -delete || true

echo "[backup] DONE. Remember: copy $BACKUP_DIR OFF-BOX or this isn't disaster-proof."
