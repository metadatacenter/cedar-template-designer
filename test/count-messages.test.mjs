// Every Designer message that carries a count, at zero, one and two, in English and Hungarian.
//
// A number before a noun needs a singular in English: "Server validation: 1 findings" was what
// one meant. The host keeps that singular under the message's key with `One` appended, as
// Workspace does, and chooses it in one place, `counted` in i18n.mjs. Hungarian keeps a noun
// singular after any number, so its two texts read alike. This fails when a counted message has
// no singular, when its singular still reads as a plural, or when a script picks the form itself.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url).pathname;
const catalogue = async language => JSON.parse(await readFile(join(root, 'app/i18n', `${language}.json`), 'utf8'));
function flatten(node, prefix = '', into = {}) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') flatten(value, path, into); else into[path] = value;
  }
  return into;
}
const texts = { en: flatten(await catalogue('en')), hu: flatten(await catalogue('hu')) };
const NOT_PLURAL = new Set(['is', 'was', 'has', 'its', 'this', 'as']);
function readsPlural(text) {
  for (const match of text.matchAll(/\{\{\s*count\s*\}\}([^.,:;()—–]*)/g))
    if (match[1].trim().split(/\s+/).filter(Boolean).slice(0, 4).some(word => /s$/i.test(word) && !NOT_PLURAL.has(word.toLowerCase())))
      return true;
  return false;
}
const counted = Object.keys(texts.en).filter(key => texts.en[`${key}One`] !== undefined);

test('every English message that counts a plural noun has a singular, in both languages', () => {
  const missing = Object.entries(texts.en)
    .filter(([key, text]) => !key.endsWith('One') && readsPlural(text))
    .filter(([key]) => texts.en[`${key}One`] === undefined || texts.hu[`${key}One`] === undefined)
    .map(([key, text]) => `${key}: ${text}`);
  assert.deepEqual(missing, []);
});

for (const key of counted) for (const language of ['en', 'hu']) for (const count of [0, 1, 2])
  test(`${key} with ${count}, in ${language}`, () => {
    const text = texts[language][count === 1 ? `${key}One` : key];
    assert.equal(typeof text, 'string');
    if (language === 'en' && count === 1) {
      assert.ok(!readsPlural(text), `the singular still reads as a plural: ${text}`);
      assert.notEqual(text, texts.en[key]);
    }
  });

test('no script chooses a singular itself', async () => {
  const sources = [];
  for (const entry of await readdir(join(root, 'app/scripts'))) if (entry.endsWith('.mjs')) sources.push(join(root, 'app/scripts', entry));
  const offenders = [];
  for (const file of sources) {
    const source = await readFile(file, 'utf8');
    for (const key of counted) {
      const leaf = key.split('.').pop();
      if (source.includes(`${leaf}One`)) offenders.push(`${file}: names ${leaf}One`);
      if (new RegExp(`\\bt\\(\\s*['"\`]${key.replace(/\./g, '\\.')}['"\`]`).test(source)) offenders.push(`${file}: translates ${key} without counted`);
    }
  }
  assert.deepEqual(offenders, []);
});
