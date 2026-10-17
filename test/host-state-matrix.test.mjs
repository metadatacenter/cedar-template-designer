import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesignerCoordinator, saveArtifact, BackendError, childSource, createBackend, canCreate, canEdit, waitForDesigner, mintIdentity, useDeploymentApi } from '../app/scripts/host-core.mjs';

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
test('forwarded host warnings remain advisory and host errors are not counted twice', () => {
  const {state, designer} = setup();
  const attempt = state.beginSave(designer);
  state.failed(new BackendError(400, {objects: {validationReport: {errors: [{location: '/schema:name', message: 'Rejected'}]}}}), attempt);
  state.finish(attempt);
  designer.validationReport = {valid: false, canSave: false, issues: [{source: 'host', severity: 'error', message: 'Rejected'}]};
  assert.equal(state.report(designer).issues.length, 1);
  designer.currentArtifact['schema:name'] = 'Corrected';
  designer.validationReport = {valid: true, canSave: true, issues: [{source: 'host', severity: 'warning', message: 'Advisory'}]};
  assert.ok(state.beginSave(designer));
});
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
// A 403 refusing a new version to anyone but the template's owner is a refusal of the save alone, as a
// 400 is. Every other 403 refuses access, so the page must be reloaded before another save.
for (const depth of [1,3,8]) for (const [status, errorKey] of [[400],[403],[403,'versioningOnlyByOwner'],[404],[412],[428],[500]]) for (const edit of ['before','after','none']) {
  test(`server report depth ${depth}, status ${status}${errorKey ? ` ${errorKey}` : ''}, edit ${edit} belongs to its submitted snapshot`, () => {
    const {state,designer} = setup(depth), original = structuredClone(designer.currentArtifact);
    const attempt = state.beginSave(designer);
    if (edit === 'before') designer.currentArtifact['schema:name'] = 'Newer';
    state.failed(new BackendError(status,{errorKey,objects:{validationReport:{errors:[{location:'/properties/'+'Child/items/properties/'.repeat(depth)+'Link',message:'Invalid default'}]}}}),attempt);
    state.finish(attempt);
    if (edit === 'after') designer.currentArtifact['schema:name'] = 'Corrected';
    const report = state.report(designer);
    assert.equal(report.server.length,edit==='none'?1:0);
    assert.equal(state.reloadRequired,[403,404,412,428].includes(status)&&errorKey!=='versioningOnlyByOwner');
    assert.equal(state.canRecheckAccess,status===403&&errorKey!=='versioningOnlyByOwner');
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

// A create or new version whose answer was lost is settled by reading the identity it was sent under.
// The source and draft identities sit on the base https://repo.test/, minted as the host mints them.
const SOURCE = 'https://repo.test/templates/0f1e2d3c-4b5a-4968-8776-655443322110';
const OPENED = {'@id': SOURCE, 'schema:name': 'Opened', 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft', 'pav:createdOn': 'then', properties: {}};
function lost(operation, status = 0, submitted = body => body) {
  useDeploymentApi('https://resource.test');
  const state = new DesignerCoordinator();
  const designer = {currentArtifact: {...structuredClone(OPENED), 'schema:name': 'Submitted'}, validationReport: {canSave: true, issues: []}, validate() {return this.validationReport;}};
  if (operation === 'create') { delete designer.currentArtifact['@id']; state.loaded({writable: true}); }
  else state.loaded({artifact: OPENED, etag: '"opened"', writable: true});
  const attempt = state.beginSave(designer);
  const id = state.identity(() => mintIdentity('templates'));
  const body = submitted({...structuredClone(attempt.artifact), '@id': operation === 'create' ? id : SOURCE});
  attempt.write = {createsIdentity: true, operation, identity: id, body};
  state.failed(new BackendError(status), attempt); state.finish(attempt);
  assert.equal(state.uncertainCreation, true); assert.equal(state.canCheckSave, true);
  return {state, designer, attempt, id, body};
}
const settle = (state, reads) => { const check = state.beginCheck(); const result = state.settleCreation(check, reads); state.finishCheck(check); return result; };
// A definition as the server stores it, with provenance stamped and a draft's own lifecycle fields.
const stored = (body, fields) => ({...structuredClone(body), 'pav:lastUpdatedOn': 'now', 'oslc:modifiedBy': 'author', ...fields});

for (const later of [false, true]) for (const etag of ['"1"', null])
  test(`a lost create that committed is adopted, later edits=${later}, validator=${etag}`, () => {
    const {state, designer, id, body} = lost('create');
    if (later) designer.currentArtifact = {...designer.currentArtifact, 'schema:name': 'Later'};
    const created = {data: stored(body, {'pav:createdOn': 'now', 'pav:createdBy': 'author'}), etag};
    assert.equal(settle(state, {created, writable: true}), 'committed');
    assert.equal(state.uncertainCreation, false); assert.equal(state.canCheckSave, false);
    assert.deepEqual(state.stored, created.data); assert.equal(state.etag, etag);
    assert.equal(state.reloadRequired, !etag);
    // Later edits stay unsaved changes against what was stored, and the next save updates it.
    assert.equal(state.dirty(designer), later);
    const next = state.beginSave(designer);
    assert.equal(next === null, !etag);
    if (next) {
      assert.equal(next.artifact['@id'], id); assert.equal(next.artifact['pav:createdOn'], 'now');
      assert.equal(next.artifact['schema:name'], later ? 'Later' : 'Submitted');
    }
    // A later create mints a new identity, since this one is settled.
    assert.notEqual(state.identity(() => 'https://repo.test/templates/another'), id);
  });

test('a lost create that is absent permits Save again under the same identity', () => {
  const {state, designer, id} = lost('create');
  assert.equal(settle(state, {created: null, writable: true}), 'absent');
  assert.equal(state.uncertainCreation, false); assert.equal(state.reloadRequired, false); assert.equal(state.canCheckSave, false);
  assert.equal(state.stored, undefined);
  assert.ok(state.beginSave(designer));
  assert.equal(state.identity(() => assert.fail('a second identity was minted')), id);
  assert.equal(JSON.parse(JSON.stringify(state.captureRecovery())).identity, id);
});

for (const [label, reads, result] of [
  ['another identity', ({body}) => ({created: {data: stored(body, {'@id': SOURCE}), etag: '"1"'}, writable: true}), 'unresolved'],
  ['no document', () => ({created: {data: null, etag: '"1"'}, writable: true}), 'unresolved'],
  ['no permission to update it', ({body}) => ({created: {data: stored(body, {}), etag: '"1"'}, writable: false}), 'readonly'],
  ['no permission to create here', () => ({created: null, writable: false}), 'readonly'],
]) test(`a lost create read as ${label} stays blocked and can be checked again`, () => {
  const fixture = lost('create'), {state, designer, id} = fixture;
  assert.equal(settle(state, reads(fixture)), result);
  assert.equal(state.uncertainCreation, true); assert.equal(state.reloadRequired, true); assert.equal(state.canCheckSave, true);
  assert.equal(state.beginSave(designer), null);
  assert.equal(state.creation.id, id);
});

// A create refused as occupied stored nothing itself, so what its identity holds is an earlier attempt's,
// whose content may differ from this one's. Its identity is adopted, but its content is not taken for the
// baseline of the designer's: the artifact must be reloaded before another save.
for (const status of [412, 428]) test(`a create refused as occupied (${status}) adopts its identity and needs a reload before another save`, () => {
  const {state, designer, body} = lost('create', status);
  // The refusal survives a reload in the journal.
  const journal = JSON.parse(JSON.stringify(state.captureRecovery()));
  assert.equal(journal.creation.occupied, true);
  const restored = new DesignerCoordinator(); restored.loaded({writable: true}); restored.restoreRecovery(journal);
  for (const coordinator of [state, restored]) {
    const created = {data: stored(body, {'schema:name': 'Stored by an earlier attempt'}), etag: '"1"'};
    assert.equal(settle(coordinator, {created, writable: true}), 'adopted');
    assert.equal(coordinator.uncertainCreation, false); assert.equal(coordinator.canCheckSave, false);
    assert.deepEqual(coordinator.stored, created.data); assert.equal(coordinator.etag, '"1"');
    assert.equal(coordinator.reloadRequired, true);
    assert.equal(coordinator.beginSave(designer), null);
    // The designer's content stays unsaved, and its journal restores without an access recheck that could re-enable Save.
    assert.equal(coordinator.dirty(designer), true);
    const again = new DesignerCoordinator(); again.loaded({artifact: created.data, etag: '"1"', writable: true});
    again.restoreRecovery(JSON.parse(JSON.stringify(coordinator.captureRecovery())));
    assert.equal(again.reloadRequired, true); assert.equal(again.canRecheckAccess, false); assert.equal(again.canCheckSave, false);
    assert.equal(again.beginSave(designer), null);
  }
});

test('only a create refused as occupied is journaled as occupied', () => {
  assert.equal(lost('create').state.captureRecovery().creation.occupied, undefined);
  const occupied = JSON.parse(JSON.stringify(lost('create', 428).state.captureRecovery()));
  const version = JSON.parse(JSON.stringify(lost('version').state.captureRecovery()));
  assert.equal(version.creation.occupied, undefined);
  // Each journal restores as written, so a refusal below is the altered field's.
  for (const journal of [occupied, version]) new DesignerCoordinator().restoreRecovery(journal);
  for (const value of [false, 'yes', null]) assert.throws(() => new DesignerCoordinator().restoreRecovery({...occupied, creation: {...occupied.creation, occupied: value}}));
  assert.throws(() => new DesignerCoordinator().restoreRecovery({...version, creation: {...version.creation, occupied: true}}));
});

const draftOf = (body, id, extra = {}) => stored(body, {'@id': id, 'pav:version': '0.0.2', 'bibo:status': 'bibo:draft',
  'pav:previousVersion': SOURCE, 'pav:createdOn': 'now', 'pav:createdBy': 'author', ...extra});
for (const later of [false, true]) test(`a lost new version that committed adopts its draft, later edits=${later}`, () => {
  // The server drops a DOI the definition carried. The draft has none of its own.
  const doi = {'https://datacite.com/doi': {'@value': 'doi:10.1/x'}};
  const {state, designer, id, body} = lost('version', 0, body => ({...body, _annotations: doi}));
  if (later) designer.currentArtifact = {...designer.currentArtifact, 'schema:name': 'Later'};
  const created = {data: draftOf(body, id), etag: '"draft"'};
  delete created.data._annotations;
  assert.equal(settle(state, {created, writable: true}), 'committed');
  assert.equal(state.stored['@id'], id); assert.equal(state.etag, '"draft"'); assert.equal(state.reloadRequired, false);
  assert.equal(state.dirty(designer), later);
  assert.equal(state.beginSave(designer)?.artifact['pav:previousVersion'], SOURCE);
});

for (const [label, change] of [
  ['another predecessor', {'pav:previousVersion': 'https://repo.test/templates/other'}],
  ['another definition', {'schema:name': 'Someone else'}],
]) test(`a lost new version whose draft holds ${label} stays unresolved`, () => {
  const {state, id, body} = lost('version');
  assert.equal(settle(state, {created: {data: draftOf(body, id, change), etag: '"draft"'}, writable: true}), 'unresolved');
  assert.equal(state.uncertainCreation, true); assert.equal(state.canCheckSave, true);
});

for (const revision of ['"opened"', '"restored"']) test(`a lost new version absent while its source is unchanged permits Save again (${revision})`, () => {
  const {state, designer, id} = lost('version');
  // A source restored after a failed step reads under a new revision with the same authored content.
  const source = {data: {...structuredClone(OPENED), 'pav:lastUpdatedOn': 'later'}, etag: revision};
  assert.equal(settle(state, {created: null, source, writable: true}), 'absent');
  assert.equal(state.reloadRequired, false); assert.equal(state.etag, revision);
  assert.ok(state.beginSave(designer));
  assert.equal(state.identity(() => assert.fail('a second identity was minted')), id);
});

for (const [label, source] of [
  ['published', {data: {...OPENED, 'bibo:status': 'bibo:published'}, etag: '"2"'}],
  ['changed', {data: {...OPENED, 'schema:name': 'Edited elsewhere'}, etag: '"2"'}],
  ['another template', {data: {...OPENED, '@id': 'https://repo.test/templates/other'}, etag: '"2"'}],
  ['without a validator', {data: OPENED, etag: null}],
]) test(`a lost new version absent while its source is ${label} stays unresolved`, () => {
  const {state, designer} = lost('version');
  assert.equal(settle(state, {created: null, source, writable: true}), 'unresolved');
  assert.equal(state.etag, '"opened"'); assert.equal(state.beginSave(designer), null); assert.equal(state.canCheckSave, true);
});

test('an outcome read after the page was replaced changes nothing', () => {
  const {state, body} = lost('create');
  const check = state.beginCheck();
  state.loaded({writable: true});
  assert.equal(state.settleCreation(check, {created: {data: stored(body, {}), etag: '"1"'}, writable: true}), 'obsolete');
  assert.equal(state.etag, undefined);
});

// The server assigns provenance to every child it writes, a creation record to a new one and a fresh
// modification stamp to a changed one, and gives an identifier to a child sent with a temporary one.
// None of that is a difference in what was submitted; any other difference in a child is.
const FIELD = 'https://repo.test/template-fields/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const field = (name, extra = {}) => ({'@id': FIELD, '@type': 'https://schema.metadatacenter.org/core/TemplateField',
  'schema:name': name, 'pav:createdOn': 'then', 'pav:createdBy': 'creator', 'pav:lastUpdatedOn': 'then', 'oslc:modifiedBy': 'creator', ...extra});
const WITH_CHILD = {...OPENED, properties: {Keep: field('Keep')}};
function lostWithChildren(submitted) {
  useDeploymentApi('https://resource.test');
  const state = new DesignerCoordinator();
  const designer = {currentArtifact: submitted(structuredClone(WITH_CHILD)), validationReport: {canSave: true, issues: []}, validate() {return this.validationReport;}};
  state.loaded({artifact: WITH_CHILD, etag: '"opened"', writable: true});
  const attempt = state.beginSave(designer);
  const id = state.identity(() => mintIdentity('templates'));
  const body = {...structuredClone(attempt.artifact), '@id': SOURCE};
  attempt.write = {createsIdentity: true, operation: 'version', identity: id, body};
  state.failed(new BackendError(0), attempt); state.finish(attempt);
  return {state, designer, id, body};
}
const changedAndAdded = body => ({...body, properties: {Keep: field('Keep', {'schema:description': 'Changed'}),
  Added: {...field('Added'), '@id': 'tmp-1760650000000-added', 'pav:createdOn': undefined}}});
const asWritten = (body, id) => {
  const data = draftOf(body, id);
  data.properties.Keep = {...data.properties.Keep, 'pav:lastUpdatedOn': 'now', 'oslc:modifiedBy': 'author'};
  data.properties.Added = {...data.properties.Added, '@id': 'https://repo.test/template-fields/9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a',
    'pav:createdOn': 'now', 'pav:createdBy': 'author', 'pav:lastUpdatedOn': 'now', 'oslc:modifiedBy': 'author'};
  return data;
};

test('a lost new version whose children the server stamped and identified is committed', () => {
  const {state, id, body} = lostWithChildren(changedAndAdded);
  assert.equal(settle(state, {created: {data: asWritten(body, id), etag: '"draft"'}, writable: true}), 'committed');
  assert.equal(state.stored.properties.Added['@id'].startsWith('https://repo.test/template-fields/'), true);
});

for (const [label, alter] of [
  ['a child holding other content', data => { data.properties.Keep['schema:description'] = 'Someone else'; }],
  ['a child under another identity', data => { data.properties.Keep['@id'] = 'https://repo.test/template-fields/other'; }],
  ['a missing child', data => { delete data.properties.Added; }],
]) test(`a lost new version whose draft holds ${label} stays unresolved`, () => {
  const {state, id, body} = lostWithChildren(changedAndAdded);
  const data = asWritten(body, id); alter(data);
  assert.equal(settle(state, {created: {data, etag: '"draft"'}, writable: true}), 'unresolved');
  assert.equal(state.uncertainCreation, true);
});

test('a lost new version absent after the server restored its source with fresh child stamps permits Save again', () => {
  const {state, designer} = lostWithChildren(changedAndAdded);
  const restored = structuredClone(WITH_CHILD);
  restored.properties.Keep = {...restored.properties.Keep, 'pav:lastUpdatedOn': 'restored', 'oslc:modifiedBy': 'author'};
  assert.equal(settle(state, {created: null, source: {data: restored, etag: '"restored"'}, writable: true}), 'absent');
  assert.equal(state.etag, '"restored"');
  assert.ok(state.beginSave(designer));
});

test('a lost new version absent while a child of its source changed stays unresolved', () => {
  const {state} = lostWithChildren(changedAndAdded);
  const changed = structuredClone(WITH_CHILD);
  changed.properties.Keep['schema:description'] = 'Edited elsewhere';
  assert.equal(settle(state, {created: null, source: {data: changed, etag: '"2"'}, writable: true}), 'unresolved');
  assert.equal(state.etag, '"opened"');
});
