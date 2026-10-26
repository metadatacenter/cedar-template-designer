import { saveArtifact as save } from '../../app/scripts/host-core.mjs';

// Orchestration fixtures use deliberately partial artifacts. Their structural verdict and the
// server's preflight are explicit test doubles; payload-validation.test.mjs exercises both real
// boundaries, and the browser conformance suite checks complete CED output with both libraries.
export const acceptPayload = () => ({canSave: true, findings: []});
export const accepted = () => ({data: {canSave: true, isValid: true, errors: [], warnings: []}});
export function saveArtifact(options) {
  return save({...options, request: (url, request) => url.includes('/command/validate?')
    ? Promise.resolve(accepted()) : options.request(url, request)});
}
