import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import model from 'cedar-model-typescript-library';
import {host, text, ORIGIN} from './host-fixture.mjs';

// The designer keeps an author's preferences in memory and announces each change. The host keeps what
// it hears in the browser, for one deployment and account, and supplies it to the designer of every
// later page. These cases are the host's half of that exchange, so the stand-in designer announces
// what a test tells it to, and a test reads back what the host assigned. CED's own browser suite
// holds the designer to announcing its changes and to obeying an assignment.
const key = (base, user) => `cedar.designer.preferences:${JSON.stringify([base, user])}`;
const KEY = key(`${ORIGIN}/api`, 'user');
const CHOSEN = {
  showRequired: false, showAllowMultiple: true, showDefaultValue: true, showElements: false,
  hiddenFieldTypes: ['email'], fieldSelectionStyle: 'sidebar',
  presets: {
    basic: {showRequired: true, showAllowMultiple: true, showDefaultValue: false, showElements: true, hiddenFieldTypes: []},
    semantic: {showRequired: true, showAllowMultiple: true, showDefaultValue: true, showElements: false, hiddenFieldTypes: []},
    modular: {showRequired: true, showAllowMultiple: true, showDefaultValue: true, showElements: true, hiddenFieldTypes: []},
  },
};
const designer = page => page.locator('#editor > *');
/** Announce a change of preferences as the designer does. */
const announce = (page, preferences) => designer(page).evaluate((element, detail) => {
  element.dispatchEvent(new CustomEvent('preferencesChange', {detail}));
}, preferences);
/** The preferences the host assigned to the designer on this page, or null when it assigned none. */
const supplied = page => designer(page).evaluate(element => element.preferences ?? null);
const stored = (page, at = KEY) => page.evaluate(name => localStorage.getItem(name), at);
/** Put entries into the browser's storage before the page's own scripts run. */
const seed = (page, entries) => page.addInitScript(values => {
  // The blank document a new tab starts on has no storage to seed.
  try { for (const [name, value] of values) localStorage.setItem(name, value); } catch { /* not this document */ }
}, entries);

for (const kind of ['template', 'element']) {
  test(`${kind}: keeps the preferences the designer announces and supplies them to later pages`, async ({page}) => {
    await host(page, kind);
    expect(await supplied(page)).toBeNull();
    expect(await stored(page)).toBeNull();

    await announce(page, CHOSEN);
    expect(JSON.parse(await stored(page))).toEqual(CHOSEN);

    await page.reload();
    await expect(page.locator('#state')).toHaveText(text('en', 'State.Unmodified'));
    expect(await supplied(page)).toEqual(CHOSEN);

    // The preferences belong to the author, so a new document opens in them as the saved one did.
    await page.goto(`${ORIGIN}/${kind}s/create`);
    await expect(page.locator('#editor')).toBeVisible({timeout: 15000});
    expect(await supplied(page)).toEqual(CHOSEN);

    // A later choice replaces the earlier one.
    await announce(page, {...CHOSEN, showRequired: true});
    expect(JSON.parse(await stored(page))).toEqual({...CHOSEN, showRequired: true});
  });
}

// CED applies an assignment made before it is connected to its first render. One made afterwards
// would show the author the default controls for a moment and then replace them.
test('supplies stored preferences before the designer is connected', async ({page}) => {
  await seed(page, [[KEY, JSON.stringify(CHOSEN)]]);
  await page.addInitScript(() => {
    const define = customElements.define.bind(customElements);
    customElements.define = (name, constructor, options) => {
      if (name === 'cedar-embeddable-designer') {
        const connected = constructor.prototype.connectedCallback;
        constructor.prototype.connectedCallback = function () {
          window.__preferencesAtConnection = this.preferences ?? null;
          connected?.call(this);
        };
      }
      define(name, constructor, options);
    };
  });

  await host(page);

  expect(await page.evaluate(() => window.__preferencesAtConnection)).toEqual(CHOSEN);
});

test("leaves another account's and another deployment's preferences where they are", async ({page}) => {
  const others = [key(`${ORIGIN}/api`, 'another'), key('https://resource.other.test/api', 'user')];
  const theirs = JSON.stringify({...CHOSEN, fieldSelectionStyle: 'inline'});
  await seed(page, others.map(name => [name, theirs]));

  await host(page);
  expect(await supplied(page)).toBeNull();

  await announce(page, CHOSEN);
  expect(JSON.parse(await stored(page))).toEqual(CHOSEN);
  for (const name of others) expect(await stored(page, name)).toBe(theirs);
});

for (const [name, raw] of [['text that is not JSON', 'not json'], ['a list', '[1,2]']]) {
  test(`opens in the designer's own preferences when the stored value is ${name}`, async ({page}) => {
    await seed(page, [[KEY, raw]]);

    await host(page);

    expect(await supplied(page)).toBeNull();
    await expect(page.locator('#message')).toHaveText('');
    await announce(page, CHOSEN);
    expect(JSON.parse(await stored(page))).toEqual(CHOSEN);
  });
}

// Preferences are a convenience. A browser that refuses to keep them must not cost the author the
// page, and nothing on the page should say so, as the notice for a draft that cannot be kept does.
test('opens and keeps working when the browser refuses to store preferences', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const refusing = original => function (name, ...rest) {
      if (String(name).startsWith('cedar.designer.preferences:')) throw new DOMException('Denied', 'SecurityError');
      return original.call(this, name, ...rest);
    };
    Storage.prototype.getItem = refusing(Storage.prototype.getItem);
    Storage.prototype.setItem = refusing(Storage.prototype.setItem);
  });

  await host(page);
  expect(await supplied(page)).toBeNull();
  await announce(page, CHOSEN);

  await expect(page.locator('#state')).toHaveText(text('en', 'State.Unmodified'));
  await expect(page.locator('#message')).toHaveText('');
  await expect(page.locator('#draft-storage-error')).toBeHidden();
  expect(errors).toEqual([]);
});

// The whole exchange with the designer the host installs: a choice made in its Preferences dialog
// reaches the browser's storage through the host, and the next page opens with it. The interface
// arrived in CED after 0.1.3, so a host whose installed designer predates it has nothing to run this
// against. The case names that reason when it is left out, and runs as soon as the designer has it.
const {CedarBuilders, CedarWriters} = model;
const BUNDLE = resolve(fileURLToPath(new URL('../../', import.meta.url)),
  process.env.CEDAR_CED_BUNDLE ?? 'node_modules/cedar-embeddable-designer/cedar-embeddable-designer.js');
const DESIGNER_HAS_PREFERENCES = readFileSync(BUNDLE, 'utf8').includes('preferencesChange');
const ITEM = '5f0d8c3e-2b7a-4c1e-9d6f-3a8b7c2e1f40';
function storedTemplate() {
  const value = CedarBuilders.templateBuilder().withSchemaName('Study').withDescription('Study schema').build();
  const child = CedarBuilders.textFieldBuilder().withSchemaName('Value').withDescription('Value schema').build();
  value.addChild(child, child.createDeploymentBuilder('Value').build());
  const source = CedarWriters.json().getStrict().getWriterForArtifact(value).getAsJsonNode(value);
  source['@id'] = `https://repo.designer.test/templates/${ITEM}`;
  return source;
}
async function openPreferences(page) {
  const real = page.locator('cedar-embeddable-designer');
  await real.locator('.user-menu-container button').first().click();
  await real.getByRole('button', {name: 'Preferences', exact: true}).click();
  const dialog = real.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}
const emailType = dialog => dialog.getByRole('group', {name: 'Visible field types'}).getByRole('checkbox', {name: 'Email', exact: true});
const requiredOption = dialog => dialog.getByRole('checkbox', {name: /Show "Required" checkbox/});

test('the real designer: what the author chooses in its dialog is there after a reload', async ({page}) => {
  test.skip(!DESIGNER_HAS_PREFERENCES, 'The installed designer predates the preferences interface.');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await host(page, 'template', 'edit', true, {designerBundle: BUNDLE, loadedArtifact: storedTemplate(), item: ITEM});
  const real = page.locator('cedar-embeddable-designer');
  // Opening is not a change, so nothing is stored until the author chooses something.
  expect(await stored(page)).toBeNull();

  const dialog = await openPreferences(page);
  await expect(emailType(dialog)).toBeChecked();
  await emailType(dialog).uncheck();
  await requiredOption(dialog).uncheck();
  await expect.poll(async () => JSON.parse(await stored(page) ?? 'null'))
    .toMatchObject({hiddenFieldTypes: ['email'], showRequired: false, fieldSelectionStyle: 'inline'});
  await real.getByRole('button', {name: 'Done', exact: true}).click();
  // A preference is not a change to the document, so nothing is unsaved and the reload asks nothing.
  await expect(page.locator('#state')).toHaveText(text('en', 'State.Unmodified'));

  await page.reload();
  await expect(page.locator('#state')).toHaveText(text('en', 'State.Unmodified'));
  expect(await real.evaluate(element => element.preferences)).toMatchObject({hiddenFieldTypes: ['email'], showRequired: false});
  const restored = await openPreferences(page);
  await expect(emailType(restored)).not.toBeChecked();
  await expect(requiredOption(restored)).not.toBeChecked();
  await expect(restored.getByRole('checkbox', {name: /Show "Allow multiple" checkbox/})).toBeChecked();
  expect(errors).toEqual([]);
});
