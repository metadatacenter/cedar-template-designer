import {test, expect} from '@playwright/test';
import {host, edit, text, minted, forceSave} from './host-fixture.mjs';

for (const operation of ['create', 'update', 'version'])
  for (const answer of ['lost response', 'missing identity'])
    test(`${operation} with ${answer} keeps newer input and cannot repeat the write`, async ({page}) => {
      const state = await host(page, 'template', operation === 'create' ? 'create' : 'edit');
      if (operation === 'version') state.impact = {canBeUpdated: false};
      let release;
      const pending = new Promise(resolve => {release = resolve;});
      const committed = [];
      await page.route(/\/api\/(templates(?:\/[^/?]+)?|command\/publish-create-draft-template\/item)(?:\?.*)?$/, async route => {
        if (route.request().method() === 'GET') return route.fallback();
        const sent = route.request().postDataJSON();
        committed.push(operation === 'version' ? sent.template : sent);
        await pending;
        if (answer === 'lost response') await route.abort('failed');
        else await route.fulfill({json: {}});
      });
      await edit(page, 'Submitted');
      await page.locator('#save').click();
      if (operation === 'version') await page.locator('#version-dialog button[value=confirm]').click();
      await expect.poll(() => committed.length).toBe(1);
      await edit(page, 'Newer');
      release();
      await expect(page.locator('#message')).toHaveText(text('en', 'Error.SaveUnconfirmed'));
      await expect(page.locator('#state')).toHaveText(text('en', 'State.SaveUnconfirmed'));
      await expect(page.locator('#save')).toBeDisabled();
      if (operation === 'update') await expect(page.locator('#reload')).toBeVisible();
      else await expect(page.locator('#reload')).toBeHidden();
      // Whether the write was stored is settled by reading it, never by repeating it.
      await expect(page.locator('#check-save')).toBeVisible();
      await edit(page, 'Still here');
      // Click directly to verify the handler also refuses, independently of the disabled button.
      const {before, after} = await forceSave(page);
      expect(after).toEqual(before);
      expect(committed).toHaveLength(1);
      expect(committed[0]['schema:name']).toBe('Submitted');
      expect(await page.locator('#editor > *').evaluate(el => el.currentArtifact['schema:name'])).toBe('Still here');
    });

test('an unavailable update assessment can be retried without discarding the draft', async ({page}) => {
  const state = await host(page);
  await page.route('**/api/command/check-update-template/item', route => route.abort('failed'));
  await edit(page, 'Kept');
  await page.locator('#save').click();
  await expect(page.locator('#message')).toHaveText(text('en', 'Error.Unreachable'));
  await expect(page.locator('#save')).toBeEnabled();
  expect(state.writes).toHaveLength(0);
  await page.unroute('**/api/command/check-update-template/item');
  await page.locator('#save').click();
  await expect(page.locator('#state')).toHaveText('Saved');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body['schema:name']).toBe('Kept');
});

// A create or new version whose answer is lost is settled by reading the identity it was sent under.
// `lose` answers the write by storing it, when it committed, and then dropping the answer.
async function lose(page, state, {operation, committed}) {
  const sent = [];
  const pattern = operation === 'create' ? '**/api/templates/*' : '**/api/command/publish-create-draft-template/item';
  const handler = async route => {
    if (route.request().method() === 'GET') return route.fallback();
    const inputs = route.request().postDataJSON(), body = operation === 'create' ? inputs : inputs.template;
    const id = operation === 'create' ? body['@id'] : inputs.draftId;
    sent.push({id, body, etag: route.request().headers()['if-match']});
    if (committed) {
      state.stored.set(id.split('/').pop(), {json: operation === 'create' ? body
        : {...body, '@id': id, 'pav:version': '0.0.2', 'bibo:status': 'bibo:draft', 'pav:previousVersion': 'item'}, etag: '"created"'});
      if (operation === 'version') state.stored.set('item', {json: {'@id': 'item', 'schema:name': 'Opened', properties: {}, 'bibo:status': 'bibo:published'}, etag: '"published"'});
    }
    await route.abort('failed');
  };
  await page.route(pattern, handler);
  return {sent, stop: () => page.unroute(pattern, handler)};
}
const designerName = page => page.locator('#editor > *').evaluate(el => el.currentArtifact['schema:name']);

for (const operation of ['create', 'version']) for (const later of [false, true])
  test(`a ${operation} that committed although its answer was lost opens at its edit address, later edits=${later}`, async ({page}) => {
    const state = await host(page, 'template', operation === 'create' ? 'create' : 'edit', true, operation === 'version' ? {impact: {canBeUpdated: false}} : {});
    const lost = await lose(page, state, {operation, committed: true});
    try {
      await edit(page, 'Submitted');
      await page.locator('#save').click();
      if (operation === 'version') await page.locator('#version-dialog button[value=confirm]').click();
      await expect(page.locator('#message')).toHaveText(text('en', 'Error.SaveUnconfirmed'));
      await expect(page.locator('#check-save')).toBeVisible();await expect(page.locator('#reload')).toBeHidden();
      if (later) await edit(page, 'Later');
    } finally { await lost.stop(); }
    const [{id}] = lost.sent;
    expect(id).toMatch(minted('templates'));
    await page.locator('#check-save').click();
    await expect(page.locator('#message')).toHaveText(text('en', 'Message.SaveConfirmed'));
    await expect(page).toHaveURL(new RegExp(`/templates/edit/${id.split('/').pop()}$`));
    await expect(page.locator('#state')).toHaveText(later ? 'Modified' : 'Saved');
    await expect(page.locator('#check-save')).toBeHidden();await expect(page.locator('#save')).toBeEnabled();
    expect(await designerName(page)).toBe(later ? 'Later' : 'Submitted');
    // The next save updates what was stored, under its validator.
    state.impact = {canBeUpdated: true};state.savedId = id.split('/').pop();
    await edit(page, 'Final');await page.locator('#save').click();
    await expect(page.locator('#state')).toHaveText('Saved');
    expect(state.writes.map(({path, etag}) => [path, etag])).toEqual([[`/api/templates/${id.split('/').pop()}`, '"created"']]);
    expect(lost.sent).toHaveLength(1);
  });

for (const operation of ['create', 'version'])
  test(`a ${operation} absent after a lost answer survives a reload and saves under the same identity`, async ({page}) => {
    const state = await host(page, 'template', operation === 'create' ? 'create' : 'edit', true, operation === 'version' ? {impact: {canBeUpdated: false}, savedId: 'new-draft'} : {});
    const lost = await lose(page, state, {operation, committed: false});
    try {
      await edit(page, 'Submitted');
      await page.locator('#save').click();
      if (operation === 'version') await page.locator('#version-dialog button[value=confirm]').click();
      await expect(page.locator('#check-save')).toBeVisible();
    } finally { await lost.stop(); }
    page.on('dialog', dialog => dialog.accept());await page.reload();
    await expect(page.locator('#draft-offer')).toBeVisible();await expect(page.locator('#check-save')).toBeHidden();
    await page.locator('#restore-draft').click();
    await expect(page.locator('#message')).toHaveText(text('en', 'Draft.RestoredGuarded'));
    await expect(page.locator('#save')).toBeDisabled();await expect(page.locator('#check-save')).toBeVisible();
    await page.locator('#check-save').click();
    await expect(page.locator('#message')).toHaveText(text('en', 'Message.ChangesKept'));
    await expect(page.locator('#check-save')).toBeHidden();await expect(page.locator('#save')).toBeEnabled();
    await page.locator('#save').click();
    if (operation === 'version') await page.locator('#version-dialog button[value=confirm]').click();
    await expect(page.locator('#state')).toHaveText('Saved');
    const [{id}] = lost.sent;
    expect(state.writes).toHaveLength(1);
    if (operation === 'create') expect(state.writes[0]).toMatchObject({path: `/api/templates/${id.split('/').pop()}`, body: {'@id': id}});
    else expect(state.writes[0]).toMatchObject({path: '/api/command/publish-create-draft-template/item', query: {}, draftId: id, etag: '"opened"'});
  });

test('a create whose check is refused for the session offers Sign in again and keeps the identity through it', async ({page}) => {
  const state = await host(page, 'template', 'create');
  const lost = await lose(page, state, {operation: 'create', committed: false});
  try { await edit(page, 'Submitted');await page.locator('#save').click();await expect(page.locator('#check-save')).toBeVisible(); }
  finally { await lost.stop(); }
  const [{id}] = lost.sent;
  const refuse = route => route.fulfill({status: 401, json: {message: 'Expired'}});
  await page.route(`**/api/templates/${id.split('/').pop()}`, refuse);
  await expect(page.locator('#sign-in-again')).toBeHidden();
  await page.locator('#check-save').click();
  await expect(page.locator('#message')).toHaveText(text('en', 'Error.SessionExpired'));
  await expect(page.locator('#sign-in-again')).toBeVisible();await expect(page.locator('#check-save')).toBeVisible();
  await expect(page.locator('#save')).toBeDisabled();
  await page.locator('#sign-in-again').click();
  expect(await page.evaluate(() => window.signInCalls)).toBe(1);
  expect(await page.evaluate(id => Object.values(sessionStorage).some(raw => raw.includes(id)), id)).toBe(true);
  await page.unroute(`**/api/templates/${id.split('/').pop()}`, refuse);
  await page.locator('#check-save').click();
  await expect(page.locator('#message')).toHaveText(text('en', 'Message.ChangesKept'));
  await expect(page.locator('#sign-in-again')).toBeHidden();
  expect(state.writes).toHaveLength(0);
});

test('a create journaled before identities were sent keeps its guard and offers no check', async ({page}) => {
  const state = await host(page, 'template', 'create');
  await edit(page, 'Submitted');state.failure = 'network';
  await page.locator('#save').click();await expect(page.locator('#check-save')).toBeVisible();
  // Model a journal an earlier Designer wrote: the same unsettled create, without its identity.
  await page.evaluate(() => {
    for (const key of Object.keys(sessionStorage)) {
      const value = JSON.parse(sessionStorage.getItem(key));
      delete value.coordinator.identity;delete value.coordinator.creation;
      sessionStorage.setItem(key, JSON.stringify(value));
    }
    Storage.prototype.setItem = () => {};
  });
  page.on('dialog', dialog => dialog.accept());await page.reload();
  await page.locator('#restore-draft').click();
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#check-save')).toBeHidden();await expect(page.locator('#reload')).toBeHidden();
  expect(state.writes).toHaveLength(1);
});

// The identity a create sends is this page's own, but what it holds need not be the last attempt. Here the
// first write is still in flight when the check reads its identity, so Save is offered again; the first write
// commits once the repeat has been sent, and the answers to both are lost. The check then finds the first
// attempt, which must not be loaded over the newer work or end its retention.
test('a create found holding an earlier attempt after a second lost answer keeps the newer work and its draft', async ({page}) => {
  const state = await host(page, 'template', 'create');
  const sent = [];
  const handler = async route => {
    if (route.request().method() === 'GET') return route.fallback();
    const body = route.request().postDataJSON();
    sent.push(body);
    if (sent.length === 2) state.stored.set(body['@id'].split('/').pop(), {json: sent[0], etag: '"created"'});
    await route.abort('failed');
  };
  await page.route('**/api/templates/*', handler);
  try {
    await edit(page, 'Submitted');
    await page.locator('#save').click();
    await page.locator('#check-save').click();
    await expect(page.locator('#message')).toHaveText(text('en', 'Message.ChangesKept'));
    await edit(page, 'Newer');
    await page.locator('#save').click();
    await expect(page.locator('#message')).toHaveText(text('en', 'Error.SaveUnconfirmed'));
    await expect(page.locator('#check-save')).toBeVisible();
  } finally { await page.unroute('**/api/templates/*', handler); }
  await page.locator('#check-save').click();
  await expect(page.locator('#message')).toHaveText(text('en', 'Message.SavedNewIdentity'));
  const id = sent[0]['@id'];
  await expect(page).toHaveURL(new RegExp(`/templates/edit/${id.split('/').pop()}$`));
  await expect(page.locator('#state')).toHaveText(text('en', 'State.ReloadRequired'));
  expect(await designerName(page)).toBe('Newer');
  await expect(page.locator('#save')).toBeDisabled();
  await expect(page.locator('#reload')).toBeVisible();
  await expect(page.locator('#check-save')).toBeHidden();
  // The newer work stays retained for the reload the page asks for.
  await expect.poll(() => page.evaluate(() => Object.values(sessionStorage).some(raw => raw.includes('Newer')))).toBe(true);
  expect(sent.map(body => [body['@id'], body['schema:name']])).toEqual([[id, 'Submitted'], [id, 'Newer']]);
});

// The journal of a create is written before its request is sent, so a lost answer can be settled after a
// reload. When storage refuses that write, the request is still sent once, the page says the draft could not
// be kept, and nothing outside the page holds the identity: leaving still asks first, and the lost answer is
// settled from the open page, under the same identity.
test('a create whose journal cannot be written settles a lost answer from the open page, under one identity', async ({page}) => {
  const state = await host(page, 'template', 'create');
  await edit(page, 'Submitted');
  await expect(page.locator('#draft-storage-error')).toBeHidden();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Full'); }; });
  const lost = await lose(page, state, {operation: 'create', committed: false});
  try {
    await page.locator('#save').click();
    await expect(page.locator('#message')).toHaveText(text('en', 'Error.SaveUnconfirmed'));
  } finally { await lost.stop(); }
  expect(lost.sent).toHaveLength(1);
  const [{id}] = lost.sent;
  await expect(page.locator('#draft-storage-error')).toBeVisible();
  await expect(page.locator('#check-save')).toBeVisible();
  await expect(page.locator('#reload')).toBeHidden();
  expect(await page.evaluate(() => {
    const leaving = new Event('beforeunload', {cancelable: true});
    window.dispatchEvent(leaving);
    return leaving.defaultPrevented;
  })).toBe(true);
  await page.locator('#check-save').click();
  await expect(page.locator('#message')).toHaveText(text('en', 'Message.ChangesKept'));
  await page.locator('#save').click();
  await expect(page.locator('#state')).toHaveText('Saved');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({path: `/api/templates/${id.split('/').pop()}`, body: {'@id': id, 'schema:name': 'Submitted'}});
});
