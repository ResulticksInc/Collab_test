import { Page, expect } from "@playwright/test";

// The app opens on a real sign-in screen. Playwright global setup prepares a
// sign-in-ready account in the existing `colab` DB, then the test logs in like
// a real user and waits for the authenticated shell.
export async function gotoApp(page: Page) {
  await page.goto("/");
  const email = page.locator('input[name="email"]');
  const password = page.locator('input[name="password"]');
  await email.waitFor({ state: "visible" });
  // The login form is a hydrated React controlled component. A fill() that lands
  // before hydration completes gets reset to "" by React's first render, which
  // then submits an empty email → "Invalid email or password" (seen as flaky
  // login timeouts on the slower tablet/mobile projects against `next dev`).
  // Retry fill-and-verify until the values actually stick (i.e. hydration is
  // done) before submitting.
  await expect(async () => {
    await email.fill("you@colab.app");
    await password.fill("demo1234");
    await expect(email).toHaveValue("you@colab.app", { timeout: 500 });
    await expect(password).toHaveValue("demo1234", { timeout: 500 });
  }).toPass({ timeout: 30000 });
  await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/api/auth/login") && res.status() === 200,
    ),
    page.locator("button.btn-p").click(),
  ]);
  await expect(page.locator("#rail")).toBeAttached({ timeout: 45000 });
  await expect(page.locator("#rail")).toBeVisible({ timeout: 45000 });
}
