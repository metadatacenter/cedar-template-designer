import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DesignerCoordinator} from '../app/scripts/host-state.mjs';

const opened = {'@id':'urn:item','schema:name':'Opened', properties:{}, extra:'Keep'};
function setup({createsIdentity=false, requiresReload=false, hasOpenedRevision=true}={}) {
  const state = new DesignerCoordinator();
  const designer = {currentArtifact:{...opened,'schema:name':'Submitted'}, isDirty:true,
    validationReport:{canSave:true,issues:[]}, validate(){return this.validationReport;}};
  state.loaded({artifact:opened,etag:hasOpenedRevision?'"opened"':null,writable:true});
  const attempt = state.beginSave(designer);
  const write = {createsIdentity,body:structuredClone(attempt.artifact)};
  state.committed(attempt,null,requiresReload,write);state.finish(attempt);
  return {state,designer,write};
}
for(const outcome of ['saved','old revision','changed','readonly','missing revision','wrong identity'])
  test(`confirmed update without an ETag: ${outcome}`,()=>{
    const {state,designer,write}=setup();
    assert.equal(state.canCheckSave,true);
    assert.equal(state.report(designer).canSave,false);
    assert.equal(state.dirty(designer),false);
    designer.currentArtifact['schema:name']='Newer';
    const check=state.beginCheck();
    const reply=outcome==='old revision'?{data:opened,etag:'"opened"'}:
      {data:{...write.body,'pav:lastUpdatedOn':'now'},etag:'"saved"'};
    if(outcome==='changed')reply.data.extra='Other author';
    if(outcome==='missing revision')reply.etag=null;
    if(outcome==='wrong identity')reply.data['@id']='urn:other';
    const result=state.checked(check,reply,outcome!=='readonly');state.finishCheck(check);
    assert.equal(result, outcome==='saved'?'saved':outcome==='readonly'?'readonly':
      ['missing revision','wrong identity'].includes(outcome)?'unresolved':'changed');
    assert.equal(state.report(designer).canSave,outcome==='saved');
    assert.equal(state.canCheckSave,outcome!=='saved');
    assert.equal(state.etag,outcome==='saved'?'"saved"':null);
    assert.equal(designer.currentArtifact['schema:name'],'Newer');
    assert.equal(state.dirty(designer),true);
    if(outcome==='saved'){
      const next=state.beginSave(designer);
      assert.equal(next.artifact.extra,'Keep');
      assert.equal(next.artifact['schema:name'],'Newer');
    }
  });
test('a failed check can be repeated without losing the captured submission',()=>{
  const {state,designer,write}=setup();
  let check=state.beginCheck();state.finishCheck(check);
  check=state.beginCheck();
  assert.equal(state.checked(check,{data:write.body,etag:'"saved"'},true),'saved');
  state.finishCheck(check);
  assert.equal(state.dirty(designer),false);
});
for(const options of [{createsIdentity:true},{requiresReload:true},{hasOpenedRevision:false}])
  test(`confirmed create or missing opened evidence cannot offer update recovery: ${JSON.stringify(options)}`,()=>{
    const {state}=setup(options);
    assert.equal(state.canCheckSave,false);
    assert.equal(state.beginCheck(),null);
  });
test('a late check cannot acknowledge a replacement document',()=>{
  const {state,write}=setup();const check=state.beginCheck();
  state.loaded({artifact:{'@id':'urn:replacement'},etag:'"replacement"',writable:false});
  assert.equal(state.checked(check,{data:write.body,etag:'"saved"'},true),'obsolete');
  assert.equal(state.etag,'"replacement"');assert.equal(state.canCheckSave,false);
});
