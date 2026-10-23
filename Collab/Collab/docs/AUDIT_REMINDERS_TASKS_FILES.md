# Enterprise Production Audit — Reminders, Tasks, Files

Code‑grounded, adversarially verified (every P0/P1 re‑checked against the source).
Bar = internal **enterprise** rollout. Scores 0–10.

## Verdict
**NOT enterprise‑ready.** Three competent *personal/small‑team* modules with genuinely
solid foundations wearing enterprise UIs they don't fulfill.

| Module | Production | Enterprise | Recommendation |
|---|---|---|---|
| **Reminders** | 5 | 3 | ship‑with‑P0‑fixes |
| **Tasks** | 5 | 3 | **not‑ready** (data‑loss + O(N²) are ship‑blockers) |
| **Files** | 5.5 | 3 | ship‑with‑P0‑fixes |

**The one theme:** the hard backend parts are *right* (Reminders' restart‑safe exactly‑once
scheduler; Tasks' IDOR‑free authz; Files' OOM‑safe streaming) — but the **last mile** is
wrong in the same shape across all three: (1) every list is **unpaginated server‑side +
un‑virtualized + filtered client‑side over the full dataset**, (2) the **integrations the UI
implies don't exist**, and (3) **data‑integrity/safety gaps**. None of the fixes touch
calls/meetings/E2EE.

---

## Cross‑module P0 (ranked — fix these before rollout)
1. **Tasks concurrent‑edit data loss** — last‑write‑wins, no version/ETag (`mysql.ts:1582` bare `WHERE id=$1`); concurrent PATCHes silently clobber. → version + 409 + live‑merge the open panel.
2. **Tasks O(N²) scale** — global `io.emit(TASK_CHANGED)` (`tasks.ts:26`) → every client refetches ≤2000 rows; plus a hard **2000‑cap that silently hides tasks** (`mysql.ts:1571`). → scope broadcast to reporter+assignee rooms + real server pagination.
3. **Files list fully unbounded** — `listForUser` no LIMIT (`mysql.ts:1917`), whole set re‑shipped on every `FILE_CHANGED`, un‑virtualized. → server pagination (blast‑radius: `searchService.ts` Files index).
4. **Reminders list fully unbounded** — `SELECT *` no LIMIT (`mysql.ts:1336`), re‑shipped on every `REMINDER_CHANGED`, compounded by unbounded recurrence row‑spawn. → server pagination.
5. **Task due dates fire nothing** — `tasks.dueAt` stored/patchable but never consumed; no `claimDue`/overdue scan in the boot loop. → wire a task‑due firing path (reuse the reminder scheduler).
6. **Reminder notifications dead** — no `reminder` branch in `sw.js` resolveNavigation/actionsFor, `dispatchNotif.actionsForType`, or in‑app onNavigate → click opens **Chats**, no Complete/Snooze. (Same class: `file_shared` mis‑routes.)
7. **Web Push ignores quiet‑hours / mute** — `pushNotif → webPushService.sendToUser` loads no user settings (`notify.ts:19`); muted users get closed‑tab pushes.
8. **Reminders recurring double‑spawn** — `spawnNext` runs at fire time AND on completion, no dedupe → a fired‑then‑completed recurring reminder spawns twice.
9. **Files lifecycle table‑stakes missing** — no restore/recycle‑bin UI (despite soft‑delete + retained blobs), no GC/retention job (unbounded storage cost), no virus scanning.
10. **Server‑side validation missing** — Tasks (status/priority enums, empty/over‑length title, due dates, circular deps) + Reminders (priority/recurrence/status allow‑lists) persist garbage states.
11. **Files downloads + public‑link fetches not audited** (`files.ts`) — exfiltration invisible to the audit log. *(Rate‑limiting is NOT a gap — global 600/min limiter covers both routes.)*

---

## Reminders — 5 prod / 3 ent — ship‑with‑P0‑fixes
**Solid:** persistent DB scheduler, exactly‑once firing (`FOR UPDATE SKIP LOCKED` + `notified_at`), missed‑reminder catch‑up after restart, correct UTC‑store/local‑display, no IDOR.
**P0:** notification nav+actions (sw.js/dispatchNotif/CoLabV1); recurring double‑spawn dedupe (reminderService/reminderFireService); server quiet‑hours gate for push (notify.ts + reminderFireService).
**P1:** Snooze (absent entirely); server pagination; custom lead time; allow‑list validation; wire the dead meeting‑reminder scheduler + task‑due reminders.
**P2:** richer recurrence (reuse meetings' `recurrenceRule`); auto‑prune recurrence rows; tray/badge overdue; lock‑screen content suppression; NL quick‑add; fire/snooze/complete history.
**Effort:** M (~4–6d P0s) + L (snooze + pagination + lead time). **Regression:** P0‑1 LOW, P0‑2 MEDIUM (shared `spawnNext`), P0‑3 LOW‑MED. **Don't refactor the firing engine.**

## Tasks — 5 prod / 3 ent — **not‑ready**
**Solid:** IDOR‑free (`assertTaskAccess` on every op), CRUD/comments/deps/activity/search/soft‑delete work.
**P0:** optimistic‑concurrency (version + 409 + live‑merge); kill global broadcast + 2000‑cap → scoped rooms + pagination; server‑side enum/title/due/cycle validation; fix N+1 serialization (batch assignee/reporter lookups, `serialize.ts:424`).
**P1:** multiple assignees (join table); attachments; optimistic UI; richer create modal; watchers + description‑@mention notify; dependency enforcement; before/after audit values; delete‑confirm; virtualize.
**P2:** recurring/subtasks/progress; projects as entities; saved views/swimlanes/Gantt; CSV; estimates/time‑tracking.
**Effort:** L (~8–12d for the 4 P0s). **Regression:** LOW (validation/optimistic/batching/scoped broadcast), MED (pagination contract + 409 handling), HIGHER (multi‑assignee ripples).

## Files — 5.5 prod / 3 ent — ship‑with‑P0‑fixes
**Solid:** streaming 2GB pipeline (no OOM), IDOR‑guarded (`permissionFor`), upload/download/share/soft‑delete work.
**P0:** restore/recycle‑bin (make soft‑delete + retained blobs meaningful); server pagination; virus scanning on upload; GC/retention job for soft‑deleted S3 objects (pattern exists for recordings/e2ee/telemetry); delete confirmation + undo.
**P1:** audit downloads + link fetches; folder hierarchy + rename/move/copy; storage quota; surface upload progress; multi‑file + drag‑in; server‑side search; pass actorId to `remove()`; MIME allow‑list; link expiry/password; **wire the existing desktop drag‑out/Save‑as/reveal IPC into FilesView** (currently only on chat attachments).
**P2:** versions; checksum dedup; file locking; in‑app preview; file comments; DLP.
**Effort:** L (~7–10d P0 set). **Regression:** LOW (restore/confirm/multi‑upload/desktop‑wire/audit), MED (pagination → `searchService.ts` Files index; GC window), HIGHER (folders + versions). **Preserve the streaming pipeline + permissionFor + the E2EE‑stamp on upload.**

---

## Cross‑module workflow validation
- **Task → reminder → notify → complete → sync:** **BROKEN** — no task↔reminder link exists at all; task due dates fire nothing.
- **File upload → preview → share → download → version → restore → audit:** **PARTIAL** — upload/share/download work; preview, versioning, restore, and download‑audit all missing.
- **Reminder → desktop notification → click → open → complete → sync:** **PARTIAL** — firing is solid, deep‑link is broken on every surface.

## Scale cliffs
Files + Reminders lists **fully unbounded**; Tasks **silently truncates at 2000**; `TASK_CHANGED` is a **global broadcast** (Reminders/Files correctly scope — a real parity inconsistency); focus/visibility reconcile refetches conversations only, so a missed `*_CHANGED` while backgrounded leaves Tasks/Reminders/Files stale.

## Recommended implementation order (all cost‑free, none touch calls/E2EE)
1. **Server pagination across all three** (the shared scale anti‑pattern) — biggest, most repeated win.
2. **Tasks ship‑blockers** — version/409/live‑merge + scoped broadcast.
3. **Reminders notification routing + actions + quiet‑hours gate + double‑spawn dedupe.**
4. **Server‑side validation** (Tasks + Reminders enums).
5. **Files restore/recycle‑bin + GC + virus‑scan + delete‑confirm.**
6. **Task‑due firing** (reuse the reminder scheduler).
7. Then P1s (multi‑assignee, folders, snooze, wire desktop IPC into Files…).
