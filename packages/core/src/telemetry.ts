/* eslint-disable no-console */

export type TelemetryEventData = Readonly<Record<string, unknown>>;

export interface TelemetryFacade {
  recordError(event: string, data?: TelemetryEventData): void;
  recordWarning(event: string, data?: TelemetryEventData): void;
  recordProgress(event: string, data?: TelemetryEventData): void;
  recordCounters(group: string, counters: Readonly<Record<string, number>>): void;
  recordTick(): void;
}

const consoleTelemetry: TelemetryFacade = {
  recordError(event, data) {
    console.error(`[telemetry:error] ${event}`, data);
  },
  recordWarning(event, data) {
    console.warn(`[telemetry:warning] ${event}`, data);
  },
  recordProgress(event, data) {
    console.info(`[telemetry:progress] ${event}`, data);
  },
  recordCounters(group, counters) {
    console.info(`[telemetry:counters] ${group}`, counters);
  },
  recordTick() {
    console.debug('[telemetry:tick]');
  },
};

/**
 * A no-op telemetry implementation that silently discards all events.
 * This is the default telemetry facade.
 */
export const silentTelemetry: TelemetryFacade = {
  recordError() {},
  recordWarning() {},
  recordProgress() {},
  recordCounters() {},
  recordTick() {},
};

/**
 * Creates a telemetry facade that logs all events to the console.
 * Use this for development/debugging when you want to see telemetry output.
 *
 * @example
 * import { setTelemetry, createConsoleTelemetry } from '@idle-engine/core';
 * setTelemetry(createConsoleTelemetry());
 */
export function createConsoleTelemetry(): TelemetryFacade {
  return consoleTelemetry;
}

let activeTelemetry: TelemetryFacade = silentTelemetry;

export const telemetry: TelemetryFacade = {
  recordError(event, data) {
    invokeSafely(activeTelemetry, 'recordError', event, data);
  },
  recordWarning(event, data) {
    invokeSafely(activeTelemetry, 'recordWarning', event, data);
  },
  recordProgress(event, data) {
    invokeSafely(activeTelemetry, 'recordProgress', event, data);
  },
  recordCounters(group, counters) {
    invokeSafely(activeTelemetry, 'recordCounters', group, counters);
  },
  recordTick() {
    invokeSafely(activeTelemetry, 'recordTick');
  },
};

export function setTelemetry(facade: TelemetryFacade): void {
  activeTelemetry = facade;
}

export function resetTelemetry(): void {
  activeTelemetry = silentTelemetry;
}

function invokeSafely<TMethod extends keyof TelemetryFacade>(
  facade: TelemetryFacade,
  method: TMethod,
  ...args: Parameters<TelemetryFacade[TMethod]>
): void {
  try {
    (
      facade[method] as (
        ...fnArgs: Parameters<TelemetryFacade[TMethod]>
      ) => ReturnType<TelemetryFacade[TMethod]>
    ).call(facade, ...args);
  } catch (error) {
    console.error('[telemetry] invocation failed', error);
  }
}
