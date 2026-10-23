# CoLab — Intelligent Onboarding Design

*Designed from CoLab's actual capabilities (grounded codebase audit + adversarial validation). Deliberately NOT a generic SaaS / Slack / Teams wizard.*

---

## The defining constraint (why this isn't a Teams clone)

CoLab has **no workspace / organization / tenant entity** — one shared database, `GET /users` returns everyone. The global `users.role` column and the `ROLES` constant (`owner`/`admin`/`guest`) are **dead code — never read for authorization**. All real authority is **created, not granted**: you become a *conversation owner* by creating a group, a *meeting host* by creating a meeting.

→ A "name your org, invite by seat with Admin/Member/Guest tiers, set channel policies" onboarding would be **fiction**. This design rejects it in favor of **personalization + discovery**.

## Current Product Capabilities (what onboarding can actually configure)

- **Profile** via `PATCH /api/users/me` — name, about (≤255), avatarUrl (initials/color auto-derived).
- **~40 whitelisted settings** via `PUT /api/settings` — appearance (theme/accent/density/zoom/fontSize/fontFamily/bubbleStyle/chatBackground), accessibility (highContrast/reduceMotion/largerText/dyslexiaFont/keyboardNavigation/blurMedia), region (language/timezone/dateFormat/timeFormat), A/V devices (mic/speaker/camera/echo/noise/ringtone), notifications (notifyLevel/notifyCalls/quietHours/sound/badge), messaging behavior (enterToSend/readReceipts/sendTyping/linkPreview/messageGrouping/autoCollapseSidebar/compactList/linkConfirm), Agen-X (agentStyle).
- **Collaboration:** connection invites (`POST /api/invites {toUserId}` → DM on accept), and creating DMs/groups/channels.
- **Nav surfaces:** dashboard, chats, calls, meetings, contacts, calendar, activity, tasks, reminders, files (+ search/agents behind flags).

> ⚠️ **Whitelist gotcha:** any settings key not in `settingsService.ts` DEFAULTS is silently dropped on save. The three onboarding keys (`onboardingDone`, `onboardingStep`, `onboardingFocus`) **must** be added to DEFAULTS.

---

## Recommended Flow — progressive, 3-tier, skippable, resumable

**Mandatory (1-tap each, sensible defaults):**
1. **Identity** — confirm display name (prefilled), optional one-line about.
2. **Appearance** — theme (light/dark) + accent, with live preview.
3. **Working focus** — Communicate / Organize / Both → sets default landing view + tour emphasis only (no fake permissions).

**Optional (each with Skip / Set up later):** Region (tz/time/date/language) · Notifications (level + quiet hours + calls) · Avatar upload · Find people (invite from directory) · Create first space.

**Advanced (collapsed accordion, opt-in):** A/V device check · Accessibility pack · Messaging behavior · Agen-X response style.

**Controls on every step:** Skip · Continue later (persists + dismisses) · Back · progress indicator. Each step writes its setting **immediately** (same debounced `PUT /api/settings` the live Settings panel uses) — partial completion is never lost.

**First-run detection:** after login, `GET /api/settings`; if `onboardingDone !== true`, open the overlay (resume at `onboardingStep`); else route to the focus-derived landing view.

---

## Personas (intent-based — honest to the data model, not invented role tiers)

- **New Member** — the only real account type; everyone runs the mandatory + optional steps.
- **Communicator / Coordinator** (`focus=communicate`) — adds **A/V device check**, emphasizes call notifications, optional first group/channel (becomes owner). Lands on chats.
- **Organizer / Async Worker** (`focus=organize`) — confirms timezone (critical for tasks/reminders/scheduling), sets Agen-X style, tours tasks/reminders/calendar/files. Lands on dashboard.
- **Accessibility-first** — cross-cutting modifier offered inline + as an optional step (largerText/highContrast/reduceMotion/dyslexiaFont/keyboardNavigation/blurMedia).

---

## Workspace Initialization Logic (answer → concrete effect)

| Answer | Writes | Effect |
|---|---|---|
| Name/about/avatar | `PATCH /users/me` | broadcasts `USER_UPDATED`, appears everywhere instantly |
| Theme/accent | `PUT /settings {theme, accent}` | reskins app shell |
| Working focus | `PUT /settings {onboardingFocus}` *(NEW key)* | default landing tab + which tour cards show |
| Region | `PUT /settings {timezone,timeFormat,dateFormat,language}` | scheduling, meetings, reminders, timestamps |
| Notifications | `PUT /settings {notifyLevel,notifyCalls,quietHours,...}` | desktop notif posture (+ browser permission prompt) |
| Find people | `POST /invites {toUserId}` | DM on accept → seeds chat list + frequent-users ranking |
| First space | `POST /conversations {kind,title,memberIds}` | user becomes **owner** |
| A/V check | `PUT /settings {micId,speakerId,cameraId,...}` from `enumerateDevices()` | preselects call/meeting devices |
| Completion | `PUT /settings {onboardingDone:true, onboardingStep:0}` | gates first-run |

---

## Settings Integration & Re-open

Onboarding is a guided front-end over the **same** settings contract — no parallel storage. Read flag via `GET /api/settings`; write each answer via the existing `PUT /api/settings` / `PATCH /api/users/me`. Add a **"Run setup again"** row in Settings (sets `onboardingDone=false`, reopens overlay). Re-running is non-destructive — it re-presents current values. Every answer stays editable forever in its existing Settings section.

---

## Enterprise UX Validation (vs Slack/Teams/Discord/Notion/Linear)

Those tools front-load org creation, seat/role provisioning, SSO/domain capture, channel policies, billing. **CoLab has none of these in its data model**, so they're deliberately omitted — avoiding premature "name your company", fake role matrices, empty-permission screens, and seat math. Result: a personalization-and-discovery onboarding honest to a product whose only real authority is *created, not granted*. The "find people" step mirrors a consumer **add-friends** flow (correct — invites create DMs), **userId-only** (no email-invite path exists in live code).

---

## Implementation Sketch (buildable without guesswork)

- **New component** `frontend/app/src/components/Onboarding.tsx` — full-screen overlay reusing `Modal.tsx` + Settings' Toggle/zoom patterns. Mount from `CoLabV1.tsx` after the authenticated branch; gate on `settings.onboardingDone !== true`.
- **Reuse existing endpoints only:** `GET/PUT /api/settings`, `PATCH /api/users/me`, `GET /api/users` + `/users/frequent`, `POST /api/invites`, `POST /api/conversations`, `navigator.mediaDevices.enumerateDevices()`.
- **One backend change (required):** add `onboardingDone:false`, `onboardingStep:0`, `onboardingFocus:'both'` to DEFAULTS in `settingsService.ts` (else silently dropped).
- **Landing view:** branch initial `mode` on `settings.onboardingFocus` (communicate→chats, else→dashboard).
- No new tables, no migrations, no role/permission code touched.

---

## Future Enhancements

1. Promote `onboardingFocus` into a first-class "Default view" Settings control.
2. If a real org/tenant entity is ever added → genuine workspace-creation + seat-invite + role-tier step.
3. Activate the dormant `admin`/`guest` roles → add invite-as-guest/admin sub-step.
4. Per-feature "discovered" map → contextual coach-marks on first visit instead of one upfront tour.
5. Tie A/V check into a real LiveKit test-room handshake (mic meter / echo test).
6. Email-invite path (`inviteService` email + auto-DM) to close signup → first conversation.
7. Surface onboarding progress in the Activity log (auditService already records actions).
