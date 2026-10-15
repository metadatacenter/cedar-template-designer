/** One tab, deployment, account and route own a draft; credentials are never stored. */
export const draftScope = (base, user, route, folder) => JSON.stringify([base, user, route.collection, route.id || '', route.id ? '' : folder]);
export function readDraft(raw, scope) {
  const value = JSON.parse(raw);
  if (value?.format !== 'cedar-host-draft' || value.version !== 1 || value.scope !== scope ||
      value.draft?.format !== 'cedar-designer-draft' || value.draft.version !== 1 ||
      typeof value.draft.state !== 'string' || !value.coordinator) throw new Error();
  return value;
}
export class DesignerDraftStore {
  constructor(scope, storage) { this.scope = scope; this.storage = storage; this.key = `cedar.designer.draft:${scope}`; }
  get backend() { return this.storage ?? sessionStorage; }
  read() { const raw = this.backend.getItem(this.key); return raw ? readDraft(raw, this.scope) : null; }
  write(value) { this.backend.setItem(this.key, JSON.stringify(value)); }
  clear() { this.backend.removeItem(this.key); }
  capture(designer, coordinator, attempt) {
    return { format: 'cedar-host-draft', version: 1, scope: this.scope,
      draft: designer.captureDraft(), coordinator: coordinator.captureRecovery(attempt) };
  }
}
