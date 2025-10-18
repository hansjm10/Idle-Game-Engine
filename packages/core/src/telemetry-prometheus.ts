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
  readonly softLimitCooldown: Gauge<string>;
  readonly softLimitBreaches: Counter<string>;
}

interface DiagnosticsCounters {
  readonly ticksOverBudget: Counter<string>;
  readonly slowSystem: Counter<string>;
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
    softLimitCooldown: new Gauge({
      name: `${prefix}events_soft_limit_cooldown_ticks`,
      help: 'Current cooldown ticks remaining before the next soft limit warning per channel.',
      registers: [registry],
      labelNames: ['channel'],
    }),
    softLimitBreaches: new Counter({
      name: `${prefix}events_soft_limit_breaches_total`,
      help: 'Total number of soft limit warnings emitted per channel.',
      registers: [registry],
      labelNames: ['channel'],
    }),
  };

  const diagnosticsCounters: DiagnosticsCounters = {
    ticksOverBudget: new Counter({
      name: `${prefix}runtime_ticks_over_budget_total`,
      help: 'Total number of runtime ticks that exceeded their budget.',
      registers: [registry],
    }),
    slowSystem: new Counter({
      name: `${prefix}runtime_system_slow_total`,
      help: 'Total number of runtime system slow warnings emitted.',
      registers: [registry],
      labelNames: ['system_id'],
    }),
  };

  const registeredSlowSystemLabels = new Set<string>();

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
      } else if (event === 'TickExecutionSlow') {
        diagnosticsCounters.ticksOverBudget.inc();
      } else if (
        event === 'SystemExecutionSlow' &&
        typeof data?.systemId === 'string' &&
        data.systemId.length > 0
      ) {
        const systemId = data.systemId;
        if (!registeredSlowSystemLabels.has(systemId)) {
          diagnosticsCounters.slowSystem.labels({ system_id: systemId });
          registeredSlowSystemLabels.add(systemId);
        }
        diagnosticsCounters.slowSystem.inc({ system_id: systemId });
      }

      logWarning(`[telemetry:warning] ${event}`, data);
    },
    recordProgress(event: string, data?: TelemetryEventData) {
      logInfo(`[telemetry:progress] ${event}`, data);
    },
    recordCounters(group: string, counters: Readonly<Record<string, number>>) {
      if (group === 'events') {
        updateEventCounters(eventCounters, counters);
      } else if (group === 'events.cooldown_ticks') {
        updateChannelGauge(eventCounters.softLimitCooldown, counters);
      } else if (group === 'events.soft_limit_breaches') {
        updateChannelCounter(eventCounters.softLimitBreaches, counters);
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

  // The runtime resets its event counters every tick, so the provided values are per-tick increments.
  if (typeof published === 'number') {
    if (published > 0) {
      counters.published.inc(published);
    }
  }

  if (typeof softLimited === 'number') {
    if (softLimited > 0) {
      counters.softLimited.inc(softLimited);
    }
  }

  if (typeof overflowed === 'number') {
    if (overflowed > 0) {
      counters.overflowed.inc(overflowed);
    }
  }

  if (typeof subscribers === 'number') {
    counters.subscribers.set(subscribers);
  }
}

function updateChannelGauge(
  gauge: Gauge<string>,
  values: Readonly<Record<string, number>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    const channel = parseChannelLabel(key);
    if (!channel || typeof value !== 'number' || !Number.isFinite(value)) {
      continue;
    }
    gauge.set({ channel }, value);
  }
}

function updateChannelCounter(
  counter: Counter<string>,
  values: Readonly<Record<string, number>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    const channel = parseChannelLabel(key);
    if (
      !channel ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0
    ) {
      continue;
    }
    counter.inc({ channel }, value);
  }
}

function parseChannelLabel(key: string): string | null {
  if (!key.startsWith('channel:')) {
    return null;
  }
  const label = key.slice('channel:'.length);
  if (label.length === 0) {
    return null;
  }
  return label;
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
