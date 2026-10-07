const COLLECTIONS = 'folders|templates|template-elements|template-fields|template-instances';
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const TYPED = new RegExp(`^(${COLLECTIONS})/(${UUID})$`);

/** The base this deployment mints identities on, such as https://repo.metadatacenter.org/. */
let deploymentBase = null;

/**
 * Learn the deployment's base from its domain. The server expands a short selector onto its own base
 * only, so only identities on that base are shortened. An identity on any other host stays absolute
 * rather than coming back as a different resource, and until the base is known nothing is shortened.
 */
export function useDeploymentDomain(domain) {
  deploymentBase = domain ? `https://repo.${domain}/` : null;
}

/**
 * The same, from the resource API the deployment is configured with. The server mints identities on
 * repo.<host> and serves them from resource.<host>, so the API names the base. A user's identities do
 * not: an account created when CEDAR ran on another domain keeps its home folder on that domain's
 * base. An API on any other host leaves the base unknown.
 */
export function useDeploymentApi(resourceRestAPI) {
  let host = null;
  try {
    host = resourceRestAPI ? new URL(resourceRestAPI).hostname : null;
  } catch {}
  useDeploymentDomain(host?.startsWith('resource.') ? host.slice('resource.'.length) : null);
}

/** HTTP selectors retain the resource type; document identities remain full IRIs. */
export function resourceSelector(id) {
  if (!deploymentBase || !id.startsWith(deploymentBase)) return id;
  const local = id.slice(deploymentBase.length);
  return TYPED.test(local) ? local : id;
}

/** The collection is already present in a REST or browser route. */
export function resourcePathId(id) {
  return resourceSelector(id).replace(TYPED, '$2');
}

/** Restore UI identity for comparisons with server-returned records. */
export function resourceIri(id, example) {
  if (!TYPED.test(id)) return id;
  const base = deploymentBase ?? example.match(new RegExp(`^(https?://[^/]+/)(?:${COLLECTIONS})/`))?.[1];
  return base ? base + id : id;
}
