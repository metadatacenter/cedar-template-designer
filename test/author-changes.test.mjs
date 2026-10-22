import {acceptPayload} from './helpers/validation.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyAuthorChanges} from '../app/scripts/author-changes.mjs';
import {DesignerCoordinator} from '../app/scripts/host-state.mjs';

const legacy = () => ({'@id': 'template', 'schema:name': 'Old', 'schema:description': 'Original',
  _annotations: {note: {'@value': 'Retain'}},
  properties: {Field: {'@id': 'field', _ui: {inputType: 'textfield'}, 'schema:description': 'Field description',
    _valueConstraints: {requiredValue: false, recommendedValue: false},
    properties: {'@type': {oneOf: [{type: 'string'}, {type: 'array', items: {type: 'string'}}]}}}},
  _ui: {order: ['Field']}});
const project = source => {
  const result = structuredClone(source);
  delete result.properties.Field._valueConstraints.recommendedValue;
  result.properties.Field.properties['@type'] = {type: 'string'};
  result.properties.Field.properties['@language'] = {type: ['string', 'null']};
  result.properties._annotations = {type: 'object'};
  return result;
};

test('pulling a new identity replaces the complete definition without inheriting hidden old schema', () => {
  const stored = legacy(), opened = project(stored), edited = structuredClone(opened);
  stored.properties.Field.oldOnlyConstraint = {pattern: 'old'};
  edited.properties.Field = {'@id': 'new-published-release', _ui: {inputType: 'textfield'},
    properties: {'@value': {type: 'string'}}, 'bibo:status': 'bibo:published'};
  const result = applyAuthorChanges(stored, opened, edited);
  assert.deepEqual(result.properties.Field, edited.properties.Field);
  assert.deepEqual(result._ui, stored._ui);
  assert.deepEqual(result._annotations, stored._annotations);
});
function setup() {
  const stored = legacy(), projection = project(stored), state = new DesignerCoordinator(acceptPayload);
  const designer = {currentArtifact: structuredClone(projection), isDirty: true,
    validationReport: {canSave: true, issues: []}, validate() {return this.validationReport;}};
  state.loaded({artifact: stored, projection, etag: '"opened"', writable: true});
  return {stored, projection, state, designer};
}
test('description edits retain the older field shape and annotations without mutating inputs', () => {
  const {stored, projection, state, designer} = setup();
  designer.currentArtifact['schema:description'] = 'Edited';
  const attempt = state.beginSave(designer);
  assert.deepEqual(attempt.artifact, {...stored, 'schema:description': 'Edited'});
  assert.deepEqual(stored, legacy());
  assert.deepEqual(projection, project(legacy()));
  assert.equal(state.matches(attempt, designer), true);
  state.committed(attempt, '"saved"'); state.finish(attempt);
  assert.equal(state.dirty(designer), false);
  assert.equal(state.etag, '"saved"');
  designer.currentArtifact.properties.Field['schema:description'] = 'Edited field';
  const second = state.beginSave(designer);
  const expected = {...stored, 'schema:description': 'Edited'};
  expected.properties.Field['schema:description'] = 'Edited field';
  assert.deepEqual(second.artifact, expected);
});
test('acknowledgement preserves newer edits and the next submission applies them to the saved source', () => {
  const {stored, state, designer} = setup();
  designer.currentArtifact['schema:description'] = 'Submitted';
  const attempt = state.beginSave(designer);
  designer.currentArtifact['schema:description'] = 'Newer';
  assert.equal(state.matches(attempt, designer), false);
  state.committed(attempt, '"saved"'); state.finish(attempt);
  assert.equal(state.dirty(designer), true);
  assert.deepEqual(state.beginSave(designer).artifact, {...stored, 'schema:description': 'Newer'});
});
test('deletion and explicit constraint changes reach storage without reviving removed values', () => {
  const stored = legacy(), opened = project(stored), edited = structuredClone(opened);
  edited.properties.Field._valueConstraints.requiredValue = true;
  assert.deepEqual(applyAuthorChanges(stored, opened, edited).properties.Field._valueConstraints,
    {requiredValue: true, recommendedValue: false});
  delete edited.properties.Field;
  edited._ui.order = [];
  const result = applyAuthorChanges(stored, opened, edited);
  assert.deepEqual(result.properties, {});
  assert.deepEqual(result._ui.order, []);
  assert.deepEqual(result._annotations, stored._annotations);
});
test('added children and changed arrays use the authored values while exact reverts retain the source', () => {
  const stored = legacy(), opened = project(stored), edited = structuredClone(opened);
  edited.properties.New = {'@id': 'new', type: 'object'};
  edited._ui.order = ['New', 'Field'];
  const result = applyAuthorChanges(stored, opened, edited);
  assert.deepEqual(result.properties.Field, stored.properties.Field);
  assert.deepEqual(result.properties.New, edited.properties.New);
  assert.deepEqual(result._ui.order, edited._ui.order);
  assert.deepEqual(applyAuthorChanges(stored, opened, structuredClone(opened)), stored);
});
test('a new artifact has no imported representation to preserve', () => {
  const {state, designer} = setup();
  state.loaded({writable: true});
  assert.deepEqual(state.beginSave(designer).artifact, designer.currentArtifact);
});
test('renaming a child key preserves its older definition while applying simultaneous edits', () => {
  const {stored, projection, state, designer} = setup();
  designer.currentArtifact.properties.Renamed = designer.currentArtifact.properties.Field;
  delete designer.currentArtifact.properties.Field;
  designer.currentArtifact.properties.Renamed['schema:description'] = 'Authored during rename';
  designer.currentArtifact._ui.order = ['Renamed'];
  const expected = structuredClone(stored);
  expected.properties.Renamed = expected.properties.Field;
  delete expected.properties.Field;
  expected.properties.Renamed['schema:description'] = 'Authored during rename';
  expected._ui.order = ['Renamed'];
  const attempt = state.beginSave(designer);
  assert.deepEqual(attempt.artifact, expected);
  state.committed(attempt, '"renamed"'); state.finish(attempt);
  designer.currentArtifact.properties.Renamed['schema:description'] = 'Next edit';
  expected.properties.Renamed['schema:description'] = 'Next edit';
  assert.deepEqual(state.beginSave(designer).artifact, expected);
  assert.deepEqual(projection, project(stored));
});
test('renamed repeated definitions retain the old items shape', () => {
  const stored = legacy(), opened = project(stored);
  stored.properties.Field = {type: 'array', minItems: 0, items: stored.properties.Field};
  opened.properties.Field = {type: 'array', minItems: 0, items: opened.properties.Field};
  const edited = {...opened, properties: {Renamed: structuredClone(opened.properties.Field)}};
  assert.deepEqual(applyAuthorChanges(stored, opened, edited).properties.Renamed, stored.properties.Field);
});
test('swapped keys follow definitions rather than inheriting the other field details', () => {
  const stored = legacy();
  stored.properties.Other = {...structuredClone(stored.properties.Field), '@id': 'other', _annotations: {note: 'Other'}};
  const opened = project(stored), edited = structuredClone(opened);
  [edited.properties.Field, edited.properties.Other] = [edited.properties.Other, edited.properties.Field];
  const result = applyAuthorChanges(stored, opened, edited);
  assert.deepEqual(result.properties.Other, stored.properties.Field);
  assert.deepEqual(result.properties.Field, stored.properties.Other);
});
test('distinct property IRIs disambiguate renamed uses of the same library definition', () => {
  const stored = legacy();
  stored.properties.Other = {...structuredClone(stored.properties.Field), _annotations: {note: 'Other'}};
  stored.properties['@context'] = {properties: {Field: {enum: ['https://example.org/field']}, Other: {enum: ['https://example.org/other']}}};
  const opened = project(stored), edited = structuredClone(opened);
  edited.properties.Renamed = edited.properties.Field;
  delete edited.properties.Field;
  edited.properties['@context'].properties.Renamed = edited.properties['@context'].properties.Field;
  delete edited.properties['@context'].properties.Field;
  const result = applyAuthorChanges(stored, opened, edited);
  assert.deepEqual(result.properties.Renamed, stored.properties.Field);
  assert.deepEqual(result.properties.Other, stored.properties.Other);
});
test('adding a duplicate identity does not copy hidden content from an existing child', () => {
  const stored = legacy(), opened = project(stored), edited = structuredClone(opened);
  edited.properties.Copy = structuredClone(edited.properties.Field);
  const result = applyAuthorChanges(stored, opened, edited);
  assert.deepEqual(result.properties.Field, stored.properties.Field);
  assert.deepEqual(result.properties.Copy, edited.properties.Copy);
});
test('JSON property names cannot mutate the result prototype', () => {
  const result = applyAuthorChanges({}, {}, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal({}.polluted, undefined);
});
for(const rename of [false,true])test(`changing repeat cardinality retains the older definition${rename?' while renaming it':''}`,()=>{
  const stored=legacy(),opened=project(stored),edited=structuredClone(opened),key=rename?'Renamed':'Field';
  const definition=edited.properties.Field;
  definition['schema:description']='Authored while wrapping';
  if(rename)delete edited.properties.Field;
  edited.properties[key]={type:'array',minItems:2,maxItems:5,items:definition};
  const wrapped=applyAuthorChanges(stored,opened,edited);
  assert.deepEqual(wrapped.properties[key],{type:'array',minItems:2,maxItems:5,items:{...stored.properties.Field,'schema:description':'Authored while wrapping'}});
  const next=structuredClone(edited);next.properties[key]=next.properties[key].items;
  next.properties[key]._valueConstraints.requiredValue=true;
  const unwrapped=applyAuthorChanges(wrapped,edited,next);
  assert.deepEqual(unwrapped.properties[key],{...stored.properties.Field,'schema:description':'Authored while wrapping',_valueConstraints:{requiredValue:true,recommendedValue:false}});
});
test('a replacement definition does not inherit the previous scalar or repeated definition',()=>{
  const stored=legacy(),opened=project(stored),edited=structuredClone(opened);
  edited.properties.Field={type:'array',minItems:0,items:{...edited.properties.Field,'@id':'replacement'}};
  assert.deepEqual(applyAuthorChanges(stored,opened,edited).properties.Field,edited.properties.Field);
  const repeated=structuredClone(opened);repeated.properties.Field={type:'array',items:repeated.properties.Field};
  const replacement=structuredClone(opened);replacement.properties.Field['@id']='replacement';
  assert.deepEqual(applyAuthorChanges(repeated,repeated,replacement).properties.Field,replacement.properties.Field);
});

for (const repeated of [false, true]) test(`an assessed release keeps its wire schema through placement and recovery (${repeated})`, () => {
  const {stored, projection, state, designer} = setup();
  const release = {...structuredClone(stored.properties.Field), '@id': 'released', 'bibo:status': 'bibo:published'};
  release.newOnly = {retained: true};
  const normalized = {...structuredClone(projection.properties.Field), '@id': 'released', 'bibo:status': 'bibo:published'};
  normalized.newOnly = {retained: true};
  designer.currentArtifact.properties.Field = repeated ? {type: 'array', minItems: 2, items: normalized} : normalized;
  state.rememberReplacement(release, designer.currentArtifact);
  const expected = repeated ? {type: 'array', minItems: 2, items: release} : release;
  assert.deepEqual(state.project(designer.currentArtifact).properties.Field, expected);
  const recovery = JSON.parse(JSON.stringify(state.captureRecovery()));
  const restored = new DesignerCoordinator(acceptPayload);
  restored.loaded({artifact: stored, projection, etag: '"opened"', writable: true});
  restored.restoreRecovery(recovery);
  assert.deepEqual(restored.project(designer.currentArtifact).properties.Field, expected);
  normalized._valueConstraints.requiredValue = true;
  normalized._ui.hidden = true;
  const changed = restored.project(designer.currentArtifact).properties.Field;
  const child = changed.items ?? changed;
  assert.deepEqual(child.properties, release.properties);
  assert.equal(child._valueConstraints.requiredValue, true);
  assert.equal(child._valueConstraints.recommendedValue, false);
  assert.equal(child._ui.hidden, true);
  assert.equal(stored.properties.Field['@id'], 'field');
  assert.throws(() => restored.rememberReplacement({...release, newOnly: {changed: true}}, designer.currentArtifact));
  assert.deepEqual(restored.project(designer.currentArtifact).properties.Field, changed);
});
