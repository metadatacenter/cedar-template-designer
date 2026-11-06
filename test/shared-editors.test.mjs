import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrationInputs, sha256 } from '../scripts/shared-editors.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ced-shared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'node_modules/component');
  await mkdir(dir, { recursive: true });
  const runtime = join(root, 'node_modules/@angular/core');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ version: '22.2.4' }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'component', version: '1.0.0' }));
  const bytes = Buffer.from('import "@angular/core";');
  await writeFile(join(dir, 'integration.mjs'), bytes);
  const manifest = { format: 'cedar-integration', version: 1, bytes: bytes.length, sha256: sha256(bytes), runtimes: { '@angular/core': { version: '22.2.4' } } };
  const save = () => writeFile(join(dir, 'integration-manifest.json'), JSON.stringify(manifest));
  await save();
  return { root, dir, manifest, save };
}
test('integration inputs record the compiled module identity', async t => {
  const { root, manifest } = await fixture(t);
  const { inputs } = await integrationInputs(root, ['component']);
  assert.equal(inputs.component.bundle, 'integration.mjs');
  assert.equal(inputs.component.sha256, manifest.sha256);
});
test('a changed module is refused before building or staging', async t => {
  const { root, dir } = await fixture(t);
  await writeFile(join(dir, 'integration.mjs'), '// tampered');
  await assert.rejects(integrationInputs(root, ['component']), /published manifest/);
});
test('a component compiled against another Angular version cannot share this runtime', async t => {
  const { root, manifest, save } = await fixture(t);
  manifest.runtimes['@angular/core'].version = '22.2.5';
  await save();
  await assert.rejects(integrationInputs(root, ['component']), /same @angular\/core runtime/);
});
