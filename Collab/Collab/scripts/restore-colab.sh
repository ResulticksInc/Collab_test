#!/usr/bin/env bash
# Restore a CoLab backup produced by backup-colab.sh. DESTRUCTIVE — overwrites the
# current DB (and optionally MinIO). Run on the box hosting the Docker stack.
#
# Usage:
#   ./restore-colab.sh <colab-db-YYYYMMDD-HHMMSS.sql.gz> [colab-minio-...tar.gz]
# Same env overrides as backup-colab.sh (DB_CONTAINER/DB_NAME/DB_USER/DB_PASS/MINIO_CONTAINER).
set -euo pipefail

DB_DUMP="${1:-}"
MINIO_TAR="${2:-}"
DB_CONTAINER="${DB_CONTAINER:-colab-db}"
DB_NAME="${DB_NAME:-colab}"
DB_USER="${DB_USER:-colab}"
DB_PASS="${DB_PASS:-colab}"
MINIO_CONTAINER="${MINIO_CONTAINER:-colab-minio}"
MINIO_DATA_DIR="${MINIO_DATA_DIR:-/data}"

[ -z "$DB_DUMP" ] && { echo "usage: $0 <db.sql.gz> [minio.tar.gz]" >&2; exit 2; }
[ -f "$DB_DUMP" ] || { echo "ERROR: db dump not found: $DB_DUMP" >&2; exit 1; }

echo "!! DESTRUCTIVE RESTORE into $DB_CONTAINER/$DB_NAME from $DB_DUMP"
[ -n "$MINIO_TAR" ] && echo "!! AND MinIO from $MINIO_TAR (object store will be replaced)"
read -r -p "Type 'restore' to proceed: " confirm
[ "$confirm" = "restore" ] || { echo "aborted."; exit 1; }

echo "[restore] restoring database..."
gunzip -c "$DB_DUMP" | docker exec -i "$DB_CONTAINER" sh -c \
  "exec mysql -u'$DB_USER' -p'$DB_PASS' '$DB_NAME'"
echo "[restore]   database restored."

if [ -n "$MINIO_TAR" ]; then
  [ -f "$MINIO_TAR" ] || { echo "ERROR: minio tar not found: $MINIO_TAR" >&2; exit 1; }
  echo "[restore] restoring MinIO (stopping container for a clean swap)..."
  docker stop "$MINIO_CONTAINER" >/dev/null
  # Wipe + extract into the same volume via a throwaway container.
  docker run --rm --volumes-from "$MINIO_CONTAINER" -v "$(cd "$(dirname "$MINIO_TAR")" && pwd)":/backup \
    alpine sh -c "rm -rf '${MINIO_DATA_DIR}'/* && tar xzf /backup/$(basename "$MINIO_TAR") -C /"
  docker start "$MINIO_CONTAINER" >/dev/null
  echo "[restore]   MinIO restored."
fi

echo "[restore] DONE. Restart the backend if it caches schema/connections."
