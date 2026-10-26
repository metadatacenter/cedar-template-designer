import {acceptPayload} from './helpers/validation.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DesignerCoordinator} from '../app/scripts/host-state.mjs';
const opened={'@id':'urn:item','schema:name':'Opened'};
for(const status of [401,403])for(const preflight of [false,true])for(const outcome of ['restored','denied','changed','same content new revision'])
  test(`access ${status}, preflight=${preflight}, ${outcome} preserves the draft and original revision`,()=>{
    const state=new DesignerCoordinator(acceptPayload),designer={currentArtifact:structuredClone(opened),validationReport:{canSave:true,issues:[]},validate(){return this.validationReport;}};
    state.loaded({artifact:opened,etag:'"opened"',writable:true});designer.currentArtifact['schema:name']='Unsaved';
    const attempt=state.beginSave(designer);if(!preflight)attempt.write={createsIdentity:false,body:designer.currentArtifact};
    state.failed({status},attempt);state.finish(attempt);
    assert.equal(state.canCheckSave,false);assert.equal(state.canRecheckAccess,true);
    const check=state.beginCheck();designer.currentArtifact['schema:name']='Newer';
    const latest={data:{...opened},etag:outcome==='changed'||outcome==='same content new revision'?'"new"':'"opened"'};
    if(outcome==='changed')latest.data['schema:name']='Other author';
    assert.equal(state.checked(check,latest,outcome!=='denied'),outcome==='restored'?'unchanged':outcome==='denied'?'readonly':'changed');
    state.finishCheck(check);
    assert.equal(state.report(designer).canSave,outcome==='restored');assert.equal(state.etag,'"opened"');
    assert.equal(designer.currentArtifact['schema:name'],'Newer');assert.equal(state.canRecheckAccess,outcome!=='restored');
  });
