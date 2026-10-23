// ── Persistent decrypted-media cache (IndexedDB) ─────────────────────────────
//
// PERF: chat attachments used to re-download the whole ciphertext AND re-decrypt
// it on every thread open / page reload, because the only client-side cache was a
// 60-entry in-memory LRU wiped on reload. On live that reads as "attachments load
// extremely slowly" — nothing is visible until 100% download + 100% decrypt, paid
// again and again.
//
// This module is the durable tier: after a blob is fetched + decrypted once, we
// keep the DECRYPTED bytes in IndexedDB keyed by file id. A later open reads them
// straight back with ZERO network and ZERO re-decrypt, so media renders instantly
// — the "local media store" behaviour enterprise chat apps have.
//
// At-rest posture: this mirrors the existing message plaintextCache (the app
// already follows the WhatsApp decrypt-once-keep-local model — SignalStore keeps
// decrypted message text locally). Decrypted media lives only in this browser's
// IndexedDB and is PURGED on user-switch via clearMediaCache() (wired into
// SignalStore.wipeForUserSwitch), so a different user on the same device never
// inherits the prior user's attachments — exactly like the plaintext cache.
//
// Everything here is best-effort: any IndexedDB failure (private mode, quota,
// blocked upgrade) resolves to a no-op so rendering falls back to the network
// path and never throws into React.

const DB_NAME = "colab-media-cache";
const STORE = "blobs";
const VERSION = 1;
// Whole-store byte budget. Oldest (least-recently-used) items are evicted once
// the total exceeds this. ~350MB is a generous local media working set.
const BUDGET_BYTES = 350 * 1024 * 1024;
// Never persist a single item larger than this — one huge video shouldn't be able
// to evict the entire rest of the working set. Sized to hold a typical short chat
// video so a played/prefetched clip is instant on replay (bigger files still stream
// from origin and hit the browser HTTP cache via the revalidating Cache-Control).
const MAX_ITEM_BYTES = 64 * 1024 * 1024;
// LRU touch throttle: don't rewrite `at` more often than this per item, so opening
// a thread full of media doesn't cause a write storm.
const TOUCH_MIN_MS = 60 * 1000;

let _dbp: Promise<IDBDatabase | null> | null = null;
let _total = -1; // running byte total; -1 = not yet computed
let _totalP: Promise<void> | null = null; // in-flight seed scan (deduped)
let _seq = 0; // sub-millisecond tiebreak so `at` values stay unique/ordered
let _evicting = false;

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

function openDB(): Promise<IDBDatabase | null> {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve) => {
    if (!idbAvailable()) return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("by_at", "at");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return _dbp;
}

function store(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function nextAt(): number {
  return Date.now() + ((_seq++ % 1000) / 1000);
}

// One-time scan to seed the running byte total (survives across reloads without a
// separate meta row). Iterates records (IDB Blobs are lazy handles, so this does
// NOT read blob bytes into memory) summing their `size`. DEDUPED via _totalP so
// concurrent puts on a cold cache don't each run a scan and clobber _total.
function ensureTotal(db: IDBDatabase): Promise<void> {
  if (_total >= 0) return Promise.resolve();
  if (_totalP) return _totalP;
  _totalP = new Promise<void>((resolve) => {
    let sum = 0;
    try {
      const cur = store(db, "readonly").openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) {
          sum += (c.value && c.value.size) || 0;
          c.continue();
        } else {
          _total = sum;
          resolve();
        }
      };
      cur.onerror = () => {
        _total = 0;
        resolve();
      };
    } catch {
      _total = 0;
      resolve();
    }
  }).then(() => {
    _totalP = null;
  });
  return _totalP;
}

// Mark an item as recently used (LRU), throttled so hot media survives eviction
// without a write on every render. Fire-and-forget.
function touch(id: string): void {
  openDB()
    .then((db) => {
      if (!db) return;
      try {
        const os = store(db, "readwrite");
        const g = os.get(id);
        g.onsuccess = () => {
          const rec = g.result;
          if (!rec) return;
          if (Date.now() - (rec.at || 0) < TOUCH_MIN_MS) return;
          rec.at = nextAt();
          os.put(rec);
        };
      } catch {
        /* best-effort */
      }
    })
    .catch(() => {});
}

// Evict oldest-first until the total is back under 90% of budget. Guarded so only
// one eviction sweep runs at a time.
function evict(): void {
  if (_evicting) return;
  _evicting = true;
  openDB()
    .then((db) => {
      if (!db || _total <= BUDGET_BYTES) {
        _evicting = false;
        return;
      }
      const target = BUDGET_BYTES * 0.9;
      try {
        const cur = store(db, "readwrite").index("by_at").openCursor(); // ascending = oldest first
        cur.onsuccess = () => {
          // A throw here would otherwise leave _evicting stuck true, permanently
          // disabling eviction for the session — reset it on any failure.
          try {
            const c = cur.result;
            if (c && _total > target) {
              const sz = (c.value && c.value.size) || 0;
              const del = c.delete();
              del.onsuccess = () => {
                _total -= sz;
              };
              c.continue();
            } else {
              _evicting = false;
            }
          } catch {
            _evicting = false;
          }
        };
        cur.onerror = () => {
          _evicting = false;
        };
      } catch {
        _evicting = false;
      }
    })
    .catch(() => {
      _evicting = false;
    });
}

// Read a decrypted blob by file id; null on miss or any error.
export async function getMedia(id: string): Promise<Blob | null> {
  if (!id) return null;
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = store(db, "readonly").get(id);
      req.onsuccess = () => {
        const rec = req.result;
        if (rec && rec.blob) {
          resolve(rec.blob as Blob);
          touch(id);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// Persist a decrypted blob keyed by file id. Skips oversized single items. Keeps
// the running total accurate (accounting for a replace) and triggers eviction when
// over budget. Best-effort; never rejects.
export async function putMedia(id: string, blob: Blob, mime?: string): Promise<void> {
  if (!id || !blob) return;
  const size = blob.size || 0;
  if (size <= 0 || size > MAX_ITEM_BYTES) return;
  const db = await openDB();
  if (!db) return;
  await ensureTotal(db);
  return new Promise((resolve) => {
    try {
      const os = store(db, "readwrite");
      const g = os.get(id);
      g.onsuccess = () => {
        const prev = g.result;
        const rec = { id, blob, mime: mime || blob.type || "", size, at: nextAt() };
        const put = os.put(rec);
        put.onsuccess = () => {
          if (_total >= 0) _total += size - (prev ? prev.size || 0 : 0);
          resolve();
          if (_total > BUDGET_BYTES) evict();
        };
        put.onerror = () => resolve();
      };
      g.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Delete the whole media database — the strongest wipe. Used as a fallback when a
// store.clear() fails, so a user-switch can never leave the prior user's decrypted
// attachments behind. Drops our cached connection first so the delete isn't blocked.
function deleteMediaDB(): Promise<void> {
  return new Promise((resolve) => {
    try {
      _dbp = null; // release our handle so deleteDatabase isn't "blocked"
      _total = -1;
      if (!idbAvailable()) return resolve();
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Purge everything. Called on user-switch (SignalStore.wipeForUserSwitch) so a new
// user on this device never inherits the prior user's decrypted attachments. If
// the fast clear() fails for any reason, fall back to deleting the whole database
// so the wipe is not silently skipped.
export async function clearMediaCache(): Promise<void> {
  const db = await openDB();
  if (!db) return deleteMediaDB();
  const cleared = await new Promise<boolean>((resolve) => {
    try {
      const req = store(db, "readwrite").clear();
      req.onsuccess = () => {
        _total = 0;
        resolve(true);
      };
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
  if (!cleared) return deleteMediaDB();
}
