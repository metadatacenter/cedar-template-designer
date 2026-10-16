import {test, expect} from '@playwright/test';
import {host, edit, text} from './host-fixture.mjs';

for(const severity of ['errors','warnings'])test(`restoring a rejected draft retains server ${severity}`,async({page})=>{
  const server=await host(page);await edit(page,'Rejected name');
  server.failure={status:400,json:{objects:{validationReport:{[severity]:[{location:'/schema:name',message:'Review the name'}]}}}};
  await page.locator('#save').click();await expect(page.locator('#server-issues')).toBeVisible();
  page.on('dialog',dialog=>dialog.accept());await page.reload();await page.locator('#restore-draft').click();
  await expect(page.locator('#server-issues')).toBeVisible();await page.locator('#server-issues summary').click();
  await expect(page.locator('#server-issues-list')).toContainText('Review the name');
  if(severity==='errors')await expect(page.locator('#save')).toBeDisabled();
  else await expect(page.locator('#save')).toBeEnabled();
  expect(server.writes).toHaveLength(1);
  await edit(page,'Corrected name');await expect(page.locator('#server-issues')).toBeHidden();
  server.failure=null;await page.locator('#save').click();await expect(page.locator('#state')).toHaveText('Saved');
  expect(server.writes).toHaveLength(2);
});

for (const kind of ['template', 'element', 'field']) {
  for (const status of [null, 401, 403, 412, 503]) {
    test(`${kind} draft survives reload after ${status ?? 'editing'}`, async ({page}) => {
      const server = await host(page, kind);
      await expect(page.locator('#download-draft, #import-draft')).toHaveCount(0);
      await edit(page, 'Retained author work');
      if (status) {
        server.failure = {status, json:{message:'Refused'}};
        await page.locator('#save').click();
        await expect(page.locator('#state')).toHaveText(text('en','State.ReloadRequired'));
      }
      await expect(page.locator('#download-draft, #import-draft')).toHaveCount(0);
      const writesBeforeReload = server.writes.length;
      page.on('dialog', dialog => dialog.accept());
      await page.reload();
      await expect(page.locator('#draft-offer')).toBeVisible();
      await expect(page.locator('#save')).toBeDisabled();
      await page.locator('#restore-draft').click();
      await expect(page.locator('#draft-offer')).toBeHidden();
      expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Retained author work');
      if (status) await expect(page.locator('#save')).toBeDisabled();
      else await expect(page.locator('#save')).toBeEnabled();
      if ([401,403,503].includes(status)) {
        server.failure = null;
        await page.locator(status===503?'#check-save':'#recheck-access').click();
        await expect(page.locator('#save')).toBeEnabled();
      }
      await expect(page.locator('#download-draft, #import-draft')).toHaveCount(0);
      expect(server.writes).toHaveLength(writesBeforeReload);
    });
  }
}
test('an uncertain create stays guarded after reload and cannot be discarded into a duplicate', async ({page}) => {
  const server = await host(page,'template','create');
  await expect(page.locator('#download-draft, #import-draft')).toHaveCount(0);
  await edit(page); server.failure='network';
  await page.locator('#save').click();
  await expect(page.locator('#state')).toHaveText(text('en','State.ReloadRequired'));
  page.on('dialog',dialog=>dialog.accept()); await page.reload();
  await expect(page.locator('#draft-offer')).toBeVisible();
  await page.locator('#discard-draft').click();
  await expect(page.locator('#draft-offer')).toBeVisible();
  await page.locator('#restore-draft').click();
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#reload')).toBeHidden();
  expect(server.writes).toHaveLength(1);
});
test('a retained draft can be opened read-only while the artifact read is unavailable', async ({page}) => {
  const server = await host(page); await edit(page,'Offline draft');
  server.brokenLoad=true;
  page.on('dialog',dialog=>dialog.accept()); await page.reload();
  await expect(page.locator('#draft-offer')).toBeVisible();
  await page.locator('#restore-draft').click();
  await expect(page.locator('#editor')).toBeVisible();
  expect(await page.locator('#editor > *').evaluate(el=>[el.currentArtifact['schema:name'],el.readOnly])).toEqual(['Offline draft',true]);
  await expect(page.locator('#save')).toBeDisabled();
});
test('sign-in retains the draft first and storage failure keeps the author on the page',async({page})=>{
  const server=await host(page);await edit(page,'Keep through sign-in');
  server.failure={status:401,json:{message:'Expired'}};await page.locator('#save').click();
  const signIn=page.locator('#sign-in-again');await expect(signIn).toBeVisible();await signIn.click();
  expect(await page.evaluate(()=>window.signInCalls)).toBe(1);
  expect(await page.evaluate(()=>Object.values(sessionStorage).some(raw=>raw.includes('Keep through sign-in')))).toBe(true);
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new Error('Full')}});
  await signIn.click();await expect(page.locator('#draft-storage-error')).toBeVisible();
  expect(await page.evaluate(()=>window.signInCalls)).toBe(1);
});
test('confirmed creation with failed readback retains its draft under the new identity',async({page})=>{
  const server=await host(page,'template','create');await edit(page,'Created but not reopened');
  await page.route('**/api/templates/saved',route=>route.fulfill({status:503,json:{message:'Unavailable'}}));
  await page.locator('#save').click();await expect(page.locator('#state')).toHaveText('Reload required');
  await expect(page).toHaveURL(/templates\/edit\/saved/);
  page.on('dialog',dialog=>dialog.accept());await page.reload();
  await expect(page.locator('#draft-offer')).toBeVisible();await page.locator('#restore-draft').click();
  expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Created but not reopened');
  await expect(page.locator('#save')).toBeDisabled();expect(server.writes).toHaveLength(1);
});
for(const status of [401,403])test(`a definitively refused create can be restored after access returns (${status})`,async({page})=>{
  const server=await host(page,'template','create');await edit(page,'Refused create');
  server.failure={status,json:{message:'Refused'}};await page.locator('#save').click();
  await expect(page.locator('#sign-in-again')).toBeVisible();server.failure=null;
  page.on('dialog',dialog=>dialog.accept());await page.reload();await page.locator('#restore-draft').click();
  await expect(page.locator('#save')).toBeEnabled();await page.locator('#save').click();await expect(page.locator('#state')).toHaveText('Saved');
});
test('restoration waits until the fresh opening read settles',async({page})=>{
  await host(page);await edit(page,'Draft while opening');
  let release;const gate=new Promise(resolve=>{release=resolve});
  await page.route('**/api/templates/item/report',async route=>{await gate;await route.fulfill({json:{currentUserPermissions:{capabilities:['updateResource']}}})});
  page.on('dialog',dialog=>dialog.accept());await page.reload({waitUntil:'domcontentloaded'});
  const component=page.locator('#editor > *');await component.waitFor({state:'attached'});
  await component.evaluate(el=>el.dispatchEvent(new CustomEvent('artifactChange')));
  await expect(page.locator('#draft-offer')).toBeVisible();await expect(page.locator('#restore-draft')).toBeDisabled();
  release();await expect(page.locator('#restore-draft')).toBeEnabled();await page.locator('#restore-draft').click();
  expect(await component.evaluate(el=>el.currentArtifact['schema:name'])).toBe('Draft while opening');
});

for(const dependency of ['profile','manifest','component','artifact','report'])test(`retained work survives ${dependency} failure and opening retry`,async({page})=>{
  const server=await host(page);await edit(page,'Retained through '+dependency);
  server.openingFailure={request:dependency,answer:route=>route.fulfill({status:503,json:{message:'Unavailable'}})};
  page.on('dialog',dialog=>dialog.accept());await page.reload();
  await expect(page.locator('#state')).toHaveText('Unable to load');
  await expect(page.locator('#draft-offer')).toBeVisible();
  expect(await page.evaluate(()=>Object.values(sessionStorage).some(raw=>raw.includes('Retained through')))).toBe(true);
  server.openingFailure=null;await page.locator('#reload').click();
  await expect(page.locator('#draft-offer')).toBeVisible();await page.locator('#restore-draft').click();
  expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Retained through '+dependency);
  expect(server.writes).toHaveLength(0);
});
