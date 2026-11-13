import {test, expect} from '@playwright/test';
import {host} from './host-fixture.mjs';

for (const allowed of [true, false]) {
  test(`downloads components during sign-in and overlaps reads without exposing ${allowed ? 'writable' : 'denied'} content early`, async ({page}) => {
    let releaseProfile, releaseReport;
    const profile = new Promise(resolve => { releaseProfile = resolve; });
    const report = new Promise(resolve => { releaseReport = resolve; });
    const requests = [];
    page.on('request', request => requests.push(new URL(request.url()).pathname));
    const opening = host(page, 'template', 'edit', allowed, {
      holdSignIn: true,
      waitForOpening: path => path === '/api/users/user' ? profile : path.endsWith('/report') ? report : undefined,
    });
    void opening.catch(() => {});
    try {
      // Do not evaluate against the about:blank context while host() replaces it.
      await page.locator('#editor').waitFor({state: 'attached'});
      await expect.poll(() => page.evaluate(() => typeof window.completeTestSignIn === 'function'), { timeout: 30_000 }).toBeTruthy();
      await expect.poll(() => requests.includes('/components/cedar-embeddable-designer.js')).toBe(true);
      expect(requests.filter(path => path.startsWith('/api/'))).toEqual([]);
      await expect(page.locator('#editor')).toBeHidden();
      await expect(page.locator('#save')).toBeDisabled();
      await page.evaluate(() => window.completeTestSignIn());
      await expect.poll(() => requests.includes('/api/templates/item')).toBe(true);
      await expect.poll(() => requests.includes('/api/templates/item/report')).toBe(true);
      await expect.poll(() => requests.includes('/api/users/user')).toBe(true);
      await expect(page.locator('#editor')).toBeHidden();
      releaseProfile();
      await expect(page.locator('#editor > cedar-embeddable-designer')).toBeAttached();
      await expect(page.locator('#editor')).toBeHidden();
      await expect(page.locator('#save')).toBeDisabled();
      releaseReport();
      await opening;
      await expect(page.locator('#editor')).toBeVisible();
      await expect(page.locator('#state')).toHaveText(allowed ? 'Unmodified' : 'Read only');
    } finally {
      releaseProfile(); releaseReport();
      await opening.catch(() => {});
    }
  });
}
