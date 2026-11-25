import {acceptPayload, saveArtifact} from './helpers/validation.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DesignerCoordinator, BackendError, useDeploymentApi} from '../app/scripts/host-core.mjs';
import {creationOutcome} from '../app/scripts/save-recovery.mjs';

// A create or a new version mints its identity on the base https://repo.test/.
useDeploymentApi('https://resource.test');
const V4 = /^https:\/\/repo\.test\/templates\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALIDATION = {objects: {validationReport: {errors: [{location: '/properties/Link', message: 'Invalid default IRI'}]}}};

// Run the real save orchestration: an assessment failure must not be confused with
// losing the acknowledgement of a write, especially a create or publish/create-draft.
// A create or new version is refused definitively by any 4xx, except that a create whose
// identity the server already holds (412 or 428) may have been stored by an earlier attempt.
for (const operation of ['assessment', 'create', 'update', 'version'])
  for (const status of [0, 400, 401, 403, 404, 408, 409, 412, 428, 500, 'body interrupted'])
    test(`${operation}: ${status} preserves work and only uncertain writes block repetition`, async () => {
      const state = new DesignerCoordinator(acceptPayload);
      const artifact = {'schema:name': 'Submitted'};
      const designer = {currentArtifact: artifact, isDirty: true, validate: () => ({canSave: true, issues: []})};
      state.loaded({artifact: {'@id': 'https://repo.test/templates/item', 'schema:name': 'Opened'}, etag: '"opened"', writable: true});
      const attempt = state.beginSave(designer);
      const error = typeof status === 'number' ? new BackendError(status, status === 400 ? VALIDATION : null) : new Error(status);
      const calls = [];
      await assert.rejects(saveArtifact({
        route: {kind: 'template', collection: 'templates', id: operation === 'create' ? null : 'https://repo.test/templates/item'},
        artifact, etag: state.etag, base: 'https://resource.test', folderId: 'folder',
        identity: () => state.identity(() => `https://repo.test/templates/${crypto.randomUUID()}`),
        onWrite: write => {attempt.write = write;}, confirmVersion: async () => true,
        request: async (url, options) => {
          calls.push({url, options});
          if (url.includes('/check-update-template/') && operation !== 'assessment')
            return {data: {canBeUpdated: operation !== 'version'}};
          // Model an edit arriving while the save or assessment is pending.
          designer.currentArtifact = {'schema:name': 'Newer'};
          throw error;
        },
      }), failure => failure === error);
      const lost = [0, 408, 500, 'body interrupted'].includes(status) || (operation === 'create' && [412, 428].includes(status));
      const uncertain = operation !== 'assessment' && lost;
      assert.equal(state.failed(error, attempt), uncertain);
      state.finish(attempt);
      assert.equal(state.uncertainCreation, uncertain && ['create', 'version'].includes(operation));
      assert.equal(state.reloadRequired, uncertain || [401, 403, 404, 409, 412, 428].includes(status));
      assert.deepEqual(state.stored, {'@id': 'https://repo.test/templates/item', 'schema:name': 'Opened'});
      assert.equal(designer.currentArtifact['schema:name'], 'Newer');
      assert.equal(state.dirty(designer), true);
      // A validation refusal belongs to the submitted snapshot, so the newer edit may be saved.
      assert.equal(state.report(designer).server.length, 0);
      assert.equal(state.beginSave(designer) === null, state.reloadRequired);
      assert.equal(calls.length, ['assessment', 'create'].includes(operation) ? 1 : 2);
      // Only an unsettled create or new version is checked by reading its identity.
      assert.equal(state.canCheckSave, uncertain);
      const write = calls.at(-1);
      if (operation === 'create') {
        assert.equal(write.options.method, 'PUT');
        assert.match(write.options.body['@id'], V4);
        assert.equal(write.url, `https://resource.test/templates/${write.options.body['@id'].split('/').pop()}?folder_id=folder`);
        assert.equal(write.options.etag, undefined);
      }
      if (operation === 'version') {
        const url = new URL(write.url);
        assert.equal(url.pathname, '/command/publish-create-draft-template/https%3A%2F%2Frepo.test%2Ftemplates%2Fitem');
        assert.equal(url.search, '');
        assert.match(write.options.body.draftId, V4);
        assert.equal(write.options.etag, '"opened"');
        assert.equal(write.options.body.template['@id'], 'https://repo.test/templates/item');
      }
      if (['create', 'version'].includes(operation)) {
        const id = operation === 'create' ? write.options.body['@id'] : write.options.body.draftId;
        assert.equal(attempt.write.identity, id);
        // The identity is reused by the next attempt, whatever the outcome of this one.
        assert.equal(state.identity(() => assert.fail('a second identity was minted')), id);
        const journal = JSON.parse(JSON.stringify(state.captureRecovery()));
        assert.equal(journal.identity, id);
        assert.equal(journal.creation?.id, uncertain ? id : undefined);
        if (uncertain) assert.deepEqual(journal.creation.submitted, operation === 'version' ? write.options.body.template : write.options.body);
        if (uncertain && operation === 'version') {
          assert.equal(journal.creation.source, 'https://repo.test/templates/item');
          assert.equal(journal.creation.etag, '"opened"');
        }
      }
    });

// A new version's draft identity is refused as occupied only when the server says so. Any other 412
// means the template changed since it was opened, which the author resolves by reopening it.
for (const errorKey of ['nodeAlreadyPresent', 'artifactHasMovedOn', undefined])
  test(`version: 412 ${errorKey ?? 'without an error key'} is ${errorKey === 'nodeAlreadyPresent' ? '' : 'not '}taken as possibly stored`, async () => {
    const state = new DesignerCoordinator(acceptPayload);
    const designer = {currentArtifact: {'schema:name': 'Submitted'}, isDirty: true, validate: () => ({canSave: true, issues: []})};
    state.loaded({artifact: {'@id': 'https://repo.test/templates/item', 'schema:name': 'Opened'}, etag: '"opened"', writable: true});
    const attempt = state.beginSave(designer);
    const error = new BackendError(412, errorKey ? {errorKey} : null);
    await assert.rejects(saveArtifact({
      route: {kind: 'template', collection: 'templates', id: 'https://repo.test/templates/item'}, artifact: designer.currentArtifact,
      etag: state.etag, base: 'https://resource.test', confirmVersion: async () => true,
      identity: () => state.identity(() => `https://repo.test/templates/${crypto.randomUUID()}`), onWrite: write => {attempt.write = write;},
      request: async url => { if (url.includes('/check-update-template/')) return {data: {canBeUpdated: false}}; throw error; },
    }), failure => failure === error);
    const occupied = errorKey === 'nodeAlreadyPresent';
    assert.equal(state.failed(error, attempt), occupied);
    assert.equal(state.uncertainCreation, occupied);
    assert.equal(state.canCheckSave, occupied);
    assert.equal(state.reloadRequired, true);
  });

// Only a template's owner may create a new version of it, and the server refuses anyone else with a 403
// under its own key. That refusal stores nothing, and no reload, sign-in or access check can lift it, so
// the page stays as it was before Save, with the edits. Any other 403 on the same request still refuses
// access, and a template the server cannot version is refused with a 400, as before.
const VERSIONING_REFUSALS = [[403, 'versioningOnlyByOwner'], [403, 'noWriteAccessToFolder'], [403, undefined],
  ...['publishOnlyDraft', 'createDraftOnlyFromPublished', 'versioningOnlyOnLatest', 'nonVersionedArtifactType'].map(key => [400, key])];
for (const [status, errorKey] of VERSIONING_REFUSALS)
  test(`version: ${status} ${errorKey ?? 'without an error key'} ${errorKey === 'versioningOnlyByOwner' ? 'leaves Save as it was'
    : status === 403 ? 'still refuses access' : 'is still a plain refusal'}`, async () => {
    const ownerOnly = errorKey === 'versioningOnlyByOwner', accessRefused = status === 403 && !ownerOnly;
    const opened = {'@id': 'https://repo.test/templates/item', 'schema:name': 'Opened'};
    const state = new DesignerCoordinator(acceptPayload);
    const designer = {currentArtifact: {'schema:name': 'Submitted'}, isDirty: true, validate: () => ({canSave: true, issues: []})};
    state.loaded({artifact: opened, etag: '"opened"', writable: true});
    const attempt = state.beginSave(designer);
    const error = new BackendError(status, errorKey ? {errorKey, parameters: {id: opened['@id']}} : null);
    const calls = [];
    await assert.rejects(saveArtifact({
      route: {kind: 'template', collection: 'templates', id: opened['@id']}, artifact: designer.currentArtifact,
      etag: state.etag, base: 'https://resource.test', confirmVersion: async () => true,
      identity: () => state.identity(() => `https://repo.test/templates/${crypto.randomUUID()}`), onWrite: write => {attempt.write = write;},
      request: async url => { calls.push(url); if (url.includes('/check-update-template/')) return {data: {canBeUpdated: false}}; throw error; },
    }), failure => failure === error);
    assert.match(calls.at(-1), /\/command\/publish-create-draft-template\//);
    assert.equal(error.message, ownerOnly ? "Only the template's owner can create a new version. Your edits have been kept."
      : accessRefused ? 'You do not have permission to save this artifact.' : 'Request failed (400). Your edits have been kept.');
    assert.equal(state.failed(error, attempt), false);
    state.finish(attempt);
    // A definitive refusal leaves nothing to check, whatever its reason.
    assert.equal(state.uncertainCreation, false);
    assert.equal(state.canCheckSave, false);
    assert.equal(state.reloadRequired, accessRefused);
    assert.equal(state.canRecheckAccess, accessRefused);
    const report = state.report(designer, designer.validate());
    assert.equal(report.canSave, !accessRefused);
    assert.equal(report.phase, accessRefused ? 'reload' : 'ready');
    assert.equal(report.server.length, 0);
    assert.deepEqual(state.stored, opened);
    assert.equal(state.dirty(designer), true);
    // The journal a reload restores from holds the same state, so a restored draft is guarded only after an access refusal.
    const journal = JSON.parse(JSON.stringify(state.captureRecovery()));
    assert.equal(journal.uncertainCreation, false);
    assert.equal(journal.creation, undefined);
    assert.equal(journal.pending?.purpose, accessRefused ? 'access' : undefined);
    const restored = new DesignerCoordinator(acceptPayload);
    restored.loaded({artifact: opened, etag: '"opened"', writable: true});
    restored.restoreRecovery(journal);
    assert.equal(restored.reloadRequired, accessRefused);
    assert.equal(restored.canRecheckAccess, accessRefused);
    assert.equal(restored.canCheckSave, false);
    assert.equal(restored.beginSave(designer) === null, accessRefused);
  });

test('a create sent without an identity, as before identities were sent, stays guarded and cannot be checked', async () => {
  const state = new DesignerCoordinator(acceptPayload);
  const designer = {currentArtifact: {'schema:name': 'Submitted'}, isDirty: true, validate: () => ({canSave: true, issues: []})};
  state.loaded({writable: true});
  const attempt = state.beginSave(designer);
  const calls = [];
  await assert.rejects(saveArtifact({
    route: {kind: 'template', collection: 'templates', id: null}, artifact: designer.currentArtifact, base: 'https://resource.test', folderId: 'folder',
    identity: () => null, onWrite: write => {attempt.write = write;},
    request: async (url, options) => { calls.push({url, options}); throw new BackendError(0); },
  }));
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].url, 'https://resource.test/templates?folder_id=folder');
  assert.equal(state.failed(new BackendError(0), attempt), true);
  assert.equal(state.uncertainCreation, true);
  assert.equal(state.canCheckSave, false);
  assert.equal(state.captureRecovery().creation, undefined);
});

// A create's identity is this page's own, so whatever it holds was sent from here, though not necessarily
// by the last attempt. What the server assigns on a create reads as the submission; anything else does not.
test('a create reads as committed only when its identity holds the last submission', () => {
  const id = 'https://repo.test/templates/6a3d1f0e-2b4c-4d5e-8f60-718293a4b5c6';
  const submitted = {'@id': id, 'schema:name': 'Study', 'pav:createdOn': null, 'pav:createdBy': null,
    properties: {Child: {'@id': 'tmp-1760650000000-child', 'schema:name': 'Child'}}};
  const stored = () => ({...structuredClone(submitted), 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft',
    'pav:createdOn': 'now', 'pav:createdBy': 'urn:user', 'pav:lastUpdatedOn': 'now', 'oslc:modifiedBy': 'urn:user',
    properties: {Child: {'@id': 'https://repo.test/template-fields/9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a', 'schema:name': 'Child',
      'pav:createdOn': 'now', 'pav:createdBy': 'urn:user'}}});
  const outcome = data => creationOutcome({operation: 'create', id, submitted}, {data, etag: '"1"'});
  assert.equal(outcome(stored()), 'committed');
  const renamed = stored(); renamed['schema:name'] = 'Study, earlier';
  assert.equal(outcome(renamed), 'earlier');
  const child = stored(); child.properties.Child['schema:name'] = 'Earlier child';
  assert.equal(outcome(child), 'earlier');
  assert.equal(outcome({...stored(), '@id': 'https://repo.test/templates/other'}), 'unresolved');
});

// A check that finds the identity absent while the first write is still in flight offers Save again. The
// author adds to the work and saves; the server, which has since stored the first attempt, refuses the
// repeat, and that answer is lost too. The identity then holds the first attempt, which must never be
// taken for the newer work and loaded over it.
test('a create whose identity holds an earlier attempt after a second lost answer is adopted, keeping the newer work', () => {
  const state = new DesignerCoordinator(acceptPayload);
  state.loaded({writable: true});
  const id = 'https://repo.test/templates/6a3d1f0e-2b4c-4d5e-8f60-718293a4b5c6';
  const designer = {currentArtifact: {'schema:name': 'First'}, isDirty: true, validationReport: {canSave: true, issues: []},
    validate() { return this.validationReport; }};
  const lose = () => {
    const attempt = state.beginSave(designer);
    attempt.write = {createsIdentity: true, operation: 'create', identity: state.identity(() => id),
      body: {...designer.currentArtifact, '@id': state.identity(() => assert.fail('a second identity was minted'))}};
    assert.equal(state.failed(new BackendError(0), attempt), true);
    state.finish(attempt);
  };
  lose();
  let check = state.beginCheck();
  assert.equal(state.settleCreation(check, {created: null, writable: true}), 'absent');
  state.finishCheck(check);
  designer.currentArtifact = {'schema:name': 'Second, extended'};
  lose();
  check = state.beginCheck();
  const earlier = {data: {'@id': id, 'schema:name': 'First', 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft'}, etag: '"1"'};
  assert.equal(state.settleCreation(check, {created: earlier, writable: true}), 'adopted');
  state.finishCheck(check);
  assert.deepEqual(state.stored, earlier.data);
  assert.equal(state.etag, '"1"');
  assert.equal(state.dirty(designer), true);
  assert.equal(state.reloadRequired, true);
  assert.equal(state.uncertainCreation, false);
  assert.equal(state.report(designer).canSave, false);
});
