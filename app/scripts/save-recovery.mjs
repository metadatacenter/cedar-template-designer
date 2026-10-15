// Ignore only root update provenance. Child identities, provenance, values,
// order, annotations and unknown content all remain part of the comparison.
export function authoredKey(document) {
  const content = structuredClone(document);
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  delete content['pav:lastUpdatedOn'];
  delete content['oslc:modifiedBy'];
  return JSON.stringify(content, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}
export function sameRevision(expected, actual) {
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  const revision = value => value.match(/^"([0-9]+)(?:-resource-record)?(?:--gzip)*"$/)?.[1];
  const saved = revision(expected);
  return saved !== undefined && saved === revision(actual);
}

/** A read is evidence, never permission to attach a fresh revision to an unrelated draft. */
export function updateOutcome({opened, submitted, etag}, latest) {
  if (!latest.etag || !latest.data || !opened?.['@id'] || latest.data['@id'] !== opened['@id']) return 'unresolved';
  if (sameRevision(etag, latest.etag)) return authoredKey(opened) === authoredKey(latest.data) ? 'unchanged' : 'unresolved';
  return authoredKey(submitted) === authoredKey(latest.data) ? 'saved' : 'changed';
}
