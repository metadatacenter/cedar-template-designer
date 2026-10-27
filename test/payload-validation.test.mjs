import {test} from 'node:test';
import assert from 'node:assert/strict';
import model from 'cedar-model-typescript-library';
import schema from 'cedar-model-typescript-library/schema.js';
import {DesignerCoordinator} from '../app/scripts/host-state.mjs';
import {saveArtifact, BackendError} from '../app/scripts/host-core.mjs';
import {accepted} from './helpers/validation.mjs';

const {CedarBuilders, CedarWriters} = model;
// The validator CED's validateArtifact carries; the host is given it rather than importing its own.
const validate = artifact => schema.SchemaArtifactValidator.validate(artifact);
function artifact() {
  return CedarWriters.json().getStrict().getTemplateWriter().getAsJsonNode(
    CedarBuilders.templateBuilder().withSchemaName('Study').withDescription('Schema definition').build());
}
const designer = value => ({currentArtifact: value, validationReport: {canSave: true, issues: []}, validate() {return this.validationReport;}});
function coordinator(stored = artifact(), projection = structuredClone(stored)) {
  const state = new DesignerCoordinator(validate);
  state.loaded({artifact: stored, projection, writable: true, etag: '"one"'});
  return {state, component: designer(structuredClone(projection))};
}

test('checks retained schema content, even when CED reports a clean projection', () => {
  const projection = artifact(), stored = structuredClone(projection);
  stored._ui.pages = [];
  const {state, component} = coordinator(stored, projection);
  assert.equal(component.validate().canSave, true);
  const report = state.report(component);
  assert.equal(report.canSave, false);
  assert.ok(report.server.some(issue => issue.location === '/_ui/pages'));
  assert.equal(state.beginSave(component), null);
  assert.deepEqual(state.project(component.currentArtifact)._ui.pages, []);
  // Feeding findings back into CED must keep the same obstruction, rather than alternate on/off.
  component.validationReport = {canSave: false, issues: report.server.map(issue => ({...issue, source: 'host'}))};
  assert.deepEqual(state.report(component).server, report.server);
});

test('recomputes a retained-payload verdict after a repair and after recovery', () => {
  const source = artifact(); source['@context']['@language'] = 'a b';
  const {state, component} = coordinator(source);
  assert.equal(state.report(component).canSave, false);
  component.currentArtifact['@context']['@language'] = 'en';
  assert.equal(state.report(component).canSave, true);
  const restored = new DesignerCoordinator(validate);
  restored.loaded({artifact: source, writable: true, etag: '"one"'});
  restored.restoreRecovery(state.captureRecovery());
  assert.equal(restored.report(component).canSave, true);
  assert.equal(restored.report(designer(source)).canSave, false);
});

test('a prepared save binds both the component snapshot and the merged body', () => {
  const {state, component} = coordinator();
  const attempt = state.beginSave(component);
  assert.ok(attempt);
  assert.equal(state.matches(attempt, component), true);
  state.stored._ui.pages = [];
  assert.equal(state.matches(attempt, component), false);
});

test('malformed or throwing local validators fail closed on repeated requests', () => {
  for (const verdict of [null, {}, {canSave: false, findings: []}, {canSave: true, findings: null}, {canSave: false, findings: [{code:'semanticNotChecked',path:'',message:'Unknown',verificationStatus:'notChecked'}]}]) {
    const state = new DesignerCoordinator(() => verdict);state.loaded({writable: true});
    const component = designer(artifact());
    for(let repeat=0;repeat<2;repeat++) assert.equal(state.beginSave(component), null);
  }
  const state = new DesignerCoordinator(() => {throw new Error('Unavailable');});state.loaded({writable: true});
  assert.equal(state.beginSave(designer(artifact())), null);
});

const base = 'https://resource.test';
const create = {base, route: {kind: 'template', collection: 'templates', id: null}, folderId: 'folder',
  identity: () => 'https://repo.test/templates/new', artifact: artifact()};

for (const operation of ['create', 'update', 'version', 'element', 'field']) test(`${operation}: validates the exact final body before recording or sending a write`, async () => {
  const calls = [], journal = [];
  const options = {...create, etag: '"one"', onWrite: write => journal.push(write), confirmVersion: async () => true};
  if(operation !== 'create') options.route = {kind: ['element','field'].includes(operation)?operation:'template', collection: operation === 'element'?'template-elements':operation === 'field'?'template-fields':'templates', id: 'https://repo.test/templates/item'};
  options.request = async (url, request) => {
    calls.push({url, ...request});
    if(url.includes('/check-update-template/'))return {data: {canBeUpdated: operation !== 'version'}};
    if(url.includes('/command/validate?')) {assert.equal(journal.length, 0); return accepted();}
    assert.equal(journal.length, 1);
    return {data: request.body};
  };
  await saveArtifact(options);
  const checked = calls.find(call => call.url.includes('/command/validate?')), written = calls.at(-1);
  assert.equal(checked.method, 'POST');
  assert.ok(checked.signal instanceof AbortSignal);
  assert.deepEqual(checked.body, written.body);
  assert.notEqual(checked.body, written.body);
  assert.deepEqual(journal[0].body, written.body);
  assert.equal(written.body['@id'], operation === 'create' ? 'https://repo.test/templates/new' : options.route.id);
});

for(const verdict of [null, {}, {canSave:true}, {canSave:true,errors:[],warnings:[{}]}, {canSave:false,errors:[],warnings:[]},
  {canSave:true,errors:[{message:'Refused',location:'/_ui/pages'}],warnings:[]}])
  test(`incomplete or contradictory backend verdict cannot write: ${JSON.stringify(verdict)}`, async () => {
    let writes=0, recorded=0;
    await assert.rejects(saveArtifact({...create, onWrite:()=>recorded++, request:async url=>{
      if(!url.includes('/command/validate?')) writes++;
      return {data:verdict};
    }}), BackendError);
    assert.equal(writes,0);assert.equal(recorded,0);
  });

test('unavailable preflight is a retryable read failure, never an uncertain creation', async () => {
  const state = new DesignerCoordinator(validate);state.loaded({writable:true});
  const component=designer(artifact()), attempt=state.beginSave(component);
  const error=new BackendError(503);
  await assert.rejects(saveArtifact({...create,artifact:attempt.artifact,onWrite:write=>attempt.write=write,
    request:async()=>{throw error;}}),failure=>failure===error);
  assert.equal(state.failed(error,attempt),false);state.finish(attempt);
  assert.equal(state.uncertainCreation,false);assert.equal(state.reloadRequired,false);
  assert.ok(state.beginSave(component));
});

test('a late positive verdict cannot authorize an edited snapshot', async () => {
  let current=true, writes=0, recorded=0;
  await assert.rejects(saveArtifact({...create,stillCurrent:()=>current,onWrite:()=>recorded++,request:async url=>{
    if(url.includes('/command/validate?')){current=false;return accepted();}writes++;return {data:{}};
  }}), /document changed/);
  assert.equal(writes,0);assert.equal(recorded,0);
});

test('unknown semantic verification remains advisory when the server allows storage', async () => {
  let written;
  await saveArtifact({...create,request:async(url,options)=>url.includes('/command/validate?')?
    {data:{canSave:true,isValid:false,errors:[],warnings:[{message:'Membership not checked'}]}}:(written=options.body,{data:options.body})});
  assert.ok(written);
});

test('a timed-out preflight aborts without recording or sending a write', async context => {
  context.mock.timers.enable({apis:['setTimeout']});
  let recorded=0, writes=0, signal;
  const saving=saveArtifact({...create,onWrite:()=>recorded++,request:(url,options)=>{
    if(!url.includes('/command/validate?')){writes++;return Promise.resolve({data:{}});}
    signal=options.signal;
    return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
  }});
  const refused=assert.rejects(saving,error=>error instanceof BackendError && error.status===504 && /Validation did not finish/.test(error.message));
  context.mock.timers.tick(30000);
  await refused;
  assert.equal(signal.aborted,true);assert.equal(recorded,0);assert.equal(writes,0);
});

test('server findings retire when retained content changes, even if the projection does not', () => {
  const {state,component}=coordinator();
  const attempt=state.beginSave(component);
  state.failed(new BackendError(400,{validationReport:{errors:[{location:'/schema:description',message:'Refused'}],warnings:[]}}),attempt);
  state.finish(attempt);
  assert.equal(state.report(component).server.length,1);
  state.stored['schema:description']='A repaired retained value';
  assert.equal(state.report(component).server.length,0);
  assert.equal(state.report(component).canSave,true);
});


test('the validation deadline also settles a transport that ignores cancellation and refuses its late verdict', async context => {
  context.mock.timers.enable({apis:['setTimeout']});
  let resolve, writes=0, recorded=0;
  const pending=new Promise(ready=>resolve=ready);
  const saving=saveArtifact({...create,onWrite:()=>recorded++,request:url=>{
    if(url.includes('/command/validate?'))return pending;
    writes++;return Promise.resolve({data:{}});
  }});
  const refused=assert.rejects(saving,error=>error.status===504);
  context.mock.timers.tick(30000);
  await refused;
  resolve(accepted());await Promise.resolve();await Promise.resolve();
  assert.equal(writes,0);assert.equal(recorded,0);
});

test('a coordinator given no validator never lets a payload be saved', () => {
  const state = new DesignerCoordinator();
  state.loaded({artifact: artifact(), writable: true, etag: '"one"'});
  const report = state.report(designer(artifact()));
  assert.equal(report.canSave, false);
  assert.equal(state.beginSave(designer(artifact())), null);
});
