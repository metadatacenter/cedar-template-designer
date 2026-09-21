import {iconSvg} from '../components/icons.js';
document.getElementById('back-icon').innerHTML = iconSvg('back');
const version = encodeURIComponent(window.cedarCacheControl || 'local');
const { routeFor, workspaceReturn, canEdit, createBackend, childSource, saveArtifact } = await import(`./host-core.mjs?v=${version}`);
const ui = Object.fromEntries(['back', 'save', 'title', 'state', 'message', 'editor', 'version-dialog', 'version-message'].map(id => [id, document.getElementById(id)]));
let designer, writable = false, saving = false, leaving = false, returnUrl, route, etag, folderId, request, config;
function message(text, error = false) { ui.message.textContent = text; ui.message.dataset.error = String(error); }
function dirty() { return !leaving && Boolean(designer?.isDirty); }
function update() {
  ui.save.disabled = !writable || saving || !designer?.canSave;
  ui.state.dataset.dirty = String(!saving && writable && dirty());
  ui.state.textContent = saving ? 'Saving…' : !writable ? 'Read only' : dirty() ? 'Unsaved changes' : 'No unsaved changes';
  if (designer) designer.inert = !writable || saving;
}
window.addEventListener('beforeunload', event => {
  if (dirty() || saving) { event.preventDefault(); event.returnValue = ''; }
});
ui.back.addEventListener('click', () => {
  if (!returnUrl || saving || (dirty() && !window.confirm('Discard your unsaved changes and return to Workspace?'))) return;
  leaving = true;
  location.assign(returnUrl);
});
function confirmVersion(impact) {
  ui['version-message'].textContent = `${impact.numberOfInstances ?? 'Existing'} metadata instances use this template${impact.oldVersion ? ` (version ${impact.oldVersion})` : ''}. These changes require a new version.`;
  const dialog = ui['version-dialog'];
  dialog.returnValue = 'cancel';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}
ui.save.addEventListener('click', async () => {
  if (!writable || saving || !designer?.validate().canSave) return;
  saving = true;
  update();
  message('Saving…');
  try {
    const result = await saveArtifact({ request, base: config.resourceRestAPI, route,
      artifact: designer.currentArtifact, etag, folderId, confirmVersion });
    if (!result) { message('Your changes are still here.'); return; }
    leaving = true;
    location.assign(returnUrl);
  } catch (error) {
    message(error.message, true);
  } finally { saving = false; update(); }
});
async function loadScript(name, digest) {
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `components/${name}.js?v=${digest}`;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${name}. Rebuild and stage the local components.`));
    document.head.append(script);
  });
}
try {
  config = await fetch(`config/host.json?v=${version}`).then(response => {
    if (!response.ok) throw new Error('Frontend configuration could not be loaded.');
    return response.json();
  });
  const params = new URLSearchParams(location.search);
  folderId = params.get('folderId');
  returnUrl = workspaceReturn(config.workspaceFrontend, params.get('returnTo'), folderId);
  route = routeFor(location.pathname === '/' ? '/templates/create' : location.pathname);
  const auth = new window.KeycloakUserHandler();
  const authenticated = await new Promise((resolve, reject) => auth.initUserHandler(resolve, () => reject(new Error('Sign-in could not be initialized. Reload to try again.'))));
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
    if (!customElements.get(elementName)) throw new Error('This Designer bundle does not include CEFD. Stage a current CED bundle and reload.');
    designer = document.createElement(elementName);
    designer.config = { terminologyBaseUrl: config.terminologyBaseUrl, bridgeBaseUrl: config.bridgeBaseUrl };
    designer.childSource = childSource(request, config.resourceRestAPI);
    // Connecting initializes Angular's public methods. Keep the editor inert until load and permissions succeed.
    designer.inert = true;
    ui.editor.hidden = true;
    ui.editor.append(designer);
    if (typeof designer.loadArtifact !== 'function') throw new Error('The local CED bundle is out of date. Rebuild CED and restart Designer.');
    if (route.id) {
      const url = `${config.resourceRestAPI}/${route.collection}/${encodeURIComponent(route.id)}`;
      const [loaded, report] = await Promise.all([request(url), request(`${url}/report`)]);
      designer.loadArtifact(loaded.data);
      etag = loaded.etag;
      writable = canEdit(report.data, loaded.data);
    } else {
      designer.newArtifact(route.kind === 'field' ? undefined : route.kind);
      writable = true;
    }
    ui.editor.hidden = false;
    for (const event of ['artifactChange', 'validationChange', 'dirtyChange']) designer.addEventListener(event, update);
    ui.title.textContent = route.id ? `Edit ${route.kind}` : `New ${route.kind}`;
    message(writable ? '' : 'This artifact is read only. Create a draft or change permissions in Workspace to edit it.');
    update();
  }
} catch (error) {
  ui.editor.replaceChildren();
  designer = null;
  writable = false;
  update();
  message(error.message, true);
}
