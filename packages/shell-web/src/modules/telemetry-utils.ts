/**
 * Shared telemetry utilities for shell-web components.
 *
 * Provides a centralized facade for recording events and errors via the
 * global __IDLE_ENGINE_TELEMETRY__ object. All methods use optional chaining
 * to gracefully handle missing telemetry facade.
 */

/**
 * Telemetry facade interface for shell components.
 * Extends the core TelemetryFacade with shell-specific methods.
 */
export interface ShellTelemetryFacade {
  recordError?: (event: string, data?: Record<string, unknown>) => void;
  recordEvent?: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * Global type augmentation for __IDLE_ENGINE_TELEMETRY__.
 */
declare global {
  interface Window {
    __IDLE_ENGINE_TELEMETRY__?: ShellTelemetryFacade;
  }

  // Also on globalThis for non-browser environments
  var __IDLE_ENGINE_TELEMETRY__: ShellTelemetryFacade | undefined;
}

/**
 * Gets the global telemetry facade if available.
 *
 * @returns The telemetry facade, or undefined if not initialized
 */
export function getTelemetryFacade(): ShellTelemetryFacade | undefined {
  return (globalThis as { __IDLE_ENGINE_TELEMETRY__?: ShellTelemetryFacade })
    .__IDLE_ENGINE_TELEMETRY__;
}

/**
 * Records a telemetry event.
 *
 * Safe to call even if telemetry is not configured - uses optional chaining
 * to avoid errors when the facade is missing.
 *
 * @param event - Event name (e.g., 'PersistenceUIManualSaveClicked')
 * @param data - Event data payload
 *
 * @example
 * recordTelemetryEvent('PersistenceUIManualSaveClicked', { slotId: 'default' });
 */
export function recordTelemetryEvent(
  event: string,
  data: Record<string, unknown>,
): void {
  getTelemetryFacade()?.recordEvent?.(event, data);
}

/**
 * Records a telemetry error.
 *
 * Safe to call even if telemetry is not configured - uses optional chaining
 * to avoid errors when the facade is missing.
 *
 * @param event - Error event name (e.g., 'ErrorBoundaryCaughtError')
 * @param data - Error data payload
 *
 * @example
 * recordTelemetryError('ErrorBoundaryCaughtError', {
 *   boundaryName: 'PersistenceUI',
 *   errorMessage: error.message
 * });
 */
export function recordTelemetryError(
  event: string,
  data: Record<string, unknown>,
): void {
  getTelemetryFacade()?.recordError?.(event, data);
}
