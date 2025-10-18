import { describe, expect, it } from 'vitest';
import { Registry } from 'prom-client';

import { createPrometheusTelemetry } from './telemetry-prometheus.js';

describe('createPrometheusTelemetry', () => {
  it('updates Prometheus metrics when counters are recorded', async () => {
    const registry = new Registry();
    const telemetry = createPrometheusTelemetry({
      registry,
      collectDefaultMetrics: false,
      prefix: 'test_',
    });

    telemetry.recordCounters('events', {
      published: 5,
      softLimited: 2,
      overflowed: 1,
      subscribers: 4,
    });

    telemetry.recordCounters('events', {
      published: 3,
      softLimited: 1,
      overflowed: 0,
      subscribers: 6,
    });

    telemetry.recordWarning('EventHandlerSlow');
    telemetry.recordWarning('TickExecutionSlow');
    telemetry.recordWarning('SystemExecutionSlow', { systemId: 'alpha' });
    telemetry.recordWarning('SystemExecutionSlow', { systemId: 'alpha' });
    telemetry.recordWarning('SystemExecutionSlow', {
      systemId: 'beta',
    });
    telemetry.recordWarning('SystemExecutionSlow', { systemId: 123 });
    telemetry.recordCounters('events.cooldown_ticks', {
      'channel:0': 3,
      'channel:1': 0,
    });
    telemetry.recordCounters('events.soft_limit_breaches', {
      'channel:0': 2,
      'channel:1': 1,
    });

    const published = await registry
      .getSingleMetric('test_events_published_total')
      ?.get();
    const softLimited = await registry
      .getSingleMetric('test_events_soft_limited_total')
      ?.get();
    const overflowed = await registry
      .getSingleMetric('test_events_overflowed_total')
      ?.get();
    const subscribers = await registry
      .getSingleMetric('test_events_subscribers')
      ?.get();
    const slowHandlers = await registry
      .getSingleMetric('test_events_slow_handlers_total')
      ?.get();
    const cooldownTicks = await registry
      .getSingleMetric('test_events_soft_limit_cooldown_ticks')
      ?.get();
    const softLimitBreaches = await registry
      .getSingleMetric('test_events_soft_limit_breaches_total')
      ?.get();
    const ticksOverBudget = await registry
      .getSingleMetric('test_runtime_ticks_over_budget_total')
      ?.get();
    const slowSystems = await registry
      .getSingleMetric('test_runtime_system_slow_total')
      ?.get();

    expect(published?.values[0]?.value).toBe(8);
    expect(softLimited?.values[0]?.value).toBe(3);
    expect(overflowed?.values[0]?.value).toBe(1);
    expect(subscribers?.values[0]?.value).toBe(6);
    expect(slowHandlers?.values[0]?.value).toBe(1);
    expect(ticksOverBudget?.values[0]?.value).toBe(1);
    expect(slowSystems?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 2,
          labels: { system_id: 'alpha' },
        }),
        expect.objectContaining({
          value: 1,
          labels: { system_id: 'beta' },
        }),
      ]),
    );
    expect(cooldownTicks?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 3, labels: { channel: '0' } }),
        expect.objectContaining({ value: 0, labels: { channel: '1' } }),
      ]),
    );
    expect(softLimitBreaches?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 2, labels: { channel: '0' } }),
        expect.objectContaining({ value: 1, labels: { channel: '1' } }),
      ]),
    );
  });
});
