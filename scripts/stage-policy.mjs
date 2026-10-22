import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function stagePolicy(root) {
  const source = resolve(root, 'node_modules/cedar-model-typescript-library');
  const bytes = await readFile(resolve(source, 'policy.esm.js'));
  const metadata = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
  const destination = resolve(root, 'app/components');
  await mkdir(destination, { recursive: true });
  await writeFile(resolve(destination, 'cedar-validation-policy.mjs'), bytes);
  const schema = await readFile(resolve(source, 'schema.esm.js'));
  await writeFile(resolve(destination, 'cedar-schema-validation.mjs'), schema);
  const identity = {name: metadata.name, version: metadata.version, sha256: createHash('sha256').update(bytes).digest('hex'),
    schemaSha256: createHash('sha256').update(schema).digest('hex')};
  await writeFile(resolve(destination, 'policy-manifest.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await stagePolicy(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
