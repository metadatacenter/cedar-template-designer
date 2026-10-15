import {test,expect} from '@playwright/test';
import {host,edit,text} from './host-fixture.mjs';
for(const operation of ['template assessment','template','element','field'])
  test(`${operation}: restore access without discarding the refused draft`,async({page})=>{
    const kind=operation==='template assessment'?'template':operation,state=await host(page,kind);
    const url=operation==='template assessment'?'**/api/command/check-update-template/item':`**/api/${{template:'templates',element:'template-elements',field:'template-fields'}[kind]}/item`;
    const refuse=route=>route.request().method()==='GET'?route.fallback():route.fulfill({status:403,json:{message:'Forbidden'}});
    await page.route(url,refuse);await edit(page,'Refused draft');await page.locator('#save').click();
    const check=page.getByRole('button',{name:'Recheck access',exact:true});await expect(check).toBeVisible();
    await expect(page.locator('#check-save')).toBeHidden();await page.unroute(url,refuse);
    await page.route('**/report',route=>route.fulfill({json:{currentUserPermissions:{capabilities:[]}}}));
    await check.click();await expect(page.locator('#message')).toHaveText(text('en','Error.RecoveryReadOnly'));
    await expect(page.locator('#save')).toBeDisabled();
    await edit(page,'Newer draft');await page.unroute('**/report');await check.click();
    await expect(page.locator('#message')).toHaveText(text('en','Message.AccessRestored'));
    await expect(page.locator('#save')).toBeEnabled();expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Newer draft');
    expect(state.writes).toHaveLength(0);
    await page.locator('#save').click();await expect(page.locator('#state')).toHaveText('Saved');
    expect(state.writes[0].etag).toBe('"opened"');expect(state.writes[0].body['schema:name']).toBe('Newer draft');
  });
