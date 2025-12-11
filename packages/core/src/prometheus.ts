/**
 * Prometheus telemetry entry point for Node.js environments.
 *
 * This module exports Prometheus-specific telemetry functionality that
 * requires prom-client (a Node.js-only library).
 *
 * @example
 * import { createPrometheusTelemetry, setTelemetry } from '@idle-engine/core';
 * // or
 * import { createPrometheusTelemetry } from '@idle-engine/core/prometheus';
 * import { setTelemetry } from '@idle-engine/core';
 *
 * const promTelemetry = createPrometheusTelemetry();
 * setTelemetry(promTelemetry);
 */

export {
  createPrometheusTelemetry,
  type PrometheusTelemetryOptions,
  type PrometheusTelemetryFacade,
} from './telemetry-prometheus.js';
