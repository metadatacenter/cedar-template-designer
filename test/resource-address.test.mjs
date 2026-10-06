// The compact address of a folder or artifact, across the deployment's base, the form an identifier
// arrives in and the collection. The server expands a short selector onto its own base only, so the
// host may shorten an identity on that base and nothing else, and shortening must round-trip.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resourceIri, resourcePathId, resourceSelector, useDeploymentBase, useDeploymentDomain } from '../app/scripts/resource-address.mjs';

const UUID = '0f1e2d3c-4b5a-4968-8776-655443322110';
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

afterEach(() => useDeploymentBase(null));

for (const [baseName, base] of Object.entries(BASES))
  for (const [formName, form] of Object.entries(FORMS))
    for (const collection of COLLECTIONS)
      test(`on ${baseName}, ${formName} in ${collection}`, () => {
        useDeploymentBase(base ? `${base}folders/${UUID}` : null);
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
