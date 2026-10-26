import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test, expect} from '@playwright/test';
import library from 'cedar-model-typescript-library';
import {host} from './host-fixture.mjs';

// A stored artifact carrying a shape the designer cannot represent and the server refuses, opened in the
// real designer and saved at once. The designer's projection drops or replaces the shape, and the host
// retains every stored branch the author did not change, so without the designer's list of superseded
// shapes the stored one went back in the body and the server refused it. Every other suite here serves a
// stand-in designer whose projection is the stored artifact itself, so none of them could see it.
//
// The designer is the installed package, or the bundle CEDAR_CED_BUNDLE names, relative to this
// repository, for a designer change not yet published. The stored template is template-038 of the
// designer's production corpus without its choice and external-authority fields, so that it can be
// saved without terminology services.

const {FieldValuePolicy, ValidationPolicy} = library;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE = resolve(ROOT, process.env.CEDAR_CED_BUNDLE ?? 'node_modules/cedar-embeddable-designer/cedar-embeddable-designer.js');
const FIELD = 'https://schema.metadatacenter.org/core/TemplateField';
// The opened artifact's identity, absolute as a real designer requires, and the UUID the page's address names.
const ITEM = '5f0d8c3e-2b7a-4c1e-9d6f-3a8b7c2e1f40';
const IRI = kind => `https://repo.designer.test/${kind}/${ITEM}`;
const template = () => ({...JSON.parse(readFileSync(new URL('./fixtures/stored-template.json', import.meta.url), 'utf8')),
  '@id': IRI('templates')});

/** What the server would refuse in a field, as the model library mirrors it. */
function refusals(field) {
  return [...FieldValuePolicy.validateConfiguration(field), ...FieldValuePolicy.validateDefault(field)]
    .filter(finding => ValidationPolicy.blocksSave(finding, 'template')).map(finding => finding.message)
    .concat(Object.hasOwn(field._ui ?? {}, 'order') ? ['A field has no order.'] : []);
}
const fields = body => Object.fromEntries(Object.entries(body.properties)
  .map(([key, value]) => [key, value?.items ?? value]).filter(([, value]) => value?.['@type'] === FIELD));

const CASES = {
  'a numeric field with no datatype': {field: 'Number', inject: field => { delete field._valueConstraints.numberType; },
    saved: field => expect(field._valueConstraints.numberType).toBe('xsd:decimal')},
  'a controlled-term default stored as text': {field: 'Controlled term',
    inject: field => { field._valueConstraints.defaultValue = 'melanoma'; },
    saved: field => expect(field._valueConstraints.defaultValue).toBeUndefined()},
  'length limits and a pattern its own term default breaks': {field: 'Controlled term',
    inject: field => Object.assign(field._valueConstraints, {minLength: 5, maxLength: 20, regex: '^[A-Z]+$'}),
    saved: field => {
      expect(field._valueConstraints.defaultValue).toEqual({termUri: 'http://purl.obolibrary.org/obo/DOID_1909', 'rdfs:label': 'melanoma'});
      for (const key of ['minLength', 'maxLength', 'regex']) expect(Object.hasOwn(field._valueConstraints, key)).toBe(false);
    }},
  'an order on a field': {field: 'Text', inject: field => { field._ui.order = []; },
    saved: field => expect(Object.hasOwn(field._ui, 'order')).toBe(false)},
};

for (const [name, {field, inject, saved}] of Object.entries(CASES)) {
  test(`a stored template with ${name} saves without it, and with every other stored branch as it was`, async ({page}) => {
    const stored = template();
    const original = fields(stored);
    inject(fields(stored)[field]);
    expect(refusals(fields(stored)[field])).not.toEqual([]);

    const state = await host(page, 'template', 'edit', true, {designerBundle: BUNDLE, loadedArtifact: stored, item: ITEM});
    await page.locator('#save').click();
    await expect.poll(() => state.writes.length).toBe(1);
    const body = state.writes[0].body;

    saved(fields(body)[field]);
    expect(refusals(fields(body)[field])).toEqual([]);
    for (const [key, definition] of Object.entries(fields(body)))
      if (key !== field) expect(definition, key).toEqual(original[key]);
  });
}

test('a stored standalone numeric field with no datatype saves with the one the designer shows', async ({page}) => {
  const stored = {...fields(template()).Number, '@id': IRI('template-fields')};
  delete stored._valueConstraints.numberType;
  const state = await host(page, 'field', 'edit', true, {designerBundle: BUNDLE, loadedArtifact: stored, item: ITEM});
  await page.locator('#save').click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body._valueConstraints.numberType).toBe('xsd:decimal');
  expect(refusals(state.writes[0].body)).toEqual([]);
});
