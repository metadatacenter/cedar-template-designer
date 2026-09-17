export function routeFor(pathname) {
  const match = /^\/(templates|elements|fields)\/(create|edit)(?:\/(.+))?\/?$/.exec(pathname);
  if (!match || (match[2] === 'edit' && !match[3]) || (match[2] === 'create' && match[3])) {
    throw new Error('Unknown designer route. Open a template, element or field from Workspace.');
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
    throw new Error('Invalid Workspace URL in frontend configuration.');
  }
  const fallback = new URL('/dashboard', workspace);
  if (folderId) fallback.searchParams.set('folderId', folderId);
  try {
    const candidate = new URL(requested);
    if (candidate.origin === workspace.origin && !candidate.username && !candidate.password) return candidate.href;
  } catch { /* Missing or malformed returnTo uses the configured Workspace. */ }
  return fallback.href;
}

export function canEdit(report, artifact) {
  return report?.currentUserPermissions?.capabilities?.includes('updateResource') === true &&
    artifact['bibo:status'] !== 'bibo:published';
}

export class BackendError extends Error {
  constructor(status, data) {
    super(status === 412 ? 'This artifact changed since you opened it. Your edits have been kept; reopen the latest version before saving.' :
      status === 401 ? 'Your session has expired. Sign in again before saving.' :
      status === 403 ? 'You do not have permission to save this artifact.' :
      `Request failed (${status}). ${data?.message || data?.errorMessage || 'Your edits have been kept.'}`);
    this.status = status;
    this.data = data;
  }
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
      const response = await fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (attempt === 0 && (response.status === 401 || data?.suggestedAction === 'refreshToken')) {
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
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid repository search cursor.');
      const params = new URLSearchParams({ q: query, resource_types: 'field,element', limit: '25', offset: String(offset) });
      const { data } = await request(`${base}/search?${params}`, { signal });
      const rows = data.resources || [];
      return {
        results: rows.map(row => ({ id: row['@id'], name: row['schema:name'], type: row.resourceType,
          version: row['pav:version'], status: row['bibo:status'], createdOn: row['pav:createdOn'], modifiedOn: row['pav:lastUpdatedOn'] })),
        ...(rows.length && offset + rows.length < data.totalCount ? { nextCursor: String(offset + rows.length) } : {}),
      };
    },
    async load(result, { signal }) {
      const collection = { field: 'template-fields', element: 'template-elements' }[result.type];
      if (!collection) throw new Error('Choose a reusable field or element.');
      return (await request(`${base}/${collection}/${encodeURIComponent(result.id)}`, { signal })).data;
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
export async function saveArtifact({ request, base, route, artifact, etag, folderId, confirmVersion }) {
  artifact = storageArtifact(artifact, !route.id);
  const url = `${base}/${route.collection}`;
  if (!route.id) {
    if (!folderId) throw new Error('No destination folder is available. Open Create from a Workspace folder.');
    return request(`${url}?${new URLSearchParams({ folder_id: folderId })}`, { method: 'POST', body: artifact });
  }
  if (!etag) throw new Error('The server did not provide a version validator. Reopen this artifact before saving.');
  const encodedId = encodeURIComponent(route.id);
  if (route.kind === 'template') {
    const { data: impact } = await request(`${base}/command/check-update-template/${encodedId}`, { method: 'POST', body: artifact });
    if (!impact.canBeUpdated) {
      if (!await confirmVersion(impact)) return null;
      return request(`${base}/command/publish-create-draft-template/${encodedId}`, { method: 'POST', body: artifact, etag });
    }
  }
  return request(`${url}/${encodedId}`, { method: 'PUT', body: artifact, etag });
}
