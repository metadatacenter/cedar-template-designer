import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { modelRuntimeSha256 } from './model-runtime.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function modelDigest(dir) {
  const metadata = await json(resolve(dir, 'package.json'));
  const hash = createHash('sha256');
  async function visit(path) {
    hash.update(relative(dir, path) + '\0');
    if ((await stat(path)).isDirectory()) for (const name of (await readdir(path)).sort()) await visit(resolve(path, name));
    else hash.update(await readFile(path));
    hash.update('\0');
  }
  await visit(resolve(dir, 'package.json'));
  const esm = await stat(resolve(dir, 'esm')).then(() => 'esm', () => metadata.module);
  await visit(resolve(dir, esm));
  return hash.digest('hex');
}

/** Refuse tampered modules or incompatible runtimes before replacing any served bytes. */
export async function integrationInputs(root, names) {
  const inputs = {}, runtimes = {};
  for (const name of names) {
    const dir = resolve(root, 'node_modules', name);
    const manifest = await json(resolve(dir, 'integration-manifest.json'));
    const bytes = await readFile(resolve(dir, 'integration.mjs'));
    if (manifest.format !== 'cedar-integration' || manifest.version !== 1 || manifest.bytes !== bytes.length || manifest.sha256 !== sha256(bytes))
      throw new Error(`${name} integration module does not match its published manifest.`);
    for (const [dependency, expected] of Object.entries(manifest.runtimes)) {
      const installed = resolve(root, 'node_modules', dependency);
      const metadata = await json(resolve(installed, 'package.json'));
      const promotedModel = dependency === 'cedar-model-typescript-library' && expected.runtimeSha256;
      const compatible = promotedModel
        ? /^[a-f0-9]{64}$/.test(expected.runtimeSha256) && modelRuntimeSha256(installed) === expected.runtimeSha256
        : metadata.version === expected.version && (!expected.sha256 || await modelDigest(installed) === expected.sha256);
      if (!compatible)
        throw new Error(`${name} requires the same ${dependency} runtime it was built with (${expected.version}). Rebuild the coordinated frontend sources.`);
      runtimes[dependency] = expected;
    }
    const metadata = await json(resolve(dir, 'package.json'));
    inputs[name] = { source: 'package', name: metadata.name, version: metadata.version, bundle: 'integration.mjs', sha256: manifest.sha256 };
  }
  return { inputs, runtimes };
}

export async function sharedEditors(root, names) {
  const { inputs, runtimes } = await integrationInputs(root, names);
  const tooling = await Promise.all(['package-lock.json', 'angular.json', 'tsconfig.json', 'src/editors.ts', 'src/integration.d.ts', 'scripts/shared-editors.mjs'].map(path => readFile(resolve(root, path))));
  const key = sha256(Buffer.concat([Buffer.from(JSON.stringify({ inputs, runtimes })), ...tooling]));
  const directory = resolve(root, 'dist/editors');
  let previous;
  try { previous = await json(resolve(directory, 'delivery.json')); } catch { /* First build. */ }
  if (previous?.key === key) {
    const bytes = await readFile(resolve(directory, 'cedar-editors.js')).catch(() => null);
    if (bytes && sha256(bytes) === previous.sha256) return { inputs, bytes, delivery: previous };
  }
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/@angular/cli/bin/ng.js'), 'build'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw result.error || new Error('Shared editor build failed');
  const stats = await json(resolve(directory, 'browser-stats.json'));
  for (const dependency of Object.keys(runtimes)) {
    const marker = `node_modules/${dependency}/`;
    const copies = new Set(Object.keys(stats.inputs).filter(path => path.includes(marker)).map(path => path.slice(0, path.lastIndexOf(marker) + marker.length)));
    if (copies.size > 1) throw new Error(`Shared build contains multiple copies of ${dependency}: ${[...copies].join(', ')}`);
  }
  // Angular links the libraries; esbuild flattens its module graph into one side-effecting script.
  const bundled = await build({ entryPoints: [resolve(directory, 'browser/main.js')], bundle: true, format: 'iife', platform: 'browser', minify: true, write: false, legalComments: 'inline' });
  const bytes = Buffer.from(bundled.outputFiles[0].contents);
  const notices = await Promise.all([resolve(directory, '3rdpartylicenses.txt'), ...names.map(name => resolve(root, 'node_modules', name, 'integration-licenses.txt'))].map(path => readFile(path)));
  await writeFile(resolve(directory, 'third-party-licenses.txt'), Buffer.concat(notices.map(bytes => Buffer.concat([bytes, Buffer.from('\n')]))));
  const delivery = { file: 'cedar-editors.js', sha256: sha256(bytes), bytes: bytes.length, key };
  await writeFile(resolve(directory, delivery.file), bytes);
  await writeFile(resolve(directory, 'delivery.json'), JSON.stringify(delivery, null, 2) + '\n');
  return { inputs, bytes, delivery };
}
