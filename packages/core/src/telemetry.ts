export type TelemetryEventData = Readonly<Record<string, unknown>>;

export interface TelemetryFacade {
  recordError(event: string, data?: TelemetryEventData): void;
  recordWarning(event: string, data?: TelemetryEventData): void;
  recordProgress(event: string, data?: TelemetryEventData): void;
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
  recordTick() {
    console.debug('[telemetry:tick]');
  },
};

let activeTelemetry: TelemetryFacade = consoleTelemetry;

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
  recordTick() {
    invokeSafely(activeTelemetry, 'recordTick');
  },
};

export function setTelemetry(facade: TelemetryFacade): void {
  activeTelemetry = facade;
}

export function resetTelemetry(): void {
  activeTelemetry = consoleTelemetry;
}

function invokeSafely(
  facade: TelemetryFacade,
  method: keyof TelemetryFacade,
  ...args: unknown[]
): void {
  try {
    const fn = facade[method] as (...fnArgs: unknown[]) => void;
    fn.apply(facade, args);
  } catch (error) {
    console.error('[telemetry] invocation failed', error);
  }
}
