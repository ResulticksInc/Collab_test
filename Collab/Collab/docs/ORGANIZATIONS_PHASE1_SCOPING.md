# Organizations Phase 1 — Tenant Scoping Checklist

**Status:** mechanism built + verified; module scoping in progress.
**Design:** `ORGANIZATIONS_ARCHITECTURE.md` + `_ADDENDUM.md`. Phase 0 (schema/seed/backfill) is done (migration `0068`).

## The mechanism (built — commit `2b46b2c`)

Org context is **ambient**, not threaded. `database/src/orgContext.ts` holds an
`AsyncLocalStorage`; the auth middleware runs each request inside
`orgContext.run({ orgId }, () => next())`. So **any driver query reads the active tenant
via `currentOrgId()`** — no route/service/method signature changes (avoids the
`getById`-called-internally ripple). Outside a request (cron / firing sweeps)
`currentOrgId()` is `null` → those global scans stay unscoped **by design**.

### The 2-line scoping pattern (apply to every DIRECT read/write below)

```ts
const orgId = currentOrgId();
const orgClause = orgId ? " AND <alias>.organization_id = $N" : ""; // $N = next positional
// ...append ${orgClause} to the WHERE; params: orgId ? [...args, orgId] : [...args]
```
Conditional so a NULL-org (legacy) session keeps prior behavior and single-tenant data
is a no-op. For dynamic-param builders: `params.push(orgId)` then reference `$${params.length}`.

## ⚠️ Ordering (learned the hard way — a call test caught it)

**Do each module as a UNIT: stamp the INSERTs FIRST (or in the same commit as) scoping
the reads.** A read‑scope (`getById` with `AND organization_id=?`) filters on a column the
paired `create` must set — if you scope the read but the create still writes NULL org, a
freshly‑created row is INVISIBLE to the read (e.g. "call not found"). Scoping keystone
by‑id reads across modules *without* their create‑stamps broke `calls-signalling.test.ts`.
So: **per module** — stamp create(s) → scope getById → scope lists/writes → **run that
module's tests** (esp. `calls-signalling` for calls, firing tests for reminders/tasks) →
only then move on. Never scope a read whose writer isn't stamped in the same change.

## ⚠️ Cross-user rule (a call test caught it — twice)

**Do NOT org-scope `getById` for CROSS-USER entities: calls + invites.** A 1:1 call or a
connection request spans two users whose active org can differ, so filtering the read by
the *fetcher's* org 404s a legitimate participant. Access to these is gated by the
participant / recipient membership check, NOT org. Still **stamp org at create** (the row
carries a correct org for lists/analytics). This applies to any entity two different-org
users can both touch. Single-owner/member entities (tasks, reminders, files, conversations,
meetings) DO scope `getById`.

## Isolation CORE — DONE (verified, all 129 backend tests pass)

Two things were security-critical: (1) close every confirmed cross-tenant READ
leak, (2) make sure no new row is born NULL-org. Both are complete.

**Read leaks closed** (org-scoped by-id + search):
- Search (all 6 domains) — `messages/tasks/reminders/meetings/users.search` (`563aadf`, `819bf24`).
- Keystone by-id — `conversations.getById`, `messages.getById`, `tasks.getById`,
  `meetings.getById`, `reminders.getOne` (+ conversations findByDmKey/findDmBetween/listForUser).
- Cross-user by-id LEFT UNSCOPED **on purpose** (see rule above) — `calls.getById`,
  `invites.getById`, `files.getMeta`, `user_blocks`/`user_reports` reads.

**Create-stamps — COMPLETE** (every DIRECT + INHERIT org table): conversations,
messages, tasks (+ assignees/watchers/activity/comments/bulkLog), task_projects,
folders, reminders (+ spawnNextOccurrence with source-org passthrough for the fire
tick), files, meetings, calls (+ requestAtomic), notifications, invites, user_blocks,
user_reports. `scheduled_messages` intentionally skipped (no org column in 0068).
Commits `768d66e` `d9556ed` `fc91a28` `<reminders>` `<finish-stamps>`.

## Boundary SWEEP — DONE (multi-tenant build, 2026-07-02)

Driving toward Teams/Slack/Jira-grade multi-tenancy, the full list/count/write sweep
is now applied via the `orgFilter(baseParams, col)` driver helper (conditional org
predicate, auto-numbered positional param; null-org → no clause; single-tenant → no-op).
**51 of 59 audited methods scoped** — reminders, folders, notifications, taskProjects,
meetings, files (list/write; public by-id/token reads left cross-user), tasks. Every
batch kept all 129 backend tests green. Commits: reminders/folders, notifications/
taskProjects, meetings, files, tasks.

**The remaining 8 are CROSS-USER (calls 4, invites 2, blocks 2)** — access is
relationship-gated (participant/recipient), not org-gated, so they are NOT scoped;
they get a guard EXEMPTION at flip time. Plan for `COLAB_ORG_GUARD` default-on:
remove `calls`/`invites`/`user_blocks`/`user_reports` from `ORG_DIRECT_TABLES` (fully
cross-user — nothing to enforce), and comment-tag the few legitimately-global/cross-user
queries on still-policed tables (files.getMeta/getData/getByToken/getDeletedMeta/
gcClaimStillValid + the firing/maintenance sweeps that reach a DIRECT table through q()).

## Deliberately DEFERRED — guard prod-on + NOT NULL (bundle with multi-org activation)

The remaining `listForUser`/`countForUser`/`update`/`remove` reads are **already
user- or membership-scoped**, so single-tenant today they leak nothing. Adding
`AND organization_id=?` to them is a MULTI-ORG feature, and turning it on before a
`0069` migration makes `organization_id` NOT NULL opens a transition gap: a row
created by a still-logged-in pre-org token (currentOrgId()=null → NULL-org) would be
invisible to an org-scoped read. So the correct enterprise sequencing is:

1. Ship the isolation core (done) — safe for the live single-tenant deploy now.
2. When activating multi-org (Phase 3 org-switcher): run `0069` (backfill any
   NULL-org → NOT NULL + FKs), THEN sweep lists/counts/writes with the 2-line
   pattern (`countForUser` MUST mirror `listForUser`), exempt the firing scans,
   flip `COLAB_ORG_GUARD` default-on, and verify each module under an org-session
   AND a NULL-org session.

Doing the sweep now would be a no-op for single-tenant AND risk that gap — so it
waits for the migration that closes the gap. `COLAB_ORG_GUARD=1` opt-in still works
for testing any module you scope early.

### Audited deferred inventory (5-agent completeness audit, 2026-07-02)

**59 list/count/write methods** on DIRECT tables still need the 2-line org clause
(they will throw once the guard flips on): meetings 6, folders 3, reminders 11,
tasks 15, taskProjects 3, invites 2, calls 4, notifications 5, files 8, blocks 2
(user_blocks+user_reports). Plus a few by-id **write-then-readback** reads that get
scoped as part of their write method: `meetings.update/setStatus/removeAttendee`,
`tasks.update`, and the `tasks.isAncestorOf` parent-walk.

**Guard-exempt at flip time** (run with no request → `currentOrgId()` null, global by
design): the firing sweeps (`reminders.claimDue`, `tasks.claimDueTasks`,
`meetings.withReminderLead`, `calls.findStaleRinging`, `meetings.claimReminderOccurrence`)
+ `calls.requestAtomic` busy-check + the maintenance sweeps `reminders.pruneOldOccurrences`,
`files.claimForGc`, `files.hardDelete`. Note `calls.hasActiveCall` uses `SELECT 1 FROM calls`
which the detector's `^select 1` probe rule already exempts.

**Surfaces:** only ONE driver (mysql.ts — the "in-memory driver" comment is stale);
NO raw org-table writes outside the driver (health/remoteControl/debug use `db.pool`
but touch no org table); sockets are `conv:<id>`/`user:<id>`/`meeting:<id>` — NOT
org-namespaced (realtime isolation is membership/host authz today). Create-stamps are
now 100% (the audit found + we fixed the last 4: task_assignees/watchers mutation
paths + audit_log).

## To scope (DIRECT reads/writes — driver `database/src/drivers/mysql.ts`)

> Line numbers below are from the discovery pass and have since drifted — locate by
> method name / query text. Each is a 2-line `currentOrgId()` + `orgClause` edit.

- **Keystone by-id (do next — collapses cross-tenant access):** `tasks.getById`,
  `meetings.getById`, `calls.getById`, `invites.getById`, `reminders.getOne`, `files.getMeta`.
- **messaging:** `conversations` findByDmKey, findDmBetween, listForUser, update, setKind,
  remove (+ its files UPDATE); `messages` listForConversation, thread, listPinned,
  toggleReaction, update, remove, pin, unpin.
- **tasks:** `tasks` listForUser, countForUser (keep identical!), list, update, remove,
  bulkPatch, bulkRemove, subtasks, subtaskProgressFor, isAncestorOf, listAllForUser,
  listForUserPage, bulkSetProjectText; `task_activity.activity`, `task_comments.comments`/
  removeComment, `task_assignees` assignees/assigneesFor, `task_watchers` watchers/watchersFor;
  `task_projects` listForUser, getForUser, update, delete (+ its tasks UPDATE).
- **reminders/folders:** `folders` listForUser, rename, delete (+ reminders UPDATE);
  `reminders` listForUser, countForUser, countsForUser, toggle, setStatus, update, delete,
  rearm, recurringDueAmong, bulkPatch, bulkRemove.
- **files:** listForUser, countForUser (identical!), listDeleted, listAllForIndex,
  getDeletedMeta, restore, setShareToken, setStar, remove.
- **meetings/calls:** `meetings` listForUser, update, remove, setStatus, setLobbyEnabled,
  setLocked; `calls` listForUser, setStatus, end, hasActiveCall, listActiveForUser.
- **notif/invites/blocks:** `notifications` listForUser, unreadCount, markRead, markAllRead,
  remove; `invites` setStatus, listForUser, findBetween; `user_blocks` unblock, listBlocked;
  `user_reports` listReports, removeReport.

## INSERT stamps (guard-EXEMPT but MANDATORY — else rows are born NULL-org and get dropped by predicates)

Add `organization_id` column + value to every create: `conversations.create` (req.org),
`messages.create` (parent conv org), `tasks.create`/spawnNext (req.org / source task),
`task_projects.create`, task child inserts (parent task org), `folders.create`,
`reminders.create`/spawnNext, `files.create`, `meetings.create`, `calls.requestAtomic`
INSERT (conversation org), `notifications.create` (**triggering entity's** org, NOT the
recipient session — the scheduler path has no `req`), `invites.create`, `user_blocks.block`,
`user_reports.report`. Also expose `organizationId` on `mapRem`/`mapMtg`/`mapCall` so spawn
paths inherit parent org.

## Do NOT touch (would break firing / calls — 6 call tests + firing tests guard these)

- Firing sweeps `FOR UPDATE SKIP LOCKED`: `reminders.claimDue`, `tasks.claimDueTasks`,
  `meetings.withReminderLead`, `calls.findStaleRinging` — stay GLOBAL (exactly-once cross-tenant
  firing); org travels via the claimed row's own `organization_id`.
- `calls.requestAtomic` busy-check `FOR UPDATE` — stays unscoped (glare/busy across contexts);
  only the INSERT stamps org.
- Call/meeting state-machine transitions + LiveKit token flow — only add predicates to reads.

## Guard-on sequence (`COLAB_ORG_GUARD` default-on in non-prod)

The q() tripwire (`unscopedOrgTable`) throws on an unscoped DIRECT SELECT/UPDATE/DELETE.
Per module: scope reads/writes → stamp inserts → exempt the legitimately-global `q()` worker
scans (`withReminderLead`, `findStaleRinging`, `claimDueTasks`, `hardDelete`, `pruneOldOccurrences`)
→ run the module's routes with `COLAB_ORG_GUARD=1` under both an org-session and a NULL-org
session (green = every DIRECT query on that module carries the predicate). Flip default-on only
after all six modules pass.
