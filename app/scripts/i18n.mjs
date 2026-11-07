// Bundled with the host so translations and code always share one content identity.
import en from '../i18n/en.json' with { type: 'json' };
import hu from '../i18n/hu.json' with { type: 'json' };
export const translations = { en, hu };
export const languages = Object.keys(translations);

export let language = 'en';

/** Returns the first preferred language whose primary subtag the host supports, or English. */
export function detectLanguage(preferred) {
  for (const tag of Array.isArray(preferred) ? preferred : []) {
    const primary = String(tag).split('-')[0].toLowerCase();
    if (languages.includes(primary)) return primary;
  }
  return 'en';
}

export function setLanguage(next) {
  language = languages.includes(next) ? next : 'en';
  return language;
}

function lookup(map, key) {
  const value = key.split('.').reduce((node, part) => node?.[part], map);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Translates a dotted key into the active language. A key missing from the active language
 * falls back to English, and a key missing from both returns the key itself. A placeholder
 * without a matching parameter is left as written, as ngx-translate leaves it.
 */
export function t(key, params = {}) {
  const text = lookup(translations[language], key) ?? lookup(translations.en, key) ?? key;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (placeholder, name) => params[name] === undefined ? placeholder : String(params[name]));
}

/**
 * The text for `key` with a number in it, in the singular when the number is one. A message's
 * singular is its key with `One` appended, as in Workspace. Hungarian keeps a noun singular after
 * any number, so its two texts read alike; English needs both.
 */
export function counted(key, count, params = { count }) {
  return t(count === 1 ? `${key}One` : key, params);
}

// Attributes that the host can fill from the maps. An element carrying data-i18n-title, for
// example, receives the translated key as its title attribute.
export const localizedAttributes = ['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'label'];

/**
 * Fills the static text of a document from the maps and sets its language. The HTML keeps the
 * English text as its initial content, so an English page does not change when this runs.
 */
export function localizeDocument(document) {
  document.documentElement.lang = language;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const attribute of localizedAttributes) {
    for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
