// Cold-tier job (docs/FILE_UPLOAD_STORAGE_CHAIN.md §11.3).
//
// Keeps the local file-storage tier a BOUNDED hot set: disk-tier files older
// than FILE_TIER_COLD_AFTER_DAYS — or, while the files volume is fuller than
// FILE_TIER_PRESSURE_PCT, the oldest disk-tier files regardless of age — are
// copied to MinIO and the row is flipped to storage_backend='s3'.
//
// Order of operations makes every crash point safe:
//   1. stream disk → S3 under the SAME key (idempotent: a re-run re-uploads);
//   2. verify the S3 object size matches the disk size;
//   3. compare-and-set the row disk → s3 (a restore/GC/re-run can't clobber it);
//   4. only then delete the disk copy. A crash between 3 and 4 leaves a stale
//      disk file whose row no longer says 'disk' — it is reaped on a later run
//      as an orphan (sweepStale) and never served, since reads follow the row.
// Reads keep working during a move: openForRead re-reads storage_backend per
// request and the disk copy is removed only after the row points at S3.
import { config, db } from "../platform";
import * as storage from "./storageService";
import * as disk from "./diskStorageService";
import { record } from "./auditService";
import { record as logError } from "./logService";
import { HeadObjectCommand } from "@aws-sdk/client-s3";

const TIER_SYSTEM_ACTOR = "system:files-tier";

export interface TierResult {
  scanned: number;
  moved: number;
  movedBytes: number;
  skipped: number;
  disabled?: boolean;
  pressure?: boolean;
  // The run was PAUSED before moving anything because object storage did not
  // answer the readiness ping. Nothing changed on disk or in the DB.
  s3Unreachable?: boolean;
}

// Production, 8 Oct 2026: the files volume crossed FILE_TIER_PRESSURE_PCT while
// the backend could not reach MinIO (nginx could; the backend's S3 calls hung).
// Every run then streamed the oldest attachments into a MinIO that never
// answered, ~30 s per file until the request timeout, and anything that DID
// land there became unreadable ("Storage unavailable") for every web client.
// So: ask MinIO once, quickly, before touching a single file.
const S3_PING_TIMEOUT_MS = 5000;
async function s3Reachable(ping: () => Promise<void>): Promise<{ ok: boolean; error?: string }> {
  try {
    await Promise.race([
      ping(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), S3_PING_TIMEOUT_MS)),
    ]);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

async function s3SizeOf(key: string): Promise<number> {
  const r = await storage.s3.send(new HeadObjectCommand({ Bucket: storage.BUCKET, Key: key }));
  return Number(r.ContentLength) || 0;
}

async function moveOne(row: { id: string; storageKey: string; size: number }): Promise<boolean> {
  const key = row.storageKey;
  const diskSize = await disk.sizeOf(key);
  const src = await disk.getStream(key);
  await storage.upload(key, src.stream, "application/octet-stream");
  const s3Size = await s3SizeOf(key);
  if (s3Size !== diskSize) {
    throw new Error(`size mismatch after copy: disk=${diskSize} s3=${s3Size}`);
  }
  const flipped = await db.files.setStorageBackend(row.id, "disk", "s3");
  if (!flipped) {
    // Row moved on without us (deleted + GC'd, or already flipped). Leave the
    // S3 copy: harmless, and GC/next run reconciles. Do NOT touch the disk file.
    return false;
  }
  await disk.remove(key);
  void record({
    actorId: TIER_SYSTEM_ACTOR,
    action: "file.tier.move",
    targetType: "file",
    targetId: row.id,
    detail: { storageKey: key, from: "disk", to: "s3", bytes: diskSize },
  });
  return true;
}

// One run. `opts` are injectable for tests; defaults come from config.
export async function runTier(opts: {
  coldAfterDays?: number;
  pressurePct?: number;
  pressureMinAgeDays?: number;
  batch?: number;
  enabled?: boolean;
  // Injectable for tests; defaults to the real bucket ping.
  pingS3?: () => Promise<void>;
} = {}): Promise<TierResult> {
  const enabled = opts.enabled ?? !!config.files.tierEnabled;
  if (!enabled) return { scanned: 0, moved: 0, movedBytes: 0, skipped: 0, disabled: true };
  const coldAfterDays = Math.max(0, Number(opts.coldAfterDays ?? config.files.tierColdAfterDays) || 0);
  const pressurePct = Math.max(0, Number(opts.pressurePct ?? config.files.tierPressurePct) || 0);
  const pressureMinAgeDays = Math.max(0, Number(opts.pressureMinAgeDays ?? config.files.tierPressureMinAgeDays) || 0);
  const batch = Math.max(1, Math.min(Number(opts.batch ?? config.files.tierBatch) || 200, 1000));
  if (!db.files.listDiskTierCandidates || !db.files.setStorageBackend)
    return { scanned: 0, moved: 0, movedBytes: 0, skipped: 0, disabled: true };

  // Pressure mode: the volume is fuller than the threshold → move the OLDEST
  // disk-tier files regardless of age. Otherwise only age-eligible files.
  let pressure = false;
  try {
    const p = await disk.ping();
    pressure = pressurePct > 0 && p.usedPct >= pressurePct;
  } catch {
    // Disk tier unreachable → nothing to move from it this run.
    return { scanned: 0, moved: 0, movedBytes: 0, skipped: 0 };
  }
  if (!pressure && coldAfterDays <= 0)
    return { scanned: 0, moved: 0, movedBytes: 0, skipped: 0, disabled: true };

  // Object storage must answer BEFORE anything is read off disk. A failed ping
  // pauses this run entirely (retried on the next tick) and is a Server Logs
  // row, because an unreachable MinIO is exactly what makes attachments show
  // "Storage unavailable" to users.
  const reach = await s3Reachable(opts.pingS3 || storage.pingBucket);
  if (!reach.ok) {
    console.warn("[files-tier] object storage unreachable — run paused, nothing moved:", reach.error);
    logError({
      source: "backend",
      severity: "warn",
      code: "FILES_TIER_S3_UNREACHABLE",
      message: `[files-tier] object storage (MinIO) did not answer the readiness ping — cold-tier run paused, nothing moved. Downloads of files already on S3 fail with "Storage unavailable" until the backend can reach MinIO again: ${reach.error}`,
      context: { pressure, pressurePct, coldAfterDays },
    });
    return { scanned: 0, moved: 0, movedBytes: 0, skipped: 0, pressure, s3Unreachable: true };
  }

  // Pressure mode moves the OLDEST files first but never today's: a fresh
  // attachment is being opened by everyone in the thread right now.
  const rows = await db.files.listDiskTierCandidates(pressure ? pressureMinAgeDays : coldAfterDays, batch);
  let moved = 0;
  let movedBytes = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      if (await moveOne(row)) {
        moved++;
        movedBytes += Number(row.size) || 0;
      } else skipped++;
    } catch (e: any) {
      // S3 down / verify failed: leave the row on disk, retry next run. Stop the
      // run on an unreachable S3 — every further move would fail the same way.
      skipped++;
      console.warn("[files-tier] move failed, left on disk:", row.id, row.storageKey, e?.message || e);
      if (storage.isStorageUnreachable(e)) break;
    }
  }
  if (moved || skipped)
    console.log(
      `[files-tier] ${pressure ? "pressure" : `cold>${coldAfterDays}d`} — moved ${moved} file(s), ${movedBytes} bytes to S3` +
        (skipped ? `, skipped ${skipped} (retry next run)` : ""),
    );
  return { scanned: rows.length, moved, movedBytes, skipped, pressure };
}
