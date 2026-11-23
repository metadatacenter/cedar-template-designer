import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesignerPreferenceStore, preferenceScope } from '../app/scripts/host-preferences.mjs';

// The store keeps what the designer announces and hands it to the next page. It is a convenience,
// so every way storage can fail has to leave the page working: a refusal must never reach the host
// as an exception while it is opening a document.
const preferences = { showRequired: false, showElements: true, fieldSelectionStyle: 'sidebar', hiddenFieldTypes: ['email'],
  presets: { basic: { showElements: true, hiddenFieldTypes: [] } } };
function memory() {
  const entries = new Map();
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}
const scope = preferenceScope('https://resource.example', 'author');

test('what one page writes the next page reads', () => {
  const storage = memory();
  assert.equal(new DesignerPreferenceStore(scope, storage).read(), null);

  assert.equal(new DesignerPreferenceStore(scope, storage).write(preferences), true);

  assert.deepEqual(new DesignerPreferenceStore(scope, storage).read(), preferences);
  assert.deepEqual([...storage.entries.keys()], [`cedar.designer.preferences:${scope}`]);
  // The stored text is the JSON the designer documents its preferences as.
  assert.deepEqual(JSON.parse(storage.entries.get(`cedar.designer.preferences:${scope}`)), preferences);
});

test('a later change replaces the stored preferences', () => {
  const storage = memory(), store = new DesignerPreferenceStore(scope, storage);
  store.write(preferences);
  store.write({ ...preferences, showRequired: true });

  assert.equal(store.read().showRequired, true);
  assert.equal(storage.entries.size, 1);
});

test('storage isolates deployment and account', () => {
  const storage = memory();
  new DesignerPreferenceStore(scope, storage).write(preferences);

  for (const other of [preferenceScope('https://resource.other.example', 'author'), preferenceScope('https://resource.example', 'reader')])
    assert.equal(new DesignerPreferenceStore(other, storage).read(), null);
  // A deployment and an account that only look alike when joined stay apart.
  assert.notEqual(preferenceScope('a', 'b","c'), preferenceScope('a","b', 'c'));
});

for (const [name, raw] of [['text that is not JSON', 'not json'], ['a list', '[1,2]'], ['a string', '"basic"'],
  ['a number', '4'], ['null', 'null'], ['an empty entry', '']])
  test(`a stored value that is ${name} reads as nothing stored`, () => {
    const storage = memory();
    storage.entries.set(`cedar.designer.preferences:${scope}`, raw);

    assert.equal(new DesignerPreferenceStore(scope, storage).read(), null);
  });

test('storage that refuses costs the preferences and nothing more', () => {
  const refuse = () => { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
  const store = new DesignerPreferenceStore(scope, { getItem: refuse, setItem: refuse });

  assert.equal(store.read(), null);
  assert.equal(store.write(preferences), false);
});

test('preferences the designer cannot serialize are not stored', () => {
  const storage = memory(), circular = {};
  circular.self = circular;

  assert.equal(new DesignerPreferenceStore(scope, storage).write(circular), false);
  assert.equal(storage.entries.size, 0);
});

test('the browser keeps preferences beyond the tab, and a browser that withholds storage is survived', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : delete globalThis.localStorage);
  const storage = memory();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage });

  new DesignerPreferenceStore(scope).write(preferences);
  assert.deepEqual(new DesignerPreferenceStore(scope).read(), preferences);

  // A browser with storage disabled throws on the property itself.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Denied', 'SecurityError'); } });
  assert.equal(new DesignerPreferenceStore(scope).read(), null);
  assert.equal(new DesignerPreferenceStore(scope).write(preferences), false);
});
