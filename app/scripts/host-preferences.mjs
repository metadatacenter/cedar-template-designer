/** One browser, deployment and account own an author's preferences; they hold no credentials and no artifact content. */
export const preferenceScope = (base, user) => JSON.stringify([base, user]);
/**
 * The designer's preferences, kept in the browser beyond the page.
 *
 * A draft is the author's work, so the page says when it cannot be kept. Preferences are a
 * convenience: storage that is unavailable, full or holding something else costs the author the
 * preferences and nothing more. Reading answers null and writing answers false, and neither throws.
 * The designer documents its preferences as plain JSON, so the standard parser reads them.
 */
export class DesignerPreferenceStore {
  constructor(scope, storage) { this.scope = scope; this.storage = storage; this.key = `cedar.designer.preferences:${scope}`; }
  // A browser that withholds storage refuses the property itself, so each use reads it anew.
  get backend() { return this.storage ?? localStorage; }
  read() {
    try {
      const raw = this.backend.getItem(this.key);
      const value = raw ? JSON.parse(raw) : null;
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }
  write(preferences) {
    try { this.backend.setItem(this.key, JSON.stringify(preferences)); return true; } catch { return false; }
  }
}
