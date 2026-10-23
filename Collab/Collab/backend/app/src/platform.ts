// Backend platform wiring. Pulls the centralized config, shared contracts, and
// the repository layer. Application modules import from here, not from env.
import config from "../../../config/src";
import * as shared from "../../../shared/src";
import { getDb, orgContext, currentOrgId } from "../../../database/src";
import { seedDemo } from "../../../database/seeds/demo.seed";
import { ok, fail } from "../../../shared/src/http"; // response envelope (re-exported for routes)

const db = getDb(config);

// Seed the workspace when in demo mode OR when the store is empty (so a fresh
// live/in-memory backend is usable). A populated production DB is left untouched.
async function seedIfNeeded() {
  if (config.features.demoMode) {
    // Demo mode: full sample workspace. MySQL persists, so only seed an
    // empty demo database — re-seeding a populated one would duplicate/clash.
    const existing = await db.users.list();
    if (existing.length > 0) {
      console.log(
        "[seed] demo workspace already present (" +
          existing.length +
          " users) — skipping | driver:",
        db.driver,
      );
      return;
    }
    // Demo accounts share the password "demo1234" so the demo is sign-in-ready.
    const r = await seedDemo(db);
    console.log(
      "[seed] demo workspace seeded:",
      JSON.stringify(r),
      "| driver:",
      db.driver,
    );
  } else {
    // Live / production mode: start EMPTY. The first person signs up, then
    // invites teammates who sign up to claim their accounts. Everything
    // persists. Report the real account count so an empty live database is
    // obvious at boot (instead of silently 401-ing every login).
    const existing = await db.users.list();
    if (existing.length === 0)
      console.log(
        "[seed] live mode \u2014 the live database is EMPTY (0 accounts). Sign up to create the first account, or run `DEMO_MODE=yes npm run dev` for the seeded demo workspace. | driver:",
        db.driver,
      );
    else
      console.log(
        "[seed] live mode \u2014 " +
          existing.length +
          " account(s) in the live database; sign in or sign up. | driver:",
        db.driver,
      );
  }
}

export { config, shared, db, seedIfNeeded, ok, fail, orgContext, currentOrgId };

// E2EE kill switch — single source of truth for the backend.
// When false, all E2EE routes remain registered but messaging never
// requires encryption. E2EE infrastructure is preserved intact.
export const e2eeEnabled: boolean = config.e2ee.enabled;
// GAP-3: when on, device-bound JWT check fails CLOSED. See middleware/auth.ts.
export const e2eeDeviceBoundStrict: boolean = config.e2ee.deviceBoundStrict;
