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

## Migration constraints

- Do not route production traffic here until preview and staging gates pass.
- Do not copy metadata instance editing into this repository; use the canonical
  CEE host.
- Cross-application navigation follows
  [`docs/CROSS_APP_NAVIGATION.md`](docs/CROSS_APP_NAVIGATION.md).
- Framework modernization is intentionally separate from the extraction.
