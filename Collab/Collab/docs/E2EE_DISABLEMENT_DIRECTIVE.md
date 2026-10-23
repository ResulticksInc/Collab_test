# E2EE Disablement Directive

**Status:** ACTIVE — E2EE is currently DISABLED (plaintext mode)  
**Date:** 2026-06-11  
**Reversible:** Yes — see Reactivation section below

---

## Objective

Temporarily disable E2EE execution while preserving the entire E2EE codebase.  
All E2EE code, tables, routes, services, and migrations are **intact and untouched**.

---

## Feature Flags

### Single Source of Truth

| Variable | Location | Current Value | Purpose |
|---|---|---|---|
| `E2EE_ENABLED` | `.env` / server env | `false` | Backend kill switch |
| `NEXT_PUBLIC_E2EE_ENABLED` | `.env` / client env | `false` | Frontend kill switch |

Both must be set. The frontend flag controls all client-side encryption paths.  
The backend flag is exposed via `config.e2ee.enabled` and `e2eeEnabled` from `platform.ts`.

---

## What Changes When Disabled

### Frontend (`NEXT_PUBLIC_E2EE_ENABLED=false`)

`isE2EEEnabled()` in `frontend/app/src/lib/e2ee/manager.ts` returns `false`.

The following are **skipped**:
- `initE2EE()` — returns immediately, no key generation
- `encryptForUser()` — returns `null` immediately
- `encryptBlob()` — returns blob unmodified with empty key/iv
- `decryptMessageList()` — passes messages through unchanged
- All `GET /api/e2ee/*` calls — never executed

Message flow (plaintext mode):
```
User types → Send → Socket/HTTP API → Message delivered
```

### Backend (`E2EE_ENABLED=false`)

- All E2EE routes remain registered at `/api/e2ee/*`
- Messaging, file upload, voice, calls — none require E2EE
- Messages are saved as:
  ```sql
  body             = <actual text>
  ciphertext_json  = NULL
  encryption_version = 0
  ```
- No encryption errors are thrown
- No encryption warnings are shown to users

---

## Files Modified

| File | Change |
|---|---|
| `.env` | `NEXT_PUBLIC_E2EE_ENABLED=false`, `E2EE_ENABLED=false` |
| `.env.example` | Same flags documented |
| `config/src/index.ts` | Added `e2ee.enabled` from `E2EE_ENABLED` env var |
| `backend/app/src/platform.ts` | Exports `e2eeEnabled` boolean |
| `backend/app/src/routes/e2ee.ts` | Added preservation notice comment |
| `backend/app/src/realtime/socket.ts` | Fixed message guard to allow `voice`/`type` without `encrypted` |
| `backend/app/src/services/messageService.ts` | Added comment on encrypted-edit guard (non-functional when disabled) |
| `frontend/app/src/lib/e2ee/manager.ts` | Added guard to `encryptForUser()`, added comment to `isE2EEEnabled()` |
| `frontend/app/src/lib/e2ee/media.ts` | Added `E2EE_ENABLED` check to `encryptBlob()` |

### Files NOT modified (preserved intact)
- `backend/app/src/services/e2eeService.ts`
- `database/migrations/0022_e2ee_foundation.sql`
- `frontend/app/src/lib/e2ee/epoch-store.ts`
- `frontend/app/src/lib/e2ee/ownership-validation.ts`
- `frontend/app/src/lib/e2ee/recovery-protocol.ts`
- `frontend/app/src/lib/e2ee/revocation-model.ts`
- `frontend/app/src/lib/e2ee/rotation-engine.ts`
- `frontend/app/src/lib/e2ee/SignalStore.ts`
- `docs/E2EE_PROTOCOL_SPEC.md`

---

## Socket Message Guard Fix

**Problem:** The socket `MESSAGE_SEND` handler had:
```ts
if (!conversationId || (!text && !file && !encrypted)) return;
```
This blocked voice messages sent without `encrypted`, `text`, or `file`.

**Fix:**
```ts
if (!conversationId || (!text && !file && !encrypted && !voice && !type)) return;
```
Voice messages carry `voice` + `type: "voice"` and no text, so they now pass through correctly.

---

## Plaintext Message Storage

When E2EE is disabled, messages are stored as:

```sql
body              = 'actual message text'
ciphertext_json   = NULL
encryption_version = 0
```

The `encryptionVersion = 0` is the existing plaintext convention — no schema change needed.

---

## Reactivation

To re-enable E2EE when ready:

1. Set in `.env`:
   ```env
   E2EE_ENABLED=true
   NEXT_PUBLIC_E2EE_ENABLED=true
   ```
2. Complete the missing backend work:
   - Validate `GET /api/e2ee/users/:userId/bundle` response
   - Validate multi-device session establishment
   - Validate media encryption/decryption end-to-end
3. Restart backend and frontend

No code changes are needed — the entire E2EE codebase is intact and functional once the flag is toggled.

---

## Verification Checklist (Plaintext Mode)

- [ ] Text messaging works (DM + group)
- [ ] Voice messages record, upload, send, receive, play back
- [ ] Image / PDF / video / ZIP / generic file attachments work
- [ ] Call setup, audio, screen share work
- [ ] Meetings work
- [ ] Groups work
- [ ] Search works
- [ ] Unread counts work
- [ ] New user registration works
- [ ] Duplicate DM prevention works
- [ ] Conversation disappearance issue resolved
- [ ] No E2EE error messages visible to users
