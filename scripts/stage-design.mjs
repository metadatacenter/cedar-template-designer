import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const tokens = root => resolve(root, 'node_modules/@org.metadatacenter/cedar-design-tokens/dist');
/**
 * Whether the installed design tokens publish the compiled CEDAR fonts. When they do, the page
 * registers the faces once from fonts.css and each component is staged in its host-fonts bundle.
 */
export const hostFonts = root => existsSync(resolve(tokens(root), 'fonts.css'));
// An older token package has no fonts.css. The page then links this, and each component keeps its own faces.
const noFonts = '/* The installed design tokens publish no fonts.css, so each component registers its own faces. */\n';
export async function stageDesign(root) {
  const source = tokens(root);
  const destination = resolve(root, 'app/components');
  const files = await Promise.all(['icons.js', 'custom-properties.css', 'motion.css', 'icon-contract.css', 'save-state.css', 'tooltip.css', 'notice.css', 'secondary-action.css', 'focus.css'].map(async name => [name, await readFile(resolve(source, name))]));
  files.push(['fonts.css', hostFonts(root) ? await readFile(resolve(source, 'fonts.css')) : Buffer.from(noFonts)]);
  await mkdir(destination, {recursive: true});
  for (const [name, bytes] of files) await writeFile(resolve(destination, name), bytes);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageDesign(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
