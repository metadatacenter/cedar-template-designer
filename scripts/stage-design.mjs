import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function stageDesign(root) {
  const source = resolve(root, 'node_modules/@org.metadatacenter/cedar-design-tokens/dist');
  const destination = resolve(root, 'app/components');
  const files = await Promise.all(['icons.js', 'custom-properties.css', 'motion.css'].map(async name => [name, await readFile(resolve(source, name))]));
  await mkdir(destination, {recursive: true});
  for (const [name, bytes] of files) await writeFile(resolve(destination, name), bytes);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageDesign(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
