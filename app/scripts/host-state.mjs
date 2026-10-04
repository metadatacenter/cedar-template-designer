/** Compare documents independently of object key order. */
export function artifactKey(value) {
  return JSON.stringify(value, (_key, node) => node && typeof node === 'object' && !Array.isArray(node)
    ? Object.fromEntries(Object.keys(node).sort().map(key => [key, node[key]])) : node);
}

function validReport(report) {
  return report?.valid !== false && report?.canSave === true && Array.isArray(report.issues) && report.issues.length === 0;
}

/** Owns the host's readiness, pending write and reports about its submitted document. */
export class DesignerCoordinator {
  ready = false;
  writable = false;
  saving = false;
  reloadRequired = false;
  uncertainCreation = false;
  loadFailed = false;
  stored;
  etag;
  #generation = 0;
  #active = true;
  #server;
  #committed = false;

  loaded({ artifact, etag, writable }) {
    if (!this.#active) return;
    this.#generation++;
    this.saving = false;
    this.stored = structuredClone(artifact);
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
    const local = complete ? validation.issues : [];
    const server = this.#server?.issues ?? [];
    return {
      canSave: this.#active && this.ready && this.writable && !this.saving && !this.reloadRequired &&
        readable && validReport(validation) &&
        !server.some(issue => issue.severity === 'error'),
      issues: [...local, ...server], server,
      phase: !this.#active ? 'closed' : this.loadFailed ? 'failed' : !this.ready ? 'loading' : this.saving ? 'saving' : this.reloadRequired ? 'reload' : 'ready',
    };
  }
  beginSave(designer) {
    if (!this.#active || !this.ready || !this.writable || this.saving || this.reloadRequired) return null;
    if (!this.report(designer, designer.validate()).canSave) return null;
    const artifact = structuredClone(designer.currentArtifact);
    const generation = ++this.#generation;
    this.saving = true;
    return { artifact, key: artifactKey(artifact), current: () => this.#active && generation === this.#generation };
  }
  unchanged(attempt, artifact) { return attempt.current() && attempt.key === artifactKey(artifact); }
  matches(attempt, designer) {
    try { return validReport(designer.validate()) && this.unchanged(attempt, designer.currentArtifact); }
    catch { return false; }
  }
  committed(attempt, etag, requiresReload = false) {
    if (!attempt.current()) return;
    this.stored = structuredClone(attempt.artifact);
    this.etag = etag;
    this.reloadRequired = requiresReload || !etag;
    this.#committed = true;
    this.#server = undefined;
  }
  dirty(designer) {
    if (!this.#committed) return Boolean(designer?.isDirty);
    try { return artifactKey(designer.currentArtifact) !== artifactKey(this.stored) || designer.validationReport.issues.some(issue => issue.source === 'draft'); }
    catch { return true; }
  }
  failed(error, attempt) {
    if (!attempt?.current()) return;
    if ([403, 404, 409, 412, 428].includes(error.status)) this.reloadRequired = true;
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
  }
  finish(attempt) { if (attempt?.current()) this.saving = false; }
  failLoad() { this.#generation++; this.saving = false; this.ready = false; this.writable = false; this.loadFailed = true; }
  dispose() { this.#active = false; this.#generation++; }
}
