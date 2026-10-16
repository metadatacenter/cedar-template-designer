const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = value => JSON.stringify(value, (_key, node) => object(node)
  ? Object.fromEntries(Object.keys(node).sort().map(key => [key, node[key]])) : node);
const definition = value => object(value) && object(value._ui) && object(value.properties) &&
  typeof value['@id'] === 'string' && value['@id'];
const sameDefinition = (left, right) => definition(left) && definition(right) && left['@id'] === right['@id'];

// A key is a placement name, not the identity of the definition placed there.
// Reused definitions can share an @id: their property IRI disambiguates placements.
// Neither index chooses arbitrarily when an identity occurs more than once.
function childIndex(properties, placement = false) {
  const index = new Map();
  for (const [key, value] of Object.entries(properties)) {
    const child = object(value?.items) ? value.items : value;
    if (!object(child) || !object(child._ui) || !object(child.properties) ||
      typeof child['@id'] !== 'string' || !child['@id']) continue;
    const iri = properties['@context']?.properties?.[key]?.enum?.[0];
    if (placement && (typeof iri !== 'string' || !iri)) continue;
    const identity = placement ? JSON.stringify([child['@id'], iri]) : child['@id'];
    index.set(identity, index.has(identity) ? null : key);
  }
  return index;
}
function childSources(opened, edited) {
  const sources = new Map();
  for (const placement of [false, true]) {
    const before = childIndex(opened, placement), after = childIndex(edited, placement);
    for (const [identity, key] of after) {
      const source = before.get(identity);
      if (key !== null && source != null && !sources.has(key)) sources.set(key, source);
    }
  }
  return sources;
}

/**
 * The component projects an older artifact into its current schema vocabulary.
 * Compare edits with that initial projection, not with the stored representation:
 * rebuilding the same document must not become an implicit schema migration.
 * Arrays are complete authored values (order, types, choices and constraints).
 */
export function applyAuthorChanges(stored, opened, edited) {
  if (keyOf(opened) === keyOf(edited)) return structuredClone(stored);
  if (!object(opened) || !object(edited)) return structuredClone(edited);
  // Repeat cardinality moves a definition under `items`; it does not replace
  // that definition with the component's normalized projection of it.
  if (edited.type === 'array' && sameDefinition(opened, edited.items))
    return { ...structuredClone(edited), items: applyAuthorChanges(stored, opened, edited.items) };
  if (opened.type === 'array' && sameDefinition(opened.items, edited))
    return applyAuthorChanges(stored?.items, opened.items, edited);
  const result = object(stored) ? structuredClone(stored) : {};
  const sources = childSources(opened, edited);
  for (const key of new Set([...Object.keys(opened), ...Object.keys(edited)])) {
    if (!Object.hasOwn(edited, key)) {
      delete result[key];
    } else {
      const source = sources.get(key) ?? key;
      const value = Object.hasOwn(opened, source)
        ? applyAuthorChanges(object(stored) && Object.hasOwn(stored, source) ? stored[source] : undefined, opened[source], edited[key])
        : structuredClone(edited[key]);
      if (value === undefined) delete result[key];
      else Object.defineProperty(result, key, {value, enumerable: true, configurable: true, writable: true});
    }
  }
  return result;
}
