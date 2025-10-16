/* eslint-disable no-console */

import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

import type { TelemetryEventData, TelemetryFacade } from './telemetry.js';

export interface PrometheusTelemetryOptions {
  readonly registry?: Registry;
  readonly prefix?: string;
  readonly collectDefaultMetrics?: boolean;
}

interface EventCounters {
  readonly published: Counter<string>;
  readonly softLimited: Counter<string>;
  readonly overflowed: Counter<string>;
  readonly subscribers: Gauge<string>;
  readonly slowHandler: Counter<string>;
}

const DEFAULT_PREFIX = 'idle_engine_';

export interface PrometheusTelemetryFacade extends TelemetryFacade {
  readonly registry: Registry;
}

export function createPrometheusTelemetry(
  options: PrometheusTelemetryOptions = {},
): PrometheusTelemetryFacade {
  const registry = options.registry ?? new Registry();
  const prefix = options.prefix ?? DEFAULT_PREFIX;

  if (options.collectDefaultMetrics ?? true) {
    collectDefaultMetrics({ register: registry, prefix });
  }

  const errors = new Counter({
    name: `${prefix}telemetry_errors_total`,
    help: 'Total number of telemetry errors emitted by the runtime.',
    registers: [registry],
    labelNames: ['event'],
  });

  const warnings = new Counter({
    name: `${prefix}telemetry_warnings_total`,
    help: 'Total number of telemetry warnings emitted by the runtime.',
    registers: [registry],
    labelNames: ['event'],
  });

  const ticks = new Counter({
    name: `${prefix}runtime_ticks_total`,
    help: 'Total number of ticks executed by the runtime.',
    registers: [registry],
  });

  const eventCounters: EventCounters = {
    published: new Counter({
      name: `${prefix}events_published_total`,
      help: 'Total number of runtime events published.',
      registers: [registry],
    }),
    softLimited: new Counter({
      name: `${prefix}events_soft_limited_total`,
      help: 'Total number of runtime events that crossed the soft limit.',
      registers: [registry],
    }),
    overflowed: new Counter({
      name: `${prefix}events_overflowed_total`,
      help: 'Total number of runtime events dropped due to overflow.',
      registers: [registry],
    }),
    subscribers: new Gauge({
      name: `${prefix}events_subscribers`,
      help: 'Number of active runtime event subscribers.',
      registers: [registry],
    }),
    slowHandler: new Counter({
      name: `${prefix}events_slow_handlers_total`,
      help: 'Total number of slow runtime event handler executions.',
      registers: [registry],
    }),
  };

  const logError = createConsoleLogger('error');
  const logWarning = createConsoleLogger('warn');
  const logInfo = createConsoleLogger('info');

  const facade: PrometheusTelemetryFacade = {
    recordError(event: string, data?: TelemetryEventData) {
      errors.inc({ event });
      logError(`[telemetry:error] ${event}`, data);
    },
    recordWarning(event: string, data?: TelemetryEventData) {
      warnings.inc({ event });

      if (event === 'EventHandlerSlow') {
        eventCounters.slowHandler.inc();
      }

      logWarning(`[telemetry:warning] ${event}`, data);
    },
    recordProgress(event: string, data?: TelemetryEventData) {
      logInfo(`[telemetry:progress] ${event}`, data);
    },
    recordCounters(group: string, counters: Readonly<Record<string, number>>) {
      if (group === 'events') {
        updateEventCounters(eventCounters, counters);
      }
    },
    recordTick() {
      ticks.inc();
    },
    registry,
  };

  return facade;
}

function updateEventCounters(
  counters: EventCounters,
  values: Readonly<Record<string, number>>,
): void {
  const { published, softLimited, overflowed, subscribers } = values;

  if (typeof published === 'number' && published > 0) {
    counters.published.inc(published);
  }

  if (typeof softLimited === 'number' && softLimited > 0) {
    counters.softLimited.inc(softLimited);
  }

  if (typeof overflowed === 'number' && overflowed > 0) {
    counters.overflowed.inc(overflowed);
  }

  if (typeof subscribers === 'number') {
    counters.subscribers.set(subscribers);
  }
}

type ConsoleMethod = (message?: unknown, ...optionalParams: unknown[]) => void;

function createConsoleLogger<
  TMethod extends 'error' | 'warn' | 'info',
>(method: TMethod): ConsoleMethod {
  if (typeof console?.[method] === 'function') {
    return console[method].bind(console);
  }
  return () => {};
}
