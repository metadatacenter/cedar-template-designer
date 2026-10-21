import { JsonSourcePolicy, canonicalJson, parseJson } from './json-policy.mjs';
import { resourcePathId, resourceSelector, mintIdentity, identityIn } from './resource-address.mjs';
import { storageArtifact, canCreate } from './host-core.mjs';
import { sameWritten } from './save-recovery.mjs';
const { t } = await import(`./i18n.mjs${new URL(import.meta.url).search}`);
const collections = { template: 'templates', element: 'template-elements', field: 'template-fields' };
const metadata = ['@id', 'schema:name', 'schema:description', 'title', 'description', 'pav:version',
  'bibo:status', 'pav:derivedFrom', 'pav:previousVersion', 'pav:createdOn', 'pav:createdBy',
  'pav:lastUpdatedOn', 'oslc:modifiedBy', '_annotations', 'skos:prefLabel', 'skos:altLabel'];
const presentation = ['order', 'propertyLabels', 'propertyDescriptions', 'header', 'footer',
  'hidden', 'valueRecommendationEnabled', 'width', 'height', 'content'];

/** A deliberately narrow proof: all validation-bearing and unknown content must be identical.
 * Metadata is stripped only from artifact definitions, never from property-name maps or enums.
 * A different shape means unknown, not a claim that a stored instance is invalid.
 */
export function validationShape(document) {
  const result = JsonSourcePolicy.clone(document);
  const visit = node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some(type => /^https:\/\/schema\.metadatacenter\.org\/core\/(Template|TemplateElement|TemplateField|StaticTemplateField)$/.test(type))) {
      for (const key of metadata) delete node[key];
      if (node._ui) for (const key of presentation) delete node._ui[key];
    }
    for (const child of Object.values(node.properties || {})) {
      visit(child); if (child?.items) visit(child.items);
    }
  };
  visit(result);
  return canonicalJson(result);
}

/** One tab/account/deployment owns the journal; it contains no credentials. */
export class ReusableJournal {
  constructor(scope, storage) { this.key = `cedar.designer.reusables:${scope}`; this.storage = storage; }
  get backend() { return this.storage ?? sessionStorage; }
  read() { const raw = this.backend.getItem(this.key); return raw ? parseJson(raw) : {}; }
  write(records) { this.backend.setItem(this.key, JsonSourcePolicy.stringify(records)); }
}

export function reusableSource(request, base, { context, journal, folder, open }) {
  const running = new Map();
  const urlFor = (type, id) => {
    if (!collections[type] || typeof id !== 'string' || !id) throw new Error(t('Error.InvalidArtifact'));
    return `${base}/${collections[type]}/${encodeURIComponent(resourcePathId(id))}`;
  };
  const read = async (url, options) => {
    try { return await request(url, options); }
    catch (error) { if (error.status === 404) return null; throw error; }
  };
  const persist = (key, record) => {
    const records = journal.read(); records[key] = record; journal.write(records);
  };
  return {
    async versions(reference, { signal }) {
      let data;
      try { ({ data } = await request(`${urlFor(reference.type, reference.id)}/versions`, { signal })); }
      catch (error) { if ([403, 404].includes(error.status)) return null; throw error; }
      const rows = data?.resources;
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row['@id'] !== 'string' || !row['@id'] ||
        typeof row['pav:version'] !== 'string' || !['bibo:draft', 'bibo:published'].includes(row['bibo:status'])) ||
        new Set(rows.map(row => row['@id'])).size !== rows.length) throw new Error(t('Error.InvalidChildren'));
      return rows.map(row => ({ id: row['@id'], name: row['schema:name'] || '', version: row['pav:version'],
        publicationStatus: row['bibo:status'] }));
    },
    async compatibility(_current, candidate, { signal, document, replacement }) {
      const state = context();
      if (!document || !replacement) throw new Error(t('Error.InvalidImpact'));
      state.rememberReplacement?.(candidate, replacement);
      // Assess what Save would actually submit, including untouched older schema branches.
      const before = state.project(document), after = state.project(replacement);
      if (validationShape(before) === validationShape(after)) return { compatible: true, invalidatedInstances: 0 };
      if (state.route.kind !== 'template' || !state.route.id) return { compatible: null, invalidatedInstances: 0 };
      const { data } = await request(`${base}/command/check-update-template/${encodeURIComponent(resourcePathId(state.route.id))}`,
        { method: 'POST', body: storageArtifact(after), etag: state.etag, signal });
      // Only an explicit zero proves there are no existing instances to invalidate. A total count
      // is never relabelled as an invalidated count, nor can canBeUpdated prove universal compatibility.
      if (!data || typeof data.canBeUpdated !== 'boolean' || !Number.isSafeInteger(data.numberOfInstances) || data.numberOfInstances < 0)
        throw new Error(t('Error.InvalidImpact'));
      return data.numberOfInstances === 0 ? { compatible: null, invalidatedInstances: 0 } : { compatible: null };
    },
    open,
    async save(artifact, { type, publish, signal }) {
      if (!['field', 'element'].includes(type) || !context().writable) throw new Error(t('Error.Forbidden'));
      const collection = collections[type];
      const key = canonicalJson([type, artifact, publish]);
      if (running.has(key)) return running.get(key);
      const work = async () => {
        signal.throwIfAborted();
        const records = journal.read();
        let record = records[key];
        if (!record) {
          if (Object.values(records).some(entry => entry.sourceId === artifact['@id'] && entry.phase !== 'complete'))
            throw new Error(t('Error.ReusableUnconfirmed'));
          const destination = folder();
          if (!destination) throw new Error(t('Error.NoFolder'));
          const report = await request(`${base}/folders/${encodeURIComponent(resourcePathId(destination))}`, { signal });
          if (!canCreate(report.data)) throw new Error(t('Error.ForbiddenCreate'));
          signal.throwIfAborted();
          const id = mintIdentity(collection);
          if (!id) throw new Error(t('Error.InvalidArtifact'));
          const body = storageArtifact(artifact, true);
          body['@id'] = id; body['pav:version'] = '0.0.1'; body['bibo:status'] = 'bibo:draft';
          // Match the server's generated root JSON Schema labels; author-facing help is separate.
          body.title = `${body['schema:name']} ${type} schema`;
          const attribution = typeof body.description === 'string' && body.description.match(/\bgenerated by\b[\s\S]*/i)?.[0].trim();
          body.description = `${body.title} ${attribution || 'generated by the CEDAR Artifact Library'}`;
          delete body['pav:previousVersion'];
          for (const name of ['pav:createdOn', 'pav:createdBy', 'pav:lastUpdatedOn', 'oslc:modifiedBy']) body[name] = null;
          record = { id, body, sourceId: artifact['@id'], folder: destination, publish, phase: 'create' };
          // Journal before any write. Storage failure prevents dispatch.
          persist(key, record);
        }
        if (!identityIn(record.id, collection) || record.publish !== publish) throw new Error(t('Error.InvalidArtifact'));
        const url = urlFor(type, record.id);
        let stored = await read(url, { signal });
        if (!stored) {
          if (record.phase !== 'create') throw new Error(t('Error.ReusableUnconfirmed'));
          signal.throwIfAborted();
          try {
            // Do not cancel a dispatched write when the tab selection changes. Its outcome must
            // still reach the journal, even when CED can no longer attach it to the parent.
            stored = await request(`${url}?${new URLSearchParams({ folder_id: resourceSelector(record.folder) })}`,
              { method: 'PUT', body: record.body });
          } catch (error) {
            stored = await read(url);
            if (!stored) throw error;
          }
          if (!stored?.data?.['@id']) stored = await read(url);
        }
        if (!stored?.data || stored.data['@id'] !== record.id) throw new Error(t('Error.ReusableUnconfirmed'));
        const expected = JsonSourcePolicy.clone(record.stored || record.body);
        if (publish && stored.data['bibo:status'] === 'bibo:published') expected['bibo:status'] = 'bibo:published';
        if (!sameWritten(stored.data, expected)) throw new Error(t('Error.ReusableUnconfirmed'));
        record.stored = stored.data; record.phase = publish ? 'publish' : 'complete'; persist(key, record);
        if (publish && stored.data['bibo:status'] !== 'bibo:published') {
          try { await request(`${base}/command/publish-artifact`, { method: 'POST',
            body: { '@id': record.id, newVersion: '0.0.1' }, etag: stored.etag }); }
          catch (error) {
            const latest = await read(url);
            if (latest?.data?.['bibo:status'] !== 'bibo:published') throw error;
          }
          stored = await read(url);
          const published = { ...record.stored, 'bibo:status': 'bibo:published' };
          if (!stored?.data || !sameWritten(stored.data, published)) throw new Error(t('Error.ReusableUnconfirmed'));
        }
        record.stored = stored.data; record.phase = 'complete'; persist(key, record);
        return JsonSourcePolicy.clone(stored.data);
      };
      const promise = work().finally(() => running.delete(key)); running.set(key, promise);
      return promise;
    },
  };
}
