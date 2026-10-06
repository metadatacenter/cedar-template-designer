import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesignerCoordinator, saveArtifact, BackendError, childSource, createBackend, canCreate, canEdit, waitForDesigner } from '../app/scripts/host-core.mjs';

function documentAt(depth) {
  let artifact = {'schema:name': 'Child', properties: {Link: {'schema:name': 'Link', _valueConstraints: {defaultValue: 'bad iri'}}}};
  for (let i = 0; i < depth; i++) artifact = {'schema:name': `Level ${i}`, properties: {Child: {type:'array',items:artifact}}};
  return artifact;
}
function setup(depth = 1, writable = true) {
  const state = new DesignerCoordinator();
  const designer = { currentArtifact: documentAt(depth), validationReport: {canSave:true,issues:[]}, validate() {return this.validationReport;} };
  state.loaded({artifact:designer.currentArtifact,etag:'"one"',writable});
  return {state,designer};
}
for (const setting of ['name','default','occurrences']) for (const depth of [0,1,3,8]) for (const shown of [false,true]) {
  test(`${setting} depth ${depth}: invalid settings block save before and after disclosure=${shown}`, () => {
    const {state,designer} = setup(depth);
    designer.validationReport = {canSave:false,issues:[{setting,shown,severity:'error',path:Array(depth).fill(1)}]};
    assert.equal(state.beginSave(designer),null); assert.equal(state.saving,false);
    designer.validationReport = {canSave:true,issues:[]};
    const attempt = state.beginSave(designer); assert.ok(attempt); assert.equal(state.beginSave(designer),null);
    state.failed(new BackendError(500),attempt); state.finish(attempt);
    assert.equal(state.report(designer).canSave,true);
  });
}
for (const depth of [1,3,8]) for (const status of [400,403,404,412,428,500]) for (const edit of ['before','after','none']) {
  test(`server report depth ${depth}, status ${status}, edit ${edit} belongs to its submitted snapshot`, () => {
    const {state,designer} = setup(depth), original = structuredClone(designer.currentArtifact);
    const attempt = state.beginSave(designer);
    if (edit === 'before') designer.currentArtifact['schema:name'] = 'Newer';
    state.failed(new BackendError(status,{objects:{validationReport:{errors:[{location:'/properties/'+'Child/items/properties/'.repeat(depth)+'Link',message:'Invalid default'}]}}}),attempt);
    state.finish(attempt);
    if (edit === 'after') designer.currentArtifact['schema:name'] = 'Corrected';
    const report = state.report(designer);
    assert.equal(report.server.length,edit==='none'?1:0);
    assert.equal(state.reloadRequired,[403,404,412,428].includes(status));
    assert.equal(report.canSave,edit!=='none'&&!state.reloadRequired);
    assert.deepEqual(state.stored,original);
    state.loaded({artifact:designer.currentArtifact,etag:'"two"',writable:true});
    assert.equal(state.report(designer).canSave,true); assert.equal(state.etag,'"two"');
  });
}
for (const transition of ['replacement','dispose','failed-load']) for (const outcome of ['success','failure']) {
  test(`old ${outcome} cannot own state after ${transition}`, () => {
    const {state,designer} = setup(); const attempt = state.beginSave(designer);
    if (transition==='replacement') state.loaded({artifact:{'schema:name':'New'},etag:'"new"',writable:false});
    else if (transition==='dispose') state.dispose(); else state.failLoad();
    if (outcome === 'failure') state.failed(new BackendError(412,{validationReport:{errors:[{message:'Obsolete'}]}}),attempt);
    else state.committed(attempt,'"obsolete"');
    state.finish(attempt);
    assert.equal(attempt.current(),false); assert.equal(state.reloadRequired,false); assert.equal(state.report(designer).server.length,0);
    assert.equal(state.beginSave(designer),null);
    assert.notEqual(state.etag,'"obsolete"');
  });
}
for (const report of [null, {}, {canSave:true}, {canSave:true,issues:null}, {canSave:true,issues:[null]}, {canSave:true,issues:[{shown:false}]}, {valid:false,canSave:true,issues:[]}]) {
  test(`incomplete or contradictory CED report cannot allow save: ${JSON.stringify(report)}`, () => {
    const {state,designer}=setup(); designer.validationReport=report;
    assert.equal(state.beginSave(designer),null);
    designer.validationReport={canSave:true,issues:[]}; assert.ok(state.beginSave(designer));
  });
}
for (const capabilities of [undefined,null,[],{},'createInFolder updateResource',['readResource'],['createInFolder'],['updateResource']]) {
  test(`permissions stay explicit: ${JSON.stringify(capabilities)}`, () => {
    const report={currentUserPermissions:{capabilities}};
    assert.equal(canCreate(report),Array.isArray(capabilities)&&capabilities.includes('createInFolder'));
    assert.equal(canEdit(report,{}),Array.isArray(capabilities)&&capabilities.includes('updateResource'));
    assert.equal(canEdit(report,{'bibo:status':'bibo:published'}),false);
  });
}
for (const impact of [null,{},[],{canBeUpdated:'false'},{canBeUpdated:1},{canBeUpdated:false,numberOfInstances:-1},{canBeUpdated:false,oldVersion:{}}]) {
  test(`malformed impact cannot authorize versioning: ${JSON.stringify(impact)}`,async()=>{
    const calls=[]; let confirmations=0;
    await assert.rejects(saveArtifact({request:async(url,options)=>{calls.push({url,options});return{data:impact};},base:'https://resource.test',route:{kind:'template',collection:'templates',id:'template'},artifact:{'schema:name':'Named'},etag:'"one"',confirmVersion:async()=>{confirmations++;return true;}}),/valid update assessment/);
    assert.equal(calls.length,1); assert.equal(confirmations,0);
  });
}
for (const when of ['impact','confirmation']) for (const change of ['document','validation','closed']) {
  test(`change to ${change} during ${when} prevents the eventual write`,async()=>{
    const {state,designer}=setup(); const attempt=state.beginSave(designer); const calls=[];
    const mutate=()=>{if(change==='document')designer.currentArtifact['schema:name']='New';else if(change==='validation')designer.validationReport={canSave:false,issues:[{shown:true}]};else state.dispose();};
    await assert.rejects(saveArtifact({request:async(url,options)=>{calls.push({url,options});if(when==='impact')mutate();return{data:{canBeUpdated:false}};},base:'https://resource.test',route:{kind:'template',collection:'templates',id:'template'},artifact:attempt.artifact,etag:'"one"',confirmVersion:async()=>{mutate();return true;},stillCurrent:()=>state.matches(attempt,designer)}),/document changed/);
    assert.equal(calls.length,1);
  });
}
for (const bad of [null,{}, {resources:null,totalCount:0},{resources:[null],totalCount:1},{resources:[{'@id':'a',resourceType:'template'}],totalCount:1},{resources:[{'@id':'a',resourceType:'field'},{'@id':'a',resourceType:'field'}],totalCount:2},{resources:[],totalCount:-1}]) {
  test(`invalid reusable-child search is recoverable: ${JSON.stringify(bad)}`,async()=>{
    let data=bad;const source=childSource(async()=>({data}),'https://resource.test');
    await assert.rejects(source.search('term',{}),/incomplete child list/);
    data={resources:[{'@id':'valid',resourceType:'field'}],totalCount:1}; assert.equal((await source.search('term',{})).results[0].id,'valid');
    data={resources:[],totalCount:0}; assert.deepEqual((await source.search('term',{cursor:'50'})).results,[]);
  });
}
test('a successful response cannot cause the transport to repeat a write',async()=>{
  let calls=0;const request=createBackend({refreshToken:(_n,ok)=>ok(),getToken:()=>''},'session',async()=>{calls++;return new Response(JSON.stringify({'@id':'saved',suggestedAction:'refreshToken'}));});
  await request('https://resource.test',{method:'POST',body:{}});assert.equal(calls,1);
});

for (const etag of ['"next"',null]) for (const newIdentity of [false,true]) for (const change of ['value','draft','unreadable']) {
  test(`acknowledged write retains ${change}, validator=${etag}, new identity=${newIdentity}`,()=>{
    const {state,designer}=setup(4);const attempt=state.beginSave(designer);
    if(change==='value')designer.currentArtifact.properties.Child.items['schema:name']='Newer';
    if(change==='draft')designer.validationReport={canSave:false,issues:[{source:'draft',setting:'default'}]};
    if(change==='unreadable')Object.defineProperty(designer,'currentArtifact',{configurable:true,get(){throw new Error('Unserializable draft');}});
    assert.equal(state.matches(attempt,designer),false);
    state.committed(attempt,etag,newIdentity);state.finish(attempt);
    assert.equal(state.dirty(designer),true);assert.equal(state.etag,etag);
    assert.equal(state.reloadRequired,newIdentity||!etag);
    assert.deepEqual(state.stored,attempt.artifact);
    Object.defineProperty(designer,'currentArtifact',{configurable:true,writable:true,value:structuredClone(attempt.artifact)});
    designer.validationReport={canSave:true,issues:[]};
    assert.equal(state.dirty(designer),false);
    assert.equal(state.report(designer).canSave,!newIdentity&&Boolean(etag));
  });
}

test('a replacement clears an uncertain creation and its dirty baseline',()=>{
  const {state,designer}=setup();const attempt=state.beginSave(designer);
  state.committed(attempt,null,true);state.uncertainCreation=true;
  state.loaded({artifact:designer.currentArtifact,etag:'"reloaded"',writable:true});
  assert.equal(state.uncertainCreation,false);assert.equal(state.reloadRequired,false);
  designer.isDirty=false;assert.equal(state.dirty(designer),false);
  assert.ok(state.beginSave(designer));
});

for(const kind of ['template','element','field'])test(`${kind} write uses the loaded identity and does not alter the draft`,async()=>{
  const calls=[];const artifact={'@id':'old','schema:name':'Named'};
  await saveArtifact({request:async(url,options)=>{calls.push({url,options});return{data:{canBeUpdated:true}};},base:'https://resource.test',route:{kind,collection:'artifacts',id:'current'},artifact,etag:'"one"'});
  assert.equal(calls.at(-1).options.body['@id'],'current');
  assert.equal(calls.at(-1).options.etag,'"one"');assert.equal(artifact['@id'],'old');
});

for(const outcome of ['registered','failed','never'])test(`component readiness settles when registration is ${outcome}`,async()=>{
  let register,reject;
  const pending=new Promise((ok,fail)=>{register=ok;reject=fail;});
  const ready=waitForDesigner({whenDefined:name=>{assert.equal(name,'cedar-embeddable-designer');return pending;}},20);
  if(outcome==='registered'){register();await ready;}
  else if(outcome==='failed'){reject(new Error('Registration failed'));await assert.rejects(ready,/Registration failed/);}
  else {await assert.rejects(ready,/out of date/);register();}
});
