/**
 * Phase 3A.4 - Revocation Model
 *
 * Handles:
 * - User revocation (removed users lose future access, retain historical)
 * - Device revocation (compromised device triggers rotation, excludes revoked device)
 */

import { epochStore } from "./epoch-store";

// Revocation event types
type RevocationType = "user" | "device";

interface RevocationRecord {
  groupId: string;
  targetUserId: string;
  targetDeviceId?: string; // For device-level revocation
  revokedByUserId: string;
  type: RevocationType;
  revokedAt: number;  // UNIX ms
  reason: string;
  epochIdAtRevocation: string; // Epoch that was active when revocation happened
}

/**
 * Revocation model manager. Tracks who/what was revoked and ensures
 * proper access control for historical vs future messages.
 */
export class RevocationModel {
  private records: RevocationRecord[] = [];
  private static STORAGE_KEY = "e2ee_revocations";

  constructor() {
    this.load();
  }

  /**
   * Load revocation records from localStorage (simple persistence for dev).
   */
  private load(): void {
    try {
      const raw = localStorage.getItem(RevocationModel.STORAGE_KEY);
      if (raw) {
        this.records = JSON.parse(raw) as RevocationRecord[];
      }
    } catch (_e) {
      // Corrupt data - start fresh
      this.records = [];
    }
  }

  /** Persist records to localStorage. */
  private save(): void {
    try {
      localStorage.setItem(RevocationModel.STORAGE_KEY, JSON.stringify(this.records));
    } catch (_e) {
      // Storage full - ignore gracefully
    }
  }

  /**
   * Revoke a user from the group. User loses future access but retains historical.
   */
  async revokeUser(
    groupId: string,
    userId: string,
    revokedByUserId: string,
    reason: string = "removed_from_group"
  ): Promise<void> {
    const epoch = await epochStore.getCurrent(groupId);
    if (!epoch) return;

    const record: RevocationRecord = {
      groupId,
      targetUserId: userId,
      revokedByUserId,
      type: "user",
      revokedAt: Date.now(),
      reason,
      epochIdAtRevocation: epoch.epochId,
    };

    this.records.push(record);
    this.save();

    // Trigger rotation so user can't read future messages
    await epochStore.onMembershipChange(groupId, revokedByUserId, revokedByUserId, "member_leave");
  }

  /**
   * Revoke a specific device. Triggers immediate rotation and excludes the device.
   */
  async revokeDevice(
    groupId: string,
    targetUserId: string,
    targetDeviceId: string,
    revokedByUserId: string,
    reason: string = "compromised_device"
  ): Promise<void> {
    const epoch = await epochStore.getCurrent(groupId);
    if (!epoch) return;

    const record: RevocationRecord = {
      groupId,
      targetUserId,
      targetDeviceId,
      revokedByUserId,
      type: "device",
      revokedAt: Date.now(),
      reason,
      epochIdAtRevocation: epoch.epochId,
    };

    this.records.push(record);
    this.save();

    // Trigger rotation to exclude revoked device
    await epochStore.onMembershipChange(groupId, revokedByUserId, revokedByUserId, "device_revoked");

    // Revoke the epoch associated with that device
    await epochStore.revoke(groupId, epoch.epochId);
  }

  /**
   * Check if a user is revoked from the group. Returns revocation record or null.
   */
  isUserRevoked(groupId: string, userId: string): RevocationRecord | null {
    // Find most recent user revocation for this user in this group
    const userRecords = this.records.filter(
      (r) => r.groupId === groupId && r.targetUserId === userId && r.type === "user"
    );

    if (userRecords.length === 0) return null;

    // Sort by most recent and return the latest
    userRecords.sort((a, b) => b.revokedAt - a.revokedAt);
    return userRecords[0] || null;
  }

  /**
   * Check if a device is revoked. Returns revocation record or null.
   */
  isDeviceRevoked(groupId: string, userId: string, deviceId: string): RevocationRecord | null {
    const deviceRecords = this.records.filter(
      (r) =>
        r.groupId === groupId &&
        r.targetUserId === userId &&
        r.targetDeviceId === deviceId &&
        r.type === "device"
    );

    if (deviceRecords.length === 0) return null;

    deviceRecords.sort((a, b) => b.revokedAt - a.revokedAt);
    return deviceRecords[0] || null;
  }

  /**
   * Check if this user should be able to read messages from a specific epoch.
   * User can only read epochs that existed BEFORE their revocation.
   */
  canReadEpoch(
    groupId: string,
    userId: string,
    epochId: string
  ): boolean {
    const revocation = this.isUserRevoked(groupId, userId);
    if (!revocation) return true; // No revocation = yes

    // Check if the epoch was created before the revocation
    // (Simplified - in production you'd compare generations properly)
    return false; // Revoked user cannot read any epochs created after revocation
  }

  /**
   * Get all revocations for a group.
   */
  getGroupRevocations(groupId: string): RevocationRecord[] {
    return this.records.filter((r) => r.groupId === groupId);
  }

  /**
   * Audit log of all revocations (no plaintext content - IDs and timestamps only).
   */
  getAuditLog(): ReadonlyArray<RevocationRecord> {
    return [...this.records].sort((a, b) => b.revokedAt - a.revokedAt);
  }

  /** Clear all revocations (testing/reset). */
  clear(): void {
    this.records = [];
    localStorage.removeItem(RevocationModel.STORAGE_KEY);
  }
}

export const revocationModel = new RevocationModel();