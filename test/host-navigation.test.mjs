import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../app/scripts/host-core.mjs';
import * as i18n from '../app/scripts/i18n.mjs';

// Exercise the real DOM wiring and navigation order with controlled I/O. In particular,
// location.assign fires beforeunload synchronously, before save's finally block runs.
async function host(isDirty = true, languages = ['en-US']) {
  const events = new Map(), nodes = new Map(), navigations = [];
  let resolveSave, rejectSave;
  const saved = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
  const designer = {
    isDirty, canSave: true, currentArtifact: {}, validate: () => ({ canSave: true }),
    newArtifact() {}, addEventListener(event, callback) { events.set('designer:' + event, callback); },
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
    documentElement: {},
    querySelectorAll: () => [],
    createElement: tag => tag === 'script' ? {} : designer,
    head: { append: script => script.onload() },
  };
  const config = { resourceRestAPI: 'https://resource.example', userRestAPI: 'https://user.example', workspaceFrontend: 'https://workspace.example' };
  const fetch = async url => ({ ok: true, json: async () => url.startsWith('config/') ? config : Object.fromEntries(
    ['cedar-embeddable-editor', 'cedar-embeddable-term-picker', 'cedar-embeddable-designer'].map(name => [name, { sha256: 'test' }]),
  ) });
  const source = (await readFile(new URL('../app/scripts/host.mjs', import.meta.url), 'utf8'))
    .replace(/^import \{iconSvg\} from [^;]+;/m, 'const iconSvg = () => "";')
    .replace(/await import\(`\.\/host-core\.mjs\?v=\$\{version\}`\)/, 'core')
    .replace(/await import\(`\.\/i18n\.mjs\?v=\$\{version\}`\)/, 'i18n');
  const run = new (Object.getPrototypeOf(async function() {}).constructor)(
    'window', 'document', 'location', 'fetch', 'customElements', 'crypto', 'navigator', 'core', 'i18n', source,
  );
  await run(window, document, location, fetch, { whenDefined: async () => {}, get: () => true },
    { randomUUID: () => 'session' }, { languages }, { ...core,
      createBackend: () => async () => ({ data: { homeFolderId: 'home' } }),
      saveArtifact: () => saved,
    }, i18n);
  assert.equal(node('save').disabled, false);
  // The e2e smokes match these English texts exactly.
  if (i18n.language === 'en') assert.equal(node('state').textContent, isDirty ? 'Modified' : 'Saved');
  return { change: () => events.get('designer:dirtyChange')(), designer, document, unload, navigations, resolveSave, rejectSave, save: () => events.get('save:click')(), node };
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

test('the host detects its language, labels the page with it and passes it to CED', async t => {
  t.after(() => i18n.setLanguage('en'));
  const english = await host(false);
  assert.equal(english.designer.language, 'en');
  assert.equal(english.document.documentElement.lang, 'en');
  const hungarian = await host(false, ['hu-HU', 'en-US']);
  assert.equal(hungarian.designer.language, 'hu');
  assert.equal(hungarian.document.documentElement.lang, 'hu');
  assert.equal(hungarian.node('state').textContent, 'Mentve');
});

test('save status follows edits, reverts and an unsuccessful save', async () => {
  const h = await host(false);
  const state = h.node('state');
  assert.equal(state.textContent, 'Saved');
  assert.equal(state.dataset.saveState, 'true');
  assert.equal(state.dataset.dirty, 'false');
  h.designer.isDirty = true;
  h.change();
  assert.equal(state.textContent, 'Modified');
  assert.equal(state.dataset.dirty, 'true');
  h.designer.isDirty = false;
  h.change();
  assert.equal(state.textContent, 'Saved');
  assert.equal(state.dataset.dirty, 'false');
  h.designer.isDirty = true;
  h.change();
  const saving = h.save();
  assert.equal(state.textContent, 'Saving…');
  assert.equal(state.dataset.saveState, 'false');
  assert.equal(h.node('save').disabled, true);
  h.rejectSave(new Error('Save failed'));
  await saving;
  assert.equal(state.textContent, 'Modified');
  assert.equal(state.dataset.saveState, 'true');
  assert.equal(state.dataset.dirty, 'true');
  assert.equal(h.node('save').disabled, false);
});
