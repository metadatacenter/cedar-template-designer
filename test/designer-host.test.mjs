import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { configure, staticServer, writeBuildInfo } from '../scripts/designer.mjs';

const commit = 'a'.repeat(40);
const environment = (overrides = {}) => ({
  CEDAR_FRONTEND_TARGET: 'local',
  CEDAR_FRONTEND_local_REST_HOST: 'metadatacenter.orgx',
  CEDAR_FRONTEND_local_UI_HOST: 'metadatacenter.orgx',
  CEDAR_FRONTEND_BEHAVIOR: 'server',
  CEDAR_VERSION: '2.9.21-SNAPSHOT',
  CEDAR_SOURCE_COMMIT: commit,
  ...overrides,
});

async function workspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'designer-host-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

test('configure writes the endpoints and globals the host reads', async (t) => {
  const base = await workspace(t);

  await configure(base, environment({ CEDAR_WORKSPACE_FRONTEND_URL: 'https://workspace.metadatacenter.orgx' }));

  assert.deepEqual(JSON.parse(await readFile(join(base, 'app/config/host.json'), 'utf8')), {
    resourceRestAPI: 'https://resource.metadatacenter.orgx',
    userRestAPI: 'https://user.metadatacenter.orgx',
    terminologyBaseUrl: 'https://terminology.metadatacenter.orgx/',
    bridgeBaseUrl: 'https://bridge.metadatacenter.orgx/',
    workspaceFrontend: 'https://workspace.metadatacenter.orgx',
  });
  assert.equal(await readFile(join(base, 'app/config/version.js'), 'utf8'), [
    `window.cedarSourceCommit = "${commit}";`,
    'window.cedarDevelopmentMode = false;',
    'window.cedarAuthUrl = "https://auth.metadatacenter.orgx";',
    `window.cedarCacheControl = "2.9.21-SNAPSHOT-${commit}";`,
  ].join('\n') + '\n');
});

test('a local target with no Workspace URL points at the local Workspace', async (t) => {
  const base = await workspace(t);

  await configure(base, environment());

  assert.equal(JSON.parse(await readFile(join(base, 'app/config/host.json'), 'utf8')).workspaceFrontend,
    'http://localhost:4201');
});

test('configure refuses an environment the CEDAR profile has not set', async (t) => {
  const base = await workspace(t);

  await assert.rejects(configure(base, environment({ CEDAR_FRONTEND_local_REST_HOST: '' })),
    /Source the CEDAR profile/);
});

test('the development server answers routes with index.html and missing assets with 404', async (t) => {
  const base = await workspace(t);
  await mkdir(join(base, 'app/scripts'), { recursive: true });
  await writeFile(join(base, 'app/index.html'), '<!doctype html><title>Designer</title>');
  await writeFile(join(base, 'app/scripts/host.mjs'), 'export {};');
  await writeFile(join(base, 'app/.env'), 'secret');
  const server = staticServer(join(base, 'app'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;

  const route = await fetch(url('/templates/edit/https%3A%2F%2Frepo.metadatacenter.orgx%2Ftemplates%2Fabc'));
  assert.equal(route.status, 200);
  assert.equal(route.headers.get('content-type'), 'text/html');
  assert.match(await route.text(), /<title>Designer<\/title>/);

  const script = await fetch(url('/scripts/host.mjs'));
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript');

  assert.equal((await fetch(url('/scripts/missing.mjs'))).status, 404);
  assert.equal((await fetch(url('/.env'))).status, 403);
  assert.equal((await fetch(url('/'), { method: 'POST' })).status, 405);
});

test('a development start records the commit, dirty state and served tree it serves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'designer-build-info-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd: dir, encoding: 'utf8' }).trim();
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    assert.equal(await writeBuildInfo(dir, {}), null);
    await mkdir(join(dir, 'app/config'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"version":"9.9.9"}');
    await writeFile(join(dir, 'app/index.html'), '<html></html>');
    await writeFile(join(dir, 'app/a b.js'), 'a');
    await writeFile(join(dir, 'app/config/build-info.json'), '{"stale":true}');
    git('init', '-q');
    git('add', 'package.json', 'app/index.html', 'app/a b.js');
    git('commit', '-q', '-m', 'fixture');
    const info = await writeBuildInfo(dir, { CEDAR_VERSION_MODIFIER: '-x' });
    const manifest = `${digest('a')}  app/a b.js\n${digest('<html></html>')}  app/index.html\n`;
    assert.deepEqual(info, {
      application: 'cedar-template-designer', version: '9.9.9', versionModifier: '-x',
      sourceCommit: git('rev-parse', 'HEAD'), sourceDirty: false, bundleSha256: digest(manifest),
    });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'app/config/build-info.json'), 'utf8')), info);
    await writeFile(join(dir, 'app/index.html'), '<html>edited</html>');
    assert.equal((await writeBuildInfo(dir, {})).sourceDirty, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
