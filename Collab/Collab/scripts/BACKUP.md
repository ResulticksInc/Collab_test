# CoLab backups (cost‑free, dependency‑free)

`backup-colab.sh` dumps the **MySQL database** (consistent, `--single-transaction`)
and archives the **MinIO object store** (attachments/recordings) using only Docker
+ `mysqldump` + `tar`. No cloud SDK, no paid service. `restore-colab.sh` puts them
back.

> **Why this matters:** today the live data lives in a single bundled MySQL
> container's volume on the host. Without backups, a disk/host failure = total
> loss. This makes the data recoverable for $0.

## Run a backup
```bash
# On the box hosting the Docker stack. Override creds for live (from .env.live):
DB_USER=colab DB_PASS='<live-pass>' DB_NAME=colab \
BACKUP_DIR=/srv/colab-backups RETAIN_DAYS=14 \
  bash scripts/backup-colab.sh
```
Produces `colab-db-<ts>.sql.gz` + `colab-minio-<ts>.tar.gz` in `$BACKUP_DIR`, and
prunes anything older than `RETAIN_DAYS`.

## Restore
```bash
bash scripts/restore-colab.sh /srv/colab-backups/colab-db-<ts>.sql.gz \
                              /srv/colab-backups/colab-minio-<ts>.tar.gz
# (DB-only restore: omit the second arg.)
```

## Schedule it (nightly, 2am)
```bash
crontab -e
# m h  dom mon dow   command
0 2 * * *  DB_USER=colab DB_PASS='<live-pass>' BACKUP_DIR=/srv/colab-backups bash /opt/CoLab/scripts/backup-colab.sh >> /var/log/colab-backup.log 2>&1
```

## ⚠️ The part only YOU can do — non‑negotiable for a *real* backup
A backup sitting on the **same box** as the data dies with the box. The script is
free; the **off‑box destination is on you**. Pick one (any works):
- Copy `$BACKUP_DIR` to a **second physical disk** / a mounted **NAS**, OR
- `rsync`/`scp` it to **another server**, OR
- Push to a **free object bucket** (e.g. Backblaze B2 free tier, an internal S3),
  e.g. add `rclone copy "$BACKUP_DIR" remote:colab-backups` to the cron after the
  backup runs.

And **test a restore** at least once into a scratch DB — an untested backup is a
hope, not a backup.
