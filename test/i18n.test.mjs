import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translations, t, detectLanguage, setLanguage } from '../app/scripts/i18n.mjs';
import { BackendError, saveMessage } from '../app/scripts/host-core.mjs';

// Hungarian entries that may equal their English source. Keep this short; each entry needs a
// reason that holds in Hungarian as well as English.
const sameInBothLanguages = new Map([
]);

function entries(map, prefix = '') {
  return Object.entries(map).flatMap(([key, value]) => typeof value === 'object' && value !== null
    ? entries(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]);
}
const en = new Map(entries(translations.en));
const hu = new Map(entries(translations.hu));
const placeholders = text => [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map(match => match[1]).sort();

test('English and Hungarian define the same ASCII keys with non-blank text', () => {
  assert.deepEqual([...hu.keys()].sort(), [...en.keys()].sort());
  for (const [key, value] of [...en, ...hu]) {
    assert.match(key, /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/, `key ${key}`);
    assert.equal(typeof value, 'string', key);
    assert.ok(value.trim(), `blank text at ${key}`);
    assert.equal(value, value.trim(), `surrounding whitespace at ${key}`);
  }
});

test('Hungarian translates every entry and keeps its placeholders', () => {
  for (const [key, english] of en) {
    if (!sameInBothLanguages.has(key)) assert.notEqual(hu.get(key), english, `${key} is not translated`);
    assert.deepEqual(placeholders(hu.get(key)), placeholders(english), `${key} placeholders`);
  }
  for (const key of sameInBothLanguages.keys()) assert.equal(hu.get(key), en.get(key), `stale allow-list entry ${key}`);
});

test('t() interpolates, falls back to English and then to the key', t_ => {
  t_.after(() => { setLanguage('en'); translations.hu.State.Saving = hu.get('State.Saving'); });
  assert.equal(t('Error.ComponentLoad', { name: 'cedar-embeddable-designer' }),
    'Could not load cedar-embeddable-designer. Rebuild and stage the local components.');
  assert.equal(t('Error.RequestFailed', { status: 500 }), 'Request failed (500). {{detail}}');
  assert.equal(t('No.Such.Key'), 'No.Such.Key');
  assert.equal(t('Header'), 'Header', 'a branch of the map is not a translation');
  setLanguage('hu');
  assert.equal(t('Version.Instances', { count: 3 }), '3 metaadatpéldány használja ezt a sablont. Ezek a módosítások új verziót igényelnek.');
  delete translations.hu.State.Saving;
  assert.equal(t('State.Saving'), 'Saving…');
  assert.equal(t('No.Such.Key'), 'No.Such.Key');
  assert.equal(setLanguage('de'), 'en');
});

test('English text matches the strings the e2e smokes and host tests match', () => {
  setLanguage('en');
  assert.deepEqual(['State.Saved', 'State.Unmodified', 'State.Modified', 'State.ReadOnly', 'State.Saving'].map(key => t(key)),
    ['Saved', 'Unmodified', 'Modified', 'Read only', 'Saving…']);
  assert.match(new BackendError(412).message, /changed since/);
  assert.equal(new BackendError(500, null).message, 'Request failed (500). Your edits have been kept.');
  assert.equal(new BackendError(500, { message: 'Server said no.' }).message, 'Request failed (500). Server said no.');
});

test('backend errors follow the active language', t_ => {
  t_.after(() => setLanguage('en'));
  setLanguage('hu');
  assert.equal(new BackendError(403).message, 'Nincs jogosultsága az artefaktum mentéséhez.');
  assert.equal(new BackendError(403, { errorKey: 'versioningOnlyByOwner' }).message,
    'Új verziót csak a sablon tulajdonosa hozhat létre. A szerkesztései megmaradtak.');
  assert.equal(new BackendError(500).message, 'A kérés sikertelen (500). A szerkesztései megmaradtak.');
});

// A refused save leaves the edits in the designer. Its message says so after the server's message as
// well as without one. The error's own text, which the child picker shows, carries the server's message alone.
test('a refused save says the edits are kept, after the server message when there is one', t_ => {
  t_.after(() => setLanguage('en'));
  const expected = {
    en: ['Request failed (400). Your edits have been kept.', 'Request failed (400). Invalid folder identifier. Your edits have been kept.',
      'Request failed (400). Invalid folder identifier'],
    hu: ['A kérés sikertelen (400). A szerkesztései megmaradtak.', 'A kérés sikertelen (400). Invalid folder identifier. A szerkesztései megmaradtak.',
      'A kérés sikertelen (400). Invalid folder identifier'],
  };
  for (const language of ['en', 'hu']) {
    setLanguage(language);
    const [withoutMessage, withMessage, ownText] = expected[language];
    assert.equal(saveMessage(new BackendError(400, null)), withoutMessage);
    assert.equal(saveMessage(new BackendError(400, {})), withoutMessage);
    assert.equal(saveMessage(new BackendError(400, { message: 'Invalid folder identifier' })), withMessage);
    assert.equal(saveMessage(new BackendError(400, { message: 'Invalid folder identifier.' })), withMessage);
    assert.equal(saveMessage(new BackendError(400, { errorMessage: 'Invalid folder identifier' })), withMessage);
    assert.equal(new BackendError(400, { message: 'Invalid folder identifier' }).message, ownText);
    // A refusal the host names in its own words, and a failure that is not a refusal, keep their text.
    for (const error of [new BackendError(403, { message: 'Server said no' }), new BackendError(412, { message: 'Server said no' }),
      new BackendError(0), new Error('Name the template')]) assert.equal(saveMessage(error), error.message);
  }
});

test('the first supported primary subtag wins, and English is the default', () => {
  assert.equal(detectLanguage(['hu-HU', 'en-US']), 'hu');
  assert.equal(detectLanguage(['de-DE', 'HU', 'en']), 'hu');
  assert.equal(detectLanguage(['de-DE', 'en-GB', 'hu']), 'en');
  assert.equal(detectLanguage(['fr-FR', 'de']), 'en');
  assert.equal(detectLanguage(['hun', 'eng']), 'en');
  assert.equal(detectLanguage([]), 'en');
  assert.equal(detectLanguage(undefined), 'en');
});
