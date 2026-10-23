// Can an undecryptable message still reach THIS device?
//
// Pure and dependency-free on purpose: the manager owns the crypto and the API
// calls, this owns the DECISION and the sharing/caching around it, and
// backend/app/test can exercise both directly (the "backend-no-frontend"
// dependency rule exempts test files so a pure frontend helper keeps one source
// of truth).

export interface E2EERecoveryPaths {
  /** This user has a server-blind history backup that could be restored. */
  hasBackup: boolean;
  /** Other (non-revoked) devices of this user that may still hold the plaintext. */
  siblingDevices: number;
  /** Any route by which a pending message could still reach THIS device. */
  recoverable: boolean;
  /** Both lookups answered. False when either failed (429, offline, expired
   *  token): the counts are then "unknown", not "none", and `recoverable` stays
   *  true so the UI never declares a message lost on the strength of an error. */
  verified: boolean;
}

/**
 * The verdict. No backup and no sibling means the key exists NOWHERE: waiting
 * cannot produce it, and neither can adding a new device later (a new device
 * starts empty too). That is the terminal state the UI must admit to instead of
 * offering a restore that cannot succeed.
 *
 * Deliberately optimistic at the boundary: a sibling device is counted even
 * though it might itself be too new to hold the plaintext. Being wrong in that
 * direction leaves a row saying "unavailable" a while longer; being wrong the
 * other way would tell someone their messages are gone when they are not.
 *
 * The same rule covers a lookup that FAILED: `verified=false` means the counts
 * are unknown, so the verdict is never terminal.
 */
export function recoveryPathsOf(
  hasBackup: boolean,
  siblingDevices: number,
  verified = true,
): E2EERecoveryPaths {
  const siblings = Math.max(0, siblingDevices | 0);
  return {
    hasBackup: !!hasBackup,
    siblingDevices: siblings,
    recoverable: !verified || !!hasBackup || siblings > 0,
    verified: !!verified,
  };
}

export interface RecoveryPathsCache {
  /** Last known answer, or null if never fetched. Never blocks, never fetches. */
  get(): E2EERecoveryPaths | null;
  /** Fetch, or reuse a fresh/in-flight answer. Concurrent callers share one call. */
  load(force?: boolean): Promise<E2EERecoveryPaths>;
  subscribe(cb: (v: E2EERecoveryPaths) => void): () => void;
  invalidate(): void;
}

/**
 * One shared, cached answer for every caller.
 *
 * The consumer is EVERY undecryptable row in a thread — potentially hundreds
 * mounting in the same frame — and the underlying lookup costs two API calls.
 * Without the in-flight share, opening one bad thread would fire hundreds of
 * duplicate requests; without the TTL it would re-fire on every re-render.
 */
export function createRecoveryPathsCache(
  fetcher: () => Promise<E2EERecoveryPaths>,
  opts?: { ttlMs?: number; unverifiedTtlMs?: number; now?: () => number },
): RecoveryPathsCache {
  const ttlMs = opts?.ttlMs ?? 60_000;
  // An answer built from a failed lookup is kept only briefly: long enough to
  // collapse a burst of row mounts into one request, short enough that the
  // next attempt finds the real answer.
  const unverifiedTtlMs = opts?.unverifiedTtlMs ?? 5_000;
  const now = opts?.now ?? Date.now;
  let cache: { at: number; v: E2EERecoveryPaths } | null = null;
  let inFlight: Promise<E2EERecoveryPaths> | null = null;
  const subs = new Set<(v: E2EERecoveryPaths) => void>();

  return {
    get: () => (cache ? cache.v : null),
    load(force = false) {
      if (
        !force &&
        cache &&
        now() - cache.at < (cache.v.verified ? ttlMs : unverifiedTtlMs)
      ) {
        return Promise.resolve(cache.v);
      }
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const v = await fetcher();
          cache = { at: now(), v };
          subs.forEach((cb) => {
            try { cb(v); } catch (_) { /* a bad subscriber must not break the rest */ }
          });
          return v;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    subscribe(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    invalidate() {
      cache = null;
    },
  };
}
