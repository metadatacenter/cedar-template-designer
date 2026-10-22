// The Designer host page with its backend, sign-in and components answered in the browser. The real
// host scripts, translations and markup are served; the designer is a small stand-in whose document,
// report and dirtiness a test sets directly. A case can instead serve a real designer bundle and the
// stored artifact it opens, which is the only way to see what the designer's projection does to it.
//
// The page and its API share one origin, named as a deployment's resource host, so the host takes the
// deployment's base from the API as it does in production: it mints identities on https://repo.designer.test/.
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
export const ORIGIN='https://resource.designer.test';
/** The form of an identity the host mints in a collection. */
export const minted=collection=>new RegExp(`^https://repo\\.designer\\.test/${collection}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);
// Unless a test names the identity a write stores (savedId), a create stores under the identity it sends.
export async function host(page, kind='template', mode='edit', allowed=true, initial={}) {
  // `item` is the opened artifact's identity in the page's address. A real designer refuses a relative
  // identity, so a case serving one names the UUID its absolute `@id` ends in.
  const item=initial.item??'item';
  const state={allowed,language:'en',writes:[],validations:[],stored:new Map(),failure:null,impact:{canBeUpdated:true},brokenLoad:false,holdWrite:null,savedId:mode==='edit'?item:undefined,nextEtag:'"next"',loadedId:item,loadedEtag:'"opened"',...initial,item};
  await page.route('https://workspace.test/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Workspace</h1>'}));
  await page.route(`${ORIGIN}/**`,async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    // A request named in `openingFailure` gets that answer instead of its own.
    const failing=state.openingFailure;
    if(failing&&OPENING_REQUESTS[failing.request](path,route.request().method()))return failing.answer(route);
    if(path.startsWith('/api/')) {
      if(path==='/api/users/user')return route.fulfill({json:{homeFolderId:'home'}});
      if(path.startsWith('/api/folders/'))return route.fulfill({json:{currentUserPermissions:{capabilities:state.allowed?['createInFolder']:[]}}});
      if(path.endsWith('/report'))return route.fulfill({json:{currentUserPermissions:{capabilities:state.allowed?['updateResource']:[]}}});
      if(path.includes('/check-update-template/'))return route.fulfill({json:state.impact});
      if(path==='/api/command/validate') {
        const body=route.request().postDataJSON();state.validations.push(body);
        if(state.holdValidation)await state.holdValidation;
        if(state.validationFailure)return route.fulfill(state.validationFailure);
        const verdict=state.validatePayload?await state.validatePayload(body,kind):{canSave:true,isValid:true,errors:[],warnings:[]};
        return route.fulfill({json:verdict});
      }
      if(route.request().method()!=='GET'){
        const write={path,query:Object.fromEntries(url.searchParams),body:route.request().postDataJSON(),etag:route.request().headers()['if-match']};
        state.writes.push(write);
        if(state.holdWrite)await state.holdWrite;
        if(state.failure==='network')return route.abort('failed');
        if(state.failure)return route.fulfill(state.failure);
        // A create names its identity in its address. The server answers with that identity in full.
        const named=route.request().method()==='PUT'&&!write.etag&&typeof write.body?.['@id']==='string'&&write.body['@id'].endsWith('/'+path.split('/').pop());
        if(state.savedId===undefined&&named)state.savedId=path.split('/').pop();
        const id=named&&state.savedId===path.split('/').pop()?write.body['@id']:state.stored.get(state.savedId)?.json['@id']??state.savedId;
        // What a write stores is what the artifact reads back as afterwards, under the same validator.
        if(state.savedId)state.stored.set(state.savedId,{json:{...write.body,'@id':id},etag:state.nextEtag});
        return route.fulfill({json:state.savedId?{'@id':id}:{},headers:state.nextEtag?{ETag:state.nextEtag}:{}});
      }
      const stored=state.stored.get(path.split('/').pop());
      if(stored)return route.fulfill({json:stored.json,headers:stored.etag?{ETag:stored.etag}:{}});
      // Only the opened artifact exists unless a write stored another.
      if(path.split('/').pop()!==state.item)return route.fulfill({status:404,json:{message:'Not found'}});
      if(state.brokenLoad)return route.fulfill({status:503,json:{message:'Load unavailable'}});
      const opened=state.loadedArtifact??{'@id':state.loadedId,'schema:name':'Opened',properties:{},...(state.unreadable?{unreadable:true}:{})};
      return route.fulfill({json:opened,headers:state.loadedEtag?{ETag:state.loadedEtag}:{}});
    }
    if(path==='/config/host.json')return route.fulfill({json:{workspaceFrontend:'https://workspace.test',resourceRestAPI:`${ORIGIN}/api`,userRestAPI:`${ORIGIN}/api`}});
    if(path==='/config/version.js')return route.fulfill({contentType:'text/javascript',body:"window.cedarCacheControl='fixture';"});
    if(path==='/scripts/handlers/KeycloakUserHandler.js')return route.fulfill({contentType:'text/javascript',body:`window.KeycloakUserHandler=class{initUserHandler(ok){ok(true)}doLogin(){window.signInCalls=(window.signInCalls||0)+1}getParsedToken(){return{sub:'user'}}getToken(){return 'test'}refreshToken(_n,ok){ok(true)}};`});
    if(path==='/components/manifest.json')return route.fulfill({json:Object.fromEntries(['cedar-embeddable-editor','cedar-embeddable-term-picker','cedar-embeddable-designer'].map(name=>[name,{sha256:'fixture'}]))});
    // `designerBundle` serves a real designer in place of the stand-in, for cases about what it projects.
    if(path==='/components/cedar-embeddable-designer.js'&&state.designerBundle)return route.fulfill({contentType:'text/javascript',body:readFileSync(state.designerBundle)});
    if(path==='/components/cedar-embeddable-designer.js')return route.fulfill({contentType:'text/javascript',body:`
      class Designer extends HTMLElement {
        currentArtifact={}; baseline=''; viewState={}; report={valid:true,canSave:true,issues:[]};
        connectedCallback(){this.textContent='Designer fixture'}
        get canSave(){return this.report.canSave}get validationReport(){return this.report}validate(){return this.report}
        get isDirty(){return JSON.stringify(this.currentArtifact)!==this.baseline}
        loadArtifact(value,options){if(!options?.preserveView)this.viewState={};if(value.unreadable)throw new Error('Child schema uses a reserved instance property name at /properties/@foo/');this.currentArtifact=structuredClone(value);this.baseline=JSON.stringify(value)}
        captureDraft(){return {format:'cedar-designer-draft',version:1,kind:'template',state:JSON.stringify({artifact:this.currentArtifact,baseline:this.baseline,report:this.report})}}
        restoreDraft(value){const data=JSON.parse(value.state);this.currentArtifact=data.artifact;this.baseline=data.baseline;this.report=data.report}
        newArtifact(){this.loadArtifact({'schema:name':''});this.report={valid:false,canSave:false,issues:[{setting:'name',shown:false,severity:'error'}]}}
      }
      setTimeout(()=>{
        // A new field opens its type chooser as a dialog over the whole page, as the real component does
        // while it is not read only. Choosing a type, the first change to the field, closes it, and
        // restored or loaded work already has its type.
        customElements.define('cedar-embeddable-field-designer',class extends Designer{
          #readOnly=false; choosing=false;
          constructor(){super();this.addEventListener('artifactChange',()=>{this.choosing=false;this.chooser()})}
          get readOnly(){return this.#readOnly}set readOnly(value){this.#readOnly=value;this.chooser()}
          newArtifact(){super.newArtifact();this.choosing=true;this.chooser()}
          loadArtifact(value,options){super.loadArtifact(value,options);this.choosing=false;this.chooser()}
          restoreDraft(value){super.restoreDraft(value);this.choosing=false;this.chooser()}
          chooser(){
            const open=this.choosing&&!this.#readOnly;let dialog=this.querySelector('.chooser');
            if(open&&!dialog){dialog=document.createElement('div');dialog.className='chooser';dialog.textContent='Choose field';
              dialog.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.3)';this.append(dialog);}
            if(!open)dialog?.remove();
          }
        });
        customElements.define('cedar-embeddable-designer',Designer);
      },30);`});
    if(path==='/components/cedar-validation-policy.mjs')return route.fulfill({contentType:'text/javascript',body:source('components/cedar-validation-policy.mjs')});
    // State-machine fixtures have partial artifacts and a stand-in designer. Real CED tests use
    // the shipped structural validator; only the stand-in's fixture boundary is stubbed.
    if(path==='/components/cedar-schema-validation.mjs')return route.fulfill({contentType:'text/javascript',body:state.designerBundle?
      source('components/cedar-schema-validation.mjs'):'export const SchemaArtifactValidator={validate:()=>({canSave:true,findings:[]})};'});
    if(path==='/components/icons.js')return route.fulfill({contentType:'text/javascript',body:'export const iconSvg=()=>"";'});
    if(path.startsWith('/components/')||path.startsWith('/scripts/keycloak/'))return route.fulfill({contentType:'text/javascript',body:''});
    if(path.startsWith('/scripts/')||path.startsWith('/i18n/'))return route.fulfill({contentType:path.endsWith('.json')?'application/json':'text/javascript',body:source(path.slice(1))});
    if(path.startsWith('/styles/'))return route.fulfill({contentType:'text/css',body:source(path.slice(1))});
    return route.fulfill({contentType:'text/html',body:source('index.html')});
  });
  // The host takes its language from the browser's preferences.
  await page.addInitScript(language=>Object.defineProperty(navigator,'languages',{get:()=>[language]}),state.language);
  await page.goto(`${ORIGIN}/${kind}s/${mode}${mode==='edit'?`/${state.item}`:''}`);
  if(state.brokenLoad||state.loadedId!==state.item||state.unreadable||state.openingFailure){
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
