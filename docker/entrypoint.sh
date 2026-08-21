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
exec "$@"
