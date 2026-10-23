import { test } from "node:test";
import assert from "node:assert/strict";

// DRIVER PARITY.
//
// The app is written against ONE repository interface with two implementations:
// MySQL (production) and JSON (local dev, no Docker). Nothing enforced that they
// stayed in step, so the JSON driver drifted until it implemented under half the
// surface — and the symptom was an opaque `TypeError: db.x.y is not a function`
// at runtime, which reads like an application bug rather than a missing driver
// method.
//
// This test does two things:
//   1. Pins the CURRENT gap. If it grows, this fails — so a new MySQL method
//      cannot be added without either implementing the JSON side or making a
//      deliberate decision to widen the gap.
//   2. Guarantees the failure mode stays honest: anything unimplemented must
//      throw the JSON_DRIVER_UNSUPPORTED error naming the method, never return
//      undefined and corrupt data downstream.
//
// Lowering BASELINE as methods get implemented is the point — it should only
// ever go down.

// Methods present in MySQL but not JSON. Started at 187; core messaging and
// meetings were implemented, bringing it to 161. Only ever lower this.
const BASELINE = 161;

function methodsOf(repo: any): string[] {
  if (!repo || typeof repo !== "object") return [];
  return Object.keys(repo).filter((k) => typeof repo[k] === "function");
}

test("the JSON driver's gap against MySQL does not grow", async () => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || "mysql://colab:colab@127.0.0.1:3306/colab_parity";
  const cfg = (await import("../../../config/src")).default;
  const { createMysqlDb } = await import("../../../database/src/drivers/mysql");
  const { createJsonDb, IMPLEMENTED } = await import("../../../database/src/drivers/json");

  const my: any = createMysqlDb(cfg);
  const js: any = createJsonDb(cfg);

  const gaps: Record<string, string[]> = {};
  let total = 0;
  for (const name of Object.keys(my)) {
    if (name === "pool" || name === "driver") continue;
    const mine = my[name];
    if (!mine || typeof mine !== "object" || Array.isArray(mine)) continue;
    // The JSON repo is Proxy-wrapped and answers EVERY property with a function,
    // so typeof can't distinguish implemented from guarded — ask the proxy for
    // its real method list instead.
    const theirs = js[name];
    const have: string[] = theirs ? theirs[IMPLEMENTED] || [] : [];
    const real = methodsOf(mine).filter((m) => !have.includes(m));
    if (real.length) {
      gaps[name] = real;
      total += real.length;
    }
  }

  await my.pool?.end?.().catch(() => {});

  const summary = Object.entries(gaps)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([r, list]) => `  ${r} (${list.length}): ${list.join(", ")}`)
    .join("\n");

  assert.ok(
    total <= BASELINE,
    `The JSON driver fell further behind MySQL: ${total} missing, baseline ${BASELINE}.\n` +
      `Implement the new method in database/src/drivers/json.ts, or raise BASELINE deliberately.\n${summary}`,
  );
  if (total < BASELINE)
    console.log(
      `[parity] JSON driver gap is now ${total} (baseline ${BASELINE}) — lower BASELINE to lock the win in.`,
    );
});

test("an unimplemented JSON method fails loudly, never silently", async () => {
  const cfg = (await import("../../../config/src")).default;
  const { createJsonDb } = await import("../../../database/src/drivers/json");
  const js: any = createJsonDb(cfg);

  // A silent undefined here is the dangerous case: the caller would carry on
  // with missing data and corrupt something far from the real cause.
  assert.throws(
    () => js.tasks.logActivity({}),
    (e: any) =>
      e.code === "JSON_DRIVER_UNSUPPORTED" &&
      e.status === 501 &&
      /db\.tasks\.logActivity/.test(e.message) &&
      /DATABASE_DRIVER=mysql/.test(e.message),
    "the error must name the method and say how to fix it",
  );

  // And an implemented method must still work untouched through the guard.
  assert.equal(typeof js.users.list, "function");
  assert.ok(Array.isArray(await js.users.list()));
});
