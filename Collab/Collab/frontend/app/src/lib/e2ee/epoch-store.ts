/**
 * Phase 3A.1 - Epoch Infrastructure
 *
 * Tracks group sender key epochs with explicit metadata including:
 * - Epoch ID and generation counter
 * - Creation/rotation timestamps
 * - Rotation reason (member join/leave, device events, scheduled)
 * - Status (active, expired, revoked)
 */

// Epoch rotation reasons
export type EpochRotationReason =
  | "group_created"
  | "member_join"
  | "member_leave"
  | "device_added"
  | "device_revoked"
  | "scheduled_rotation";

// Epoch lifecycle status
export type EpochStatus = "active" | "expired" | "revoked";

/**
 * Full epoch metadata record. Stored separately from Signal's SenderKeyRecord
 * so we can inspect history, audit rotations, and reason about key lifecycle.
 */
export interface GroupEpoch {
  id: string;              // Composite key: groupId::generation (computed)
  groupId: string;
  epochId: string;         // UUID - changes on every rotation
  generation: number;      // Incrementing counter starting at 0
  createdAt: number;       // UNIX ms
  rotatedAt?: number;      // UNIX ms, set when this epoch expires/revokes
  reason: EpochRotationReason;
  status: EpochStatus;
  ownerUserId: string;     // Who created the key for this epoch
  ownerDeviceId: string;   // Which device generated it
}

/**
 * IndexedDB-backed epoch store. Persists both history and fast lookup
 * of the current active epoch per group.
 */
export class EpochStore {
  private static DB_NAME = "signal-epochs";
  private static DB_VERSION = 1;
  private static STORE_NAME = "epochs";

  private db: IDBDatabase | null = null;
  private ready!: Promise<void>;

  constructor() {
    this.ready = this.initDb();
  }

  // -- internals --

  private async initDb(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(EpochStore.DB_NAME, EpochStore.DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(EpochStore.STORE_NAME)) {
          const store = db.createObjectStore(EpochStore.STORE_NAME, {
            keyPath: "id",
          });
          // Simple index on groupId for lookup by group
          store.createIndex("groupId", "groupId", { unique: false });
        }
      };
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private openStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return new Promise((resolve, reject) => {
      if (!this.db) {
        const req = indexedDB.open(EpochStore.DB_NAME, EpochStore.DB_VERSION);
        req.onsuccess = () => {
          this.db = req.result;
          const tx = this.db!.transaction(EpochStore.STORE_NAME, mode);
          resolve(tx.objectStore(EpochStore.STORE_NAME));
        };
        req.onerror = () => reject(req.error);
      } else {
        const tx = this.db.transaction(EpochStore.STORE_NAME, mode);
        resolve(tx.objectStore(EpochStore.STORE_NAME));
      }
    });
  }

  // -- public API --

  /**
   * Return the currently active epoch for a group, or null if none exists.
   */
  async getCurrent(group: string): Promise<GroupEpoch | null> {
    const store = await this.openStore("readonly");
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result as GroupEpoch[];
        const active = all.find((e) => e.groupId === group && e.status === "active");
        resolve(active || null);
      };
    });
  }

  /**
   * Return all epochs (including historical) for a group, ordered by generation desc.
   */
  async history(group: string): Promise<GroupEpoch[]> {
    const store = await this.openStore("readonly");
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result as GroupEpoch[];
        const filtered = all.filter((e) => e.groupId === group);
        resolve(filtered.sort((a, b) => b.generation - a.generation));
      };
    });
  }

  /**
   * Create a brand-new active epoch and mark any previous active epoch as expired.
   */
  async create(
    groupId: string,
    ownerUserId: string,
    ownerDeviceId: string,
    reason: EpochRotationReason = "group_created"
  ): Promise<GroupEpoch> {
    const prev = await this.getCurrent(groupId);
    const gen = (prev?.generation ?? -1) + 1;

    if (prev && prev.status === "active") {
      // Expire previous
      prev.status = "expired";
      prev.rotatedAt = Date.now();
      await this.save(prev);
    }

    const epoch: GroupEpoch = {
      id: `${groupId}::${gen}`,
      groupId,
      epochId: crypto.randomUUID(),
      generation: gen,
      createdAt: Date.now(),
      reason,
      status: "active",
      ownerUserId,
      ownerDeviceId,
    };
    await this.save(epoch);
    return epoch;
  }

  /**
   * Mark an active epoch as revoked (e.g. device compromise).
   */
  async revoke(groupId: string, epochId: string): Promise<boolean> {
    const store = await this.openStore("readwrite");
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result as GroupEpoch[];
        let found = false;
        for (const epoch of all) {
          if (epoch.groupId === groupId && epoch.epochId === epochId && epoch.status === "active") {
            epoch.status = "revoked";
            epoch.rotatedAt = Date.now();
            store.put(epoch);
            found = true;
            break;
          }
        }
        resolve(found);
      };
    });
  }

  /** Record a rotation triggered by a membership change. Creates a new epoch. */
  async onMembershipChange(
    groupId: string,
    ownerUserId: string,
    ownerDeviceId: string,
    reason: "member_join" | "member_leave" | "device_added" | "device_revoked"
  ): Promise<GroupEpoch> {
    return this.create(groupId, ownerUserId, ownerDeviceId, reason);
  }

  /** Record a scheduled/time-based rotation. */
  async onScheduledRotation(
    groupId: string,
    ownerUserId: string,
    ownerDeviceId: string
  ): Promise<GroupEpoch> {
    return this.create(groupId, ownerUserId, ownerDeviceId, "scheduled_rotation");
  }

  /** Save or update an epoch record. */
  private async save(epoch: GroupEpoch): Promise<void> {
    const store = await this.openStore("readwrite");
    epoch.id = `${epoch.groupId}::${epoch.generation}`;
    store.put(epoch);
  }

  /** Clear all epochs (testing/cleanup). */
  async clear(): Promise<void> {
    const store = await this.openStore("readwrite");
    store.clear();
  }
}

export const epochStore = new EpochStore();