import test from 'node:test';
import assert from 'node:assert/strict';
import {DesignerCoordinator} from '../app/scripts/host-state.mjs';
import {DesignerDraftStore, draftScope, readDraft} from '../app/scripts/host-draft.mjs';
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
