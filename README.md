# CEDAR Template Designer host

Workspace opens this authenticated frontend on the Designer hostname. It embeds
`<cedar-embeddable-designer>` (CED) for template and element authoring, CEE/CEF for
preview and field values, and CETP for controlled-term constraints. The combined
`cedar-template-editor` application is independent and unchanged.

The host owns Keycloak SSO, permission checks, repository child search, persistence,
conditional writes, dirty-navigation warnings and safe return to Workspace. It
contains no AngularJS authoring UI or legacy designer dependencies.

The unsaved indicator is a filled yellow dot beside the status text. Hosts may
override its color with `--designer-unsaved-color`; the default is `#eab308`.

## Local development

Install the locked packages and start the host using the CEDAR profile:

```sh
export CEDAR_HOME="$HOME/CEDAR" CEDAR_PROFILE=develop
source "$CEDAR_HOME/cedar-development/bin/templates/cedar-profile-native.sh"
cd "$CEDAR_HOME/cedar-template-designer" && npm ci
cedarcli native restart frontend designer
```

The development server uses port 4202 (`CEDAR_FRONTEND_PORT` overrides it).
`npm start` runs the same host directly. `npm run prepare:components` or
`npx gulp copy:ced` stages the installed packages without restarting the server.
Reload the page after staging.

| Component | Pinned package |
| --- | --- |
| CED | `@org.metadatacenter/cedar-embeddable-designer@0.1.0-dev.20260916.2593d382` (Nexus) |
| CETP | `@org.metadatacenter/cedar-embeddable-term-picker@0.1.0-dev.20260915.0ec47d9c` (Nexus) |
| CEE/CEF | `cedar-embeddable-editor@2.0.15` (npmjs) |

The npm aliases and scoped registry in `.npmrc` route only the development
components to Nexus. No sibling checkouts are needed. Staging checks each
bundle's bytes against its published manifest, then records package name,
version and SHA-256 in `app/components/manifest.json`. Those hashes also
cache-bust the component scripts. `npm pack` stages and includes these components;
environment configuration is generated separately by Gulp.

For local component development, build a sibling and explicitly set
`CEDAR_CED_BUNDLE`, `CEDAR_CEE_BUNDLE` or `CEDAR_CETP_BUNDLE` to its bundle path
when staging. There is no implicit fallback to a sibling. Server payloads reject
these overrides and require the locked packages. Generated files stay out of Git.

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

The versioning command requires the original `If-Match` validator. The backend
uses the same source snapshot for version allocation and conditional publication;
a concurrent change returns 412 before any draft is created. The host retains
edits on that response and does not refresh the validator behind the user's back.

Standalone `/fields/*` routes use CEFD from the CED bundle. The host owns the
same ETag and permission checks as element editing. CEFD provides a type chooser
and edits one field definition using CED’s shared controls. A CED snapshot with
CEFD registration is required; during development stage it with `CEDAR_CED_BUNDLE`.

CED continues to support fields inside templates/elements and reusable repository children.

## Verification

`npm test` exercises navigation, permission checks, conditional saving, versioning,
error retention, token refresh and repository child search without the stack.
The live CED host smoke covers create/update, stale-save rejection, versioning
with metadata instances, cancellation and return to Workspace. It is in `cedar-development/ops/e2e/ced-host-smoke.mjs`.
