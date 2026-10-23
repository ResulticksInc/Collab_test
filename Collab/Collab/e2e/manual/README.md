# Manual end-to-end checks

Regression checks for defects that unit tests could not have caught, because each
one needed a **real browser, a real second participant, or real media**.

These are deliberately **not** `*.spec.ts`: Playwright's default glob only
collects `*.spec.ts` / `*.test.ts`, so `npm run test:e2e` will not pick them up
and cannot be broken by them. They need a running stack, so they are run by hand.

## Running them

Bring the stack up first, then point `BASE` at it (`SOCK` only matters for the
mention-hardening check, which talks to the socket directly):

```bash
docker compose up -d --build backend frontend
BASE=http://localhost:3003 SOCK=http://localhost:4000 node e2e/manual/verify_muteall.mjs
```

Each script creates its own throwaway accounts and prints `N passed, M failed`.

If signup starts failing, the in-memory rate limiter has tripped:
`docker compose restart backend` clears it.

## What each one pins down

| Script | Defect it guards |
|---|---|
| `verify_orphan_date_pill.mjs` | Orphan date separator — a "Monday 24 Aug" pill with nothing under it. Date pills were computed over the RAW message list, but some rows render as null (ended/expired meeting-invite cards the client suppresses, album continuations, hidden legacy system lines) — a day whose only occupant is invisible left a bare pill. Browser check with a PLANTED backdated expired invite (direct SQL — the API can't backdate): asserts every rendered pill has a message under it, the suppressed day shows no pill, and real days keep theirs. Sensitivity: stashing the fix reproduces the field screenshot exactly (`orphans:["Monday 24 Aug"]`). |
| `verify_temp_group_order.mjs` | "Group chats are still at the top" — the auto-created call temp group was hard-pinned above every chat by a temporary-first tier in the sidebar sort, for its whole 7-day life. Browser check (needs frontend + backend): creates the temp group via `/temp-from-session`, lands newer activity in a DM, and asserts the DM renders ABOVE the group in the rail. Sensitivity demonstrated: restoring the pinned sort makes exactly this assertion fail (`["Order Alice + Order Bob","Order Bob"]` vs the fixed order). |
| `verify_leave_confirm.mjs` | Confirm-before-exit for meetings AND calls. Every exit path in the shared `LeaveControl` (participant Leave, host Leave, End, End for everyone) now opens an app-styled confirmation ("Leave this meeting?" / "…call?", "End … for everyone?") with a Stay option; the action fires only on explicit confirm, guarded against double-invoke. Browser check: prompt appears on Leave, Stay keeps you in, confirming Leave exits. |
| `verify_favorites.mjs` | File favorites — the "favourites are not stable" field report. Pure REST (needs S3/MinIO for the upload). Root cause it pins: `files.starred` was one GLOBAL flag with an owner-only setStar gate — starring your own uploads worked, starring a file shared WITH you 404'd and the optimistic star silently reverted, and one member's star appeared in every member's Favorites tab. After migration 0114 (per-user `file_stars`): a member stars a shared file (200), tabs and row `starred` flags are strictly per-viewer, un-starring never touches anyone else, and no-access users still get 404. |
| `verify_link_joiner_history.mjs` | §11 Q4 / MCHAT-21 history policy. Pure REST. Under the default `MEETING_LINK_JOINER_HISTORY=joinpoint`, an UNINVITED link-joiner is added to the meeting chat on room entry but reads from their join forward (per-member `history_visible_from` cutoff, enforced at read time), can post, and never sees pre-join messages — while invited members keep the full thread. The subtle regression it pins: `enterRoom` upserts every entrant as an "accepted" attendee, so a naive invited-vs-joined check is impossible post-hoc — the cutoff must be stamped from a PRE-session membership snapshot. `=full` flips the policy without a code change. |
| `verify_telemetry.mjs` | Cross-cutting usage telemetry (§9.2). Pure REST. The counter pipeline end to end: anonymous client batches via `POST /api/telemetry/events` (strict name vocabulary — junk/script names silently dropped; batches capped at 50), per-day aggregates with NO user dimension behind an authed GET, and server-side counters riding the real flows (recurrence pattern distribution on create, the reschedule/cancel occurrence-vs-series split). Client-side events (view switches, pin/spotlight, pop-out path taken, mute latency buckets, mic re-acquisition, chat pill/pagination taps) use the same endpoint via `trackEvent`. |
| `verify_recurrence.mjs` | Recurring meetings (§8). Pure REST. Headline: RCR-22 "this and all following" splits the series — the past keeps its schedule (rule truncated to the day before), the future is a new series carrying the edit with an "after N" count reduced by the consumed occurrences, per-occurrence exceptions PARTITION at the split, attendees carry over, and both series share the ONE meeting chat. Also: the 730-occurrence / 5-year horizon rejections (RCR-03), monthly day-31 clamp-vs-skip short-month handling with validation (RCR-04), the server-computed next-dates preview endpoint (RCR-05), and ending a series early leaves no future occurrences while chat history stands (RCR-27 — this exposed a fallback that resurrected the anchor of any ENDED series onto the calendar forever). |
| `verify_reschedule_cancel.mjs` | Reschedule & cancel + recurrence exceptions (§7/§8). Pure REST. The headline regression it pins: "This event only" silently rewrote the whole series (`occurrenceScope` was sent and read by nothing). Asserts: a single-occurrence edit writes an override — siblings and the series anchor untouched, occurrence flagged `isException` (RSCH-02/RCR-20/21); past-occurrence edits rejected (RSCH-08); RSVP resets only on time changes (RSCH-04); a series edit KEEPS the exception (RSCH-09 default); "moved this meeting" chat trace (RSCH-10); ICS carries a bumped SEQUENCE, the structured RRULE (FREQ/BYDAY/COUNT), METHOD:REQUEST→CANCEL and EXDATEs (RSCH-06/CNCL-03/RCR-23); occurrence-scope cancel excludes one occurrence only (CNCL-01/RCR-23); after a series cancel the join is closed but the chat stays writable (CNCL-04/05); both cancels + reschedules audit-logged with scope (CNCL-08). |
| `verify_recording.mjs` | Meeting recording (§6). Pure REST — no browser, no SFU, but needs S3 (a throwaway MinIO works: `S3_ENDPOINT=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=…` on the backend). Exercises the client-recording upload path: host-gated save (REC-01), ready row + member-only list/stream with outsider 403s (REC-11), audit rows for upload/download/delete (REC-11/12), the attendance report posting to the meeting chat at completion with both attendees named (REC-15), and host-only delete. |
| `verify_meeting_chat.mjs` | Meeting-linked group chat (§5). Pure REST + socket — no browser, no SFU; `BASE` points at the BACKEND directly (default `http://localhost:4010`). Asserts the ONE persistent meeting group end to end: created at scheduling with host + invitees as members (MCHAT-01/20), named from the subject and renamed with the meeting (MCHAT-03), persistent — not a temp group, still writable after the meeting (MCHAT-04), an occurrence divider at session start (MCHAT-05), an uninvited link joiner added on room entry (MCHAT-21), in-meeting socket chat mirrored into the thread LIVE with no duplicate from the end-of-meeting back-fill (MCHAT-10), a "Meeting ended" trace (MCHAT-12), and mid-flight invitees gaining membership. |
| `verify_newest_at_top.mjs` | Chat ordering — newest at top (§4, D-3(b)). Alice flips the per-user setting; Bob/Carol feed messages over REST, delivered live over the socket. Asserts the default stays newest-at-bottom, descending render with the newest visible without scrolling (ORD-01), no scroll jump on live arrival + the upward "new messages" pill (ORD-03/04), Load-earlier at the BOTTOM appending older rows without a jump (ORD-05), the unread divider latched at the unread/read boundary (ORD-08 — needs the unread to arrive while viewing another thread; opening via deep link marks read first), grouping across descending order (ORD-10), and own-send visibility (ORD-12). No SFU needed. Caveat: measure scroll anchors AFTER letting Playwright scroll the click target into view — its auto-scroll reads as a false jump. |
| `verify_views.mjs` | Meeting stage views (§1). THREE real participants on a real SFU. Asserts gallery default (VIEW-01), speaker view railing + persistence (VIEW-03/07), per-participant isolation (VIEW-06), local multi-pin (VIEW-08), the full spotlight lifecycle (VIEW-09: organizer-only control, forced layout for everyone with the pin retained but hidden, "Spotlighted by X" banner, per-viewer "Return to my view", late-joiner re-announce over the data channel, removal releasing everyone), SR announcements (VIEW-11), and content-share promote/return (VIEW-22/23). Same local-LiveKit + headed requirements as `verify_popout.mjs`. |
| `verify_popout.mjs` | Screen-share pop out (POP-01…POP-10). Host + guest in a real meeting on a real SFU: host shares a tab (auto-selected by title — a dedicated `ShareTarget` tab, since LiveKit excludes the sharer's own tab); guest pops the share out via Document PiP. Asserts the placeholder + live thumbnail + "Bring back" (POP-04/05), the header's Minimize/Maximize controls + resize capability (POP-02 — actual resizes need a human gesture inside the PiP window), re-click focuses instead of duplicating, the OWN-share button is inert with an explanation (POP-08), leaving closes pop-outs (POP-10), and the presenter stopping auto-closes the pop-out with a "sharing ended" toast (§2 acceptance). Needs a LOCAL LiveKit (`LIVEKIT_WS_URL` must not point at production) and runs headed — Document PiP needs a window manager. |
| `verify_muteall.mjs` | "Mute everyone" reported success while muting nobody. Two real participants via Chrome fake media devices: asserts the server actually muted a track, the muted user's dock toggle flips to Unmute, their own tile badge appears, they are told why, and the host's roster shows them muted. |
| `verify_voice.mjs` | Voice notes in an E2EE chat would not play — ciphertext was handed to `<audio>`. Records and sends a real voice message, confirms the server stored it `encrypted: true`, then plays it back **as the recipient** and asserts `currentTime` actually advances. |
| `repro_mention_ui.mjs` | @mention landed on the wrong person. Two group members share the first name "Aravinth"; picks the second from the composer and asserts exactly he is notified and the other is not. |
| `verify_mention_hardening.mjs` | Security/privacy of the id-based mention path: a non-member id claimed by a client is rejected, the sender is never self-notified, an encrypted mention stores no plaintext excerpt, and mentions are delivered in DMs, groups and channels. |

## Why these exist

Two of these defects reached production and stayed there undetected, and during
the session that fixed them two "verified" claims turned out to be **vacuous** —
the tests passed identically with and without the fix.

So the bar here is sensitivity, not green ticks: **a check is only worth keeping
if it fails when its fix is removed.** That was demonstrated for the voice check
(disable the `decryptBlob` call in `VoicePlayer.tsx` and it fails with
`MediaError code 4`, `readyState 0`) and for the mention check (0/0 notifications
before the fix, 1/0 after). If you change any of this code, re-check that the
relevant script still fails without your change before trusting it.
