import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stageDesign} from '../scripts/stage-design.mjs';
test('stages shared icon geometry and size tokens together', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ced-design-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'node_modules/@org.metadatacenter/cedar-design-tokens/dist');
  await mkdir(source, {recursive: true});
  for (const name of ['icons.js', 'custom-properties.css', 'motion.css']) await writeFile(join(source, name), name);
  await stageDesign(root);
  for (const name of ['icons.js', 'custom-properties.css', 'motion.css']) assert.equal(await readFile(join(root, 'app/components', name), 'utf8'), name);
});
test('a missing token package fails before replacing served assets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ced-design-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'app/components'), {recursive: true});
  await writeFile(join(root, 'app/components/icons.js'), 'previous');
  await assert.rejects(stageDesign(root), /ENOENT/);
  assert.equal(await readFile(join(root, 'app/components/icons.js'), 'utf8'), 'previous');
});
