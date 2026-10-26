import {acceptPayload} from './helpers/validation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseJson, canonicalJson, JsonSourcePolicy} from '../app/scripts/json-policy.mjs';
import {createBackend} from '../app/scripts/host-core.mjs';
import {applyAuthorChanges} from '../app/scripts/author-changes.mjs';
import {authoredKey, updateOutcome} from '../app/scripts/save-recovery.mjs';
import {DesignerCoordinator} from '../app/scripts/host-state.mjs';
import {DesignerDraftStore, draftScope} from '../app/scripts/host-draft.mjs';
const source = '{"@id":"item","N":9007199254740993,"D":0.10000000000000001}';
test('HTTP responses and subsequent writes retain exact numeric tokens', async () => {
  const calls = [];
  const request = createBackend({refreshToken: (_time, ok) => ok(), getToken: () => 'test'}, 'session',
    async (_url, options) => { calls.push(options); return new Response(source); });
  const {data} = await request('https://resource.example/item');
  await request('https://resource.example/item', {method: 'PUT', body: data});
  assert.equal(calls[1].body, source);
});
test('merge, recovery and comparison preserve numeric atoms without treating them as properties', () => {
  const data = parseJson(source), state = new DesignerCoordinator(acceptPayload);
  state.loaded({artifact: data, etag: '"1"', writable: true});
  const scope = draftScope('api', 'user', {collection: 'templates', id: 'item'}, '');
  const memory = new Map();
  const store = new DesignerDraftStore(scope, {getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v)});
  const component = {captureDraft: () => ({format: 'cedar-designer-draft', version: 1, state: '{}'})};
  store.write(store.capture(component, state));
  assert.equal(JsonSourcePolicy.stringify(store.read().coordinator.stored), source);
  assert.equal(JsonSourcePolicy.stringify(applyAuthorChanges(data, data, {...data, name: 'mine'})), source.slice(0,-1) + ',"name":"mine"}');
  assert.equal(authoredKey(data), authoredKey({...data, 'pav:lastUpdatedOn': 'now'}));
  assert.notEqual(canonicalJson(data), canonicalJson(JSON.parse(source)));
  const pending = {opened: data, submitted: data, etag: '"1"'};
  assert.equal(updateOutcome(pending, {data: JsonSourcePolicy.clone(data), etag: '"2"'}), 'saved');
  assert.equal(updateOutcome(pending, {data: JSON.parse(source), etag: '"2"'}), 'changed');
});
test('generic JSON parsing requires exactly one value and preserves decoded key identity', () => {
  for (const value of [[], null, 'text', true, 2]) assert.deepEqual(parseJson(JSON.stringify(value)), value);
  for (const value of ['1,"extra":2', '{"a":1,"\\u0061":2}', '{} {}', '[1,]']) assert.throws(() => parseJson(value));
  assert.notEqual(canonicalJson({'é': 1}), canonicalJson({'é': 1}));
});
