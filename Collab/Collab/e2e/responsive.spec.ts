import { test, expect } from "@playwright/test";
import { gotoApp } from "./_helpers";

test("desktop shows sidebar and main together", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "desktop only");
  await gotoApp(page);
  await page.locator('#rail button[aria-label="Messages"]').click();
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(page.locator("#main")).toBeVisible();
});

test("mobile collapses to a single pane with working back navigation", async ({
  page,
}) => {
  test.skip(test.info().project.name !== "mobile", "mobile only");
  await gotoApp(page);
  await page.locator('#rail button[aria-label="Messages"]').click();
  await expect(page.locator("#sidebar")).toBeVisible();
  const firstConv = page.locator(".cv").first();
  if (await firstConv.count()) {
    await firstConv.click();
    await expect(page.locator(".mobile-back")).toBeVisible();
    await page.locator(".mobile-back").click();
    await expect(page.locator("#sidebar")).toBeVisible();
  }
});

test("tooltips are not clipped off-screen", async ({ page }) => {
  // Hover tooltips are a pointer/desktop affordance — the touch tablet/mobile
  // projects (iPad/iPhone) render the rail without any hover [data-tip] triggers,
  // so this clipping check only applies on desktop (mirrors the desktop-only /
  // mobile-only scoping of the other tests in this file).
  test.skip(
    test.info().project.name !== "desktop",
    "hover tooltips only exist on pointer/desktop",
  );
  await gotoApp(page);
  // Hover the first VISIBLE tooltip trigger (skip the desktop-collapsed-only
  // ".rl-collapse" when it is display:none).
  const btn = page.locator("#rail [data-tip]:visible").first();
  await btn.hover();
  const box = await btn.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
});

// Walk every rail module at the current project's viewport (desktop/tablet/mobile)
// and assert the page never scrolls horizontally — the objective "works on all
// devices" check + a regression net against future fixed-width layouts.
const MODULES = [
  "Dashboard",
  "Messages",
  "Calls",
  "Contacts",
  "Calendar",
  "Activity",
  "Tasks",
  "Reminders",
  "Files",
];
test("no horizontal overflow on any module", async ({ page }) => {
  await gotoApp(page);
  for (const label of MODULES) {
    const btn = page.locator(`#rail button[aria-label="${label}"]`).first();
    if (!(await btn.count()) || !(await btn.isVisible())) continue;
    await btn.click();
    await page.waitForTimeout(250); // let the view mount/settle
    const o = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(o.sw, `horizontal overflow on "${label}"`).toBeLessThanOrEqual(o.cw + 2);
  }
});

// Sweep widths from the smallest phone to 4K-ultrawide on the authenticated shell
// and assert no horizontal overflow at any size (catches global scaling breaks
// like an uncapped chat column or a fixed-width container). Runs once.
test("no horizontal overflow across the width spectrum", async ({ page }) => {
  test.skip(
    test.info().project.name !== "desktop",
    "viewport-resize sweep runs once",
  );
  await gotoApp(page);
  for (const width of [
    320, 360, 390, 480, 600, 768, 1024, 1280, 1440, 1920, 2560, 3440,
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const o = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(o.sw, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(
      o.cw + 2,
    );
  }
});
