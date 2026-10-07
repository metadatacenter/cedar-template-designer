import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../app/scripts/host-core.mjs';
import * as i18n from '../app/scripts/i18n.mjs';

// Exercise the real DOM wiring and navigation order with controlled I/O. In particular,
// location.assign fires beforeunload synchronously, before a handler's finally block runs.
// With an impact, a save asks the version dialog first, as a template change that needs a new version does.
// With realSave, the host's own saveArtifact writes to the repository below instead of awaiting resolveSave.
async function host(isDirty = true, languages = ['en-US'], existing = false, impact = null, realSave = false) {
  const events = new Map(), nodes = new Map(), navigations = [], requests = [];
  let resolveSave, rejectSave;
  const saved = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
  const designer = {
    isDirty, canSave: true, currentArtifact: {}, validationReport: { canSave: true, issues: [] }, validate: () => ({ canSave: true, issues: [] }),
    newArtifact() {}, addEventListener(event, callback) { events.set('designer:' + event, callback); },
    // Like CED, loading takes the artifact as the document and the baseline the designer compares
    // edits with. A load while the host starts leaves alone the state each test starts from.
    loads: [], loadArtifact(source) {
      this.loads.push(source);
      if (this.started) { this.isDirty = false; this.currentArtifact = structuredClone(source); }
    },
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
    pathname: existing ? '/templates/edit/template-id' : '/templates/create',
    search: `?folderId=folder-id&returnTo=${encodeURIComponent('https://workspace.example/folders/folder-id')}`,
    get href() { return `https://designer.example${this.pathname}${this.search}`; },
    assign: url => navigations.push({ url, blocked: unload() }),
  };
  const window = {
    addEventListener: (event, callback) => events.set(event, callback),
    confirmations: [], answer: true,
    confirm(text) { this.confirmations.push(text); return this.answer; },
    history: { replaceState(_state, _title, url) { ({ pathname: location.pathname, search: location.search } = new URL(url)); } },
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
  // Holds templates as the resource server does. Creation mints the identity and starts at Draft
  // 0.0.1. An update needs the current ETag, refuses a change to lifecycle metadata, and answers
  // with the graph record rather than the document. An entry that is an error fails its read.
  const repository = new Map(), impacts = [];
  if (existing) repository.set('template-id', { data: { '@id': 'template-id', 'schema:name': 'Study', 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft' }, etag: '"one"' });
  let revision = 0;
  const store = (id, data) => {
    const entry = { data: { ...structuredClone(data), '@id': id }, etag: `"${++revision}"` };
    repository.set(id, entry);
    return entry;
  };
  const request = async (url, { method = 'GET', body, etag } = {}) => {
    requests.push({ method, url, ...(etag ? { etag } : {}) });
    const [, collection, id, rest] = new URL(url).pathname.split('/').map(decodeURIComponent);
    const current = id => {
      if (repository.get(id)?.etag !== etag) throw new core.BackendError(412);
      return repository.get(id).data;
    };
    if (method === 'POST' && collection === 'templates') {
      return structuredClone(store('created-template', { ...body, 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft' }));
    }
    if (method === 'POST' && id === 'check-update-template') return { data: impacts.shift() ?? { canBeUpdated: true } };
    if (method === 'POST' && id === 'publish-create-draft-template') {
      const source = current(rest);
      const draft = store('draft-template', { ...body, 'pav:version': '0.0.2', 'bibo:status': 'bibo:draft', 'pav:previousVersion': source['@id'] });
      return { data: { '@id': 'draft-template', resourceType: 'template' }, etag: draft.etag };
    }
    if (method === 'PUT') {
      const stored = current(id);
      if (['pav:version', 'bibo:status', 'pav:previousVersion'].some(key => stored[key] !== body[key])) throw new core.BackendError(400);
      return { data: { '@id': id, resourceType: 'template' }, etag: store(id, body).etag };
    }
    if (method === 'GET' && !rest && repository.has(id)) {
      const entry = repository.get(id);
      if (entry instanceof Error) throw entry;
      return structuredClone(entry);
    }
    return { data: { '@id': 'template-id', homeFolderId: 'home', currentUserPermissions: {capabilities: ['createInFolder', 'updateResource']} }, etag: '"one"' };
  };
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
      createBackend: () => request,
      saveArtifact: realSave ? core.saveArtifact : options => impact ? options.confirmVersion(impact).then(confirmed => confirmed ? saved : null) : saved,
    }, i18n);
  designer.started = true;
  assert.equal(node('save').disabled, false);
  // The e2e smokes match these English texts exactly.
  if (i18n.language === 'en') assert.equal(node('state').textContent, isDirty ? 'Modified' : 'Unmodified');
  const closeVersion = choice => { node('version-dialog').returnValue = choice; events.get('version-dialog:close')(); };
  return { change: () => events.get('designer:dirtyChange')(), closeVersion, designer, document, unload, navigations, resolveSave, rejectSave,
    save: () => events.get('save:click')(), back: () => events.get('back:click')(), node, location, window, requests, repository, impacts };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

for (const dirty of [true, false]) {
  test(`saving a new artifact stays in Designer at its edit address (dirty=${dirty})`, async () => {
    const h = await host(dirty);
    const { search } = h.location;
    assert.equal(h.unload(), dirty);
    const saving = h.save();
    assert.equal(h.unload(), true, 'leaving during an unfinished save must still warn');
    const stored = { '@id': 'saved-template', 'schema:name': 'Study', 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft' };
    h.repository.set('saved-template', { data: stored, etag: '"1"' });
    h.resolveSave({ data: stored, etag: '"1"' });
    await saving;
    assert.deepEqual(h.navigations, []);
    assert.equal(h.location.pathname, '/templates/edit/saved-template');
    assert.equal(h.location.search, search, 'the edit address keeps returnTo and folderId');
    assert.deepEqual(h.requests.at(-1), { method: 'GET', url: 'https://resource.example/templates/saved-template' });
    assert.deepEqual(h.designer.loads, [stored]);
    assert.equal(h.node('state').textContent, 'Saved');
    assert.equal(h.node('state').dataset.dirty, 'false');
    assert.equal(h.node('message').textContent, '');
    assert.equal(h.node('save').disabled, false);
    assert.equal(h.unload(), false);
  });
}

test('saving an existing artifact stays in Designer, which only Back to Workspace leaves', async () => {
  const h = await host(true, ['en-US'], true);
  const address = h.location.href;
  const saving = h.save();
  const stored = { ...h.repository.get('template-id').data, 'schema:name': 'Study, revised' };
  h.repository.set('template-id', { data: stored, etag: '"two"' });
  h.resolveSave({ data: { '@id': 'template-id', resourceType: 'template' }, etag: '"two"' });
  await saving;
  assert.deepEqual(h.navigations, []);
  assert.equal(h.location.href, address);
  assert.deepEqual(h.designer.loads.at(-1), stored);
  assert.equal(h.node('state').textContent, 'Saved');
  assert.equal(h.node('message').textContent, '');
  assert.equal(h.unload(), false);
  // Leaving with unsaved changes asks first, and declining stays.
  h.designer.isDirty = true;
  h.change();
  h.window.answer = false;
  h.back();
  assert.deepEqual(h.window.confirmations, ['Discard your unsaved changes and return to Workspace?']);
  assert.deepEqual(h.navigations, []);
  h.window.answer = true;
  h.back();
  assert.deepEqual(h.navigations, [{ url: 'https://workspace.example/folders/folder-id', blocked: false }]);
});

test('a second save after creating an artifact updates it with the ETag the creation returned', async () => {
  const h = await host(true, ['en-US'], false, null, true);
  h.designer.currentArtifact = { 'schema:name': 'Study' };
  const before = h.requests.length;
  await h.save();
  assert.equal(h.node('state').textContent, 'Saved');
  assert.equal(h.location.pathname, '/templates/edit/created-template');
  h.designer.currentArtifact = { ...h.designer.currentArtifact, 'schema:name': 'Study, revised' };
  h.designer.isDirty = true;
  h.change();
  assert.equal(h.node('state').textContent, 'Modified');
  await h.save();
  assert.deepEqual(h.requests.slice(before), [
    { method: 'POST', url: 'https://resource.example/templates?folder_id=folder-id' },
    { method: 'GET', url: 'https://resource.example/templates/created-template' },
    { method: 'POST', url: 'https://resource.example/command/check-update-template/created-template' },
    { method: 'PUT', url: 'https://resource.example/templates/created-template', etag: '"1"' },
    { method: 'GET', url: 'https://resource.example/templates/created-template' },
  ]);
  assert.equal(h.repository.get('created-template').data['schema:name'], 'Study, revised');
  assert.equal(h.node('state').textContent, 'Saved');
  assert.deepEqual(h.navigations, []);
});

test('confirming a new version opens the new draft, and the next save updates the draft', async () => {
  const h = await host(true, ['en-US'], true, null, true);
  h.designer.currentArtifact = { ...h.repository.get('template-id').data, 'schema:name': 'Study, revised' };
  h.impacts.push({ canBeUpdated: false, numberOfInstances: 9, oldVersion: '0.0.1' });
  const before = h.requests.length;
  const saving = h.save();
  while (!h.node('version-dialog').open) await settle();
  h.closeVersion('confirm');
  await saving;
  assert.equal(h.location.pathname, '/templates/edit/draft-template');
  assert.equal(h.designer.currentArtifact['pav:version'], '0.0.2');
  assert.equal(h.node('state').textContent, 'Saved');
  h.designer.currentArtifact = { ...h.designer.currentArtifact, 'schema:name': 'Study, second revision' };
  h.designer.isDirty = true;
  h.change();
  await h.save();
  assert.deepEqual(h.requests.slice(before), [
    { method: 'POST', url: 'https://resource.example/command/check-update-template/template-id' },
    { method: 'POST', url: 'https://resource.example/command/publish-create-draft-template/template-id', etag: '"one"' },
    { method: 'GET', url: 'https://resource.example/templates/draft-template' },
    { method: 'POST', url: 'https://resource.example/command/check-update-template/draft-template' },
    { method: 'PUT', url: 'https://resource.example/templates/draft-template', etag: '"1"' },
    { method: 'GET', url: 'https://resource.example/templates/draft-template' },
  ]);
  assert.equal(h.repository.get('draft-template').data['schema:name'], 'Study, second revision');
  assert.deepEqual(h.navigations, []);
});

test('a save whose stored artifact cannot be read back stays in Designer and asks for a reload', async () => {
  const h = await host();
  const saving = h.save();
  h.repository.set('saved-template', new core.BackendError(0));
  h.resolveSave({ data: { '@id': 'saved-template' }, etag: '"1"' });
  await saving;
  assert.deepEqual(h.navigations, []);
  assert.equal(h.location.pathname, '/templates/edit/saved-template');
  assert.equal(h.node('state').textContent, 'Reload required');
  assert.equal(h.node('message').textContent, 'Saved. Reload the designer before saving again.');
  assert.equal(h.node('save').disabled, true);
  assert.equal(h.node('reload').hidden, false);
  assert.equal(h.unload(), false);
});

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
