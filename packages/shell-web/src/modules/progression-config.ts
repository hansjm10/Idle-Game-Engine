/**
 * Progression UI configuration.
 *
 * The progression UI is now enabled by default. This helper remains so callers
 * can query a single source of truth and future toggles can be reintroduced
 * without touching call sites.
 */
export function isProgressionUIEnabled(): boolean {
  return true;
}
