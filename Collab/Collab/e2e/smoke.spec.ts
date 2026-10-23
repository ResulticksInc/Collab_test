import { test, expect } from "@playwright/test";
import { gotoApp } from "./_helpers";

test("app shell renders with rail and header", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator("#rail")).toBeVisible();
  await expect(page.locator("#vdash")).toBeVisible();
  await expect(page.locator(".dash2-greet")).toContainText(/Good/);
});

test("no horizontal overflow", async ({ page }) => {
  await gotoApp(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(2);
});
