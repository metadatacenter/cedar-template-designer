import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reusableSource, ReusableJournal, validationShape } from '../app/scripts/reusable-artifacts.mjs';
import { useDeploymentApi, BackendError } from '../app/scripts/host-core.mjs';
const base = 'https://resource.example';
useDeploymentApi(base);
const signal = () => new AbortController().signal;
const field = () => ({ '@id': 'https://example.org/inline', '@type': 'https://schema.metadatacenter.org/core/TemplateField',
  'schema:name': 'Field', 'schema:description': '', 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft',
  type: 'object', properties: { '@value': { type: 'string' } }, _ui: {inputType: 'textfield'},
  'pav:createdOn': null, 'pav:createdBy': null, 'pav:lastUpdatedOn': null, 'oslc:modifiedBy': null });
function harness({ fault, count = 0 } = {}) {
  const calls = [], stored = new Map(), memory = new Map();
  const journal = new ReusableJournal('test', { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) });
  const context = () => ({ route: {kind: 'template', id: 'parent'}, project: value => structuredClone(value), writable: true, etag: '"parent"' });
  const request = async (url, options = {}) => {
    calls.push({url, ...structuredClone({...options, signal: undefined})});
    if (url.includes('/folders/')) return {data: {currentUserPermissions: {capabilities: ['createInFolder']}}};
    if (url.includes('/check-update-template/')) return {data: {canBeUpdated: count === 0, numberOfInstances: count}};
    if (url.endsWith('/publish-artifact')) {
      const id = options.body['@id']; const entry = stored.get(id);
      entry.data['bibo:status'] = 'bibo:published'; entry.etag = '"2"';
      if (fault === 'publish') { fault = undefined; throw new BackendError(0); }
      return structuredClone(entry);
    }
    const id = options.body?.['@id'] || [...stored.keys()].find(id => url.includes(id.split('/').at(-1)));
    if (options.method === 'PUT') {
      assert.equal(stored.has(id), false, 'retry must not create or overwrite a second artifact');
      stored.set(id, {data: {...structuredClone(options.body), 'pav:createdOn': 'created'}, etag: '"1"'});
      if (fault === 'create') { fault = undefined; throw new BackendError(0); }
    }
    if (!stored.has(id)) throw new BackendError(404);
    return structuredClone(stored.get(id));
  };
  const options = {context, journal, folder: () => 'home', open: () => {}};
  return {calls, stored, journal, request, options, source: reusableSource(request, base, options)};
}
test('equivalence ignores only artifact metadata and presentation, retaining constraints and metadata-named properties', () => {
  const before = field(), after = structuredClone(before);
  after['@id'] = 'https://example.org/release'; after['schema:description'] = 'Help';
  assert.equal(validationShape(before), validationShape(after));
  after.properties['@value'].minLength = 2;
  assert.notEqual(validationShape(before), validationShape(after));
  const template = {'@type': 'https://schema.metadatacenter.org/core/Template', properties: {title: before}};
  assert.notEqual(validationShape(template), validationShape({...template, properties: {}}));
});
for (const count of [0, 3, undefined, -1, 0.5]) test(`real impact count ${count} never claims schema compatibility`, async () => {
  const h = harness();
  const request = async () => ({data: {canBeUpdated: true, numberOfInstances: count}});
  const source = reusableSource(request, base, h.options);
  const document = field(), replacement = field(); replacement.properties['@value'].minLength = 3;
  if (count === 0 || count === 3) assert.deepEqual(await source.compatibility(document, replacement, {document, replacement, signal: signal()}),
    count === 0 ? {compatible: null, invalidatedInstances: 0} : {compatible: null});
  else await assert.rejects(source.compatibility(document, replacement, {document, replacement, signal: signal()}));
});
for (const type of ['field', 'element']) for (const publish of [false, true]) for (const fault of [undefined, 'create', 'publish'])
test(`${type} ${publish ? 'publication' : 'draft'} survives ${fault || 'normal'} acknowledgement and a recreated host`, async () => {
  const h = harness({fault}); const input = field();
  if (type === 'element') input['@type'] = 'https://schema.metadatacenter.org/core/TemplateElement';
  const result = await h.source.save(input, {type, publish, signal: signal()});
  assert.equal(result['bibo:status'], publish ? 'bibo:published' : 'bibo:draft');
  assert.equal(result['pav:version'], '0.0.1'); assert.notEqual(result['@id'], input['@id']);
  const reopened = reusableSource(h.request, base, h.options);
  assert.deepEqual(await reopened.save(input, {type, publish, signal: signal()}), result);
  assert.equal(h.stored.size, 1);
  assert.equal(h.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(h.calls.filter(call => call.url.endsWith('/publish-artifact')).length, publish ? 1 : 0);
});
test('journal failure stops dispatch and cancellation before dispatch writes nothing', async () => {
  const h = harness(); h.options.journal = {read: () => ({}), write: () => { throw new Error('storage full'); }};
  await assert.rejects(reusableSource(h.request, base, h.options).save(field(), {type: 'field', publish: true, signal: signal()}), /storage full/);
  assert.equal(h.stored.size, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.source.save(field(), {type: 'field', publish: true, signal: controller.signal}));
  assert.equal(h.stored.size, 0);
});
test('version lookup forwards cancellation and unreadable origins offer no history', async () => {
  const h = harness(); const abort = signal();
  const source = reusableSource(async (url, options) => {
    assert.ok(url.endsWith('/versions')); assert.equal(options.signal, abort); throw new BackendError(403);
  }, base, h.options);
  assert.equal(await source.versions({type: 'field', id: 'source'}, {signal: abort}), null);
});

test('a reusable save submits the server-derived schema labels and retains generator attribution', async () => {
  const h = harness();
  const input = {...field(), title: 'Old field schema', description: 'Old field schema generated by CEDAR test 1'};
  const result = await h.source.save(input, {type: 'field', publish: false, signal: signal()});
  assert.equal(result.title, 'Field field schema');
  assert.equal(result.description, 'Field field schema generated by CEDAR test 1');
  assert.equal(result['schema:description'], '');
});
