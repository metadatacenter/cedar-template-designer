// One runtime graph, with each component retaining its own application injector.
import 'zone.js';
async function registerEditors() {
  await import('cedar-embeddable-editor/integration.mjs');
  await customElements.whenDefined('cedar-embeddable-editor');
  await import('cedar-embeddable-term-picker/integration.mjs');
  await customElements.whenDefined('cedar-embeddable-term-picker');
  await import('cedar-embeddable-designer/integration.mjs');
}
registerEditors().catch(error => console.error('CEDAR editor integration failed', error));
