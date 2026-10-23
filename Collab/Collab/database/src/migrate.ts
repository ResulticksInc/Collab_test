import config from "../../config/src";
import { ensureDatabase, migrate } from "./bootstrap";
(async () => {
  await ensureDatabase(config.database.url);
  const n = await migrate(config.database.url);
  console.log(`[migrate] applied ${n} migration file(s).`);
})().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exit(1);
});
