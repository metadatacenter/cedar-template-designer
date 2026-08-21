# Template Designer ownership inventory

This repository is the extracted CEDAR Template Designer frontend. The production
`cedar-template-editor` monolith remains authoritative until the preview and staging
gates pass; this inventory defines the intended boundary of the extracted application.

## Owned routes

- `/templates/create` and `/templates/edit/:templateId`
- `/elements/create` and `/elements/edit/:elementId`
- `/fields/create` and `/fields/edit/:fieldId`

## Retained application areas

- Template, element, and field authoring controllers and forms
- Controlled-term constraints, recommended values, temporal fields, rich text, staging,
  validation, and authoring-specific schema manipulation
- The embedded artifact finder used to include existing fields and elements
- The finder-only search/browse infrastructure, inclusion modal, and category tree
- Shared authentication, backend HTTP, URL, user, tracking, and UI infrastructure needed
  by authoring

The finder and category-tree code are explicit boundary exceptions: they support an
authoring workflow and do not make Designer an owner of the Workspace dashboard.

## Explicitly excluded

- Dashboard, folder management, sharing, profile, settings, privacy, messaging, and
  logout routes; those belong to `cedar-workspace`
- Metadata instance create/edit routes and every legacy AngularJS runtime renderer
- The CEE host and the `cedar-embeddable-editor` package; Workspace owns the thin host
  shell and consumes the independently released component
- Spreadsheet mode, Handsontable, ngHandsontable, and their adapters and styles
- Archived legacy artifact frontends
- The inherited Protractor/Selenium harness and broad legacy unit suite

## Cross-application boundary

Designer accepts opaque encoded artifact identifiers plus `folderId` and `returnTo`
query parameters. Back and cancel perform full-page navigation only to an exact,
configured Workspace origin; malformed, insecure, credential-bearing, and cross-origin
values fall back safely. See [`CROSS_APP_NAVIGATION.md`](CROSS_APP_NAVIGATION.md).

## Verification floor

- `npm test` runs the focused return-URL security tests.
- `npm start` serves Designer on port 4202 and LiveReload on 35731 by default.
- `/templates/create` must return the application shell.
- Generated Designer configuration contains `workspaceFrontend` and no CEE or retired
  frontend-host setting.
- A repository-wide case-insensitive search for `handsontable`, `nghandsontable`, or
  `spreadsheet` must return no matches.
- Before every parity gate, audit commits added to the frozen monolith baseline and port
  applicable fixes deliberately rather than merging the monolith wholesale.
