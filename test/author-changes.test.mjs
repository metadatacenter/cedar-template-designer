import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyAuthorChanges} from '../app/scripts/author-changes.mjs';
import {DesignerCoordinator} from '../app/scripts/host-state.mjs';

const legacy = () => ({'@id': 'template', 'schema:name': 'Old', 'schema:description': 'Original',
  _annotations: {note: {'@value': 'Retain'}},
  properties: {Field: {'@id': 'field', 'schema:description': 'Field description',
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
function setup() {
  const stored = legacy(), projection = project(stored), state = new DesignerCoordinator();
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
test('JSON property names cannot mutate the result prototype', () => {
  const result = applyAuthorChanges({}, {}, JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal({}.polluted, undefined);
});
