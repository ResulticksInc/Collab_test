// What goes INTO the history backup, and what a device should do when it finds
// itself without a key. Pure and dependency-free on purpose: the manager owns the
// crypto and the API calls, this owns the decisions, and backend/app/test can
// exercise it directly (the "backend-no-frontend" dependency rule exempts test
// files, so a pure frontend helper keeps one source of truth).

/** One backed-up message: the same shape Mechanism A and B have always used. */
export interface BackupEntry {
  convId: string;
  msgId: string;
  senderDeviceId: string;
  ts: any;
  type: any;
  text: string;
}

/**
 * Merge a freshly-gathered set of entries INTO what the server backup already
 * holds. The backup used to be rebuilt from scratch on every refresh, which had
 * two consequences: it could only ever contain what THIS device could still read
 * (so messages another device had restored — or this device had since evicted —
 * silently dropped out), and it forced a full walk of every conversation each
 * time. Merging keeps every entry any device ever contributed; a fresh entry for
 * the same message REPLACES the old one so an edit is carried forward.
 */
export function mergeEntries(
  existing: BackupEntry[],
  fresh: BackupEntry[],
): BackupEntry[] {
  const byId = new Map<string, BackupEntry>();
  for (const e of existing || []) if (e && e.msgId) byId.set(String(e.msgId), e);
  for (const e of fresh || []) if (e && e.msgId) byId.set(String(e.msgId), e);
  return [...byId.values()];
}

function tsOf(e: BackupEntry): number {
  const t = e && e.ts != null ? new Date(e.ts).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * Keep the backup under the server's size ceiling by dropping the OLDEST
 * entries first. Sorted oldest→newest on the way out so chunks are stable
 * across refreshes. `maxBytes` is measured on the JSON text of the entries
 * (the ciphertext the server measures is that JSON plus fixed overhead, so the
 * caller passes a budget below the server limit).
 */
export function trimToBudget(entries: BackupEntry[], maxBytes: number): BackupEntry[] {
  const sorted = [...(entries || [])].sort((a, b) => tsOf(a) - tsOf(b));
  if (!(maxBytes > 0)) return sorted;
  let total = 0;
  const kept: BackupEntry[] = [];
  // Walk newest→oldest so the newest always survive; reverse at the end.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const sz = JSON.stringify(sorted[i]).length + 1;
    if (total + sz > maxBytes) break;
    total += sz;
    kept.push(sorted[i]);
  }
  return kept.reverse();
}

/**
 * The newest message timestamp a set of entries covers — the watermark an
 * INCREMENTAL gather resumes from. 0 when there is nothing.
 */
export function newestTs(entries: BackupEntry[]): number {
  let n = 0;
  for (const e of entries || []) {
    const t = tsOf(e);
    if (t > n) n = t;
  }
  return n;
}

export interface RefreshGatherPlan {
  /** Walk every conversation with no watermark: this device's first contribution. */
  allTime: boolean;
  /** Otherwise gather only messages newer than this epoch-ms timestamp. */
  sinceTs: number;
}

/**
 * What a backup refresh should gather from THIS device.
 *
 * Every device contributes its ENTIRE readable history to a backup exactly once
 * — the first time it publishes against that backup (identified by the backup's
 * salt, so a rotated backup is walked again) — and only what is newer than the
 * watermark after that.
 *
 * The watermark is strictly THIS device's: the newest message it has itself
 * walked. It must never be advanced to the backup's newest entry, because
 * "the backup holds a message from 12:00" does not mean "the backup holds
 * everything before 12:00" — another device may have contributed that entry
 * while lacking the older ones only this device can read. Resuming from the
 * backup's newest entry (the old rule) skipped those older messages forever,
 * and a device restored from the backup stayed on "Restoring…" for them.
 *
 * Before the full-walk marker, the gather also resumed as soon as the backup
 * held anything, so a device joining a backup seeded by a key-less device
 * merged nothing but newer messages into it.
 */
export function planRefreshGather(opts: {
  /** Salt of the backup this device has already walked in full, or null. */
  fullWalkSalt: string | null;
  /** Salt of the backup on the server now. */
  backupSalt: string;
  /** This device's own watermark (newest message it has walked itself). */
  watermark: number;
  /** Newest entry the server backup holds right now — informational only. */
  existingNewest?: number;
}): RefreshGatherPlan {
  if (!opts.fullWalkSalt || opts.fullWalkSalt !== opts.backupSalt)
    return { allTime: true, sinceTs: 0 };
  const since = opts.watermark || 0;
  return since > 0 ? { allTime: false, sinceTs: since } : { allTime: true, sinceTs: 0 };
}

// ── Recovery state machine ───────────────────────────────────────────────────
// What the chat UI shows in place of a message this device can't read yet. There
// is no "try again" — recovery is automatic — so the UI only needs to know
// whether recovery is still RUNNING (show a restoring row), has FINISHED with
// nothing left to try (show an honest terminal row), or is IDLE.

export type RecoveryPhase = "idle" | "restoring" | "done" | "exhausted";

export interface RecoveryState {
  phase: RecoveryPhase;
  /** Entries merged by the most recent run. */
  restored: number;
  /** Wall-clock ms of the last transition. */
  at: number;
  /** Which automatic sources were tried in the last run. */
  tried: string[];
  /** A typed credential (password / passphrase / recovery key) could still open
   *  a backup that no automatic source can. The UI may offer ONE unlock. */
  credentialCouldUnlock: boolean;
}

export const initialRecoveryState: RecoveryState = {
  phase: "idle",
  restored: 0,
  at: 0,
  tried: [],
  credentialCouldUnlock: false,
};

export type RecoveryEvent =
  | { type: "start"; at: number }
  | {
      type: "finish";
      at: number;
      restored: number;
      tried: string[];
      keyHeld: boolean;
      credentialCouldUnlock: boolean;
      /** A source could not be REACHED (rate-limited, 5xx, offline) rather than
       *  tried and found empty. The run proved nothing; it must be repeated. */
      transient?: boolean;
    }
  | { type: "reset" };

/**
 * Pure reducer. "done" means this device now holds a key (or merged something)
 * so remaining rows are expected to fill in; "exhausted" means every automatic
 * source was tried and the device STILL has no key — only a sibling coming
 * online or a typed credential can change that. A run that could not reach a
 * source (429 / 5xx / offline) proves nothing and goes back to "idle": the UI
 * keeps showing "Restoring…" and the manager schedules another run. Calling
 * that "exhausted" is how a rate-limited init turned a fully recoverable
 * history into a wall of "Encrypted message".
 */
export function reduceRecovery(s: RecoveryState, ev: RecoveryEvent): RecoveryState {
  switch (ev.type) {
    case "start":
      return { ...s, phase: "restoring", at: ev.at };
    case "finish":
      return {
        phase:
          ev.keyHeld || ev.restored > 0 ? "done" : ev.transient ? "idle" : "exhausted",
        restored: ev.restored,
        at: ev.at,
        tried: ev.tried,
        credentialCouldUnlock: ev.credentialCouldUnlock,
      };
    case "reset":
      return { ...initialRecoveryState };
    default:
      return s;
  }
}

/**
 * Should an automatic recovery run NOW? Runs are throttled so a thread full of
 * pending rows, a flapping socket, or the periodic re-decrypt can't stampede the
 * backup endpoint — but a FORCED run (init, reconnect, an explicit trigger)
 * always goes, and a run never overlaps another.
 */
export function shouldRunRecovery(
  s: RecoveryState,
  now: number,
  opts: { force?: boolean; minIntervalMs?: number; inFlight: boolean },
): boolean {
  if (opts.inFlight) return false;
  if (opts.force) return true;
  const min = opts.minIntervalMs ?? 60_000;
  if (s.phase === "restoring") return false;
  return now - s.at >= min;
}
