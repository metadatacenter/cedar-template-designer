#!/bin/bash
set -euo pipefail

: "${CEDAR_HOST:?CEDAR_HOST must name the environment host}"

export CEDAR_ANALYTICS_KEY="${CEDAR_ANALYTICS_KEY:-false}"
export CEDAR_GA4_TRACKING_ID="${CEDAR_GA4_TRACKING_ID:-false}"
export CEDAR_DATACITE_ENABLED="${CEDAR_DATACITE_ENABLED:-false}"
export CEDAR_FRONTEND_BEHAVIOR=server
export CEDAR_FRONTEND_TARGET="${CEDAR_FRONTEND_TARGET:-local}"
export CEDAR_VERSION="${CEDAR_VERSION:-$(node -p "require('./package.json').version")}"
export CEDAR_VERSION_MODIFIER="${CEDAR_VERSION_MODIFIER:-}"
export CEDAR_AUTH_URL="${CEDAR_AUTH_URL:-https://auth.${CEDAR_HOST}}"
export CEDAR_WORKSPACE_FRONTEND_URL="${CEDAR_WORKSPACE_FRONTEND_URL:-https://workspace-next.${CEDAR_HOST}}"
export CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL="${CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL:-https://designer-next.${CEDAR_HOST}}"

if [[ ! "$CEDAR_FRONTEND_TARGET" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "CEDAR_FRONTEND_TARGET contains unsupported characters" >&2
  exit 1
fi

for suffix in UI_HOST REST_HOST; do
  name="CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_${suffix}"
  value="${!name:-$CEDAR_HOST}"
  printf -v "$name" '%s' "$value"
  export "$name"
done

for suffix in USER1_LOGIN USER1_PASSWORD USER1_NAME USER2_LOGIN USER2_PASSWORD USER2_NAME; do
  name="CEDAR_FRONTEND_${CEDAR_FRONTEND_TARGET}_${suffix}"
  value="${!name:-}"
  printf -v "$name" '%s' "$value"
  export "$name"
done

./node_modules/.bin/gulp

# Record both the immutable source identity baked into the image and the exact
# environment-specific tree nginx is about to serve. The generated metadata file
# is excluded from its own digest and lives under /config, whose nginx policy is
# no-store. A dirty local build is explicit rather than falsely claiming that its
# source commit alone identifies the payload.
source_commit=$(cat /usr/local/share/cedar-source-commit)
source_dirty=$(cat /usr/local/share/cedar-source-dirty)
if [[ ! "$source_commit" =~ ^([0-9a-f]{40}|unknown)$ ]]; then
  echo "image carries an invalid source commit" >&2
  exit 1
fi
if [[ ! "$source_dirty" =~ ^(true|false|unknown)$ ]]; then
  echo "image carries an invalid source-dirty marker" >&2
  exit 1
fi

bundle_sha256=$(
  find app -type f ! -path 'app/config/build-info.json' -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum \
    | sha256sum \
    | cut -d' ' -f1
)

CEDAR_APPLICATION_ID=cedar-template-designer \
CEDAR_SOURCE_COMMIT="$source_commit" \
CEDAR_SOURCE_DIRTY="$source_dirty" \
CEDAR_BUNDLE_SHA256="$bundle_sha256" \
node <<'NODE'
const fs = require('fs');

const info = {
  application: process.env.CEDAR_APPLICATION_ID,
  version: process.env.CEDAR_VERSION,
  versionModifier: process.env.CEDAR_VERSION_MODIFIER,
  sourceCommit: process.env.CEDAR_SOURCE_COMMIT,
  sourceDirty: process.env.CEDAR_SOURCE_DIRTY === 'true'
    ? true
    : process.env.CEDAR_SOURCE_DIRTY === 'false' ? false : 'unknown',
  bundleSha256: process.env.CEDAR_BUNDLE_SHA256,
};
fs.writeFileSync('app/config/build-info.json', `${JSON.stringify(info, null, 2)}\n`);
NODE

exec "$@"
