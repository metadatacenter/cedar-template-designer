import {iconSvg} from '../components/icons.js';
document.getElementById('back-icon').innerHTML = iconSvg('back');
// Workspace heads its Create Draft dialog with this icon, and this dialog also ends in a new draft.
document.getElementById('version-icon').innerHTML = iconSvg('new-record');
const version = encodeURIComponent(window.cedarCacheControl || 'local');
const { routeFor, workspaceReturn, canEdit, createBackend, childSource, saveArtifact } = await import(`./host-core.mjs?v=${version}`);
// host-core.mjs imports this same versioned URL, so both modules share one active language.
const { t, detectLanguage, setLanguage, localizeDocument } = await import(`./i18n.mjs?v=${version}`);
const language = setLanguage(detectLanguage(navigator.languages));
localizeDocument(document);
const ui = Object.fromEntries(['back', 'save', 'save-help', 'title', 'state', 'message', 'editor', 'version-dialog', 'version-message', 'version-explanation'].map(id => [id, document.getElementById(id)]));
let designer, writable = false, saving = false, leaving = false, discarded = false, returnUrl, route, saved = false, etag, folderId, request, config, stored;
function message(text, error = false) { ui.message.textContent = text; ui.message.dataset.tone = error ? 'error' : 'info'; }
function dirty() { return !leaving && Boolean(designer?.isDirty); }
function update() {
  ui.save.disabled = !writable || saving || !designer?.canSave;
  // While the designer lists errors, Save says why it is refused. An error it holds back, such as a name nobody has touched, is not yet one to point at.
  const blocked = writable && !saving && Boolean(designer?.validationReport?.issues.some(issue => issue.shown));
  ui['save-help'].dataset.blocked = String(blocked);
  if (blocked) ui.save.setAttribute('aria-describedby', 'save-tooltip');
  else ui.save.removeAttribute('aria-describedby');
  ui.state.dataset.saveState = String(!saving && writable);
  ui.state.dataset.dirty = String(!saving && writable && dirty());
  // Until it is edited, an artifact is unmodified, whether read from the server or new; only a save made here is reported as saved.
  ui.state.textContent = t(saving ? 'State.Saving' : !writable ? 'State.ReadOnly' : dirty() ? 'State.Modified' : saved ? 'State.Saved' : 'State.Unmodified');
  if (designer) designer.inert = !writable || saving;
}
window.addEventListener('beforeunload', event => {
  if (!leaving && (dirty() || saving)) { event.preventDefault(); event.returnValue = ''; }
});
function leave() {
  leaving = true;
  location.assign(returnUrl);
}
ui.back.addEventListener('click', () => {
  if (!returnUrl || saving || (dirty() && !window.confirm(t('Message.ConfirmDiscard')))) return;
  leave();
});
function confirmVersion(impact) {
  const key = `Version.${impact.numberOfInstances == null ? 'ExistingInstances' : 'Instances'}${impact.oldVersion ? 'OfVersion' : ''}`;
  ui['version-message'].textContent = t(key, { count: impact.numberOfInstances, version: impact.oldVersion });
  ui['version-explanation'].textContent = t(`Version.Explanation${impact.oldVersion ? 'OfVersion' : ''}`, { version: impact.oldVersion });
  const dialog = ui['version-dialog'];
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      // Discarding returns the designer to the template as it was opened, and stays in the designer.
      discarded = dialog.returnValue === 'discard';
      if (discarded) designer.loadArtifact(structuredClone(stored));
      resolve(dialog.returnValue === 'confirm');
    }, { once: true });
    dialog.showModal();
  });
}
ui.save.addEventListener('click', async () => {
  if (!writable || saving || !designer?.validate().canSave) return;
  saving = true;
  update();
  message(t('State.Saving'));
  try {
    const result = await saveArtifact({ request, base: config.resourceRestAPI, route,
      artifact: designer.currentArtifact, etag, folderId, confirmVersion });
    if (!result) { message(t(discarded ? 'Message.ChangesDiscarded' : 'Message.ChangesKept')); return; }
    saved = true;
    leave();
  } catch (error) {
    message(error.message, true);
  } finally { saving = false; update(); }
});
async function loadScript(name, digest) {
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `components/${name}.js?v=${digest}`;
    script.onload = resolve;
    script.onerror = () => reject(new Error(t('Error.ComponentLoad', { name })));
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
    folderId ||= profile.homeFolderId;
    const manifest = await fetch(`components/manifest.json?v=${version}`, { cache: 'no-store' }).then(response => response.json());
    for (const name of ['cedar-embeddable-editor', 'cedar-embeddable-term-picker', 'cedar-embeddable-designer']) {
      await loadScript(name, manifest[name].sha256);
    }
    const elementName = route.kind === 'field' ? 'cedar-embeddable-field-designer' : 'cedar-embeddable-designer';
    await customElements.whenDefined('cedar-embeddable-designer');
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
      const url = `${config.resourceRestAPI}/${route.collection}/${encodeURIComponent(route.id)}`;
      const [loaded, report] = await Promise.all([request(url), request(`${url}/report`)]);
      stored = structuredClone(loaded.data);
      designer.loadArtifact(loaded.data);
      etag = loaded.etag;
      writable = canEdit(report.data, loaded.data);
    } else {
      designer.newArtifact(route.kind === 'field' ? undefined : route.kind);
      writable = true;
    }
    designer.readOnly = !writable;
    ui.editor.hidden = false;
    for (const event of ['artifactChange', 'validationChange', 'dirtyChange']) designer.addEventListener(event, update);
    ui.title.textContent = t(`Header.Title.${route.kind}`);
    message(writable ? '' : t('Message.ReadOnly'));
    update();
  }
} catch (error) {
  ui.editor.replaceChildren();
  designer = null;
  writable = false;
  update();
  message(error.message, true);
}
