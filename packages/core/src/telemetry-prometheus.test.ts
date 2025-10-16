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

    expect(published?.values[0]?.value).toBe(8);
    expect(softLimited?.values[0]?.value).toBe(3);
    expect(overflowed?.values[0]?.value).toBe(1);
    expect(subscribers?.values[0]?.value).toBe(6);
    expect(slowHandlers?.values[0]?.value).toBe(1);
  });
});
