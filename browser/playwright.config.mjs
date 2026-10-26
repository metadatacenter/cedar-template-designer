import { defineConfig } from "@playwright/test";
export default defineConfig({
  workers: process.env.CEDAR_TEST_WORKERS ? Number(process.env.CEDAR_TEST_WORKERS) : undefined,
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  use: { browserName: "chromium", trace: "retain-on-failure" },
});
