import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// This guard fails when a user-visible string bypasses the translation maps. It reads the
// served HTML and the host modules as text, so a new string is caught without running the
// host. Deliberate exceptions live in i18n-allowlist.json with a reason each; an entry that
// no longer matches a finding also fails, so the list cannot accumulate stale exceptions.

const app = new URL('../app/', import.meta.url);
const letter = /\p{L}/u;

// HTML attributes that browsers show or announce. Each one is exempt only when the element
// also carries data-i18n-<attribute>, which the host uses to fill it from the maps.
const htmlAttributes = ['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'label'];

// JavaScript sinks that reach the user in this host. A string literal with a letter in the
// right-hand side of one of these property assignments, or in the arguments of one of these
// calls, is a finding. A literal inside a t() call passes. A literal inside any other nested
// call is an argument to that function, such as an icon name, and is not display text.
const propertySinks = ['textContent', 'innerText', 'innerHTML', 'title', 'placeholder', 'ariaLabel', 'ariaDescription', 'alt', 'label'];
const callSinks = {
  message: 'the host status line',
  confirm: 'a browser confirmation dialog',
  alert: 'a browser alert dialog',
  Error: 'an error message, which the host displays in its status line',
  super: 'the BackendError message, which the host displays in its status line',
};

export function htmlFindings(source) {
  const findings = [];
  const html = source.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '<$1></$1>');
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack = [];
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|<!doctype[^>]*>/gi;
  let last = 0;
  const text = chunk => {
    const content = chunk.replace(/&(?:[a-z]+|#\d+|#x[\da-f]+);/gi, ' ').trim();
    if (letter.test(content) && !stack.at(-1)?.attributes.has('data-i18n')) findings.push(content.replace(/\s+/g, ' '));
  };
  for (const match of html.matchAll(tag)) {
    text(html.slice(last, match.index));
    last = match.index + match[0].length;
    if (!match[2]) continue;
    const name = match[2].toLowerCase();
    if (match[1]) { while (stack.length && stack.pop().name !== name); continue; }
    const attributes = new Map([...match[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
      .map(([, key, a, b, c]) => [key.toLowerCase(), a ?? b ?? c ?? '']));
    for (const attribute of htmlAttributes) {
      const value = attributes.get(attribute);
      if (value && letter.test(value) && !attributes.has(`data-i18n-${attribute}`)) findings.push(`${attribute}="${value}"`);
    }
    if (!voids.has(name) && !match[4]) stack.push({ name, attributes });
  }
  text(html.slice(last));
  return findings;
}

// The tokenizer understands comments, strings, template literals and regular expression
// literals well enough for these modules. A template literal becomes a string token for its
// static text, followed by its interpolations as bracketed groups of ordinary tokens.
function tokenize(source) {
  const tokens = [];
  const regexAfter = /[(,=:[!&|?{};+\-*%<>~^]$|^$|\b(?:return|typeof|case|throw|await)$/;
  let i = 0;
  const previous = () => tokens.at(-1)?.value ?? '';
  function template() {
    let text = '';
    const inner = [];
    i++;
    while (i < source.length && source[i] !== '`') {
      if (source[i] === '\\') { text += source.slice(i, i + 2); i += 2; continue; }
      if (source.startsWith('${', i)) {
        i += 2;
        let depth = 1, start = i;
        while (depth) {
          if (source[i] === '`') { skipTemplate(); continue; }
          if (source[i] === '{') depth++;
          if (source[i] === '}') depth--;
          i++;
        }
        inner.push({ type: 'punct', value: '(' }, ...tokenize(source.slice(start, i - 1)), { type: 'punct', value: ')' });
        continue;
      }
      text += source[i++];
    }
    i++;
    tokens.push({ type: 'string', value: text }, ...inner);
  }
  function skipTemplate() {
    i++;
    while (source[i] !== '`') i += source[i] === '\\' ? 2 : 1;
    i++;
  }
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('//', i)) { i = source.indexOf('\n', i) + 1 || source.length; continue; }
    if (source.startsWith('/*', i)) { i = source.indexOf('*/', i + 2) + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      tokens.push({ type: 'string', value: source.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === '`') { template(); continue; }
    if (c === '/' && regexAfter.test(previous())) {
      let j = i + 1, klass = false;
      while (klass || source[j] !== '/') {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') klass = true;
        else if (source[j] === ']') klass = false;
        j++;
      }
      j++;
      while (/[a-z]/.test(source[j])) j++;
      tokens.push({ type: 'regex', value: source.slice(i, j) });
      i = j;
      continue;
    }
    const word = /^[\p{L}_$][\p{L}\p{N}_$]*|^\d[\w.]*/u.exec(source.slice(i, i + 200));
    if (word) { tokens.push({ type: 'word', value: word[0] }); i += word[0].length; continue; }
    const punct = /^(?:\?\.|===|!==|==|!=|=>|&&|\|\||\?\?|\.\.\.|[^\s])/.exec(source.slice(i, i + 3));
    tokens.push({ type: 'punct', value: punct[0] });
    i += punct[0].length;
  }
  return tokens;
}

const opens = { '(': ')', '[': ']', '{': '}' };
function closing(tokens, start) {
  let depth = 0;
  for (let j = start; j < tokens.length; j++) {
    if (tokens[j].type !== 'punct') continue;
    if (opens[tokens[j].value]) depth++;
    else if (Object.values(opens).includes(tokens[j].value) && --depth === 0) return j;
  }
  return tokens.length;
}

// Collects letter-bearing literals in tokens[start, end), skipping the arguments of calls.
function literals(tokens, start, end, found) {
  for (let j = start; j < end; j++) {
    const token = tokens[j];
    if (token.type === 'string' && letter.test(token.value)) found.push(token.value);
    if (token.type === 'word' && tokens[j + 1]?.value === '(' && !['if', 'while', 'for', 'switch'].includes(token.value)) {
      j = closing(tokens, j + 1);
    }
  }
}

export function scriptFindings(source) {
  const tokens = tokenize(source);
  const found = [];
  for (let j = 0; j < tokens.length; j++) {
    const token = tokens[j];
    if (token.type !== 'word') continue;
    const before = tokens[j - 1]?.value;
    if (propertySinks.includes(token.value) && (before === '.' || before === '?.') && tokens[j + 1]?.value === '=') {
      let end = j + 2, depth = 0;
      for (; end < tokens.length; end++) {
        const value = tokens[end].type === 'punct' ? tokens[end].value : null;
        if (opens[value]) depth++;
        else if (Object.values(opens).includes(value) && --depth < 0) break;
        else if (depth === 0 && (value === ';' || value === ',')) break;
      }
      literals(tokens, j + 2, end, found);
    } else if (callSinks[token.value] && tokens[j + 1]?.value === '(' && before !== 'function' &&
      (before !== '.' || tokens[j - 2]?.value === 'window') && (token.value !== 'Error' || before === 'new')) {
      literals(tokens, j + 2, closing(tokens, j + 1), found);
    }
  }
  return found;
}

async function allFindings() {
  const findings = [];
  for (const name of (await readdir(app)).filter(name => name.endsWith('.html')).sort()) {
    for (const text of htmlFindings(await readFile(new URL(name, app), 'utf8'))) findings.push({ file: `app/${name}`, text });
  }
  const scripts = new URL('scripts/', app);
  for (const name of (await readdir(scripts)).filter(name => name.endsWith('.mjs') && !name.includes('.test.')).sort()) {
    for (const text of scriptFindings(await readFile(new URL(name, scripts), 'utf8'))) findings.push({ file: `app/scripts/${name}`, text });
  }
  return findings;
}

test('the scanners recognize each sink and each exemption', () => {
  assert.deepEqual(htmlFindings('<p>Hello</p><p data-i18n="A">Hi</p><!-- note --><script>x("text")</script><b title="Tip" data-i18n="B">x</b><i alt="Pic" data-i18n-alt="C" data-i18n="D">y</i> &nbsp; '),
    ['Hello', 'title="Tip"']);
  assert.deepEqual(scriptFindings(`a.textContent = b ? 'One' : t('Key'); window.confirm("Two"); throw new Error(\`Three \${x}\`);
    message(t('K', { v: 'param' })); el.innerHTML = iconSvg('back'); function message(text) {} x.message('ignored'); const s = /'/; super('Four');`),
    ['One', 'Two', 'Three ', 'Four']);
});

test('every user-visible string goes through the translation maps', async () => {
  const allowed = JSON.parse(await readFile(new URL('i18n-allowlist.json', import.meta.url), 'utf8'));
  for (const entry of allowed) assert.ok(entry.file && entry.text && entry.reason?.trim(), `Allow-list entries need a file, text and reason: ${JSON.stringify(entry)}`);
  const findings = await allFindings();
  const key = entry => `${entry.file}\u0000${entry.text}`;
  const allowedKeys = new Set(allowed.map(key));
  const unlisted = findings.filter(finding => !allowedKeys.has(key(finding)));
  const stale = allowed.filter(entry => !findings.some(finding => key(finding) === key(entry)));
  assert.deepEqual(unlisted, [], `Untranslated user-visible strings (${unlisted.length}). Move each into app/i18n/*.json, or allow-list it with a reason.`);
  assert.deepEqual(stale, [], 'Allow-list entries that no longer match anything must be removed.');
});
