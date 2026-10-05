import {test,expect} from '@playwright/test';
import {host,edit} from './host-fixture.mjs';

for(const kind of ['template','element','field'])for(const mode of ['create','edit'])for(const allowed of [false,true]) {
  test(`${kind} ${mode}: permission and unnamed initial state stay coordinated, allowed=${allowed}`,async({page})=>{
    const state=await host(page,kind,mode,allowed);
    const save=page.locator('#save');
    if(!allowed||mode==='create')await expect(save).toBeDisabled();else await expect(save).toBeEnabled();
    await edit(page,'');await edit(page,'',{setting:'name',shown:true,severity:'error'});await expect(save).toBeDisabled();
    await edit(page,'Named');
    if(!allowed){await expect(save).toBeDisabled();expect(state.writes).toHaveLength(0);return;}
    await save.click();await expect(page.getByRole('heading',{name:'Workspace'})).toBeVisible();
    expect(state.writes).toHaveLength(1);expect(state.writes[0].etag).toBe(mode==='edit'?'"opened"':undefined);
  });
}
for(const depth of [1,3,8])for(const severity of ['errors','warnings']) {
  test(`nested server ${severity} at depth ${depth} can be identified and corrected`,async({page})=>{
    const state=await host(page);
    const location='/properties/'+'Child/items/properties/'.repeat(depth)+'Link';
    state.failure={status:400,json:{message:'Validation failed',objects:{validationReport:{[severity]:[{location,message:'Invalid default IRI'}]}}}};
    await edit(page);await page.locator('#save').click();
    await expect(page.locator('#server-issues')).toContainText(location);
    await expect(page.locator('#server-issues')).toContainText('Invalid default IRI');
    if(severity==='errors')await expect(page.locator('#save')).toBeDisabled();else await expect(page.locator('#save')).toBeEnabled();
    await edit(page,'Corrected');await expect(page.locator('#server-issues')).toBeHidden();
    state.failure=null;await page.locator('#save').click();await expect(page.getByRole('heading',{name:'Workspace'})).toBeVisible();
    expect(state.writes).toHaveLength(2);
  });
}
for(const status of [403,412])test(`write ${status} keeps the edit and offers explicit reload`,async({page})=>{
  const state=await host(page);state.failure={status,json:{message:'Cannot save'}};
  await edit(page,'Unsaved');await page.locator('#save').click();await expect(page.locator('#save')).toBeDisabled();
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('#reload').click();
  expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Unsaved');
  page.once('dialog',dialog=>dialog.accept());state.failure=null;await page.locator('#reload').click();
  await expect(page.locator('#state')).toHaveText('Unmodified');await expect(page.locator('#save')).toBeEnabled();expect(state.writes).toHaveLength(1);
});
for(const impact of [{},{canBeUpdated:'false'}])test(`invalid impact cannot open confirmation or write: ${JSON.stringify(impact)}`,async({page})=>{
  const state=await host(page);state.impact=impact;await edit(page);await page.locator('#save').click();
  await expect(page.locator('#message')).toContainText('valid update assessment');await expect(page.locator('#version-dialog')).not.toBeVisible();expect(state.writes).toHaveLength(0);
});

for(const kind of ['template','element','field'])for(const mode of ['create','edit'])test(`${kind} ${mode} keeps newer edits after a write starts`,async({page})=>{
  const state=await host(page,kind,mode);let release;
  state.holdWrite=new Promise(resolve=>{release=resolve;});
  await edit(page,'Submitted');await page.locator('#save').click();
  await expect.poll(()=>state.writes.length).toBe(1);
  // Inert controls stop new typing, but an already pending component operation may still finish.
  await edit(page,'Newer');state.holdWrite=null;release();
  await expect(page.locator('#message')).toContainText('Further changes remain');
  expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Newer');
  expect(await page.locator('#editor > *').evaluate(el=>el.inert)).toBe(false);
  expect(state.writes[0].body['schema:name']).toBe('Submitted');
  if(mode==='create'){
    await expect(page).toHaveURL(new RegExp(`/${kind}s/edit/saved`));
    await expect(page.locator('#save')).toBeDisabled();await expect(page.locator('#reload')).toBeVisible();
    page.once('dialog',dialog=>dialog.dismiss());await page.locator('#reload').click();
    expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Newer');
  }else{
    await expect(page.locator('#save')).toBeEnabled();await page.locator('#save').click();
    await expect(page.getByRole('heading',{name:'Workspace'})).toBeVisible();
    expect(state.writes).toHaveLength(2);expect(state.writes[1].etag).toBe('"next"');
    expect(state.writes[1].body['schema:name']).toBe('Newer');expect(state.writes[1].body['@id']).toBe('item');
  }
});
for(const reason of ['new-version','missing-validator','invalid-draft','unreadable-draft'])test(`post-write ${reason} preserves the open draft`,async({page})=>{
  const state=await host(page);let release;
  if(reason==='new-version'){state.impact={canBeUpdated:false};state.savedId='new-draft';}
  if(reason==='missing-validator')state.nextEtag=null;
  state.holdWrite=new Promise(resolve=>{release=resolve;});
  await edit(page,'Submitted');await page.locator('#save').click();
  if(reason==='new-version')await page.locator('#version-dialog button[value=confirm]').click();
  await expect.poll(()=>state.writes.length).toBe(1);
  if(reason==='invalid-draft')await edit(page,'Submitted',{source:'draft',setting:'default',shown:true});
  else if(reason==='unreadable-draft')await page.locator('#editor > *').evaluate(el=>Object.defineProperty(el,'currentArtifact',{get(){throw new Error('Unserializable draft');}}));
  else await edit(page,'Newer');
  release();await expect(page.locator('#message')).toContainText('Further changes remain');
  await expect(page.locator('#save')).toBeDisabled();
  if(reason==='new-version')await expect(page).toHaveURL(/\/templates\/edit\/new-draft/);
  if(reason==='new-version'||reason==='missing-validator')await expect(page.locator('#reload')).toBeVisible();
  expect(state.writes).toHaveLength(1);
});
for(const mode of ['create','edit'])test(`unidentified ${mode} acknowledgement cannot cause a duplicate save`,async({page})=>{
  const state=await host(page,'template',mode);state.savedId=null;
  await edit(page);await page.locator('#save').click();
  await expect(page.locator('#message')).toContainText('Check Workspace');await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#reload')).toBeVisible({visible:mode==='edit'});
  expect(state.writes).toHaveLength(1);
});

for(const kind of ['template','element','field'])for(const fault of ['unavailable','identity','validator'])test(`${kind} ${fault} load has an explicit recovery path`,async({page})=>{
  const initial=fault==='unavailable'?{brokenLoad:true}:fault==='identity'?{loadedId:'wrong'}:{loadedEtag:null};
  const state=await host(page,kind,'edit',true,initial);
  await expect(page.locator('#save')).toBeDisabled();await expect(page.locator('#reload')).toBeVisible();
  expect(state.writes).toHaveLength(0);
  state.brokenLoad=false;state.loadedId='item';state.loadedEtag='"recovered"';
  await page.locator('#reload').click();
  await expect(page.locator('#state')).toHaveText('Unmodified');await expect(page.locator('#save')).toBeEnabled();
});
