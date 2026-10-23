# Collab — Enterprise UI Audit (20 Golden Rules)

Code-grounded audit of every product surface against the 20 Enterprise UI Golden Rules.
Method: 9 surface auditors → per-surface adversarial verifier (drops false positives, re-rates
severity, adds missed issues). Every finding below is **confirmed** or **adjusted** (real); rejected
over-claims were removed. Static analysis only (the app was not run), so findings are derived from the
actual JSX + CSS with file:line evidence.

> Coverage gap: the **secondary-modules** surface (Calendar / Tasks / Files / Activity / Contacts /
> Search) verifier died on a transient socket error, so that surface is **not yet covered** — re-run pending.

Severity: **Critical** = broken/blocking · **High** = clearly wrong & user-visible · **Medium** = real
but narrow/polish · **Low** = cosmetic/maintainability.

---

## Systemic root causes (fix these first — each kills many findings)

### S1 · Z-index has no tier system; toasts render *behind* overlays — `R8` HIGH
The app mixes CSS z-index (100/200/220/999/1000/4000/4500/4600/9999/10000) **and** inline JS z-index
(Modal `800`, toast `900`, call/meeting overlays `1000`) with no shared source of truth.
- The live **toast is `zIndex:900`** (CoLabV1.tsx:3957) — *below* the call stage (1000), meeting
  `.mr-overlay` (1000), avatar-crop (4000), onboarding (4500), help (4600). **Every in-call/in-meeting
  confirmation and error toast** ("Recording stopped", "Participant muted/removed", "Mute all failed",
  device-switch errors) is **invisible** (CoLabV1.tsx:3943-3963 vs 6713-6727; v1.css:7348-7354). Same for
  toasts fired inside avatar-crop / help flows.
- Base **Modal overlay is `800`** — *below* tooltips and FloatingMenu dropdowns (`1000`), so a hovered
  tooltip / open dropdown can paint over a modal (Modal.tsx:72; FloatingMenu.tsx:147; v1.css:4453).
- **Fix:** define `:root` tokens `--z-sticky:100; --z-dropdown:500; --z-popover:1000; --z-modal:2000;
  --z-toast:3000; --z-overlay:4000` and migrate **every** CSS *and* inline z-index onto them. Toast →
  `--z-toast` (above the 4000 overlays where confirmations fire). Base Modal → `--z-modal`.

### S2 · Escape is handled by ≥4 uncoordinated listeners → one press closes a dialog **and** navigates Back — `R10,R18` HIGH
Only the single `modal` state is mirrored into `modalRef` (CoLabV1.tsx:549). `logoutOpen`,
`shortcutsOpen`, `manageConvId`, Settings (opened via `onMode`), AvatarCropModal, and the chat
delete-dialog are **invisible to the global ESC arbiter** (CoLabV1.tsx:556-566). Result, per dialog:
- Logout / Shortcuts: base-Modal listener closes it **and** global `goBack()` fires (CoLabV1.tsx:556-566).
- Settings: raw `keydown` listener (Settings.tsx:409-415, **no deps array** → rebinds every render) closes
  Settings **and** global Back fires; with AvatarCrop open, one Escape fires **onCancel + onClose + Back** (triple).
- AvatarCrop over ManageGroup: Escape cancels crop **+** closes Manage modal (loses unsaved edits) **+** Back.
- Chat delete-confirm: no Escape handler at all → Escape dispatches global Back with the dialog still open
  (ChatView.tsx:1531-1553).
- **Fix:** one ESC arbiter. Either mirror **any** open overlay into `modalRef`
  (`modal || logoutOpen || shortcutsOpen || manageConvId || cropFile || …`), or have every overlay register
  on mount via the cancelable `colab:esc` protocol and `preventDefault()` so exactly one layer responds.

### S3 · No modal locks background scroll; no focus trap/restore anywhere — `R10,R18` HIGH
Repo-wide there is **zero** `body.style.overflow` / scroll-lock (Modal.tsx:65-141; `.ob-overlay`,
`.hc-overlay`, `.mm-overlay`, `.acm-overlay`). Background scrolls behind every dialog. Base Modal also never
captures/traps/restores focus (Modal.tsx:58-97) — Tab leaves the dialog to background controls; focus is lost
on close.
- **Fix:** shared scroll-lock + focus-trap + focus-restore in one Modal/`useModal` hook; route every overlay
  through it (Onboarding, Help, AvatarCrop, createMeeting, call/meeting dialogs).

### S4 · Dark theme + custom accent → accent surfaces turn near-**white** — `R15` HIGH (strongest finding)
`body.dark/oled/midnight/forest` set dark `--acb/--ac100`, but the standalone `body.accent-*` classes
hardcode **light** values (`#eff6ff`, `#f5f3ff`, …) and, applied together (CoLabV1.tsx:243-261), the accent
class **wins by source order** (v1.css:13177-13206 > :85). So in dark theme + any non-default accent, every
`--acb` surface — time pills, calendar event chips, reaction-pill states, **focus rings** — becomes a glaring
near-white box in a charcoal UI (and dark-text-on-white turns invisible). No `body.dark.accent-*` overrides exist.
- **Fix:** add dark-scoped accent overrides (`body.dark.accent-cobalt blue { --acb:#1a2230; --ac100:#26344d }`, ×
  every theme × accent), or derive `--acb/--ac100` from the active theme's neutral scale instead of hardcoding.

### S5 · Keyboard & touch dead-ends across primary controls — `R16,R18`
- **Conversation rows** are bare `<div onClick>` (ConversationSidebar.tsx:46-51, 121/137/161/371/502) — not
  focusable, no role/aria-current. The **primary navigation of the app is keyboard-inaccessible**.
- **Row actions** (kebab = mute/star/read/archive/delete, favourite star) are **hover-only** opacity:0, no
  `:focus-within`, no `@media (hover:none)` (v1.css:879/4604/704-705/4617). Unreachable by keyboard/touch.
- **Chat message toolbar** (react/reply/forward/edit/delete/pin) mounts only on hover/mouse-click
  (ChatView.tsx:1366-1372, 1500-1514) — keyboard-dead.
- **Rail collapsed expand** chevron is `:hover`-only with no `:focus-visible` reveal and `aria-expanded`
  missing (v1.css:309-324); tablet breakpoint hides the collapse control entirely (v1.css:4988-4998).
- **Global tooltips** (`[data-tip]`) are `:hover`-only — no `:focus`/touch path (v1.css:4433-4455).
- **FloatingMenu** dropdown: no arrow-key nav, doesn't move focus into the menu, no `aria-haspopup/expanded`
  (FloatingMenu.tsx:101-106).
- **Fix:** make rows `role=button tabIndex=0 aria-current` + `onKeyDown`; reveal hover actions on
  `:focus-within` and under `@media (hover:none)`; mount message toolbar on focus; add `:focus-visible`
  tooltip + rail-expand reveal; implement WAI-ARIA menu keyboard pattern in FloatingMenu.

### S6 · Animations exceed the 150–250ms budget — `R19` MEDIUM ⚠ conflicts with your recent request
`.ms-tile { transition: all 0.3s }` (v1.css:10139 — also animates layout on every grid relayout + join/leave),
`#rail` width `0.32s + 0.09s` (~410ms, v1.css:253), toggle/knob `0.3s`, toast `0.3s`, body theme `0.26s`, and
the **app-wide interaction rule at `0.3s/0.28s`** (v1.css:11503-11513). `prefers-reduced-motion` is correctly
honored. **Note:** the 0.3s app-wide rule is the one you asked me to make "smoother / a good amount" — Rule 19
caps it at 250ms, so this is a **direct conflict with your instruction**; your call whether to keep 0.3s or
drop to ~0.2s.

---

## Per-surface findings

### Login / Sign-up
- **HIGH** `R1,R14,R20` — Signup form **clips off-screen with no scroll** at 150–175% zoom / 1366×768:
  `body{overflow:hidden}` + `.auth-wrap` centered + `.auth-card`/`.auth-form` no `overflow-y` → top fields &
  submit unreachable (v1.css:140-151, 13511-13551). **Fix:** let the auth screen scroll (`.auth-wrap`
  `overflow-y:auto; align-items:flex-start`); don't apply global `body{overflow:hidden}` pre-auth.
- **HIGH** `R18,R16` — Text inputs have **no visible focus ring** (global `input:focus-visible{outline:none}`
  but no `.auth-input:focus` rule) — WCAG 2.4.7 on the first screen (LoginScreen.tsx:69-83; v1.css:215-221).
- **MED** `R15` — Login always renders **light**, then flashes to dark after auth (theme not persisted /
  applied pre-auth; CoLabV1.tsx:128-129, 789, 708-727).
- **MED** `R17,R18` — Error banner has no `role="alert"`/`aria-live` (LoginScreen.tsx:214-224).
- **LOW** — autoFocus skips the Name field in signup (250 vs 229); checklist appears on first keystroke and
  shifts the button (R7); strength row no gap; `.btn-p` keeps pointer cursor when disabled; "Passwords dont
  match." missing apostrophe (line 320).

### Nav rail
- **HIGH** `R16,R18,R11` — Collapsed rail expand is hover-only: no `:focus-visible` reveal (invisible focus
  target) + dead on touch + no `aria-expanded` (v1.css:309-324; Rail.tsx:225-236). *(keyboard Enter does work —
  the button is in tab order — but the user can't see focus.)*
- **HIGH** `R16,R18` — `@media(max-width:1024px)` hides the collapse control and labels with no tap-reveal;
  tooltips are hover-only → touch/tablet has no way to read labels or expand (v1.css:4988-4998, 5363-5372).
- **HIGH** `R18` — Resize handle is `role="separator"` but a non-focusable `<div>`, mouse-drag-only, no
  keyboard/touch, missing `aria-valuenow/min/max` (Rail.tsx:317-325).
- **LOW** — ad-hoc z-index 20/21; off-grid sizes; footer mixes 28/34/44px heights; uncapped badge counts
  (no `99+`); expanded profile name truncates with no title; nav buttons lack group/list semantics.

### Conversation sidebar
- **HIGH** `R17,R20` — **No loading state**: shows three false "No conversations / No groups / No channels"
  empties while fetching / on slow reconnect (ConversationSidebar.tsx:415-486; CoLabV1.tsx:66,599,771).
- **HIGH** `R16,R18` — Kebab + star **hover-only**, and rows non-focusable → keyboard/touch can't reach
  mute/favourite/archive/delete (v1.css:879/4604/704-705; ConversationSidebar.tsx:46-51).
- **MED** — rows are non-semantic clickable divs (no keyboard select of a conversation); truncated names have
  no `title` tooltip (R1); section "+" are bare `<span onClick>`; FloatingMenu not arrow-key navigable.
- **LOW** — search has no loading/error state (silent fallback); archived rows `opacity:0.7` hurts dark
  contrast; ad-hoc z-index 40/6/3/2.

### Chat window / messaging
- **HIGH** `R16,R18` — Message action toolbar (react/reply/copy/forward/edit/delete/pin) **unreachable by
  keyboard** (ChatView.tsx:1366-1372, 1500-1514).
- **HIGH** `R16,R18,R12` — Composer **@mention popover is fully broken**: no click handler, never calls
  `props.command`, renders at viewport `(0,0)` not the caret — a mention can't be inserted by mouse *or*
  keyboard (RichTextEditor.tsx:154-204).
- **MED** `R8` — message popovers use z 9000–10002, inverted vs the 800 modal layer.
- **MED** `R15` — reaction "mine" uses undefined `--ac-light` → always `#eff6ff` (near-white) in dark mode
  (ChatView.tsx:758,897; v1.css:1866).
- **MED** `R12,R20` — voice player `min-width:220px` overflows a narrow/zoomed bubble (v1.css:1459-1479).
- **MED** `R1,R7` — reactor-names tooltip absolute inside the clipped `.msgs` scroller → clips at top edge
  (ChatView.tsx:906-919).
- **MED** `R10,R18` — delete-confirm dialog: no Escape (fires global Back), no scroll-lock, no focus restore,
  no `role=dialog` (ChatView.tsx:1531-1553).
- **MED** `R20,R1` — staged-attachment tray has no max-height/scroll → many files push input & Send off-screen
  (v1.css:11911).
- **MED** `R18` — hidden toolbar (opacity:0) stays in tab/AT tree; speed button accent-on-accent low contrast.
- **LOW** — system pill truncates with no title; hover Copy no touch path; dead legacy textarea/mention code;
  LinkPreview img has no `onError` fallback (broken-image glyph).

### Dashboard
- **HIGH** `R1,R14,R20` — `.dash2` (`height:100% + overflow:hidden`) + the 56px nav-history bar + zoom →
  bottom 2×2 row **clips with no scrollbar**; the `@560px` single-column mode makes it worse
  (v1.css:5385-5398, 4679-4683, 11495-11498). **Fix:** `.dash2 { overflow-y:auto }`, lower the top-padding ceiling.
- **MED** `R17,R20` — no loading state: shows "0 Unread / All clear / No frequent contacts" before data
  resolves (false all-clear on slow net / failed fetch).
- **MED** `R19` — the global 0.28–0.3s rule applies to the dashboard cards (see S6).
- **LOW** — uneven 2×2 cell heights; off-grid spacing (gap 22/9, pad 14, search 46); duplicate `.dash2-search`
  block leaves dead `margin-bottom:20px`.

### Calls + Meetings
- **HIGH** `R8,R1` — In-call/meeting toasts invisible (see S1).
- **HIGH** `R1,R20` — Speaker/expanded meeting view stacks minimized tiles in **one vertical column** and clips
  them (`.ms-stage overflow:hidden`, no filmstrip) with 6–8+ participants (MeetingStage.tsx:485-520; v1.css:10016-10290).
- **HIGH** `R9,R18,R7` — meeting **device-settings / reaction / chat-emoji popups never close on outside-click
  or Escape** (MeetingStage.tsx:946-976, 1003-1016, 869-898).
- **MED** `R14,R3` — 1:1/group call control bar has no `flex-wrap` → 9 host controls overflow at zoom/small
  laptop (meeting `.ms-controls` wraps; inconsistent) (CoLabV1.tsx:6482-6495).
- **MED** `R18,R10` — CallModal/MeetingStage declare `role=dialog aria-modal` but have no Escape/focus mgmt;
  Escape falls through to global Back mid-call (CoLabV1.tsx:6713-6727).
- **MED** `R19` — `.ms-tile transition:all 0.3s` animates the whole grid on every join/leave/layout switch.
- **MED** `R18,R16` — host-row controls (Make co-host / Mute / **Remove**) are ~9px font / sub-20px tap targets.
- **LOW** — pin button identical glyph for pinned/unpinned; side panel fixed-width no responsive collapse;
  4s floating-reaction animation not under reduced-motion; off-grid sizes.

### Settings / Onboarding / Help / Agents
- **HIGH** `R10,R18` — Settings' raw Escape listener double-closes with child modals + triggers global Back
  (see S2) (Settings.tsx:409-415).
- **MED** `R1,R20` — Onboarding card has **no max-height** → footer (Back/Continue) clips at zoom/short
  viewport, blocking completion; it's non-dismissible so there's no escape hatch (v1.css:12602-12618).
- **MED** `R5,R16,R17` — Security section tiles (Password / MFA / Device management) are dead `<div>`s that do
  nothing and have no "not available" state (Settings.tsx:1244-1248).
- **MED** `R18` — custom Toggle is icon-only with `aria-pressed` but **no accessible name**; segmented
  zoom/density groups have no `radiogroup` semantics (Settings.tsx:234-264, 691-705, 845-883).
- **MED** `R10,R20` — no scroll-lock / focus-restore on Onboarding/Help (see S3); Onboarding has no dialog role.
- **LOW** — overlay z-index 4000/4500/4600 off-scale; inline button heights 32/34 vs 36; half-pixel fonts.

### Modal / Dropdown / Tooltip framework
- **HIGH** — S1 (z-index), S2 (Escape), S3 (scroll-lock/focus) all root here.
- **HIGH** `R18` — createMeeting + AvatarCrop overlays missing `role=dialog`/`aria-modal` (CoLabV1.tsx:3733;
  AvatarCropModal.tsx:112).
- **MED** `R1` — CSS tooltip `white-space:nowrap`, center-anchored, no viewport collision → long tips on edge
  controls run off-screen (v1.css:4436-4454).
- **MED** `R9,R18` — FloatingMenu no arrow-key nav / focus-move / `aria-haspopup` (FloatingMenu.tsx:101-106).
- **MED** `R7` — FloatingMenu first paint at `-9999` before position computed (use `useLayoutEffect`).
- **MED** `R17` — createMeeting modal: no busy/disable/try-catch on Create → closes + false "created" toast on
  failure; double-click double-creates (CoLabV1.tsx:3746-3751).
- **LOW** — `onClose()` called unguarded though optional; mixed footer button heights; off-grid padding;
  meeting-title input lone `1.5px` border.

### Global CSS systems
- **HIGH** — S1 (z-index), S4 (dark+accent). 
- **MED** `R19` — durations (see S6).
- **MED** `R1` — bare CSS modal `.m/.msm/.mm2` has no max-height/overflow → clips off-viewport for any
  consumer not using Modal.tsx (v1.css:3835-3849).
- **LOW** `R3` — no `--control-h` token; controls at 26/30/34/36px sit together (composer .ib 30 vs .sb-btn 34).
- **LOW** `R2` — pervasive off-8px-grid spacing + half-pixel fonts.
- **LOW** `R14` — arbitrary/overlapping breakpoints (560/640/720/760/900/980/1000/1024/1100); 1366×768 gets the
  full desktop layout (rail 248 + sidebar 288 + info 320 = 856px chrome → ~510px chat with all panes open).

---

## What already complies (sample)
Theme system + `prefers-reduced-motion` honored app-wide · FloatingMenu portals with flip/shift viewport
handling · group-call grid is count-aware fit-all (no clip) · ARIA `aria-current`/`aria-label` on rail items ·
message bubbles use `min(%,px)` dynamic sizing · composer editor is height-capped · InviteModal has proper
busy/error/sent states · global `:focus-visible` ring exists.

## Recommended fix order
1. **S4 dark+accent** (1 CSS block — biggest visible win) → 2. **S1 z-index tiers + toast** (tokens + migrate)
→ 3. **S2 Escape arbiter** + **S3 scroll-lock/focus** (shared Modal hook) → 4. **S5 keyboard/touch** (rows,
toolbars, tooltips, FloatingMenu) → 5. clipping/scroll (auth, dashboard, onboarding, meeting tiles) →
6. **@mention** repair → 7. loading states → 8. **S6** durations (confirm 0.3s vs 0.2s with you) → 9. polish (R2/R3).
