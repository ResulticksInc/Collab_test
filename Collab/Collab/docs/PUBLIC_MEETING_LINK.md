# Public meeting link (guest join)

A host can create a **public link** for a meeting. Anyone with it — including people
who have no Collab account — opens `/join/<token>`, types a name and joins the meeting
inside the meeting's organisation. No sign-up, no login.

## Using it

| Who | Where | What |
| --- | --- | --- |
| Host / co-host | Calendar → meeting → **Public link** (details / edit dialog), or in the meeting → **Invite** | *Create public link* (copies it), *Copy public link*, *Turn off* |
| Guest | `https://<host>/join/<token>` | Lobby asks for a name; **Join now** enables once the name is valid; then they are in the meeting |

*Turn off* revokes the token at once — the old URL stops resolving. People already in the
room stay until they leave. Creating a link again mints a **different** token.

## What a guest is

* A `users` row with `role='guest'`, a synthetic `guest+<uuid>@guest.invalid` email, no
  password and **no organisation membership** (so they never appear in the org
  directory). Display name is stored as `"<name> (Guest)"` so a guest can't pass as a member.
* A short-lived session (`GUEST_SESSION_TTL_HOURS`, default 12) whose `active_org_id` is
  copied from the **meeting row** — the client never chooses the tenant.
* The meeting's own rules still apply: lobby policy (a guest is never "invited", so a host
  with the lobby on admits guests one by one), lock, eject, hard-end window.

## Name rules (lobby and server agree)

2–50 characters, at least one letter or digit, no `<` `>`, control / zero-width /
bidi-override characters stripped, a typed "(Guest)" suffix not doubled. Server:
`normalizeGuestName` (`services/guestMeetingService.ts`); lobby: `lib/guestName.ts`
(a test asserts they agree).

## One guest identity per browser profile

Before this rule, every press of **Join** minted a brand-new guest user, so one person
re-entering from the same browser under different names ("Hari Vigenesh", "Hari",
"Vicky") appeared as three participants in the roster and the attendance log.

* The lobby generates a **device id** once per browser profile (`lib/guestDevice.ts`,
  `localStorage` key `clb_guest_device_id`, an opaque random string — not a hardware
  fingerprint) and sends it with the lookup (`?device=`) and the join (`deviceId`).
* The server pins `(meeting, device) → guest user` in `meeting_guest_devices`
  (migration 0135) on the first join. Every later join from that browser — a refresh, a
  reconnect after a network drop, a new tab, or a join under a **different name** —
  reuses that guest user, so the same Guest ID (and the same attendance rows) is kept.
  The **original display name is retained**; the join response says `resumed: true`
  and carries the name actually in use.
* The lobby shows the known name read-only ("This browser already joined this meeting
  as X. You'll rejoin with the same name."), and if a join still comes back resumed
  under another name, a toast tells the guest which name they are in under.
* Scope: public-link guests only. Signed-in Collab members never pass through this
  path. The binding is **per meeting**, so the same browser is a new guest in a
  different meeting, and a different browser profile or device is a different
  participant even with the same name.
* A browser that sends no (or a malformed) device id — storage blocked, private
  mode — gets a fresh identity per join, exactly as before. Clearing site data forgets
  the id, which is indistinguishable from arriving on a new device.
* Two tabs joining at once race on the primary key; the first writer wins and the other
  tab adopts that identity (its own fresh row is never given a session).

## Security model

The guest token (`{ guest:true, mid:<meetingId>, jti }`) is deliberately narrow:

* **REST** — `middleware/auth.ts › guestAuth` allows only the in-meeting endpoints of *its
  own* meeting (room enter/heartbeat/leave, lobby/self, options, polls list + vote, the
  LiveKit token for that meeting, self-mute report, logout). Everything else is a
  `403 GUEST_FORBIDDEN` **before any route code runs**, so new routes are closed to guests
  by default. The org-membership gate is skipped (a guest has none) — the allowlist is the bound.
* **Socket** — `realtime/socket.ts`: a guest socket may emit only the meeting events
  (join, hand, reaction, chat, whiteboard) for its own meeting; chat file attachments are stripped.
* **Privacy** — room payloads and presence broadcasts sent to a guest carry roster essentials
  only (no email / phone / title), and the org chat group id is withheld.
* **Fan-out** — guests are never added to the meeting chat group, never trigger auto-record /
  "meeting started" notifications, and are never invited by calendar sync.
* **Public endpoints** (`/api/public/meetings/:token[/join]`) are no-auth and rate-limited per
  IP (lookup 60/min, join 20/10 min). The lookup reveals only title, host name, org name and
  whether the meeting is closed — never attendees.
* The signed-in app's tokens are never touched: the guest bearer lives in memory (and
  `sessionStorage` for refresh), and the API client skips session recovery for guest tokens.

## Schema

`0132_meeting_public_link.sql` adds `meetings.public_link_token` (nullable, unique). The
token is separate from the meeting id (which is shared in chat/invites and needs a Collab
session) so the account-less path can be revoked without touching the id.

`0135_meeting_guest_devices.sql` adds `meeting_guest_devices (meeting_id, device_id →
user_id, join_count, created_at, last_seen_at)` — the per-meeting browser-profile →
guest binding described above.

## Known limits / follow-ups

* Anyone holding the link can reach the lobby. With the default lobby policy (`everyone`)
  they go straight in — hosts who want to vet guests should turn the lobby on.
* Guest user rows are kept (they own meeting-chat lines and attendance rows); there is no
  purge job yet.
* Guests can't upload files, record, or invite; they have no chat history beyond the
  meeting's own.
* Because one browser profile is one participant, opening the link in a **second tab**
  of the same browser replaces the first tab's media connection (LiveKit keeps one
  connection per identity) — the first tab shows "call dropped" and reconnects. Same as
  a member on two devices today.
