import {readFileSync} from 'node:fs';
import {test,expect} from '@playwright/test';

const root = new URL('../../app/', import.meta.url);
const source = name => readFileSync(new URL(name, root), 'utf8');
async function host(page, kind='template', mode='edit', allowed=true, initial={}) {
  const state={writes:[],failure:null,impact:{canBeUpdated:true},brokenLoad:false,holdWrite:null,savedId:mode==='edit'?'item':'saved',nextEtag:'"next"',loadedId:'item',loadedEtag:'"opened"',...initial};
  await page.route('https://workspace.test/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Workspace</h1>'}));
  await page.route('https://designer.test/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    if(path.startsWith('/api/')) {
      if(path==='/api/users/user')return route.fulfill({json:{homeFolderId:'home'}});
      if(path.startsWith('/api/folders/'))return route.fulfill({json:{currentUserPermissions:{capabilities:allowed?['createInFolder']:[]}}});
      if(path.endsWith('/report'))return route.fulfill({json:{currentUserPermissions:{capabilities:allowed?['updateResource']:[]}}});
      if(path.includes('/check-update-template/'))return route.fulfill({json:state.impact});
      if(route.request().method()!=='GET'){
        state.writes.push({path,body:route.request().postDataJSON(),etag:route.request().headers()['if-match']});
        if(state.holdWrite)await state.holdWrite;
        if(state.failure)return route.fulfill(state.failure);
        return route.fulfill({json:state.savedId?{'@id':state.savedId}:{},headers:state.nextEtag?{ETag:state.nextEtag}:{}});
      }
      if(state.brokenLoad)return route.fulfill({status:503,json:{message:'Load unavailable'}});
      return route.fulfill({json:{'@id':state.loadedId,'schema:name':'Opened',properties:{}},headers:state.loadedEtag?{ETag:state.loadedEtag}:{}});
    }
    if(path==='/config/host.json')return route.fulfill({json:{workspaceFrontend:'https://workspace.test',resourceRestAPI:'https://designer.test/api',userRestAPI:'https://designer.test/api'}});
    if(path==='/config/version.js')return route.fulfill({contentType:'text/javascript',body:"window.cedarCacheControl='fixture';"});
    if(path==='/scripts/handlers/KeycloakUserHandler.js')return route.fulfill({contentType:'text/javascript',body:`window.KeycloakUserHandler=class{initUserHandler(ok){ok(true)}getParsedToken(){return{sub:'user'}}getToken(){return 'test'}refreshToken(_n,ok){ok(true)}};`});
    if(path==='/components/manifest.json')return route.fulfill({json:Object.fromEntries(['cedar-embeddable-editor','cedar-embeddable-term-picker','cedar-embeddable-designer'].map(name=>[name,{sha256:'fixture'}]))});
    if(path==='/components/cedar-embeddable-designer.js')return route.fulfill({contentType:'text/javascript',body:`
      class Designer extends HTMLElement {
        currentArtifact={}; baseline=''; report={valid:true,canSave:true,issues:[]};
        connectedCallback(){this.textContent='Designer fixture'}
        get canSave(){return this.report.canSave}get validationReport(){return this.report}validate(){return this.report}
        get isDirty(){return JSON.stringify(this.currentArtifact)!==this.baseline}
        loadArtifact(value){this.currentArtifact=structuredClone(value);this.baseline=JSON.stringify(value)}
        newArtifact(){this.loadArtifact({'schema:name':''});this.report={valid:false,canSave:false,issues:[{setting:'name',shown:false,severity:'error'}]}}
      }
      setTimeout(()=>{
        customElements.define('cedar-embeddable-field-designer',class extends Designer{});
        customElements.define('cedar-embeddable-designer',Designer);
      },30);`});
    if(path==='/components/icons.js')return route.fulfill({contentType:'text/javascript',body:'export const iconSvg=()=>"";'});
    if(path.startsWith('/components/')||path.startsWith('/scripts/keycloak/'))return route.fulfill({contentType:'text/javascript',body:''});
    if(path.startsWith('/scripts/')||path.startsWith('/i18n/'))return route.fulfill({contentType:path.endsWith('.json')?'application/json':'text/javascript',body:source(path.slice(1))});
    if(path.startsWith('/styles/'))return route.fulfill({contentType:'text/css',body:source(path.slice(1))});
    return route.fulfill({contentType:'text/html',body:source('index.html')});
  });
  await page.goto(`https://designer.test/${kind}s/${mode}${mode==='edit'?'/item':''}`);
  if(state.brokenLoad||state.loadedId!=='item'){
    await expect(page.locator('#state')).toHaveText('Unable to load');return state;
  }
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#state')).toHaveText(!allowed?'Read only':mode==='edit'&&!state.loadedEtag?'Reload required':'Unmodified');
  return state;
}
async function edit(page, name='Edited', issue=null) {
  await page.locator('#editor > *').evaluate((designer,{name,issue})=>{
    designer.currentArtifact['schema:name']=name;
    designer.report={valid:!issue,canSave:!issue,issues:issue?[issue]:[]};
    designer.dispatchEvent(new CustomEvent('artifactChange'));
  },{name,issue});
}
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
