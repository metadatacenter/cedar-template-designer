import {test, expect} from '@playwright/test';
import model from 'cedar-model-typescript-library';
import {host, text} from './host-fixture.mjs';

const {CedarBuilders, CedarWriters} = model;
const item = '5f0d8c3e-2b7a-4c1e-9d6f-3a8b7c2e1f40';
function artifact(withElement = false) {
  const template = CedarBuilders.templateBuilder().withSchemaName('Study').withDescription('Study schema').build();
  const field = CedarBuilders.textFieldBuilder().withSchemaName('Value').withDescription('Value schema').build();
  template.addChild(field, field.createDeploymentBuilder('Value').build());
  if (withElement) {
    const element = CedarBuilders.templateElementBuilder().withSchemaName('Section').withDescription('Section schema').build();
    template.addChild(element, element.createDeploymentBuilder('Section').build());
  }
  const value = CedarWriters.json().getStrict().getWriterForArtifact(template).getAsJsonNode(template);
  value['@id'] = `https://repo.designer.test/templates/${item}`;
  return value;
}

for (const width of [375, 1440]) {
  test(`draft recovery communicates blocked editing only while a choice is pending at ${width}`, async ({page}, info) => {
    await page.setViewportSize({width, height: 1000});
    await host(page, 'template', 'edit', true, {shared: true, item, loadedArtifact: artifact(true)});
    const name = page.getByRole('textbox', {name: 'Enter field name', exact: true});
    const remove = page.getByTitle('Delete field', {exact: true});
    const grips = page.locator('.field-drag-handle, .element-drag-handle');
    await expect(grips).toHaveCount(2);
    await expect(page.locator('#draft-offer')).toBeHidden();
    await expect(page.locator('#editor')).not.toHaveAttribute('data-draft-pending');
    await expect(remove).toHaveCSS('opacity', '1');
    for (const grip of await grips.all()) await expect(grip).toHaveCSS('opacity', '1');
    await page.screenshot({path: info.outputPath('ordinary-editing.png')});
    await name.fill('Retained name');
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(page.locator('#draft-offer')).toBeVisible();
    await expect(page.locator('#draft-offer')).toContainText('before editing or saving');
    await expect(page.locator('#editor')).toHaveAttribute('data-draft-pending');
    await expect.poll(() => remove.evaluate(el => Number(getComputedStyle(el).opacity))).toBeLessThan(1);
    for (const grip of await grips.all())
      await expect.poll(() => grip.evaluate(el => Number(getComputedStyle(el).opacity))).toBeLessThan(1);
    await expect(page.locator('#restore-draft')).toBeEnabled();
    await expect(page.locator('#restore-draft')).toHaveCSS('opacity', '1');
    await expect(page.locator('cedar-embeddable-designer')).toHaveAttribute('inert');
    await page.screenshot({path: info.outputPath('draft-offered.png')});
    await page.locator('#restore-draft').click();
    await expect(page.locator('#draft-offer')).toBeHidden();
    await expect(page.locator('#editor')).not.toHaveAttribute('data-draft-pending');
    await expect(remove).toHaveCSS('opacity', '1');
    for (const grip of await grips.all()) await expect(grip).toHaveCSS('opacity', '1');
    await expect(name).toHaveValue('Retained name');
    await name.fill('Editing resumed');
    await expect(name).toHaveValue('Editing resumed');
  });
}

for (const language of ['en', 'hu']) {
  test(`server findings identify their inclusion in the real Designer summary (${language})`, async ({page}, info) => {
    await page.setViewportSize({width: 375, height: 667});
    const server = await host(page, 'template', 'edit', true, {shared: true, language, item, loadedArtifact: artifact()});
    await expect(page.locator('#server-issues')).toBeHidden();
    server.failure = {status: 400, json: {objects: {validationReport: {errors: [{location: '/schema:description', message: 'Describe this study before saving it.'}]}}}};
    await page.locator('#save').click();
    await expect(page.locator('#server-issues-title')).toHaveText(
      text(language, 'Message.ServerFindingsOne', {count: 1}) + ' ' + text(language, 'Message.ServerFindingsIncluded'));
    await expect(page.locator('app-validation-summary')).toBeVisible();
    await page.locator('#server-issues summary').click();
    await expect(page.locator('#server-issues-list')).toContainText('/schema:description: Describe this study before saving it.');
    await expect(page.locator('#save')).toBeDisabled();
    await page.screenshot({path: info.outputPath('shared-validation.png')});
  });
}

test.describe('touch validation feedback', () => {
  test.use({hasTouch: true, viewport: {width: 375, height: 667}});
  test.skip(({browserName}) => browserName === 'firefox', 'Touch profiles use Chromium and WebKit');
  test('a failed Save tap leaves the failure message unobscured', async ({page}, info) => {
    const server = await host(page, 'template', 'edit', true, {shared: true, item, loadedArtifact: artifact()});
    server.failure = {status: 400, json: {objects: {validationReport: {errors: [
      {location: '/schema:description', message: 'Describe this study before saving it.'},
    ]}}}};
    await page.locator('#save').tap();
    await expect(page.locator('#save')).toBeDisabled();
    await expect(page.locator('#message')).toContainText('Your edits have been kept');
    await expect(page.getByRole('tooltip')).toBeHidden();
    await expect(page.locator('app-validation-summary')).toBeVisible();
    await page.screenshot({path: info.outputPath('touch-save-failure.png')});
  });
});
