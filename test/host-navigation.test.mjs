import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as core from '../app/scripts/host-core.mjs';
import * as drafts from '../app/scripts/host-draft.mjs';
import * as policy from '../app/scripts/json-policy.mjs';
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
  // Holds templates as the resource server does. Creation stores the identity the request names and
  // starts at Draft 0.0.1; a repeat that names an identity already held is refused with 428. A new
  // version is stored under the draft identity the request names. An update needs the current ETag,
  // refuses a change to lifecycle metadata, and answers with the graph record rather than the
  // document. An entry that is an error fails its read, and an artifact never stored reads as not
  // found. `faults` answers the next write with an error: `committed` stores the write first, as a
  // server whose answer is lost does, and `refused` leaves everything as it was.
  const repository = new Map(), impacts = [], faults = [];
  if (existing) repository.set('template-id', { data: { '@id': 'template-id', 'schema:name': 'Study', 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft' }, etag: '"one"' });
  let revision = 0;
  const store = (id, data, identity = id) => {
    const entry = { data: { ...structuredClone(data), '@id': identity }, etag: `"${++revision}"` };
    repository.set(id, entry);
    return entry;
  };
  const request = async (url, { method = 'GET', body, etag } = {}) => {
    requests.push({ method, url, ...(etag ? { etag } : {}) });
    const address = new URL(url);
    const [, collection, id, rest] = address.pathname.split('/').map(decodeURIComponent);
    const current = id => {
      if (repository.get(id)?.etag !== etag) throw new core.BackendError(412);
      return repository.get(id).data;
    };
    const writing = method !== 'GET' && id !== 'check-update-template';
    const fault = writing ? faults.shift() : undefined;
    if (fault?.refused) throw fault.refused;
    const answer = result => { if (fault?.committed) throw fault.committed; return result; };
    if (method === 'POST' && collection === 'templates') {
      return answer(structuredClone(store('created-template', { ...body, 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft' })));
    }
    if (method === 'PUT' && collection === 'templates' && !etag) {
      if (repository.has(id)) throw new core.BackendError(428);
      const created = store(id, { ...body, 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft', 'pav:createdOn': 'now' }, body['@id']);
      return answer({ data: structuredClone(created.data), etag: created.etag });
    }
    if (method === 'POST' && id === 'check-update-template') return { data: impacts.shift() ?? { canBeUpdated: true } };
    if (method === 'POST' && id === 'publish-create-draft-template') {
      const source = current(rest);
      const named = address.searchParams.get('draft_id');
      const draftId = named ?? 'draft-template';
      if (repository.has(core.resourcePathId(draftId))) throw new core.BackendError(412, { errorKey: 'nodeAlreadyPresent' });
      // Publishing the source gives it a new revision; the draft takes the next in the series.
      repository.set(rest, { data: { ...source, 'bibo:status': 'bibo:published' }, etag: '"published"' });
      const draft = store(core.resourcePathId(draftId), { ...body, 'pav:version': '0.0.2', 'bibo:status': 'bibo:draft', 'pav:previousVersion': source['@id'] }, draftId);
      return answer({ data: { '@id': draftId, resourceType: 'template' }, etag: draft.etag });
    }
    if (method === 'PUT') {
      const stored = current(id);
      if (['pav:version', 'bibo:status', 'pav:previousVersion'].some(key => stored[key] !== body[key])) throw new core.BackendError(400);
      return answer({ data: { '@id': stored['@id'], resourceType: 'template' }, etag: store(id, body, stored['@id']).etag });
    }
    if (method === 'GET' && !rest && repository.has(id)) {
      const entry = repository.get(id);
      if (entry instanceof Error) throw entry;
      return structuredClone(entry);
    }
    if (method === 'GET' && !rest && collection === 'templates') throw new core.BackendError(404);
    return { data: { '@id': 'template-id', homeFolderId: 'home', currentUserPermissions: {capabilities: ['createInFolder', 'updateResource']} }, etag: '"one"' };
  };
  const source = (await readFile(new URL('../app/scripts/host.mjs', import.meta.url), 'utf8'))
    .replace(/^import \{[^;]+from '\.\/json-policy\.mjs';/m, 'const { JsonSourcePolicy, TextPolicy } = policy;')
    .replace(/^import \{iconSvg\} from [^;]+;/m, 'const iconSvg = () => "";')
    .replace(/await import\(`\.\/host-core\.mjs\?v=\$\{version\}`\)/, 'core')
    .replace(/await import\(`\.\/host-draft\.mjs\?v=\$\{version\}`\)/, 'drafts')
    .replace(/await import\(`\.\/i18n\.mjs\?v=\$\{version\}`\)/, 'i18n');
  const run = new (Object.getPrototypeOf(async function() {}).constructor)(
    'window', 'document', 'location', 'fetch', 'customElements', 'crypto', 'navigator', 'core', 'i18n', 'drafts', 'policy', source,
  );
  await run(window, document, location, fetch, { whenDefined: async () => {}, get: () => true },
    { randomUUID: () => 'session' }, { languages }, { ...core,
      canEdit: () => true,
      createBackend: () => request,
      saveArtifact: realSave ? core.saveArtifact : options => impact ? options.confirmVersion(impact).then(confirmed => confirmed ? saved : null) : saved,
    }, i18n, drafts, policy);
  designer.started = true;
  assert.equal(node('save').disabled, false);
  // The e2e smokes match these English texts exactly.
  if (i18n.language === 'en') assert.equal(node('state').textContent, isDirty ? 'Modified' : 'Unmodified');
  const closeVersion = choice => { node('version-dialog').returnValue = choice; events.get('version-dialog:close')(); };
  return { change: () => events.get('designer:dirtyChange')(), closeVersion, designer, document, unload, navigations, resolveSave, rejectSave,
    save: () => events.get('save:click')(), back: () => events.get('back:click')(), check: () => events.get('check-save:click')(),
    recheck: () => events.get('recheck-access:click')(), node, location, window, requests, repository, impacts, faults };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
// The identity the host mints for a create or new version, on the base https://repo.example/.
const UUID = '6a3d1f0e-2b4c-4d5e-8f60-718293a4b5c6';
const MINTED = `https://repo.example/templates/${UUID}`;
const minting = t => t.mock.method(globalThis.crypto, 'randomUUID', () => UUID);

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

test('saving an existing artifact keeps the open document, and the next save uses the ETag it returned', async () => {
  const h = await host(true, ['en-US'], true, null, true);
  h.designer.currentArtifact = { ...h.repository.get('template-id').data, 'schema:name': 'Study, revised' };
  const address = h.location.href, before = h.requests.length;
  await h.save();
  assert.deepEqual(h.navigations, []);
  assert.equal(h.location.href, address);
  assert.equal(h.designer.loads.length, 1, 'the designer keeps the open document, and the author keeps their place in it');
  assert.equal(h.node('state').textContent, 'Saved');
  assert.equal(h.node('message').textContent, '');
  assert.equal(h.unload(), false);
  h.designer.currentArtifact = { ...h.designer.currentArtifact, 'schema:name': 'Study, second revision' };
  h.change();
  assert.equal(h.node('state').textContent, 'Modified');
  await h.save();
  assert.deepEqual(h.requests.slice(before), [
    { method: 'POST', url: 'https://resource.example/command/check-update-template/template-id' },
    { method: 'PUT', url: 'https://resource.example/templates/template-id', etag: '"one"' },
    { method: 'POST', url: 'https://resource.example/command/check-update-template/template-id' },
    { method: 'PUT', url: 'https://resource.example/templates/template-id', etag: '"1"' },
  ]);
  assert.equal(h.repository.get('template-id').data['schema:name'], 'Study, second revision');
  assert.equal(h.node('state').textContent, 'Saved');
  // Only Back to Workspace leaves Designer. With unsaved changes it asks first, and declining stays.
  h.designer.currentArtifact = { ...h.designer.currentArtifact, 'schema:name': 'Study, unsaved' };
  h.change();
  h.window.answer = false;
  h.back();
  assert.deepEqual(h.window.confirmations, ['Discard your unsaved changes and return to Workspace?']);
  assert.deepEqual(h.navigations, []);
  h.window.answer = true;
  h.back();
  assert.deepEqual(h.navigations, [{ url: 'https://workspace.example/folders/folder-id', blocked: false }]);
});

test('a second save after creating an artifact updates it with the ETag the creation returned', async t => {
  minting(t);
  const h = await host(true, ['en-US'], false, null, true);
  h.designer.currentArtifact = { 'schema:name': 'Study' };
  const before = h.requests.length;
  await h.save();
  assert.equal(h.node('state').textContent, 'Saved');
  assert.equal(h.location.pathname, `/templates/edit/${UUID}`);
  h.designer.currentArtifact = { ...h.designer.currentArtifact, 'schema:name': 'Study, revised' };
  h.designer.isDirty = true;
  h.change();
  assert.equal(h.node('state').textContent, 'Modified');
  await h.save();
  // The create puts the identity it minted, and every later request uses that identity.
  assert.deepEqual(h.requests.slice(before), [
    { method: 'PUT', url: `https://resource.example/templates/${UUID}?folder_id=folder-id` },
    { method: 'GET', url: `https://resource.example/templates/${UUID}` },
    { method: 'POST', url: `https://resource.example/command/check-update-template/${UUID}` },
    { method: 'PUT', url: `https://resource.example/templates/${UUID}`, etag: '"1"' },
  ]);
  assert.equal(h.repository.get(UUID).data['@id'], MINTED);
  assert.equal(h.repository.get(UUID).data['schema:name'], 'Study, revised');
  assert.equal(h.node('state').textContent, 'Saved');
  assert.deepEqual(h.navigations, []);
});

test('confirming a new version opens the new draft, and the next save updates the draft', async t => {
  minting(t);
  const h = await host(true, ['en-US'], true, null, true);
  h.designer.currentArtifact = { ...h.repository.get('template-id').data, 'schema:name': 'Study, revised' };
  h.impacts.push({ canBeUpdated: false, numberOfInstances: 9, oldVersion: '0.0.1' });
  const before = h.requests.length;
  const saving = h.save();
  while (!h.node('version-dialog').open) await settle();
  h.closeVersion('confirm');
  await saving;
  assert.equal(h.location.pathname, `/templates/edit/${UUID}`);
  assert.equal(h.designer.currentArtifact['pav:version'], '0.0.2');
  assert.equal(h.node('state').textContent, 'Saved');
  h.designer.currentArtifact = { ...h.designer.currentArtifact, 'schema:name': 'Study, second revision' };
  h.designer.isDirty = true;
  h.change();
  await h.save();
  assert.deepEqual(h.requests.slice(before), [
    { method: 'POST', url: 'https://resource.example/command/check-update-template/template-id' },
    { method: 'POST', url: `https://resource.example/command/publish-create-draft-template/template-id?draft_id=${encodeURIComponent(MINTED)}`, etag: '"one"' },
    { method: 'GET', url: `https://resource.example/templates/${UUID}` },
    { method: 'POST', url: `https://resource.example/command/check-update-template/${UUID}` },
    { method: 'PUT', url: `https://resource.example/templates/${UUID}`, etag: '"1"' },
  ]);
  assert.equal(h.repository.get(UUID).data['@id'], MINTED);
  assert.equal(h.repository.get(UUID).data['schema:name'], 'Study, second revision');
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

// A refused create or update leaves the edits in the designer. Its message says so after the server's
// message as well as without one, and a server message that ends with a full stop takes no second one.
for (const [language, languages, withoutMessage, withMessage] of [
  ['English', ['en-US'], 'Request failed (400). Your edits have been kept.', 'Request failed (400). Invalid folder identifier. Your edits have been kept.'],
  ['Hungarian', ['hu-HU'], 'A kérés sikertelen (400). A szerkesztései megmaradtak.', 'A kérés sikertelen (400). Invalid folder identifier. A szerkesztései megmaradtak.'],
]) for (const existing of [false, true]) for (const data of [null, { message: 'Invalid folder identifier' }, { message: 'Invalid folder identifier.' }]) {
  test(`a refused ${existing ? 'update' : 'create'} in ${language} ${data ? `with the server message "${data.message}"` : 'without a server message'} says the edits are kept`, async t => {
    t.after(() => i18n.setLanguage('en'));
    minting(t);
    const h = await host(true, languages, existing, null, true);
    h.designer.currentArtifact = { ...(existing ? h.repository.get('template-id').data : {}), 'schema:name': 'Study, revised' };
    const before = structuredClone([...h.repository]);
    // The error is made in the page's language, as the host's request makes it.
    h.faults.push({ refused: new core.BackendError(400, data) });
    await h.save();
    // The refusal answered the write itself.
    assert.equal(h.requests.at(-1).method, 'PUT');
    assert.equal(h.requests.at(-1).url.startsWith(`https://resource.example/templates/${existing ? 'template-id' : UUID}`), true);
    assert.equal(h.node('message').textContent, data ? withMessage : withoutMessage);
    assert.equal(h.node('message').dataset.tone, 'error');
    assert.equal(h.designer.currentArtifact['schema:name'], 'Study, revised');
    assert.deepEqual([...h.repository], before);
    assert.equal(h.node('save').disabled, false);
    assert.equal(h.unload(), true);
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

// Exceptional controls appear only while their condition exists.
const RECOVERY = ['check-save', 'recheck-access', 'draft-offer', 'sign-in-again', 'reload'];
const shown = h => RECOVERY.filter(id => h.node(id).hidden === false);
for (const existing of [false, true]) test(`a ${existing ? 'opened' : 'new'} template offers no recovery control while opening, editing or after saving`, async t => {
  minting(t);
  const h = await host(false, ['en-US'], existing, null, true);
  assert.deepEqual(shown(h), []);
  h.designer.currentArtifact = { ...(existing ? h.repository.get('template-id').data : {}), 'schema:name': 'Study, edited' };
  h.designer.isDirty = true; h.change();
  assert.equal(h.node('state').textContent, 'Modified');
  assert.deepEqual(shown(h), []);
  await h.save();
  assert.equal(h.node('state').textContent, 'Saved');
  assert.deepEqual(shown(h), []);
});

/** Save a template that needs a new version, and confirm the version dialog. */
async function saveNewVersion(h) {
  h.impacts.push({ canBeUpdated: false, numberOfInstances: 1, oldVersion: '0.0.1' });
  h.node('version-dialog').open = false;
  const saving = h.save();
  while (!h.node('version-dialog').open) await settle();
  h.closeVersion('confirm');
  await saving;
}
const successors = h => [...h.repository.values()].filter(entry => entry.data?.['pav:previousVersion'] === 'template-id');
const versionWrites = h => h.requests.filter(request => request.url.includes('/publish-create-draft-template/'));

for (const [label, refusal, message] of [
  ['refused permission', new core.BackendError(403), 'You do not have permission to save this artifact.'],
  ['refused permission to create in its folder', new core.BackendError(403, { errorKey: 'noWriteAccessToFolder' }), 'You do not have permission to save this artifact.'],
  ['refused validation', new core.BackendError(400, { message: 'Validation failed', objects: { validationReport: { errors: [{ location: '/properties/Link', message: 'Invalid default IRI' }] } } }),
    'Request failed (400). Validation failed. Your edits have been kept.'],
]) test(`a new version with ${label} stays on the template with the edits and creates the draft once corrected`, async t => {
  minting(t);
  const h = await host(true, ['en-US'], true, null, true);
  const opened = structuredClone(h.repository.get('template-id'));
  h.designer.currentArtifact = { ...opened.data, 'schema:name': 'Study, revised' };
  h.faults.push({ refused: refusal });
  await saveNewVersion(h);
  // Nothing was stored. The page reports the refusal in the existing words and does not take it for a possible success.
  assert.equal(h.location.pathname, '/templates/edit/template-id');
  assert.equal(h.node('message').textContent, message);
  assert.equal(h.node('state').textContent, refusal.status === 400 ? 'Modified' : 'Reload required');
  assert.equal(h.designer.currentArtifact['schema:name'], 'Study, revised');
  assert.deepEqual(h.repository.get('template-id'), opened);
  assert.deepEqual(successors(h), []);
  assert.equal(h.node('check-save').hidden, true);
  assert.equal(h.node('recheck-access').hidden, refusal.status !== 403);
  assert.equal(h.node('server-issues').hidden, refusal.status !== 400);
  if (refusal.status === 403) { await h.recheck(); assert.equal(h.node('message').textContent.startsWith('Access is restored'), true); }
  else { h.designer.currentArtifact = { ...h.designer.currentArtifact, 'schema:name': 'Study, corrected' }; h.change(); }
  assert.equal(h.node('save').disabled, false);
  await saveNewVersion(h);
  assert.equal(h.location.pathname, `/templates/edit/${UUID}`);
  assert.equal(h.node('state').textContent, 'Saved');
  assert.equal(successors(h).length, 1);
  assert.equal(successors(h)[0].data['@id'], MINTED);
  // Both attempts send the validator the template was opened with, and the one identity minted for the draft.
  assert.deepEqual(versionWrites(h).map(({ url, etag }) => [new URL(url).searchParams.get('draft_id'), etag]), [[MINTED, '"one"'], [MINTED, '"one"']]);
});

// Only the template's owner may create a new version, and the server refuses anyone else with a 403
// under its own key. Nothing was stored and no recovery can lift that refusal, so the page keeps the
// edits and Save and offers no recovery control, as it does for a template the server cannot version.
for (const [label, refusal, message] of [
  ['to anyone but the owner', new core.BackendError(403, { errorKey: 'versioningOnlyByOwner', parameters: { id: 'template-id' } }),
    "Only the template's owner can create a new version. Your edits have been kept."],
  ...['publishOnlyDraft', 'createDraftOnlyFromPublished', 'versioningOnlyOnLatest', 'nonVersionedArtifactType'].map(errorKey =>
    [`as ${errorKey}`, new core.BackendError(400, { errorKey }), 'Request failed (400). Your edits have been kept.']),
]) test(`a new version refused ${label} keeps the edits and Save, and offers no recovery control`, async t => {
  minting(t);
  const h = await host(true, ['en-US'], true, null, true);
  const opened = structuredClone(h.repository.get('template-id'));
  h.designer.currentArtifact = { ...opened.data, 'schema:name': 'Study, revised' };
  h.faults.push({ refused: refusal });
  await saveNewVersion(h);
  assert.equal(h.location.pathname, '/templates/edit/template-id');
  assert.equal(h.node('message').textContent, message);
  assert.equal(h.node('message').dataset.tone, 'error');
  assert.equal(h.node('state').textContent, 'Modified');
  assert.equal(h.node('save').disabled, false);
  assert.deepEqual(shown(h), []);
  assert.equal(h.node('server-issues').hidden, true);
  assert.equal(h.designer.currentArtifact['schema:name'], 'Study, revised');
  assert.deepEqual(h.repository.get('template-id'), opened);
  assert.deepEqual(successors(h), []);
  // The edits are unsaved, so leaving the page still asks first.
  assert.equal(h.unload(), true);
  // Save is offered as it was. Once the server accepts, the draft is created once, under the identity first minted.
  await saveNewVersion(h);
  assert.equal(h.location.pathname, `/templates/edit/${UUID}`);
  assert.equal(h.node('state').textContent, 'Saved');
  assert.equal(successors(h).length, 1);
  assert.deepEqual(versionWrites(h).map(({ url, etag }) => [new URL(url).searchParams.get('draft_id'), etag]), [[MINTED, '"one"'], [MINTED, '"one"']]);
});

test('a new version whose answer is lost sends nothing more until Check save status finds it absent', async t => {
  const uuid = minting(t);
  const h = await host(true, ['en-US'], true, null, true);
  h.designer.currentArtifact = { ...h.repository.get('template-id').data, 'schema:name': 'Study, revised' };
  h.faults.push({ refused: new core.BackendError(500) });
  await saveNewVersion(h);
  assert.match(h.node('message').textContent, /^We could not confirm whether your changes were saved/);
  assert.deepEqual(shown(h), ['check-save']);
  const before = h.requests.length;
  await h.save();
  assert.equal(h.requests.length, before, 'a second save sends no further request');
  await h.check();
  assert.deepEqual(h.requests.slice(before).map(({ method, url }) => `${method} ${new URL(url).pathname}`).sort(), [
    `GET /templates/${UUID}`, 'GET /templates/template-id', 'GET /templates/template-id/report']);
  assert.equal(h.node('message').textContent, 'Not saved. Your changes remain in the designer.');
  assert.deepEqual(shown(h), []);
  assert.equal(h.node('save').disabled, false);
  await saveNewVersion(h);
  assert.equal(h.location.pathname, `/templates/edit/${UUID}`);
  assert.equal(successors(h).length, 1);
  assert.equal(uuid.mock.callCount(), 1, 'the retry reuses the identity');
});

for (const later of [false, true]) test(`a new version that committed although its answer was lost opens the draft, later edits=${later}`, async t => {
  minting(t);
  const h = await host(true, ['en-US'], true, null, true);
  h.designer.currentArtifact = { ...h.repository.get('template-id').data, 'schema:name': 'Study, revised' };
  h.faults.push({ committed: new core.BackendError(0) });
  await saveNewVersion(h);
  assert.deepEqual(shown(h), ['check-save']);
  if (later) { h.designer.currentArtifact = { ...h.designer.currentArtifact, 'schema:name': 'Study, later' }; h.change(); }
  await h.check();
  assert.equal(h.location.pathname, `/templates/edit/${UUID}`);
  assert.equal(h.node('message').textContent, 'The stored version matches your submitted changes. Your current edits have been kept.');
  assert.equal(h.node('state').textContent, later ? 'Modified' : 'Saved');
  assert.equal(h.designer.currentArtifact['schema:name'], later ? 'Study, later' : 'Study, revised');
  assert.deepEqual(shown(h), []);
  assert.equal(h.repository.get('template-id').data['bibo:status'], 'bibo:published');
  if (!later) return;
  const before = h.requests.length;
  await h.save();
  assert.deepEqual(h.requests.slice(before), [
    { method: 'POST', url: `https://resource.example/command/check-update-template/${UUID}` },
    { method: 'PUT', url: `https://resource.example/templates/${UUID}`, etag: '"1"' },
  ]);
  assert.equal(successors(h).length, 1);
  assert.equal(successors(h)[0].data['schema:name'], 'Study, later');
});

for (const later of [false, true]) test(`a create that committed although its answer was lost opens at its edit address, later edits=${later}`, async t => {
  minting(t);
  const h = await host(true, ['en-US'], false, null, true);
  h.designer.currentArtifact = { 'schema:name': 'Study' };
  h.faults.push({ committed: new core.BackendError(0) });
  await h.save();
  assert.match(h.node('message').textContent, /^We could not confirm whether your changes were saved/);
  assert.equal(h.node('state').textContent, 'Reload required');
  assert.deepEqual(shown(h), ['check-save']);
  if (later) { h.designer.currentArtifact = { 'schema:name': 'Study, later' }; h.change(); }
  await h.check();
  assert.equal(h.location.pathname, `/templates/edit/${UUID}`);
  assert.equal(h.node('message').textContent, 'The stored version matches your submitted changes. Your current edits have been kept.');
  assert.equal(h.node('state').textContent, later ? 'Modified' : 'Saved');
  assert.deepEqual(shown(h), []);
  if (!later) assert.deepEqual(h.designer.loads.at(-1), h.repository.get(UUID).data);
  const before = h.requests.length;
  h.designer.currentArtifact = { ...h.designer.currentArtifact, 'schema:name': 'Study, final' }; h.change();
  await h.save();
  assert.deepEqual(h.requests.slice(before).slice(-1), [{ method: 'PUT', url: `https://resource.example/templates/${UUID}`, etag: '"1"' }]);
  assert.equal(h.repository.get(UUID).data['schema:name'], 'Study, final');
  assert.equal(h.repository.get(UUID).data['pav:createdOn'], 'now', 'the update is applied to what was stored');
  assert.deepEqual([...h.repository.keys()], [UUID]);
});

test('a create absent after a lost answer saves again under the same identity', async t => {
  const uuid = minting(t);
  const h = await host(true, ['en-US'], false, null, true);
  h.designer.currentArtifact = { 'schema:name': 'Study' };
  h.faults.push({ refused: new core.BackendError(503) });
  await h.save();
  assert.equal(h.node('save').disabled, true);
  await h.check();
  assert.equal(h.node('message').textContent, 'Not saved. Your changes remain in the designer.');
  assert.equal(h.node('message').dataset.tone, 'info');
  assert.equal(h.node('state').textContent, 'Modified');
  assert.deepEqual(shown(h), []);
  await h.save();
  assert.equal(h.node('state').textContent, 'Saved');
  assert.equal(h.location.pathname, `/templates/edit/${UUID}`);
  assert.deepEqual(h.requests.filter(({ method }) => method === 'PUT').map(({ url }) => url),
    [`https://resource.example/templates/${UUID}?folder_id=folder-id`, `https://resource.example/templates/${UUID}?folder_id=folder-id`]);
  assert.equal(uuid.mock.callCount(), 1);
});

test('a create refused as occupied is checked, never taken for success or failure', async t => {
  minting(t);
  const h = await host(true, ['en-US'], false, null, true);
  h.designer.currentArtifact = { 'schema:name': 'Study, extended' };
  // An earlier attempt under this identity committed with less content, so the repeat answers 428.
  const earlier = { 'schema:name': 'Study', '@id': MINTED, 'pav:version': '0.0.1', 'bibo:status': 'bibo:draft' };
  h.repository.set(UUID, { data: earlier, etag: '"7"' });
  await h.save();
  assert.match(h.node('message').textContent, /^We could not confirm whether your changes were saved/);
  assert.deepEqual(shown(h), ['check-save']);
  const before = h.requests.length;
  await h.check();
  // The identity is adopted, but the designer keeps its own content rather than the earlier attempt's,
  // and the artifact must be reloaded before another save, as a new artifact the designer has not adopted is.
  assert.equal(h.location.pathname, `/templates/edit/${UUID}`);
  assert.equal(h.node('message').textContent, 'Saved as a new artifact. Further changes remain here; reload the saved artifact before saving again.');
  assert.equal(h.node('state').textContent, 'Reload required');
  assert.equal(h.designer.currentArtifact['schema:name'], 'Study, extended');
  assert.deepEqual(shown(h), ['reload']);
  assert.equal(h.node('save').disabled, true);
  assert.deepEqual(h.requests.slice(before).filter(({ method }) => method !== 'GET'), []);
  assert.deepEqual(h.repository.get(UUID).data, earlier);
  // The designer's content is unsaved, so leaving the page still asks first.
  assert.equal(h.unload(), true);
});

for (const [label, answer, message] of [
  ['refused for the session', new core.BackendError(401), 'Your session has expired. Sign in again before saving.'],
  ['refused', new core.BackendError(403), 'Save status could not be checked. Your edits have been kept. Check your connection and access, then try again.'],
  ['unavailable', new core.BackendError(503), 'Save status could not be checked. Your edits have been kept. Check your connection and access, then try again.'],
]) test(`a create whose check is ${label} stays blocked and can be checked again`, async t => {
  minting(t);
  const h = await host(true, ['en-US'], false, null, true);
  h.designer.currentArtifact = { 'schema:name': 'Study' };
  h.faults.push({ refused: new core.BackendError(0) });
  await h.save();
  h.repository.set(UUID, answer);
  await h.check();
  assert.equal(h.node('message').textContent, message);
  assert.equal(h.node('save').disabled, true);
  assert.deepEqual(shown(h), answer.status === 401 ? ['check-save', 'sign-in-again'] : ['check-save']);
  h.repository.delete(UUID);
  await h.check();
  assert.equal(h.node('message').textContent, 'Not saved. Your changes remain in the designer.');
  assert.deepEqual(shown(h), []);
});
