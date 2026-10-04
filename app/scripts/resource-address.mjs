/** HTTP selectors retain the resource type; document identities remain full IRIs.
 * Foreign/legacy hosts stay absolute until their identities have actually migrated. */
export function resourceSelector(id) {
  return id.replace(/^https?:\/\/repo\.metadatacenter\.org[xy]?\/(folders|templates|template-elements|template-fields|template-instances)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, '$1/$2');
}

/** The collection is already present in a REST or browser route. */
export function resourcePathId(id) {
  return resourceSelector(id).replace(/^(folders|templates|template-elements|template-fields|template-instances)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/, '$2');
}

/** Restore UI identity for comparisons with server-returned records. */
export function resourceIri(id, example) {
  if (!/^(folders|templates|template-elements|template-fields|template-instances)\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) return id;
  const base = example.match(/^(https?:\/\/[^/]+)\/(?:folders|templates|template-elements|template-fields|template-instances)\//)?.[1];
  return base ? base + '/' + id : id;
}
