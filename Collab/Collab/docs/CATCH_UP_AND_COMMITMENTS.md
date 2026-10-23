# Catch-up & Commitments — implementation plan

Status: proposal. Nothing in this document is built yet.

## 0. Source and assumption

The Google AI-mode link contains only the question, not the answer. It could not be opened from here, so the answer text was not read. The question is:

> What is one thing people are looking for while using Teams, Google, Slack and WhatsApp that would be a killer feature, useful for both B2C and B2B users?

This plan assumes the answer is the one gap all four products share: **people cannot tell what needs them without reading everything.** The feature is therefore **Catch-up & Commitments**:

1. **Catch-up.** One tap gives a short, structured digest of what you missed across all chats, calls and meetings.
2. **Commitments.** The digest pulls out decisions, questions waiting on you, promises you made, promises made to you, and dates. Each can become a task or reminder in one tap.

If the Google answer named a different feature, the Section 3 gap analysis and the Section 8 rollout still apply. Sections 4–7 would need to be redone.

## 1. Why this feature

| Product | What users still do by hand |
|---|---|
| WhatsApp | Scroll 200 unread group messages to find the one date or request that matters |
| Slack | Open every channel with a badge, skim threads, copy action items into a task tool |
| Teams | Replay a meeting or read the recap, then re-type who owes what |
| Google Chat / Meet | Same, with notes in a separate Doc |

| Audience | What the feature does for them |
|---|---|
| B2B | Decisions, owners and deadlines surface without a status meeting. Catch-up after leave or a time-zone gap takes a minute. |
| B2C | Family and friends group chats: plans, dates, "who is bringing what", and a reminder before it happens. |

CoLab already owns every surface this feature needs: chat, calls, meetings, tasks, reminders and notifications. Competitors split these across separate apps.

## 2. What already exists in this codebase

| Piece | Location | What it gives us |
|---|---|---|
| Per-conversation summary | `backend/app/src/services/aiService.ts` `summarizeConversation` | Membership check, `viewerId` history cutoff, E2EE rows skipped, 60 messages and 6000 characters of transcript, bullets plus an optional "Action items:" list in plain text |
| Summary route | `backend/app/src/routes/ai.ts` `POST /ai/summarize` | Auth and error mapping (`AI_DISABLED` returns 503, upstream errors return 502) |
| LLM client | `aiService.ts` `chatComplete`, config `config.ai` (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_TIMEOUT_MS`) | OpenAI-compatible endpoint, off when `LLM_BASE_URL` is unset |
| Tasks | `routes/tasks.ts` `POST /tasks` | Title, due date, assignee, description, and an actionable task card posted into the chat |
| Reminders | `services/reminderService.ts` `createReminder`, `reminderNL.ts` | Due date, recurrence, push at due time |
| Notifications and push | `notificationService.ts`, `mobilePushService.ts`, `webPushService.ts` | Delivery on web, desktop and mobile |
| Unread state | `conversationService.ts` member flag `unread`, `lastReadAt` | The boundary for "what I missed" |
| Search | `routes/search.ts`, `searchService.ts` | Link a commitment back to its source message |
| Frontend entry | `frontend/app/src/components/chat/useChatView2.tsx` calls `api.summarize` | The existing "Catch me up" button in a chat |

## 3. Gaps to close

1. **Single conversation only.** There is no cross-conversation view and no "everything since I last looked".
2. **Window is not "unread".** It always takes the latest 60 messages, not the messages after `lastReadAt`.
3. **Unstructured output.** Plain text cannot be turned into tasks, dated, or assigned to a person.
4. **No link back.** Nothing ties a summary line to the messages that produced it.
5. **Nothing persists.** Each tap re-runs the model and re-pays the cost. There is no read or dismissed state.
6. **Meetings and calls are not inputs.** Recordings exist (`recordingService.ts`), but no transcript is read by any AI feature.
7. **No cost or abuse controls.** There is no per-user budget, cache or rate limit on `/ai/summarize`.

## 4. Product behaviour

### 4.1 Entry points
- **Activity tab, "Catch up" card:** cross-conversation digest since the user's last digest or last visit. This is the primary entry.
- **Chat header, "Catch me up":** the existing button, upgraded to the structured result and limited to unread messages.
- **Meeting end screen:** "Recap and action items" for that meeting, when a transcript exists (phase 3).

### 4.2 Digest content
Each digest has these sections, and empty ones are hidden:

| Section | Meaning |
|---|---|
| Needs you | Questions and requests directed at the user, including @mentions |
| You committed | Promises the user made ("I'll send it Friday") |
| Waiting on others | Promises made to the user |
| Decisions | What was agreed |
| Dates | Meetings, deadlines and plans with a date or time |
| Highlights | Two or three lines per active conversation, ranked by relevance |

Every item shows who said it, where, and when. Tapping an item opens the chat at the source message.

### 4.3 One-tap actions
- **Make task:** `POST /tasks` with the item text as title, the detected due date and the owner as assignee. For tasks created from a chat, the existing task-card behaviour applies.
- **Remind me:** `createReminder` at the detected time, or a default of 9:00 the same day for date-only items.
- **Dismiss / Done:** hides the item and teaches nothing else. The item stays dismissed for that digest.

### 4.4 B2C and B2B wording
The same engine runs for both. Only the labels differ. In a workspace conversation the sections read "Needs you / Decisions / Owners". In a personal chat or family group they read "Plans / Who's doing what / Dates". The choice follows the conversation's `orgId`.

## 5. Technical design

### 5.1 Pipeline
```
select conversations with unread since boundary
  → per conversation: build transcript (existing visibility + E2EE rules)
  → map step: LLM → structured JSON per conversation (cached)
  → reduce step: rank and merge across conversations (no extra LLM call for ≤ 8 conversations)
  → persist items → return digest
```

Reasons for the split:
- The map step is per conversation, so it is cacheable and parallel.
- The reduce step is plain code, so it costs nothing and is testable.
- A conversation whose unread window has not changed is never re-summarised.

### 5.2 Structured output
`chatComplete` is called with a system prompt that demands JSON only, and the response is validated before use. Anything that fails validation is dropped and logged, never shown.

```json
{
  "highlights": ["string"],
  "items": [
    {
      "kind": "needs_you | you_committed | waiting_on | decision | date",
      "text": "string, max 160 chars",
      "ownerName": "string | null",
      "dueAt": "ISO-8601 | null",
      "sourceMessageId": "string"
    }
  ]
}
```

Rules enforced in code, not in the prompt:
- `sourceMessageId` must be one of the message ids that were sent in the transcript. Items citing anything else are discarded, which blocks hallucinated sources.
- `ownerName` is resolved to a user id by exact match against the conversation's members. Unresolved owners become null, never guessed.
- `dueAt` must parse and must not be in the past.
- Text is length-clamped and HTML-stripped.

The transcript sent to the model prefixes each line with its message id, for example `[m_8f2] Priya: I'll send the deck Friday`.

### 5.3 Window selection
- Boundary per conversation: `max(lastReadAt, history_visible_from)`.
- Cap: 200 messages and about 12k characters per conversation, oldest dropped first. If the cap is hit, the digest says "Showing the latest part of a long conversation".
- Cross-conversation cap: the 8 most relevant conversations (mentions first, then unread count). The rest are listed as counts only.

### 5.4 Data model
New migration `database/migrations/0129_catchup.sql`, mirrored in `database/schema/schema.sql` and in both drivers (`drivers/mysql.ts` and `drivers/json.ts`):

```sql
CREATE TABLE IF NOT EXISTS catchup_items (
  id              VARCHAR(36) PRIMARY KEY,
  user_id         VARCHAR(36) NOT NULL,
  org_id          VARCHAR(36) NULL,
  conversation_id VARCHAR(36) NOT NULL,
  source_message_id VARCHAR(36) NOT NULL,
  kind            VARCHAR(16) NOT NULL,
  text            VARCHAR(255) NOT NULL,
  owner_id        VARCHAR(36) NULL,
  due_at          DATETIME NULL,
  status          VARCHAR(12) NOT NULL DEFAULT 'open',   -- open | done | dismissed
  task_id         VARCHAR(36) NULL,
  reminder_id     VARCHAR(36) NULL,
  window_hash     CHAR(64) NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_status (user_id, status, created_at),
  KEY idx_window (conversation_id, window_hash)
);

CREATE TABLE IF NOT EXISTS catchup_cache (
  conversation_id VARCHAR(36) NOT NULL,
  window_hash     CHAR(64) NOT NULL,
  result_json     MEDIUMTEXT NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id, window_hash)
);
```

`window_hash` is a SHA-256 of the ordered message ids and edit timestamps in the window. A cache hit costs no model call.

The cache holds conversation-level model output, which was built from messages visible to the requesting member. Because members can have different `history_visible_from` cutoffs, the cache key must also include that cutoff in the hash. Without it, one member's summary could expose history that another member is not allowed to see.

### 5.5 API
New router `backend/app/src/routes/catchup.ts`, mounted in `app.ts` next to `aiRoutes`:

| Method and path | Purpose |
|---|---|
| `POST /catchup` | Build or refresh the digest. Body: `{ since?: ISO, conversationIds?: string[] }`. Returns sections and items. |
| `GET /catchup/items?status=open` | Open items across digests |
| `PATCH /catchup/items/:id` | Set `done` or `dismissed` |
| `POST /catchup/items/:id/task` | Create a task from an item, store `task_id` |
| `POST /catchup/items/:id/reminder` | Create a reminder from an item, store `reminder_id` |
| `POST /ai/summarize` | Kept for compatibility. Internally calls the same service with one conversation. |

Errors reuse the `ai.ts` mapping: 503 `AI_DISABLED`, 502 `AI_ERROR`, 403 `FORBIDDEN`. New: 429 `CATCHUP_LIMIT` when the budget in 5.7 is exhausted.

### 5.6 Service layout
- `services/catchupService.ts`: window selection, transcript build, map and reduce, persistence.
- `services/aiService.ts`: gains `chatCompleteJson(messages, schemaValidator)`, which retries once on invalid JSON. `summarizeConversation` is refactored to share the transcript builder so the visibility and E2EE rules live in one place.
- The transcript builder is the only code that decides what the model may read. Both features call it, so a fix to privacy rules applies to both.

### 5.7 Cost, scale and limits
- **Gate:** new config `CATCHUP_ENABLED` (default false) in `config/src/index.ts`, on top of `config.ai.enabled`.
- **Budget:** per-user cap, default 20 digests per day and 5 per hour, enforced in Redis, not in process memory. This follows the multi-replica rule from the architecture report. Rate limits in memory break with a second backend.
- **Concurrency:** at most 3 model calls in flight per request, and a global semaphore per backend instance. Requests above the cap wait, then return 429.
- **Large scale:** at the 5M-user target, digest generation moves to a queue worker on the event bus (see the 5M architecture diagram). The API then returns `202` with a digest id and the client receives `catchup:ready` over the socket. In phase 1 it stays synchronous with a 30-second timeout (`LLM_TIMEOUT_MS`).
- **Cache effect:** a busy group chat read by 50 members produces one model call per distinct (window, cutoff) pair, not 50.

### 5.8 Privacy and safety
- **E2EE conversations are never read.** Rows with `encryptionVersion > 0` are skipped, and a digest says so ("N conversations are end-to-end encrypted and were not summarised"). This is the existing rule in `summarizeConversation`.
- **Membership and history cutoff** are enforced per conversation before any message is loaded (existing rule, AUDIT P2 #37).
- **No cross-user leakage:** items are stored per `user_id`. The conversation-level cache is keyed as described in 5.4.
- **User control:** a Settings toggle "Include my chats in AI catch-up", default on for workspaces whose admin enables the feature, off for personal chats until the user opts in. Per-conversation "Exclude from catch-up" in the chat menu.
- **Data handling:** the transcript is sent only to the configured `LLM_BASE_URL`. Prompts and outputs are not logged at info level, only ids, counts and timings.
- **Prompt injection:** message text is passed as quoted data in the user turn, the system prompt states that message content is not instructions, and the code-side validation in 5.2 means an injected "create a task" cannot produce an item that was not tied to a real message.
- **Admin:** an org setting to disable the feature entirely, and an audit entry (`auditService`) when a digest is generated.

### 5.9 Frontend
- **API:** add `api.catchup`, `api.catchupItems`, `api.catchupItemUpdate`, `api.catchupItemToTask`, `api.catchupItemToReminder` to `frontend/app/src/lib/api.ts`. Add typed DTOs to `shared/` instead of `any`.
- **View:** new `components/colab/CatchUpView.tsx` rendered at the top of `ActivityView.tsx`, using existing tokens from `styles/tokens.css` and the dark-mode rules in `styles/chats.css`. No new global CSS file.
- **Chat button:** `useChatView2.tsx` switches from plain text to the structured result and shows the same item rows inside the existing summary popover.
- **States:** loading skeleton, empty ("You're all caught up"), AI-off (hide the card), 429 (show remaining budget), partial (some conversations skipped).
- **Socket (phase 4):** `catchup:ready` event added to `shared/src/events.ts` and to `frontend/app/src/lib/socket.ts` together, so the two lists stay in sync.

## 6. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| 1 | Structured per-conversation catch-up on unread messages, items stored, make-task and remind-me, feature flag | Works in one chat on `localhost:3002`; invalid model output is dropped; E2EE and cutoff tests pass |
| 2 | Cross-conversation digest on Activity, ranking, cache, Redis budget | One tap covers all unread chats within the timeout; cache hit rate visible in metrics |
| 3 | Meeting and call recap from transcripts | Needs a transcription source first (see open questions) |
| 4 | Async worker, `catchup:ready` push, scheduled "morning digest" notification | Runs on the event bus; delivered through existing push |

## 7. Testing

- **Unit (backend, `backend/app/test/`):** window selection, hash and cache key, JSON validation (bad id, bad date, past date, unresolved owner), transcript builder skips E2EE rows, budget enforcement.
- **Privacy tests:** a member with a later `history_visible_from` never receives items from messages before it, including when another member's cached result exists.
- **Route tests:** supertest for each endpoint, covering 403, 429, 503.
- **Prompt regression:** a fixed set of 20 sample conversations (work and personal) with expected item kinds, run against the configured model, treated as a non-blocking check.
- **E2E (Playwright):** open Activity, run catch-up on the probe users, create a task from an item, confirm the task exists. Use the throwaway MySQL recipe already used for backend tests.

## 8. Rollout and metrics

- Ship dark behind `CATCHUP_ENABLED`, enable for one workspace, then widen.
- Success metrics: share of active users who open a digest per week, items turned into tasks or reminders, items dismissed unread (quality signal), median time from open to first action, model cost per active user per month.
- Guardrail metrics: 429 rate, upstream error rate, and the share of items dropped by validation (a rising number means the prompt or model regressed).

## 9. Risks

| Risk | Mitigation |
|---|---|
| Model invents a commitment | Every item must cite a real message id; the UI always shows the source line |
| Wrong owner or date | Owners resolved by exact member match; dates validated; user confirms before a task is created |
| Cost grows with chat volume | Unread-only windows, caches, per-user budget, reduce step without a model call |
| Users distrust AI reading private chats | Opt-in for personal chats, per-conversation exclusion, E2EE never read, clear "what was read" line in the digest |
| In-memory limits break at scale | Redis-backed budget from day one |

## 10. Open questions

1. What did the Google answer actually name as the feature? If it differs, tell me and Sections 4–5 get rewritten around it.
2. Which model sits behind `LLM_BASE_URL` on the live host, and what is its context size and monthly budget?
3. Is a transcription source available for meetings and calls? Phase 3 depends on it.
4. Should personal (non-workspace) chats be included at launch, or only workspace conversations?
5. Is E2EE going to be switched on for most conversations? If so, this feature mostly cannot read them, and a client-side summary would be needed instead.
