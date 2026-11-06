import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { integrationInputs, sha256 } from '../scripts/shared-editors.mjs';
import { modelRuntimeSha256 } from '../scripts/model-runtime.mjs';

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

async function modelFixture(t) {
  const fixtureData = await fixture(t);
  const dir = join(fixtureData.root, 'node_modules/cedar-model-typescript-library');
  await mkdir(join(dir, 'esm'), { recursive: true });
  const metadata = { name: 'cedar-model-typescript-library', version: '1.0.27', module: 'esm/index.js' };
  await writeFile(join(dir, 'package.json'), JSON.stringify(metadata));
  await writeFile(join(dir, 'esm/index.js'), 'export const model = 1;');
  fixtureData.manifest.runtimes['cedar-model-typescript-library'] = {
    version: metadata.version, sha256: 'a'.repeat(64), runtimeSha256: modelRuntimeSha256(dir),
  };
  await fixtureData.save();
  return { ...fixtureData, modelDir: dir, metadata };
}

test('a public component accepts byte-equivalent train model code', async t => {
  const { root, modelDir, metadata } = await modelFixture(t);
  await writeFile(join(modelDir, 'package.json'), JSON.stringify({ ...metadata,
    name: '@org.metadatacenter/cedar-model-typescript-library', version: '1.0.28-dev.20261106.abcdef0',
    publishConfig: { registry: 'https://nexus.bmir.stanford.edu/repository/npm-cedar/', tag: 'dev' },
  }));
  await integrationInputs(root, ['component']);
});

test('changing model ESM code is rejected even at the same version', async t => {
  const { root, modelDir } = await modelFixture(t);
  await writeFile(join(modelDir, 'esm/index.js'), 'export const model = 2;');
  await assert.rejects(integrationInputs(root, ['component']), /same cedar-model-typescript-library runtime/);
});

test('changing model resolver metadata is rejected', async t => {
  const { root, modelDir, metadata } = await modelFixture(t);
  await writeFile(join(modelDir, 'package.json'), JSON.stringify({ ...metadata, sideEffects: false }));
  await assert.rejects(integrationInputs(root, ['component']), /same cedar-model-typescript-library runtime/);
});

test('legacy model manifests still require the exact version', async t => {
  const { root, manifest, save } = await modelFixture(t);
  manifest.runtimes['cedar-model-typescript-library'] = { version: '1.0.26' };
  await save();
  await assert.rejects(integrationInputs(root, ['component']), /same cedar-model-typescript-library runtime/);
});
