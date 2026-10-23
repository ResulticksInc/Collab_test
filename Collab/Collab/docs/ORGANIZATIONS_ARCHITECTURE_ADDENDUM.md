# Organizations Architecture — Validation Addendum (v2)

**Status:** Deep enterprise validation of [ORGANIZATIONS_ARCHITECTURE.md](./ORGANIZATIONS_ARCHITECTURE.md) against 11 scenarios + an adversarial 5–10‑year debt review. **Planning only — no code.** This addendum **supersedes** the noted v1 sections; everything not called out here stands.

---

## 0. Headline — what survives, what v1 got wrong

**Survives, do not relitigate:** shared‑schema row‑level `organization_id`; **global `users` + `organization_members` join** (multi‑org); **Teams = hierarchical Departments**; org‑scoped RBAC in principle; zero‑orphan migration *intent*. The *model* is right.

**v1 got three things wrong** — the adversarial pass proved each against the actual code. These are the decisions that become 5–10‑yr debt if shipped as written:

| v1 section | The flaw (code‑grounded) | Corrected decision |
|---|---|---|
| **§5 active‑org on the session** | `active_org_id` is one column on one *device* session, but a browser shares one session across tabs → tab 2 switches org, tab 1 silently writes the **wrong tenant**. And the firing loops (`index.ts:245`), socket handshake (`socket.ts:175`), API keys, webhooks have **no session at all**. | **Org context lives on the request/connection** (default *from* session) for humans, **on the credential** for machines, **on the row** for background jobs. §1 below. |
| **§7 tenant‑bound repository** | `db` is a **process‑wide singleton** (`database/src/index.ts:3`); the driver is a **4,681‑line hand‑written‑SQL object literal** (`mysql.ts`) with ~400 bespoke `SELECT`s. There is nothing to inject `WHERE organization_id` *into*. `db.forOrg()` **cannot be built** — believing it exists makes review *less* careful (safety theater). | **A query interceptor in `q()`** (the one real chokepoint, `mysql.ts:56`) that **throws in CI/test** when a DIRECT‑table query lacks an `organization_id` predicate, **plus denormalize `organization_id` onto hot INHERIT tables** (`messages`, `tasks_*`) for defense‑in‑depth + sharding. §2 below. |
| **§2/§4 global user identity** | Global `users` + `email UNIQUE` (`0001:4`) is right for multi‑org but makes **GDPR erasure, per‑org retention, SSO identity‑ownership, and data residency mutually contradictory** — the exact things procurement audits. | **Split global auth identity from org‑owned principals** `(org_id, external_id)`. GDPR erasure scrubs the global auth identity + the requesting org's principal, leaving other orgs' legally‑required audit intact. §3 below. |

Everything else (lifecycle, workspaces, team depth, modules, AI, admin, external collab, notifications, search, desktop) is answered §4–§15.

---

## 1. Org context — REVISED (supersedes v1 §5)

Org is **not** a session property. It is resolved per actor class:

- **Human requests / sockets:** default from `auth_sessions.active_org_id`, but the **active org is asserted per request/connection** (an `X‑Colab‑Org` header / socket handshake arg), then **re‑verified against `organization_members`** in middleware → `req.org`. This gives **per‑tab isolation** (tab 1 and tab 2 each carry their own org; a switch in one never corrupts the other). The session column is just the last‑used default.
- **Machine credentials (API keys, webhooks):** org is **intrinsic to the credential** — `org_api_keys.organization_id`. A second, first‑class org‑resolution path, **designed now** so it never drifts from the human path.
- **Background jobs (firing engines, GC, sweeps):** org is **intrinsic to the row**. `reminders`/`tasks` are DIRECT (they carry `organization_id`), so `claimDue` (`mysql.ts:1869`, today org‑agnostic) selects globally but **carries each row's `organization_id` forward** into notification/delivery — so per‑org DND, rate limits, and AI policy apply with **no session**. v1's claim that the firing services are "unchanged, just a filter" is wrong — they must become **org‑carrying** (they already have the column; the *services* need the plumbing).
- **Socket layer** needs its own org resolution in the handshake (`socket.ts:175`) — rooms become `conv:<org>:<cid>` only if the handshake loads the org. This is net‑new, not free.

---

## 2. Isolation enforcement — REVISED (supersedes v1 §7)

The magic repo is retired. Two concrete, buildable guards:

1. **`q()`‑level interceptor** (`mysql.ts:56` is the single chokepoint every query passes through). In **non‑production**, any `SELECT/UPDATE/DELETE` touching a DIRECT table without an `organization_id =` predicate **throws** — a *real*, testable structural guard in one place. MySQL 8 has no Postgres‑RLS equivalent, so app‑layer is the only option; this is the right seam.
2. **Denormalize `organization_id` onto the hot INHERIT tables** (`messages`, task children) despite v1's "avoid redundant storage." At multi‑tenant scale this is **security defense‑in‑depth + the sharding key**; the double‑write risk is trivially removed by deriving org from the (always‑known) parent at insert time. v1 treated denormalization as a bug; here it's a necessity.
3. **Search is a confirmed live leak today** (§12) — `messages.search` (`mysql.ts:826`) and global search are globally unscoped. This is the highest‑priority isolation fix, not a future nicety.

---

## 3. Identity / tenancy split — NEW (revises v1 §2/§4)

- Keep **global `users`** for authentication (email‑unique stays — it's the one unique that must *not* get org‑folded).
- Add a per‑org **principal**: `organization_principals(organization_id, user_id, external_id NULL, display_name, ...)`. Org‑owned identity, retention, and audit display name live here.
- **GDPR erasure** = scrub global auth identity + null the principals *the requesting org controls*; other orgs' legally‑required audit trails keep a pseudonymized principal. Resolves the global‑user vs per‑org‑retention contradiction.
- **SSO** provisions an identity keyed by `(org_id, external_id)` — *linkable to* but not *equal to* the global user, so SCIM deprovision in Acme never nukes Jane's personal account. This is a **schema fork that's nearly free now and impossible to retrofit** after millions of cross‑org rows.
- **E2EE + residency:** keep ciphertext server‑blind, but device/key rows (`e2ee_*`) need an **org/residency association** — otherwise you can never answer "export/delete/keep‑in‑region all of Acme's E2EE data." Server‑blindness and data‑residency are *not* automatically compatible; tag now.

---

## 4. Organization lifecycle — NEW (the biggest v1 gap)

v1 designed structure but had **no state model, no ownership‑transfer guard, no orphan invariant.**

**Two orthogonal status axes (never conflate):** `organizations.status` ∈ `active | suspended | archived | pending_delete | deleted` (whole tenant) vs `organization_members.status` ∈ `invited | active | suspended | left` (one person). Plus the `role` axis.

**Org state machine:** `active ⇄ suspended`, `active/suspended → archived ⇄ restore`, `archived → pending_delete (grace window) → deleted`. **You cannot one‑click delete a live org** — archive (recoverable, billing off) then a *separate, grace‑windowed* delete, reusing the file GC claim‑then‑purge pattern (`fileGcService.ts`) with an `ORG_DELETE_GRACE_DAYS`. Per state: what login/writes/reads/realtime/billing/disk do (suspended = blocked at org‑resolve in middleware; archived = owner read‑only; pending_delete = export/cancel only).

**The invariant that prevents orphans:** **≥1 `active` `owner` at all times.** Every destructive member op (leave, delete‑account, role‑change, suspend) has this as an enforced precondition. **Critically, the existing `DELETE /account` route (`auth.ts:53`) must become org‑aware** — today a sole owner deleting their account orphans the org silently. That + the `#66` session‑revocation path are the two "5‑yr debt traps" v1 buries.

**Ownership transfer** is a required step before an owner may leave/delete; sole‑owner has no valid transfer → op is blocked with a clear "assign a new owner first."

**Merge:** design the model to *not preclude* it, but **do not build it and do not ship a stub** — it's genuine O(n) id‑remapping + conflict resolution; a half‑merge corrupts a tenant. "Never until a paying acquisition forces it."

**Export** (GDPR/offboarding): read‑only, never hard‑delete on export.

---

## 5. Workspaces — DECISION: **defer** (one hook now)

Org → Teams is sufficient for the next several years. A Workspace tier (Slack Enterprise Grid) is, structurally, just **a second grouping column** (`workspace_id`) on the same tables — adding it later is **additive (a flag + a resolution rule), not a re‑tenanting**. So deferral is safe. **The one hook to add now:** channel/conversation scoping designed so a `workspace_id` can slot in without a migration of the tenant boundary. Do **not** build Workspaces — the user is right that it's unneeded abstraction today.

## 6. Team hierarchy — depth‑capped adjacency + materialized path

Keep **adjacency list (`parent_team_id`)** but add: a **hard depth cap of 5** (Org→Div→Dept→Sub→Squad covers Resulticks' `Sales→India→…` and `Eng→Python→React` with room), a **materialized `path` column** for cheap descendant/"all members under Sales" queries (adjacency alone needs recursive CTEs), **cycle prevention on move‑subtree**, and a **per‑org single‑root** constraint. Unlimited nesting is a footgun (runaway trees, unbounded recursion); 5 is a product decision, not a DB limit.

## 7. Tasks → Work Management — decouple now

Put `organization_id` on the **tenant ROOT** (a `project`/`board`), and have tasks/subtasks/checklists/deps/comments/activity **inherit** through it — **never couple the org layer to today's `tasks` schema.** A future Projects→Boards→Tasks→Automation→Timeline rewrite then **doesn't touch the org layer at all.** This satisfies "do not tightly couple Organizations to the current Task implementation."

**Generic module contract** (for CRM/Helpdesk/Wiki/KB/Whiteboards/Forms/Analytics/…): **convention, not a heavy registry** — every new module's root table gets `organization_id`, goes through the `q()` guard, uses `can()` for RBAC, and writes `audit_log`. That five‑line checklist is the "Org is the single ownership boundary" guarantee with **zero core changes** per module.

## 8. AI ownership — org‑owned, multi‑provider, encrypted

`org_ai_settings(organization_id, provider, models, mcp_servers, policies, rate_limits, prompt_library, …)` so **different orgs use different providers simultaneously**. **The headline risk (flagged): there is no secret‑encryption for AI keys today** — per‑org provider secrets must be **encrypted at rest** (versioned), DB‑resolved, with per‑org rate‑limits + audit + an MCP **tool allow‑list**. Semantic search stays MySQL‑only per the standing constraint. AI enforcement reads `req.org`.

## 9. Org administration surface — complete matrix + gaps

v1's list (Branding/Themes/Departments/Teams/Members/Roles/Permissions/Domains/SSO/SCIM/Security/Audit/Billing/Storage/Integrations/AI/API Keys/Webhooks/Marketplace/Desktop Policies) is good but **missing** what mature enterprise admin needs: **data residency, retention & legal hold, session/device management, notification/DND policy, data export/DPA, service accounts, IP allowlists.** Add these to the Org Settings roadmap.

## 10. External collaboration — shared channels break single‑org NOT NULL

The **shared channel spanning two orgs is a conversation that belongs to two tenants at once** — which directly contradicts v1 §12's `conversations.organization_id NOT NULL`. **Resolution:** conversations get a **`home_organization_id`** (owning tenant) that can be present, plus a **`conversation_orgs` join** for the multi‑tenant case, added the day shared channels ship. Do **not** bake single‑org‑NOT‑NULL on conversations — it forecloses the very feature shared‑schema was chosen to enable. Guests = **members whose visibility is purely `conversation_members`‑derived**, never a permission flag the catalog must remember to restrict (that's how Slack's multi‑channel guest is safe).

## 11. Notifications — org‑tagged, all‑org desktop delivery

Notification fan‑out is **user‑centric today** (`userRoom(uid)`, `notificationService.create` takes no org — `notificationService.ts:65`). Decision: **notifications are org‑tagged** (add `organization_id`) and **delivered for ALL of a user's orgs** (you must get a native desktop ping for Org B while active in Org A), but the **in‑app feed filters to the active org** with a cross‑org unread roll‑up. Active‑org (§1) never suppresses cross‑org delivery.

## 12. Search — CONFIRMED live cross‑org leak; scope all domains

`messages.search`/global search are **globally unscoped today** — post‑orgs this is an immediate cross‑tenant disclosure the (non‑existent) tenant repo can't catch. **All six search domains** (people, teams, messages, meetings, calendar, files, reminders, projects) scope through `organization_members`/org at the `q()` guard. UX: "this org" default, opt‑in "all my orgs" roll‑up. MySQL FULLTEXT stays; the org join must preserve `MATCH…AGAINST` relevance ordering (a per‑query rewrite, not a wrapper).

## 13. Desktop — mostly stays global

Thin shell remains sufficient. Per‑item: native notifications = **all‑org** (§11); **device registration + desktop security policies = org‑aware** (a device is enrolled *per org* for MDM/compliance); screen‑share, remote‑control, auto‑update = **global** (device‑level, no org needed). No desktop‑specific tenancy code beyond passing org context the shared web app already carries.

## 14. Migration — REVISED (supersedes v1 §12 tightening)

v1's one‑shot nullable→backfill→NOT‑NULL is **irreversible** (forward‑only runner, no down‑migrations) and its **conversation backfill is ambiguous** (a DM between a soon‑to‑be‑Resulticks user and a soon‑to‑be‑Personal user has two candidate orgs). Corrections: (1) a **dry‑run verification gate** that asserts zero `NULL` + zero ambiguous rows *before* tightening; (2) resolve ambiguous conversations by an **explicit rule** (DM's org = the initiator's primary org) decided *before* backfill; (3) **online‑DDL** (`ALGORITHM=INPLACE` / `pt-online-schema-change`) for the `NOT NULL`+FK tighten on `messages`‑scale tables (the backfill‑batching mitigation doesn't cover the DDL lock); (4) keep `users.email UNIQUE` **global** (don't org‑fold it) while org‑folding `conversations.dm_key` + `organizations.slug`; recreating the existing `dm_key` unique index is itself an under‑load DDL to schedule.

## 15. RBAC — real roles now, guests as membership

Add **`roles` + `role_permissions` tables now** (the static catalog becomes the *seed*, not the mechanism) so **named custom roles** ("Auditor", "Billing‑only") are assignable to many members — the per‑member override table is *not* a custom‑role mechanism. Resolve the **collision** between org perms (`manage_meetings`) and existing resource checks (meeting host at `socket.ts:71`): decide explicitly whether org‑perm overrides host‑control (document it, or `manage_meetings` is a lie). Two authz systems (`can()` + legacy ad‑hoc SQL) will coexist — plan the convergence, don't leave it accidental.

---

## 16. The three decisions that cost the most if wrong now

1. **Where org context lives** — off the session; request/connection (humans) + credential (machines) + row (background). Getting this wrong = re‑plumbing every service later (most expensive retrofit).
2. **Real isolation vs believed‑magic** — `q()` interceptor + hot‑table `organization_id` denormalization, not a repo factory that can't be built. The difference between a provable boundary and a cross‑tenant‑leak headline.
3. **Identity/tenancy split** — global auth identity vs org‑owned principals `(org_id, external_id)` + E2EE residency tag. A near‑free schema fork today, effectively impossible after millions of cross‑org rows.

---

## Revised Phase 0 (buildable, still invisible to users)

Fold the corrections in **before** the first backfill: create `organizations` (with the full status enum) + `organization_members` (with the ≥1‑active‑owner invariant) + `teams` (depth‑cap 5, `path`) + `organization_principals`; add nullable `organization_id` + composite indexes to DIRECT tables **and hot INHERIT tables**; add `active_org_id` to sessions **as a default only**; ship the **`q()` interceptor in CI**; make **`DELETE /account` org‑aware**; the **dry‑run‑gated, ambiguity‑resolved** backfill seeding Resulticks + 44 teams + Personal orgs. No user‑visible change; the three expensive decisions are now correct from row zero.

**Recommendation to the approver:** approve the *model* and this addendum. Do **not** approve v1 §5/§7/§12 as written — they're superseded here. On your two open decisions: **guests = membership‑visibility, not a role flag** (§10), and I'll mirror the **official Resulticks division chart** when you provide it (else the proposed rollup seeds it). With that, Phase 0 is buildable.
