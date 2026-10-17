import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackendError, routeFor, workspaceReturn, canEdit, createBackend, saveArtifact, storageArtifact, childSource, useDeploymentApi } from '../app/scripts/host-core.mjs';
const base = 'https://resource.example';
// A create or new version mints its identity on the deployment's base.
useDeploymentApi(base);
const minted = collection => new RegExp(`^https://repo\\.example/${collection}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`);
const route = { kind: 'template', collection: 'templates', id: 'https://repo.example/templates/a' };
const artifact = { '@id': route.id, 'schema:name': 'Changed', properties: {} };
function harness(responses) {
  const calls = [];
  const request = async (url, options = {}) => { calls.push({ url, ...options }); const next = responses.shift(); if (next instanceof Error) throw next; return next; };
  return { calls, options: { request, base, route, artifact, etag: '"v1"', folderId: 'folder', confirmVersion: async () => true } };
}
for (const kind of ['template', 'element', 'field']) {
  test(`${kind} saves reject missing or blank names before any request`, async () => {
    for (const id of [null, route.id]) {
      for (const name of [undefined, null, '', ' \t\n']) {
        const h = harness([]);
        await assert.rejects(saveArtifact({ ...h.options,
          route: { ...route, kind, id }, artifact: { ...artifact, 'schema:name': name },
        }), { message: `Enter ${kind === 'element' ? 'an' : 'a'} ${kind} name before saving.` });
        assert.equal(h.calls.length, 0);
      }
    }
  });
}
test('route identifiers remain opaque through encoded and historical raw URLs', () => {
  assert.equal(routeFor('/templates/edit/' + encodeURIComponent(route.id)).id, route.id);
  assert.equal(routeFor('/templates/edit/https:/repo.example/templates/a').id, route.id);
  assert.equal(routeFor('/elements/create').kind, 'element');
  assert.throws(() => routeFor('/templates/edit'));
  assert.throws(() => routeFor('/templates/create/extra'));
});
test('return URLs reject foreign origins, credentials and script schemes', () => {
  for (const url of ['https://evil.example/dashboard', 'https://user@workspace.example/dashboard', '//workspace.example/dashboard', 'javascript:alert(1)', null]) {
    assert.equal(workspaceReturn('https://workspace.example', url, 'x'), 'https://workspace.example/dashboard?folderId=x');
  }
  assert.equal(workspaceReturn('https://workspace.example', 'https://workspace.example/dashboard?q=a#result'), 'https://workspace.example/dashboard?q=a#result');
});
test('a return without a folder identifier names no folder, so Workspace opens the home folder', () => {
  // A designer opened without folderId, for example from OpenView's login link, is asked for no folder by its return.
  for (const missing of [null, undefined, '']) {
    assert.equal(workspaceReturn('https://workspace.example', null, missing), 'https://workspace.example/dashboard');
    assert.doesNotMatch(workspaceReturn('https://workspace.example', 'https://evil.example/', missing), /undefined|null/);
  }
});
test('permissions fail closed and published artifacts stay locked', () => {
  assert.equal(canEdit({}, {}), false);
  const report = { currentUserPermissions: { capabilities: ['updateResource'] } };
  assert.equal(canEdit(report, {}), true);
  assert.equal(canEdit(report, { 'bibo:status': 'bibo:published' }), false);
});
test('template save checks impact and sends the original representation ETag', async () => {
  const h = harness([{ data: { canBeUpdated: true } }, { data: artifact }]);
  await saveArtifact(h.options);
  assert.equal(h.calls[0].url, base + '/command/check-update-template/' + encodeURIComponent(route.id));
  assert.equal(h.calls[1].method, 'PUT');
  assert.equal(h.calls[1].etag, '"v1"');
  assert.deepEqual(h.calls[1].body, artifact);
});
test('declining versioning makes no write and keeps the edit', async () => {
  const h = harness([{ data: { canBeUpdated: false, numberOfInstances: 2 } }]);
  assert.equal(await saveArtifact({ ...h.options, confirmVersion: async () => false }), null);
  assert.equal(h.calls.length, 1);
});
test('accepted versioning sends the original validator and the new draft\'s identity without refreshing it or copying instances', async () => {
  const h = harness([{ data: { canBeUpdated: false } }, { data: artifact }]);
  await saveArtifact(h.options);
  const url = new URL(h.calls[1].url);
  assert.equal(url.origin + url.pathname, base + '/command/publish-create-draft-template/' + encodeURIComponent(route.id));
  assert.deepEqual([...url.searchParams.keys()], ['draft_id']);
  assert.match(url.searchParams.get('draft_id'), minted('templates'));
  assert.equal(h.calls[1].method, 'POST');
  assert.equal(h.calls[1].etag, '"v1"');
  assert.equal(h.calls[1].body['@id'], route.id);
  assert.equal(h.calls.length, 2);
});
test('failed impact requests never fall through to writing', async () => {
  const h = harness([new Error('Offline')]);
  await assert.rejects(saveArtifact(h.options), /Offline/);
  assert.equal(h.calls.length, 1);
});
test('element update is conditional; creation puts a minted identity in the selected folder', async () => {
  const h = harness([{ data: artifact }, { data: artifact }]);
  await saveArtifact({ ...h.options, route: { kind: 'element', collection: 'template-elements', id: 'element-id' } });
  assert.equal(h.calls[0].method, 'PUT');
  assert.equal(h.calls[0].etag, '"v1"');
  await saveArtifact({ ...h.options, route: { kind: 'element', collection: 'template-elements', id: null } });
  const id = h.calls[1].body['@id'];
  assert.match(id, minted('template-elements'));
  assert.equal(h.calls[1].method, 'PUT');
  assert.equal(h.calls[1].url, `${base}/template-elements/${id.split('/').pop()}?folder_id=folder`);
  // A create states no validator, since there is nothing it could match.
  assert.equal(h.calls[1].etag, undefined);
});
test('missing validators and destination folders block writes', async () => {
  const h = harness([]);
  await assert.rejects(saveArtifact({ ...h.options, etag: null }), /validator/);
  await assert.rejects(saveArtifact({ ...h.options, route: { ...route, id: null }, folderId: null }), /folder/);
  assert.equal(h.calls.length, 0);
});
test('backend refreshes an expired session once and retains conditional headers', async () => {
  const calls = [], refreshes = [];
  const auth = { getToken: () => 'test-token', refreshToken: (validity, success) => { refreshes.push(validity); success(true); } };
  const request = createBackend(auth, 'session', async (url, opts) => {
    calls.push(opts);
    return new Response(JSON.stringify(calls.length === 1 ? {} : artifact), { status: calls.length === 1 ? 401 : 200, headers: { ETag: '"v2"' } });
  });
  const saved = await request(base, { method: 'PUT', body: artifact, etag: '"v1"' });
  assert.deepEqual(refreshes, [30, -1]);
  assert.equal(calls[1].headers['If-Match'], '"v1"');
  assert.equal(saved.etag, '"v2"');
});
test('a request that gets no answer fails in the host\'s words, and a cancellation stays one', async () => {
  const auth = { getToken: () => 'test-token', refreshToken: (_validity, success) => success(true) };
  const unreachable = createBackend(auth, 'session', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(unreachable(base), error => error instanceof BackendError && error.status === 0 &&
    error.message === 'The server could not be reached. Check your connection and try again.');
  const cancelled = createBackend(auth, 'session', async () => { throw new DOMException('Aborted', 'AbortError'); });
  await assert.rejects(cancelled(base), error => error.name === 'AbortError');
});
test('child search forwards cancellation and permission-filtered pagination', async () => {
  const calls = [];
  const source = childSource(async (url, options) => { calls.push({ url, options }); return { data: { resources: [{ '@id': 'a', 'schema:name': 'A', resourceType: 'element' }], totalCount: 2 } }; }, base);
  const signal = new AbortController().signal;
  const result = await source.search('heart', { signal });
  assert.equal(result.nextCursor, '1');
  assert.equal(result.results[0].type, 'element');
  assert.equal(calls[0].options.signal, signal);
  assert.equal(new URL(calls[0].url).searchParams.get('resource_types'), 'field,element');
});

test('storage metadata fills only typed artifacts, preserves provenance and does not mutate CED', () => {
  const field = { '@type': 'https://schema.metadatacenter.org/core/TemplateField', 'schema:description': null, 'pav:createdBy': 'author' };
  const source = { '@id': 'minted', '@type': 'https://schema.metadatacenter.org/core/Template', properties: { children: { type: 'array', items: field }, '@id': { type: 'string' } } };
  const stored = storageArtifact(source, true);
  assert.equal(stored['@id'], null);
  assert.equal(stored.properties.children.items['schema:description'], '');
  assert.equal(stored.properties.children.items['pav:createdBy'], 'author');
  assert.equal(stored.properties.children.items['pav:createdOn'], null);
  assert.deepEqual(stored.properties['@id'], { type: 'string' });
  assert.equal(source['@id'], 'minted');
  assert.equal(field['schema:description'], null);
});

test('standalone field creation and updates use the field collection and original ETag', async () => {
  const h = harness([{ data: artifact }, { data: artifact }]);
  const route = routeFor('/fields/create');
  await saveArtifact({ ...h.options, route });
  assert.equal(h.calls[0].url, `${base}/template-fields/${h.calls[0].body['@id'].split('/').pop()}?folder_id=folder`);
  assert.match(h.calls[0].body['@id'], minted('template-fields'));
  assert.equal(h.calls[0].method, 'PUT');
  await saveArtifact({ ...h.options, route: routeFor('/fields/edit/' + encodeURIComponent('https://example.org/fields/one')) });
  assert.equal(h.calls[1].method, 'PUT');
  assert.equal(h.calls[1].etag, '"v1"');
  assert.equal(h.calls.length, 2, 'field saves do not invoke template version commands');
});
test('standalone stale field update propagates the conflict without retrying', async () => {
  const conflict = new BackendError(412);
  const h = harness([conflict]);
  await assert.rejects(saveArtifact({ ...h.options, route: { kind: 'field', collection: 'template-fields', id: 'field-id' } }), error => error === conflict);
  assert.equal(h.calls.length, 1);
});
