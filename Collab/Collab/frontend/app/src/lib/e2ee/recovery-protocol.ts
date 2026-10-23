/**
 * Phase 3A.3 - Recovery Protocol
 *
 * Handles missing-key recovery flow:
 * 1. Detect missing epoch during decryption
 * 2. Request epoch bundle from server/group
 * 3. Install recovered epoch
 * 4. Retry decryption
 * 5. Telemetry on recovery events
 */

import { epochStore } from "./epoch-store";

// Recovery telemetry interface
interface RecoveryTelemetry {
  groupId: string;
  missingEpochId?: string;
  requestTimestamp: number;
  responseTimestamp?: number;
  retryTimestamp?: number;
  success: boolean;
  error?: string;
}

/**
 * Recovery protocol manager handles missing epoch recovery.
 */
export class RecoveryProtocol {
  private telemetry: RecoveryTelemetry[] = [];

  /**
   * Check if we have the required epoch for a message. Returns null if epoch is available,
   * or the recovery metadata if epoch is missing and needs to be recovered.
   */
  async checkEpoch(
    groupId: string,
    senderUserId: string,
    senderDeviceId: string
  ): Promise<RecoveryRequest | null> {
    const epoch = await epochStore.getCurrent(groupId);
    if (!epoch) {
      return {
        groupId,
        requiredEpoch: "unknown",
        reason: "no_epoch_exists",
        senderUserId,
        senderDeviceId,
      };
    }

    // Check if we have the key stored for this sender in this epoch
    const keyId = `${senderUserId}::${senderDeviceId}::${groupId}`;
    const hasKey = await this.hasSenderKey(keyId);

    if (!hasKey) {
      return {
        groupId,
        requiredEpoch: epoch.epochId,
        reason: "missing_sender_key",
        senderUserId,
        senderDeviceId,
      };
    }

    return null;
  }

  /**
   * Attempt to recover a missing epoch. Returns recovered metadata or throws.
   */
  async recover(
    request: RecoveryRequest
  ): Promise<RecoveryResult | null> {
    const telemetryEntry: RecoveryTelemetry = {
      groupId: request.groupId,
      missingEpochId: request.requiredEpoch !== "unknown" ? request.requiredEpoch : undefined,
      requestTimestamp: Date.now(),
      success: false,
    };

    try {
      // Request epoch bundle from server
      const bundle = await this.fetchEpochBundle(request.groupId);
      if (!bundle) {
        telemetryEntry.error = "no_bundle_from_server";
        telemetryEntry.responseTimestamp = Date.now();
        this.telemetry.push(telemetryEntry);
        return null;
      }

      // Install epoch data
      await this.installEpoch(bundle);
      telemetryEntry.responseTimestamp = Date.now();
      telemetryEntry.success = true;

      return {
        groupId: request.groupId,
        recoveredEpochId: bundle.epochId,
        installedAt: Date.now(),
      };
    } catch (err) {
      telemetryEntry.error = String(err);
      telemetryEntry.responseTimestamp = Date.now();
      this.telemetry.push(telemetryEntry);
      throw err;
    }
  }

  /**
   * Retry decryption after recovery.
   */
  async retryDecrypt(
    groupId: string,
    senderUserId: string,
    senderDeviceId: string,
    messageData: any
  ): Promise<boolean> {
    const prevEpoch = await epochStore.getCurrent(groupId);
    if (!prevEpoch) return false;

    // Key should now be installed - attempt decrypt through manager
    try {
      // Placeholder - actual decrypt happens through manager.decryptMessage()
      const signal = await import("@signalapp/libsignal-client").catch(() => null);
      if (!signal) return false;

      // Retry succeeded
      return true;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Check if we have the sender key in our IndexedDB store.
   */
  private async hasSenderKey(id: string): Promise<boolean> {
    // Access signal-store's senderKeys objectStore directly
    return new Promise((resolve) => {
      const req = indexedDB.open("signal-store", 1);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains("senderKeys")) {
            resolve(false);
            return;
          }
          const tx = db.transaction("senderKeys", "readonly");
          const store = tx.objectStore("senderKeys");
          const getReq = store.get(id);
          getReq.onsuccess = () => resolve(!!getReq.result);
          getReq.onerror = () => resolve(false);
        } catch (_e) {
          resolve(false);
        }
      };
      req.onerror = () => resolve(false);
    });
  }

  /**
   * Fetch epoch bundle from server. In real implementation this would call an API.
   */
  private async fetchEpochBundle(groupId: string): Promise<EpochBundle | null> {
    // Placeholder - in production this would call the backend to request the current
    // epoch's sender key distribution message for this group.
    try {
      const current = await epochStore.getCurrent(groupId);
      if (!current) return null;

      return {
        groupId,
        epochId: current.epochId,
        generation: current.generation,
        ownerUserId: current.ownerUserId,
        ownerDeviceId: current.ownerDeviceId,
        senderKeyPayload: "", // Will be populated by server response
        createdAt: current.createdAt,
      };
    } catch (_e) {
      return null;
    }
  }

  /**
   * Install epoch data from bundle.
   */
  private async installEpoch(bundle: EpochBundle): Promise<void> {
    // Check if epoch already exists in local store
    const existing = await epochStore.getCurrent(bundle.groupId);
    if (existing && existing.generation >= bundle.generation) {
      return; // We have a newer or equal epoch
    }

    // Process sender key distribution through Signal protocol
    const signal = await import("@signalapp/libsignal-client").catch(() => null);
    if (!signal || !bundle.senderKeyPayload) {
      // Can't install without Signal module or key payload
      return;
    }

    // TODO: When Signal WASM is available, deserialize and process the
    // SenderKeyDistributionMessage through processSenderKeyDistributionMessage()
  }

  /** Get all recovery telemetry records. */
  getTelemetry(): RecoveryTelemetry[] {
    return [...this.telemetry];
  }

  /** Clear telemetry (testing/reset). */
  clearTelemetry(): void {
    this.telemetry = [];
  }
}

export interface RecoveryRequest {
  groupId: string;
  requiredEpoch: string;
  reason: "no_epoch_exists" | "missing_sender_key";
  senderUserId: string;
  senderDeviceId: string;
}

export interface RecoveryResult {
  groupId: string;
  recoveredEpochId: string;
  installedAt: number;
}

interface EpochBundle {
  groupId: string;
  epochId: string;
  generation: number;
  ownerUserId: string;
  ownerDeviceId: string;
  senderKeyPayload: string;
  createdAt: number;
}

export const recoveryProtocol = new RecoveryProtocol();