import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stageComponents } from '../scripts/stage-components.mjs';
const names = ['cedar-embeddable-designer', 'cedar-embeddable-editor', 'cedar-embeddable-term-picker'];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ced-components-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of names) {
    const dir = join(root, 'node_modules', name);
    await mkdir(dir, { recursive: true });
    const bytes = Buffer.from(`// ${name}`);
    await writeFile(join(dir, `${name}.js`), bytes);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@org.metadatacenter/' + name, version: '0.1.0-dev.test' }));
    await writeFile(join(dir, 'bundle-manifest.json'), JSON.stringify({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  }
  const policy = join(root, 'node_modules/cedar-model-typescript-library');
  await mkdir(policy, { recursive: true });
  await writeFile(join(policy, 'policy.esm.js'), 'export const fixture = true;');
  await writeFile(join(policy, 'schema.esm.js'), 'export const schemaFixture = true;');
  await writeFile(join(policy, 'package.json'), JSON.stringify({name: 'cedar-model-typescript-library', version:'1.0.0'}));
  return root;
}
test('stages verified installed packages with published identities', async t => {
  const root = await fixture(t);
  const manifest = await stageComponents(root, {});
  const policy = await readFile(join(root, 'app/components/cedar-validation-policy.mjs'));
  const identity = JSON.parse(await readFile(join(root, 'app/components/policy-manifest.json'), 'utf8'));
  assert.equal(policy.toString(), 'export const fixture = true;');
  const schema = await readFile(join(root, 'app/components/cedar-schema-validation.mjs'));
  assert.equal(schema.toString(), 'export const schemaFixture = true;');
  assert.equal(identity.schemaSha256, createHash('sha256').update(schema).digest('hex'));
  assert.equal(identity.sha256, createHash('sha256').update(policy).digest('hex'));
  for (const name of names) {
    assert.equal(manifest[name].version, '0.1.0-dev.test');
    assert.equal(manifest[name].source, 'package');
    assert.equal(await readFile(join(root, 'app/components', `${name}.js`), 'utf8'), `// ${name}`);
  }
});
test('refuses a tampered package before changing served components', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'node_modules', names[1], `${names[1]}.js`), '// tampered');
  await assert.rejects(stageComponents(root, {}), /published bundle manifest/);
  await assert.rejects(readFile(join(root, 'app/components', `${names[0]}.js`)), { code: 'ENOENT' });
});
test('local overrides are explicit and cannot enter server payloads', async t => {
  const root = await fixture(t);
  const path = join(root, 'local.js');
  await writeFile(path, '// local');
  const manifest = await stageComponents(root, { CEDAR_CED_BUNDLE: path });
  assert.equal(manifest[names[0]].source, 'local-override');
  await assert.rejects(stageComponents(root, { CEDAR_CED_BUNDLE: path, CEDAR_FRONTEND_BEHAVIOR: 'server' }), /locked package/);
});
