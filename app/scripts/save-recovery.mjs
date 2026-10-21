import { ExactDecimal, JsonSourcePolicy, IdentifierPolicy, canonicalJson } from './json-policy.mjs';
import { resourcePathId } from './resource-address.mjs';
// Ignore only root update provenance. Child identities, provenance, values,
// order, annotations and unknown content all remain part of the comparison.
export function authoredKey(document) {
  const content = JsonSourcePolicy.clone(document);
  if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
  delete content['pav:lastUpdatedOn'];
  delete content['oslc:modifiedBy'];
  return canonicalJson(content);
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
  return sameWritten(latest.data, submitted) ? 'saved' : 'changed';
}

const PROVENANCE = ['pav:createdOn', 'pav:createdBy', 'pav:lastUpdatedOn', 'oslc:modifiedBy'];
const absoluteIri = value => typeof value === 'string' && IdentifierPolicy.isValid(value);

/**
 * Two documents as the artifact server compares a child with its stored counterpart, for judging what a
 * write stored of a submission. Provenance at every depth is the server's to assign: a changed child takes
 * a new modification stamp and a new child a creation record. So is the identifier of a child the
 * submission sent without an absolute one, such as the designer's temporary identifiers. Everything else,
 * names, order of arrays, values, constraints and annotations, must match.
 */
export function sameWritten(stored, submitted) {
  const a = JsonSourcePolicy.clone(stored), b = JsonSourcePolicy.clone(submitted);
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object') return false;
  const visit = (node, sent) => {
    if (Array.isArray(node)) { node.forEach((item, index) => visit(item, Array.isArray(sent) ? sent[index] : undefined)); return; }
    if (!node || typeof node !== 'object' || ExactDecimal.isExact(node)) return;
    const counterpart = sent && typeof sent === 'object' && !Array.isArray(sent) ? sent : undefined;
    for (const key of PROVENANCE) { delete node[key]; if (counterpart) delete counterpart[key]; }
    for (const [key, value] of Object.entries(node)) {
      const other = counterpart?.[key];
      if (value && typeof value === 'object' && !Array.isArray(value) && absoluteIri(value['@id']) &&
          other && typeof other === 'object' && !Array.isArray(other) && !absoluteIri(other['@id'])) {
        delete value['@id']; delete other['@id'];
      }
      visit(value, other);
    }
  };
  visit(a, b);
  return authoredKey(a) === authoredKey(b);
}

/**
 * What a new version stores of a submitted definition. The draft keeps the identity, version, status,
 * predecessor and creation provenance it was created with, and carries no DOI.
 */
function storedDefinition(submitted, draft) {
  const result = JsonSourcePolicy.clone(submitted);
  for (const key of ['@id', 'pav:version', 'bibo:status', 'pav:previousVersion', 'pav:createdOn', 'pav:createdBy']) {
    if (Object.hasOwn(draft, key)) result[key] = draft[key]; else delete result[key];
  }
  const annotations = result._annotations;
  if (annotations && typeof annotations === 'object' && !Array.isArray(annotations)) {
    delete annotations['https://datacite.com/doi'];
    if (!Object.keys(annotations).length) delete result._annotations;
  }
  return result;
}

/**
 * The outcome of a write that sent a new identity and whose answer was lost, judged from a read of that
 * identity and, for a new version, of the template it was drawn from. 'committed' means the identity holds
 * what was sent; 'absent' means nothing was committed and the write may be sent again under the same
 * identity; 'unresolved' covers everything else. A name never decides.
 * @param creation {operation: 'create'|'version', id, submitted, source?, opened?}
 * @param created the identity's {data, etag}, or null when it reads as not found
 * @param source the source template's {data, etag}, read only for a version whose identity is absent
 */
export function creationOutcome(creation, created, source) {
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && resourcePathId(a) === resourcePathId(b);
  if (created) {
    if (!created.data || typeof created.data !== 'object' || !same(created.data['@id'], creation.id)) return 'unresolved';
    if (creation.operation === 'create') return 'committed';
    return same(created.data['pav:previousVersion'], creation.source) &&
      sameWritten(created.data, storedDefinition(creation.submitted, created.data)) ? 'committed' : 'unresolved';
  }
  if (creation.operation === 'create') return 'absent';
  // Still a draft, as the Designer judges whether a template may be edited, holding what was opened. A
  // command the server undid restores the source with an ordinary write, which may restamp provenance.
  return source?.etag && source.data && same(source.data['@id'], creation.source) && source.data['bibo:status'] !== 'bibo:published' &&
    sameWritten(source.data, creation.opened) ? 'absent' : 'unresolved';
}
