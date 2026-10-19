import {test,expect} from '@playwright/test';
import {host,edit,text} from './host-fixture.mjs';

for(const kind of ['template','element','field']) for(const language of ['en','hu'])
  test(`${kind} confirms a successful save without an ETag in ${language}`,async({page})=>{
    const state=await host(page,kind,'edit',true,{language,nextEtag:null});
    await edit(page,'Submitted');await page.locator('#save').click();
    await expect(page.locator('#message')).toHaveText(text(language,'Error.SavedVerificationUnavailable'));
    await expect(page.locator('#check-save')).toBeVisible();await expect(page.locator('#save')).toBeDisabled();
    state.stored.get('item').etag='"confirmed"';
    const component=await page.locator('#editor > *').elementHandle();
    const collection={template:'templates',element:'template-elements',field:'template-fields'}[kind];
    let release;const gate=new Promise(resolve=>release=resolve);
    const delay=async route=>{await gate;await route.fallback();};
    await page.route(`**/api/${collection}/item`,delay);
    try{
      await page.locator('#check-save').click();await expect(page.locator('#check-save')).toBeDisabled();
      await edit(page,'Newer during verification');release();
      await expect(page.locator('#check-save')).toBeHidden();await expect(page.locator('#save')).toBeEnabled();
      await expect(page.locator('#state')).toHaveText(text(language,'State.Modified'));
      expect(await component.evaluate(el=>el.isConnected&&el.currentArtifact['schema:name']==='Newer during verification')).toBe(true);
    }finally{release();await page.unroute(`**/api/${collection}/item`,delay);}
    expect(state.writes).toHaveLength(1);state.nextEtag='"next"';
    await page.locator('#save').click();await expect(page.locator('#state')).toHaveText(text(language,'State.Saved'));
    expect(state.writes).toHaveLength(2);expect(state.writes[1].etag).toBe('"confirmed"');
    await page.reload();await expect(page.locator('#state')).toHaveText(text(language,'State.Unmodified'));
    expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Newer during verification');
  });

for(const failure of ['read failed','permission lost','changed','missing revision','old revision'])
  test(`confirmed save verification remains blocked after ${failure}`,async({page})=>{
    const state=await host(page,'template','edit',true,{nextEtag:null});
    await edit(page,'Submitted');await page.locator('#save').click();await expect(page.locator('#check-save')).toBeVisible();
    await edit(page,'Newer');
    const url=failure==='permission lost'?'**/api/templates/item/report':'**/api/templates/item';
    const fail=route=>failure==='read failed'?route.abort('failed'):route.fulfill(
      failure==='permission lost'?{json:{currentUserPermissions:{capabilities:[]}}}:
      {json:failure==='old revision'?{'@id':'item','schema:name':'Opened',properties:{}}:
        {...state.writes[0].body,...(failure==='changed'?{'schema:name':'Other author'}:{})},
      headers:failure==='missing revision'?{}:{ETag:failure==='old revision'?'"opened"':'"changed"'}});
    await page.route(url,fail);await page.locator('#check-save').click();
    await expect(page.locator('#message')).toHaveText(text('en',failure==='read failed'?'Error.RecoveryUnavailable':failure==='permission lost'?'Error.RecoveryReadOnly':'Error.RecoveryUnresolved'));
    await expect(page.locator('#save')).toBeDisabled();await expect(page.locator('#check-save')).toBeEnabled();
    expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Newer');
    expect(state.writes).toHaveLength(1);
    await page.unroute(url,fail);state.stored.get('item').etag='"confirmed"';
    await page.locator('#check-save').click();await expect(page.locator('#save')).toBeEnabled();
    expect(state.writes).toHaveLength(1);
  });
