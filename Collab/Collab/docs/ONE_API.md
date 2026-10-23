# One API — structured-JSON DB helper (inert switch + ready client)

> **Honesty up front (state as of the live cutover, 2026-06-18):** the
> `ONE_API_ENABLED` switch is **inert at runtime**. CoLab's SQL executor
> (`database/src/drivers/mysql.ts q()`) always uses the direct MySQL pool;
> **nothing in the app imports `fetchData`/`mutate` from `oneApiClient.ts`**.
> An earlier design routed runtime SQL through the gateway at the `q()`
> chokepoint — that was rolled back because the gateway's structured-JSON
> payload cannot express CoLab's FULLTEXT / window-function / upsert /
> `FOR UPDATE` queries (and the DB team flagged it as a perf hit). The client
> matches the gateway's request/response contract and is ready to be wired
> into specific call sites; until then, flipping the switch ON is safe but
> has zero runtime effect. See `docs/ENTERPRISE_READINESS_REPORT.md` for the
> verdict and `database/src/oneApiClient.ts` for the contract.

## The switch (env)

| Env var | Default | Meaning |
|---|---|---|
| `ONE_API_ENABLED` | `false` | **Currently inert.** Reserved gate for future explicit call sites that use `oneApiClient.fetchData/mutate`. Does not affect the SQL executor. |
| `ONE_API_URL` | `""` | Gateway endpoint, e.g. `http://10.101.1.4:7988/fetch-data` |
| `ONE_API_DB_TYPE` | `mysql` | Sent in the payload |
| `ONE_API_DATABASE` | `""` | Target database name |
| `ONE_API_KEY` | `""` | Sent as `Authorization: Bearer <key>` if set |
| `ONE_API_FALLBACK` | `true` | Reserved for future use — currently unused. |
| `ONE_API_TIMEOUT_MS` | `15000` | Per-request timeout when `oneApiClient` IS called |

## How it's wired (important — it is NOT a transparent driver)

The gateway is **structured-JSON only** (confirmed): it takes
`{ db_type, database, table, columns, joins?, conditions?, … }` and an action,
NOT raw SQL. CoLab's DB driver emits complex raw SQL (joins, subqueries, window
functions, FULLTEXT, `ON DUPLICATE KEY` upserts, `FOR UPDATE`), which the
structured format **cannot express**. So One API **cannot transparently back the
driver**, and CoLab's own queries always use the direct MySQL pool (fast).

Instead, One API is an **explicit structured helper** —
[`database/src/oneApiClient.ts`](../database/src/oneApiClient.ts), exposing
`fetchData(payload)` (read) and `mutate(payload)` (write) — for the specific
calls that suit a simple structured shape (or to reach shared company data via
the gateway). It is gated by `ONE_API_ENABLED` and throws when off. Nothing in
the app calls it yet; wire it where a structured op genuinely fits.

## ⚠️ Contract to confirm with the DB architect

The READ shape matches the shared sample. Still confirm:

1. The **WRITE contract** — how the action is specified for insert/update/delete
   (assumed `action` + `data`/`conditions` in `mutate()` — "actions will be changed").
2. **Auth header**, **endpoint path**, and the **JSON response shape**.

When known, edit **only** `oneApiClient.ts` (`fetchData`/`mutate`/`request`).

> Note: routing ALL of CoLab's data access through a structured-only gateway is
> not feasible without losing FULLTEXT/window/upsert/transaction capability — and
> the DB team flagged it as a performance hit. Hence: OFF by default, explicit
> helper only. If the architect needs full coverage, that's a separate design
> discussion (the gateway would need to accept richer/raw queries + transactions).

## What currently uses One API at runtime

**Nothing.** Every CoLab query path uses the direct MySQL pool:

- Reads/writes — `database/src/drivers/mysql.ts q()` → mysql2 pool.
- Migrations / DDL — `database/src/bootstrap.ts` → direct connection (DDL not
  possible through the structured gateway anyway).
- The two transactional paths — `calls.requestAtomic` and
  `scheduledMessages.claimDue` use `SELECT … FOR UPDATE` in a DB transaction; a
  stateless per-call gateway can't hold a transaction.

`oneApiClient.fetchData/mutate` is sitting ready, gated by `ONE_API_ENABLED`,
called by no one. Wire it where a specific structured read genuinely fits (e.g.
reaching shared company data via the gateway), then this section should be
updated to list those call sites.

## DB target by environment (local vs live)

The DB target is just `DATABASE_URL` resolved through `DB_PROFILE`:
- `DB_PROFILE=local` → `DATABASE_URL_LOCAL` (bundled MySQL container)
- `DB_PROFILE=live`  → `DATABASE_URL_LIVE` (corporate MySQL `10.101.3.2:3603`)

This is the only knob that decides where data lives. One API does not factor in.

## Testing the gateway directly (server-side only)

Until a call site uses One API, the only way to validate the gateway is to POST
to it directly from somewhere that can route to `ONE_API_URL` (the live server,
not your laptop):

```bash
curl -s -X POST "$ONE_API_URL" \
  -H 'Content-Type: application/json' \
  -d '{"db_type":"mysql","database":"colab","table":"users",
       "columns":["id","email"],"limit":1,"export":"json"}'
```

A successful response is an array (or an envelope under `.data` / `.results` /
`.rows` / `.values` / `.records`). Any other shape means the gateway contract
drifted — open `database/src/oneApiClient.ts` request/response parsing and
align.
