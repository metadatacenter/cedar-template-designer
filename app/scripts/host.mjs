import { JsonSourcePolicy, TextPolicy } from './json-policy.mjs';
import {iconSvg} from '../components/icons.js';
document.getElementById('back-icon').innerHTML = iconSvg('back');
// Workspace heads its Create Draft dialog with this icon, and this dialog also ends in a new draft.
document.getElementById('version-icon').innerHTML = iconSvg('new-record');
const version = encodeURIComponent(window.cedarCacheControl || 'local');
const { resourceSelector, resourcePathId, useDeploymentApi, mintIdentity, routeFor, workspaceReturn, canEdit, canCreate, createBackend, openingMessage, saveMessage, childSource, saveArtifact, DesignerCoordinator, waitForDesigner } = await import(`./host-core.mjs?v=${version}`);
const { DesignerDraftStore, draftScope, discardable } = await import(`./host-draft.mjs?v=${version}`);
// host-core.mjs imports this same versioned URL, so both modules share one active language.
const { t, counted, detectLanguage, setLanguage, localizeDocument } = await import(`./i18n.mjs?v=${version}`);
const language = setLanguage(detectLanguage(navigator.languages));
localizeDocument(document);
const ui = Object.fromEntries(['back', 'save', 'save-help', 'title', 'state', 'message', 'editor', 'version-dialog', 'version-message', 'version-explanation', 'reload', 'check-save', 'recheck-access', 'server-issues', 'server-issues-title', 'server-issues-list', 'draft-offer', 'restore-draft', 'discard-draft', 'draft-storage-error', 'sign-in-again'].map(id => [id, document.getElementById(id)]));
const state = new DesignerCoordinator();
let designer, leaving = false, discarded = false, returnUrl, route, saved = false, folderId, request, config, auth, draftStore, offeredDraft;
// The stored artifact is one the designer cannot read, so reloading it cannot help.
let unreadable = false, openingAccessRefused = false, forwardedFindings;
// The read that settles a lost create or new version was refused for the session.
let creationCheckSignedOut = false;
function message(text, error = false) { ui.message.textContent = text; ui.message.dataset.tone = error ? 'error' : 'info'; }
function dirty() { return !leaving && state.dirty(designer); }
// A new field opens its type chooser as a dialog over the whole page, which would cover the offer of a
// retained draft and leave neither Restore nor Discard reachable. The chooser waits for that decision.
function choiceWouldCoverOffer() { return route?.kind === 'field' && !route.id && Boolean(offeredDraft); }
function canRecheckOpeningAccess() {
  return !offeredDraft && !dirty() && ((state.loadFailed && openingAccessRefused) ||
    (state.ready && !state.writable && !state.reloadRequired));
}
function keepDraft(attempt) {
  if (leaving || !draftStore || !designer || offeredDraft || !state.ready || (state.saving && !attempt?.write) || typeof designer.captureDraft !== 'function') return;
  try {
    if (dirty() || state.reloadRequired || attempt?.write) draftStore.write(draftStore.capture(designer, state, attempt));
    else draftStore.clear();
    ui['draft-storage-error'].hidden = true;
  } catch { ui['draft-storage-error'].hidden = false; }
}
function clearDraft() {
  try { draftStore?.clear(); offeredDraft = null; } catch { ui['draft-storage-error'].hidden = false; }
}
function selectDraftStore() {
  const previous = draftStore;
  const scope = draftScope(config.resourceRestAPI, auth.getParsedToken().sub,
    { ...route, id: route.id ? resourcePathId(route.id) : '' }, folderId);
  const next = new DesignerDraftStore(scope);
  if (previous && previous.scope !== scope) {
    // Store the confirmed identity before removing the old route's journal.
    try { next.write(next.capture(designer, state)); previous.clear(); }
    catch { ui['draft-storage-error'].hidden = false; }
  }
  draftStore = next;
}
function update() {
  const report = state.report(designer);
  const findingsKey = JSON.stringify(report.server);
  if (designer && typeof designer.revealValidationFinding === 'function' && findingsKey !== forwardedFindings) {
    forwardedFindings = findingsKey;
    designer.validationFindings = report.server.map(({location, message, severity}) => ({location: location || '', message, severity}));
  }
  ui.save.disabled = !report.canSave || Boolean(offeredDraft);
  ui['draft-offer'].hidden = !offeredDraft;
  ui['restore-draft'].disabled = state.saving || state.checking || !designer || (!state.ready && !state.loadFailed);
  ui['discard-draft'].disabled = state.saving || state.checking;
  ui.reload.hidden = !(state.loadFailed || state.reloadRequired) || state.uncertainCreation || unreadable || canRecheckOpeningAccess();
  ui.reload.disabled = state.saving || state.checking;
  ui['check-save'].hidden = !state.canCheckSave;
  ui['check-save'].disabled = state.saving || state.checking;
  ui['recheck-access'].hidden = !(state.canRecheckAccess || canRecheckOpeningAccess());
  ui['sign-in-again'].hidden = !(openingAccessRefused || canRecheckOpeningAccess() || state.canRecheckAccess ||
    (state.reloadRequired && !route?.id && !state.uncertainCreation) || (creationCheckSignedOut && state.uncertainCreation));
  ui['sign-in-again'].disabled = state.saving || state.checking;
  ui['recheck-access'].disabled = state.saving || state.checking;
  ui['server-issues'].hidden = !report.server.length;
  ui['server-issues-title'].textContent = counted('Message.ServerFindings', report.server.length);
  ui['server-issues-list'].replaceChildren();
  for (const issue of report.server) {
    const row = document.createElement('li');
    const text = `${issue.location || '/'}: ${issue.message}`;
    const mapped = designer?.validationReport?.issues.some(finding => finding.source === 'host' && finding.location === (issue.location || '') && !finding.unmapped);
    if (mapped && typeof designer.revealValidationFinding === 'function') {
      const link = document.createElement('button');
      link.type = 'button'; link.className = 'finding-link'; link.textContent = text;
      link.addEventListener('click', () => designer.revealValidationFinding(issue.location || ''));
      row.append(link);
    } else row.textContent = text;
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
  if (designer) {
    designer.readOnly = !state.writable || choiceWouldCoverOffer();
    designer.inert = !state.ready || state.loadFailed || state.saving || Boolean(offeredDraft);
  }
  keepDraft();
}
window.addEventListener('pagehide', () => state.dispose());
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
window.addEventListener('beforeunload', event => {
  keepDraft();
  if (!leaving && (dirty() || state.saving)) { event.preventDefault(); event.returnValue = ''; }
});
function leave() {
  leaving = true;
  location.assign(returnUrl);
}
function artifactUrl() { return `${config.resourceRestAPI}/${route.collection}/${encodeURIComponent(resourcePathId(route.id))}`; }
/**
 * Open what a save stored in place of the document it submitted, as reopening the page would. A save
 * that creates an artifact or a new draft gets its identity and lifecycle metadata from the server, and
 * the next save must update that artifact rather than resubmit the draft. When the stored artifact
 * cannot be adopted, nothing changes and the answer is false.
 */
async function reopen(attempt) {
  let loaded;
  try { loaded = await request(artifactUrl()); } catch { return false; }
  const id = loaded?.data?.['@id'];
  if (!attempt.current() || typeof id !== 'string' || resourcePathId(id) !== resourcePathId(route.id) || !state.matches(attempt, designer)) return false;
  let projection;
  try { designer.loadArtifact(loaded.data, { preserveView: true }); projection = designer.currentArtifact; } catch { return false; }
  state.loaded({ artifact: loaded.data, projection, etag: loaded.etag, writable: state.writable });
  state.reloadRequired = !loaded.etag;
  return true;
}
ui.back.addEventListener('click', () => {
  if (!returnUrl || state.saving || (dirty() && !window.confirm(t('Message.ConfirmDiscard')))) return;
  if (!state.reloadRequired && !offeredDraft) clearDraft();
  leave();
});
ui.reload.addEventListener('click', () => {
  if (state.saving || state.checking || state.uncertainCreation || (dirty() && !window.confirm(t('Message.ConfirmReload')))) return;
  if (!state.loadFailed) clearDraft();
  leaving = true; location.reload();
});
/** Read a resource, answering null when the server reports that it does not exist. */
async function readIfPresent(url) {
  try { return await request(url); } catch (error) { if (error?.status === 404) return null; throw error; }
}
/**
 * Settle a create or new version whose answer was lost by reading the identity it was sent under, and
 * for an absent new version the template it was drawn from. Committed opens what was stored at its edit
 * address and keeps later edits as unsaved changes. A create refused as occupied moves to that address
 * too, keeping the designer's content, and needs a reload before another save. Absent permits Save again
 * under the same identity; anything else leaves Save blocked, and the check may be repeated.
 */
async function settleCreation(check, creation) {
  const url = `${config.resourceRestAPI}/${route.collection}/${encodeURIComponent(resourcePathId(creation.id))}`;
  const created = await readIfPresent(url);
  let source, writable = state.writable;
  if (created) writable = canEdit((await request(`${url}/report`)).data, created.data);
  else if (creation.operation === 'version') {
    const [latest, report] = await Promise.all([request(artifactUrl()), request(`${artifactUrl()}/report`)]);
    source = latest; writable = canEdit(report.data, latest.data);
  }
  if (!check.current()) return;
  const result = state.settleCreation(check, { created, source, writable });
  if (result === 'committed' || result === 'adopted') {
    saved = true;
    route.id = created.data['@id'];
    const address = new URL(location.href);
    address.pathname = `/${route.kind}s/edit/${encodeURIComponent(resourcePathId(route.id))}`;
    window.history.replaceState(null, '', address.href);
    // Without later edits the designer opens what was stored, as a confirmed save does. What an earlier
    // attempt stored is never loaded over the designer's content, which may hold more than it.
    if (result === 'committed' && !state.dirty(designer)) {
      try {
        designer.loadArtifact(created.data, { preserveView: true });
        state.loaded({ artifact: created.data, projection: designer.currentArtifact, etag: created.etag, writable: true });
        state.reloadRequired = !created.etag;
      } catch { /* The submitted projection stays the baseline the designer is compared with. */ }
    }
    selectDraftStore();
  }
  if (result === 'obsolete') return;
  if (result === 'adopted') { message(t('Message.SavedNewIdentity'), true); return; }
  const key = result === 'committed' ? (state.reloadRequired ? 'Error.NoValidator' : 'Message.SaveConfirmed') :
    result === 'absent' ? 'Message.ChangesKept' : result === 'readonly' ? 'Error.RecoveryReadOnly' : 'Error.RecoveryUnresolved';
  message(t(key), key.startsWith('Error.'));
}
async function checkRecovery() {
  // A clean read-only opening has no local work to reconcile; fetch content and access together again.
  if (canRecheckOpeningAccess() && !state.saving && !state.checking) { location.reload(); return; }
  const access = state.canRecheckAccess;
  const creation = state.creation;
  const check = state.beginCheck();
  if (!check) return;
  creationCheckSignedOut = false;
  update(); message(t(access ? 'Message.CheckingAccess' : 'Message.CheckingSave'));
  try {
    if (creation) { await settleCreation(check, creation); return; }
    const url = artifactUrl();
    const [latest, report] = await Promise.all([request(url), request(`${url}/report`)]);
    if (!check.current()) return;
    const result = state.checked(check, latest, canEdit(report.data, latest.data));
    if (result === 'saved') saved = true;
    const recovered = result === 'saved' || result === 'unchanged';
    message(t(result === 'saved' ? 'Message.SaveConfirmed' : result === 'unchanged' ? (access ? 'Message.AccessRestored' : 'Message.SaveUnchanged') :
      result === 'readonly' ? 'Error.RecoveryReadOnly' : 'Error.RecoveryUnresolved'), !recovered);
  } catch (error) {
    if (!check.current()) return;
    creationCheckSignedOut = Boolean(creation) && error?.status === 401;
    message(t(creationCheckSignedOut ? 'Error.SessionExpired' : access ? 'Error.AccessUnavailable' : 'Error.RecoveryUnavailable'), true);
  } finally { state.finishCheck(check); update(); }
}
ui['check-save'].addEventListener('click', checkRecovery);
ui['recheck-access'].addEventListener('click', checkRecovery);
ui['sign-in-again'].addEventListener('click', () => {
  if (!draftStore || !auth || state.saving || state.checking) return;
  if (canRecheckOpeningAccess()) { auth.doLogin(); return; }
  try {
    draftStore.write(offeredDraft ?? draftStore.capture(designer, state));
    ui['draft-storage-error'].hidden = true;
    auth.doLogin();
  } catch { ui['draft-storage-error'].hidden = false; }
});
ui['restore-draft'].addEventListener('click', () => {
  if (!offeredDraft || !designer || state.saving || state.checking || (!state.ready && !state.loadFailed)) return;
  if (dirty() && !window.confirm(t('Message.ConfirmDiscard'))) return;
  try {
    // Validate host state separately before the component atomically adopts its snapshot.
    const candidate = new DesignerCoordinator(); candidate.restoreRecovery(offeredDraft.coordinator);
    designer.restoreDraft(offeredDraft.draft);
    state.restoreRecovery(offeredDraft.coordinator);
    offeredDraft = null; ui.editor.hidden = false;
    message(t(state.reloadRequired ? 'Draft.RestoredGuarded' : 'Draft.Restored'), state.reloadRequired);
    update();
  } catch { message(t('Draft.Invalid'), true); }
});
ui['discard-draft'].addEventListener('click', () => {
  if (!offeredDraft || state.saving || state.checking) return;
  if (!discardable(offeredDraft)) { message(t('Draft.UnknownCreate'), true); return; }
  if (window.confirm(t('Message.ConfirmDiscard'))) { clearDraft(); update(); }
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
      if (discarded) designer.loadArtifact(JsonSourcePolicy.clone(state.stored));
      resolve(dialog.returnValue === 'confirm');
    }, { once: true });
    dialog.showModal();
  });
}
ui.save.addEventListener('click', async () => {
  let attempt;
  try {
    if (offeredDraft) return;
    attempt = state.beginSave(designer);
    if (!attempt) return;
    update(); message(t('State.Saving'));
    const result = await saveArtifact({ request, base: config.resourceRestAPI, route,
      artifact: attempt.artifact, etag: state.etag, folderId, confirmVersion,
      // Every attempt of a create or new version reuses one identity until a write under it is confirmed.
      identity: () => state.identity(() => mintIdentity(route.collection)),
      stillCurrent: () => state.matches(attempt, designer), onWrite: write => { attempt.write = write; keepDraft(attempt); } });
    if (!attempt.current()) return;
    if (!result) { message(t(discarded ? 'Message.ChangesDiscarded' : 'Message.ChangesKept')); return; }
    if (!result.data || typeof result.data['@id'] !== 'string' || TextPolicy.isBlank(result.data['@id'])) {
      state.reloadRequired = true; state.uncertainCreation = attempt.write?.createsIdentity ?? !route.id;
      throw new Error(t('Error.SaveUnconfirmed'));
    }
    const confirmedWrite = attempt.write;
    attempt.write = undefined;
    saved = true;
    // A successful save stays in Designer. A new artifact or draft takes its own edit address.
    const newIdentity = route.id !== result.data['@id'];
    route.id = result.data['@id'];
    const address = new URL(location.href);
    address.pathname = `/${route.kind}s/edit/${encodeURIComponent(resourcePathId(route.id))}`;
    window.history.replaceState(null, '', address.href);
    if (newIdentity && state.matches(attempt, designer) && await reopen(attempt)) {
      selectDraftStore();
      message(state.reloadRequired ? t('Error.NoValidator') : '', state.reloadRequired);
      return;
    }
    if (!attempt.current()) return;
    // The open document stays in the designer, with the author's place in it, and the next update uses
    // the ETag this save returned. A new artifact or draft the designer has not adopted needs a reload
    // before another save.
    const edited = !state.matches(attempt, designer);
    state.committed(attempt, result.etag, newIdentity, confirmedWrite);
    if (newIdentity) {
      // The reply establishes the identity even when readback cannot establish content.
      // Keep the reload guard and bind the retained draft to that confirmed identity.
      state.stored['@id'] = route.id;
      selectDraftStore();
    }
    if (state.canCheckSave) message(t('Error.SavedVerificationUnavailable'), true);
    else if (edited) message(t(newIdentity ? 'Message.SavedNewIdentity' : 'Message.SavedWithChanges') + (!result.etag ? ' ' + t('Error.NoValidator') : ''), state.reloadRequired);
    else message(newIdentity ? t('Message.SavedReloadRequired') : !result.etag ? t('Error.NoValidator') : '', state.reloadRequired);
  } catch (error) {
    if (attempt && !attempt.current()) return;
    const unconfirmed = state.failed(error, attempt);
    message(unconfirmed ? t('Error.SaveUnconfirmed') : saveMessage(error), true);
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
  route = routeFor(location.pathname === '/' ? '/templates/create' : location.pathname);
  // The address says which designer this is, so the heading waits for nothing the page loads.
  ui.title.textContent = t(`Header.Title.${route.kind}`);
  config = await readJson(`config/host.json?v=${version}`, 'Error.ConfigurationLoad');
  useDeploymentApi(config.resourceRestAPI);
  const params = new URLSearchParams(location.search);
  folderId = params.get('folderId');
  returnUrl = workspaceReturn(config.workspaceFrontend, params.get('returnTo'), folderId);
  auth = new window.KeycloakUserHandler();
  const authenticated = await new Promise((resolve, reject) => auth.initUserHandler(resolve, () => reject(new Error(t('Error.SignIn')))));
  if (!authenticated) { auth.doLogin(); } else {
    request = createBackend(auth, crypto.randomUUID());
    // Existing records and explicit destinations can find their scoped retained draft before profile loading.
    if (route.id || folderId) {
      selectDraftStore();
      try { offeredDraft = draftStore.read(); } catch { ui['draft-storage-error'].hidden = false; }
    }
    const { data: profile } = await request(`${config.userRestAPI}/users/${encodeURIComponent(auth.getParsedToken().sub)}`);
    folderId ||= profile.homeFolderId;
    if (!draftStore) {
      selectDraftStore();
      try { offeredDraft = draftStore.read(); } catch { ui['draft-storage-error'].hidden = false; }
    }
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
    for (const event of ['artifactChange', 'validationChange', 'dirtyChange']) designer.addEventListener(event, update);
    if (route.id) {
      const url = artifactUrl();
      const [loaded, report] = await Promise.all([request(url), request(`${url}/report`)]);
      if (!loaded.data || resourcePathId(loaded.data['@id']) !== resourcePathId(route.id)) throw new Error(t('Error.InvalidArtifact'));
      route.id = loaded.data['@id']; // Keep the stored identity for subsequent PUT bodies.
      let projection;
      try {
        designer.loadArtifact(loaded.data);
        projection = designer.currentArtifact;
      } catch (error) {
        // The reader refuses an artifact it cannot read, such as one whose child is stored under a
        // reserved key, and says why in its own words, which name the place in the artifact.
        unreadable = true;
        throw new Error(t('Error.Unreadable', { detail: error.message }));
      }
      state.loaded({ artifact: loaded.data, projection, etag: loaded.etag, writable: canEdit(report.data, loaded.data) });
      if (state.writable && !loaded.etag) { state.reloadRequired = true; message(t('Error.NoValidator'), true); }
    } else {
      if (!folderId) throw new Error(t('Error.NoFolder'));
      const {data: folder} = await request(`${config.resourceRestAPI}/folders/${encodeURIComponent(resourcePathId(folderId))}`);
      designer.newArtifact(route.kind === 'field' ? undefined : route.kind);
      state.loaded({writable: canCreate(folder)});
    }
    designer.readOnly = !state.writable || choiceWouldCoverOffer();
    ui.editor.hidden = false;
    if (!state.reloadRequired) message(state.writable ? '' : t('Message.ReadOnly'));
    update();
  }
} catch (error) {
  // A freshly loaded component can restore a retained draft even if the server read failed.
  if (!offeredDraft || typeof designer?.restoreDraft !== 'function') {
    ui.editor.replaceChildren(); designer = null;
  }
  openingAccessRefused = [401, 403].includes(error.status);
  state.failLoad();
  update();
  message(openingMessage(error, !route?.id), true);
}
