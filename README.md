# CEDAR Template Designer host

Workspace opens this authenticated frontend on the Designer hostname. It embeds
`<cedar-embeddable-designer>` (CED) for template and element authoring, CEE/CEF for
preview and field values, and CETP for controlled-term constraints. The combined
`cedar-template-editor` application is independent and unchanged.

The host owns Keycloak SSO, permission checks, repository child search, persistence,
conditional writes, dirty-navigation warnings and safe return to Workspace. It
contains no AngularJS authoring UI or legacy designer dependencies.

A mark beside the status text shows the save state: a hollow ring while nothing is
unsaved and a filled dot once something is. The design tokens' `save-state.css`
draws it in the warning colour, `status-warning-text`.

## Local development

Install the locked packages and start the host using the CEDAR profile:

```sh
export CEDAR_HOME="$HOME/CEDAR" CEDAR_PROFILE=develop
source "$CEDAR_HOME/cedar-development/bin/templates/cedar-profile-native.sh"
cd "$CEDAR_HOME/cedar-template-designer" && npm ci
cedarcli native restart frontend designer
```

The development server uses port 4202 (`CEDAR_FRONTEND_PORT` overrides it).
`npm start` runs the same host directly. `npm run prepare:components` stages the
installed packages without restarting the server.
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
keep the edits. Published artifacts and artifacts without `updateResource`
capability remain inspectable: tabs, expansion, outline and preview work, while editing
controls are disabled and Save is unavailable. The host is inert only while loading,
after a failed load, and while saving.

A successful save stays in Designer. After saving a new artifact or a new draft,
the host reads the stored artifact back, opens it and moves to its edit address,
keeping the query string. The designer then holds the identity and version
metadata the server assigned. Saving an existing artifact keeps the open document
and the author's place in it. Its created and modified dates in the designer's
metadata settings update when the artifact is next opened. Either way, the next
save is a conditional update under the most recent ETag. Only the Workspace control
returns to Workspace, and it asks first when changes are unsaved.

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
The live CED host smoke covers create/update without leaving Designer, stale-save
rejection, versioning with metadata instances, cancellation and the return to Workspace.
It is in `cedar-development/ops/e2e/ced-host-smoke.mjs`.

A successful first save or new-draft save adopts the stored artifact through
`loadArtifact(data, { preserveView: true })`, preserving matching settings tabs and
expansion while receiving the server identity. The coordinator still verifies the
submitted document is current before adoption. Ordinary loads and explicit reloads
reset the view.

Unfinished Designer work is retained in this tab's `sessionStorage`, scoped to the
signed-in account, deployment, artifact kind and identity (or create folder).
Reload offers explicit restoration after fresh server reads; a restored draft does
not inherit permission or an ETag from the recovery file. Download/import recovery
files retain unfinished controls and the evidence for interrupted writes. A failed
storage write is reported so the author can download before leaving.

The host journals immediately before dispatching a write. A create is a PUT under
an identity the host mints on the deployment's base, and a new version names the
draft identity it asks for in `draft_id`. The journal keeps that identity and the
submitted definition, and for a new version also the source template and the ETag
it was opened with. Every attempt reuses the identity until its outcome is settled.
When an answer is lost, Save stays blocked through reload and sign-in, and Discard
is refused. Check save status then reads the identity. If the artifact is stored,
it opens at its edit address and later edits remain as unsaved changes. If it is
absent, Save sends the write again under the same identity. Any other answer leaves
Save blocked, and the check may be repeated. A create whose identity the server
already holds (412 or 428) is checked the same way. That attempt stored nothing,
so an artifact found there was stored by an earlier attempt whose content may
differ. The page moves to its edit address and keeps the designer's content. The
artifact must be reloaded before the next save. While the deployment's base
cannot be derived from the resource API, the server mints the identity as before,
and a lost answer cannot be checked. Update recovery rechecks the stored revision
and access before permitting another conditional write. Explicit confirmed
discard clears ordinary drafts. Closing a tab ends automatic retention.
