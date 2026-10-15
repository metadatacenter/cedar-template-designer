const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = value => JSON.stringify(value, (_key, node) => object(node)
  ? Object.fromEntries(Object.keys(node).sort().map(key => [key, node[key]])) : node);

/**
 * The component projects an older artifact into its current schema vocabulary.
 * Compare edits with that initial projection, not with the stored representation:
 * rebuilding the same document must not become an implicit schema migration.
 * Arrays are complete authored values (order, types, choices and constraints).
 */
export function applyAuthorChanges(stored, opened, edited) {
  if (keyOf(opened) === keyOf(edited)) return structuredClone(stored);
  if (!object(opened) || !object(edited)) return structuredClone(edited);
  const result = object(stored) ? structuredClone(stored) : {};
  for (const key of new Set([...Object.keys(opened), ...Object.keys(edited)])) {
    if (!Object.hasOwn(edited, key)) {
      delete result[key];
    } else {
      const value = Object.hasOwn(opened, key)
        ? applyAuthorChanges(object(stored) && Object.hasOwn(stored, key) ? stored[key] : undefined, opened[key], edited[key])
        : structuredClone(edited[key]);
      if (value === undefined) delete result[key];
      else Object.defineProperty(result, key, {value, enumerable: true, configurable: true, writable: true});
    }
  }
  return result;
}
