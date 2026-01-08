/**
 * Prometheus telemetry entry point for Node.js environments.
 *
 * This module exports Prometheus-specific telemetry functionality that
 * requires prom-client (a Node.js-only library).
 *
 * @example
 * import { setTelemetry } from '@idle-engine/core/internals';
 * import { createPrometheusTelemetry } from '@idle-engine/core/prometheus';
 * // or
 * import { createPrometheusTelemetry } from '@idle-engine/core/prometheus';
 * import { setTelemetry } from '@idle-engine/core/internals';
 *
 * const promTelemetry = createPrometheusTelemetry();
 * setTelemetry(promTelemetry);
 */

export {
  createPrometheusTelemetry,
  type PrometheusTelemetryOptions,
  type PrometheusTelemetryFacade,
} from './telemetry-prometheus.js';
