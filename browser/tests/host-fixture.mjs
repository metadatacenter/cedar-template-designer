// The Designer host page with its backend, sign-in and components answered in the browser. The real
// host scripts, translations and markup are served; the designer is a small stand-in whose document,
// report and dirtiness a test sets directly.
import {readFileSync} from 'node:fs';
import {expect} from '@playwright/test';

const translations = Object.fromEntries(['en','hu'].map(language=>[language,JSON.parse(readFileSync(new URL(`../../app/i18n/${language}.json`,import.meta.url),'utf8'))]));
/** The host's text for a key in a language, with its placeholders filled as the host fills them. */
export function text(language,key,params={}) {
  const value=key.split('.').reduce((node,part)=>node?.[part],translations[language]);
  if(typeof value!=='string')throw new Error(`No ${language} text for ${key}`);
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g,(placeholder,name)=>params[name]===undefined?placeholder:String(params[name]));
}

/** The requests the page makes while it opens, by name, as a path and method identify them. */
export const OPENING_REQUESTS={
  configuration:(path)=>path==='/config/host.json',
  profile:(path)=>path==='/api/users/user',
  manifest:(path)=>path==='/components/manifest.json',
  component:(path)=>path==='/components/cedar-embeddable-designer.js',
  artifact:(path,method)=>method==='GET'&&/^\/api\/(templates|template-elements|template-fields)\/item$/.test(path),
  report:(path)=>path.endsWith('/report'),
  folder:(path)=>path.startsWith('/api/folders/'),
};

const root = new URL('../../app/', import.meta.url);
const source = name => readFileSync(new URL(name, root), 'utf8');
export async function host(page, kind='template', mode='edit', allowed=true, initial={}) {
  const state={language:'en',writes:[],failure:null,impact:{canBeUpdated:true},brokenLoad:false,holdWrite:null,savedId:mode==='edit'?'item':'saved',nextEtag:'"next"',loadedId:'item',loadedEtag:'"opened"',...initial};
  await page.route('https://workspace.test/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Workspace</h1>'}));
  await page.route('https://designer.test/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    // A request named in `openingFailure` gets that answer instead of its own.
    const failing=state.openingFailure;
    if(failing&&OPENING_REQUESTS[failing.request](path,route.request().method()))return failing.answer(route);
    if(path.startsWith('/api/')) {
      if(path==='/api/users/user')return route.fulfill({json:{homeFolderId:'home'}});
      if(path.startsWith('/api/folders/'))return route.fulfill({json:{currentUserPermissions:{capabilities:allowed?['createInFolder']:[]}}});
      if(path.endsWith('/report'))return route.fulfill({json:{currentUserPermissions:{capabilities:allowed?['updateResource']:[]}}});
      if(path.includes('/check-update-template/'))return route.fulfill({json:state.impact});
      if(route.request().method()!=='GET'){
        state.writes.push({path,body:route.request().postDataJSON(),etag:route.request().headers()['if-match']});
        if(state.holdWrite)await state.holdWrite;
        if(state.failure==='network')return route.abort('failed');
        if(state.failure)return route.fulfill(state.failure);
        return route.fulfill({json:state.savedId?{'@id':state.savedId}:{},headers:state.nextEtag?{ETag:state.nextEtag}:{}});
      }
      if(state.brokenLoad)return route.fulfill({status:503,json:{message:'Load unavailable'}});
      return route.fulfill({json:{'@id':state.loadedId,'schema:name':'Opened',properties:{},...(state.unreadable?{unreadable:true}:{})},headers:state.loadedEtag?{ETag:state.loadedEtag}:{}});
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
        loadArtifact(value){if(value.unreadable)throw new Error('Child schema uses a reserved instance property name at /properties/@foo/');this.currentArtifact=structuredClone(value);this.baseline=JSON.stringify(value)}
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
  // The host takes its language from the browser's preferences.
  await page.addInitScript(language=>Object.defineProperty(navigator,'languages',{get:()=>[language]}),state.language);
  await page.goto(`https://designer.test/${kind}s/${mode}${mode==='edit'?'/item':''}`);
  if(state.brokenLoad||state.loadedId!=='item'||state.unreadable||state.openingFailure){
    await expect(page.locator('#state')).toHaveText(text(state.language,'State.LoadFailed'));return state;
  }
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#state')).toHaveText(text(state.language,!allowed?'State.ReadOnly':mode==='edit'&&!state.loadedEtag?'State.ReloadRequired':'State.Unmodified'));
  return state;
}
export async function edit(page, name='Edited', issue=null) {
  await page.locator('#editor > *').evaluate((designer,{name,issue})=>{
    designer.currentArtifact['schema:name']=name;
    designer.report={valid:!issue,canSave:!issue,issues:issue?[issue]:[]};
    designer.dispatchEvent(new CustomEvent('artifactChange'));
  },{name,issue});
}
