/** Budget the manifest-driven page, counting shared deliveries once and legacy fallback separately. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { sha256 } from './shared-editors.mjs';

export async function pageSize(root) {
  const app = resolve(root, 'app'), files = new Map();
  async function add(path, phase = 'initial', digest) {
    const absolute = resolve(app, path);
    if (!absolute.startsWith(app + '/')) throw new Error(`Invalid page asset: ${path}`);
    const bytes = await readFile(absolute);
    if (digest && sha256(bytes) !== digest) throw new Error(`Served component differs from manifest: ${path}`);
    if (files.has(path)) return;
    files.set(path, { path, phase, bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, sha256: sha256(bytes) });
    if (path.endsWith('.css')) for (const match of bytes.toString().matchAll(/@import\s+['"]([^'"]+)['"]/g))
      await add(relative(app, resolve(dirname(absolute), match[1])), phase);
    if (path.endsWith('.css')) for (const match of bytes.toString().matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
      if (match[1].startsWith('data:') || !/\.woff2(?:[?#]|$)/.test(match[1])) continue;
      if (/^(?:[a-z]+:|\/\/)/i.test(match[1])) throw new Error(`Unmeasured remote font: ${match[1]}`);
      await add(relative(app, resolve(dirname(absolute), match[1].split(/[?#]/)[0])), 'deferred');
    }
  }
  async function scripts(dir) {
    for (const entry of await readdir(resolve(app, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await scripts(path);
      else if (/\.[cm]?js$/.test(path)) await add(path);
    }
  }
  // All host scripts are initial imports today. Counting the directory also prevents a new
  // host module escaping the budget, while the browser test proves observed requests are covered.
  await scripts('scripts');
  await add('styles/host.css');
  await add('components/icons.js');
  await add('components/cedar-validation-policy.mjs');
  const manifest = JSON.parse(await readFile(resolve(app, 'components/manifest.json'), 'utf8'));
  const shared = Object.values(manifest).every(entry => entry.bundle === 'integration.mjs');
  for (const [name, entry] of Object.entries(manifest)) {
    const file = entry.delivery?.file ?? `${name}.js`;
    if (!/^[\w-]+\.js$/.test(file)) throw new Error(`Invalid component filename: ${file}`);
    await add(`components/${file}`, 'initial', entry.delivery?.sha256 ?? entry.sha256);
  }
  await add('components/cedar-schema-validation.mjs', 'deferred');
  const sum = phase => [...files.values()].filter(file => !phase || file.phase === phase)
    .reduce((total, file) => ({ bytes: total.bytes + file.bytes, gzip: total.gzip + file.gzip }), { bytes: 0, gzip: 0 });
  const report = { mode: shared ? 'shared' : 'standalone', initial: sum('initial'), total: sum(), files: [...files.values()] };
  const limits = shared ? { initial: [4000000, 1000000], total: [4500000, 1150000] }
    : { initial: [5200000, 1300000], total: [5700000, 1450000] };
  for (const phase of ['initial', 'total']) {
    const [bytes, gzip] = limits[phase];
    if (report[phase].bytes > bytes || report[phase].gzip > gzip)
      throw new Error(`Designer ${report.mode} ${phase} exceeds page budget: ${JSON.stringify(report[phase])}; limits ${bytes}/${gzip}`);
  }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const report = await pageSize(root);
  await writeFile(resolve(root, 'app/components/page-size.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Designer ${report.mode}: initial ${report.initial.bytes} raw / ${report.initial.gzip} gzip; total ${report.total.bytes} / ${report.total.gzip}`);
}
