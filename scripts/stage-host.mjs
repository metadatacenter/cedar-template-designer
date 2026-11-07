import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, realpath} from 'node:fs/promises';
import {resolve, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Keep cache identity tied to emitted bytes, including changed tokens or validation policy. */
export async function writeHostAssetVersion(root) {
  let manifest, version;
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'app/host/manifest.json'), 'utf8'));
    version = await readFile(resolve(root, 'app/config/version.js'), 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const assets = Object.fromEntries(Object.entries(manifest).map(([name, entry]) => [name, `${entry.file}?v=${entry.sha256}`]));
  await writeFile(resolve(root, 'app/config/version.js'), version.replace(/^window\.cedarHostAssets = .*;\n/gm, '')
    + `window.cedarHostAssets = ${JSON.stringify(assets)};\n`);
}

/** One module and one stylesheet, preserving CSS order and the existing hashed font files. */
export async function stageHost(root) {
  const app = await realpath(resolve(root, 'app')), output = resolve(app, 'host');
  const result = await build({
    entryPoints: [resolve(app, 'scripts/host.mjs'), resolve(app, 'styles/host.css')],
    outdir: output, entryNames: '[name]', outExtension: {'.js': '.mjs'},
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    write: false, metafile: true, legalComments: 'inline',
    plugins: [{name: 'existing-host-fonts', setup(builder) {
      builder.onResolve({filter: /\.woff2$/}, args => {
        const file = resolve(args.resolveDir, args.path);
        if (!file.startsWith(resolve(app, 'components/fonts') + '/')) throw new Error(`Unexpected host font: ${file}`);
        return {path: '../' + relative(app, file), external: true};
      });
    }}],
  });
  await mkdir(output, {recursive: true});
  const manifest = {};
  for (const file of result.outputFiles) {
    await writeFile(file.path, file.contents);
    manifest[file.path.endsWith('.css') ? 'style' : 'script'] = {
      file: relative(app, file.path), sha256: createHash('sha256').update(file.contents).digest('hex'),
    };
  }
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeHostAssetVersion(root);
  return result.metafile;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await stageHost(fileURLToPath(new URL('../', import.meta.url)));
