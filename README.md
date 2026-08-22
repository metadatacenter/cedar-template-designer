# cedar-template-designer

CEDAR's Template Designer frontend for creating and editing templates, elements,
and fields, including controlled-term constraints and the embedded artifact
finder used during authoring.

This repository is being extracted from the legacy `cedar-template-editor`
AngularJS monolith. It is not in the production release path yet. See
[`MIGRATION.md`](MIGRATION.md) for the frozen source commit, current boundary,
baseline test debt, and extraction gates.

## Local development

Export `CEDAR_HOME`, source the normal CEDAR development profile, and run:

```sh
cd "$CEDAR_HOME/cedar-template-designer"
npm start
```

The default development and LiveReload ports are `4202` and `35731`.
Override them with `CEDAR_FRONTEND_PORT` and `CEDAR_LIVERELOAD_PORT` when
needed. The production monolith continues to use port `4200`.

The current unit baseline is run with `npm test`. Cross-application smoke tests
live under `cedar-development/ops/e2e`.

## Publication and native server deployment

The package is published to the CEDAR Nexus npm repository through the explicit cedarcli command:

```sh
cedarcli deploy split-frontends --dry-run
cedarcli deploy split-frontends
```

Because npm package versions are immutable, the command stages a unique version derived from the
commit timestamp and ID (for example `2.9.2-dev.20260822003012.gabcdef123456`) without changing this
working tree. Publication is not runtime deployment. A native staging or production host checks out the approved
Git commit and generates both environment-configured static trees with:

```sh
cedarcli build split-frontends --server-payload
```

That command requires `CEDAR_FRONTEND_BEHAVIOR=server` and exact
`CEDAR_WORKSPACE_FRONTEND_URL`/`CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL` values. It runs `npm ci`, runs
Gulp, records `/config/build-info.json`, and exits; host nginx serves this repository's `app`
directory directly. Docker is not required on staging or production.

## Docker deployment

Docker construction is deliberately outside this application repository. `cedar-docker-build`
owns the image recipe, nginx configuration, and entrypoint; it consumes one exact immutable npm
version from Nexus. `cedar-docker-deploy` owns the service, network, health check, and runtime
environment. This repository contains no Docker-specific files.

Both native server payloads and Docker images expose `/config/build-info.json` with the source
commit and a SHA-256 over the exact environment-specific tree served. Docker payloads additionally
record the immutable npm version and tarball digest. The file is served with `Cache-Control:
no-store`; deployment acceptance must record it and reject provenance-unknown payloads.

## Migration constraints

- Do not route production traffic here until preview and staging gates pass.
- Do not copy metadata instance editing into this repository; use the canonical
  CEE host.
- Cross-application navigation follows
  [`docs/CROSS_APP_NAVIGATION.md`](docs/CROSS_APP_NAVIGATION.md).
- Framework modernization is intentionally separate from the extraction.
