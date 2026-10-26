import {saveArtifact} from './helpers/validation.mjs';
// The compact address of a folder or artifact, across the deployment's base, the form an identifier
// arrives in and the collection. The server expands a short selector onto its own base only, so the
// host may shorten an identity on that base and nothing else, and shortening must round-trip.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { identityIn, mintIdentity, resourceIri, resourcePathId, resourceSelector, useDeploymentApi, useDeploymentDomain } from '../app/scripts/resource-address.mjs';


const UUID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const COLLECTIONS = ['folders', 'templates', 'template-elements', 'template-fields', 'template-instances'];
const BASES = {
  'a development deployment': 'https://repo.metadatacenter.orgx/',
  'the production deployment': 'https://repo.metadatacenter.org/',
  'a deployment not yet known': null,
};
const own = (b) => b ?? 'https://repo.metadatacenter.orgx/';
const FORMS = {
  'its own identity': (c, b) => ({ id: `${own(b)}${c}/${UUID}`, mine: !!b }),
  'its own identity with an upper-case uuid': (c, b) => ({ id: `${own(b)}${c}/${UUID.toUpperCase()}`, mine: !!b }),
  "another CEDAR host's identity": (c, b) => ({ id: `https://repo.metadatacenter.${b?.includes('.org/') ? 'orgx' : 'org'}/${c}/${UUID}`, mine: false }),
  'its own host over http': (c, b) => ({ id: `${own(b).replace('https:', 'http:')}${c}/${UUID}`, mine: false }),
  'a malformed uuid': (c, b) => ({ id: `${own(b)}${c}/${UUID.slice(1)}`, mine: false }),
  'a name rather than a uuid': (c, b) => ({ id: `${own(b)}${c}/home`, mine: false }),
  'a trailing slash': (c, b) => ({ id: `${own(b)}${c}/${UUID}/`, mine: false }),
  'a user rather than a resource': (_c, b) => ({ id: `${own(b)}users/${UUID}`, mine: false }),
};

afterEach(() => useDeploymentDomain(null));

for (const [baseName, base] of Object.entries(BASES))
  for (const [formName, form] of Object.entries(FORMS))
    for (const collection of COLLECTIONS)
      test(`on ${baseName}, ${formName} in ${collection}`, () => {
        useDeploymentDomain(base ? new URL(base).hostname.replace(/^repo\./, '') : null);
        const { id, mine } = form(collection, base);
        const uuid = id.slice(id.lastIndexOf('/') + 1);
        const selector = resourceSelector(id);
        assert.equal(selector, mine ? `${collection}/${uuid}` : id);
        assert.equal(resourcePathId(id), mine ? uuid : id);
        assert.equal(resourceIri(selector, `${own(base)}folders/${UUID}`), id);
      });

test('takes the base from the deployment\'s domain', () => {
  useDeploymentDomain('metadatacenter.org');
  assert.equal(resourceSelector(`https://repo.metadatacenter.org/templates/${UUID}`), `templates/${UUID}`);
  assert.equal(resourceSelector(`https://repo.metadatacenter.orgx/templates/${UUID}`), `https://repo.metadatacenter.orgx/templates/${UUID}`);
});

for (const [api, base] of [
  ['https://resource.metadatacenter.org', 'https://repo.metadatacenter.org/'],
  ['https://resource.metadatacenter.org/', 'https://repo.metadatacenter.org/'],
  ['https://resource.staging.metadatacenter.org', 'https://repo.staging.metadatacenter.org/'],
  ['https://resource.metadatacenter.orgx', 'https://repo.metadatacenter.orgx/'],
])
  test(`takes the base from the resource API ${api}`, () => {
    useDeploymentApi(api);
    assert.equal(resourceSelector(`${base}templates/${UUID}`), `templates/${UUID}`);
    assert.equal(resourcePathId(`${base}folders/${UUID}`), UUID);
  });

test('takes no base from a resource API on any other host', () => {
  for (const api of ['https://api.example', 'https://user.metadatacenter.org', 'https://metadatacenter.org', 'not a URL', '', null, undefined]) {
    useDeploymentApi(api);
    assert.equal(resourceSelector(`https://repo.metadatacenter.org/templates/${UUID}`), `https://repo.metadatacenter.org/templates/${UUID}`);
  }
});

// An account created when CEDAR ran on metadatacenter.net keeps its home folder and its older
// resources on that base. The server would expand a short selector for one onto .org instead.
test("keeps an earlier domain's identities absolute while shortening the deployment's own", () => {
  useDeploymentApi('https://resource.metadatacenter.org');
  for (const collection of COLLECTIONS) {
    const legacy = `https://repo.metadatacenter.net/${collection}/${UUID}`;
    assert.equal(resourceSelector(legacy), legacy);
    assert.equal(resourcePathId(legacy), legacy);
    assert.equal(resourceSelector(`https://repo.metadatacenter.org/${collection}/${UUID}`), `${collection}/${UUID}`);
  }
});

for (const [label, folderId, expected] of [
  ['a folder on an earlier domain\'s base', `https://repo.metadatacenter.net/folders/${UUID}`, `https://repo.metadatacenter.net/folders/${UUID}`],
  ['a folder the deployment minted', `https://repo.metadatacenter.org/folders/${UUID}`, `folders/${UUID}`],
  ['a folder Workspace handed over in short form', `folders/${UUID}`, `folders/${UUID}`],
])
  test(`creates in ${label} under the folder the server will resolve`, async () => {
    useDeploymentApi('https://resource.metadatacenter.org');
    const calls = [];
    const request = async (url, options) => { calls.push({ url, options }); return { data: { '@id': options.body['@id'] } }; };
    await saveArtifact({ request, base: 'https://resource.metadatacenter.org', route: { kind: 'template', collection: 'templates', id: null },
      artifact: { 'schema:name': 'Named' }, folderId });
    assert.equal(calls.length, 1);
    // The new template's identity is minted on the deployment's own base, whatever the folder's base.
    const minted = calls[0].options.body['@id'];
    assert.match(minted, new RegExp(`^https://repo\\.metadatacenter\\.org/templates/${V4}$`));
    assert.equal(calls[0].options.method, 'PUT');
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, `/templates/${minted.slice(minted.lastIndexOf('/') + 1)}`);
    assert.equal(url.searchParams.get('folder_id'), expected);
  });

// The server accepts a caller's identity only on its own base, as a full IRI in the artifact's collection.
for (const collection of COLLECTIONS)
  test(`mints a random identity in ${collection} on the deployment's base`, () => {
    useDeploymentApi('https://resource.metadatacenter.orgx');
    const [first, second] = [mintIdentity(collection), mintIdentity(collection)];
    assert.match(first, new RegExp(`^https://repo\\.metadatacenter\\.orgx/${collection}/${V4}$`));
    assert.notEqual(first, second);
    assert.equal(resourceSelector(first), `${collection}/${first.slice(first.lastIndexOf('/') + 1)}`);
    assert.equal(identityIn(first, collection), true);
    for (const other of COLLECTIONS.filter(name => name !== collection)) assert.equal(identityIn(first, other), false);
  });

test('mints nothing while the base is unknown or for an unknown collection', () => {
  for (const api of ['https://api.example', null]) {
    useDeploymentApi(api);
    assert.equal(mintIdentity('templates'), null);
  }
  useDeploymentApi('https://resource.metadatacenter.org');
  for (const collection of ['users', 'template', '', 'templates/x']) assert.equal(mintIdentity(collection), null);
});

test('recognises only a full identity of the minted form on the deployment\'s base', () => {
  useDeploymentApi('https://resource.metadatacenter.org');
  const own = `https://repo.metadatacenter.org/templates/${UUID}`;
  assert.equal(identityIn(own, 'templates'), true);
  for (const id of [`templates/${UUID}`, UUID, `https://repo.metadatacenter.net/templates/${UUID}`, `http://repo.metadatacenter.org/templates/${UUID}`,
    `${own}/`, `https://repo.metadatacenter.org/templates/home`, null, undefined, 7]) assert.equal(identityIn(id, 'templates'), false, String(id));
  // Before the base is known, any host is accepted, since only the deployment's own journal names one.
  useDeploymentDomain(null);
  assert.equal(identityIn(`https://repo.metadatacenter.net/templates/${UUID}`, 'templates'), true);
});

test('creates by POST, as before identities were sent, while the base is unknown', async () => {
  useDeploymentApi('https://api.example');
  const calls = [];
  await saveArtifact({ request: async (url, options) => { calls.push({ url, options }); return { data: { '@id': 'minted-by-server' } }; },
    base: 'https://api.example', route: { kind: 'field', collection: 'template-fields', id: null }, artifact: { 'schema:name': 'Named' }, folderId: 'home' });
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].url, 'https://api.example/template-fields?folder_id=home');
  assert.equal(calls[0].options.body['@id'], null);
});
