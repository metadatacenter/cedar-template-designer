import {test, expect} from '@playwright/test';
import {host, edit, text} from './host-fixture.mjs';

for (const operation of ['create', 'update', 'version'])
  for (const answer of ['lost response', 'missing identity'])
    test(`${operation} with ${answer} keeps newer input and cannot repeat the write`, async ({page}) => {
      const state = await host(page, 'template', operation === 'create' ? 'create' : 'edit');
      if (operation === 'version') state.impact = {canBeUpdated: false};
      let release;
      const pending = new Promise(resolve => {release = resolve;});
      const committed = [];
      await page.route(/\/api\/(templates(?:\/item)?|command\/publish-create-draft-template\/item)(?:\?.*)?$/, async route => {
        if (route.request().method() === 'GET') return route.fallback();
        committed.push(route.request().postDataJSON());
        await pending;
        if (answer === 'lost response') await route.abort('failed');
        else await route.fulfill({json: {}});
      });
      await edit(page, 'Submitted');
      await page.locator('#save').click();
      if (operation === 'version') await page.locator('#version-dialog button[value=confirm]').click();
      await expect.poll(() => committed.length).toBe(1);
      await edit(page, 'Newer');
      release();
      await expect(page.locator('#message')).toHaveText(text('en', 'Error.SaveUnconfirmed'));
      await expect(page.locator('#save')).toBeDisabled();
      if (operation === 'update') await expect(page.locator('#reload')).toBeVisible();
      else await expect(page.locator('#reload')).toBeHidden();
      await edit(page, 'Still here');
      // Dispatch directly to verify the handler also refuses, independently of the disabled button.
      await page.locator('#save').dispatchEvent('click');
      expect(committed).toHaveLength(1);
      expect(committed[0]['schema:name']).toBe('Submitted');
      expect(await page.locator('#editor > *').evaluate(el => el.currentArtifact['schema:name'])).toBe('Still here');
    });

test('an unavailable update assessment can be retried without discarding the draft', async ({page}) => {
  const state = await host(page);
  await page.route('**/api/command/check-update-template/item', route => route.abort('failed'));
  await edit(page, 'Kept');
  await page.locator('#save').click();
  await expect(page.locator('#message')).toHaveText(text('en', 'Error.Unreachable'));
  await expect(page.locator('#save')).toBeEnabled();
  expect(state.writes).toHaveLength(0);
  await page.unroute('**/api/command/check-update-template/item');
  await page.locator('#save').click();
  await expect(page.locator('#state')).toHaveText('Saved');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body['schema:name']).toBe('Kept');
});
