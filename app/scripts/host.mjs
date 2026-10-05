import {iconSvg} from '../components/icons.js';
document.getElementById('back-icon').innerHTML = iconSvg('back');
// Workspace heads its Create Draft dialog with this icon, and this dialog also ends in a new draft.
document.getElementById('version-icon').innerHTML = iconSvg('new-record');
const version = encodeURIComponent(window.cedarCacheControl || 'local');
const { resourceSelector, resourcePathId, useDeploymentBase, routeFor, workspaceReturn, canEdit, canCreate, createBackend, childSource, saveArtifact, DesignerCoordinator, waitForDesigner } = await import(`./host-core.mjs?v=${version}`);
// host-core.mjs imports this same versioned URL, so both modules share one active language.
const { t, detectLanguage, setLanguage, localizeDocument } = await import(`./i18n.mjs?v=${version}`);
const language = setLanguage(detectLanguage(navigator.languages));
localizeDocument(document);
const ui = Object.fromEntries(['back', 'save', 'save-help', 'title', 'state', 'message', 'editor', 'version-dialog', 'version-message', 'version-explanation', 'reload', 'server-issues', 'server-issues-title', 'server-issues-list'].map(id => [id, document.getElementById(id)]));
const state = new DesignerCoordinator();
let designer, leaving = false, discarded = false, returnUrl, route, saved = false, folderId, request, config;
function message(text, error = false) { ui.message.textContent = text; ui.message.dataset.tone = error ? 'error' : 'info'; }
function dirty() { return !leaving && state.dirty(designer); }
function update() {
  const report = state.report(designer);
  ui.save.disabled = !report.canSave;
  ui.reload.hidden = !(state.loadFailed || state.reloadRequired) || state.uncertainCreation;
  ui.reload.disabled = state.saving;
  ui['server-issues'].hidden = !report.server.length;
  ui['server-issues-title'].textContent = t('Message.ServerFindings', {count: report.server.length});
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
  const counted = count == null ? 'ExistingInstances' : count === 1 ? 'OneInstance' : 'Instances';
  const key = `Version.${counted}${impact.oldVersion ? 'OfVersion' : ''}`;
  ui['version-message'].textContent = t(key, { count: impact.numberOfInstances, version: impact.oldVersion });
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
    if (!state.matches(attempt, designer)) {
      const newIdentity = route.id !== result.data['@id'];
      // A new draft has server-owned version metadata that the open document has not adopted.
      state.committed(attempt, result.etag, newIdentity);
      route.id = result.data['@id'];
      const address = new URL(location.href);
      address.pathname = `/${route.kind}s/edit/${encodeURIComponent(resourcePathId(route.id))}`;
      window.history.replaceState(null, '', address.href);
      message(t(newIdentity ? 'Message.SavedNewIdentity' : 'Message.SavedWithChanges') + (!result.etag ? ' ' + t('Error.NoValidator') : ''), state.reloadRequired);
      return;
    }
    leave();
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
try {
  config = await fetch(`config/host.json?v=${version}`).then(response => {
    if (!response.ok) throw new Error(t('Error.ConfigurationLoad'));
    return response.json();
  });
  const params = new URLSearchParams(location.search);
  folderId = params.get('folderId');
  returnUrl = workspaceReturn(config.workspaceFrontend, params.get('returnTo'), folderId);
  route = routeFor(location.pathname === '/' ? '/templates/create' : location.pathname);
  const auth = new window.KeycloakUserHandler();
  const authenticated = await new Promise((resolve, reject) => auth.initUserHandler(resolve, () => reject(new Error(t('Error.SignIn')))));
  if (!authenticated) { auth.doLogin(); } else {
    request = createBackend(auth, crypto.randomUUID());
    const { data: profile } = await request(`${config.userRestAPI}/users/${encodeURIComponent(auth.getParsedToken().sub)}`);
    // The home folder is an identity this deployment minted, so it names the base to shorten against.
    useDeploymentBase(profile.homeFolderId);
    folderId ||= profile.homeFolderId;
    const manifest = await fetch(`components/manifest.json?v=${version}`, { cache: 'no-store' }).then(response => response.json());
    for (const name of ['cedar-embeddable-editor', 'cedar-embeddable-term-picker', 'cedar-embeddable-designer']) {
      await loadScript(name, manifest[name].sha256);
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
      const url = `${config.resourceRestAPI}/${route.collection}/${encodeURIComponent(resourcePathId(route.id))}`;
      const [loaded, report] = await Promise.all([request(url), request(`${url}/report`)]);
      if (!loaded.data || resourcePathId(loaded.data['@id']) !== resourcePathId(route.id)) throw new Error(t('Error.InvalidArtifact'));
      route.id = loaded.data['@id']; // Keep the stored identity for subsequent PUT bodies.
      designer.loadArtifact(loaded.data);
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
  message(error.message, true);
}
