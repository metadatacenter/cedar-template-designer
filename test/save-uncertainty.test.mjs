import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DesignerCoordinator, saveArtifact, BackendError} from '../app/scripts/host-core.mjs';

// Run the real save orchestration: an assessment failure must not be confused with
// losing the acknowledgement of a write, especially a create or publish/create-draft.
for (const operation of ['assessment', 'create', 'update', 'version'])
  for (const status of [0, 401, 403, 408, 412, 500, 'body interrupted'])
    test(`${operation}: ${status} preserves work and only uncertain writes block repetition`, async () => {
      const state = new DesignerCoordinator();
      const artifact = {'schema:name': 'Submitted'};
      const designer = {currentArtifact: artifact, isDirty: true, validate: () => ({canSave: true, issues: []})};
      state.loaded({artifact: {'schema:name': 'Opened'}, etag: '"opened"', writable: true});
      const attempt = state.beginSave(designer);
      const error = typeof status === 'number' ? new BackendError(status) : new Error(status);
      const calls = [];
      await assert.rejects(saveArtifact({
        route: {kind: 'template', collection: 'templates', id: operation === 'create' ? null : 'item'},
        artifact, etag: state.etag, base: 'https://resource.test', folderId: 'folder',
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
      const uncertain = operation !== 'assessment' && [0, 408, 500, 'body interrupted'].includes(status);
      assert.equal(state.failed(error, attempt), uncertain);
      state.finish(attempt);
      assert.equal(state.uncertainCreation, uncertain && ['create', 'version'].includes(operation));
      assert.equal(state.reloadRequired, uncertain || [401, 403, 412].includes(status));
      assert.deepEqual(state.stored, {'schema:name': 'Opened'});
      assert.equal(designer.currentArtifact['schema:name'], 'Newer');
      assert.equal(state.dirty(designer), true);
      assert.equal(state.beginSave(designer) === null, state.reloadRequired);
      assert.equal(calls.length, ['assessment', 'create'].includes(operation) ? 1 : 2);
    });
