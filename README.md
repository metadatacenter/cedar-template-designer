# CEDAR Template Designer host

Workspace opens this authenticated frontend on the Designer hostname. It embeds
`<cedar-embeddable-designer>` (CED) for template and element authoring, CEE/CEF for
preview and field values, and CETP for controlled-term constraints. The combined
`cedar-template-editor` application is independent and unchanged.

The host owns Keycloak SSO, permission checks, repository child search, persistence,
conditional writes, dirty-navigation warnings and safe return to Workspace. It
contains no AngularJS authoring UI or legacy designer dependencies.

## Local development

Build the sibling components, then stage and start the host using the CEDAR profile:

```sh
export CEDAR_HOME="$HOME/CEDAR" CEDAR_PROFILE=develop
source "$CEDAR_HOME/cedar-development/bin/templates/cedar-profile-native.sh"
cd "$CEDAR_HOME/cedar-embeddable-designer" && npm run dist
cd "$CEDAR_HOME/cedar-embeddable-editor" && npm run build:production
cd "$CEDAR_HOME/cedar-embeddable-editor/visual" && npm run bundle
cd "$CEDAR_HOME/cedar-embeddable-term-picker" && npm run dist
cd "$CEDAR_HOME/cedar-template-designer" && npm ci
cedarcli native restart frontend designer
```

The development server uses port 4202 (`CEDAR_FRONTEND_PORT` overrides it).
`npm start` runs the same host directly. `npm run prepare:components` or
`npx gulp copy:ced` refreshes its local bundles without restarting the server.
Reload the page after staging. Bundle SHA-256s in `app/components/manifest.json`
cache-bust each component independently.

CED is not fetched from npmjs. By default staging reads sibling build outputs.
`CEDAR_CED_BUNDLE`, `CEDAR_CEE_BUNDLE` and `CEDAR_CETP_BUNDLE` can point to explicit
bundle files, including files extracted from future immutable Nexus packages.
Missing bundles fail startup. Generated components and configuration are ignored
by Git. Distribution builders must stage these components before assembling a
payload; publishing the host source alone does not produce a self-contained app.

## Routes and saving

The existing `/templates/create`, `/templates/edit/{id}`, `/elements/create` and
`/elements/edit/{id}` routes accept `folderId` and `returnTo`. Identifiers remain
opaque. `returnTo` accepts only the configured Workspace origin.

New documents start empty. Save validates CED's complete artifact and supplies
the storage API's required empty provenance keys and descriptions for new children,
preserving existing values. Existing artifacts use their original
ETag on PUT. Templates run the backend's `check-update-template` command first;
when instances prevent an in-place update, a confirmation offers to publish the
original and save a new draft without copying instances. Cancellation and failures
keep the edits. Successful saves return to Workspace. Published artifacts and
artifacts without `updateResource` capability are inert and cannot be saved.

The versioning command has no atomic conditional-write contract yet. The host
re-reads and compares the original ETag before invoking it and also sends
`If-Match`; the backend must eventually enforce that header atomically to close
the remaining race between that read and the command.

Standalone `/fields/*` routes show an explicit unsupported message for now. CED
supports fields *inside* templates/elements and reusable repository children, but
not standalone field-document authoring. There is no legacy fallback.

## Verification

`npm test` exercises navigation, permission checks, conditional saving, versioning,
error retention, token refresh and repository child search without the stack.
The live CED host smoke covers create/update, stale-save rejection, versioning
with metadata instances, cancellation and return to Workspace. It is in `cedar-development/ops/e2e/ced-host-smoke.mjs`.
