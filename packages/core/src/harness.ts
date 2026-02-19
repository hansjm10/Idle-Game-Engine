/**
 * Node entry point for `@idle-engine/core/harness`.
 *
 * This entry point re-exports the browser-safe harness surface so that both
 * Node and browser consumers share the same supported API.
 *
 * @public
 * @stability experimental
 */

export * from './harness.browser.js';
