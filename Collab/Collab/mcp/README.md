# CoLab MCP Server

A production-grade **Model Context Protocol** server that securely exposes CoLab
capabilities to AI assistants. It is a **thin, secure orchestration layer** over
the existing CoLab backend — it adds no privileged data path and duplicates no
business logic. Every action is performed _as the authenticated user_, and the
CoLab backend enforces all authentication, membership, and authorization.

```
AI assistant ──MCP(JSON-RPC)──▶ colab-mcp ──HTTP(Bearer JWT)──▶ CoLab backend ──▶ MySQL
   (Claude, etc.)                (this pkg)     existing REST API + services
```

---

## 1. Architecture overview

| Layer             | File(s)                                     | Responsibility                                                                                                                                      |
| ----------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transports**    | `transports/stdio`, `transports/sse` (HTTP) | Speak MCP JSON-RPC 2.0. stdio = single-user desktop clients; HTTP = multi-user remote clients (per-request Bearer).                                 |
| **Dispatch**      | `dispatch.ts`                               | The whole MCP protocol: `initialize`, `ping`, `tools/*`, `resources/*`, `prompts/*`, error envelopes. Transport-agnostic.                           |
| **Auth boundary** | `auth/jwt.ts`                               | Local HS256 verification of the CoLab JWT (defense-in-depth) → resolves `userId`/`tenant` for scoping + audit. Backend re-verifies authoritatively. |
| **Validation**    | `validation/schema.ts`                      | Dependency-free JSON-Schema validator + sanitizer. Default-deny unknown keys, type coercion, bounds, control-char stripping.                        |
| **Audit**         | `audit/logger.ts`                           | Structured audit log to **stderr** (stdout is the protocol channel). Logs who/what/when/resource/outcome/duration — never content or tokens.        |
| **Gateway**       | `server/gateway.ts`                         | The ONLY bridge to CoLab — HTTP with the user's Bearer token, timeouts, concurrency bound, redacted error mapping, binary upload.                   |
| **Tools**         | `tools/*.ts`                                | 32 tools across 8 feature areas, each mapped to a real REST endpoint.                                                                               |
| **Resources**     | `resources/index.ts`                        | 8 collection resources + 2 URI templates, paginated.                                                                                                |
| **Prompts**       | `prompts/index.ts`                          | 7 reusable prompt templates that orchestrate tools.                                                                                                 |

**Why an HTTP gateway and not direct DB/service access?** It guarantees the MCP
server can never bypass a permission check: the backend's existing middleware and
service-layer membership gates (`assertMember` → 403, device-bound JWT revocation,
rate limiting) apply to every MCP-driven action automatically. Zero duplicated
authorization logic = zero drift.

---

## 2. Tool inventory (32 tools)

**Messaging** — `list_conversations`, `list_messages`, `search_messages`,
`send_message`, `reply_message`, `conversation_summary`
**Contacts** — `list_contacts`, `search_contacts`, `contact_details`, `frequent_contacts`
**Calendar** — `list_events`, `create_meeting`, `update_meeting`, `cancel_meeting`
**Meetings** — `upcoming_meetings`, `meeting_details`, `join_information`
**Tasks** — `list_tasks`, `create_task`, `assign_task`, `update_status`, `update_task`
**Files** — `list_files`, `search_files`, `file_metadata`, `download_file`, `upload_file`
**Activity** — `recent_activity`, `unread_activity`
**Reminders** — `upcoming_reminders`, `create_reminder`
**Search** — `global_search`

Every tool carries a strict JSON schema, input validation + sanitization,
permission-by-pass-through, audit logging, structured responses, and annotations
(`readOnlyHint` / `destructiveHint` / `idempotentHint`).

## 3. Resources

Collections (fixed URI): `colab://conversations`, `colab://tasks`,
`colab://meetings`, `colab://files`, `colab://contacts`, `colab://activity`,
`colab://reminders`, `colab://notifications`.
Templates: `colab://conversations/{conversationId}/messages`,
`colab://conversations/{conversationId}/thread/{messageId}`.
All reads are paginated and scoped to the requester by the backend.

## 4. Prompt templates

`daily_summary`, `meeting_summary`, `task_summary`, `unread_messages`,
`project_status`, `upcoming_meetings`, `recent_activity` — each instructs the
assistant to call the relevant tools (no duplicated logic).

---

## 5. Running

```bash
# stdio (desktop MCP client) — token via env:
COLAB_MCP_TOKEN=<jwt> COLAB_API_BASE_URL=http://localhost:4000 npm --workspace mcp start

# HTTP (multi-user) — token per request (Authorization: Bearer <jwt>):
COLAB_API_BASE_URL=http://localhost:4000 npm --workspace mcp run start:http
# → POST http://localhost:4015/mcp   GET /mcp/capabilities   GET /healthz
```

### Configuration (all via env)

| Var                                           | Default                 | Purpose                          |
| --------------------------------------------- | ----------------------- | -------------------------------- |
| `COLAB_API_BASE_URL` / `BACKEND_INTERNAL_URL` | `http://localhost:4000` | Backend origin                   |
| `COLAB_MCP_PORT`                              | `4015`                  | HTTP transport port              |
| `COLAB_MCP_TOKEN`                             | —                       | Default bearer for stdio         |
| `AUTH_JWT_SECRET`                             | —                       | Enables local HS256 verification |
| `COLAB_MCP_VERIFY_JWT`                        | `true`                  | Toggle local verification        |
| `COLAB_MCP_TIMEOUT_MS`                        | `15000`                 | Gateway timeout                  |
| `COLAB_MCP_MAX_CONCURRENCY`                   | `32`                    | In-flight backend calls cap      |
| `COLAB_MCP_MAX_PAGE`                          | `100`                   | Hard pagination ceiling          |
| `COLAB_MCP_CORS_ORIGIN`                       | `*`                     | HTTP CORS origin                 |

### Example: register with a desktop MCP client

```json
{
  "mcpServers": {
    "colab": {
      "command": "npx",
      "args": ["tsx", "mcp/app/src/index.ts"],
      "env": {
        "COLAB_MCP_TOKEN": "<user-jwt>",
        "COLAB_API_BASE_URL": "http://localhost:4000"
      }
    }
  }
}
```

---

## 6. Security model

- **Authentication** — every request needs a CoLab JWT. The HTTP transport reads
  it per request (`Authorization: Bearer`), so one process serves many users in
  isolation. Local HS256 verification rejects bad/expired tokens at the boundary;
  the backend verifies again authoritatively.
- **Authorization & tenant/resource isolation** — enforced by the backend on
  every call (membership gates, device-bound revocation, ownership). The MCP
  server holds no elevated credential and cannot widen a user's scope.
- **Input safety** — strict schemas, default-deny unknown keys, sanitization,
  size caps. Binary uploads are size-bounded.
- **No content leakage** — audit logs record identifiers and outcomes, never
  message bodies, file contents, or tokens. Errors are redacted (no stack traces,
  no backend internals).
- **Resilience** — per-call timeout, bounded concurrency, structured error
  envelopes for every failure class (auth, forbidden, not-found, rate-limit,
  unavailable, timeout).

## 7. Testing

`mcp/app/test/mcp.test.ts` (21 tests, run: `node --import tsx --test mcp/app/test/mcp.test.ts`)
covers authentication (valid/missing/tampered/expired), input validation
(defaults, default-deny, enum, coercion, control-char stripping), the protocol
surface (initialize, tools/resources/prompts lists, unknown method), tool
execution with a mocked backend (bearer forwarding = per-user isolation, invalid
input → recoverable `isError`, backend 403 → redacted `FORBIDDEN`), and resource
template parameter extraction.

## 8. Performance

Cursor/keyset pagination for messages; hard page ceilings on every list tool and
resource (`COLAB_MCP_MAX_PAGE`); serialized-payload byte cap; bounded concurrent
backend calls; per-call timeout. No tool ever loads an unbounded dataset.

## 9. Roadmap

- Streamable-HTTP **server→client SSE** streaming for long-running tool output
  (the HTTP transport currently returns a single JSON response per call).
- `resources/subscribe` live updates bridged from the backend Socket.IO events.
- True multi-tenant scoping once CoLab introduces a workspace/tenant claim in the
  JWT (the boundary already forwards `X-CoLab-Tenant` and reads a `tenantId`
  claim if present).
- OAuth 2.1 / SSO bearer issuance in front of the HTTP transport (the server is
  already pure-Bearer, so this is an edge concern, not a code change here).
- Optional swap of the hand-rolled JSON-RPC layer for `@modelcontextprotocol/sdk`
  if a runtime dependency becomes acceptable (kept dependency-free today to match
  the repo's zero-extra-infra posture).
