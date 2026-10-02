import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { surfaceCases, checkSurface } from "./surface-contracts.generated.mjs";
const registry = JSON.parse(
  readFileSync(new URL("../../.ui-surfaces.json", import.meta.url), "utf8"),
);
// Render the actual host markup and stylesheet. Authentication/component behavior
// is covered by the host suite; this fixture isolates the host-owned surfaces.
async function host(page) {
  const html = readFileSync(
    new URL("../../app/index.html", import.meta.url),
    "utf8",
  )
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(
      "</head>",
      '<link rel="stylesheet" href="/styles/host.css"></head>',
    );
  await page.route("https://surface.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/")
      return route.fulfill({ contentType: "text/html", body: html });
    if (path === "/styles/host.css")
      return route.fulfill({
        contentType: "text/css",
        body: readFileSync(
          new URL("../../app/styles/host.css", import.meta.url),
          "utf8",
        ),
      });
    if (
      ["/components/motion.css", "/components/custom-properties.css", "/components/icon-contract.css"].includes(
        path,
      )
    )
      return route.fulfill({
        contentType: "text/css",
        body: readFileSync(
          new URL(
            "../../node_modules/@org.metadatacenter/cedar-design-tokens/dist/" +
              path.split("/").pop(),
            import.meta.url,
          ),
          "utf8",
        ),
      });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("https://surface.test/");
}
const scenarios = {
  "host-page": async (page) => host(page),
  version: async (page) => {
    await host(page);
    await page
      .locator("#version-dialog")
      .evaluate((dialog) => dialog.showModal());
  },
  error: async (page) => {
    await host(page);
    await page.locator("#message").evaluate((message) => {
      message.dataset.error = "true";
      message.textContent =
        "Your edits have been kept. Reopen the latest version before saving.";
    });
  },
};
for (const { surface, state, width, title } of surfaceCases(
  registry,
  scenarios,
))
  test(title, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await scenarios[surface.scenario](page);
    await checkSurface(page, surface, state, expect, testInfo);
  });

test('Workspace return matches the shared borderless return control', async ({page}) => {
  await host(page);
  const back = page.getByRole('button', {name: 'Workspace', exact: true});
  await expect(back).toHaveCSS('border-top-width', '0px');
  await expect(back).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(back).toBeEnabled();
});

test('a refused Save says why on hover, and only while errors are listed', async ({page}) => {
  await host(page);
  const help = page.locator('#save-help');
  const tooltip = page.getByRole('tooltip');
  await expect(page.locator('#save')).toBeDisabled();
  await help.hover();
  await expect(tooltip).toBeHidden();
  await help.evaluate((node) => { node.dataset.blocked = 'true'; });
  await page.mouse.move(0, 0);
  await help.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('Cannot save until errors are fixed');
  const box = await tooltip.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
});

test('save indicator is hollow until there is unsaved content, then filled', async ({page}) => {
  await host(page);
  const state = page.locator('#state');
  const appearance = () => state.evaluate(node => {
    const dot = getComputedStyle(node, '::before');
    return {content: dot.content, fill: dot.backgroundColor};
  });
  for (const text of ['Unmodified', 'Saved']) {
    await state.evaluate((node, text) => {
      node.dataset.saveState = 'true';
      node.dataset.dirty = 'false';
      node.textContent = text;
    }, text);
    expect(await appearance()).toEqual({content: '""', fill: 'rgba(0, 0, 0, 0)'});
  }
  await state.evaluate(node => {
    node.dataset.dirty = 'true';
    node.textContent = 'Modified';
  });
  const modified = await appearance();
  expect(modified.content).toBe('""');
  expect(modified.fill).not.toBe('rgba(0, 0, 0, 0)');
  await state.evaluate(node => {
    node.dataset.saveState = 'false';
    node.textContent = 'Saving…';
  });
  expect((await appearance()).content).toBe('none');
});
