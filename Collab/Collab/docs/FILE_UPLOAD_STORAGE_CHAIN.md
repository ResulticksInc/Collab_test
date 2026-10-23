# File upload storage chain — local disk → MinIO → MySQL (≤ 8 MB)

**Status:** implemented on UAT (uncommitted as of 2026-10-06; see §14 for what was verified) · **Plan date:** 2026-10-05
**Scope:** document / attachment uploads through `POST /api/files` (chat attachments,
voice notes, screenshots, task attachments). Call recordings and custom stickers keep
writing straight to MinIO and are out of scope for this change.

---

## 1. Goal

Every upload is stored by walking a fixed chain of tiers until one succeeds:

| Order | Tier | Backend | Used when |
|---|---|---|---|
| 1 | **File storage** | local disk volume on the backend (`FILE_STORAGE_DIR`) | always tried first |
| 2 | **MinIO** | existing S3 bucket (`S3_*`) | disk tier refused / failed |
| 3 | **MySQL** | `files.data` LONGBLOB | MinIO failed **and** file size ≤ 8 MB |

If the chain is exhausted the request fails with the existing honest `503 STORAGE_UNAVAILABLE`.
Downloads, share links, previews, GC and health checks are updated so a file can be read
back from whichever tier accepted it.

**Assumption to confirm with the requester:** the chain above is a *priority order*
(disk is the primary store, MinIO and MySQL are fallbacks). The alternative reading,
"stage on disk, then always copy to MinIO", is noted in §12 as a follow-up and is not
part of this plan.

---

## 2. Current behaviour (what we change)

Source of truth today:

- `backend/app/src/services/fileService.ts` → `create()` (lines ~152–219).
  - Uploads ≤ `FILE_BLOB_FALLBACK_MAX_BYTES` (default **8 MB**, `config/src/index.ts:271`)
    are buffered, pushed to MinIO, and on MinIO failure written to `files.data`.
  - Uploads > 8 MB are streamed to MinIO (multipart). No fallback; failure → 503.
- `backend/app/src/services/storageService.ts` — S3 client, `upload / getStream / remove /
  presignedUrl / pingBucket`, fast-fail connect timeouts, `NoSuchKey → 404`.
- `database/src/drivers/mysql.ts` → `files.create / getMeta / getData / getByToken /
  claimForGc / hardDelete`. A row is "on S3" when `storage_key IS NOT NULL`, otherwise
  bytes are in `data`.
- Read path: `getDownload`, `linkDownload`, `ticketDownload`, `getPresignedUrl` in
  `fileService.ts`; `routes/files.ts` pipes the stream or sends the buffer.
- GC: `backend/app/src/services/fileGcService.ts` deletes the S3 object then hard-deletes
  the row.
- Health: `routes/health.ts` `/ready` probes `pingBucket()` as a non-critical `minio` check.

Schema (`database/schema/schema.sql:375`):

```
data         LONGBLOB NULL
storage_key  TEXT NULL
```

There is no column that says *which* backend holds the bytes; it is inferred from
`storage_key` being set. The disk tier needs an explicit backend column.

---

## 3. Target behaviour

### 3.1 Decision flow in `fileService.create()`

```
size = declared Content-Length (already validated ≤ 2 GB by the route)
small = size > 0 && size <= FILE_BLOB_FALLBACK_MAX_BYTES   (8 MB)

if small:
    buf = readAll(stream, 8 MB)           # existing helper; stream consumed once, safely
    try disk.upload(key, buf)     → backend = "disk"
    else try s3.upload(key, buf)  → backend = "s3"
    else                          → backend = "db" (bytes go in files.data)
else (large, must stream):
    if disk.preflight(size) ok:           # dir writable + free space ≥ size + headroom
        try disk.uploadStream(key, stream) → backend = "disk"
        on mid-stream failure: cleanup temp file → 503 STORAGE_UNAVAILABLE
                               (stream is consumed; nothing left to retry — same as today)
    else:
        try s3.upload(key, stream)         → backend = "s3"
        on failure → 503 STORAGE_UNAVAILABLE
    # no MySQL tier for > 8 MB (max_allowed_packet / LONGBLOB cost — unchanged)
```

Every fallback step logs a `console.warn("[files] <tier> unavailable — falling back to
<next>: <reason>")` so an outage is visible even though the user's upload succeeded.

### 3.2 Tier order is configurable

`FILE_STORAGE_ORDER` (default `disk,s3,db`). Setting `s3,db` restores today's behaviour
exactly, which is the rollback switch. Unknown tier names are rejected at boot.
`db` is only ever consulted for `small` uploads regardless of its position.

### 3.3 Read path

A row's `storage_backend` drives the read:

| backend | download / link / ticket | presigned URL | Range support |
|---|---|---|---|
| `disk` | `fs.createReadStream(abs, {start,end})` piped by the route | **not available** → returns `null` like a BLOB row today (client already falls back to the proxy download) | yes, native |
| `s3` | unchanged (`storage.getStream`) | unchanged | yes |
| `db` | unchanged (`db.files.getData`) | not available | no (whole buffer) |

Legacy rows (`storage_backend` empty) are resolved by the migration backfill (§4), so no
runtime inference is needed after migration.

---

## 4. Schema change — `database/migrations/0127_files_storage_backend.sql`

```sql
-- 0127_files_storage_backend.sql
--
-- Which tier holds a file's bytes. Until now this was inferred from storage_key
-- (NULL → LONGBLOB in `data`, otherwise S3). The local-disk tier reuses
-- storage_key as a relative path, so the backend must be explicit.
ALTER TABLE files
  ADD COLUMN storage_backend VARCHAR(8) NOT NULL DEFAULT '' AFTER storage_key;

UPDATE files SET storage_backend = 's3' WHERE storage_backend = '' AND storage_key IS NOT NULL;
UPDATE files SET storage_backend = 'db' WHERE storage_backend = '' AND storage_key IS NULL;
```

- `storage_key` is **reused** for the disk tier as the relative path under
  `FILE_STORAGE_DIR` (same `files/YYYY/MM/DD/<uploader>/<uid>-<name>` shape from
  `storageService.storageKey`). No new path column.
- Mirror the column in `database/schema/schema.sql` (fresh installs) and add the
  migration to whatever ordered list the migrator reads (follow 0126's pattern).
- Driver changes in `database/src/drivers/mysql.ts`:
  - `files.create` — insert `storage_backend` (caller passes it; default `'db'` when
    `data` is given, must be `'disk' | 's3'` when `storage_key` is given).
  - Every `SELECT` that returns `storage_key` also returns `storage_backend`
    (`getMeta`, `getDeletedMeta`, `getByToken`, `getById`-style list queries,
    `claimForGc`, task attachment join at ~line 3683).
  - Row mapper: `storageBackend: r.storage_backend || null`.
- Add the column to `driver-parity.test.ts` expectations if that test enumerates
  `files` columns.

---

## 5. Config — `config/src/index.ts`

Add under `storage:`:

```ts
// Tier order for POST /api/files. "disk,s3,db" (default) = local volume first,
// MinIO second, MySQL LONGBLOB third (small uploads only). "s3,db" = legacy.
order: str("FILE_STORAGE_ORDER", "disk,s3,db"),
// Root of the local file-storage tier. Inside the container this is a named
// volume (files_data:/app/data/files); host-run backends default to ./data/files.
localDir: str("FILE_STORAGE_DIR", "./data/files"),
// Disk tier refuses an upload (and the chain moves on to MinIO) unless at least
// this much space is free AFTER the upload would land. 512 MB default.
localMinFreeBytes: num("FILE_STORAGE_MIN_FREE_BYTES", 512 * 1024 * 1024),
```

`blobFallbackMaxBytes` (8 MB) stays as the MySQL threshold — no rename, so existing
`.env.*` files keep working.

Document the three new vars in `.env.example`, `.env.teams`, `.env.live` and
`docs/ENV_PROFILES.md`.

---

## 6. New module — `backend/app/src/services/diskStorageService.ts`

Same surface as `storageService.ts` so `fileService` can treat tiers uniformly:

```ts
export async function preflight(bytes: number): Promise<void>   // throws DiskUnavailable
export async function upload(key: string, data: Buffer | Readable): Promise<void>
export async function getStream(key: string, range?: string): Promise<{ stream, contentLength, contentRange?, statusCode }>
export async function remove(key: string): Promise<void>
export async function ping(): Promise<{ freeBytes: number }>    // for /health/ready + ops
export function isDiskUnavailable(e): boolean
```

Rules:

- **Path safety.** `abs = path.resolve(root, key)`; reject unless `abs.startsWith(root + sep)`.
  `storageKey()` already strips everything but `[a-zA-Z0-9._-]` from the filename, but
  the guard is cheap insurance against a crafted key reaching `remove()`.
- **Atomic write.** Write to `<abs>.part`, `fsync`, then `rename` to `<abs>`. A crash
  mid-upload leaves only a `.part` file, never a half file that a download could serve.
  `upload()` deletes the `.part` on any error.
- **Directory creation.** `mkdir -p` the dated sub-directory per upload (idempotent).
- **Preflight.** `fs.statfs(root)` (Node ≥ 18.15) → `bavail * bsize`; require
  `free - bytes >= localMinFreeBytes`. Also `fs.access(root, W_OK)`. Any failure is
  "disk unavailable" and moves the chain on *before* the request stream is consumed.
- **Range reads.** Parse the single `bytes=a-b` form (same as the S3 path); return 206
  with `Content-Range: bytes a-b/total`; 416 when unsatisfiable (reuse the
  `RANGE_NOT_SATISFIABLE` error shape from `storageService.getStream`).
- **Missing file** → throw the same `404 OBJECT_MISSING` error shape so every download
  route renders "This file is no longer available."
- **Unavailable detection.** `ENOSPC, EROFS, EACCES, EIO, ENOENT (root)` → unavailable;
  everything else propagates.
- **Startup.** `index.ts` boot: `mkdir -p localDir` next to the existing `ensureBucket()`
  call (~line 230); log the resolved absolute path and free space. Never fail boot on
  it — a missing volume just means the chain falls through to MinIO.
- **Orphan sweep (optional, same run as GC).** Remove `*.part` files older than 24 h.

---

## 7. `fileService.ts` changes

### `create()`

Replace the current two-branch body with the chain in §3.1. Keep `readAll()`. The tier
loop is data-driven:

```ts
const order = config.storage.order.split(",").map(s => s.trim());
let backend: "disk" | "s3" | "db" | null = null;

for (const tier of order) {
  if (tier === "db") { if (!small) continue; backend = "db"; break; }
  const driver = tier === "disk" ? disk : storage;
  try {
    if (small) await driver.upload(key, data!, mime);
    else { await driver.preflight?.(size); await driver.upload(key, stream!, mime); }
    backend = tier; break;
  } catch (e) {
    if (!small && streamConsumed(e)) throw storageUnavailableError(e); // bytes gone
    console.warn(`[files] ${tier} tier unavailable — trying next: ${e?.message || e}`);
  }
}
if (!backend) throw storageUnavailableError(lastError);
```

`streamConsumed` is true once the disk/S3 driver has read any bytes; implement by
wrapping the request stream in a `PassThrough` that flips a flag on first `data` event.
Preflight failures happen before that flag flips, so they fall through cleanly.

`db.files.create` receives `storageKey: backend === "db" ? null : key`,
`storageBackend: backend`, `data: backend === "db" ? data : null`.

### Read helpers

Introduce one internal helper used by `getDownload`, `linkDownload`, `ticketDownload`
and the task-attachment path:

```ts
async function openForRead(meta, range?) {
  switch (meta.storageBackend) {
    case "disk": return disk.getStream(meta.storageKey, range);
    case "s3":   return storage.getStream(meta.storageKey, range);
    default:     return null;           // caller uses db.files.getData
  }
}
```

`getPresignedUrl` returns `null` unless `storageBackend === "s3"`.

`serializeFile` adds `storageBackend` only if the ops portal / client needs it; the
public API shape otherwise stays the same.

### Other callers

- `routes/files.ts` upload handler: pass-through, no change except the virus-scan hook
  now receives `{ storageKey, storageBackend }` so a future scanner knows where to read.
- `routes/media.ts:26` (`storage.download`) and `taskService.ts` (via `fileService`):
  route through `openForRead` / a `readAll` of it instead of calling `storage.*` directly.

---

## 8. GC — `fileGcService.ts` + `claimForGc`

- `claimForGc` returns `storage_backend` alongside `storage_key`.
- Worker:

```ts
if (row.storageBackend === "disk")      await disk.remove(row.storageKey);
else if (row.storageBackend === "s3")   await storage.remove(row.storageKey);
// "db": bytes drop with the row
```

- Same contract as today: a failed tier delete **skips** the hard-delete and retries
  next run. A disk `ENOENT` on delete counts as success (object already gone).
- Audit detail gains `storageBackend`.

---

## 9. Health, ops portal, Docker

- `routes/health.ts` `/ready`: add `disk: { ok, freeBytes, critical: false, degraded }`
  from `disk.ping()`. Still non-critical — one tier down must not de-rotate the instance.
- `routes/ops.ts` dependency panel (~line 468): add the disk probe next to
  `storagePing`; show tier order + resolved directory + free space.
- `docker-compose.yml`, `docker-compose.live.yml`, `docker-compose.teams` variants,
  `docker-compose.production.yml`, `docker-compose.cloud.yml`, `docker-compose.mumbai.yml`:

```yaml
  backend:
    environment:
      FILE_STORAGE_DIR: /app/data/files
      FILE_STORAGE_ORDER: ${FILE_STORAGE_ORDER:-disk,s3,db}
    volumes:
      - files_data:/app/data/files
volumes:
  files_data:
```

- `docker/Dockerfile.backend`: `RUN mkdir -p /app/data/files` (the runner image runs as
  root today, so no chown is needed; revisit if a non-root user is introduced).
- Backup runbooks (`docs/DEPLOY_RUNBOOK.md`, `docs/DB_MIGRATION_RUNBOOK.md`): the
  `files_data` volume is now part of the backup set alongside `mysqldata` and `minio_data`.

---

## 10. Tests

Unit (`backend/app/test/file-storage-chain.test.ts`, run with `npm run test:unit`;
needs the throwaway MySQL on 3307 per `docs` memory):

1. Small upload, all tiers healthy → `storageBackend = "disk"`, file exists under a temp
   `FILE_STORAGE_DIR`, `files.data IS NULL`.
2. Small upload, disk preflight fails (temp dir read-only) → `"s3"`.
3. Small upload, disk + S3 fail → `"db"`, bytes in `files.data`.
4. Large upload (> 8 MB), disk preflight fails, S3 healthy → `"s3"` (streamed).
5. Large upload, disk + S3 fail → `503 STORAGE_UNAVAILABLE`, no row, no `.part` left.
6. Large upload, disk fails mid-stream → 503, `.part` removed.
7. Download of each backend returns identical bytes; Range on disk returns 206 with
   correct `Content-Range`; unsatisfiable range → 416.
8. GC removes the disk file and hard-deletes the row; failed disk delete leaves the row.
9. Path-traversal key (`../../etc/passwd`) is rejected by the disk driver.
10. `FILE_STORAGE_ORDER=s3,db` reproduces today's behaviour (regression guard).

Existing tests to keep green: `reminders-tasks-files.test.ts`, `driver-parity.test.ts`.

E2E (live stack on `localhost:7524`, users `user4`/`user5`): upload a PDF in a DM,
download it from the other side, stop `collab-minio`, upload again (should still succeed
via disk), restore MinIO.

---

## 11. Capacity and scaling (300 users)

**Where it runs.** Live is one VM, one backend container, Docker named volumes on the
host disk (`docker-compose.live.yml`). Node streams each upload straight to disk, so
throughput is not a concern at this size: a few dozen concurrent uploads are far below
what a single disk serves. The constraint is storage **growth**, not load.

### 11.1 Growth estimate

Adjust the assumptions to real usage; the formula is
`users × attachments/day × average size × working days`.

| Assumption | Value |
|---|---|
| Users | 300 |
| Attachments per user per working day | 10 |
| Average attachment size | 2 MB |
| Growth per working day | ~6 GB |
| Growth per month (22 working days) | ~130 GB |
| Growth per year | ~1.5 TB |

Soft-deleted files are retained for the GC window (`FILES_GC_RETENTION_DAYS`, default
30) before their bytes are reclaimed, so the volume only shrinks when users delete and
the window elapses. Per-file ceiling stays 2 GB (`MAX_UPLOAD_BYTES` in
`routes/files.ts`).

### 11.2 Scaling levers, in order of effort

1. **Resizable managed disk for the files volume.** Place `files_data` on a cloud
   managed disk (Azure Managed Disk / EBS) rather than the VM root disk; it resizes
   online. The free-space preflight (§6) already diverts overflow to MinIO when the disk
   is tight, so a full disk degrades to "uploads go to MinIO", never to failed uploads.
2. **Cold tier to MinIO (recommended, part of this plan — see §11.3).** Keeps the disk
   tier a bounded hot set of recent files; MinIO absorbs unbounded growth and is the
   tier that can scale out (distributed MinIO, erasure coding).
3. **Per-user / per-org quota.** `files.size` and `organization_id` are already on
   every row; a `SUM(size) WHERE uploader_id=? AND deleted=0` check before `create()`
   with a `FILE_QUOTA_BYTES_PER_USER` setting (0 = unlimited) makes growth predictable.
   Return `413 QUOTA_EXCEEDED` with an exposed message.
4. **Shared file system — only if backend replicas are added.** Mount the same
   directory via Azure Files / EFS / NFS so every replica sees it. Not needed for 300
   users on one VM; keep `FILE_STORAGE_ORDER=s3,db` instead if replicas arrive before
   the shared mount does.
5. **Monitoring.** `/api/health/ready.checks.disk.freeBytes` (§9) → alert at 80 % used
   and again at `FILE_STORAGE_MIN_FREE_BYTES` (the point where overflow to MinIO starts).

### 11.3 Cold-tier job — `backend/app/src/services/fileTierService.ts`

Runs on the same scheduler as the GC sweeper (`index.ts`), bounded per run, and moves
disk-tier files to MinIO:

```
candidates = files WHERE storage_backend='disk' AND deleted=0
             AND created_at <= now() - FILE_TIER_COLD_AFTER_DAYS
             ORDER BY created_at ASC LIMIT FILE_TIER_BATCH
also, when disk usage > FILE_TIER_PRESSURE_PCT: oldest disk-tier files first,
             regardless of age, until usage is back under the threshold

for each row:
  stream disk file → storage.upload(key, stream)      # same key, no path change
  verify: HeadObject size == fs.stat size
  UPDATE files SET storage_backend='s3' WHERE id=? AND storage_backend='disk'
  disk.remove(key)                                    # only after the UPDATE succeeded
```

- Order of operations makes every failure safe: a crash before the `UPDATE` leaves the
  disk copy authoritative and an orphan object in MinIO (re-uploaded idempotently next
  run); a crash after the `UPDATE` but before `disk.remove` leaves a stale disk file that
  the next run deletes (`storage_backend` is no longer `disk`, so the file is a known
  orphan).
- Settings: `FILE_TIER_COLD_AFTER_DAYS` (default 30), `FILE_TIER_PRESSURE_PCT`
  (default 80), `FILE_TIER_BATCH` (default 200), `FILE_TIER_ENABLED` (default `true`;
  `false` keeps disk as the permanent store).
- Reads are unaffected during a move: `openForRead` (§7) re-reads `storage_backend`
  per request, and the disk file is removed only after the row points at MinIO.
- Logs one line per run (moved count, bytes, skipped) and an audit row
  (`file.tier.move`, system actor) per moved file, matching the GC governance rule.
- Add to §10 tests: cold-after-days move, pressure-triggered move, crash between
  upload and UPDATE (re-run converges), crash between UPDATE and remove (orphan cleaned).

### 11.4 What this gives

Disk-first on a resizable managed disk, with the cold tier to MinIO, is sufficient for
300 users for years: the disk holds roughly one month of recent uploads (≈130 GB at the
assumptions above) and MinIO holds the rest. Without the cold tier, disk-first only moves
the capacity ceiling from MinIO to the VM disk.

---

## 12. Rollout, risks, open questions

**Rollout**

1. Ship migration 0127 + code with `FILE_STORAGE_ORDER=s3,db` in `.env.live` → no
   behaviour change, proves the column + read path.
2. Mount `files_data`, switch to `disk,s3,db`, watch `/api/health/ready.checks.disk`.
3. Existing MinIO objects are **not** migrated; both tiers serve forever. An optional
   `scripts/migrate-files-s3-to-disk.ts` can be added later.

**Risks / things the requester should confirm**

- **Single-instance assumption.** Disk-first only works when exactly one backend
  container serves uploads and downloads. A second replica would not see the volume.
  MinIO was the shared tier. If horizontal scaling is on the roadmap, keep
  `FILE_STORAGE_ORDER=s3,db` for those environments.
- **Backups.** A new volume to back up; losing it loses every disk-tier file.
- **Disk pressure.** 2 GB uploads now land on the backend volume. The preflight guard
  keeps `FILE_STORAGE_MIN_FREE_BYTES` free, after which uploads silently move to MinIO.
  Alert on the `disk.freeBytes` health field.
- **Presigned URLs** are unavailable for disk-tier files. Live already serves every
  download through the backend proxy, so no user-facing change there; dev setups that
  used `S3_PUBLIC_ENDPOINT` presigning will fall back to the proxy route.
- **E2EE** is unaffected — ciphertext is opaque bytes to every tier.
- **Alternative design (not in this plan):** always stage on disk, then replicate to
  MinIO asynchronously and keep MinIO as the canonical store. This gives large uploads a
  retry path instead of a 503 and keeps multi-replica safety. Worth a separate decision
  if the goal is resilience rather than "disk is primary".

---

## 13. Work breakdown (suggested order)

| # | Task | Files |
|---|---|---|
| 1 | Migration + schema + driver columns | `database/migrations/0127_*.sql`, `database/schema/schema.sql`, `database/src/drivers/mysql.ts` |
| 2 | Config vars | `config/src/index.ts`, `.env.example`, `.env.teams`, `.env.live`, `docs/ENV_PROFILES.md` |
| 3 | Disk driver | `backend/app/src/services/diskStorageService.ts` |
| 4 | Upload chain | `backend/app/src/services/fileService.ts` (`create`) |
| 5 | Read path | `fileService.ts` (`openForRead`, download/link/ticket/presigned), `routes/files.ts`, `routes/media.ts`, `services/taskService.ts` |
| 6 | GC | `services/fileGcService.ts`, `claimForGc` |
| 7 | Boot + health + ops | `index.ts`, `routes/health.ts`, `routes/ops.ts` |
| 8 | Docker volumes + Dockerfile | all `docker-compose*.yml`, `docker/Dockerfile.backend` |
| 9 | Cold-tier job + settings | `backend/app/src/services/fileTierService.ts`, `index.ts`, `config/src/index.ts` |
| 10 | Tests | `backend/app/test/file-storage-chain.test.ts`, `backend/app/test/file-tier.test.ts` |
| 11 | Docs | this file (flip status), `DEPLOY_RUNBOOK.md`, `DEPLOY_HEALTHCHECK.md` |

---

## 14. Implementation status (2026-10-06)

Everything in §13 is coded. Files touched:

| Area | Files |
|---|---|
| Schema | `database/migrations/0127_files_storage_backend.sql`, `database/schema/schema.sql` |
| Drivers | `database/src/drivers/mysql.ts` (`storage_backend` on every files read/write, `listDiskTierCandidates`, `setStorageBackend`, `tierStats`), `database/src/drivers/json.ts` (same surface) |
| Config | `config/src/index.ts` → `storage.order / localDir / localMinFreeBytes`, `files.tier*` |
| Disk tier | `backend/app/src/services/diskStorageService.ts` (new) |
| Upload chain + reads | `backend/app/src/services/fileService.ts` (`create`, `openForRead`, `effectiveBackend`, `tierOrder`) |
| GC | `backend/app/src/services/fileGcService.ts` |
| Cold tier | `backend/app/src/services/fileTierService.ts` (new) |
| Boot / health / ops | `backend/app/src/index.ts`, `routes/health.ts` (`checks.disk`), `routes/ops.ts` (`checks.disk`) |
| Docker / env | `docker-compose.yml`, `docker-compose.live.yml`, `docker-compose.production.yml` (`files_data` volume + `FILE_*` env; `docker-compose.cloud.yml` inherits), `docker/Dockerfile.backend`, `.env.example`, `.env.teams`, `.env.live`, `.gitignore` (`data/`), `docs/ENV_PROFILES.md` |
| Tests | `backend/app/test/file-storage-chain.test.ts` (12 cases), `file-storage-order-legacy.test.ts` (2), `file-tier-minio.test.ts` (2, needs MinIO on 9003) |

Verified locally against a throwaway MySQL on 3307 and the dev MinIO on 9003:
all 16 new cases pass, the existing `reminders-tasks-files` suite passes (54/54),
`tsc` is clean, and `lint:circular` reports only pre-existing cycles.
`driver-parity.test.ts` fails identically on the clean tree (gap 171 vs baseline 161)
and is not widened by this change.

Not done here: the per-user quota (§11.2 item 3) and the optional S3→disk backfill
script (§12) — both deliberately left out of this change.
