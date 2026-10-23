// Pretest step (npm `pretest:unit`): create + migrate the throwaway `colab_test`
// schema ONCE, serially, before `node --test` spawns the per-file test processes.
// That removes the first-run migrate race (many processes migrating an empty DB at
// once) and makes the suite deterministic. Never fails the run: if MySQL is simply
// unreachable, the suites detect that themselves and skip.
import { useTestDatabase } from "./_setup";
import { migrate } from "../../../database/src/bootstrap";

(async () => {
  const url = await useTestDatabase();
  const n = await migrate(url);
  console.log(`[test-db] colab_test ready — ${n} migration file(s) applied this run.`);
})()
  .catch((e: any) => {
    console.warn(
      "[test-db] could not prepare colab_test (suites will skip if MySQL is unreachable):",
      e?.message,
    );
  })
  .finally(() => process.exit(0));
