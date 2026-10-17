import { applyAuthorChanges } from './author-changes.mjs';
import { creationOutcome, sameRevision, updateOutcome } from './save-recovery.mjs';

/** Compare documents independently of object key order. */
export function artifactKey(value) {
  return JSON.stringify(value, (_key, node) => node && typeof node === 'object' && !Array.isArray(node)
    ? Object.fromEntries(Object.keys(node).sort().map(key => [key, node[key]])) : node);
}

function validReport(report) {
  return report?.valid !== false && report?.canSave === true && Array.isArray(report.issues) && report.issues.every(issue => issue?.severity === 'warning');
}

/**
 * Whether the server refused a new version because only the template's owner may create one, whatever
 * role the author holds. Nothing was written, and neither a reload nor signing in again changes who owns
 * the template, so the page keeps the edits and Save as they were and offers no recovery.
 */
export function ownerOnlyRefusal(error) {
  return error?.status === 403 && error.data?.errorKey === 'versioningOnlyByOwner';
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
  // The identity the next create or new version is sent under. It is minted once and kept, across
  // reloads through the retained draft, until a write under it is confirmed, so that no retry of an
  // unsettled write can store a second artifact.
  #identity;
  // The create or new version whose answer was lost, until a read of its identity settles it.
  #creation;

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
    this.#identity = undefined;
    this.#creation = undefined;
  }
  /** The identity for this page's next create or new version, minted by `mint` the first time. */
  identity(mint) {
    this.#identity ??= mint() ?? undefined;
    return this.#identity ?? null;
  }
  #creationOf(write, attempt) {
    if (!write?.createsIdentity || !write.identity) return undefined;
    return structuredClone({ operation: write.operation, id: write.identity, submitted: write.body, projection: attempt.projection,
      ...(write.operation === 'version' ? { source: this.stored?.['@id'], etag: this.etag } : {}) });
  }
  captureRecovery(attempt) {
    const pending = this.#pendingUpdate;
    const write = attempt?.write;
    // Written before the request is sent, so that a lost answer can be settled after a reload.
    const creation = this.#creationOf(write, attempt) ?? this.#creation;
    return structuredClone({
      stored: this.stored, projection: this.#projection, etag: this.etag,
      committed: this.#committed, reloadRequired: this.reloadRequired || Boolean(write),
      server: this.#server,
      uncertainCreation: this.uncertainCreation || Boolean(write?.createsIdentity),
      identity: creation?.id ?? this.#identity,
      creation,
      pending: write && !write.createsIdentity && this.stored && this.etag
        ? { opened: this.stored, submitted: write.body, etag: this.etag, purpose: 'save', projection: attempt.projection }
        : pending ? { opened: pending.opened, submitted: pending.submitted, etag: pending.etag,
          purpose: pending.purpose, projection: pending.attempt.projection } : undefined,
    });
  }
  restoreRecovery(value) {
    const copy = structuredClone(value);
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!object(copy) || typeof copy.committed !== 'boolean' || typeof copy.reloadRequired !== 'boolean' ||
      typeof copy.uncertainCreation !== 'boolean' || (copy.stored !== undefined && !object(copy.stored)) ||
      (copy.projection !== undefined && !object(copy.projection)) || (copy.etag !== undefined && typeof copy.etag !== 'string')) throw new Error();
    if (copy.pending && (!object(copy.pending.opened) || !object(copy.pending.submitted) || !object(copy.pending.projection) ||
      typeof copy.pending.etag !== 'string' || !['save', 'access', 'acknowledgement'].includes(copy.pending.purpose))) throw new Error();
    if (copy.server && (typeof copy.server.key !== 'string' || !Array.isArray(copy.server.issues) ||
      !copy.server.issues.every(issue => object(issue) && typeof issue.message === 'string' &&
        typeof issue.location === 'string' && ['error', 'warning'].includes(issue.severity) && issue.source === 'server'))) throw new Error();
    // A journal written before identities were sent has neither field and keeps its guard.
    const creation = copy.creation;
    if ((copy.identity !== undefined && typeof copy.identity !== 'string') || (creation !== undefined && (!object(creation) ||
      !copy.uncertainCreation || creation.id !== copy.identity || !object(creation.submitted) || !object(creation.projection) ||
      (creation.occupied !== undefined && !(creation.occupied === true && creation.operation === 'create')) ||
      !(creation.operation === 'create'
        ? copy.stored === undefined && creation.source === undefined && creation.etag === undefined && creation.submitted['@id'] === creation.id
        : creation.operation === 'version' && typeof creation.source === 'string' && copy.stored?.['@id'] === creation.source &&
          typeof creation.etag === 'string' && creation.etag === copy.etag && creation.submitted['@id'] === creation.source)))) throw new Error();
    const same = this.ready && (copy.stored === undefined ? this.stored === undefined :
      sameRevision(copy.etag, this.etag) && artifactKey(copy.stored) === artifactKey(this.stored));
    this.#generation++;
    this.stored = copy.stored; this.#projection = copy.projection; this.etag = copy.etag;
    this.#committed = copy.committed;
    this.#pendingUpdate = copy.pending ? { ...copy.pending, attempt: { projection: copy.pending.projection } } : undefined;
    this.reloadRequired = (copy.stored !== undefined && copy.reloadRequired) || copy.uncertainCreation || !same || !this.writable;
    this.uncertainCreation = copy.uncertainCreation;
    this.#identity = copy.identity;
    this.#creation = creation;
    if (this.reloadRequired && !this.uncertainCreation && !this.#pendingUpdate && copy.stored && copy.etag && copy.projection)
      this.#pendingUpdate = { opened: copy.stored, submitted: copy.stored, etag: copy.etag,
        purpose: 'access', attempt: { projection: copy.projection } };
    this.#server = copy.server;
    this.ready = true; this.loadFailed = false;
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
  committed(attempt, etag, requiresReload = false, write = attempt.write) {
    if (!attempt.current()) return;
    if (!etag && !requiresReload && write?.createsIdentity === false && write.body && this.stored && this.etag) {
      this.#pendingUpdate = {attempt, opened: structuredClone(this.stored),
        submitted: structuredClone(write.body), etag: this.etag, purpose: 'acknowledgement'};
    }
    this.stored = structuredClone(attempt.artifact);
    this.#projection = structuredClone(attempt.projection);
    this.etag = etag;
    this.reloadRequired = requiresReload || !etag;
    this.#committed = true;
    this.#server = undefined;
    if (write?.createsIdentity) { this.#identity = undefined; this.#creation = undefined; }
  }
  dirty(designer) {
    if (!this.#committed) return Boolean(designer?.isDirty);
    try { return artifactKey(designer.currentArtifact) !== artifactKey(this.#projection) || designer.validationReport.issues.some(issue => issue.source === 'draft'); }
    catch { return true; }
  }
  failed(error, attempt) {
    if (!attempt?.current()) return;
    const write = attempt.write;
    // A refusal because the identity is already held shows only that some write under it was stored, and a
    // lost answer may hide which. Reading the identity settles it. It is never taken for success or failure.
    const occupied = Boolean(write?.createsIdentity && write.identity && (write.operation === 'create'
      ? [412, 428].includes(error.status) : error.status === 412 && error.data?.errorKey === 'nodeAlreadyPresent'));
    const unconfirmed = occupied || Boolean(write && (error.status == null || error.status === 0 ||
      (error.status >= 200 && error.status < 300) || error.status === 408 || error.status >= 500));
    const ownerOnly = ownerOnlyRefusal(error);
    if (unconfirmed || (!ownerOnly && [401, 403, 404, 409, 412, 428].includes(error.status))) this.reloadRequired = true;
    const accessRefused = !ownerOnly && [401, 403].includes(error.status);
    if ((unconfirmed && !attempt.write.createsIdentity || accessRefused) && this.stored && this.etag) {
      this.#pendingUpdate = {attempt, opened: structuredClone(this.stored),
        submitted: structuredClone(attempt.write?.body ?? attempt.artifact), etag: this.etag, purpose: accessRefused ? 'access' : 'save'};
    }
    if (unconfirmed && write.createsIdentity) {
      this.uncertainCreation = true;
      const creation = this.#creationOf(write, attempt);
      // A create refused as occupied stored nothing itself. What its identity holds was stored by an
      // earlier attempt, whose content may differ from this one's, and the settlement must know that.
      this.#creation = creation && occupied && write.operation === 'create' ? { ...creation, occupied: true } : creation;
      if (write.identity) this.#identity = write.identity;
    }
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
  // An unsettled create or new version is checked by reading the identity it sent. One sent before
  // identities were sent has none, so it cannot be checked and stays guarded.
  get canCheckSave() {
    return this.#active && (this.uncertainCreation ? Boolean(this.#creation)
      : ['save', 'acknowledgement'].includes(this.#pendingUpdate?.purpose));
  }
  /** The unsettled create or new version, with the template it was drawn from. */
  get creation() { return this.uncertainCreation && this.#creation ? structuredClone({ ...this.#creation, opened: this.stored }) : undefined; }
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
    if (this.#pendingUpdate.purpose === 'acknowledgement' && result === 'unchanged') return 'changed';
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
  /**
   * Settle an unsettled create or new version from reads of its identity (`created`, null when not
   * found) and, when that is absent for a version, of its source. Committed adopts what was stored as
   * the saved artifact, keeping the submitted projection as the baseline later edits are compared with.
   * A create refused as occupied is 'adopted' instead: its identity is taken as the saved artifact, but
   * an earlier attempt stored it, so nothing is a baseline for the designer's content. That content stays
   * unsaved, and the artifact must be reloaded before another save, as a new artifact the designer has
   * not adopted must be. Absent permits Save again under the same identity. Anything else changes nothing.
   */
  settleCreation(check, { created = null, source, writable }) {
    if (!check?.current() || !this.uncertainCreation || !this.#creation) return 'obsolete';
    const creation = { ...this.#creation, opened: this.stored };
    const result = creationOutcome(creation, created, source);
    if (result === 'unresolved') return result;
    if (!writable) return 'readonly';
    const adopted = result === 'committed' && creation.occupied === true;
    if (result === 'committed') {
      this.stored = structuredClone(created.data);
      // Without a baseline no retained draft can be rechecked into a save that would merge onto it.
      this.#projection = adopted ? undefined : structuredClone(creation.projection);
      this.etag = created.etag;
      this.#committed = true;
      this.reloadRequired = adopted || !created.etag;
      this.#identity = undefined;
    } else {
      if (creation.operation === 'version') { this.stored = structuredClone(source.data); this.etag = source.etag; }
      this.reloadRequired = false;
    }
    this.writable = true;
    this.uncertainCreation = false;
    this.#creation = undefined;
    this.#pendingUpdate = undefined;
    this.#server = undefined;
    return adopted ? 'adopted' : result;
  }
  finishCheck(check) { if (check?.current()) this.checking = false; }
  finish(attempt) { if (attempt?.current()) this.saving = false; }
  failLoad() { this.#generation++; this.checking = false; this.#pendingUpdate = undefined; this.saving = false; this.ready = false; this.writable = false; this.loadFailed = true; }
  dispose() { this.#active = false; this.#generation++; }
}
