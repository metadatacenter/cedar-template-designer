import test from 'node:test';
import assert from 'node:assert/strict';
import {DesignerCoordinator} from '../app/scripts/host-state.mjs';
import {DesignerDraftStore, discardable, draftScope, readDraft} from '../app/scripts/host-draft.mjs';
import {BackendError, useDeploymentApi} from '../app/scripts/host-core.mjs';
const opened={'@id':'item','schema:name':'Opened'};
const designer={currentArtifact:{...opened,'schema:name':'Edited'},isDirty:true,validationReport:{valid:true,canSave:true,issues:[]},validate(){return this.validationReport}};
const fresh=()=>{const state=new DesignerCoordinator();state.loaded({artifact:opened,etag:'"1"',writable:true});return state};
test('pre-dispatch journal restores a pending update without callbacks and checks its stored outcome',()=>{
  const state=fresh(),attempt=state.beginSave(designer);attempt.write={body:attempt.artifact,createsIdentity:false};
  const copy=JSON.parse(JSON.stringify(state.captureRecovery(attempt)));
  const restored=fresh();restored.restoreRecovery(copy);
  assert.equal(restored.report(designer).canSave,false);assert.equal(restored.canCheckSave,true);
  const check=restored.beginCheck();assert.equal(restored.checked(check,{data:opened,etag:'"1"'},true),'unchanged');
  restored.finishCheck(check);assert.equal(restored.report(designer).canSave,true);
});
test('a changed stored revision or current permission never becomes writable from a snapshot',()=>{
  for(const [etag,writable] of [['"2"',true],['"1"',false]]){
    const state=fresh(),copy=state.captureRecovery(),restored=fresh();
    restored.loaded({artifact:opened,etag,writable});restored.restoreRecovery(copy);
    assert.equal(restored.report(designer).canSave,false);assert.equal(restored.etag,'"1"');
  }
});
test('storage isolates deployment, account, collection, identity and create folder',()=>{
  const scope=draftScope('api','u',{collection:'templates',id:'item'},'home');
  for(const other of [draftScope('api2','u',{collection:'templates',id:'a'},'home'),draftScope('api','v',{collection:'templates',id:'a'},'home'),draftScope('api','u',{collection:'fields',id:'a'},'home'),draftScope('api','u',{collection:'templates',id:'b'},'home'),draftScope('api','u',{collection:'templates'},'home')])assert.notEqual(other,scope);
  const storage=new Map(),store=new DesignerDraftStore(scope,{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)});
  const value={format:'cedar-host-draft',version:1,scope,draft:{format:'cedar-designer-draft',version:1,state:'{}'},coordinator:fresh().captureRecovery()};
  store.write(value);assert.deepEqual(store.read(),JSON.parse(JSON.stringify(value)));assert.throws(()=>readDraft(JSON.stringify(value),'another'));
  assert.throws(()=>readDraft(JSON.stringify({...value,coordinator:{...value.coordinator,stored:{'@id':'other'}}}),scope));
  store.clear();assert.equal(store.read(),null);
});
for(const severity of ['errors','warnings'])test(`restored ${severity} stay bound to their rejected draft until it changes`,()=>{
  const component={...designer,currentArtifact:structuredClone(designer.currentArtifact)};
  const state=fresh(),attempt=state.beginSave(component);
  state.failed({status:400,data:{validationReport:{[severity]:[{location:'/schema:name',message:'Review the name'}]}}},attempt);state.finish(attempt);
  const restored=fresh();restored.restoreRecovery(JSON.parse(JSON.stringify(state.captureRecovery())));
  assert.equal(restored.report(component).server[0]?.message,'Review the name');
  assert.equal(restored.report(component).canSave,severity==='warnings');
  component.currentArtifact['schema:name']='Corrected';
  assert.equal(restored.report(component).server.length,0);assert.equal(restored.report(component).canSave,true);
});

// A create or new version is journaled with the identity it is sent under before it is sent, so a lost
// answer can be settled after a reload or a sign-in. Identities sit on https://repo.test/.
useDeploymentApi('https://resource.test');
const UUID='0f1e2d3c-4b5a-4968-8776-655443322110';
const SOURCE='https://repo.test/templates/'+UUID;
const MINTED='https://repo.test/templates/6a3d1f0e-2b4c-4d5e-8f60-718293a4b5c6';
const ELEMENT='https://repo.test/template-elements/6a3d1f0e-2b4c-4d5e-8f60-718293a4b5c6';
const memory=()=>{const storage=new Map();return {getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};};
const component=()=>({currentArtifact:{'@id':SOURCE,'schema:name':'Submitted',properties:{}},validationReport:{valid:true,canSave:true,issues:[]},
  validate(){return this.validationReport},captureDraft:()=>({format:'cedar-designer-draft',version:1,state:'{}'})});
/** A page that sent a create or new version under MINTED, journaled before dispatch, whose answer was lost. */
function journaled(operation,{lose=true}={}){
  const scope=draftScope('api','u',{collection:'templates',id:operation==='create'?'':UUID},'home');
  const store=new DesignerDraftStore(scope,memory()),designer=component(),state=new DesignerCoordinator();
  if(operation==='create')state.loaded({writable:true});
  else state.loaded({artifact:{'@id':SOURCE,'schema:name':'Opened','bibo:status':'bibo:draft'},etag:'"opened"',writable:true});
  const attempt=state.beginSave(designer);
  attempt.write={createsIdentity:true,operation,identity:state.identity(()=>MINTED),body:{...attempt.artifact,'@id':operation==='create'?MINTED:SOURCE}};
  store.write(store.capture(designer,state,attempt));
  const beforeDispatch=store.read();
  if(lose){state.failed(new BackendError(0),attempt);state.finish(attempt);store.write(store.capture(designer,state));}
  return {scope,store,state,beforeDispatch,raw:()=>store.backend.getItem(store.key)};
}
for(const operation of ['create','version'])test(`a ${operation} identity round-trips through capture, readDraft and restore`,()=>{
  const {scope,store,beforeDispatch}=journaled(operation);
  for(const value of [beforeDispatch,store.read()]){
    assert.equal(value.coordinator.identity,MINTED);assert.equal(value.coordinator.creation.id,MINTED);
    assert.equal(value.coordinator.uncertainCreation,true);assert.equal(discardable(value),false);
    if(operation==='version')assert.deepEqual([value.coordinator.creation.source,value.coordinator.creation.etag],[SOURCE,'"opened"']);
  }
  const restored=new DesignerCoordinator();
  if(operation==='create')restored.loaded({writable:true});
  else restored.loaded({artifact:{'@id':SOURCE,'schema:name':'Opened','bibo:status':'bibo:draft'},etag:'"opened"',writable:true});
  restored.restoreRecovery(readDraft(JSON.stringify(store.read()),scope).coordinator);
  assert.equal(restored.uncertainCreation,true);assert.equal(restored.reloadRequired,true);
  assert.equal(restored.canCheckSave,true);assert.equal(restored.creation.id,MINTED);
  assert.equal(restored.identity(()=>assert.fail('a second identity was minted')),MINTED);
});
for(const operation of ['create','version'])test(`a ${operation} identity is refused in another scope or form`,()=>{
  const {store,raw}=journaled(operation);
  const value=JSON.parse(raw());
  const id=operation==='create'?'':UUID;
  const elsewhere=[draftScope('api','u',{collection:'template-elements',id},'home'),draftScope('api','u',{collection:'templates',id:operation==='create'?UUID:''},'home')];
  for(const other of [draftScope('api2','u',{collection:'templates',id},'home'),draftScope('api','v',{collection:'templates',id},'home'),...elsewhere])
    assert.throws(()=>readDraft(raw(),other));
  // Relabelled for another collection or route, the identity no longer belongs there.
  for(const other of elsewhere)assert.throws(()=>readDraft(JSON.stringify({...value,scope:other}),other));
  const altered=change=>JSON.stringify({...value,coordinator:{...value.coordinator,...change(value.coordinator)}});
  for(const change of [
    ()=>({identity:ELEMENT,creation:{...value.coordinator.creation,id:ELEMENT}}),
    ()=>({identity:'templates/'+UUID,creation:{...value.coordinator.creation,id:'templates/'+UUID}}),
    ()=>({identity:'https://repo.other/templates/'+UUID,creation:{...value.coordinator.creation,id:'https://repo.other/templates/'+UUID}}),
    ()=>({identity:MINTED.replace(/c6$/,'c7')}),
    ()=>({creation:{...value.coordinator.creation,operation:operation==='create'?'version':'create'}}),
    ()=>({creation:null}),
    ...(operation==='version'?[()=>({creation:{...value.coordinator.creation,source:'https://repo.test/templates/'+MINTED.slice(-36)}})]:[]),
  ])assert.throws(()=>readDraft(altered(change),store.scope));
  // The coordinator refuses what the scope cannot judge: a creation that is not unsettled, or that disagrees with what was opened.
  const coordinator=readDraft(raw(),store.scope).coordinator;
  for(const change of [{uncertainCreation:false},{creation:{...coordinator.creation,submitted:null}},{creation:{...coordinator.creation,projection:[]}},
    ...(operation==='version'?[{creation:{...coordinator.creation,etag:'"other"'}},{creation:{...coordinator.creation,submitted:{...coordinator.creation.submitted,'@id':MINTED}}}]
      :[{creation:{...coordinator.creation,submitted:{...coordinator.creation.submitted,'@id':SOURCE}}}])])
    assert.throws(()=>new DesignerCoordinator().restoreRecovery({...coordinator,...change}));
});
test('a journal written before identities were sent keeps its guard and cannot be checked',()=>{
  const {store,raw}=journaled('create');
  const legacy=JSON.parse(raw());delete legacy.coordinator.identity;delete legacy.coordinator.creation;
  store.write(legacy);const value=store.read();
  assert.equal(discardable(value),false);
  const restored=new DesignerCoordinator();restored.loaded({writable:true});restored.restoreRecovery(value.coordinator);
  assert.equal(restored.reloadRequired,true);assert.equal(restored.canCheckSave,false);assert.equal(restored.beginCheck(),null);
  assert.equal(restored.report(component()).canSave,false);
});
test('Discard is refused until a create or new version is settled, and allowed once it is',()=>{
  const {store,state}=journaled('create');
  assert.equal(discardable(store.read()),false);
  const check=state.beginCheck();assert.equal(state.settleCreation(check,{created:null,writable:true}),'absent');state.finishCheck(check);
  store.write(store.capture(component(),state));
  const settled=store.read();
  assert.equal(discardable(settled),true);
  // The identity outlives the settlement, so a Save after a reload cannot mint a second one.
  assert.equal(settled.coordinator.identity,MINTED);assert.equal(settled.coordinator.creation,undefined);
  const restored=new DesignerCoordinator();restored.loaded({writable:true});restored.restoreRecovery(settled.coordinator);
  assert.equal(restored.reloadRequired,false);assert.equal(restored.canCheckSave,false);
  assert.equal(restored.identity(()=>assert.fail('a second identity was minted')),MINTED);
  // Until its answer arrives, a write journaled before dispatch is unsettled too.
  assert.equal(discardable(journaled('version',{lose:false}).store.read()),false);
});
