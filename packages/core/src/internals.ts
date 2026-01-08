/**
 * Node entry point for the full `@idle-engine/core` surface.
 *
 * This entry point is intended for engine contributors and tooling; it exports
 * everything from the browser-safe internals entry, plus Node-only telemetry.
 *
 * @internal
 * @stability experimental
 */

export * from './internals.browser.js';
export {
  createPrometheusTelemetry,
  type PrometheusTelemetryFacade,
  type PrometheusTelemetryOptions,
} from './telemetry-prometheus.js';
