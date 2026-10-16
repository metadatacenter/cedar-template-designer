import {test, expect} from '@playwright/test';
import {host, edit} from './host-fixture.mjs';

for (const kind of ['template','element','field']) for (const mode of ['edit','create']) {
  test(`${kind} ${mode} rechecks a read-only opening with fresh content and access`, async ({page}) => {
    const server = await host(page,kind,mode,false);
    await expect(page.locator('#recheck-access')).toBeVisible();
    await page.locator('#recheck-access').click();
    await expect(page.locator('#state')).toHaveText('Read only');
    await expect(page.locator('#save')).toBeDisabled();
    server.allowed = true;
    if(mode==='edit')server.stored.set('item',{json:{'@id':'item','schema:name':'Newer saved content',properties:{}},etag:'"newer"'});
    await page.locator('#recheck-access').click();
    await expect(page.locator('#state')).toHaveText('Unmodified');
    await expect(page.locator('#recheck-access')).toBeHidden();
    expect(await page.locator('#editor > *').evaluate(el=>el.readOnly)).toBe(false);
    if(mode==='edit')expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Newer saved content');
    expect(server.writes).toHaveLength(0);
    await edit(page,'Allowed now');await page.locator('#save').click();
    await expect(page.locator('#state')).toHaveText('Saved');
    if(mode==='edit')expect(server.writes[0].etag).toBe('"newer"');
  });
}
test('read-only sign-in does not invent a recovery draft',async({page})=>{
  await host(page,'template','edit',false);
  await page.locator('#sign-in-again').click();
  expect(await page.evaluate(()=>window.signInCalls)).toBe(1);
  expect(await page.evaluate(()=>Object.keys(sessionStorage))).toEqual([]);
});
