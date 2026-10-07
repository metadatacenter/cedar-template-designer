import {iconSvg} from '../components/icons.js';
document.getElementById('back-icon').innerHTML = iconSvg('back');
// Workspace heads its Create Draft dialog with this icon, and this dialog also ends in a new draft.
document.getElementById('version-icon').innerHTML = iconSvg('new-record');
const version = encodeURIComponent(window.cedarCacheControl || 'local');
const { resourceSelector, resourcePathId, useDeploymentApi, routeFor, workspaceReturn, canEdit, canCreate, createBackend, openingMessage, childSource, saveArtifact, DesignerCoordinator, waitForDesigner } = await import(`./host-core.mjs?v=${version}`);
// host-core.mjs imports this same versioned URL, so both modules share one active language.
const { t, counted, detectLanguage, setLanguage, localizeDocument } = await import(`./i18n.mjs?v=${version}`);
const language = setLanguage(detectLanguage(navigator.languages));
localizeDocument(document);
const ui = Object.fromEntries(['back', 'save', 'save-help', 'title', 'state', 'message', 'editor', 'version-dialog', 'version-message', 'version-explanation', 'reload', 'server-issues', 'server-issues-title', 'server-issues-list'].map(id => [id, document.getElementById(id)]));
const state = new DesignerCoordinator();
let designer, leaving = false, discarded = false, returnUrl, route, saved = false, folderId, request, config;
// The stored artifact is one the designer cannot read, so reloading it cannot help.
let unreadable = false;
function message(text, error = false) { ui.message.textContent = text; ui.message.dataset.tone = error ? 'error' : 'info'; }
function dirty() { return !leaving && state.dirty(designer); }
function update() {
  const report = state.report(designer);
  ui.save.disabled = !report.canSave;
  ui.reload.hidden = !(state.loadFailed || state.reloadRequired) || state.uncertainCreation || unreadable;
  ui.reload.disabled = state.saving;
  ui['server-issues'].hidden = !report.server.length;
  ui['server-issues-title'].textContent = counted('Message.ServerFindings', report.server.length);
  ui['server-issues-list'].replaceChildren();
  for (const issue of report.server) {
    const row = document.createElement('li');
    row.textContent = `${issue.location || '/'}: ${issue.message}`;
    ui['server-issues-list'].append(row);
  }
  // While the designer lists errors, Save says why it is refused. An error it holds back, such as a name nobody has touched, is not yet one to point at.
  const blocked = state.writable && !state.saving && Boolean(report.issues.some(issue => issue.shown && issue.severity !== 'warning'));
  ui['save-help'].dataset.blocked = String(blocked);
  if (blocked) ui.save.setAttribute('aria-describedby', 'save-tooltip');
  else ui.save.removeAttribute('aria-describedby');
  ui.state.dataset.saveState = String(!state.saving && state.writable);
  ui.state.dataset.dirty = String(!state.saving && state.writable && dirty());
  // Until it is edited, an artifact is unmodified, whether read from the server or new; only a save made here is reported as saved.
  ui.state.textContent = t(state.loadFailed ? 'State.LoadFailed' : !state.ready ? 'Page.Loading' : state.reloadRequired ? 'State.ReloadRequired' : state.saving ? 'State.Saving' : !state.writable ? 'State.ReadOnly' : dirty() ? 'State.Modified' : saved ? 'State.Saved' : 'State.Unmodified');
  if (designer) designer.inert = !state.writable || state.saving;
}
window.addEventListener('pagehide', () => state.dispose());
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
window.addEventListener('beforeunload', event => {
  if (!leaving && (dirty() || state.saving)) { event.preventDefault(); event.returnValue = ''; }
});
function leave() {
  leaving = true;
  location.assign(returnUrl);
}
function artifactUrl() { return `${config.resourceRestAPI}/${route.collection}/${encodeURIComponent(resourcePathId(route.id))}`; }
/**
 * Open what a save stored in place of the document it submitted, as reopening the page would. A write
 * can assign the identity, lifecycle metadata and child identifiers, and the next save must update the
 * stored artifact rather than resubmit the draft. When the stored artifact cannot be adopted, nothing
 * changes and the answer is false.
 */
async function reopen(attempt) {
  let loaded;
  try { loaded = await request(artifactUrl()); } catch { return false; }
  const id = loaded?.data?.['@id'];
  if (!attempt.current() || typeof id !== 'string' || resourcePathId(id) !== resourcePathId(route.id) || !state.matches(attempt, designer)) return false;
  try { designer.loadArtifact(loaded.data); } catch { return false; }
  state.loaded({ artifact: loaded.data, etag: loaded.etag, writable: state.writable });
  state.reloadRequired = !loaded.etag;
  return true;
}
ui.back.addEventListener('click', () => {
  if (!returnUrl || state.saving || (dirty() && !window.confirm(t('Message.ConfirmDiscard')))) return;
  leave();
});
ui.reload.addEventListener('click', () => {
  if (state.saving || state.uncertainCreation || (dirty() && !window.confirm(t('Message.ConfirmReload')))) return;
  leaving = true; location.reload();
});
function confirmVersion(impact) {
  const count = impact.numberOfInstances;
  const ofVersion = impact.oldVersion ? 'OfVersion' : '';
  const params = { count, version: impact.oldVersion };
  // An unknown count has a message of its own, which names no number.
  ui['version-message'].textContent = count == null
    ? t(`Version.ExistingInstances${ofVersion}`, params)
    : counted(`Version.Instances${ofVersion}`, count, params);
  ui['version-explanation'].textContent = t(`Version.Explanation${impact.oldVersion ? 'OfVersion' : ''}`, { version: impact.oldVersion });
  const dialog = ui['version-dialog'];
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      // Discarding returns the designer to the template as it was opened, and stays in the designer.
      discarded = dialog.returnValue === 'discard';
      if (discarded) designer.loadArtifact(structuredClone(state.stored));
      resolve(dialog.returnValue === 'confirm');
    }, { once: true });
    dialog.showModal();
  });
}
ui.save.addEventListener('click', async () => {
  let attempt;
  try {
    attempt = state.beginSave(designer);
    if (!attempt) return;
    update(); message(t('State.Saving'));
    const result = await saveArtifact({ request, base: config.resourceRestAPI, route,
      artifact: attempt.artifact, etag: state.etag, folderId, confirmVersion,
      stillCurrent: () => state.matches(attempt, designer) });
    if (!attempt.current()) return;
    if (!result) { message(t(discarded ? 'Message.ChangesDiscarded' : 'Message.ChangesKept')); return; }
    if (!result.data || typeof result.data['@id'] !== 'string' || !result.data['@id'].trim()) {
      state.reloadRequired = true; state.uncertainCreation = !route.id;
      throw new Error(t('Error.SaveUnconfirmed'));
    }
    saved = true;
    // A successful save stays in Designer. A new artifact or draft takes its own edit address.
    const newIdentity = route.id !== result.data['@id'];
    route.id = result.data['@id'];
    const address = new URL(location.href);
    address.pathname = `/${route.kind}s/edit/${encodeURIComponent(resourcePathId(route.id))}`;
    window.history.replaceState(null, '', address.href);
    if (state.matches(attempt, designer) && await reopen(attempt)) {
      message(state.reloadRequired ? t('Error.NoValidator') : '', state.reloadRequired);
      return;
    }
    if (!attempt.current()) return;
    // Edits made during the save stay in the designer, which then holds a document the server has not
    // stored. A reload must adopt what the server assigned before another save: always when the save
    // created an artifact or draft, and when an unedited document could not be reopened.
    const edited = !state.matches(attempt, designer);
    state.committed(attempt, result.etag, newIdentity || !edited);
    message(edited ? t(newIdentity ? 'Message.SavedNewIdentity' : 'Message.SavedWithChanges') + (!result.etag ? ' ' + t('Error.NoValidator') : '') : t('Message.SavedReloadRequired'), state.reloadRequired);
  } catch (error) {
    if (attempt && !attempt.current()) return;
    state.failed(error, attempt); message(error.message, true);
  } finally { state.finish(attempt); update(); }
});
async function loadScript(name, digest) {
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `components/${name}.js?v=${digest}`;
    const timer = setTimeout(() => fail(), 30000);
    const fail = () => { clearTimeout(timer); script.onload = null; script.onerror = null; script.remove?.(); reject(new Error(t('Error.ComponentLoad', { name }))); };
    script.onload = () => { clearTimeout(timer); script.onload = null; script.onerror = null; resolve(); };
    script.onerror = fail;
    document.head.append(script);
  });
}
/** A file the page needs before it can open, read whole or refused with the reason given. */
async function readJson(url, failure, options) {
  let response;
  try { response = await fetch(url, options); } catch { throw new Error(t('Error.Unreachable')); }
  if (!response.ok) throw new Error(t(failure));
  try { return await response.json(); } catch { throw new Error(t(failure)); }
}
try {
  config = await readJson(`config/host.json?v=${version}`, 'Error.ConfigurationLoad');
  useDeploymentApi(config.resourceRestAPI);
  const params = new URLSearchParams(location.search);
  folderId = params.get('folderId');
  returnUrl = workspaceReturn(config.workspaceFrontend, params.get('returnTo'), folderId);
  route = routeFor(location.pathname === '/' ? '/templates/create' : location.pathname);
  const auth = new window.KeycloakUserHandler();
  const authenticated = await new Promise((resolve, reject) => auth.initUserHandler(resolve, () => reject(new Error(t('Error.SignIn')))));
  if (!authenticated) { auth.doLogin(); } else {
    request = createBackend(auth, crypto.randomUUID());
    const { data: profile } = await request(`${config.userRestAPI}/users/${encodeURIComponent(auth.getParsedToken().sub)}`);
    folderId ||= profile.homeFolderId;
    const manifest = await readJson(`components/manifest.json?v=${version}`, 'Error.ManifestLoad', { cache: 'no-store' });
    for (const name of ['cedar-embeddable-editor', 'cedar-embeddable-term-picker', 'cedar-embeddable-designer']) {
      const digest = manifest?.[name]?.sha256;
      if (typeof digest !== 'string') throw new Error(t('Error.ComponentLoad', { name }));
      await loadScript(name, digest);
    }
    const elementName = route.kind === 'field' ? 'cedar-embeddable-field-designer' : 'cedar-embeddable-designer';
    await waitForDesigner(customElements);
    if (!customElements.get(elementName)) throw new Error(t('Error.MissingFieldDesigner'));
    designer = document.createElement(elementName);
    // CED reads the host's language before it renders. A CED build without the property ignores it.
    designer.language = language;
    // Suppress authoring UI (including the field chooser) until loading and permissions finish.
    designer.readOnly = true;
    designer.config = { terminologyBaseUrl: config.terminologyBaseUrl, bridgeBaseUrl: config.bridgeBaseUrl };
    designer.childSource = childSource(request, config.resourceRestAPI);
    // Connecting initializes Angular's public methods. Keep the editor inert until load and permissions succeed.
    designer.inert = true;
    ui.editor.hidden = true;
    ui.editor.append(designer);
    if (typeof designer.loadArtifact !== 'function') throw new Error(t('Error.OutdatedBundle'));
    if (route.id) {
      const url = artifactUrl();
      const [loaded, report] = await Promise.all([request(url), request(`${url}/report`)]);
      if (!loaded.data || resourcePathId(loaded.data['@id']) !== resourcePathId(route.id)) throw new Error(t('Error.InvalidArtifact'));
      route.id = loaded.data['@id']; // Keep the stored identity for subsequent PUT bodies.
      try {
        designer.loadArtifact(loaded.data);
      } catch (error) {
        // The reader refuses an artifact it cannot read, such as one whose child is stored under a
        // reserved key, and says why in its own words, which name the place in the artifact.
        unreadable = true;
        throw new Error(t('Error.Unreadable', { detail: error.message }));
      }
      state.loaded({ artifact: loaded.data, etag: loaded.etag, writable: canEdit(report.data, loaded.data) });
      if (state.writable && !loaded.etag) { state.reloadRequired = true; message(t('Error.NoValidator'), true); }
    } else {
      if (!folderId) throw new Error(t('Error.NoFolder'));
      const {data: folder} = await request(`${config.resourceRestAPI}/folders/${encodeURIComponent(resourcePathId(folderId))}`);
      designer.newArtifact(route.kind === 'field' ? undefined : route.kind);
      state.loaded({writable: canCreate(folder)});
    }
    designer.readOnly = !state.writable;
    ui.editor.hidden = false;
    for (const event of ['artifactChange', 'validationChange', 'dirtyChange']) designer.addEventListener(event, update);
    ui.title.textContent = t(`Header.Title.${route.kind}`);
    if (!state.reloadRequired) message(state.writable ? '' : t('Message.ReadOnly'));
    update();
  }
} catch (error) {
  ui.editor.replaceChildren();
  designer = null;
  state.failLoad();
  update();
  message(openingMessage(error, !route?.id), true);
}
