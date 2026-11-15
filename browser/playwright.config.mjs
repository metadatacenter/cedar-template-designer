import { defineConfig } from "@playwright/test";

/** The variables that stage an editor from a standalone bundle of the developer's choosing. */
const BUNDLE_OVERRIDES = ["CEDAR_CED_BUNDLE", "CEDAR_CEE_BUNDLE", "CEDAR_CETP_BUNDLE"];

/**
 * Whether to run `shared-editors.spec.mjs`, which tests the one shared script staging combines the three
 * editors into. Staging serves standalone scripts instead when a bundle override names one, when an
 * installed package lacks its integration manifest, or when the design tokens publish no fonts. Only an
 * override is a choice, so only an override leaves the spec out, and the run says so. Any other
 * standalone staging runs the spec, whose first test names the editors staging left standalone.
 * CEDAR_REQUIRE_SHARED_EDITORS runs it in every case.
 */
function sharedEditorsRun() {
  if (process.env.CEDAR_REQUIRE_SHARED_EDITORS === "1") return true;
  const overrides = BUNDLE_OVERRIDES.filter((name) => process.env[name]);
  if (!overrides.length) return true;
  // Workers load this file too; the main process alone reports the choice.
  if (!process.env.TEST_WORKER_INDEX)
    console.log(`shared-editors.spec.mjs is left out: ${overrides.join(", ")} stages a standalone bundle.`);
  return false;
}

export default defineConfig({
  workers: process.env.CEDAR_TEST_WORKERS
    ? Number(process.env.CEDAR_TEST_WORKERS)
    : undefined,
  testDir: "./tests",
  testIgnore: sharedEditorsRun() ? [] : ["**/shared-editors.spec.mjs"],
  // Every functional/accessibility spec runs in all engines by default.
  projects: [
    { name: "", use: { browserName: "chromium" } },
    ...["firefox", "webkit"].map((browserName) => ({
      name: browserName,
      use: { browserName },
    })),
  ],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Fail on the first failure in CI; a retry must not hide an unreliable case.
  maxFailures: process.env.CI ? 1 : 0,
  use: {
    browserName: "chromium",
    trace: process.env.CEDAR_TEST_TRACE === "on" ? "retain-on-failure" : "off",
    screenshot: process.env.CI ? "only-on-failure" : "off",
  },
});
