// Configuration, component staging and local static serving for the Template Designer host,
// with nothing beyond Node. gulp and gulp-connect did this before, and brought chokidar 3 and
// braces with them for a watcher the host never used.
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Write the host's runtime configuration from the CEDAR profile's environment. */
export async function configure(base = root, env = process.env) {
  const target = env.CEDAR_FRONTEND_TARGET;
  const restHost = env[`CEDAR_FRONTEND_${target}_REST_HOST`];
  const uiHost = env[`CEDAR_FRONTEND_${target}_UI_HOST`];
  if (!restHost || !uiHost) throw new Error('Source the CEDAR profile before configuring the frontend.');
  const development = env.CEDAR_FRONTEND_BEHAVIOR === 'develop';
  const commit = env.CEDAR_SOURCE_COMMIT
    || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim();
  const output = resolve(base, 'app/config');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'host.json'), JSON.stringify({
    resourceRestAPI: `https://resource.${restHost}`,
    userRestAPI: `https://user.${restHost}`,
    terminologyBaseUrl: `https://terminology.${restHost}/`,
    bridgeBaseUrl: `https://bridge.${restHost}/`,
    workspaceFrontend: env.CEDAR_WORKSPACE_FRONTEND_URL
      || (target === 'local' ? 'http://localhost:4201' : `https://workspace-next.${uiHost}`),
  }, null, 2));
  const globals = {
    cedarVersion: env.CEDAR_VERSION,
    cedarVersionModifier: env.CEDAR_VERSION_MODIFIER || '',
    cedarSourceCommit: commit,
    cedarDevelopmentMode: development,
    cedarAuthUrl: env.CEDAR_AUTH_URL || `https://auth.${uiHost}`,
    cedarCacheControl: `${env.CEDAR_VERSION}-${commit}${development ? '-' + Date.now() : ''}`,
  };
  await writeFile(resolve(output, 'version.js'),
    Object.entries(globals).map(([key, value]) => `window.${key} = ${JSON.stringify(value)};`).join('\n') + '\n');
}

/** Copy the installed component bundles and design files into the tree the host serves. */
export function stage(base = root) {
  for (const script of ['scripts/stage-components.mjs', 'scripts/stage-design.mjs']) {
    execFileSync(process.execPath, [script], { cwd: base, stdio: 'inherit' });
  }
}

const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/**
 * Serve a directory, answering every route that is not a file with its index.html.
 *
 * The designer's routes name the artifact they open, such as /templates/edit/<id>, so a path that
 * names no file is a route rather than a missing asset. A path with an extension that names no
 * file is a missing asset, and answers 404 rather than an HTML page that a script tag would run.
 */
export function staticServer(directory) {
  const base = resolve(directory);
  return createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.includes('\0') || pathname.includes('\\')
          || pathname.split('/').some((part) => part.startsWith('.'))) {
        res.writeHead(403).end();
        return;
      }
      let path = resolve(base, '.' + pathname);
      if (!path.startsWith(base + sep)) path = resolve(base, 'index.html');
      try {
        if (!(await stat(path)).isFile()) throw new Error('Not a file');
      } catch {
        if (extname(pathname.split('/').pop())) {
          res.writeHead(404).end();
          return;
        }
        path = resolve(base, 'index.html');
      }
      if (!(await realpath(path)).startsWith((await realpath(base)) + sep)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(path);
      res.writeHead(200, {
        'Content-Type': mime[extname(path)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': body.length,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(400).end();
    }
  });
}

/**
 * `start` configures, stages, and in development serves app/ on CEDAR_FRONTEND_PORT. A server
 * payload stops after staging: its web server is the image's nginx.
 */
async function main(command) {
  if (!['start', 'configure', 'stage'].includes(command)) {
    throw new Error('Usage: designer.mjs start|configure|stage');
  }
  if (command === 'stage') return stage();
  const behavior = process.env.CEDAR_FRONTEND_BEHAVIOR;
  if (command === 'start' && !['develop', 'server'].includes(behavior)) {
    throw new Error('CEDAR_FRONTEND_BEHAVIOR must be develop or server.');
  }
  await configure();
  if (command === 'configure') return;
  stage();
  if (behavior !== 'develop') return;
  const port = Number(process.env.CEDAR_FRONTEND_PORT || 4202);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CEDAR_FRONTEND_PORT');
  staticServer(resolve(root, 'app')).listen(port, '0.0.0.0', () =>
    console.log(`CEDAR Template Designer development server on port ${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main(process.argv[2]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
