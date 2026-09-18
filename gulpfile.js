const gulp = require('gulp');
const connect = require('gulp-connect');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');

function configure(done) {
  const env = process.env;
  const target = env.CEDAR_FRONTEND_TARGET;
  const restHost = env[`CEDAR_FRONTEND_${target}_REST_HOST`];
  const uiHost = env[`CEDAR_FRONTEND_${target}_UI_HOST`];
  if (!restHost || !uiHost) throw new Error('Source the CEDAR profile before configuring the frontend.');
  const development = env.CEDAR_FRONTEND_BEHAVIOR === 'develop';
  const commit = env.CEDAR_SOURCE_COMMIT || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync('app/config', { recursive: true });
  writeFileSync('app/config/host.json', JSON.stringify({
    resourceRestAPI: `https://resource.${restHost}`,
    userRestAPI: `https://user.${restHost}`,
    terminologyBaseUrl: `https://terminology.${restHost}/`,
    bridgeBaseUrl: `https://bridge.${restHost}/`,
    workspaceFrontend: env.CEDAR_WORKSPACE_FRONTEND_URL || (target === 'local' ? 'http://localhost:4201' : `https://workspace-next.${uiHost}`),
  }, null, 2));
  const globals = {
    cedarVersion: env.CEDAR_VERSION, cedarVersionModifier: env.CEDAR_VERSION_MODIFIER || '',
    cedarSourceCommit: commit, cedarDevelopmentMode: development,
    cedarAuthUrl: env.CEDAR_AUTH_URL || `https://auth.${uiHost}`,
    cedarCacheControl: `${env.CEDAR_VERSION}-${commit}${development ? '-' + Date.now() : ''}`,
  };
  writeFileSync('app/config/version.js', Object.entries(globals).map(([key, value]) => `window.${key} = ${JSON.stringify(value)};`).join('\n') + '\n');
  done();
}
gulp.task('replace-url', configure);
gulp.task('replace-version', configure);
gulp.task('replace-tracking', (done) => done()); // Older payload builders call this task.
gulp.task('copy:ced', (done) => {
  execFileSync(process.execPath, ['scripts/stage-components.mjs'], { stdio: 'inherit' });
  done();
});
gulp.task('default', gulp.series(configure, 'copy:ced', (done) => {
  if (process.env.CEDAR_FRONTEND_BEHAVIOR === 'develop') {
    connect.server({ root: 'app', port: Number(process.env.CEDAR_FRONTEND_PORT || 4202), host: '0.0.0.0', fallback: 'app/index.html' });
  } else if (process.env.CEDAR_FRONTEND_BEHAVIOR !== 'server') {
    throw new Error('CEDAR_FRONTEND_BEHAVIOR must be develop or server.');
  }
  done();
}));
