# Collab — Enterprise Multi‑Tenant Organizations Architecture

**Status:** Design & validation — **NO CODE until approved.**
**Author:** architecture review grounded in `database/migrations/0001..0066`, `backend/app/src`, `frontend/app/src`, `desktop/`.
**Scope:** Introduce **Organization** as the top‑level tenant entity (Slack Enterprise Grid / MS Teams / Google Workspace model) without breaking existing users.

---

## 0. TL;DR — the verdict

1. **Adopt shared‑schema, row‑level multi‑tenancy** (`organization_id` column on tenant‑root tables in the one MySQL DB). This is the correct model for Collab's scale and feature set — **not** schema‑per‑tenant or DB‑per‑tenant. Reasoning in §2.
2. **`users` stays GLOBAL — it does NOT get an `organization_id` column.** Membership is a join table. This is the single most important correction to the proposal: a user column would hard‑bind one user to one org and make multi‑org membership (an explicit requirement) impossible to add later without a rewrite.
3. **`conversations` is the keystone.** Adding `organization_id` there (and to the other ~15 content roots) tenants the entire messaging graph by inheritance. Messages, members, reactions, files inherit org through it.
4. **Active org lives on the session row (`auth_sessions.active_org_id`), not in the JWT.** This is what makes "switch org without re‑login, per device, revocable" work — and it reuses the `#66` session infrastructure you already shipped.
5. **Org context is injected in ONE place** (auth middleware → `req.org`) and enforced by a **request‑scoped, tenant‑bound repository** so individual queries never pass `organization_id` manually and can't leak across tenants.
6. **Departments = Teams, and Teams are a self‑referential tree** (`parent_team_id`). The real Resulticks org chart (`Sales – India/USA/SEA/…`) proves nesting is mandatory from day one.
7. **Migration is zero‑orphan:** every existing user gets a **Personal Organization**; all their existing data is backfilled into it in one additive, idempotent migration. Nothing is ever orphaned.
8. Everything else (SSO, SCIM, domain auto‑join, org switching UI, guests, per‑org AI, audit, billing) is **designed for now, built later** — the schema and auth seams below make each a bounded feature, not a rewrite.

---

## 1. Current architecture (grounded facts)

| Area | Reality today | Consequence for org work |
|---|---|---|
| **DB** | Single MySQL, 43 tables, raw SQL migrations `0001..0066`. Root PKs are `VARCHAR(36)` UUIDs from app `genId()` (`mysql.ts:5,23`). Collation `utf8mb4_unicode_ci` (`bootstrap.ts:82`). | `organizations.id` follows the same UUID pattern. Collation is **case+accent‑insensitive** → org‑scoped unique keys need care (§4). |
| **Migration runner** | `bootstrap.ts:217‑307`: filename‑ordered, run‑once via `schema_migrations`, statement‑level, swallows "already applied" errnos. No `ADD COLUMN IF NOT EXISTS`. | Org migrations must be additive + idempotent. **Data backfills are NOT errno‑protected** → must be self‑guarded (`WHERE organization_id IS NULL`), like `0063:110` and `0064:41` already are. |
| **Soft‑delete** | Post‑`0046` everything is soft‑deleted with explicit driver‑side cascades (`mysql.ts:483‑499`), not FK CASCADE. | `organization_id` FKs should be `RESTRICT`/`SET NULL`; org teardown is an explicit service, matching the pattern. |
| **Auth** | JWT `{sub,name,jti,deviceId?}` (`authService.tokenFor`), permissive middleware (`middleware/auth.ts`), durable 30‑day session rows (`auth_sessions`, `#66`) with revocation. | The session row is the natural home for **active org** (§5). |
| **AuthZ** | Ad‑hoc: `users.role`, per‑resource `created_by`/owner checks, meeting host checks. No RBAC, no tenant boundary. | Replace with org‑scoped RBAC (§6) — additively, without breaking meeting/host logic. |
| **Realtime** | Socket.IO rooms are **org‑agnostic** (per‑conversation / per‑user). | Rooms must become org‑scoped (`conv:<org>:<cid>`) to prevent cross‑tenant broadcast leaks (§7). |
| **Frontend** | God‑component `CoLabV1.tsx` bootstraps user/context; `Rail.tsx` brand header; Settings module. | Org Switcher = the Rail brand block; Org Settings = new Settings sections (§8). |
| **Desktop** | Thin Electron shell over the **same** web bundle. | Org context flows automatically — **zero desktop‑specific tenancy code** (§9). |
| **Tenant boundary** | **None exists.** Zero `organization/tenant/workspace` tables in all 66 migrations. | Greenfield — no legacy tenant model to unwind. |

---

## 2. Multi‑tenancy model — decision & validation

**Three candidate models:**

| Model | What it is | Verdict for Collab |
|---|---|---|
| **Shared schema, row‑level `organization_id`** | One DB, one schema, every tenant row tagged with `organization_id`, enforced by a query filter. | ✅ **RECOMMENDED.** |
| Schema‑per‑tenant | One DB, N schemas (one per org). | ❌ Migrations × N schemas; the run‑once ledger breaks; cross‑org features (guests, shared channels) become impossible. |
| DB‑per‑tenant | Physical DB per org. | ❌ Massive ops overhead; kills the current single‑DB deploy; only justified at bank/health‑record isolation levels Collab doesn't need yet. |

**Why shared‑schema is correct here (validating your proposal — you were right on this):**

- **Operational continuity.** Collab is one Docker MySQL with an additive‑migration convention. Row‑level tenancy keeps that unchanged — one migration path, one backup, one connection pool.
- **Cross‑org is a first‑class requirement.** Guests, a user in multiple orgs, and future shared channels **need** rows from different orgs to coexist in the same tables. Schema/DB‑per‑tenant makes those features architecturally impossible.
- **Scale is a non‑issue at this stage.** Composite indexes `(organization_id, <hot column>)` keep tenant‑filtered queries fast well into millions of rows. You can *later* shard by `organization_id` (it's the natural shard key) without a model change — the column is forward‑compatible with every heavier model.
- **Isolation is enforced in code, provably.** A tenant‑bound repository (§7) makes "forgot the `WHERE organization_id`" a structural impossibility rather than a per‑query discipline.

**Improvement over the proposal:** the proposal said *"Users should reference `organization_id`."* They must not — see §3. Membership is the join; the user is global identity.

---

## 3. Core data model

```
Collab Platform
  └── Organization (tenant)          organizations
        ├── Members (RBAC role)      organization_members (user_id × org_id)
        ├── Teams / Departments      teams (self-referential tree)
        │     └── Team members       team_members
        └── Content (org_id-scoped)  conversations, meetings, tasks, files, reminders, …
users  ── GLOBAL identity, joined to N orgs via organization_members
```

**`organizations`** (the full field set from your spec — name, logo, slug, description, brand_color, timezone, language, country, website, support_email, industry, status, plan, storage_quota, created_by, created_at) plus `is_personal TINYINT` (marks the auto‑created Personal org) and the soft‑delete trio. `slug UNIQUE` (URL/subdomain key). PK `VARCHAR(36)`.

**`organization_members`** — the DIRECT tenant‑root of the whole model. Composite PK `(organization_id, user_id)`, `role` (owner|admin|manager|member|guest), `status` (active|invited|suspended), soft‑delete. Two indexes: `(user_id, deleted)` = "which orgs am I in" (org switcher), `(organization_id, role, deleted)` = "list this org's admins". This mirrors the proven `conversation_members` shape (`0001:22`).

**`teams`** (= departments) — `id, organization_id, parent_team_id NULL, name, slug, lead_user_id, created_at, soft-delete`, `UNIQUE(organization_id, slug)`. **Self‑referential** so `Sales → Sales – India` nests to any depth. `team_members(team_id, user_id, role)` — a person can be in several teams. Member counts are **derived**, never stored as truth.

---

## 4. Database impact — table classification

Every table is one of: **DIRECT** (gets `organization_id`), **INHERIT** (derives org via a parent FK — no own column, avoids redundant storage), **GLOBAL** (no tenancy).

| Classification | Tables (grounded) | Rationale |
|---|---|---|
| **GLOBAL** | `users`, `e2ee_devices` & all `e2ee_*`, `push_subscriptions`, `schema_migrations`, `deploy_state`, `client_errors` | Identity & cryptographic device state are cross‑org; E2EE stays **server‑blind** and must not gain a tenant column that could leak the social graph. |
| **DIRECT** (add `organization_id`) | `conversations` (0001:13) ⭐, `meetings` (0002:10), `tasks` (0004), `files` (0008), `reminders` (0003), `folders` (0003), `calls` (0003:22), `notifications` (0028), `task_projects` (0063), `invites` (0007), `user_blocks`/`user_reports` (0031, nullable), `audit_log` (0001:47) | Tenant‑root content/config. `conversations` ⭐ is the keystone — its `organization_id` tenants the entire message graph by inheritance. `meetings` can't reliably inherit (`created_by`/`conversation_id` both nullable, 0002:15) so it's DIRECT. |
| **INHERIT** (no column) | `messages`, `conversation_members`, `message_deletions`, `bookmarks`, `scheduled_messages` → via `conversation_id`; `meeting_*` (attendees, presence, lobby, ejected, messages, recordings, reminders_sent) → via `meeting_id`; `task_*` (activity, deps, comments, assignees, watchers, attachments, saved_views) → via `task_id`; `file_shares` → via `file_id`; `voicemails` → via `files` | Deriving org through the parent FK avoids denormalized storage + double‑write bugs. Enforced by the tenant repo joining to the parent. |

**Indexing:** composite `(organization_id, <hot column>)` on every DIRECT table — e.g. `(organization_id, updated_at)` for conversation lists, `(organization_id, due_at)` for reminders/tasks firing. Add **before** backfill so the backfill `UPDATE` and all subsequent scoped reads are indexed.

**Collation hazard (real):** `utf8mb4_unicode_ci` is case+accent‑insensitive. Any unique key that must become **per‑org** — `organizations.slug`, and existing global uniques like `conversations.dm_key` (0035) — needs the org prefix folded in (`UNIQUE(organization_id, dm_key)`), and slug generation must normalize for the insensitive collation to avoid "Acme" vs "acme" collisions.

**FKs:** `organization_id` → `organizations(id)` as `RESTRICT` (or `SET NULL` for optional ones); org teardown is an explicit soft‑delete cascade service, consistent with the post‑`0046` pattern (`mysql.ts:483`).

---

## 5. Authentication & org context

**Where does `organization_id` come from on each request?** Four options were weighed:

| Source | Problem |
|---|---|
| JWT `org` claim | Token is immutable for its TTL → switching orgs would need a re‑mint every switch; revoking access to an org can't take effect until expiry. Bad for multi‑org. |
| Request header `X‑Colab‑Org` | Client‑asserted → trivially spoofable; still needs a membership check every request anyway. |
| **Session row `auth_sessions.active_org_id`** | ✅ **RECOMMENDED.** |
| Re‑derive from data | Impossible when a user is in multiple orgs. |

**Recommendation — active org on the session (Option C):** add `active_org_id` to the `auth_sessions` row (`#66`). It is *session‑scoped, mutable, server‑authoritative, per‑device, and already revocable* — exactly what "switch without re‑login, per device" demands. Switching orgs = one `UPDATE auth_sessions SET active_org_id=? WHERE id=?` (no token change). The JWT stays `{sub, jti}`; the middleware resolves org from the session.

**One‑place injection.** Extend the existing auth middleware: after it validates the session (`#66`), it loads `active_org_id`, **verifies the caller is an active member of that org** (`organization_members`), and sets `req.org = { id, role, permissions }`. Every downstream route reads `req.org` — **no route ever accepts `organization_id` as a parameter.** A non‑member's forged/stale active org → `403`, fail‑closed for authz (distinct from the fail‑*open* posture of the session‑liveness check, which must stay fail‑open so infra blips don't lock everyone out).

**Login flow unchanged.** Existing login keeps working; on login the session's `active_org_id` defaults to the user's Personal org (or last‑used). Legacy tokens with no session still work (permissive), landing in the Personal org.

**SSO/SCIM seam (design only):** `identity_providers(org_id, type, config)` and `org_domains(org_id, domain, verified)` tables, plus an `auth_method` on the member. Nothing built now — but the middleware's "resolve identity → resolve org membership → resolve permissions" order is already the SSO/SCIM shape.

---

## 6. RBAC strategy

**Today:** ad‑hoc `users.role` + owner/host checks scattered across services — insufficient (not org‑scoped, not granular, not extensible).

**Proposed:**
- **Roles** are org‑scoped, stored on `organization_members.role`: `owner | admin | manager | member | guest`.
- **Permissions** are a **role → permission catalog** (primary mechanism) — a static map (`owner` ⊇ `admin` ⊇ `manager` ⊇ `member` ⊇ `guest`) covering the granular set from your spec: `manage_users, manage_roles, manage_meetings, manage_calendar, manage_files, manage_tasks, manage_ai, manage_apps, manage_integrations, manage_security, manage_audit_logs, manage_billing, manage_sso, manage_domains`.
- **Extensibility escape hatch:** an optional `organization_member_permissions(org_id, user_id, permission, allow)` override table for per‑member grants/denials — so custom roles and one‑off exceptions never require a schema change.
- **Enforcement:** a single helper `can(userId, orgId, permission)` resolving `role catalog ∪ overrides`, computed once in the middleware into `req.org.permissions`, checked at route entry. Meeting host / conversation‑owner checks are **kept** and layered *inside* the org boundary (host control is resource‑scoped, not org‑scoped) — so calls/meetings behavior is unchanged.
- **Guests:** `role='guest'` = a real member with a minimal permission set (join specific conversations/meetings they're invited to, no management perms). Models external clients/vendors/contractors **inside** an org without a separate account type.

**Decision needed from you (raised earlier):** guests as a restricted role inside Resulticks, **or** external parties as their own lightweight orgs with cross‑org shared channels. Recommendation: **restricted role inside the org** for v1 (simpler, matches Slack's "multi‑channel guest"); promote to cross‑org shared channels only when a second real tenant exists.

---

## 7. Backend & realtime impact

- **Systematic scoping, not per‑query edits.** Introduce a **request‑scoped, tenant‑bound repository factory**: `db.forOrg(req.org.id)` returns a repo whose every method injects `WHERE organization_id = ?` (and joins to the parent for INHERIT tables). Services call the bound repo, so a missing tenant filter is structurally impossible. This is far safer than hand‑editing hundreds of queries and is the single highest‑leverage isolation decision.
- **Realtime isolation.** Socket rooms are org‑agnostic today → a cross‑tenant leak risk. Namespace rooms with the org: `conv:<org>:<cid>`, `user:<org>:<uid>`, presence per org. Validate room‑join against `organization_members` (belt‑and‑suspenders). Notifications/broadcasts fan out only within the org.
- **Do NOT destabilize:** calls/meetings signalling, E2EE (stays server‑blind, GLOBAL), and the reminder **firing backbone** (`claimDue` FOR UPDATE SKIP LOCKED). These gain an `organization_id` filter on their *queries* only — their control flow is untouched. The 6 call tests + firing tests remain the guard.
- **Per‑org AI (design):** `org_ai_settings(org_id, provider, models, mcp_servers, policies, rate_limits, prompt_library)` — AI enforcement reads `req.org` so different orgs can use different providers/models. Greenfield; no AI table exists today.

---

## 8. Frontend impact (plan only)

- **Org Switcher:** convert the `Rail.tsx` brand block (`rl-brand`) into an org switcher — current org logo/name + a dropdown of the user's orgs (from `organization_members`, the `(user_id)` index). Selecting one calls the switch endpoint (updates `active_org_id`) and re‑bootstraps the app context. Placement is already the natural top‑of‑rail slot.
- **Org Settings** maps onto the existing Settings module as new sections, gated by `req.org.permissions`: **Members · Roles & Permissions · Teams/Departments · Branding · Security · Domains · SSO · Billing · Audit Logs · Apps/Integrations · Storage.**
- **Branding → theming:** an org's `brand_color`/`logo` flow into the existing `--ac`/logo system (the same variables the brand gradient + rail logo already use), so per‑org theming is a data change, not new plumbing.
- **Context flow:** the active org id lands in the bootstrap payload, threads through `lib/api.ts` (already same‑origin) and the socket connect handshake — no per‑request org passing on the client either.

---

## 9. Desktop impact

**Effectively zero.** The Electron app is a thin shell over the *same* web bundle (`desktop/` wraps the Next app). Org context is server‑session state resolved by the shared frontend, so it flows into Electron automatically — **no duplicated implementation, no desktop‑specific tenancy code.** The only desktop touchpoint is that the secure‑token store (`#66` keychain) already keys on the session, which now carries `active_org_id`.

---

## 10. Teams / Departments + Resulticks seed

The Teams layer (§3) is validated by the **real Resulticks org chart** (44 departments, ~322 people). Key structural facts it forces:
- **Nesting is mandatory** — `Sales – India/USA/SEA/Global/MEIA/Operations` is an explicit parent→child; engineering disciplines (ReactJS, Python, Mobile, Database, DevOps, …) roll up under Product/Engineering. → `parent_team_id`, arbitrary depth.
- **Department ≡ Team** (depth‑1 under the org); no separate entity.
- **Seed data (not lorem):** the migration that creates the **Resulticks** org also seeds these 44 teams in the reviewed tree. The 4 without headcount (`Documentation, API, Management, Product Management`) seed as **empty teams**.

*(Full proposed department tree is in the chat thread / to be attached; division rollups beyond `Sales` are a proposal pending your official Resulticks division chart.)*

---

## 11. Future‑readiness — designed, NOT built

| Capability | Seam that makes it a feature, not a rewrite |
|---|---|
| **SSO (Entra/Google/Okta/Keycloak/Auth0, SAML/OIDC)** | `identity_providers(org_id, …)`; middleware already does identity→membership→permissions. |
| **SCIM provisioning** | `organization_members.status` (invited/active/suspended) + `auth_method`; SCIM = automated writes to members. |
| **Domain auto‑join** | `org_domains(org_id, domain, verified)`; signup checks verified domain → auto‑add membership. |
| **Org switching w/o logout** | `auth_sessions.active_org_id` (§5) — the switch is one UPDATE. |
| **Guests / external** | `role='guest'` restricted permission set (§6). |
| **Per‑org AI** | `org_ai_settings` (§7). |
| **Audit / Legal Hold / DLP / Retention** | `audit_log` already append‑only (`0018` triggers) + DIRECT `organization_id`; retention = org‑scoped soft‑delete sweep. |
| **Billing / Plans / Quota** | `organizations.plan` + `storage_quota`; enforced in the tenant repo on file writes. |
| **API keys / Webhooks / Apps / Marketplace** | `org_api_keys`, `org_webhooks`, `org_apps` — all DIRECT `organization_id`, same pattern. |

None of these require touching the core once §3–§7 land.

---

## 12. Migration strategy — zero orphan

1. **Additive schema** (one migration): create `organizations`, `organization_members`, `teams`, `team_members`; add `organization_id` (nullable first) + composite indexes to every DIRECT table; add `auth_sessions.active_org_id`.
2. **Backfill (self‑idempotent, `WHERE organization_id IS NULL`):**
   - For the internal deployment: create the **Resulticks** org, seed its teams, and add every existing user as a member (role inferred from current `users.role`; the account owner = `owner`).
   - For any *other* existing user not mapped to Resulticks: create a **Personal Organization** (`is_personal=1`) and add them as `owner`.
   - Backfill every DIRECT table's `organization_id` from the owning user/conversation (`conversations` first, then everything that inherits from it).
   - Default each session's `active_org_id` to the user's primary org.
3. **Tighten** (a later migration, once backfill is verified): make `organization_id` `NOT NULL` and add the FKs.
4. **Guarantee:** the backfill is guarded so re‑runs are no‑ops (matching `0063/0064`); nothing is ever left `NULL` → **no orphans**, and the app keeps working at every step (nullable → populated → enforced).

---

## 13. Risks & breaking changes

| Risk | Mitigation |
|---|---|
| A query forgets the org filter → cross‑tenant leak | Tenant‑bound repo (§7) makes it structurally impossible; add a test that asserts scoped repos always inject the filter. |
| Realtime broadcast leaks across orgs | Org‑namespaced rooms + join validation (§7). |
| Per‑org unique constraints under case‑insensitive collation | Fold `organization_id` into uniques; normalize slugs (§4). |
| Backfill on a large table locks/times out | Batched, indexed‑first, idempotent backfill; run in the off‑box migration window. |
| E2EE gaining a tenant column leaks the social graph | E2EE stays GLOBAL/server‑blind (§4). |
| Meeting/host/call authz regressions | Keep resource‑scoped host checks *inside* the org boundary; the 6 call tests + firing tests guard it. |
| Legacy tokens (no session) after rollout | Permissive path routes them to the Personal org; unchanged login. |

---

## 14. Recommended implementation phases

- **Phase 0 — Foundation (schema + migration).** `organizations`, `organization_members`, `teams`; `organization_id` nullable + indexes; backfill Resulticks + Personal orgs; zero‑orphan verify. *No behavior change yet.*
- **Phase 1 — Context & isolation.** `active_org_id` on session; middleware `req.org`; tenant‑bound repo; org‑namespaced sockets. *This is the security‑critical phase — thorough adversarial verification.*
- **Phase 2 — RBAC.** Role catalog + `can()`; map existing admin/host checks into the org boundary; guest role.
- **Phase 3 — Org UI.** Org Switcher (Rail) + Org Settings surfaces (Members/Roles/Teams/Branding); per‑org branding → theming.
- **Phase 4 — Teams/Departments UX.** Team tree management, membership, org chart view (seeded with Resulticks).
- **Phase 5+ — Enterprise (as sold).** SSO → SCIM → domain auto‑join → billing/quota → audit/retention → per‑org AI → apps/webhooks. Each is now a bounded feature on the seams above.

Ship Phase 0–1 behind the scenes (invisible to users, everyone in their Personal/Resulticks org); expose Phase 3 UI only when multi‑org is real.

---

## 15. Where this improves on the proposal

1. **`users` is GLOBAL, not org‑columned** — the one change that preserves multi‑org (the proposal would have blocked it).
2. **Active org on the session, not the JWT** — enables switch‑without‑relogin + instant revocation, reusing `#66`.
3. **Department = hierarchical Team** — driven by the real Resulticks chart; avoids a redundant Department entity and a painful "add nesting later".
4. **Tenant‑bound repository** — turns tenant isolation from per‑query discipline into a structural guarantee.
5. **Explicit INHERIT classification** — avoids denormalized `organization_id` on 20+ child tables (no double‑write bugs), per your "avoid redundant storage" directive.
6. **Phased, invisible rollout** — Phase 0–1 ship with zero user‑visible change, de‑risking the largest architectural move in the product's life.

**Nothing here is implemented.** On your approval of this architecture (and the two open decisions — official Resulticks division rollup, and guest‑as‑role vs guest‑as‑org), Phase 0 becomes the first buildable unit.
