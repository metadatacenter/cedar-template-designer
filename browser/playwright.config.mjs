import { defineConfig } from "@playwright/test";
export default defineConfig({
  workers: process.env.CEDAR_TEST_WORKERS ? Number(process.env.CEDAR_TEST_WORKERS) : undefined,
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: { browserName: "chromium", trace: "retain-on-failure" },
});
