// Files GC / retention sweeper (P0-E) — the HIGHEST-RISK change in the set, so
// it is deliberately CONSERVATIVE.
//
// Files soft-delete and RETAIN their S3 blob so they are restorable from the
// recycle bin. That means storage grows unbounded unless something eventually
// reclaims aged-out trash. This sweeper does exactly that, and ONLY that:
//
//   • It claims ONLY soft-deleted rows (deleted=1) whose deleted_at is older than
//     the retention window (FILES_GC_RETENTION_DAYS, default 30). The claim query
//     can NEVER return a live file — the predicate is enforced in SQL. The claim is
//     ATOMIC + OBSERVABLE: claimForGc stamps gc_claimed_at (FOR UPDATE SKIP LOCKED).
//   • Immediately BEFORE the irreversible S3 delete it RE-CONFIRMS the claim
//     (gcClaimStillValid: still deleted=1 AND still marked). restore() clears the
//     marker, so a Restore that races an in-flight sweep WINS — the worker skips
//     the blob. This closes the restore/GC TOCTOU that could otherwise delete the
//     blob of a now-live file (leaving a live row → NoSuchKey on every download).
//   • For each still-valid row it deletes the S3 object FIRST, then hard-deletes
//     the row. If the S3 delete FAILS, it logs + SKIPS the row (does NOT
//     hard-delete), so the row is retried next run instead of orphaning the blob.
//   • hardDelete() re-checks `deleted=1` in SQL — the final belt-and-suspenders.
//   • It LOGS every object it removes AND writes an AUDIT ROW per permanent
//     deletion (system actor) — the repo has a soft-delete governance rule: no
//     silent permanent deletion, and irreversible destruction must be queryable.
//   • Retention of 0 (or negative) DISABLES GC entirely — the caller skips it and
//     run() also no-ops defensively.
//   • Work per run is BOUNDED by `batch` (repo-clamped to <=1000).
//
// Touches nothing in the calls/meetings/LiveKit/E2EE path.

import { config, db } from "../platform";
import * as storage from "./storageService";
import * as disk from "./diskStorageService";
import { record } from "./auditService";

// Synthetic actor for system-initiated permanent deletions (no human triggers
// GC). Keeps the audit trail attributable without inventing a user id.
const GC_SYSTEM_ACTOR = "system:files-gc";

export interface GcResult {
  scanned: number; // rows claimed this run
  removed: number; // rows permanently deleted (blob + row)
  skipped: number; // rows left for retry (blob delete failed / restored mid-run)
  removedIds: string[];
  disabled?: boolean;
}

// Run one GC sweep. `retentionDays`/`batch` default to config but are injectable
// for tests. A retention of 0/negative is a hard no-op (GC disabled).
export async function runGc(
  retentionDays: number = config.files.gcRetentionDays,
  batch: number = config.files.gcBatch,
): Promise<GcResult> {
  const days = Number(retentionDays);
  if (!(days > 0)) {
    // Disabled: never reclaim anything. Files stay soft-deleted (restorable).
    return { scanned: 0, removed: 0, skipped: 0, removedIds: [], disabled: true };
  }
  const claimed = await db.files.claimForGc(days, batch);
  if (!claimed.length)
    return { scanned: 0, removed: 0, skipped: 0, removedIds: [] };

  const removedIds: string[] = [];
  let skipped = 0;
  for (const row of claimed) {
    // RE-CONFIRM the claim immediately before the irreversible S3 delete. If the
    // owner restored this file between claim and now, restore() cleared the marker
    // (and flipped deleted=0), so the claim is no longer valid — SKIP the blob
    // delete entirely. This is the fix for the restore/GC TOCTOU: without it the
    // blob of a now-LIVE file would be deleted, leaving a row pointing at a missing
    // object (NoSuchKey on every later download/preview/link). When the driver
    // lacks the helper (none today), fall back to deleting — the hardDelete
    // deleted=1 guard then still protects the ROW.
    if (db.files.gcClaimStillValid) {
      const stillClaimed = await db.files.gcClaimStillValid(row.id);
      if (!stillClaimed) {
        // Restored (or otherwise un-claimed) mid-run — leave the file untouched.
        skipped++;
        console.log(
          "[files-gc] claim invalidated (file restored mid-sweep) — skipping blob delete:",
          row.id,
        );
        continue;
      }
    }
    // Which tier holds the bytes (0127): disk volume, S3/MinIO, or the row's own
    // LONGBLOB. Pre-0127 rows carry no backend — a key means S3, no key means DB.
    const backend =
      row.storageBackend === "disk" || row.storageBackend === "s3" || row.storageBackend === "db"
        ? row.storageBackend
        : row.storageKey
          ? "s3"
          : "db";
    if (row.storageKey && backend !== "db") {
      try {
        if (backend === "disk") await disk.remove(row.storageKey);
        else await storage.remove(row.storageKey);
      } catch (e: any) {
        // Tier delete failed — DO NOT hard-delete the row. Leaving the row keeps
        // the (id ↔ key) link so the object is retried next run; hard-deleting
        // here would orphan the blob forever (invisible, unreclaimable storage).
        skipped++;
        console.warn(
          "[files-gc] %s object delete FAILED, leaving row for retry:",
          backend,
          row.id,
          row.storageKey,
          e && e.message,
        );
        continue;
      }
    } else {
      // No storage key (BLOB-fallback upload, or already-cleared). Nothing to
      // delete from a tier — the row's LONGBLOB (if any) drops with the row.
    }
    // Blob gone (or none) → permanently delete the row. hardDelete re-guards on
    // deleted=1, so a row restored mid-run is safely skipped.
    const r = await db.files.hardDelete(row.id);
    if (r.deleted) {
      removedIds.push(row.id);
      // Soft-delete governance: an IRREVERSIBLE permanent deletion must be a
      // queryable audit fact, not just an ephemeral console line. Mirror the
      // file lifecycle audit rows (upload/download/restore) with a system actor.
      // Fire-and-forget — auditService.record never throws — so an audit-store
      // hiccup can't block reclaiming the next row.
      void record({
        actorId: GC_SYSTEM_ACTOR,
        action: "file.gc.purge",
        targetType: "file",
        targetId: row.id,
        detail: { storageKey: row.storageKey || null, storageBackend: backend, retentionDays: days },
      });
    } else skipped++; // restored between claim and delete — left intact, count it
  }

  // Soft-delete governance: NEVER delete silently. Log every reclaimed object.
  if (removedIds.length || skipped) {
    console.log(
      `[files-gc] retention=${days}d — permanently removed ${removedIds.length} file(s)` +
        (skipped ? `, skipped ${skipped} (retry next run)` : "") +
        (removedIds.length ? ` | ids: ${removedIds.join(",")}` : ""),
    );
  }
  return {
    scanned: claimed.length,
    removed: removedIds.length,
    skipped,
    removedIds,
  };
}
