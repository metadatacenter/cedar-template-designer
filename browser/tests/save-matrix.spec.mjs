import {test,expect} from '@playwright/test';
import {host,edit,text} from './host-fixture.mjs';

// Save in the Designer host, across the kind of artifact, creating or editing, the language, whether
// the open artifact was edited, and how the server answers. Each case asserts where the page ends up,
// what it says and in which language, whether Save and Reload are offered, what the designer still
// holds, and what was written. Saving a template that metadata already uses asks first whether to
// create a new version, so editing a template adds the three answers to that question.

const COLLECTIONS={template:'templates',element:'template-elements',field:'template-fields'};
const OUTCOMES=['saved',400,401,403,404,409,412,500,'a network failure','an unidentified acknowledgement'];
const VERSIONING={'a new version confirmed':'confirm','a new version declined':'cancel','a new version discarded':'discard'};
// The server's own message is shown as it wrote it, in whatever language the server uses.
const SERVER_MESSAGE='Server says no';
const VALIDATION={message:'Validation failed',objects:{validationReport:{errors:[{location:'/properties/Link',message:'Invalid default IRI'}]}}};

const cases=[];
for(const kind of Object.keys(COLLECTIONS))for(const mode of ['create','edit'])for(const language of ['en','hu'])
  // A new artifact cannot be saved until it is named, so creating always edits.
  for(const edited of mode==='create'?[true]:[true,false])
    for(const outcome of [...OUTCOMES,...(kind==='template'&&mode==='edit'?Object.keys(VERSIONING):[])])
      cases.push({kind,mode,language,edited,outcome});

// What the page says after each failed save, and whether the open artifact must be reloaded first.
function failure(outcome,language,mode){
  const say=(key,params)=>text(language,key,params);
  switch(outcome){
    case 400:return {message:say('Error.RequestFailed',{status:400,detail:VALIDATION.message}),reload:false,findings:1};
    case 401:return {message:say('Error.SessionExpired'),reload:false};
    case 403:return {message:say('Error.Forbidden'),reload:true};
    case 404:case 409:return {message:say('Error.RequestFailed',{status:outcome,detail:SERVER_MESSAGE}),reload:true};
    case 412:return {message:say('Error.Conflict'),reload:true};
    case 500:return {message:say('Error.RequestFailed',{status:500,detail:SERVER_MESSAGE}),reload:false};
    case 'a network failure':return {message:say('Error.Unreachable'),reload:false};
    // A creation the server did not identify may have happened, so the page offers no reload to repeat it.
    case 'an unidentified acknowledgement':return {message:say('Error.SaveUnconfirmed'),reload:true,offerReload:mode==='edit'};
  }
}

for(const {kind,mode,language,edited,outcome} of cases)
  test(`${kind} ${mode} in ${language}, ${edited?'edited':'unedited'}, ${outcome}`,async({page})=>{
    const state=await host(page,kind,mode,true,{language});
    if(typeof outcome==='number')state.failure={status:outcome,json:outcome===400?VALIDATION:{message:SERVER_MESSAGE}};
    if(outcome==='a network failure')state.failure='network';
    if(outcome==='an unidentified acknowledgement')state.savedId=null;
    if(outcome in VERSIONING)state.impact={canBeUpdated:false,numberOfInstances:3,oldVersion:'0.0.1'};
    if(outcome==='a new version confirmed')state.savedId='new-draft';
    await expect(page.locator('html')).toHaveAttribute('lang',language);
    if(edited)await edit(page,'Edited');
    const name=edited?'Edited':'Opened';
    const designerName=()=>page.locator('#editor > *').evaluate(designer=>designer.currentArtifact['schema:name']);
    const save=page.locator('#save'),reload=page.locator('#reload'),message=page.locator('#message'),status=page.locator('#state');
    await expect(save).toBeEnabled();
    await save.click();

    if(outcome in VERSIONING){
      const dialog=page.locator('#version-dialog');
      await expect(dialog).toBeVisible();
      await expect(page.locator('#version-message')).toHaveText(text(language,'Version.InstancesOfVersion',{count:3,version:'0.0.1'}));
      await dialog.locator(`button[value=${VERSIONING[outcome]}]`).click();
    }
    if(outcome==='saved'||outcome==='a new version confirmed'){
      // A successful save stays in Designer, at the edit address of what it stored, and holds that.
      await expect(status).toHaveText(text(language,'State.Saved'));
      await expect(page).toHaveURL(new RegExp(`/${kind}s/edit/${state.savedId}$`));
      await expect(page.getByRole('heading',{name:'Workspace'})).toHaveCount(0);
      await expect(message).toHaveText('');
      expect(await designerName()).toBe(name);
      await expect(save).toBeEnabled();await expect(reload).toBeHidden();
      expect(state.writes).toEqual([{
        path:outcome==='saved'?`/api/${COLLECTIONS[kind]}${mode==='edit'?'/item':''}`:'/api/command/publish-create-draft-template/item',
        body:expect.objectContaining({'schema:name':name}),
        etag:mode==='edit'?'"opened"':undefined,
      }]);
      return;
    }
    if(outcome==='a new version declined'||outcome==='a new version discarded'){
      const discarded=outcome==='a new version discarded';
      await expect(message).toHaveText(text(language,discarded?'Message.ChangesDiscarded':'Message.ChangesKept'));
      await expect(message).toHaveAttribute('data-tone','info');
      expect(await designerName()).toBe(discarded?'Opened':name);
      await expect(status).toHaveText(text(language,edited&&!discarded?'State.Modified':'State.Unmodified'));
      await expect(save).toBeEnabled();await expect(reload).toBeHidden();
      expect(state.writes).toHaveLength(0);
      return;
    }

    const expected=failure(outcome,language,mode);
    await expect(message).toHaveText(expected.message);
    await expect(message).toHaveAttribute('data-tone','error');
    // A failed save keeps the edit, and the page stays where it is.
    expect(await designerName()).toBe(name);
    await expect(page.getByRole('heading',{name:'Workspace'})).toHaveCount(0);
    await expect(status).toHaveText(text(language,expected.reload?'State.ReloadRequired':edited?'State.Modified':'State.Unmodified'));
    if(expected.findings){
      await expect(page.locator('#server-issues')).toBeVisible();
      await expect(page.locator('#server-issues-title')).toHaveText(text(language,expected.findings===1?'Message.ServerFindingsOne':'Message.ServerFindings',{count:expected.findings}));
    }else await expect(page.locator('#server-issues')).toBeHidden();
    // Save stays refused while a server error is listed or the artifact must be reloaded.
    if(expected.reload||expected.findings)await expect(save).toBeDisabled();else await expect(save).toBeEnabled();
    if(expected.offerReload??expected.reload)await expect(reload).toBeVisible();else await expect(reload).toBeHidden();
    // An expired session is refreshed and the write tried once more.
    expect(state.writes).toHaveLength(outcome===401?2:1);
  });
