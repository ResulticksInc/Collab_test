// Cross-viewport functional + responsive validation (Definition of Done: responsive).
// Run: npm run test:e2e  (installs browsers first time: npx playwright install)
import { defineConfig, devices } from "@playwright/test";

delete process.env.DEMO_MODE;
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "mysql://colab:colab@localhost:3306/colab";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90000,
  retries: 1,
  workers: 1,
  use: { baseURL: "http://localhost:3002", trace: "on-first-retry" },
  // Run the REAL backend and frontend stack against the existing database.
  // e2e signs in like a real user against the existing `colab` DB.
  // The DB user is expected to operate inside that existing database only.
  webServer: [
    {
      command: "npm run dev:backend",
      url: "http://localhost:4000/api/health",
      reuseExistingServer: true,
      timeout: 120000,
      env: {
        DATABASE_URL: "mysql://colab:colab@localhost:3306/colab",
      },
    },
    {
      command: "npm run dev:frontend",
      url: "http://localhost:3002",
      reuseExistingServer: true,
      timeout: 120000,
    },
  ],
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "tablet",
      use: {
        ...devices["iPad (gen 7)"],
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
    },
  ],
});
