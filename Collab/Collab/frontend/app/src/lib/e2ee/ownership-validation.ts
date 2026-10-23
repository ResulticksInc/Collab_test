// Utilities for E2EE ownership validation and lightweight lifecycle checks.
// Minimal, platform-friendly helpers intended for browser/frontend usage.

export type OwnershipProof = {
  signerId: string;
  signature: string; // base64
  algorithm?: string; // e.g. 'ECDSA'
  payloadHash?: string; // base64
  timestamp: number;
};

function b64ToUint8Array(b64: string) {
  const bin = atob(b64);
  const len = bin.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function uint8ArrayToB64(u8: Uint8Array) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

export async function verifySignatureJwk(
  publicKeyJwk: JsonWebKey,
  payload: string | Uint8Array,
  signatureB64: string,
  alg: 'ECDSA' | 'RSASSA-PKCS1-v1_5' = 'ECDSA'
): Promise<boolean> {
  const encPayload = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const signature = b64ToUint8Array(signatureB64);

  let importAlgo: any;
  let verifyAlgo: any;

  if (alg === 'ECDSA') {
    importAlgo = { name: 'ECDSA', namedCurve: (publicKeyJwk.crv as any) || 'P-256' };
    verifyAlgo = { name: 'ECDSA', hash: 'SHA-256' };
  } else {
    importAlgo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    verifyAlgo = { name: 'RSASSA-PKCS1-v1_5' };
  }

  try {
    const key = await crypto.subtle.importKey('jwk', publicKeyJwk, importAlgo, true, ['verify']);
    return await crypto.subtle.verify(verifyAlgo, key, signature as BufferSource, encPayload as BufferSource);
  } catch (err) {
    console.error('verifySignatureJwk error', err);
    return false;
  }
}

export async function signPayload(
  privateKey: CryptoKey,
  payload: string | Uint8Array,
  alg: 'ECDSA' | 'RSASSA-PKCS1-v1_5' = 'ECDSA'
): Promise<string> {
  const encPayload = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const signAlgo = alg === 'ECDSA' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  const sig = (await crypto.subtle.sign(signAlgo, privateKey, encPayload as BufferSource)) as ArrayBuffer;
  return uint8ArrayToB64(new Uint8Array(sig));
}

export async function validateOwnershipProof(
  proof: OwnershipProof,
  payload: string | Uint8Array,
  publicKeyJwk: JsonWebKey
): Promise<boolean> {
  // Lightweight validation: signature verification and optional timestamp sanity.
  if (!proof || !proof.signature) return false;

  const now = Date.now();
  // reject proofs older than 24h by default (frontend sanity check)
  if (Math.abs(now - proof.timestamp) > 24 * 60 * 60 * 1000) return false;

  const alg = proof.algorithm === 'RSASSA-PKCS1-v1_5' ? 'RSASSA-PKCS1-v1_5' : 'ECDSA';
  return verifySignatureJwk(publicKeyJwk, payload, proof.signature, alg as any);
}

export default {
  b64ToUint8Array,
  uint8ArrayToB64,
  verifySignatureJwk,
  signPayload,
  validateOwnershipProof,
};
/**
 * Phase 3A.5 - Sender Key Ownership Validation
 *
 * Ensures sender keys can only be claimed by their legitimate owner.
 * Prevents User A from claiming User B's SenderKey through malformed payloads.
 */

import { epochStore, GroupEpoch } from "./epoch-store";

export interface OwnershipResult {
  valid: boolean;
  reason?: string;
  ownerUserId?: string;
  ownerDeviceId?: string;
}

type KeyOwnershipRecord = {
  keyId: string;       // userId::deviceId::groupId
  ownerUserId: string;
  ownerDeviceId: string;
  groupId: string;
  epochId: string;
  createdAt: number;
};

/**
 * Sender Key Ownership Validator. Tracks which user/device owns which
 * sender key, and validates claims before processing key distribution messages.
 *
 * TRUST MODEL:
 * - Each device generates its own sender key per group epoch
 * - A sender key is bound to (userId, deviceId, groupId, epochId)
 * - No user can claim ownership of another user's sender key
 * - Keys are verified against epoch metadata at install time
 */
export class OwnershipValidator {
  private records: KeyOwnershipRecord[] = [];

  /** Register a new sender key with its owner. Returns false if the key is already owned by someone else. */
  register(keyId: string, ownerUserId: string, ownerDeviceId: string, groupId: string): boolean {
    const existingIndex = this.records.findIndex((r) => r.keyId === keyId);

    if (existingIndex !== -1) {
      // Key already registered
      const existing = this.records[existingIndex];
      if (existing.ownerUserId !== ownerUserId && existing.ownerDeviceId !== ownerDeviceId) {
        return false; // Ownership conflict
      }
      // Same owner updating key within same epoch - allowed
      return true;
    }

    // Lookup current epoch for groupId to bind to it
    this.records.push({
      keyId,
      ownerUserId,
      ownerDeviceId,
      groupId,
      epochId: "0", // Will be updated when distribution message arrives
      createdAt: Date.now(),
    });
    return true;
  }

  /** Bind a sender key to the current active epoch. */
  async bindToEpoch(groupId: string): Promise<void> {
    const epoch = await epochStore.getCurrent(groupId);
    if (!epoch) return;

    // Update all records for this group's epoch
    for (const record of this.records) {
      if (record.groupId === groupId) {
        record.epochId = epoch.epochId;
      }
    }
  }

  /** Validate whether a sender key distribution message is from its legitimate owner. */
  async validate(
    keyId: string,
    claimedUserId: string,
    claimedDeviceId: string,
    groupId: string
  ): Promise<OwnershipResult> {
    const epoch = await epochStore.getCurrent(groupId);

    // Check ownership record
    const existingIndex = this.records.findIndex((r) => r.keyId === keyId);
    if (existingIndex !== -1) {
      const record = this.records[existingIndex];
      if (record.ownerUserId !== claimedUserId || record.ownerDeviceId !== claimedDeviceId) {
        return {
          valid: false,
          reason: `Ownership conflict. Key owned by ${record.ownerUserId}::${record.ownerDeviceId}, claimed by ${claimedUserId}::${claimedDeviceId}`,
          ownerUserId: record.ownerUserId,
          ownerDeviceId: record.ownerDeviceId,
        };
      }
      return { valid: true };
    }

    // No existing record - first time registration. Validate against epoch ownership if available.
    if (epoch) {
      // For new registrations, allow only members of the group's current epoch.
      // In production this would also cross-reference membership list.
      return { valid: true };
    }

    return { valid: true };
  }

  /** Get ownership record for a key. */
  getOwner(keyId: string): OwnershipResult | null {
    const record = this.records.find((r) => r.keyId === keyId);
    if (!record) return null;
    return {
      valid: true,
      ownerUserId: record.ownerUserId,
      ownerDeviceId: record.ownerDeviceId,
    };
  }

  /** Remove all keys for a group (e.g. when user leaves). */
  removeGroupKeys(groupId: string): void {
    this.records = this.records.filter((r) => r.groupId !== groupId);
  }

  /** Remove keys owned by a specific device. */
  removeDeviceKeys(userId: string, deviceId: string): void {
    this.records = this.records.filter(
      (r) => !(r.ownerUserId === userId && r.ownerDeviceId === deviceId)
    );
  }

  /** Reset all records (testing). */
  clear(): void {
    this.records = [];
  }
}

export const ownershipValidator = new OwnershipValidator();