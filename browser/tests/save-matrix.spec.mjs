import {test,expect} from '@playwright/test';
import {host,edit,text,minted} from './host-fixture.mjs';

// Save in the Designer host, across the kind of artifact, creating or editing, whether the open
// artifact was edited, and how the server answers. Each case asserts where the page ends up, what it
// says and in which language, whether Save, Reload and the recovery controls are offered, what the
// designer still holds, and what was written. Saving a template that metadata already uses asks first
// whether to create a new version, so editing a template adds the three answers to that question and
// the answers the server can give to a confirmed new version.
//
// The language selects only the catalogue a message comes from and never a branch in the code
// under test, so every case runs in English. A case runs in Hungarian as well when it is the first
// to leave its message, so that each message a save can leave appears once in Hungarian.

const COLLECTIONS={template:'templates',element:'template-elements',field:'template-fields'};
const OUTCOMES=['saved',400,401,403,404,409,412,500,'a network failure','an unidentified acknowledgement'];
const VERSIONING={'a new version confirmed':'confirm','a new version declined':'cancel','a new version discarded':'discard'};
// A confirmed new version the server refuses, or whose answer is lost.
const REFUSED_VERSION={'a new version refused (400)':400,'a new version refused (403)':403,'a new version refused (404)':404,
  'a new version refused (409)':409,'a new version failing (500)':500,'a new version without an answer':'a network failure'};
// The server's own message is shown as it wrote it, in whatever language the server uses.
const SERVER_MESSAGE='Server says no';
const VALIDATION={message:'Validation failed',objects:{validationReport:{errors:[{location:'/properties/Link',message:'Invalid default IRI'}]}}};

const cases=[],shownInHungarian=new Set();
for(const kind of Object.keys(COLLECTIONS))for(const mode of ['create','edit'])
  // A new artifact cannot be saved until it is named, so creating always edits.
  for(const edited of mode==='create'?[true]:[true,false])
    for(const outcome of [...OUTCOMES,...(kind==='template'&&mode==='edit'?[...Object.keys(VERSIONING),...Object.keys(REFUSED_VERSION)]:[])]){
      const hungarian=messageAfter(outcome,'hu',mode);
      const languages=shownInHungarian.has(hungarian)?['en']:['en','hu'];
      shownInHungarian.add(hungarian);
      for(const language of languages)cases.push({kind,mode,language,edited,outcome});
    }

/** What #message says once a save with this outcome has ended. */
function messageAfter(outcome,language,mode){
  if(outcome==='saved'||outcome==='a new version confirmed')return '';
  if(outcome==='a new version declined')return text(language,'Message.ChangesKept');
  if(outcome==='a new version discarded')return text(language,'Message.ChangesDiscarded');
  return failure(REFUSED_VERSION[outcome]??outcome,language,mode,outcome in REFUSED_VERSION).message;
}

// What the page says after each failed save, whether the open artifact must be reloaded first, and
// which recovery control it offers. A write whose answer was lost, and a create whose identity the
// server already holds, may have been stored. The page checks rather than offering to repeat it.
function failure(outcome,language,mode,version=false){
  const say=(key,params)=>text(language,key,params);
  const lost={message:say('Error.SaveUnconfirmed'),reload:true,offerReload:mode==='edit'&&!version,check:true};
  switch(outcome){
    case 400:return {message:say('Error.RequestFailed',{status:400,detail:VALIDATION.message}),reload:false,findings:1};
    case 401:return {message:say('Error.SessionExpired'),reload:true,recheck:mode==='edit'};
    case 403:return {message:say('Error.Forbidden'),reload:true,recheck:mode==='edit'};
    case 404:case 409:return {message:say('Error.RequestFailed',{status:outcome,detail:SERVER_MESSAGE}),reload:true};
    case 412:return mode==='create'?{...lost,offerReload:false}:{message:say('Error.Conflict'),reload:true};
    case 500:case 'a network failure':case 'an unidentified acknowledgement':return lost;
  }
}

for(const {kind,mode,language,edited,outcome} of cases)
  test(`${kind} ${mode} in ${language}, ${edited?'edited':'unedited'}, ${outcome}`,async({page})=>{
    const state=await host(page,kind,mode,true,{language});
    const answer=REFUSED_VERSION[outcome]??outcome;
    if(typeof answer==='number')state.failure={status:answer,json:answer===400?VALIDATION:{message:SERVER_MESSAGE}};
    if(answer==='a network failure')state.failure='network';
    if(outcome==='an unidentified acknowledgement')state.savedId=null;
    if(outcome in VERSIONING||outcome in REFUSED_VERSION)state.impact={canBeUpdated:false,numberOfInstances:3,oldVersion:'0.0.1'};
    if(outcome==='a new version confirmed')state.savedId='new-draft';
    await expect(page.locator('html')).toHaveAttribute('lang',language);
    if(edited)await edit(page,'Edited');
    const name=edited?'Edited':'Opened';
    const designerName=()=>page.locator('#editor > *').evaluate(designer=>designer.currentArtifact['schema:name']);
    const save=page.locator('#save'),reload=page.locator('#reload'),message=page.locator('#message'),status=page.locator('#state');
    const check=page.locator('#check-save'),recheck=page.locator('#recheck-access');
    await expect(save).toBeEnabled();
    await save.click();

    if(outcome in VERSIONING||outcome in REFUSED_VERSION){
      const dialog=page.locator('#version-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.locator('#version-message')).toHaveText(text(language,'Version.InstancesOfVersion',{count:3,version:'0.0.1'}));
      await dialog.locator(`button[value=${VERSIONING[outcome]??'confirm'}]`).click();
    }
    if(outcome==='saved'||outcome==='a new version confirmed'){
      // A successful save stays in Designer, at the edit address of what it stored, and holds that.
      await expect(status).toHaveText(text(language,'State.Saved'));
      await expect(page).toHaveURL(new RegExp(`/${kind}s/edit/${state.savedId}$`));
      await expect(page.getByRole('heading',{name:'Workspace'})).toHaveCount(0);
      await expect(message).toHaveText('');
      expect(await designerName()).toBe(name);
      await expect(save).toBeEnabled();await expect(reload).toBeHidden();
      await expect(check).toBeHidden();await expect(recheck).toBeHidden();await expect(page.locator('#draft-offer')).toBeHidden();
      // A create puts the identity it minted. A new version names the draft identity it asks for.
      const created=mode==='create'?state.writes[0].body['@id']:undefined;
      expect(state.writes).toEqual([{
        path:outcome==='saved'?`/api/${COLLECTIONS[kind]}/${mode==='edit'?'item':state.savedId}`:'/api/command/publish-create-draft-template/item',
        query:mode==='create'?{folder_id:'home'}:outcome==='saved'?{}:{draft_id:expect.stringMatching(minted('templates'))},
        body:expect.objectContaining({'schema:name':name,'@id':mode==='create'?expect.stringMatching(minted(COLLECTIONS[kind])):'item'}),
        etag:mode==='edit'?'"opened"':undefined,
      }]);
      if(created)expect(created.endsWith('/'+state.savedId)).toBe(true);
      return;
    }
    if(outcome==='a new version declined'||outcome==='a new version discarded'){
      const discarded=outcome==='a new version discarded';
      await expect(message).toHaveText(text(language,discarded?'Message.ChangesDiscarded':'Message.ChangesKept'));
      await expect(message).toHaveAttribute('data-tone','info');
      expect(await designerName()).toBe(discarded?'Opened':name);
      await expect(status).toHaveText(text(language,edited&&!discarded?'State.Modified':'State.Unmodified'));
      await expect(save).toBeEnabled();await expect(reload).toBeHidden();
      await expect(check).toBeHidden();await expect(recheck).toBeHidden();
      expect(state.writes).toHaveLength(0);
      return;
    }

    const expected=failure(answer,language,mode,outcome in REFUSED_VERSION);
    await expect(message).toHaveText(expected.message);
    await expect(message).toHaveAttribute('data-tone','error');
    // A failed save keeps the edit, and the page stays where it is.
    expect(await designerName()).toBe(name);
    await expect(page.getByRole('heading',{name:'Workspace'})).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/${kind}s/${mode}${mode==='edit'?'/item':''}$`));
    await expect(status).toHaveText(text(language,expected.reload?'State.ReloadRequired':edited?'State.Modified':'State.Unmodified'));
    if(expected.findings){
      await expect(page.locator('#server-issues')).toBeVisible();
      await expect(page.locator('#server-issues-title')).toHaveText(text(language,expected.findings===1?'Message.ServerFindingsOne':'Message.ServerFindings',{count:expected.findings}));
    }else await expect(page.locator('#server-issues')).toBeHidden();
    // Save stays refused while a server error is listed or the artifact must be reloaded.
    if(expected.reload||expected.findings)await expect(save).toBeDisabled();else await expect(save).toBeEnabled();
    if(expected.offerReload??expected.reload)await expect(reload).toBeVisible();else await expect(reload).toBeHidden();
    if(expected.check)await expect(check).toBeVisible();else await expect(check).toBeHidden();
    if(expected.recheck)await expect(recheck).toBeVisible();else await expect(recheck).toBeHidden();
    // An expired session is refreshed and the write tried once more.
    expect(state.writes).toHaveLength(answer===401?2:1);
    if(outcome in REFUSED_VERSION)expect(state.writes[0]).toEqual({path:'/api/command/publish-create-draft-template/item',
      query:{draft_id:expect.stringMatching(minted('templates'))},body:expect.objectContaining({'schema:name':name,'@id':'item'}),etag:'"opened"'});
  });

/** Save the edited template as a new version, confirming the version dialog. */
async function saveNewVersion(page){
  await page.locator('#save').click();
  await page.locator('#version-dialog button[value=confirm]').click();
}

test('a new version refused for validation is corrected and then created once, under the identity it first named',async({page})=>{
  const state=await host(page,'template','edit',true,{impact:{canBeUpdated:false},savedId:'new-draft'});
  state.failure={status:400,json:VALIDATION};
  await edit(page,'Refused');await saveNewVersion(page);
  await expect(page.locator('#server-issues')).toBeVisible();
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#state')).toHaveText('Modified');
  state.failure=null;await edit(page,'Corrected');
  await expect(page.locator('#server-issues')).toBeHidden();
  await saveNewVersion(page);
  await expect(page.locator('#state')).toHaveText('Saved');
  await expect(page).toHaveURL(/\/templates\/edit\/new-draft$/);
  expect(state.writes.map(write=>[write.path,write.etag,write.body['schema:name']])).toEqual([
    ['/api/command/publish-create-draft-template/item','"opened"','Refused'],
    ['/api/command/publish-create-draft-template/item','"opened"','Corrected'],
  ]);
  expect(state.writes[1].query.draft_id).toBe(state.writes[0].query.draft_id);
});

test('a new version refused permission is restored after a reload, still guarded, without another write',async({page})=>{
  const state=await host(page,'template','edit',true,{impact:{canBeUpdated:false}});
  state.failure={status:403,json:{message:SERVER_MESSAGE}};
  await edit(page,'Refused version');await saveNewVersion(page);
  await expect(page.locator('#message')).toHaveText(text('en','Error.Forbidden'));
  await expect(page.locator('#recheck-access')).toBeVisible();await expect(page.locator('#check-save')).toBeHidden();
  page.on('dialog',dialog=>dialog.accept());await page.reload();
  await expect(page.locator('#draft-offer')).toBeVisible();
  await expect(page.locator('#check-save')).toBeHidden();await expect(page.locator('#recheck-access')).toBeHidden();
  await page.locator('#restore-draft').click();
  await expect(page.locator('#message')).toHaveText(text('en','Draft.RestoredGuarded'));
  expect(await page.locator('#editor > *').evaluate(el=>el.currentArtifact['schema:name'])).toBe('Refused version');
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#recheck-access')).toBeVisible();await expect(page.locator('#check-save')).toBeHidden();
  expect(state.writes).toHaveLength(1);
});

// Recovery controls are exceptional, so none appears while a page opens, stays unchanged, is edited and saved.
for(const kind of Object.keys(COLLECTIONS))for(const mode of ['create','edit'])
  test(`${kind} ${mode} offers no recovery control on a fresh, unchanged or ordinarily edited page`,async({page})=>{
    const state=await host(page,kind,mode);
    const recovery=page.locator('#check-save, #recheck-access, #draft-offer, #sign-in-again, #reload, #server-issues');
    // Every control is present to be hidden, so the check cannot pass by matching nothing.
    const absent=async()=>{await expect(recovery).toHaveCount(6);for(const control of await recovery.all())await expect(control).toBeHidden();};
    await absent();
    await edit(page,'Ordinary edit');await expect(page.locator('#state')).toHaveText('Modified');await absent();
    await page.locator('#save').click();await expect(page.locator('#state')).toHaveText('Saved');await absent();
    await page.reload();await expect(page.locator('#state')).toHaveText('Unmodified');await absent();
    expect(state.writes).toHaveLength(1);
  });
