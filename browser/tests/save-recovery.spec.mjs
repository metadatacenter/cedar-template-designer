import {test,expect} from '@playwright/test';
import {host,edit,text} from './host-fixture.mjs';
for(const kind of ['template','element','field'])for(const committed of [false,true])
  test(`${kind}: check an interrupted ${committed?'committed':'uncommitted'} update without replacing newer edits`,async({page})=>{
    const state=await host(page,kind);
    const collection={template:'templates',element:'template-elements',field:'template-fields'}[kind];
    let writes=0;
    const lost=async route=>{
      if(route.request().method()!=='PUT')return route.fallback();
      writes++;
      if(committed)state.stored.set('item',{json:route.request().postDataJSON(),etag:'"saved"'});
      await route.abort('failed');
    };
    await page.route(`**/api/${collection}/item`,lost);
    await edit(page,'Submitted');await page.locator('#save').click();
    await expect(page.locator('#check-save')).toBeVisible();
    await page.unroute(`**/api/${collection}/item`,lost);
    await edit(page,'Newer');
    const component=await page.locator('#editor > *').elementHandle();
    await page.locator('#check-save').click();
    await expect(page.locator('#message')).toHaveText(text('en',committed?'Message.SaveConfirmed':'Message.SaveUnchanged'));
    await expect(page.locator('#check-save')).toBeHidden();
    await expect(page.locator('#save')).toBeEnabled();
    expect(await component.evaluate(el=>el.isConnected&&el.currentArtifact['schema:name']==='Newer')).toBe(true);
    expect(writes).toBe(1);
    await page.locator('#save').click();
    await expect(page.locator('#state')).toHaveText('Saved');
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].etag).toBe(committed?'"saved"':'"opened"');
    expect(state.writes[0].body['schema:name']).toBe('Newer');
  });
for(const failure of ['read failed','permission lost','conflict','missing revision','wrong artifact'])
  test(`status check with ${failure} preserves input and refuses another write`,async({page})=>{
    const state=await host(page);
    await edit(page,'Submitted');state.failure='network';await page.locator('#save').click();
    await expect(page.locator('#check-save')).toBeVisible();
    state.failure=null;
    const interfere=async route=>{
      if(route.request().method()!=='GET')return route.fallback();
      if(failure==='read failed')return route.abort('failed');
      if(failure==='permission lost')return route.fulfill({json:{currentUserPermissions:{capabilities:[]}}});
      return route.fulfill({json:{'@id':failure==='wrong artifact'?'wrong':'item','schema:name':'Other',properties:{}},headers:failure==='missing revision'?{}:{ETag:'"other"'}});
    };
    const url=failure==='permission lost'?'**/api/templates/item/report':'**/api/templates/item';
    await page.route(url,interfere);
    await edit(page,'Kept');await page.locator('#check-save').click();
    await expect(page.locator('#message')).toHaveText(text('en',failure==='read failed'?'Error.RecoveryUnavailable':failure==='permission lost'?'Error.RecoveryReadOnly':'Error.RecoveryUnresolved'));
    await expect(page.locator('#save')).toBeDisabled();
    expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Kept');
    await page.unroute(url,interfere);
    await page.locator('#check-save').click();
    await expect(page.locator('#save')).toBeEnabled();
    expect(state.writes).toHaveLength(1);
  });
test('newer edits during a delayed recovery read remain dirty after a matching saved snapshot',async({page})=>{
  const state=await host(page);
  await edit(page,'Submitted');state.failure='network';await page.locator('#save').click();
  await expect(page.locator('#check-save')).toBeVisible();
  let release;const pending=new Promise(resolve=>release=resolve);
  await page.route('**/api/templates/item',async route=>{
    await pending;return route.fulfill({json:state.writes[0].body,headers:{ETag:'"confirmed"'}});
  });
  await page.locator('#check-save').click();
  await expect(page.locator('#check-save')).toBeDisabled();
  await edit(page,'Edited during check');release();
  await expect(page.locator('#save')).toBeEnabled();
  await expect(page.locator('#state')).toHaveText('Modified');
  expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Edited during check');
});

// The artifact server stamps what it stores: modification provenance at the root, creation provenance on a
// new child, and an absolute identifier for a child the designer identified temporarily. Every other case
// here reads a lost update back exactly as it was sent, so this one reads it back as the server stores it.
// That stamping alone is the submitted save; a child holding other content is not.
const ITEM='5f0d8c3e-2b7a-4c1e-9d6f-3a8b7c2e1f40',ID=`https://repo.designer.test/templates/${ITEM}`;
const PROVENANCE={'pav:createdOn':'2026-11-01T10:00:00-07:00','pav:createdBy':'https://metadatacenter.org/users/author',
  'pav:lastUpdatedOn':'2026-11-01T10:00:00-07:00','oslc:modifiedBy':'https://metadatacenter.org/users/author'};
for(const stored of ['as the server stamps it','with the new child holding other content'])
  test(`a lost update read back ${stored} is judged by what the server assigns`,async({page})=>{
    const other=stored.includes('other');
    const state=await host(page,'template','edit',true,{item:ITEM,loadedArtifact:{'@id':ID,'schema:name':'Opened',...PROVENANCE,properties:{}}});
    // The author adds a child, which the designer identifies temporarily until the server mints its identity.
    await page.locator('#editor > *').evaluate(designer=>{designer.currentArtifact.properties.Added={'@id':'tmp-1760650000000-added','schema:name':'Added'};});
    await edit(page,'Submitted');
    let sent;
    const lose=async route=>{if(route.request().method()!=='PUT')return route.fallback();sent=route.request().postDataJSON();await route.abort('failed');};
    await page.route(`**/api/templates/${ITEM}`,lose);
    await page.locator('#save').click();
    await expect(page.locator('#check-save')).toBeVisible();
    await page.unroute(`**/api/templates/${ITEM}`,lose);
    expect(sent.properties.Added['@id']).toBe('tmp-1760650000000-added');
    const stamp={'pav:lastUpdatedOn':'2026-11-15T09:30:00-08:00','oslc:modifiedBy':'https://metadatacenter.org/users/author'};
    const json={...structuredClone(sent),...stamp,properties:{...structuredClone(sent.properties),Added:{...sent.properties.Added,
      '@id':'https://repo.designer.test/template-fields/9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a',
      'pav:createdOn':stamp['pav:lastUpdatedOn'],'pav:createdBy':stamp['oslc:modifiedBy'],...stamp,...(other?{'schema:name':'Someone else'}:{})}}};
    state.stored.set(ITEM,{json,etag:'"stamped"'});
    await page.locator('#check-save').click();
    await expect(page.locator('#message')).toHaveText(text('en',other?'Error.RecoveryUnresolved':'Message.SaveConfirmed'));
    if(other){await expect(page.locator('#save')).toBeDisabled();await expect(page.locator('#check-save')).toBeVisible();return;}
    await expect(page.locator('#check-save')).toBeHidden();
    await edit(page,'Renamed');await page.locator('#save').click();
    await expect(page.locator('#state')).toHaveText('Saved');
    // The next save updates the stored revision.
    expect(state.writes).toHaveLength(1);expect(state.writes[0].etag).toBe('"stamped"');
  });
