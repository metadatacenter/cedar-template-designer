import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DesignerCoordinator} from '../app/scripts/host-state.mjs';
import {updateOutcome, sameRevision} from '../app/scripts/save-recovery.mjs';
const opened = {'@id':'urn:item','schema:name':'Opened','pav:lastUpdatedOn':'old',
  properties:{Term:{'@id':'urn:field',_valueConstraints:{classes:[{uri:'urn:term'}]}}}};
const submitted = {...opened, 'schema:name':'Submitted'};
const pending = {opened, submitted, etag:'"10--gzip"'};
const latest = () => ({data:{...structuredClone(submitted),'pav:lastUpdatedOn':'new','oslc:modifiedBy':'urn:user'},etag:'"11"'});
for (const change of ['name','annotation','child identity','term','unknown']) test(`a different ${change} cannot be mistaken for the submitted save`,()=>{
  const reply=latest();
  if(change==='name')reply.data['schema:name']='Other';
  if(change==='annotation')reply.data._annotations={'urn:note':{'@value':'Other'}};
  if(change==='child identity')reply.data.properties.Term['@id']='urn:other';
  if(change==='term')reply.data.properties.Term._valueConstraints.classes[0].uri='urn:other';
  if(change==='unknown')reply.data.extra='Other';
  assert.equal(updateOutcome(pending,reply),'changed');
});
// The server stamps a changed child with fresh modification provenance, gives a new child a creation
// record, and replaces a temporary child identifier with one of its own. A save that did only that is
// the submitted save; a child holding other content is not.
test('provenance and identifiers the server assigns to children still read as the submitted save',()=>{
  const sent={...structuredClone(submitted),properties:{...structuredClone(submitted.properties),
    Added:{'@id':'tmp-1760650000000-added','schema:name':'Added'}}};
  const reply={data:{...structuredClone(sent),'pav:lastUpdatedOn':'new','oslc:modifiedBy':'urn:user'},etag:'"11"'};
  reply.data.properties.Term={...reply.data.properties.Term,'pav:lastUpdatedOn':'new','oslc:modifiedBy':'urn:user'};
  reply.data.properties.Added={...reply.data.properties.Added,'@id':'https://repo.test/template-fields/9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a',
    'pav:createdOn':'new','pav:createdBy':'urn:user','pav:lastUpdatedOn':'new','oslc:modifiedBy':'urn:user'};
  assert.equal(updateOutcome({...pending,submitted:sent},reply),'saved');
  reply.data.properties.Added['schema:name']='Someone else';
  assert.equal(updateOutcome({...pending,submitted:sent},reply),'changed');
});
test('only root update provenance and object order may differ in a matching save',()=>{
  assert.equal(updateOutcome(pending,latest()),'saved');
  assert.equal(updateOutcome(pending,{data:structuredClone(opened),etag:'"10-resource-record--gzip"'}),'unchanged');
  assert.equal(updateOutcome(pending,{data:submitted,etag:'"10"'}),'unresolved');
  for(const reply of [{data:submitted,etag:null},{data:{...submitted,'@id':'urn:other'},etag:'"11"'},{data:null,etag:'"11"'}])
    assert.equal(updateOutcome(pending,reply),'unresolved');
  assert.equal(sameRevision('"10"','W/"10"'),false);
  assert.equal(sameRevision('"opaque"','"opaque--gzip"'),false);
});
function setup(createsIdentity=false){
  const state=new DesignerCoordinator();
  const designer={currentArtifact:structuredClone(opened),isDirty:true,validationReport:{canSave:true,issues:[]},validate(){return this.validationReport;}};
  state.loaded({artifact:opened,etag:pending.etag,writable:true});
  designer.currentArtifact=structuredClone(submitted);
  const attempt=state.beginSave(designer);
  attempt.write={createsIdentity,body:structuredClone(submitted)};
  state.failed(new Error('Lost response'),attempt);state.finish(attempt);
  return{state,designer,attempt};
}
for(const outcome of ['saved','unchanged','changed','readonly','missing revision'])test(`recovery ${outcome} retains newer local input and releases only a reconciled write`,()=>{
  const{state,designer}=setup();
  const check=state.beginCheck();assert.ok(check);assert.equal(state.beginCheck(),null);
  designer.currentArtifact['schema:name']='Newer';
  const reply=outcome==='unchanged'?{data:opened,etag:'"10"'}:latest();
  if(outcome==='changed')reply.data['schema:name']='Other';
  if(outcome==='missing revision')reply.etag=null;
  assert.equal(state.checked(check,reply,outcome!=='readonly'),outcome==='missing revision'?'unresolved':outcome);
  state.finishCheck(check);
  assert.equal(designer.currentArtifact['schema:name'],'Newer');
  assert.equal(state.dirty(designer),true);
  assert.equal(state.report(designer).canSave,['saved','unchanged'].includes(outcome));
  assert.equal(state.etag,outcome==='saved'?'"11"':pending.etag);
  assert.equal(state.canCheckSave,!['saved','unchanged'].includes(outcome));
});
for(const transition of ['reload','failed load','dispose'])test(`late status check after ${transition} cannot change the document or revision`,()=>{
  const{state}=setup();const check=state.beginCheck();
  if(transition==='reload')state.loaded({artifact:{'@id':'urn:replacement'},etag:'"replacement"',writable:false});
  else if(transition==='failed load')state.failLoad();else state.dispose();
  assert.equal(state.checked(check,latest(),true),'obsolete');
  assert.notEqual(state.etag,'"11"');assert.equal(state.canCheckSave,false);
});
test('failed reads can be repeated, while creates never offer an update status check',()=>{
  const{state,designer}=setup();let check=state.beginCheck();state.finishCheck(check);
  assert.equal(state.report(designer).canSave,false);
  check=state.beginCheck();assert.equal(state.checked(check,latest(),true),'saved');state.finishCheck(check);
  assert.equal(state.dirty(designer),false);
  assert.equal(setup(true).state.beginCheck(),null);
});
