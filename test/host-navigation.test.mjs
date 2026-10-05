import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../app/scripts/host-core.mjs';
import * as i18n from '../app/scripts/i18n.mjs';

// Exercise the real DOM wiring and navigation order with controlled I/O. In particular,
// location.assign fires beforeunload synchronously, before save's finally block runs.
// With an impact, a save asks the version dialog first, as a template change that needs a new version does.
async function host(isDirty = true, languages = ['en-US'], existing = false, impact = null) {
  const events = new Map(), nodes = new Map(), navigations = [];
  let resolveSave, rejectSave;
  const saved = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
  const designer = {
    isDirty, canSave: true, currentArtifact: {}, validationReport: { canSave: true, issues: [] }, validate: () => ({ canSave: true, issues: [] }),
    newArtifact() {}, addEventListener(event, callback) { events.set('designer:' + event, callback); },
    // Like CED, loading again takes the artifact as the baseline the designer compares edits with.
    // The first load leaves alone the state each test starts from.
    loads: [], loadArtifact(source) { if (this.loads.push(source) > 1) this.isDirty = false; },
  };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      dataset: {}, attributes: {}, addEventListener: (event, callback) => events.set(`${id}:${event}`, callback),
      setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
      append() {}, replaceChildren() {}, showModal() { this.open = true; },
    });
    return nodes.get(id);
  };
  const unload = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    events.get('beforeunload')(event);
    return event.prevented;
  };
  const location = {
    pathname: existing ? '/templates/edit/template-id' : '/templates/create', search: '',
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
      canEdit: () => true,
      createBackend: () => async () => ({ data: { '@id': 'template-id', homeFolderId: 'home', currentUserPermissions: {capabilities: ['createInFolder', 'updateResource']} }, etag: '"one"' }),
      saveArtifact: options => impact ? options.confirmVersion(impact).then(confirmed => confirmed ? saved : null) : saved,
    }, i18n);
  assert.equal(node('save').disabled, false);
  // The e2e smokes match these English texts exactly.
  if (i18n.language === 'en') assert.equal(node('state').textContent, isDirty ? 'Modified' : 'Unmodified');
  const closeVersion = choice => { node('version-dialog').returnValue = choice; events.get('version-dialog:close')(); };
  return { change: () => events.get('designer:dirtyChange')(), closeVersion, designer, document, unload, navigations, resolveSave, rejectSave, save: () => events.get('save:click')(), node };
}

for (const dirty of [true, false]) {
  test(`successful save returns to Workspace without prompting (dirty=${dirty})`, async () => {
    const h = await host(dirty);
    assert.equal(h.unload(), dirty);
    const saving = h.save();
    assert.equal(h.unload(), true, 'leaving during an unfinished save must still warn');
    h.resolveSave({ data: { '@id': 'saved-template' } });
    await saving;
    assert.equal(h.node('state').textContent, 'Saved');
    assert.equal(h.node('state').dataset.dirty, 'false');
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
    // A failure reads as an error notice; a cancelled save's explanation as information.
    assert.equal(h.node('message').textContent, failed ? 'Save failed' : 'Not saved. Your changes remain in the designer.');
    assert.equal(h.node('message').dataset.tone, failed ? 'error' : 'info');
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
  assert.equal(hungarian.node('state').textContent, 'Változatlan');
});

test('save status follows edits, reverts and an unsuccessful save', async () => {
  const h = await host(false);
  const state = h.node('state');
  assert.equal(state.textContent, 'Unmodified');
  assert.equal(state.dataset.saveState, 'true');
  assert.equal(state.dataset.dirty, 'false');
  h.designer.isDirty = true;
  h.change();
  assert.equal(state.textContent, 'Modified');
  assert.equal(state.dataset.dirty, 'true');
  h.designer.isDirty = false;
  h.change();
  assert.equal(state.textContent, 'Unmodified');
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

test('Save explains its refusal only while the designer lists an error', async () => {
  const h = await host(false);
  const help = h.node('save-help');
  assert.equal(help.dataset.blocked, 'false');
  // A blank name nobody has touched blocks saving, but the summary does not list it yet.
  h.designer.canSave = false;
  h.designer.validationReport = { canSave: false, issues: [{ setting: 'name', shown: false }] };
  h.change();
  assert.equal(h.node('save').disabled, true);
  assert.equal(help.dataset.blocked, 'false');
  assert.equal(h.node('save').attributes['aria-describedby'], undefined);
  h.designer.validationReport = { canSave: false, issues: [{ setting: 'key', shown: true }] };
  h.change();
  assert.equal(help.dataset.blocked, 'true');
  assert.equal(h.node('save').attributes['aria-describedby'], 'save-tooltip');
  h.designer.canSave = true;
  h.designer.validationReport = { canSave: true, issues: [] };
  h.change();
  assert.equal(help.dataset.blocked, 'false');
  assert.equal(h.node('save').attributes['aria-describedby'], undefined);
});

test('an existing unchanged artifact is unmodified, and returning to its original content restores that state', async () => {
  const h = await host(false, ['en-US'], true);
  assert.equal(h.node('state').textContent, 'Unmodified');
  assert.equal(h.node('state').dataset.dirty, 'false');
  h.designer.isDirty = true;
  h.change();
  assert.equal(h.node('state').textContent, 'Modified');
  h.designer.isDirty = false;
  h.change();
  assert.equal(h.node('state').textContent, 'Unmodified');
});

test('the version dialog names the draft version the existing template is published as', async () => {
  const h = await host(true, ['en-US'], true, { numberOfInstances: 9, oldVersion: '0.0.1' });
  const saving = h.save();
  assert.equal(h.node('version-dialog').open, true);
  assert.equal(h.node('version-message').textContent,
    '9 metadata instances use this template (version 0.0.1 draft). These changes require a new version.');
  assert.equal(h.node('version-explanation').textContent,
    'The existing template will be published as version 0.0.1 and your changes saved as a new draft. Existing metadata stays with the original template.');
  h.closeVersion('cancel');
  await saving;
});

for (const [count, version, language, message] of [
  [1, null, 'en-US', '1 metadata instance uses this template. These changes require a new version.'],
  [1, '0.0.1', 'en-US', '1 metadata instance uses this template (version 0.0.1 draft). These changes require a new version.'],
  [9, null, 'en-US', '9 metadata instances use this template. These changes require a new version.'],
  [null, null, 'en-US', 'Existing metadata instances use this template. These changes require a new version.'],
  [1, null, 'hu-HU', '1 metaadatpéldány használja ezt a sablont. Ezek a módosítások új verziót igényelnek.'],
  [9, '0.0.1', 'hu-HU', '9 metaadatpéldány használja ezt a sablont (verzió: 0.0.1, vázlat). Ezek a módosítások új verziót igényelnek.'],
]) test(`the version dialog's message for an instance count of ${count ?? 'unknown'}${version ? ' and a versioned draft' : ''} in ${language}`, async () => {
  const h = await host(true, [language], true, { numberOfInstances: count, ...(version ? { oldVersion: version } : {}) });
  const saving = h.save();
  assert.equal(h.node('version-message').textContent, message);
  h.closeVersion('cancel');
  await saving;
});

test('discarding from the version dialog restores the template as opened and stays in the designer', async () => {
  const h = await host(true, ['en-US'], true, { numberOfInstances: 9, oldVersion: '0.0.1' });
  const [opened] = h.designer.loads;
  h.designer.isDirty = true;
  h.change();
  const saving = h.save();
  h.closeVersion('discard');
  await saving;
  assert.deepEqual(h.navigations, []);
  assert.equal(h.designer.loads.length, 2);
  assert.deepEqual(h.designer.loads[1], opened);
  assert.notEqual(h.designer.loads[1], opened, 'each restore must start from its own copy of the stored template');
  assert.equal(h.node('message').textContent, 'Not saved. Your changes were discarded.');
  assert.equal(h.node('state').textContent, 'Unmodified');
  assert.equal(h.unload(), false);
  // A later save that keeps its changes says so.
  h.designer.isDirty = true;
  h.change();
  const again = h.save();
  h.closeVersion('cancel');
  await again;
  assert.equal(h.designer.loads.length, 2);
  assert.equal(h.node('message').textContent, 'Not saved. Your changes remain in the designer.');
});

test('keeping editing from the version dialog stays in the designer with the changes', async () => {
  const h = await host(true, ['en-US'], true, { numberOfInstances: 9 });
  const saving = h.save();
  assert.equal(h.node('version-explanation').textContent,
    'The existing template will be published and your changes saved as a new draft. Existing metadata stays with the original template.');
  h.closeVersion('cancel');
  await saving;
  assert.deepEqual(h.navigations, []);
  assert.equal(h.designer.loads.length, 1);
  assert.equal(h.node('message').textContent, 'Not saved. Your changes remain in the designer.');
  assert.equal(h.unload(), true);
});
