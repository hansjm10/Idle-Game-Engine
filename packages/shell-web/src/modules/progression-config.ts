/**
 * Progression UI feature flag configuration.
 *
 * Controls whether the progression/resource dashboard UI is enabled in the shell.
 * Feature-flagged during rollout until the resource dashboard stabilizes.
 *
 * Requires VITE_ENABLE_PROGRESSION_UI environment variable to be explicitly set to enable.
 * Defaults to false for safe rollout.
 */

/**
 * Checks if the progression UI feature is enabled.
 * Reads from VITE_ENABLE_PROGRESSION_UI environment variable.
 * Defaults to false (disabled by default for safe rollout).
 */
export function isProgressionUIEnabled(): boolean {
  // Check Vite-prefixed env var first (build-time)
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ENABLE_PROGRESSION_UI !== undefined) {
    const value = import.meta.env.VITE_ENABLE_PROGRESSION_UI;
    return value === 'true' || value === '1' || value === true;
  }

  // Check non-prefixed var (runtime/test)
  if (typeof process !== 'undefined' && process.env?.ENABLE_PROGRESSION_UI !== undefined) {
    const value = process.env.ENABLE_PROGRESSION_UI;
    return value === 'true' || value === '1';
  }

  // Default: disabled for safe rollout
  return false;
}
