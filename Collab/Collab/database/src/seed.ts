import config from "../../config/src";
import { getDb } from "./index";
import { seedDemo } from "../seeds/demo.seed";

// ── SAFETY RAIL (data-loss prevention) ──────────────────────────────────────
// seedDemo upserts 7 FIXED demo accounts via `INSERT ... ON DUPLICATE KEY UPDATE`
// on the UNIQUE email, and injects demo conversations/messages. Run against the
// LIVE database it would OVERWRITE any real account holding a demo email
// (you@/emily@/marcus@/priya@/david@/lena@colab.app), reset its password to the
// demo hash, and pollute live data. So this standalone CLI seeder must guard
// itself: only ever seed a DEMO, EMPTY target. The production container boot
// path is already safe (it uses the guarded seedIfNeeded in backend platform.ts).
// NEVER run `npm run db:seed` / scripts/db.sh against a live DATABASE_URL.
(async () => {
  const db = getDb(config);
  // 1) Refuse unless this is explicitly a demo target.
  if (!config.features.demoMode) {
    console.error(
      "[seed] 🚫 REFUSING to seed: DEMO_MODE is not enabled.\n" +
        "       This tool overwrites fixed demo accounts and injects demo data — it\n" +
        "       must NEVER run against a live/production database. Set DEMO_MODE=yes\n" +
        "       to seed a demo workspace.",
    );
    if (db.pool) await db.pool.end();
    process.exit(1);
  }
  // 2) Even in demo mode, refuse if the target already has accounts (re-seeding a
  //    populated DB would clobber/clash) UNLESS FORCE_SEED=true is explicitly specified.
  const force = process.env.FORCE_SEED === "true" || process.env.FORCE_SEED === "yes" || process.env.FORCE_SEED === "1";
  const existing = await db.users.list();
  if (existing.length > 0 && !force) {
    console.error(
      "[seed] 🚫 REFUSING to seed: target already has " +
        existing.length +
        " account(s).\n" +
        "       Re-seeding would overwrite existing data. Set FORCE_SEED=true if you intend to re-seed.",
    );
    if (db.pool) await db.pool.end();
    process.exit(1);
  }
  // Legitimate case: DEMO_MODE=yes + empty demo DB → seed as before.
  const r = await seedDemo(db);
  console.log("[seed] demo data loaded:", r, "driver:", db.driver);
  if (db.pool) await db.pool.end();
  process.exit(0);
})().catch((e) => {
  console.error("[seed] failed:", e);
  process.exit(1);
});
