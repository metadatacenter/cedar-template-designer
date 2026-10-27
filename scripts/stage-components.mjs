import { stagePolicy } from './stage-policy.mjs';
import { hostFonts } from './stage-design.mjs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const components = {
  'cedar-embeddable-designer': 'CEDAR_CED_BUNDLE',
  'cedar-embeddable-editor': 'CEDAR_CEE_BUNDLE',
  'cedar-embeddable-term-picker': 'CEDAR_CETP_BUNDLE',
};
const exists = path => access(path).then(() => true, () => false);
/**
 * The bundle of an installed package to serve. When the page registers the CEDAR fonts itself, a
 * package that ships a host-fonts bundle is staged in that one, so the page downloads the faces once
 * rather than once per component. An older package without one is staged self-contained.
 */
async function packageBundle(packageDir, name, fontsFromHost) {
  const hosted = `${name}.host-fonts.js`;
  return fontsFromHost && await exists(resolve(packageDir, hosted))
    ? { file: hosted, manifest: 'bundle-manifest.host-fonts.json' }
    : { file: `${name}.js`, manifest: 'bundle-manifest.json' };
}
export async function stageComponents(root, env = process.env) {
  const staged = [];
  const fontsFromHost = hostFonts(root);
  for (const [name, overrideKey] of Object.entries(components)) {
    const override = env[overrideKey];
    if (override && env.CEDAR_FRONTEND_BEHAVIOR === 'server') {
      throw new Error(`${overrideKey} is a local development override; server payloads require the locked package.`);
    }
    const packageDir = resolve(root, 'node_modules', name);
    const bundle = await packageBundle(packageDir, name, fontsFromHost);
    const from = override ? resolve(root, override) : resolve(packageDir, bundle.file);
    let bytes;
    try { bytes = await readFile(from); } catch { throw new Error(`Missing ${name} bundle. Run npm ci or set ${overrideKey} for local development.`); }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let identity = { source: 'local-override', sha256 };
    if (!override) {
      const metadata = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
      let published;
      try { published = JSON.parse(await readFile(resolve(packageDir, bundle.manifest), 'utf8')); } catch { published = {}; }
      if (published.sha256 !== sha256 || published.bytes !== bytes.length) {
        throw new Error(`${name} does not match its published bundle manifest. Reinstall the locked package.`);
      }
      // Served as <name>.js either way. `bundle` names the package file the bytes came from.
      identity = { source: 'package', name: metadata.name, version: metadata.version, bundle: bundle.file, sha256 };
    }
    staged.push({ name, bytes, identity });
  }
  await stagePolicy(root);
  // Validate every input before replacing any served bundle.
  const destination = resolve(root, 'app/components');
  await mkdir(destination, { recursive: true });
  const manifest = {};
  for (const { name, bytes, identity } of staged) {
    await writeFile(resolve(destination, `${name}.js`), bytes);
    manifest[name] = identity;
    console.log(`${name}: ${identity.version || 'local override'}${identity.bundle?.endsWith('.host-fonts.js') ? ', host fonts' : ''} (${identity.sha256.slice(0, 12)})`);
  }
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageComponents(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
