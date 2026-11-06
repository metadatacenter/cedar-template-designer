import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pageSize } from '../scripts/check-page-size.mjs';
import { sha256 } from '../scripts/shared-editors.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ced-page-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(path, bytes) {
    const file = join(root, 'app', path);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, bytes);
  }
  for (const name of ['scripts/host.mjs', 'styles/host.css', 'components/icons.js', 'components/cedar-validation-policy.mjs', 'components/cedar-schema-validation.mjs']) await put(name, '// fixture');
  const bytes = Buffer.from('// shared script');
  await put('components/cedar-editors.js', bytes);
  const manifest = Object.fromEntries(['cee', 'ced', 'cetp'].map(name => [name, { bundle: 'integration.mjs', delivery: { file: 'cedar-editors.js', sha256: sha256(bytes) } }]));
  const save = () => put('components/manifest.json', JSON.stringify(manifest));
  await save();
  return { root, put, manifest, save };
}
test('a shared delivery is counted once and the fallback is deferred', async t => {
  const { root } = await fixture(t), report = await pageSize(root);
  assert.equal(report.mode, 'shared');
  assert.equal(report.files.filter(file => file.path.endsWith('/cedar-editors.js')).length, 1);
  assert.equal(report.total.bytes - report.initial.bytes, 10);
});
test('new manifest deliveries cannot escape the page budget', async t => {
  const { root, put, manifest, save } = await fixture(t);
  const bytes = Buffer.alloc(4100000, 'x');
  await put('components/another.js', bytes);
  manifest.another = { bundle: 'integration.mjs', delivery: { file: 'another.js', sha256: sha256(bytes) } };
  await save();
  await assert.rejects(pageSize(root), /exceeds page budget/);
});
test('a stale shared script fails even if it is small enough', async t => {
  const { root, put } = await fixture(t);
  await put('components/cedar-editors.js', '// modified');
  await assert.rejects(pageSize(root), /differs from manifest/);
});
test('external font subsets count toward the total and must exist', async t => {
  const { root, put } = await fixture(t);
  await put('styles/host.css', "@font-face{src:url('../components/fonts/subset.woff2')}");
  await assert.rejects(pageSize(root), /ENOENT/);
  await put('components/fonts/subset.woff2', 'font bytes');
  const report = await pageSize(root);
  assert.equal(report.files.find(file => file.path.endsWith('subset.woff2')).phase, 'deferred');
});
