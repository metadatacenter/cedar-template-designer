import { JsonSourcePolicy, parseJson } from './json-policy.mjs';
import { identityIn, resourcePathId } from './resource-address.mjs';
/** One tab, deployment, account and route own a draft; credentials are never stored. */
export const draftScope = (base, user, route, folder) => JSON.stringify([base, user, route.collection, route.id || '', route.id ? '' : folder]);
export function readDraft(raw, scope) {
  const value = parseJson(raw);
  if (value?.format !== 'cedar-host-draft' || value.version !== 1 || value.scope !== scope ||
      value.draft?.format !== 'cedar-designer-draft' || value.draft.version !== 1 ||
      typeof value.draft.state !== 'string' || !value.coordinator) throw new Error();
  const [, , collection, id] = JSON.parse(scope);
  const matches = artifact => typeof artifact?.['@id'] === 'string' && resourcePathId(artifact['@id']) === id;
  const { identity, creation } = value.coordinator;
  if ((id && !matches(value.coordinator.stored)) || (!id && value.coordinator.stored !== undefined) ||
    (value.coordinator.pending && (!matches(value.coordinator.pending.opened) || !matches(value.coordinator.pending.submitted)))) throw new Error();
  // A create's identity belongs to the collection being created in; a new version's to the template
  // collection, drawn from the template this draft was opened on.
  if ((identity !== undefined && !identityIn(identity, collection)) || (creation !== undefined && (!creation ||
    typeof creation !== 'object' || creation.id !== identity || (creation.operation === 'create' ? Boolean(id)
      : creation.operation !== 'version' || collection !== 'templates' || !id || !matches({ '@id': creation.source }))))) throw new Error();
  return value;
}
/** A draft whose create or new version is unsettled may hold the only record of that write, so it stays until settled. */
export const discardable = value => value?.coordinator?.uncertainCreation !== true;
export class DesignerDraftStore {
  constructor(scope, storage) { this.scope = scope; this.storage = storage; this.key = `cedar.designer.draft:${scope}`; }
  get backend() { return this.storage ?? sessionStorage; }
  read() { const raw = this.backend.getItem(this.key); return raw ? readDraft(raw, this.scope) : null; }
  write(value) { this.backend.setItem(this.key, JsonSourcePolicy.stringify(value)); }
  clear() { this.backend.removeItem(this.key); }
  capture(designer, coordinator, attempt) {
    return { format: 'cedar-host-draft', version: 1, scope: this.scope,
      draft: designer.captureDraft(), coordinator: coordinator.captureRecovery(attempt) };
  }
}
