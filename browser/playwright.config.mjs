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

export default defineConfig({
  workers: process.env.CEDAR_TEST_WORKERS
    ? Number(process.env.CEDAR_TEST_WORKERS)
    : undefined,
  testDir: "./tests",
  testIgnore: sharedEditorsStaged() ? [] : ["**/shared-editors.spec.mjs"],
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
