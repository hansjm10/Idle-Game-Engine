/**
 * Persistence UI feature flag configuration.
 *
 * Controls whether the persistence UI panel is enabled in the shell.
 * Feature-flagged during rollout until persistence stabilizes.
 *
 * See docs/runtime-react-worker-bridge-design.md §14.1
 */

/**
 * Checks if the persistence UI feature is enabled.
 * Reads from VITE_ENABLE_PERSISTENCE_UI or ENABLE_PERSISTENCE_UI environment variables.
 * Defaults to true in development/test, false in production.
 */
export function isPersistenceUIEnabled(): boolean {
  // Check Vite-prefixed env var first (build-time)
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ENABLE_PERSISTENCE_UI !== undefined) {
    const value = import.meta.env.VITE_ENABLE_PERSISTENCE_UI;
    return value === 'true' || value === '1' || value === true;
  }

  // Check non-prefixed var (runtime)
  if (typeof process !== 'undefined' && process.env?.ENABLE_PERSISTENCE_UI !== undefined) {
    const value = process.env.ENABLE_PERSISTENCE_UI;
    return value === 'true' || value === '1';
  }

  // Default: prefer NODE_ENV when available (test harness controls this),
  // otherwise fall back to Vite's import.meta.env.
  const nodeEnv = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
  if (typeof nodeEnv === 'string') {
    return nodeEnv.toLowerCase() !== 'production';
  }

  if (typeof import.meta !== 'undefined') {
    if (import.meta.env?.DEV) {
      return true;
    }
    const mode = typeof import.meta.env?.MODE === 'string'
      ? import.meta.env.MODE.toLowerCase()
      : undefined;
    if (mode === 'development' || mode === 'test') {
      return true;
    }
  }

  return false;
}
