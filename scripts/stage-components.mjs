import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const components = {
  'cedar-embeddable-designer': 'CEDAR_CED_BUNDLE',
  'cedar-embeddable-editor': 'CEDAR_CEE_BUNDLE',
  'cedar-embeddable-term-picker': 'CEDAR_CETP_BUNDLE',
};
export async function stageComponents(root, env = process.env) {
  const staged = [];
  for (const [name, overrideKey] of Object.entries(components)) {
    const override = env[overrideKey];
    if (override && env.CEDAR_FRONTEND_BEHAVIOR === 'server') {
      throw new Error(`${overrideKey} is a local development override; server payloads require the locked package.`);
    }
    const packageDir = resolve(root, 'node_modules', name);
    const from = override ? resolve(root, override) : resolve(packageDir, `${name}.js`);
    let bytes;
    try { bytes = await readFile(from); } catch { throw new Error(`Missing ${name} bundle. Run npm ci or set ${overrideKey} for local development.`); }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let identity = { source: 'local-override', sha256 };
    if (!override) {
      const metadata = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'));
      const published = JSON.parse(await readFile(resolve(packageDir, 'bundle-manifest.json'), 'utf8'));
      if (published.sha256 !== sha256 || published.bytes !== bytes.length) {
        throw new Error(`${name} does not match its published bundle manifest. Reinstall the locked package.`);
      }
      identity = { source: 'package', name: metadata.name, version: metadata.version, sha256 };
    }
    staged.push({ name, bytes, identity });
  }
  // Validate every input before replacing any served bundle.
  const destination = resolve(root, 'app/components');
  await mkdir(destination, { recursive: true });
  const manifest = {};
  for (const { name, bytes, identity } of staged) {
    await writeFile(resolve(destination, `${name}.js`), bytes);
    manifest[name] = identity;
    console.log(`${name}: ${identity.version || 'local override'} (${identity.sha256.slice(0, 12)})`);
  }
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageComponents(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
