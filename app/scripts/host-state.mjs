import { applyAuthorChanges } from './author-changes.mjs';
import { updateOutcome } from './save-recovery.mjs';

/** Compare documents independently of object key order. */
export function artifactKey(value) {
  return JSON.stringify(value, (_key, node) => node && typeof node === 'object' && !Array.isArray(node)
    ? Object.fromEntries(Object.keys(node).sort().map(key => [key, node[key]])) : node);
}

function validReport(report) {
  return report?.valid !== false && report?.canSave === true && Array.isArray(report.issues) && report.issues.every(issue => issue?.severity === 'warning');
}

/** Owns the host's readiness, pending write and reports about its submitted document. */
export class DesignerCoordinator {
  ready = false;
  writable = false;
  saving = false;
  checking = false;
  reloadRequired = false;
  uncertainCreation = false;
  loadFailed = false;
  stored;
  etag;
  #generation = 0;
  #active = true;
  #server;
  #committed = false;
  #projection;
  #pendingUpdate;

  loaded({ artifact, projection = artifact, etag, writable }) {
    if (!this.#active) return;
    this.#generation++;
    this.saving = false;
    this.checking = false;
    this.#pendingUpdate = undefined;
    this.stored = structuredClone(artifact);
    this.#projection = structuredClone(projection);
    this.etag = etag;
    this.writable = writable === true;
    this.ready = true;
    this.reloadRequired = false;
    this.uncertainCreation = false;
    this.loadFailed = false;
    this.#server = undefined;
    this.#committed = false;
  }
  report(designer, validation = designer?.validationReport) {
    let readable = true;
    if (this.#server || validReport(validation)) {
      try {
        const artifact = designer?.currentArtifact;
        readable = Boolean(artifact && typeof artifact === 'object' && !Array.isArray(artifact));
        if (this.#server && this.#server.key !== artifactKey(artifact)) this.#server = undefined;
      }
      catch { readable = false; }
    }
    const complete = Array.isArray(validation?.issues) && validation.issues.every(issue => issue && typeof issue === 'object');
    const local = complete ? validation.issues.filter(issue => issue.source !== 'host') : [];
    const server = this.#server?.issues ?? [];
    return {
      canSave: this.#active && this.ready && this.writable && !this.saving && !this.checking && !this.reloadRequired &&
        readable && validReport(validation) &&
        !server.some(issue => issue.severity === 'error'),
      issues: [...local, ...server], server,
      phase: !this.#active ? 'closed' : this.loadFailed ? 'failed' : !this.ready ? 'loading' : this.saving ? 'saving' : this.reloadRequired ? 'reload' : 'ready',
    };
  }
  beginSave(designer) {
    if (!this.#active || !this.ready || !this.writable || this.saving || this.reloadRequired) return null;
    if (!this.report(designer, designer.validate()).canSave) return null;
    const projection = structuredClone(designer.currentArtifact);
    const artifact = this.stored === undefined ? structuredClone(projection)
      : applyAuthorChanges(this.stored, this.#projection, projection);
    const generation = ++this.#generation;
    this.saving = true;
    return { artifact, projection, key: artifactKey(projection), current: () => this.#active && generation === this.#generation };
  }
  unchanged(attempt, artifact) { return attempt.current() && attempt.key === artifactKey(artifact); }
  matches(attempt, designer) {
    try { return validReport(designer.validate()) && this.unchanged(attempt, designer.currentArtifact); }
    catch { return false; }
  }
  committed(attempt, etag, requiresReload = false) {
    if (!attempt.current()) return;
    this.stored = structuredClone(attempt.artifact);
    this.#projection = structuredClone(attempt.projection);
    this.etag = etag;
    this.reloadRequired = requiresReload || !etag;
    this.#committed = true;
    this.#server = undefined;
  }
  dirty(designer) {
    if (!this.#committed) return Boolean(designer?.isDirty);
    try { return artifactKey(designer.currentArtifact) !== artifactKey(this.#projection) || designer.validationReport.issues.some(issue => issue.source === 'draft'); }
    catch { return true; }
  }
  failed(error, attempt) {
    if (!attempt?.current()) return;
    const unconfirmed = Boolean(attempt.write && (error.status == null || error.status === 0 ||
      (error.status >= 200 && error.status < 300) || error.status === 408 || error.status >= 500));
    if (unconfirmed || [401, 403, 404, 409, 412, 428].includes(error.status)) this.reloadRequired = true;
    const accessRefused = [401, 403].includes(error.status);
    if ((unconfirmed && !attempt.write.createsIdentity || accessRefused) && this.stored && this.etag) {
      this.#pendingUpdate = {attempt, opened: structuredClone(this.stored),
        submitted: structuredClone(attempt.write?.body ?? attempt.artifact), etag: this.etag, purpose: accessRefused ? 'access' : 'save'};
    }
    if (unconfirmed && attempt.write.createsIdentity) this.uncertainCreation = true;
    const report = error.data?.objects?.validationReport ?? error.data?.validationReport;
    const issues = [];
    for (const severity of ['error', 'warning']) {
      const rows = report?.[severity === 'error' ? 'errors' : 'warnings'];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) if (row && typeof row.message === 'string') issues.push({
        message: row.message, location: typeof row.location === 'string' ? row.location : '', severity, source: 'server', shown: true,
      });
    }
    this.#server = { key: attempt.key, issues };
    return unconfirmed;
  }
  get canCheckSave() { return this.#active && this.#pendingUpdate?.purpose === 'save' && !this.uncertainCreation; }
  get canRecheckAccess() { return this.#active && this.#pendingUpdate?.purpose === 'access' && !this.uncertainCreation; }
  beginCheck() {
    if (!(this.canCheckSave || this.canRecheckAccess) || this.saving || this.checking) return null;
    const generation = ++this.#generation;
    this.checking = true;
    return { current: () => this.#active && generation === this.#generation };
  }
  checked(check, latest, writable) {
    if (!check?.current() || !this.#pendingUpdate) return 'obsolete';
    if (!writable) return 'readonly';
    const result = updateOutcome(this.#pendingUpdate, latest);
    if (this.#pendingUpdate.purpose === 'access' && result !== 'unchanged') return 'changed';
    if (result !== 'saved' && result !== 'unchanged') return result;
    if (result === 'saved') {
      this.stored = structuredClone(latest.data);
      this.#projection = structuredClone(this.#pendingUpdate.attempt.projection);
      this.etag = latest.etag;
      this.#committed = true;
    }
    // An unchanged revision permits another conditional update. A late first
    // commit still wins only once: the server refuses the stale retry with 412.
    this.reloadRequired = false;
    this.writable = true;
    this.#server = undefined;
    this.#pendingUpdate = undefined;
    return result;
  }
  finishCheck(check) { if (check?.current()) this.checking = false; }
  finish(attempt) { if (attempt?.current()) this.saving = false; }
  failLoad() { this.#generation++; this.checking = false; this.#pendingUpdate = undefined; this.saving = false; this.ready = false; this.writable = false; this.loadFailed = true; }
  dispose() { this.#active = false; this.#generation++; }
}
