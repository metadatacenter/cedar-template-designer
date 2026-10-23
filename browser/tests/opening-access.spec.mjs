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

for(const mode of ['edit','create']) for(const status of [401,403]) {
  test(`${mode} recovers an opening refusal (${status}) through a fresh access check`,async({page})=>{
    const server=await host(page,'template',mode,true,{openingFailure:{request:mode==='edit'?'artifact':'folder',answer:route=>route.fulfill({status,json:{message:'Access refused'}})}});
    await expect(page.locator('#recheck-access')).toBeVisible();
    await expect(page.locator('#sign-in-again')).toBeVisible();
    await page.locator('#recheck-access').click();await expect(page.locator('#state')).toHaveText('Unable to load');
    await expect(page.locator('#save')).toBeDisabled();expect(server.writes).toHaveLength(0);
    server.openingFailure=null;await page.locator('#recheck-access').click();await expect(page.locator('#state')).toHaveText('Unmodified');
    await edit(page,'Access granted');await page.locator('#save').click();await expect(page.locator('#state')).toHaveText('Saved');
  });
}

for (const kind of ['template','element','field']) {
  test(`a published ${kind} says why it is read only and offers no access check`, async ({page}) => {
    await host(page,kind,'edit',true,{loadedArtifact:{'@id':'item','schema:name':'Opened','bibo:status':'bibo:published','pav:version':'1.0.0',properties:{}}});
    await expect(page.locator('#state')).toHaveText('Read only');
    await expect(page.locator('#message')).toHaveText("This artifact is published, so it is read only. Create a draft in Workspace if you'd like to edit a new version of it.");
    // Neither control can make a published artifact editable, so neither appears.
    await expect(page.locator('#recheck-access')).toBeHidden();
    await expect(page.locator('#sign-in-again')).toBeHidden();
  });
}

test('an artifact the person may not edit says so and keeps its access check', async ({page}) => {
  await host(page,'template','edit',false);
  await expect(page.locator('#message')).toHaveText('You do not have permission to edit this artifact. Ask its owner for edit access, then use Recheck access.');
  await expect(page.locator('#recheck-access')).toBeVisible();
  await expect(page.locator('#sign-in-again')).toBeVisible();
});

test('a folder the person may not create in says so', async ({page}) => {
  await host(page,'template','create',false);
  await expect(page.locator('#message')).toHaveText('You do not have permission to create an artifact in this folder. Ask its owner for access, then use Recheck access.');
  await expect(page.locator('#recheck-access')).toBeVisible();
});
