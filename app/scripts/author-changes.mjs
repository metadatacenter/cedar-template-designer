import { ExactDecimal, JsonSourcePolicy, canonicalJson } from './json-policy.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !ExactDecimal.isExact(value);
const keyOf = canonicalJson;
const definition = value => object(value) && object(value._ui) && object(value.properties) &&
  typeof value['@id'] === 'string' && value['@id'];

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
export function applyAuthorChanges(stored, opened, edited, replacements = []) {
  if (keyOf(opened) === keyOf(edited)) return JsonSourcePolicy.clone(stored);
  if (!object(opened) || !object(edited)) return JsonSourcePolicy.clone(edited);
  // An explicit reusable-version replacement adopts that complete definition. Hidden branches
  // retained for ordinary editing must not be carried from the old identity into the new one.
  if (definition(opened) && definition(edited) && opened['@id'] !== edited['@id']) {
    const source = replacements.find(entry => entry.artifact['@id'] === edited['@id']);
    if (!source) return JsonSourcePolicy.clone(edited);
    const raw = JsonSourcePolicy.clone(source.artifact), projection = JsonSourcePolicy.clone(source.projection);
    // These flags belong to the field's placement. Preserve explicit false in an older source
    // when CED omits the default, while applying any deliberate placement change.
    for (const [group, keys] of [['_ui', ['hidden', 'continuePreviousLine', 'valueRecommendationEnabled']],
      ['_valueConstraints', ['requiredValue', 'recommendedValue']]]) {
      for (const key of keys) {
        const value = edited[group]?.[key];
        if (Object.hasOwn(edited[group] ?? {}, key)) {
          (projection[group] ??= {})[key] = value; (raw[group] ??= {})[key] = value;
        } else {
          if (projection[group]) delete projection[group][key];
          if (raw[group]?.[key] === true) raw[group][key] = false;
        }
      }
    }
    return applyAuthorChanges(raw, projection, edited, replacements);
  }
  // Repeat cardinality moves a definition under `items`; it does not replace
  // that definition with the component's normalized projection of it.
  if (edited.type === 'array' && definition(opened) && definition(edited.items))
    return { ...JsonSourcePolicy.clone(edited), items: applyAuthorChanges(stored, opened, edited.items, replacements) };
  if (opened.type === 'array' && definition(opened.items) && definition(edited))
    return applyAuthorChanges(stored?.items, opened.items, edited, replacements);
  const result = object(stored) ? JsonSourcePolicy.clone(stored) : {};
  const sources = childSources(opened, edited);
  for (const key of new Set([...Object.keys(opened), ...Object.keys(edited)])) {
    if (!Object.hasOwn(edited, key)) {
      delete result[key];
    } else {
      const source = sources.get(key) ?? key;
      const value = Object.hasOwn(opened, source)
        ? applyAuthorChanges(object(stored) && Object.hasOwn(stored, source) ? stored[source] : undefined, opened[source], edited[key], replacements)
        : JsonSourcePolicy.clone(edited[key]);
      if (value === undefined) delete result[key];
      else Object.defineProperty(result, key, {value, enumerable: true, configurable: true, writable: true});
    }
  }
  return result;
}

/**
 * The stored artifact with each shape the designer reports having superseded put as its projection holds
 * it: the projection's value where it has one, and nothing where it has none. These are shapes the
 * designer cannot represent and the server refuses, so retaining them would carry a refusal into every
 * save. Every other stored branch is left exactly as it was, to be retained as before.
 */
export function supersede(stored, shapes = []) {
  const result = JsonSourcePolicy.clone(stored);
  for (const shape of shapes) {
    const parts = shape.location.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const key = parts.pop();
    // A location whose container is missing no longer describes this artifact, and is left alone.
    let parent = result;
    for (const part of parts) parent = object(parent) && Object.hasOwn(parent, part) ? parent[part] : undefined;
    if (!object(parent) || key === undefined) continue;
    if (Object.hasOwn(shape, 'value'))
      Object.defineProperty(parent, key, {value: JsonSourcePolicy.clone(shape.value), enumerable: true, configurable: true, writable: true});
    else delete parent[key];
  }
  return result;
}
