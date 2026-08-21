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

## Preview image

The repository builds directly from its checkout; it does not require a published npm tarball.
Use the provenance-aware wrapper and image versions declared by `cedar-docker-build`:

```sh
"$CEDAR_HOME/cedar-docker-build/bin/build-split-preview-frontends.sh" designer
```

The image requires `CEDAR_HOST` at runtime and serves port `4202`. It generates environment-specific
service, navigation, and authentication origins before nginx starts. Override
`CEDAR_WORKSPACE_FRONTEND_URL`, `CEDAR_TEMPLATE_DESIGNER_FRONTEND_URL`, or `CEDAR_AUTH_URL` for a
nonstandard preview topology. This image is preview-only until the migration acceptance gate passes.

Every running image exposes `/config/build-info.json` with its baked source commit, whether that
checkout was dirty, and a SHA-256 over the exact environment-specific tree nginx serves. The file is
served with `Cache-Control: no-store`; staging acceptance must record it and reject dirty images.

## Migration constraints

- Do not route production traffic here until preview and staging gates pass.
- Do not copy metadata instance editing into this repository; use the canonical
  CEE host.
- Cross-application navigation follows
  [`docs/CROSS_APP_NAVIGATION.md`](docs/CROSS_APP_NAVIGATION.md).
- Framework modernization is intentionally separate from the extraction.
