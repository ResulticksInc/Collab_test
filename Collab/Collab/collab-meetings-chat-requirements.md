# Collab — Meetings, Calling and Chat Enhancements
## Product Requirements · v1.0 · September 1, 2026

**Scope:** seven feature areas — meeting stage views, screen-share pop out, mic/camera mute integrity on 1:1 calls, chat message ordering, meeting-linked group chat, meeting recording, and scheduling operations (reschedule, cancel, recurrence).

**Out of scope for this release:** telephony/PSTN dial-in, breakout rooms, live captions translation, webinar/town-hall formats, room-system (SIP) join, e-discovery export.

**Convention:** requirement IDs are stable and Jira-ready. `[M]` = must have, `[S]` = should have, `[C]` = could have. Anything marked **Assumption** or **Needs validation** is not a settled fact and must be confirmed before build.

---

## 0. Decisions required before build

These change scope materially. Each has a recommendation, but the call is yours.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D-1 | Hard mute vs soft mute | (a) Stop capture entirely — nothing recorded, no "you're muted" speech detection possible; (b) keep capture, discard locally — detection possible | (a) hard mute, per your requirement. Offer speech-while-muted detection as an opt-in setting that runs locally only |
| D-2 | Camera off behavior | (a) Release the camera so the hardware LED turns off; (b) keep the device open, stop sending frames (faster resume) | (a) release. Users read the LED as ground truth; a lit LED while "off" is a trust incident |
| D-3 | Newest-message-at-top in chat | (a) Apply everywhere as stated; (b) apply as a user preference, default newest-at-bottom | (b). See §4 risk note — the pattern breaks reply-reading order. If (a) is firm, §4 specifies it as stated |
| D-4 | Composer position under newest-at-top | (a) Keep composer at the bottom; (b) move composer to the top, next to newest message | (b) if D-3 = (a). A bottom composer that posts to the top forces a scroll on every send |
| D-5 | Meeting chat for recurring series | (a) One chat for the whole series (Teams behavior); (b) one chat per occurrence | (a). Continuity beats isolation for standing meetings |
| D-6 | Recording ownership | (a) Organizer owns, admin retention policy applies; (b) workspace owns | Confirm with legal/compliance before build — this drives storage, sharing and retention design |

---

# 1. Meeting stage views

**Objective:** let a participant choose how the stage is composed, so the meeting adapts to what matters at that moment — faces, one speaker, or shared content.

## 1.1 View modes

| ID | Requirement | Pri |
|---|---|---|
| VIEW-01 | **Gallery view** — equal-sized tiles in a responsive grid. Default when no content is being shared and 2+ participants have video on | [M] |
| VIEW-02 | Gallery paginates when participants exceed the tile cap. Page controls show `‹ 1 of 3 ›`. Active speakers are always promoted to page 1 | [M] |
| VIEW-03 | **Speaker view** (your "participant view") — dominant speaker rendered large, remaining participants in a filmstrip along one edge | [M] |
| VIEW-04 | **Focus on content** — shared content fills the stage; participant tiles collapse to a compact filmstrip, or hide entirely at the user's choice | [M] |
| VIEW-05 | **Full screen** — stage fills the display, all chrome auto-hides after 3s of pointer inactivity and returns on movement or keypress | [M] |
| VIEW-06 | View selection is per-participant and never affects what others see | [M] |
| VIEW-07 | View selection persists for the duration of the meeting, and is remembered as the user's default for the next meeting | [S] |
| VIEW-08 | **Pin** — a participant pins up to 4 tiles for themselves only. Pinned tiles survive speaker changes and view switches | [M] |
| VIEW-09 | **Spotlight** — organizer or co-organizer forces a tile large for everyone. Max 3 spotlights. Spotlight overrides others' view choice with a visible "Spotlighted by Marcus" label and a "Return to my view" escape | [S] |
| VIEW-10 | Hide non-video participants — audio-only participants collapse into a single overflow chip showing count and names on hover | [S] |
| VIEW-11 | Screen reader announces the active view and any forced change ("Spotlight applied. Emily Carter is now the main view.") | [M] |

## 1.2 Layout and switching behavior

| ID | Requirement | Pri |
|---|---|---|
| VIEW-20 | Tile cap per page is device-tier dependent, not fixed. **Recommended targets — needs validation on real hardware:** desktop 49, laptop 25, tablet 9, mobile 4 | [M] |
| VIEW-21 | Dominant-speaker switching is debounced. **Recommended:** promote only after 2s of continuous dominance; ignore bursts under 500ms | [M] |
| VIEW-22 | When content sharing starts, the stage auto-switches to Focus on content unless the user has manually chosen a view during the current sharing session | [M] |
| VIEW-23 | When sharing stops, the stage returns to the view in effect before sharing began | [M] |
| VIEW-24 | Tiles preserve source aspect ratio; fill-to-crop is a user preference, never the silent default | [S] |
| VIEW-25 | Only tiles visible on the current page are decoded. Off-page and hidden tiles are unsubscribed at the SFU to save bandwidth and CPU | [M] |
| VIEW-26 | Tile ordering is deterministic and stable — you (self-view), then spotlighted, then pinned, then video-on by recent speaking order, then audio-only. Tiles never reshuffle for a reason the user can't see | [M] |
| VIEW-27 | Self-view can be minimized, hidden, or detached; hiding self-view does not stop the outgoing video stream, and the UI says so | [S] |
| VIEW-28 | View switch renders within **300ms** (recommended target) with no black frame or audio interruption | [M] |

## 1.3 Acceptance criteria (sample)

- **Given** 12 participants with video on and no content shared, **when** I open the meeting, **then** Gallery view is active with all 12 tiles equally sized and no pagination on desktop.
- **Given** Focus on content is active, **when** the presenter stops sharing, **then** the stage returns to my previous view within 300ms with no reconnect.
- **Given** the organizer spotlights Michael, **when** I had pinned Emily, **then** Michael's spotlight applies, Emily's pin is retained but not shown, and a "Return to my view" control is visible.
- **Given** I am on Gallery page 2, **when** a participant on page 1 starts speaking, **then** they are not force-scrolled into my view; the page-1 indicator shows an active-speaker dot instead.

---

# 2. Screen share — pop out

**Objective:** let a viewer detach shared content into its own window so it can sit on a second monitor while the meeting stage stays available.

| ID | Requirement | Pri |
|---|---|---|
| POP-01 | A **Pop out** control appears on the shared-content surface for every viewer, and on individual participant tiles | [M] |
| POP-02 | The popped-out window is resizable, movable across monitors, and independently maximizable | [M] |
| POP-03 | Audio remains in the main meeting window. Popping out never renegotiates or drops the audio session | [M] |
| POP-04 | While content is popped out, the main window shows a placeholder in the content area with a "Bring back" control and a live thumbnail | [M] |
| POP-05 | Closing the popped-out window returns content to the main stage in the previously active view | [M] |
| POP-06 | Multiple simultaneous pop-outs are supported. **Recommended cap: 3**, to protect decode budget | [S] |
| POP-07 | **Always on top** is an option in the popped-out window, off by default | [S] |
| POP-08 | Loop prevention — if a user is sharing the same display that contains their own popped-out window, the pop-out is suppressed with an inline explanation, rather than producing recursive mirroring | [M] |
| POP-09 | Popped-out windows carry minimal controls: participant name, mute-state indicator, pin, always-on-top, close. No meeting-wide destructive controls (end meeting, remove participant) | [M] |
| POP-10 | On leaving or ending the meeting, all popped-out windows close automatically | [M] |
| POP-11 | Window position and size are remembered per monitor for the next pop-out in the same session | [C] |

**Platform behavior**
- Desktop app: native secondary window. Full requirement set applies.
- Chromium browsers: Document Picture-in-Picture, which supports POP-01 to POP-05 and POP-10. **Needs validation:** always-on-top is browser-controlled, not app-controlled.
- Browsers without Document PiP: fall back to video-only PiP with reduced controls, or open in a new tab. The UI must state which capability is available rather than showing a control that silently degrades.
- Mobile: out of scope this release.

**Acceptance criteria (sample)**
- **Given** Emily is sharing her screen, **when** I pop out the content and drag it to my second monitor, **then** the content renders at source resolution, audio stays uninterrupted in the main window, and the main window shows the placeholder with a live thumbnail.
- **Given** I have content popped out, **when** the presenter stops sharing, **then** the popped-out window closes and a "Sharing ended" toast appears in the main window.

---

# 3. Mic and camera state integrity (1:1 and group)

**Objective:** mute means nothing is captured, unmute always works, and the state survives everything the network and the operating system do to a call. This is a trust feature — it is graded on worst-case behavior, not average.

## 3.1 Mute semantics

| ID | Requirement | Pri |
|---|---|---|
| MIC-01 | Mute stops audio capture at the source. The track is disabled **and** publishing stops, so no audio frames are encoded or transmitted | [M] |
| MIC-02 | Server-side enforcement — the SFU drops any audio packets from a participant whose server-side state is muted, so a client bug cannot leak audio | [M] |
| MIC-03 | The client holds a single mute-intent state. UI reflects intent immediately, then reconciles with the server; if reconciliation fails, the UI reverts and surfaces the failure rather than showing a false state | [M] |
| MIC-04 | Mute state is re-applied **before** media is published on every reconnect, ICE restart, network switch (Wi-Fi ↔ cellular ↔ ethernet), or device change | [M] |
| MIC-05 | Mute state survives: audio-only → video upgrade, screen-share start/stop, participant promotion, moving between pop-out and main window, and app backgrounding | [M] |
| MIC-06 | Camera off follows the same rules: capture is released so the hardware indicator turns off (D-2), and no frames are transmitted | [M] |
| MIC-07 | Hardware mute (headset button, keyboard mute key) syncs bidirectionally with the in-app state where the OS exposes it. **Needs validation per platform** | [S] |
| MIC-08 | Speech-while-muted detection is opt-in only, processes locally, transmits nothing, and is unavailable when hard mute is active (D-1) | [C] |
| MIC-09 | Organizer mute of a participant sets server-side state; the participant can unmute themselves unless "prevent unmute" is applied. Both actions are logged | [S] |

## 3.2 Device and stability handling

| ID | Requirement | Pri |
|---|---|---|
| MIC-20 | Default input device is resolved at call start; if it disappears mid-call, the client falls back to the next available device **and preserves mute state** — a fallback never unmutes anyone | [M] |
| MIC-21 | Device hot-plug (headset connect/disconnect, Bluetooth switch) completes without dropping the call. **Recommended target: audio resumes within 2s** | [M] |
| MIC-22 | Audio track health is monitored. If the track ends unexpectedly, the client re-acquires it automatically and shows a transient "Reconnecting your microphone" indicator | [M] |
| MIC-23 | On sustained failure to acquire audio (recommended: 3 attempts over 10s), show a recovery panel with device picker and permission guidance — never a silent dead mic | [M] |
| MIC-24 | Permission revoked mid-call is detected within 2s and surfaced with a direct route to OS/browser settings | [M] |
| MIC-25 | Echo cancellation, noise suppression and auto gain are on by default and independently toggleable; changing them does not restart the call | [S] |
| MIC-26 | Pre-join device check: input level meter, output test tone, camera preview, and the same mute state that will apply on join | [M] |
| MIC-27 | In-call diagnostics panel shows current input device, sample rate, packet loss, jitter and round-trip time, with a one-click "Send diagnostics" | [S] |

## 3.3 Acceptance criteria

- **Given** I am muted on a 1:1 call, **when** the WebRTC stats are inspected, **then** outbound audio packets are zero for the entire muted period.
- **Given** I am muted, **when** my network switches from Wi-Fi to cellular and the session re-establishes, **then** I remain muted, and the same holds for 3 consecutive reconnects.
- **Given** my camera is off, **when** I check the device, **then** the hardware indicator light is off.
- **Given** I unplug my headset mid-call while unmuted, **when** audio falls back to the built-in mic, **then** the call continues and my unmuted state is preserved and announced ("Switched to MacBook Pro Microphone").
- **Given** I am muted and the app is backgrounded for 10 minutes, **when** I return, **then** I am still muted and the mic indicator is accurate.

## 3.4 Non-functional targets (recommended — needs validation)

| Metric | Target |
|---|---|
| Mute/unmute state applied end-to-end | < 200ms |
| Media resume after device change | < 2s |
| Media resume after network switch | < 5s |
| Mute-state divergence between client UI and server | 0 tolerated defects — treat as Sev-1 |
| 1:1 call drop rate | < 0.5% of calls |

---

# 4. Chat ordering — newest at top

**Objective (as stated):** newest messages appear at the top of the message pane, older messages below, in both direct and group chats.

> **Risk note, flagged once and then specified as asked.** Reverse-chronological breaks reading order for conversations: a reply appears above the message it answers, so quoted replies and multi-message thoughts read backwards. Every major messaging product uses newest-at-bottom for this reason. My recommendation is D-3(b) — ship it as a user preference with newest-at-bottom as the default, which costs roughly the same to build and lets you measure adoption. The requirements below hold either way.

| ID | Requirement | Pri |
|---|---|---|
| ORD-01 | Message pane renders newest first, descending by server timestamp, identically for direct chats, group chats and meeting chats | [M] |
| ORD-02 | Ordering is server-authoritative and identical on every device and platform for the same conversation | [M] |
| ORD-03 | A newly received or sent message inserts at the top with a brief highlight; the pane does not jump if the user is scrolled down reading history | [M] |
| ORD-04 | When the user is scrolled away from the top and a message arrives, show a "New messages ↑" pill that returns to the top on tap | [M] |
| ORD-05 | Pagination loads **older** messages as the user scrolls **down**, in pages of 50, with a skeleton loader and no scroll-position jump | [M] |
| ORD-06 | Date separators read in descending order ("Today" at the top, then "Yesterday", then earlier dates) and remain sticky while scrolling | [M] |
| ORD-07 | Within a single day, messages are strictly descending by timestamp; ties broken by server sequence ID, never by client clock | [M] |
| ORD-08 | The unread divider sits at the boundary between unread and read messages and is stable — it does not move while the user is reading | [M] |
| ORD-09 | Replies show an inline quoted preview of the parent message, since the parent now sits below the reply. Tapping the preview scrolls to the parent and highlights it | [M] |
| ORD-10 | Consecutive-message grouping (same sender within 2 minutes) still applies, with the avatar and timestamp on the topmost message of the group | [M] |
| ORD-11 | Search results, pinned messages and deep links all resolve to the correct position in the descending order and highlight the target | [M] |
| ORD-12 | Composer placement follows D-4; if the composer stays at the bottom, sending must not force a scroll to see your own message | [M] |
| ORD-13 | Read receipts, edits, deletions and reactions update in place without reordering the list | [M] |
| ORD-14 | Conversation-list ordering (left pane) is unchanged — most recent activity first | [M] |
| ORD-15 | Export and print of a conversation follow chronological (oldest-first) order regardless of the display setting | [S] |

**Acceptance criteria (sample)**
- **Given** a group chat with 500 messages, **when** I open it, **then** the newest message is at the top and visible without scrolling, and the first 50 messages load in under 1s.
- **Given** I am scrolled 200 messages down, **when** three new messages arrive, **then** my scroll position does not move and a "New messages ↑" pill shows the count.
- **Given** message B replies to message A, **when** I view the chat, **then** B appears above A with a quoted preview of A, and tapping the preview scrolls to A.

---

# 5. Meeting-linked group chat

**Objective:** every meeting has a persistent chat that captures what was said, shared and produced — available before, during and after the meeting, like Teams.

## 5.1 Creation and lifecycle

| ID | Requirement | Pri |
|---|---|---|
| MCHAT-01 | A meeting chat is created automatically when a meeting is scheduled, and is reachable from the calendar entry before the meeting starts | [M] |
| MCHAT-02 | "Meet now" / ad-hoc calls create a meeting chat on the first of: a message sent, a file shared, or the call ending with 2+ participants | [M] |
| MCHAT-03 | The chat is named from the meeting subject. Renaming the meeting renames the chat until someone renames the chat manually, after which the chat name wins | [S] |
| MCHAT-04 | The chat persists after the meeting ends. It appears in the Chat list like any other group | [M] |
| MCHAT-05 | For a recurring series, one chat spans all occurrences (D-5), with a system divider marking each occurrence: "Sprint planning · Sep 9" | [M] |
| MCHAT-06 | The chat is accessible from three entry points: the calendar item, the meeting stage (Chat panel), and the Chat list | [M] |

## 5.2 What is captured

| ID | Requirement | Pri |
|---|---|---|
| MCHAT-10 | Messages sent in the in-meeting chat panel and messages sent from the Chat list are the same thread — one message store, two surfaces | [M] |
| MCHAT-11 | Images and files shared in-meeting are stored in the chat with thumbnail preview, uploader, timestamp and size | [M] |
| MCHAT-12 | System events are captured as compact entries: meeting started/ended, participant joined/left with timestamps, recording started/stopped, sharing started/stopped by whom | [M] |
| MCHAT-13 | Recording, transcript, recap and attendance report post into the chat as cards when processing completes | [M] |
| MCHAT-14 | Reactions, replies, mentions, edits and deletions behave exactly as in a normal group chat | [M] |
| MCHAT-15 | Links shared in-meeting render with preview cards | [S] |
| MCHAT-16 | Whiteboard or notes artifacts, if present, attach to the chat | [C] |
| MCHAT-17 | In-meeting messages carry a subtle "in meeting" marker so post-meeting readers can tell live chatter from follow-up | [S] |

## 5.3 Membership and access

| ID | Requirement | Pri |
|---|---|---|
| MCHAT-20 | Invitees get chat access when the meeting is scheduled, whether or not they attend | [M] |
| MCHAT-21 | Someone who joins without an invite (via link) is added to the chat on join, and sees history from their join point forward. **Needs validation with legal** — full-history access for uninvited joiners is a policy question | [M] |
| MCHAT-22 | External guests get chat access scoped by the workspace external-access policy; if guests are restricted, the chat shows a clear notice rather than silently dropping their messages | [M] |
| MCHAT-23 | A participant removed from the meeting retains read access to messages up to the point of removal and loses posting rights | [S] |
| MCHAT-24 | Adding people to the chat after the meeting is allowed for the organizer, with a choice of "share history" or "from now on" | [S] |
| MCHAT-25 | Leaving the chat is possible for any member except the organizer; leaving does not remove them from the meeting invite | [M] |
| MCHAT-26 | The chat inherits meeting-level permissions for who can post (everyone / organizers only) | [C] |

**Acceptance criteria (sample)**
- **Given** a meeting is scheduled with 9 invitees, **when** any invitee opens the calendar item before the meeting, **then** they can post in the meeting chat.
- **Given** a recurring meeting, **when** the third occurrence ends, **then** the chat shows three occurrence dividers and each occurrence's recording card sits under its own divider.
- **Given** Emily shares an image in the in-meeting chat panel, **when** I open the chat from the Chat list two days later, **then** the image is present with preview, uploader and timestamp.

---

# 6. Meeting recording

**Objective:** organizers can record a meeting; the recording, transcript and recap land in the meeting chat automatically.

| ID | Requirement | Pri |
|---|---|---|
| REC-01 | Organizers and co-organizers can start and stop recording. Extending this to all participants is an admin policy | [M] |
| REC-02 | Recording captures active speaker video, shared content, and mixed audio. **Recommended:** content and speaker in one composed stream; separate per-participant tracks are a later phase | [M] |
| REC-03 | Every participant sees a persistent recording indicator on the stage, and a one-time consent notice on start | [M] |
| REC-04 | Participants joining after recording started see the notice on join, before their media is published | [M] |
| REC-05 | The recording notice includes a link to the workspace recording policy and, where required by region, an explicit consent action. **Needs legal validation per jurisdiction** | [M] |
| REC-06 | Recording auto-stops when the meeting ends or when the last participant leaves | [M] |
| REC-07 | Pause and resume produce a single continuous recording, not multiple files | [S] |
| REC-08 | A processing card posts to the meeting chat immediately on stop, showing status, and updates to a playable card when ready. **Recommended target: available within 15 minutes for a 60-minute meeting — needs validation** | [M] |
| REC-09 | Transcript is generated with speaker attribution and timestamps, searchable, and downloadable | [M] |
| REC-10 | The recap (decisions, action items, open questions) posts as a card and is editable by the organizer before sharing | [S] |
| REC-11 | Access defaults to meeting participants; the organizer can extend access, and every access change is audit-logged | [M] |
| REC-12 | Download is permitted per admin policy, and download events are logged | [M] |
| REC-13 | Recording storage location and retention follow the workspace admin policy (D-6). Retention changes never delete without the configured notice period | [M] |
| REC-14 | Recording failure mid-meeting alerts the person who started it, retries once, and preserves everything captured up to the failure | [M] |
| REC-15 | Attendance report (join/leave times, duration) posts to the chat for the organizer | [S] |

---

# 7. Reschedule and cancel

## 7.1 Reschedule

| ID | Requirement | Pri |
|---|---|---|
| RSCH-01 | Organizer and delegates can change date, time, duration, timezone, title, description, attendees and settings | [M] |
| RSCH-02 | For a recurring meeting, the editor asks: **this occurrence** or **this and all following** — never silently applies to the series | [M] |
| RSCH-03 | Attendees receive an update showing old value struck through and new value, plus who changed it and when | [M] |
| RSCH-04 | RSVP responses reset **only** when date, time, duration or location changes. Description, agenda and attachment edits preserve responses | [M] |
| RSCH-05 | The join link, meeting ID and meeting chat are preserved across a reschedule. All prior messages, files and recordings stay attached | [M] |
| RSCH-06 | Calendar interoperability: the update increments `SEQUENCE` and is delivered as a valid iCalendar update so Outlook and Google Calendar update in place rather than creating a duplicate | [M] |
| RSCH-07 | Conflict detection warns the organizer when the new time conflicts with a required attendee's calendar, where free/busy is available | [S] |
| RSCH-08 | Rescheduling a past or in-progress occurrence is blocked with an explanation | [M] |
| RSCH-09 | Bulk-editing an entire series when occurrences have individual exceptions prompts: keep exceptions or overwrite them. Default is keep | [M] |
| RSCH-10 | A system message posts to the meeting chat: "Marcus moved this meeting to Thursday, Sep 4, 3:00 PM" | [S] |

## 7.2 Cancel

| ID | Requirement | Pri |
|---|---|---|
| CNCL-01 | Organizer and delegates can cancel a single occurrence or an entire series, chosen explicitly | [M] |
| CNCL-02 | Cancellation requires confirmation stating exactly what will be cancelled ("Cancel all 12 remaining occurrences?") and allows an optional note to attendees | [M] |
| CNCL-03 | Attendees receive a cancellation notice; the event is removed from their calendars via a valid iCalendar cancellation | [M] |
| CNCL-04 | The join link is deactivated. Anyone attempting to join sees "This meeting was cancelled" with the organizer's note | [M] |
| CNCL-05 | The meeting chat remains accessible and readable. Members can still post follow-ups; a system message marks the cancellation | [M] |
| CNCL-06 | Recordings, transcripts and files from past occurrences are unaffected by cancelling future occurrences | [M] |
| CNCL-07 | Cancelling an in-progress meeting is not offered; the organizer ends the meeting instead | [M] |
| CNCL-08 | Cancellation is recorded in the audit log with actor, timestamp and scope | [S] |

---

# 8. Recurring meetings

**Objective:** recurring series behave predictably across timezones, exceptions and external calendars.

## 8.1 Recurrence patterns

| ID | Requirement | Pri |
|---|---|---|
| RCR-01 | Patterns: daily; every weekday; every N days; weekly on selected weekdays; every N weeks; monthly by day-of-month; monthly by ordinal weekday (e.g. third Tuesday); yearly | [M] |
| RCR-02 | End conditions: no end date; after N occurrences; on a specific date | [M] |
| RCR-03 | A maximum series horizon applies to prevent unbounded generation. **Recommended: 5 years or 730 occurrences, whichever comes first — needs validation** | [M] |
| RCR-04 | Monthly by day-of-month handles short months explicitly, with a user choice of "last day of month" or "skip". Never silently shift to the 1st of the next month | [M] |
| RCR-05 | The recurrence editor shows a plain-language summary and the next 5 computed dates before saving ("Every 2 weeks on Tuesday, until Dec 15 — next: Sep 8, Sep 22, …") | [M] |

## 8.2 Storage and time handling

| ID | Requirement | Pri |
|---|---|---|
| RCR-10 | The series is stored as a rule (RFC 5545 `RRULE`) anchored to the organizer's IANA timezone, plus `EXDATE` exclusions and per-occurrence overrides — not as a materialized list of events | [M] |
| RCR-11 | Occurrences are computed on read and rendered in each viewer's local timezone | [M] |
| RCR-12 | DST: the series keeps its **local wall-clock time** in the organizer's timezone. A 9:00 AM New York meeting stays 9:00 AM New York across the DST boundary, and attendees in other zones see their local time shift accordingly | [M] |
| RCR-13 | A DST shift that changes the time for attendees in other timezones surfaces a one-time notice in the meeting chat | [S] |
| RCR-14 | If the organizer's timezone changes (relocation), the series prompts: keep original timezone or rebase to the new one | [S] |
| RCR-15 | Every occurrence has a stable occurrence ID (`RECURRENCE-ID`) used to attach recordings, transcripts, attendance and RSVPs | [M] |

## 8.3 Exceptions and per-occurrence behavior

| ID | Requirement | Pri |
|---|---|---|
| RCR-20 | A single occurrence can be moved, shortened, extended, renamed, or cancelled without affecting the series | [M] |
| RCR-21 | Modified occurrences are visually marked in the calendar as exceptions to the series | [M] |
| RCR-22 | Editing "this and all following" splits the series at that point: the past keeps its rule, the future gets a new one, and both remain linked to the same meeting chat | [M] |
| RCR-23 | Cancelling a single occurrence adds an exclusion; the series and all other occurrences are untouched | [M] |
| RCR-24 | RSVP is per occurrence, with a "respond for the whole series" shortcut | [M] |
| RCR-25 | Attendees added mid-series see all future occurrences and, at the organizer's choice, chat history from the start or from joining | [S] |
| RCR-26 | Recording, transcript, recap and attendance attach to the specific occurrence and are presented in the chat under that occurrence's divider | [M] |
| RCR-27 | Ending a series early ("end after today") is available and does not delete past occurrences or their artifacts | [M] |
| RCR-28 | Organizer transfer is supported; if the organizer leaves the workspace, the series is reassigned per admin policy rather than orphaned | [S] |

**Acceptance criteria (sample)**
- **Given** a weekly Tuesday 9:00 AM meeting in America/New_York with attendees in Asia/Kolkata, **when** US DST ends, **then** the meeting stays 9:00 AM New York and Kolkata attendees see their local time shift by one hour, with a notice in the chat.
- **Given** a 20-occurrence series where occurrence 5 was moved to Wednesday, **when** the organizer edits the series time, **then** they are prompted to keep or overwrite the exception, and choosing "keep" leaves occurrence 5 on Wednesday.
- **Given** a recurring meeting recorded on three occasions, **when** I open the meeting chat, **then** each recording appears under its own occurrence divider, correctly dated.

---

# 9. Cross-cutting requirements

## 9.1 Non-functional

| Area | Requirement |
|---|---|
| Performance | Gallery at maximum tile count sustains 30fps on the target device tier — **needs validation**. Chat opens the first 50 messages in under 1s |
| Reliability | Mute-state divergence, unauthorized recording access, and audio leaked while muted are Sev-1 classes with a same-day fix SLA |
| Accessibility | Full keyboard operation for all meeting controls; visible focus; screen-reader announcements for view and spotlight changes; recording state announced; captions independent of view mode; WCAG 2.1 AA contrast |
| Localization | All new strings externalized; date, time and recurrence summaries localized; RTL layouts supported for the meeting stage and chat |
| Security | Recording and transcript access checks enforced server-side on every fetch, not by URL obscurity; access changes audit-logged |
| Privacy | Clear disclosure of what the meeting chat retains; recording consent per §6; no client-side speech processing that transmits audio while muted |

## 9.2 Telemetry to instrument

- View mode selected, switch frequency, time spent per view, spotlight and pin usage
- Pop-out opened/closed, monitor count, session duration, fallback path taken
- Mute/unmute latency, mute-state reconciliation failures, device-change events, mic re-acquisition attempts, permission revocations
- Chat: time to first paint, pagination requests, "New messages" pill taps, reply-preview taps
- Meeting chat: messages per meeting, files per meeting, post-meeting engagement in first 48 hours
- Recording: start rate, processing duration, playback rate, download rate, failure rate
- Reschedule/cancel: frequency, lead time, RSVP reset rate, occurrence-vs-series split
- Recurrence: pattern distribution, exception rate, series length

## 9.3 Dependencies

Media server / SFU (server-side mute enforcement, selective subscription), recording pipeline and storage, transcription service, calendar and iCalendar interop layer, notification service, identity and guest-access policy, admin policy framework.

---

# 10. Delivery plan

| Phase | Contents | Rationale |
|---|---|---|
| **1 — Trust** | §3 mic/camera integrity in full; §2 pop out (desktop + Chromium PiP) | Broken mute is a credibility problem; nothing else matters if the call is unreliable |
| **2 — Stage** | §1 views (VIEW-01 to VIEW-08, VIEW-20 to VIEW-28) | Visible value, self-contained, no backend schema change |
| **3 — Continuity** | §5 meeting chat; §4 chat ordering; §6 recording (REC-01 to REC-09, REC-11 to REC-14) | Meeting chat is the container recording depends on, so it lands first |
| **4 — Scheduling** | §7 reschedule/cancel; §8 recurrence | Largest data-model change; needs the occurrence ID model from Phase 3 to attach artifacts |
| **5 — Polish** | VIEW-09 to VIEW-11, POP-06/07/11, REC-10/15, remaining `[S]` and `[C]` items | Sequenced after adoption data from earlier phases |

## 10.1 Jira epic breakdown

| Epic | Stories (indicative) | Key risk |
|---|---|---|
| E1 Mute integrity | Hard-mute capture control; server-side enforcement; state reconciliation; reconnect re-apply; device fallback; diagnostics panel; pre-join check | Platform-specific device APIs |
| E2 Meeting views | Gallery + pagination; speaker view; focus on content; pin; spotlight; selective subscription; view persistence | Decode/CPU budget on low-tier hardware |
| E3 Pop out | Detached window shell; content routing; loop prevention; PiP fallback; lifecycle cleanup | Browser API variance |
| E4 Chat ordering | Descending render; reverse pagination; unread divider; reply previews; composer placement; export order | Scroll-anchoring defects |
| E5 Meeting chat | Auto-creation; unified message store; system events; membership rules; artifact cards; series dividers | Membership/permission edge cases |
| E6 Recording | Capture pipeline; consent notices; processing status; transcript; access control; audit logging | Legal/regional consent |
| E7 Scheduling ops | Reschedule flows; RSVP reset rules; cancellation; iCalendar updates; conflict detection | External calendar interop |
| E8 Recurrence | RRULE model; occurrence IDs; exceptions; series split; DST handling; horizon limits | Timezone and DST correctness |

---

# 11. Open questions

1. D-1 through D-6 in §0 — all block their respective epics.
2. Does the workspace need per-participant recording tracks, or is a composed stream sufficient for this release? (Affects storage cost materially.)
3. Which jurisdictions require explicit recording consent for your customer base? Legal input needed before §6 build.
4. Should uninvited link joiners see full meeting-chat history, or only from their join point? (MCHAT-21.)
5. Is external-guest chat access allowed by default, or off until an admin enables it?
6. Do you need room/resource booking in recurrence (rooms, equipment)? Currently out of scope.
7. What is the target device floor for gallery view? This sets the tile caps in VIEW-20.
