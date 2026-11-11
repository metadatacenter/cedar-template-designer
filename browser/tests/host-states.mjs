import {readFileSync, existsSync} from 'node:fs';
import {expect} from '@playwright/test';
import {host, edit, text} from './host-fixture.mjs';

// The host's states as its browser suites reach them, for the checks that measure the page in each.
// The accessibility gate and the layout checks scan the same states.

// The embedded components draw their own content and run checks of their own, so these checks leave them
// out: CED and its field designer, CEE and its field element, and the term picker.
export const EXCLUDED = [
  'cedar-embeddable-designer',
  'cedar-embeddable-field-designer',
  'cedar-embeddable-editor',
  'cedar-embeddable-field',
  'cedar-embeddable-term-picker',
];

const designerName = page => page.locator('#editor > *').evaluate(designer => designer.currentArtifact['schema:name']);
const message = page => page.locator('#message');

/** A template open for editing and saved once, the server answering the write with `failure` unless it is null. */
export async function saveMeets(page, failure, initial = {}) {
  const state = await host(page, 'template', 'edit', true, initial);
  state.failure = failure;
  await edit(page, 'Submitted');
  await page.locator('#save').click();
  // The write has met the failure once it is recorded, so a caller may change the server afterwards.
  // A refused session refreshes its token and writes once more.
  await expect.poll(() => state.writes.length).toBeGreaterThan(0);
  return state;
}
/** A template whose edit was retained, offered again after a reload. */
export async function draftOffer(page) {
  await host(page);
  await edit(page, 'Retained author work');
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.locator('#draft-offer')).toBeVisible();
}
/** Server findings listed after a save the server refused, with the list open. */
export async function findingsOpen(page) {
  await saveMeets(page, {status: 400, json: {message: 'Validation failed', objects: {validationReport: {errors: [
    {location: '/properties/Link', message: 'Invalid default IRI'},
    {location: '/properties/Child/items/properties/Name', message: 'Review the name'},
  ]}}}});
  await expect(page.locator('#server-issues')).toBeVisible();
  await page.locator('#server-issues summary').click();
  await expect(page.locator('#server-issues-list li')).toHaveCount(2);
}
/** The new-version confirmation, open over the designer. */
export async function versionDialog(page) {
  await host(page, 'template', 'edit', true, {impact: {canBeUpdated: false, numberOfInstances: 3, oldVersion: '0.0.1'}});
  await edit(page, 'Submitted');
  await page.locator('#save').click();
  await expect(page.locator('#version-dialog')).toBeVisible();
}
/** A template with an edit, so that Save is offered. */
export async function modified(page) {
  await host(page);
  await edit(page);
  await expect(page.locator('#state')).toHaveText('Modified');
}
/** A template the person may not edit, which offers an access check and sign-in. */
export async function readOnly(page) {
  await host(page, 'template', 'edit', false);
  await expect(page.locator('#recheck-access')).toBeVisible();
}

/** Each state, by name. A state may return what to do once the page has been measured. */
export const states = {
  // Opening, before sign-in completes, as the startup suite holds it.
  opening: async page => {
    const opening = host(page, 'template', 'edit', true, {holdSignIn: true});
    void opening.catch(() => {});
    await page.waitForFunction(() => typeof window.completeTestSignIn === 'function');
    await expect(page.locator('#editor')).toBeHidden();
    return async () => {
      await page.evaluate(() => window.completeTestSignIn());
      await opening.catch(() => {});
    };
  },
  'template edit': page => host(page),
  'template create': async page => {
    await host(page, 'template', 'create');
    await expect(page.locator('#save')).toBeDisabled();
  },
  'element edit': page => host(page, 'element'),
  'field edit': page => host(page, 'field'),
  // A new field opens its type chooser over the whole page.
  'field create': async page => {
    await host(page, 'field', 'create');
    await expect(page.locator('.chooser')).toBeVisible();
  },
  'template edit in Hungarian': async page => {
    await host(page, 'template', 'edit', true, {language: 'hu'});
    await expect(page.locator('html')).toHaveAttribute('lang', 'hu');
  },
  'read only': readOnly,
  'read-only create': async page => {
    await host(page, 'template', 'create', false);
    await expect(message(page)).toHaveText(text('en', 'Message.ReadOnlyFolder'));
  },
  published: async page => {
    await host(page, 'template', 'edit', true, {loadedArtifact: {'@id': 'item', 'schema:name': 'Opened', 'bibo:status': 'bibo:published', 'pav:version': '1.0.0', properties: {}}});
    await expect(message(page)).toHaveText(text('en', 'Message.ReadOnlyPublished'));
  },
  'load failed': async page => {
    await host(page, 'template', 'edit', true, {brokenLoad: true});
    await expect(page.locator('#reload')).toBeVisible();
  },
  'opening refused': async page => {
    await host(page, 'template', 'edit', true, {openingFailure: {request: 'artifact', answer: route => route.fulfill({status: 403, json: {message: 'Access refused'}})}});
    await expect(page.locator('#sign-in-again')).toBeVisible();
  },
  'component failed': async page => {
    await host(page, 'template', 'create', true, {openingFailure: {request: 'component', answer: route => route.abort('failed')}});
    await expect(message(page)).toHaveText(text('en', 'Error.ComponentLoad', {name: 'cedar-embeddable-designer'}));
  },
  unreadable: async page => {
    await host(page, 'template', 'edit', true, {unreadable: true});
    await expect(message(page)).toHaveAttribute('data-tone', 'error');
  },
  modified,
  saving: async page => {
    let release;
    const state = await host(page);
    state.holdWrite = new Promise(resolve => { release = resolve; });
    await edit(page, 'Submitted');
    await page.locator('#save').click();
    await expect.poll(() => state.writes.length).toBe(1);
    await expect(page.locator('#state')).toHaveText('Saving…');
    return () => release();
  },
  saved: async page => {
    await modified(page);
    await page.locator('#save').click();
    await expect(page.locator('#state')).toHaveText('Saved');
  },
  // While the designer lists an error, Save is refused and says why on hover.
  'refused save': async page => {
    await host(page);
    await edit(page, 'Named', {setting: 'name', shown: true, severity: 'error'});
    await expect(page.locator('#save-help')).toHaveAttribute('data-blocked', 'true');
  },
  'refused save explained': async page => {
    await states['refused save'](page);
    await page.locator('#save-help').hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
  },
  'server findings': async page => {
    await saveMeets(page, {status: 400, json: {message: 'Validation failed', objects: {validationReport: {warnings: [{location: '/schema:name', message: 'Review the name'}]}}}});
    await expect(page.locator('#server-issues')).toBeVisible();
  },
  'server findings open': findingsOpen,
  // Forty findings, which the list scrolls beneath its count.
  'many server findings': async page => {
    const errors = Array.from({length: 40}, (_, i) => ({location: `/properties/Field${i}`, message: 'Invalid default IRI'}));
    await saveMeets(page, {status: 400, json: {message: 'Validation failed', objects: {validationReport: {errors}}}});
    await page.locator('#server-issues summary').click();
    await expect(page.locator('#server-issues li')).toHaveCount(40);
  },
  'version dialog': versionDialog,
  'save declined': async page => {
    await versionDialog(page);
    await page.locator('#version-dialog button[value=cancel]').click();
    await expect(message(page)).toHaveText(text('en', 'Message.ChangesKept'));
  },
  // An edit made while a save is under way stays unsaved after it.
  'saved with later changes': async page => {
    let release;
    const state = await host(page);
    state.holdWrite = new Promise(resolve => { release = resolve; });
    await edit(page, 'Submitted');
    await page.locator('#save').click();
    await expect.poll(() => state.writes.length).toBe(1);
    await edit(page, 'Newer');
    release();
    await expect(message(page)).toHaveText(text('en', 'Message.SavedWithChanges'));
  },
  'request failed': async page => {
    await saveMeets(page, {status: 409, json: {message: 'Server says no'}});
    await expect(message(page)).toContainText('Request failed (409)');
  },
  conflict: async page => {
    await saveMeets(page, {status: 412, json: {message: 'Changed'}});
    await expect(message(page)).toHaveText(text('en', 'Error.Conflict'));
  },
  'session expired': async page => {
    await saveMeets(page, {status: 401, json: {message: 'Expired'}});
    await expect(page.locator('#sign-in-again')).toBeVisible();
  },
  'save unconfirmed': async page => {
    await saveMeets(page, 'network');
    await expect(page.locator('#check-save')).toBeVisible();
    await expect(page.locator('#reload')).toBeVisible();
  },
  // A save refused for lack of access, and the access check that follows, as the recheck suite drives them.
  'access refused': async page => {
    await saveMeets(page, {status: 403, json: {message: 'Forbidden'}});
    await expect(page.getByRole('button', {name: 'Recheck access', exact: true})).toBeVisible();
  },
  'access still refused': async page => {
    const state = await saveMeets(page, {status: 403, json: {message: 'Forbidden'}});
    state.failure = null;
    state.allowed = false;
    await page.locator('#recheck-access').click();
    await expect(message(page)).toHaveText(text('en', 'Error.RecoveryReadOnly'));
  },
  'access restored': async page => {
    const state = await saveMeets(page, {status: 403, json: {message: 'Forbidden'}});
    state.failure = null;
    await page.locator('#recheck-access').click();
    await expect(message(page)).toHaveText(text('en', 'Message.AccessRestored'));
  },
  // A save whose stored revision could not be confirmed, and the checks that settle it.
  'save unverified': async page => {
    await saveMeets(page, null, {nextEtag: null});
    await expect(message(page)).toHaveText(text('en', 'Error.SavedVerificationUnavailable'));
  },
  'save unresolved': async page => {
    await saveMeets(page, 'network');
    await page.route('**/api/templates/item', route => route.request().method() === 'GET'
      ? route.fulfill({json: {'@id': 'item', 'schema:name': 'Other', properties: {}}, headers: {ETag: '"other"'}}) : route.fallback());
    await page.locator('#check-save').click();
    await expect(message(page)).toHaveText(text('en', 'Error.RecoveryUnresolved'));
  },
  'save confirmed': async page => {
    const state = await saveMeets(page, 'network');
    state.failure = null;
    state.stored.set('item', {json: state.writes[0].body, etag: '"saved"'});
    await page.locator('#check-save').click();
    await expect(message(page)).toHaveText(text('en', 'Message.SaveConfirmed'));
  },
  // Retained work offered after a reload, as the draft suite drives it.
  'draft offer': draftOffer,
  'draft offer while opening': async page => {
    await host(page);
    await edit(page, 'Draft while opening');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/templates/item/report', async route => { await gate; await route.fallback(); });
    page.on('dialog', dialog => dialog.accept());
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.locator('#editor > *').waitFor({state: 'attached'});
    await page.locator('#editor > *').evaluate(designer => designer.dispatchEvent(new CustomEvent('artifactChange')));
    await expect(page.locator('#restore-draft')).toBeDisabled();
    return () => release();
  },
  // A new field's retained draft holds its type chooser back, so the offer stays reachable.
  'new field draft offer': async page => {
    await host(page, 'field', 'create');
    await edit(page, 'Retained new field');
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(page.locator('#draft-offer')).toBeVisible();
    await expect(page.locator('.chooser')).toHaveCount(0);
  },
  'draft restored': async page => {
    await draftOffer(page);
    await page.locator('#restore-draft').click();
    await expect(page.locator('#draft-offer')).toBeHidden();
    expect(await designerName(page)).toBe('Retained author work');
  },
  'unresolved create offered': async page => {
    const state = await host(page, 'template', 'create');
    await edit(page);
    state.failure = 'network';
    await page.locator('#save').click();
    await expect(page.locator('#state')).toHaveText('Reload required');
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await page.locator('#discard-draft').click();
    await expect(message(page)).toHaveText(text('en', 'Draft.UnknownCreate'));
  },
  'unresolved create restored': async page => {
    await states['unresolved create offered'](page);
    await page.locator('#restore-draft').click();
    await expect(message(page)).toHaveText(text('en', 'Draft.RestoredGuarded'));
  },
  'draft not retained': async page => {
    await saveMeets(page, {status: 401, json: {message: 'Expired'}});
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Full'); }; });
    await page.locator('#sign-in-again').click();
    await expect(page.locator('#draft-storage-error')).toBeVisible();
  },
  'draft after a failed opening': async page => {
    const state = await host(page);
    await edit(page, 'Retained through report');
    state.openingFailure = {request: 'report', answer: route => route.fulfill({status: 503, json: {message: 'Unavailable'}})};
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(page.locator('#state')).toHaveText('Unable to load');
    await expect(page.locator('#draft-offer')).toBeVisible();
  },
};

// The host page with the real shared components it ships, which load fonts and styles of their own.
const shared = existsSync(new URL('../../app/components/cedar-editors.js', import.meta.url));
if (shared) states['shared components'] = async page => {
  const artifact = JSON.parse(readFileSync(new URL('./fixtures/stored-template.json', import.meta.url), 'utf8'));
  const item = artifact['@id'].split('/').pop();
  artifact['@id'] = `https://repo.designer.test/templates/${item}`;
  await host(page, 'template', 'edit', true, {shared: true, loadedArtifact: artifact, item});
  await expect(page.locator('#editor > cedar-embeddable-designer').getByPlaceholder('Template name')).toBeVisible();
};
