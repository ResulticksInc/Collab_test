# Phase 3A Validation Report

## Scope: Group Sender Key Infrastructure

---

## 1. GroupSenderKey Storage

### IndexedDB Schema
**File:** `frontend/app/src/lib/e2ee/SignalStore.ts` (lines 1-118)

| Store Name | Key Path | Purpose | Status |
|------------|----------|---------|--------|
| `identity` | `id` | Identity key pair + registration ID | ✅ Present |
| `prekeys` | `id` | One-time pre-keys | ✅ Present |
| `signedPreKeys` | `id` | Signed pre-key | ✅ Present |
| `sessions` | `id` | 1:1 Signal sessions | ✅ Present |
| `senderKeys` | `id` | Group sender keys | ✅ Present |

### Storage Implementation
**File:** `frontend/app/src/lib/e2ee/manager.ts` (lines 140-156)

```typescript
class MySenderKeyStore {
  async saveSenderKey(sender, distributionId, record) {
    // Composite key: {userId}::{deviceId}::{groupId}
    const id = `${sender.name()}::${sender.deviceId()}::${distributionId}`;
    await signalStore.storeSenderKey(id, Buffer.from(record.serialize()).toString("base64"));
  }
  async getSenderKey(sender, distributionId) {
    const id = `${sender.name()}::${sender.deviceId()}::${distributionId}`;
    const b64 = await signalStore.loadSenderKey(id);
    if (!b64) return null;
    return Signal.SenderKeyRecord.deserialize(Buffer.from(b64, "base64"));
  }
}
```

### Verdict: ✅ PASS
Storage layer correctly implements composite key pattern `{sender}:{deviceId}:{distributionId}` for group sender keys. The `senderKeys` object store exists with proper CRUD operations.

---

## 2. Sender Key Ownership Model

### Evidence
- Each sender key record is identified by the sender's `ProtocolAddress` (userId + deviceId)
- Keys are stored per-device — each device generates and owns its own sender keys independently
- Distribution uses the `distributionId` (groupId in current implementation) as epoch anchor

### Verdict: ⚠️ PARTIAL
Ownership model exists implicitly through the composite key pattern but is not explicitly documented. No ownership validation (e.g., preventing one user from claiming another user's sender key).

---

## 3. Sender Key Versioning

### Evidence
**File:** `frontend/app/src/lib/e2ee/manager.ts` (lines 140-156)

The Signal protocol itself provides versioning through:
- `SenderKeyRecord` contains `chainKey` and `iteration` counters internally
- Each call to `SenderKeyDistributionMessage.create()` generates a fresh chain key + iteration counter
- `MySenderKeyStore.saveSenderKey()` overwrites the record for the same composite key, allowing in-place updates

### Verdict: ✅ PASS
Versioning is handled by Signal's native `SenderKeyRecord` protocol type. The storage layer correctly supports overwrite semantics needed for key refresh/rotation.

---

## 4. Epoch Model

### Evidence
**File:** `frontend/app/src/lib/e2ee/manager.ts` (lines 361-375)

```typescript
const distMsg = await Signal.SenderKeyDistributionMessage.create(
  localAddress,
  groupId, // distributionId (UUID string)
  stores.senderKey
);
```

The current implementation:
- Uses `groupId` as the distribution ID (epoch anchor)
- Does NOT track epoch timestamps or generation numbers
- Does NOT implement epoch rotation policy
- Does NOT store epoch metadata alongside sender keys

### What's Missing:
| Requirement | Present | Location |
|-------------|---------|----------|
| Epoch timestamp storage | ❌ No | `SignalStore.ts` — no `epochCreatedAt` field |
| Epoch generation counter | ❌ No | No rotation policy exists |
| Epoch rotation trigger | ❌ No | Keys are created on-demand, not time-based |
| Stale epoch detection | ❌ No | No TTL or max-lifetime check |

### Verdict: ❌ FAIL
Epoch model is not implemented. Sender keys use `groupId` as a static anchor with no rotation lifecycle.

---

## 5. Recovery Model

### Evidence
No recovery mechanism exists in either `SignalStore.ts` or `manager.ts`:
- No key backup/restore operations
- No missing-key detection
- No key re-request protocol
- Browser refresh loses any in-memory key state (IndexedDB persists serialized data but Signal native objects don't survive page reload)

### Verdict: ❌ FAIL
Recovery model is not implemented.

---

## 6. Key Lifecycle

| Phase | Status | Evidence |
|-------|--------|----------|
| Creation | ⚠️ Partial | `initE2EE()` creates identity + pre-keys. Sender keys created in `distributeGroupSenderKey()` on-demand. |
| Distribution | ✅ Present | `distributeGroupSenderKey()` sends key distribution messages via encrypted envelopes (lines 345-395) |
| Rotation | ❌ Missing | No time-based or count-based rotation policy |
| Recovery | ❌ Missing | No backup/restore mechanism |
| Revocation | ❌ Missing | No key deletion or device revocation flow |

---

## Summary

| Requirement | Status | Notes |
|-------------|--------|-------|
| GroupSenderKey storage | ✅ PASS | IndexedDB + composite key pattern |
| Sender key ownership | ⚠️ PARTIAL | Implicit, no validation |
| Sender key versioning | ✅ PASS | Protocol-level via Signal SDK |
| Epoch model | ❌ FAIL | Not implemented |
| Recovery model | ❌ FAIL | Not implemented |
| Key lifecycle complete | ❌ INCOMPLETE | Rotation/recovery/revocation missing |

**Overall Phase 3A Status: PARTIALLY COMPLETE — data layer exists, lifecycle incomplete.**

Critical blocker for Phase 3B: Epoch rotation and recovery must be implemented before pairwise distribution can safely function.