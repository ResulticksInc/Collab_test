import { AsyncLocalStorage } from "node:async_hooks";

// Organizations — ambient, request-scoped tenant context (Phase 1 isolation).
//
// The auth middleware runs each authenticated request inside
// `orgContext.run({ orgId }, () => next())`, so ANY driver query can read the active
// tenant via `currentOrgId()` WITHOUT threading `orgId` through every
// route -> service -> method call. That threading is intractable on a hand-written
// SQL driver because methods like `getById` are called BOTH from routes (which have
// req.org) AND internally by other methods (which don't) — the "getById ripple".
//
// Background jobs / cron / firing sweeps run OUTSIDE any request -> there is no store
// -> `currentOrgId()` returns null -> those global scans stay unscoped BY DESIGN (they
// process every tenant's due rows in one locked sweep and carry each row's own
// `organization_id` forward). This matches the addendum: org context is on the
// request for humans, on the row for background jobs.
export type OrgStore = { orgId: string | null };

export const orgContext = new AsyncLocalStorage<OrgStore>();

/** The active tenant for the current async context, or null outside a request. */
export const currentOrgId = (): string | null =>
  orgContext.getStore()?.orgId ?? null;
