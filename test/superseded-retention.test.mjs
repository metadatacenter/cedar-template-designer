import {test} from 'node:test';
import assert from 'node:assert/strict';
import library from 'cedar-model-typescript-library';
import {applyAuthorChanges, supersede} from '../app/scripts/author-changes.mjs';
import {DesignerCoordinator, supersededShapes} from '../app/scripts/host-state.mjs';

// Retaining what the author did not change is how the host avoids turning a save into a schema
// migration. It is also how a stored shape the designer cannot represent, and the server refuses,
// came back in every save: the designer's projection had already dropped or replaced it, the
// projection compared equal to itself, and the stored branch was kept. The host's suites gave it a
// designer whose projection was the stored artifact itself, so no test ever saw a projection differ
// from what was stored. These cases give it what the real designer reports, and judge every saved
// body by the model library's mirror of the server's field rules.

const {FieldValuePolicy, ValidationPolicy} = library;
const FIELD = 'https://schema.metadatacenter.org/core/TemplateField';
const literal = {'@type': {type: 'string', format: 'uri'}, '@value': {type: ['string', 'null']}};
const iri = {'@type': {type: 'string', format: 'uri'}, '@id': {type: 'string', format: 'uri'}, 'rdfs:label': {type: ['string', 'null']}};
const DOID = {acronym: 'DOID', name: 'Human Disease Ontology', uri: 'https://data.bioontology.org/ontologies/DOID', numTerms: 1};
const definition = (id, ui, constraints, properties = literal) =>
  ({'@id': `https://repo.example/template-fields/${id}`, '@type': FIELD, type: 'object', 'schema:name': id,
    _ui: ui, _valueConstraints: {requiredValue: false, ...constraints}, properties: structuredClone(properties)});

/** A stored template with one field carrying each superseded shape, and one valid legacy shape to retain. */
function stored() {
  return {'@id': 'https://repo.example/templates/t', '@type': 'https://schema.metadatacenter.org/core/Template',
    'schema:name': 'Stored', 'schema:description': '', _ui: {order: ['Count', 'Disease', 'Note', 'Legacy']},
    properties: {
      Count: definition('count', {inputType: 'numeric'}, {}),
      Disease: definition('disease', {inputType: 'textfield'},
        {ontologies: [DOID], defaultValue: 'Null', minLength: 5, maxLength: 20, regex: '^[A-Z]+$'}, iri),
      Note: definition('note', {inputType: 'textfield', order: []}, {}),
      Legacy: definition('legacy', {inputType: 'textfield'}, {recommendedValue: false}),
    }};
}
/** What the designer's projection of it holds, as its own suite pins, and the list it reports. */
function opened() {
  const result = stored();
  result.properties.Count._valueConstraints.numberType = 'xsd:decimal';
  for (const key of ['defaultValue', 'minLength', 'maxLength', 'regex']) delete result.properties.Disease._valueConstraints[key];
  delete result.properties.Note._ui.order;
  delete result.properties.Legacy._valueConstraints.recommendedValue;
  return result;
}
const SUPERSEDED = [
  {location: '/properties/Count/_valueConstraints/numberType', code: 'numberType', value: 'xsd:decimal'},
  {location: '/properties/Disease/_valueConstraints/defaultValue', code: 'termDefault'},
  ...['minLength', 'maxLength', 'regex'].map(key =>
    ({location: `/properties/Disease/_valueConstraints/${key}`, code: 'termTextConstraint'})),
  {location: '/properties/Note/_ui/order', code: 'fieldOrder'},
];

/** Every field definition of a body, through repeated children. */
function fields(node, path = '') {
  if (node?.items) return fields(node.items, `${path}/items`);
  if (node?.['@type'] === FIELD) return [[path, node]];
  return Object.entries(node?.properties ?? {}).filter(([, child]) => child && typeof child === 'object')
    .flatMap(([key, child]) => fields(child, `${path}/properties/${key}`));
}
/** What the server would refuse in a body's fields, as the model library mirrors it. */
function refusals(body) {
  return fields(body).flatMap(([path, field]) => [
    ...FieldValuePolicy.validateConfiguration(field, path), ...FieldValuePolicy.validateDefault(field, path),
  ].filter(finding => ValidationPolicy.blocksSave(finding, 'template')).map(finding => `${finding.path}: ${finding.message}`)
    .concat(Object.hasOwn(field._ui ?? {}, 'order') ? [`${path}/_ui/order: a field has no order`] : []));
}
const at = (body, ...keys) => keys.reduce((node, key) => node?.[key], body);

const term = {termUri: 'http://purl.obolibrary.org/obo/DOID_4', 'rdfs:label': 'disease'};
const EDITS = {
  'nothing': () => {},
  'the template description': edited => { edited['schema:description'] = 'Edited'; },
  'each superseded field': edited => {
    for (const key of ['Count', 'Disease', 'Note']) edited.properties[key]['schema:description'] = 'Edited';
  },
  'a renamed key': edited => {
    edited.properties.Total = edited.properties.Count; delete edited.properties.Count;
    edited._ui.order[0] = 'Total';
  },
  'a field made repeatable': edited => {
    edited.properties.Count = {type: 'array', minItems: 0, items: edited.properties.Count};
  },
  'a datatype the author chose': edited => { edited.properties.Count._valueConstraints.numberType = 'xsd:int'; },
  'a term default the author chose': edited => { edited.properties.Disease._valueConstraints.defaultValue = term; },
};
const count = body => body.properties.Count ?? body.properties.Total;

for (const [name, edit] of Object.entries(EDITS)) {
  test(`after ${name}, the saved body carries no superseded shape and keeps every other retained one`, () => {
    const edited = opened();
    edit(edited);
    const body = applyAuthorChanges(supersede(stored(), SUPERSEDED), opened(), edited);
    assert.deepEqual(refusals(body), []);
    const numeric = count(body).items ?? count(body);
    assert.equal(numeric._valueConstraints.numberType, name === 'a datatype the author chose' ? 'xsd:int' : 'xsd:decimal');
    assert.deepEqual(body.properties.Disease._valueConstraints.defaultValue,
      name === 'a term default the author chose' ? term : undefined);
    // A valid legacy shape the designer omits is still retained, as before.
    assert.equal(body.properties.Legacy._valueConstraints.recommendedValue, false);
  });
}

test('without the list, the merge alone retains every superseded shape, which the server refuses', () => {
  const body = applyAuthorChanges(stored(), opened(), opened());
  assert.deepEqual(body, stored());
  assert.notDeepEqual(refusals(body), []);
  assert.ok(Object.hasOwn(body.properties.Note._ui, 'order'));
});

test('a chosen term default is refused under retained length limits unless they are superseded', () => {
  const edited = opened();
  EDITS['a term default the author chose'](edited);
  assert.notDeepEqual(refusals(applyAuthorChanges(stored(), opened(), edited)).filter(issue => issue.includes('Disease')), []);
  assert.deepEqual(refusals(applyAuthorChanges(supersede(stored(), SUPERSEDED), opened(), edited)), []);
});

test('supersede changes only the locations it is given, and only where they still describe the artifact', () => {
  const before = stored();
  const after = supersede(before, [
    ...SUPERSEDED,
    {location: '/properties/Missing/_valueConstraints/numberType', code: 'numberType', value: 'xsd:decimal'},
    {location: '/properties/__proto__/polluted', code: 'fieldOrder', value: true},
    {location: '/_ui/order/0', code: 'fieldOrder'},
  ]);
  assert.deepEqual(before, stored());
  assert.equal(after.properties.Missing, undefined);
  assert.equal(Object.hasOwn(after.properties, '__proto__'), false);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(after._ui, before._ui);
  const expected = opened();
  expected.properties.Legacy._valueConstraints.recommendedValue = false;
  assert.deepEqual(after, expected);
});

test('the list comes only from a well-formed report', () => {
  assert.deepEqual(supersededShapes(undefined), []);
  assert.deepEqual(supersededShapes({superseded: 'none'}), []);
  assert.deepEqual(supersededShapes({superseded: [{location: 'relative', code: 'fieldOrder'}, {code: 'fieldOrder'},
    ...SUPERSEDED]}), SUPERSEDED);
});

function coordinator(superseded) {
  const state = new DesignerCoordinator();
  state.loaded({artifact: stored(), projection: opened(), superseded, etag: '"opened"', writable: true});
  const designer = {currentArtifact: opened(), isDirty: false, validationReport: {canSave: true, issues: []},
    validate() { return this.validationReport; }};
  return {state, designer};
}

test('Save sends the body with the superseded shapes put as the projection holds them', () => {
  const {state, designer} = coordinator(SUPERSEDED);
  const attempt = state.beginSave(designer);
  assert.deepEqual(refusals(attempt.artifact), []);
  assert.equal(attempt.artifact.properties.Legacy._valueConstraints.recommendedValue, false);
});

test('a designer that reports no list is retained from exactly as before', () => {
  const {state, designer} = coordinator(undefined);
  assert.deepEqual(state.beginSave(designer).artifact, stored());
});

test('the list survives a recovery journal, is refused when malformed, and ends with a confirmed save', () => {
  const {state, designer} = coordinator(SUPERSEDED);
  const journal = state.captureRecovery();
  assert.deepEqual(journal.superseded, SUPERSEDED);

  const restored = new DesignerCoordinator();
  restored.loaded({artifact: stored(), projection: opened(), etag: '"opened"', writable: true});
  restored.restoreRecovery(journal);
  assert.deepEqual(restored.captureRecovery().superseded, SUPERSEDED);
  assert.throws(() => new DesignerCoordinator().restoreRecovery({...journal, superseded: [{location: 3}]}));
  const older = structuredClone(journal); delete older.superseded;
  const fromOlder = new DesignerCoordinator(); fromOlder.restoreRecovery(older);
  assert.deepEqual(fromOlder.captureRecovery().superseded, []);

  const attempt = state.beginSave(designer);
  state.committed(attempt, '"saved"');
  assert.deepEqual(state.captureRecovery().superseded, []);
  assert.deepEqual(refusals(state.stored), []);
});
