import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../app/scripts/host-core.mjs';

// Exercise the real DOM wiring and navigation order with controlled I/O. In particular,
// location.assign fires beforeunload synchronously, before save's finally block runs.
async function host(isDirty = true) {
  const events = new Map(), nodes = new Map(), navigations = [];
  let resolveSave, rejectSave;
  const saved = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
  const designer = {
    isDirty, canSave: true, currentArtifact: {}, validate: () => ({ canSave: true }),
    newArtifact() {}, addEventListener() {},
    loadArtifact() {},
  };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      dataset: {}, addEventListener: (event, callback) => events.set(`${id}:${event}`, callback),
      append() {}, replaceChildren() {},
    });
    return nodes.get(id);
  };
  const unload = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    events.get('beforeunload')(event);
    return event.prevented;
  };
  const location = {
    pathname: '/templates/create', search: '',
    assign: url => navigations.push({ url, blocked: unload() }),
  };
  const window = {
    addEventListener: (event, callback) => events.set(event, callback),
    confirm: () => true,
    KeycloakUserHandler: class {
      initUserHandler(resolve) { resolve(true); }
      getParsedToken() { return { sub: 'test-user' }; }
    },
  };
  const document = {
    getElementById: node,
    createElement: tag => tag === 'script' ? {} : designer,
    head: { append: script => script.onload() },
  };
  const config = { resourceRestAPI: 'https://resource.example', userRestAPI: 'https://user.example', workspaceFrontend: 'https://workspace.example' };
  const fetch = async url => ({ ok: true, json: async () => url.startsWith('config/') ? config : Object.fromEntries(
    ['cedar-embeddable-editor', 'cedar-embeddable-term-picker', 'cedar-embeddable-designer'].map(name => [name, { sha256: 'test' }]),
  ) });
  const source = (await readFile(new URL('../app/scripts/host.mjs', import.meta.url), 'utf8'))
    .replace(/^import \{iconSvg\} from [^;]+;/m, 'const iconSvg = () => "";')
    .replace(/await import\(`\.\/host-core\.mjs\?v=\$\{version\}`\)/, 'core');
  const run = new (Object.getPrototypeOf(async function() {}).constructor)(
    'window', 'document', 'location', 'fetch', 'customElements', 'crypto', 'core', source,
  );
  await run(window, document, location, fetch, { whenDefined: async () => {}, get: () => true },
    { randomUUID: () => 'session' }, { ...core,
      createBackend: () => async () => ({ data: { homeFolderId: 'home' } }),
      saveArtifact: () => saved,
    });
  assert.equal(node('save').disabled, false);
  assert.equal(node('state').textContent, isDirty ? 'Unsaved changes' : 'Not saved yet');
  return { unload, navigations, resolveSave, rejectSave, save: () => events.get('save:click')(), node };
}

for (const dirty of [true, false]) {
  test(`successful save returns to Workspace without prompting (dirty=${dirty})`, async () => {
    const h = await host(dirty);
    assert.equal(h.unload(), dirty);
    const saving = h.save();
    assert.equal(h.unload(), true, 'leaving during an unfinished save must still warn');
    h.resolveSave({ data: { '@id': 'saved-template' } });
    await saving;
    assert.deepEqual(h.navigations, [{ url: 'https://workspace.example/dashboard', blocked: false }]);
  });
}

for (const failed of [true, false]) {
  test(`${failed ? 'failed' : 'cancelled'} save retains unsaved-change protection`, async () => {
    const h = await host();
    const saving = h.save();
    if (failed) h.rejectSave(new Error('Save failed'));
    else h.resolveSave(null);
    await saving;
    assert.deepEqual(h.navigations, []);
    assert.equal(h.unload(), true);
    assert.equal(h.node('save').disabled, false);
  });
}
