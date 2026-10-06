import { resourceSelector, resourcePathId, useDeploymentBase } from './resource-address.mjs';
export { resourceSelector, resourcePathId, useDeploymentBase };
// Loading the maps with this module's query string keeps one shared instance with host.mjs,
// which imports the same versioned URL and sets the active language on it.
const { t } = await import(`./i18n.mjs${new URL(import.meta.url).search}`);
const { DesignerCoordinator } = await import(`./host-state.mjs${new URL(import.meta.url).search}`);
export { DesignerCoordinator };

/** Angular registers CED asynchronously after its script has loaded. Bound that wait. */
export function waitForDesigner(registry, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('Error.OutdatedBundle'))), timeoutMs);
    registry.whenDefined('cedar-embeddable-designer').then(() => {
      clearTimeout(timer); resolve();
    }, error => { clearTimeout(timer); reject(error); });
  });
}

export function routeFor(pathname) {
  const match = /^\/(templates|elements|fields)\/(create|edit)(?:\/(.+))?\/?$/.exec(pathname);
  if (!match || (match[2] === 'edit' && !match[3]) || (match[2] === 'create' && match[3])) {
    throw new Error(t('Error.UnknownRoute'));
  }
  return {
    kind: { templates: 'template', elements: 'element', fields: 'field' }[match[1]],
    collection: { templates: 'templates', elements: 'template-elements', fields: 'template-fields' }[match[1]],
    id: match[3] ? decodeURIComponent(match[3]).replace(/^(https?):\/(?!\/)/, '$1://') : null,
  };
}

export function workspaceReturn(base, requested, folderId) {
  const workspace = new URL(base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(workspace.hostname);
  if (workspace.username || workspace.password || !(workspace.protocol === 'https:' || (local && workspace.protocol === 'http:'))) {
    throw new Error(t('Error.InvalidWorkspaceUrl'));
  }
  const fallback = new URL('/dashboard', workspace);
  if (folderId) fallback.searchParams.set('folderId', resourceSelector(folderId));
  try {
    const candidate = new URL(requested);
    if (candidate.origin === workspace.origin && !candidate.username && !candidate.password) return candidate.href;
  } catch { /* Missing or malformed returnTo uses the configured Workspace. */ }
  return fallback.href;
}

export function canEdit(report, artifact) {
  const capabilities = report?.currentUserPermissions?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes('updateResource') &&
    artifact['bibo:status'] !== 'bibo:published';
}
export function canCreate(folder) {
  const capabilities = folder?.currentUserPermissions?.capabilities;
  return Array.isArray(capabilities) && capabilities.includes('createInFolder');
}

export class BackendError extends Error {
  constructor(status, data, { unreadable = false } = {}) {
    // A server-supplied message is shown as the server wrote it; only the host's own text is translated.
    // Status 0 means no answer arrived.
    super(unreadable ? t('Error.UnreadableAnswer') :
      status === 0 ? t('Error.Unreachable') :
      status === 412 ? t('Error.Conflict') :
      status === 401 ? t('Error.SessionExpired') :
      status === 403 ? t('Error.Forbidden') :
      t('Error.RequestFailed', { status, detail: data?.message || data?.errorMessage || t('Error.EditsKept') }));
    this.status = status;
    this.data = data;
    this.unreadable = unreadable;
  }
}

/**
 * What a failure while the page opens says. A BackendError's own text is written for a save, so it
 * speaks of edits kept and of saving, neither of which exists before the page has opened.
 */
export function openingMessage(error, creating = false) {
  if (!(error instanceof BackendError)) return error?.message ?? String(error);
  if (error.unreadable) return t('Error.UnreadableAnswer');
  if (error.status === 0) return t('Error.Unreachable');
  if (error.status === 401) return t('Error.SessionEnded');
  if (error.status === 403) return t(creating ? 'Error.ForbiddenCreate' : 'Error.ForbiddenOpen');
  return t('Error.RequestFailed', {
    status: error.status,
    detail: error.data?.message || error.data?.errorMessage || t('Error.ReloadToRetry'),
  });
}

export function createBackend(auth, sessionId, fetcher = fetch) {
  let refreshing;
  async function refresh(minValidity) {
    if (!refreshing) refreshing = new Promise((resolve, reject) => {
      auth.refreshToken(minValidity, resolve, () => reject(new BackendError(401)));
    }).finally(() => { refreshing = null; });
    return refreshing;
  }
  return async function request(url, { method = 'GET', body, etag, signal } = {}) {
    await refresh(30);
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = { Authorization: `Bearer ${auth.getToken()}`, 'CEDAR-Client-Session-Id': sessionId, Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (etag) headers['If-Match'] = etag;
      let response;
      try {
        response = await fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
      } catch (error) {
        // A cancelled request stays a cancellation. Any other rejection means no answer arrived, and the
        // browser's own text for that is neither translated nor helpful.
        if (error?.name === 'AbortError') throw error;
        throw new BackendError(0);
      }
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch {
        // A read that answers with something other than JSON has failed: a proxy's sign-in page, or
        // a body cut short. A write's acknowledgement is judged by the save, which knows that an
        // unreadable one may still mean the write happened.
        if (response.ok && method === 'GET') throw new BackendError(response.status, null, { unreadable: true });
        data = null;
      }
      if (!response.ok && attempt === 0 && (response.status === 401 || data?.suggestedAction === 'refreshToken')) {
        await refresh(-1);
        continue;
      }
      if (!response.ok) throw new BackendError(response.status, data);
      return { data, etag: response.headers.get('ETag') };
    }
  };
}

export function childSource(request, base) {
  return {
    async search(query, { signal, cursor = '0' }) {
      const offset = Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(t('Error.InvalidSearchCursor'));
      const params = new URLSearchParams({ q: query, resource_types: 'field,element', limit: '25', offset: String(offset) });
      const { data } = await request(`${base}/search?${params}`, { signal });
      const rows = data?.resources;
      if (!Array.isArray(rows) || !Number.isSafeInteger(data.totalCount) || data.totalCount < rows.length ||
          rows.some(row => !row || typeof row['@id'] !== 'string' || !row['@id'].trim() || !['field', 'element'].includes(row.resourceType)) ||
          new Set(rows.map(row => row['@id'])).size !== rows.length) throw new Error(t('Error.InvalidChildren'));
      return {
        results: rows.map(row => ({ id: row['@id'], name: row['schema:name'], type: row.resourceType,
          version: row['pav:version'], status: row['bibo:status'], createdOn: row['pav:createdOn'], modifiedOn: row['pav:lastUpdatedOn'] })),
        ...(rows.length && offset + rows.length < data.totalCount ? { nextCursor: String(offset + rows.length) } : {}),
      };
    },
    async load(result, { signal }) {
      const collection = { field: 'template-fields', element: 'template-elements' }[result.type];
      if (!collection) throw new Error(t('Error.ChooseReusable'));
      return (await request(`${base}/${collection}/${encodeURIComponent(resourcePathId(result.id))}`, { signal })).data;
    },
  };
}

/** Storage requires explicit empty provenance on new artifacts; the server owns its values. */
export function storageArtifact(source, creating = false) {
  const result = structuredClone(source);
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    if (types.some(type => /^https:\/\/schema\.metadatacenter\.org\/core\/(Template|TemplateElement|TemplateField|StaticTemplateField)$/.test(type))) {
      for (const key of ['pav:createdOn', 'pav:createdBy', 'pav:lastUpdatedOn', 'oslc:modifiedBy']) {
        if (!(key in node)) node[key] = null;
      }
      if (node['schema:description'] == null) node['schema:description'] = '';
    }
    for (const child of Object.values(node.properties || {})) {
      visit(child);
      if (child?.items) visit(child.items);
    }
  }
  visit(result);
  if (creating) result['@id'] = null;
  return result;
}

/** Validators belong to the loaded representation, never a URL cache. */
export async function saveArtifact({ request, base, route, artifact, etag, folderId, confirmVersion, stillCurrent = () => true }) {
  const name = artifact?.['schema:name'];
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(t(`Error.NameRequired.${route.kind}`));
  }
  artifact = storageArtifact(artifact, !route.id);
  const url = `${base}/${route.collection}`;
  const current = () => { if (!stillCurrent()) throw new Error(t('Error.DocumentChanged')); };
  current();
  if (!route.id) {
    if (!folderId) throw new Error(t('Error.NoFolder'));
    return request(`${url}?${new URLSearchParams({ folder_id: resourceSelector(folderId) })}`, { method: 'POST', body: artifact });
  }
  if (!etag) throw new Error(t('Error.NoValidator'));
  artifact['@id'] = route.id; // Resolved from the loaded document, never from a short browser address.
  const encodedId = encodeURIComponent(resourcePathId(route.id));
  if (route.kind === 'template') {
    const { data: impact } = await request(`${base}/command/check-update-template/${encodedId}`, { method: 'POST', body: artifact });
    current();
    if (!impact || typeof impact.canBeUpdated !== 'boolean' ||
        (impact.numberOfInstances != null && (!Number.isSafeInteger(impact.numberOfInstances) || impact.numberOfInstances < 0)) ||
        (impact.oldVersion != null && typeof impact.oldVersion !== 'string')) throw new Error(t('Error.InvalidImpact'));
    if (!impact.canBeUpdated) {
      if (!await confirmVersion(impact)) return null;
      current();
      return request(`${base}/command/publish-create-draft-template/${encodedId}`, { method: 'POST', body: artifact, etag });
    }
  }
  return request(`${url}/${encodedId}`, { method: 'PUT', body: artifact, etag });
}
