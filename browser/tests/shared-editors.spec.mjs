import { readFileSync, existsSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { host } from './host-fixture.mjs';

const app = new URL('../../app/', import.meta.url);
const shared = existsSync(new URL('components/cedar-editors.js', app));
test.skip(!shared, 'Old registry pins have standalone scripts; the source reactor supplies integration modules.');
const stored = () => {
  const artifact = JSON.parse(readFileSync(new URL('./fixtures/stored-template.json', import.meta.url), 'utf8'));
  artifact['@id'] = `https://repo.designer.test/templates/${artifact['@id'].split('/').pop()}`;
  return artifact;
};

test('one shared request renders real summaries, preview and editing without recovery controls', async ({ page }) => {
  await page.addInitScript(() => {
    window.__bodyShifts = [];
    new PerformanceObserver(list => {
      for (const shift of list.getEntries()) {
        if (!shift.hadRecentInput && shift.sources.some(source => source.node === document.body))
          window.__bodyShifts.push(shift.value);
      }
    }).observe({type: 'layout-shift', buffered: true});
  });
  const requests = [], errors = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  page.on('pageerror', error => errors.push(error.message));
  const artifact = stored(), item = artifact['@id'].split('/').pop();
  await host(page, 'template', 'edit', true, { shared: true, loadedArtifact: artifact, item });
  const designer = page.locator('#editor > cedar-embeddable-designer');
  await expect(designer.locator('app-field-summary .cee-spec-box').first()).toBeVisible();
  await designer.getByPlaceholder('Template name').fill('Shared runtime editing');
  await expect(page.locator('#state')).toHaveText('Modified');
  await designer.getByRole('button', { name: /Preview/ }).first().click();
  await expect(designer.locator('app-cee-preview cedar-embeddable-editor')).toBeVisible();
  await expect(designer.locator('app-cee-preview .title-label').first()).toBeVisible();
  for (const id of ['reload', 'check-save', 'recheck-access', 'draft-offer', 'draft-storage-error']) await expect(page.locator('#' + id)).toBeHidden();
  expect(requests.filter(path => path === '/components/cedar-editors.js')).toHaveLength(1);
  for (const path of ['/host/host.mjs', '/host/host.css'])
    expect(requests.filter(request => request === path), path).toHaveLength(1);
  expect(requests.filter(path => /^\/scripts\/.*\.mjs$/.test(path) || path.startsWith('/i18n/'))).toEqual([]);
  expect(requests.filter(path => /\/cedar-embeddable-.*\.js$/.test(path))).toEqual([]);
  expect(requests).not.toContain('/components/cedar-schema-validation.mjs');
  expect(requests.filter(path => path.includes('/cedar-rdf-'))).toEqual([]);
  const budget = JSON.parse(readFileSync(new URL('components/page-size.json', app), 'utf8'));
  const covered = new Set(budget.files.map(file => '/' + file.path));
  for (const path of requests.filter(path => /\.(m?js|css|woff2)$/.test(path) && !path.startsWith('/config/'))) expect(covered.has(path), path).toBe(true);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__bodyShifts.filter(value => value > 0.1))).toEqual([]);
});

test('RDF export loads its processors on demand and reuses them for the next format', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  await host(page, 'template', 'create', true, { shared: true });
  await expect(page.locator('#editor > cedar-embeddable-designer').getByPlaceholder('Template name')).toBeVisible();
  const artifact = stored();
  await page.evaluate(artifact => {
    const editor = document.createElement('cedar-embeddable-editor');
    editor.id = 'rdf-editor';
    editor.config = { showDownloadMenu: true, readOnlyMode: true };
    document.body.append(editor);
    editor.templateObject = artifact;
    editor.instanceObject = {
      '@id': 'https://example.org/instances/deferred-rdf',
      '@context': { Text: 'https://example.org/text' },
      'schema:isBasedOn': artifact['@id'],
      Text: { '@value': 'Deferred export content' },
    };
  }, artifact);
  const editor = page.locator('#rdf-editor');
  await expect(editor.locator('.download-trigger')).toBeVisible();
  expect(requests.filter(path => path.includes('/cedar-rdf-'))).toEqual([]);
  for (const format of ['instanceTurtle', 'instanceNQuads']) {
    await editor.locator('.download-trigger').click();
    const downloaded = page.waitForEvent('download');
    await page.locator(`[data-download="${format}"]`).click();
    const download = await downloaded, stream = await download.createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    expect(body).toContain('https://example.org/instances/deferred-rdf');
    expect(body).toContain('Deferred export content');
    expect(download.suggestedFilename()).toMatch(format === 'instanceTurtle' ? /\.ttl$/ : /\.nq$/);
  }
  const manifest = JSON.parse(readFileSync(new URL('components/manifest.json', app), 'utf8'));
  const assets = Object.keys(Object.values(manifest)[0].delivery.assets ?? {});
  for (const asset of assets) expect(requests.filter(path => path === `/components/${asset}`)).toHaveLength(1);
});

test('two designers retain independent documents and UI languages', async ({ page }) => {
  await host(page, 'template', 'create', true, { shared: true });
  await page.evaluate(() => {
    const second = document.createElement('cedar-embeddable-designer');
    second.id = 'second-designer'; second.language = 'hu';
    document.body.append(second); second.newArtifact('template');
  });
  const first = page.locator('#editor > cedar-embeddable-designer'), second = page.locator('#second-designer');
  await first.getByPlaceholder('Template name').fill('Only the first');
  await expect(first.getByRole('button', { name: 'Add field', exact: true })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Add field', exact: true })).toHaveCount(0);
  expect(await second.evaluate(element => element.currentArtifact['schema:name'])).not.toBe('Only the first');
  await second.evaluate(element => element.language = 'en');
  await expect(second.getByRole('button', { name: 'Add field', exact: true })).toBeVisible();
  await expect(first.getByPlaceholder('Template name')).toHaveValue('Only the first');
});

test('the real CEF default editor updates the document and its summary', async ({ page }) => {
  const artifact = stored(), item = artifact['@id'].split('/').pop();
  await host(page, 'template', 'edit', true, { shared: true, loadedArtifact: artifact, item });
  const designer = page.locator('#editor > cedar-embeddable-designer');
  const card = designer.locator('app-field-card').first();
  await card.locator('.settings-toggle').click();
  await card.getByRole('tab', { name: 'Constraints', exact: true }).click();
  const input = card.locator('app-field-default-value input').first();
  await input.fill('A shared default');
  await input.press('Tab');
  await expect.poll(() => designer.evaluate(element => element.currentArtifact.properties.Text._valueConstraints.defaultValue)).toBe('A shared default');
  await expect(card.locator('app-field-summary .cee-spec-box')).toContainText('A shared default');
});

test('the shared term picker searches while the designer retains its document', async ({ page }) => {
  await host(page, 'template', 'create', true, { shared: true });
  const queries = [];
  await page.route('https://terminology.shared.test/search', route => {
    const { query } = route.request().postDataJSON(); queries.push(query);
    return route.fulfill({ json: { query, sources: [], results: {} } });
  });
  await page.evaluate(() => {
    const picker = document.createElement('cedar-embeddable-term-picker');
    picker.terminologyBaseUrl = 'https://terminology.shared.test/';
    document.body.append(picker);
  });
  await page.locator('cedar-embeddable-term-picker input').first().fill('melanoma');
  await expect.poll(() => queries).toContain('melanoma');
  await expect(page.locator('cedar-embeddable-term-picker')).toContainText('No terms match');
  await expect(page.locator('#editor > cedar-embeddable-designer').getByPlaceholder('Template name')).toBeVisible();
});

test('shared script failure uses the existing load failure and retry experience', async ({ page }) => {
  await host(page, 'template', 'create', true, { shared: true, openingFailure: { request: 'component', answer: route => route.abort('failed') } });
  await expect(page.locator('#reload')).toBeVisible();
  await expect(page.locator('#editor')).toBeHidden();
});
