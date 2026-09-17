import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Explicit paths also accept bundles extracted from future Nexus packages. No npmjs lookup.
const sources = {
  'cedar-embeddable-designer': process.env.CEDAR_CED_BUNDLE || '../cedar-embeddable-designer/dist-bundle/cedar-embeddable-designer.js',
  'cedar-embeddable-editor': process.env.CEDAR_CEE_BUNDLE || '../cedar-embeddable-editor/visual/public/cedar-embeddable-editor.js',
  'cedar-embeddable-term-picker': process.env.CEDAR_CETP_BUNDLE || '../cedar-embeddable-term-picker/dist-bundle/cedar-embeddable-term-picker.js',
};
await mkdir(resolve(root, 'app/components'), { recursive: true });
const manifest = {};
for (const [name, source] of Object.entries(sources)) {
  const from = resolve(root, source);
  try { await stat(from); } catch { throw new Error(`Build ${name} first: missing ${from}`); }
  const contents = await readFile(from);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  await copyFile(from, resolve(root, `app/components/${name}.js`));
  manifest[name] = { sha256 };
  console.log(`${name}: ${contents.length} bytes (${sha256.slice(0, 12)})`);
}
await writeFile(resolve(root, 'app/components/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
