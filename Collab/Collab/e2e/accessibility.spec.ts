import { test, expect } from "@playwright/test";
import { gotoApp } from "./_helpers";
import AxeBuilder from "@axe-core/playwright";

test.describe("accessibility", () => {
  test("home view has no serious or critical axe violations", async ({
    page,
  }) => {
    await gotoApp(page);
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(serious).toEqual([]);
  });
});
