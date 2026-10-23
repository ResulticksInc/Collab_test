# Phase 3B Implementation Plan

## Prerequisite Status: BLOCKED

Phase 3B cannot be implemented until the Signal runtime is browser-compatible. Current verdict (VERDICT B) means `@signalapp/libsignal-client` cannot function in a browser. This plan documents the architecture for when a WASM-compatible Signal implementation becomes available.

---

## Pre-Condition Checklist

| Requirement | Status | Notes |
|-------------|--------|-------|
| Browser-compatible Signal library | ❌ MISSING | Requires WASM migration (see `BROWSER_COMPATIBILITY_VERDICT.md`) |
| Phase 3A epoch model | ❌ INCOMPLETE | Epoch rotation not implemented |
| Phase 3A recovery model | ❌ INCOMPLETE | No backup/restore mechanism |
| Runtime crash resolved | ✅ FIXED | App builds without Signal native error |

**DO NOT implement Phase 3B until all pre-conditions are green.**

---

## Architecture Overview

```
┌──────────────┐     ┌───────────────────┐     ┌─────────────────┐
│   Sender D   │────>│  Pairwise Encrypt  │────>│  Message Store  │
│              │     │  (per recipient)   │     │    (backend)    │
└──────────────┘     └───────────────────┘     └─────────────────┘
                           │
                    ┌──────▼───────┐
                    │  Device Fanout│
                    │ (per device)  │
                    └──────────────┘
```

---

## Sprint 1: Pairwise Distribution

### What It Does
For each recipient user in a group, create an individually encrypted envelope containing the sender key distribution message.

### Files to Change
| File | Change |
|------|--------|
| `frontend/app/src/lib/e2ee/manager.ts` | Refine `distributeGroupSenderKey()` — currently sequential single-loop fanout |
| NEW: `frontend/app/src/lib/e2ee/pairwise.ts` | Extract pairwise logic into dedicated module |

### Implementation Steps
1. Create `pairwise.ts` with `encryptForRecipients(token, groupId, userIds, payload)` function
2. For each recipient user:
 * Fetch device list via backend API
 * Create Signal session if needed
 * Encrypt distribution message to that user's devices
3. Send envelope array to backend for persistence
4. Update `distributeGroupSenderKey()` to use new module

### Key Design Decisions
- Sender key distribution message is identical for all recipients (same sender, same groupId)
- Each recipient gets per-device encrypted envelopes
- Backend stores envelopes in existing `ciphertext` message array schema

---

## Sprint 2: Device Fanout

### What It Does
For each recipient user, fan out the encrypted sender key to ALL of that user's registered devices.

### Files to Change
| File | Change |
|------|--------|
| `frontend/app/src/lib/e2ee/pairwise.ts` | Add per-device envelope creation |
| Backend: e2ee message API | Already supports ciphertext array — verify schema compatibility |

### Implementation Steps
1. Query backend for recipient's device list: `GET /api/e2ee/devices/:userId`
2. For each device, create signal session and encrypt
3. Bundle per-user envelopes into single message document
4. Handle missing devices gracefully (skip, log warning)

---

## Sprint 3: Offline Queue

### What It Does
When a recipient is offline or unreachable, queue the sender key distribution for later retry/delivery.

### Files to Change
| File | Change |
|------|--------|
| NEW: `backend/app/src/e2ee/offline-queue.ts` | Server-side queue for pending distributions |
| Backend: message API | Add queue reference to message document |

### Implementation Steps
1. When fanout fails for a device, store failure in queue table
2. Queue entry includes: senderId, groupId, deviceId, distributionMessage, timestamp
3. Background worker processes queue with exponential backoff
4. Deliver when device comes online via WebSocket push or stored message

---

## Sprint 4: Distribution Acknowledgements

### What It Does
Receivers send an encrypted ACK message confirming receipt of sender key. Sender monitors for ACKs.

### Files to Change
| File | Change |
|------|--------|
| NEW: `shared/src/protocol.ts` | Define ACK message type constant |
| `frontend/app/src/lib/e2ee/manager.ts` | Add ACK handling in `decryptMessageList()` |
| Backend: message handler | Persist and query ACK state |

### Protocol
```
Sender → Group: GROUP_SENDER_KEY_DISTRIBUTION (encrypted envelope)
Receiver → Group: GROUP_SENDER_KEY_ACK (encrypted envelope)
   { type: "GROUP_SENDER_KEY_ACK", groupId, senderId, senderDeviceId, epoch }
```

### Timeout Policy
| Event | Action |
|-------|--------|
| ACK received within 30s | Mark device as synchronized |
| No ACK after 30s | Queue retry distribution |
| No ACK after 120s | Mark device stale, log metric |
| Max 3 retries | Escalate to admin alert |

---

## Sprint 5: Missing-Key Recovery

### What It Does
When a message cannot be decrypted because the sender key is missing, trigger a re-request from the group.

### Files to Change
| File | Change |
|------|--------|
| `frontend/app/src/lib/e2ee/manager.ts` | Add recovery detection in `decryptMessageList()` |
| NEW: Socket event handler | Emit `request_sender_key_replay` on socket |
| Backend: group controller | Handle replay request, forward to group members |

### Flow
```
Message received → decrypt fails (no key) 
  → emit "request_sender_key_replay" via socket
  → server forwards to all group members with valid keys
  → member with key re-sends distribution message
```

---

## Sprint 6: Epoch Synchronization

### What It Does
Ensure all devices have the current epoch's sender key. Detect when epochs diverge and trigger rotation.

### Files to Change
| File | Change |
|------|--------|
| `frontend/app/src/lib/e2ee/SignalStore.ts` | Add epoch metadata storage |
| `frontend/app/src/lib/e2ee/manager.ts` | Add epoch comparison + rotation trigger |
| Backend: group API | Expose current epoch per group |

### Epoch Metadata to Store
```typescript
interface GroupEpoch {
  groupId: string;
  epochId: string;        // UUID, changes on rotation
  senderUser: string;     // who owns current key
  senderDevice: string;   // which device
  generation: number;     // incrementing counter
  createdAt: Date;        // timestamp
}
```

### Rotation Policy
| Trigger | Action |
|---------|--------|
| Epoch age > 24h | Force rotation |
| Member leaves group | Rotate keys |
| Decryption failure rate > 5% | Trigger rotation |
| Manual admin command | Immediate rotation |

---

## Deliverables Checklist

| Item | Target Sprint | Status |
|------|--------------|--------|
| Pairwise distribution module | Sprint 1 | ⬜ Not started |
| Device fanout logic | Sprint 2 | ⬜ Not started |
| Offline queue | Sprint 3 | ⬜ Not started |
| ACK protocol | Sprint 4 | ⬜ Not started |
| Missing-key recovery | Sprint 5 | ⬜ Not started |
| Epoch synchronization | Sprint 6 | ⬜ Not started |

---

## Dependencies

Phase 3B depends on:
1. ✅ Runtime crash fix (completed)
2. ❌ Browser-compatible Signal library (WASM migration needed)
3. ❌ Phase 3A epoch model completion
4. ❌ Phase 3A recovery model completion

**Estimated effort after WASM migration: ~6 sprints, ~3 weeks per sprint = ~6 weeks total.**