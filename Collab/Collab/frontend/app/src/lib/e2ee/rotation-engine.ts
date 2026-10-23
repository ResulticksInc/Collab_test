/**
 * Phase 3A.2 - Rotation Engine
 *
 * Manages sender key rotation policy with triggers for:
 * - Membership changes (join/leave)
 * - Device events (add/revoke)
 * - Scheduled rotation (time-based or message-count based)
 */

import { epochStore, EpochRotationReason } from "./epoch-store";

// Rotation configuration
interface RotationConfig {
  maxMessageCount: number;    // Rotate after N messages per epoch
  maxAgeMs: number;           // Rotate after T ms (14 days default)
}

const DEFAULT_CONFIG: RotationConfig = {
  maxMessageCount: 100,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000, // 14 days
};

// Message counter per epoch
interface EpochCounter {
  groupId: string;
  epochId: string;
  messageCount: number;
  lastResetAt: number;
}

/**
 * Rotation engine tracks message counts and age to trigger rotations.
 */
export class RotationEngine {
  private config: RotationConfig;
  // In-memory counter map - resets on refresh (acceptable for dev)
  private counters = new Map<string, EpochCounter>();

  constructor(config?: Partial<RotationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Update rotation policy config. */
  updateConfig(partial: Partial<RotationConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** Get current rotation config. */
  getConfig(): RotationConfig {
    return { ...this.config };
  }

  /**
   * Record a message sent in the group. Returns true if rotation should happen.
   */
  async recordMessage(
    groupId: string,
    epochId: string,
    ownerUserId: string,
    ownerDeviceId: string
  ): Promise<boolean> {
    const key = `${groupId}::${epochId}`;
    const counter = this.counters.get(key);

    if (!counter || counter.epochId !== epochId) {
      // New epoch or no counter yet - create one
      this.counters.set(key, {
        groupId,
        epochId,
        messageCount: 1,
        lastResetAt: Date.now(),
      });
      return false;
    }

    counter.messageCount += 1;

    // Check message count threshold
    if (counter.messageCount >= this.config.maxMessageCount) {
      await epochStore.onScheduledRotation(groupId, ownerUserId, ownerDeviceId);
      this.counters.delete(key);
      return true;
    }

    // Check age threshold
    const age = Date.now() - counter.lastResetAt;
    if (age >= this.config.maxAgeMs) {
      await epochStore.onScheduledRotation(groupId, ownerUserId, ownerDeviceId);
      this.counters.delete(key);
      return true;
    }

    return false;
  }

  /**
   * Trigger rotation for membership change.
   */
  async onMemberJoin(
    groupId: string,
    ownerUserId: string,
    ownerDeviceId: string
  ): Promise<void> {
    await epochStore.onMembershipChange(groupId, ownerUserId, ownerDeviceId, "member_join");
    this.clearGroupCounters(groupId);
  }

  async onMemberLeave(
    groupId: string,
    ownerUserId: string,
    ownerDeviceId: string
  ): Promise<void> {
    await epochStore.onMembershipChange(groupId, ownerUserId, ownerDeviceId, "member_leave");
    this.clearGroupCounters(groupId);
  }

  async onDeviceAdded(
    groupId: string,
    ownerUserId: string,
    ownerDeviceId: string
  ): Promise<void> {
    await epochStore.onMembershipChange(groupId, ownerUserId, ownerDeviceId, "device_added");
    // Don't clear counters - just track the new device
  }

  async onDeviceRevoked(
    groupId: string,
    ownerUserId: string,
    ownerDeviceId: string
  ): Promise<void> {
    await epochStore.onMembershipChange(groupId, ownerUserId, ownerDeviceId, "device_revoked");
    this.clearGroupCounters(groupId);
  }

  /**
   * Check if current epoch should be rotated based on age.
   */
  async checkScheduledRotation(
    groupId: string,
    ownerUserId: string,
    ownerDeviceId: string
  ): Promise<boolean> {
    const epoch = await epochStore.getCurrent(groupId);
    if (!epoch) return false;

    const age = Date.now() - epoch.createdAt;
    if (age >= this.config.maxAgeMs) {
      await epochStore.onScheduledRotation(groupId, ownerUserId, ownerDeviceId);
      return true;
    }

    return false;
  }

  /**
   * Clear all counters for a group (after rotation).
   */
  private clearGroupCounters(groupId: string): void {
    for (const [key, counter] of this.counters.entries()) {
      if (counter.groupId === groupId) {
        this.counters.delete(key);
      }
    }
  }

  /**
   * Get current counter state for debugging.
   */
  getCounter(groupId: string): EpochCounter | null {
    const epoch = this.counters.get(`${groupId}::current`);
    return epoch || null;
  }

  /** Reset all counters (testing). */
  reset(): void {
    this.counters.clear();
  }
}

export const rotationEngine = new RotationEngine();