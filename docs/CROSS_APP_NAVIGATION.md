# Cross-application navigation contract (draft 0.1)

This contract lets Workspace, Template Designer, and the canonical CEE host evolve
and deploy independently. It is intentionally small: applications exchange URLs and
opaque artifact identifiers, not AngularJS services or in-memory route state.

## Applications and ownership

| Application | Owned routes | Provisional local port |
| --- | --- | --- |
| `cedar-workspace` | `/`, `/dashboard`, `/profile`, `/settings`, `/privacy`, `/messaging`, `/logout` | 4201 |
| `cedar-template-designer` | `/templates/*`, `/elements/*`, `/fields/*` | 4202 |
| canonical CEE host | `/instances/create/:templateId`, `/instances/edit/:instanceId` | existing host |

`cedar-artifacts` currently implements the guarded instance routes and is therefore
the integration target during extraction. This is not a decision to retain that
repository forever. The CEE host may change later without changing Workspace or
Designer routes, provided the configured CEE base URL keeps this contract.

No coordinating `cedar-workbench` runtime is required for the initial split.
Deployment coordination belongs in `cedar-development`, build/deploy repositories,
and `cedar-cli` until a shell application has an actual runtime responsibility.

## Runtime configuration

Each environment must provide these absolute HTTPS origins:

- `workspaceFrontend`
- `templateDesignerFrontend`
- `artifactsFrontend` (the current CEE host; rename only in a later contract version)

Preview origins must not replace production values. Production, staging, and local
configuration are generated independently. Root-relative assets must either be
served on separate origins or be explicitly namespaced before path-based routing is
allowed.

## Routes and parameters

| From | Action | Destination |
| --- | --- | --- |
| Workspace | create template | `{designer}/templates/create?folderId=...&returnTo=...` |
| Workspace | create element | `{designer}/elements/create?folderId=...&returnTo=...` |
| Workspace | create field | `{designer}/fields/create?folderId=...&returnTo=...` |
| Workspace | edit template | `{designer}/templates/edit/{artifactId}?returnTo=...` |
| Workspace | edit element | `{designer}/elements/edit/{artifactId}?returnTo=...` |
| Workspace | edit field | `{designer}/fields/edit/{artifactId}?returnTo=...` |
| Workspace | create instance | `{cee}/instances/create/{templateId}?folderId=...&returnTo=...` |
| Workspace | edit instance | `{cee}/instances/edit/{instanceId}?returnTo=...` |
| Designer or CEE | return | validated `returnTo`, otherwise `{workspace}/dashboard` |

Rules:

1. Route-segment identifiers and query values are encoded exactly once with
   `encodeURIComponent` or `URLSearchParams`.
2. `folderId` is optional on edit routes and required for create flows that save
   into a folder.
3. `returnTo` is the absolute current Workspace URL, including folder, search,
   sharing, and fragment state.
4. Cross-application navigation uses `window.location.assign` (same tab) unless a
   user action explicitly requests a new tab. Angular `$location` is never used for
   another application's route.
5. Save redirects stay within the application that owns the artifact type. Cancel,
   close, and explicit “Back to Workspace” actions use the return rule above.

## `returnTo` security

Treat `returnTo` as untrusted input.

- Parse with the platform `URL` API; reject malformed values.
- Allow only `https:` outside local development.
- Allow only the configured Workspace origin (and explicit preview origin where
  applicable), never an arbitrary same-realm or same-parent-domain URL.
- Do not accept user-info components, protocol-relative URLs, or JavaScript/data
  schemes.
- On rejection or absence, fall back to `{workspace}/dashboard`.
- Never copy access tokens, refresh tokens, or credentials into a URL.

## Authentication

- All three applications use the `CEDAR` Keycloak realm and rely on SSO; tokens are
  not passed between applications.
- Preview may temporarily reuse the legacy `cedar-angular-app` client only after its
  exact redirect URIs and web origins are configured.
- Target state is one public client per independently deployed frontend, with exact
  redirect URIs and web origins rather than wildcards.
- Login redirects must preserve the application's full destination route.
- Logout behaviour is a product-wide contract and must be tested across all three
  applications before production cutover.

## Compatibility and rollback

- Contract changes are additive during migration. Existing legacy routes continue
  working until staging parity is signed off.
- Preview routing is enabled by environment configuration, not by changing
  production DNS or nginx rules.
- A production routing change must have a one-step reversal to
  `cedar-template-editor` and must not require a data migration.
- Bookmark and deep-link tests cover every route in the table, authenticated and
  unauthenticated.

## Decisions still to ratify

- Final production origins and whether Workspace retains the current
  `cedar.metadatacenter.org` origin.
- Final Keycloak client IDs and redirect URI lists.
- Whether CEE opens in the same tab for all actions or preserves an explicit
  user-selected new-tab flow.
- Long-term CEE host repository after the current `cedar-artifacts` integration
  phase.
