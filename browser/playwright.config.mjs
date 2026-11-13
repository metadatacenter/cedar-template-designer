import { readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * Whether staging combined the three editors into the one shared script that
 * `shared-editors.spec.mjs` tests. Staging does so when every staged package provides
 * `integration.mjs`, and records the shared delivery in the manifest. Old registry pins and explicit
 * local bundle overrides take the standalone path, where that test has nothing to check, so it is
 * left out of the run rather than skipped. CI sets CEDAR_REQUIRE_SHARED_EDITORS, so a pin that loses
 * the shared path fails there instead of passing with the test left out.
 */
function sharedEditorsStaged() {
  if (process.env.CEDAR_REQUIRE_SHARED_EDITORS === "1") return true;
  try {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../app/components/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    return Object.values(manifest).some((component) => component?.delivery);
  } catch {
    return false;
  }
}

// Functional browser contracts share the existing worker budget; pixel baselines keep their own projects.
const functionalSpecs = [
  "save-matrix.spec.mjs",
  "save-recovery.spec.mjs",
  "save-uncertainty.spec.mjs",
  "draft-recovery.spec.mjs",
  "access-recheck.spec.mjs",
  "opening-access.spec.mjs",
  "opening-matrix.spec.mjs",
  "startup-overlap.spec.mjs",
  "state-coordination.spec.mjs",
  "shared-editors.spec.mjs",
  "confirmed-save-recovery.spec.mjs",
];

export default defineConfig({
  workers: process.env.CEDAR_TEST_WORKERS
    ? Number(process.env.CEDAR_TEST_WORKERS)
    : undefined,
  testDir: "./tests",
  testIgnore: sharedEditorsStaged() ? [] : ["**/shared-editors.spec.mjs"],
  // Keep pixel baselines in their original project; measure accessibility in every engine.
  projects: [
    ...["firefox", "webkit"].map((browserName) => ({
      name: `${browserName}-functional`,
      testMatch: functionalSpecs,
      use: { browserName },
    })),
    { name: "", use: { browserName: "chromium" } },
    ...["firefox", "webkit"].map((browserName) => ({
      name: `${browserName}-accessibility`,
      testMatch: /(?:accessibility|layout-resilience)\.spec\.mjs/,
      use: { browserName },
    })),
  ],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Stop a known-red CI/reactor run after a test exhausts its retry.
  maxFailures: process.env.CI ? 1 : 0,
  use: { browserName: "chromium", trace: "retain-on-failure" },
});
