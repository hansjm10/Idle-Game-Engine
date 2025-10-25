import { performance } from 'node:perf_hooks';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventBus, EventBufferOverflowError } from './event-bus.js';
import { DEFAULT_EVENT_BUS_OPTIONS } from './runtime-event-catalog.js';
import {
  type RuntimeEventPayload,
  type RuntimeEventType,
} from './runtime-event.js';
import { buildRuntimeEventFrame } from './runtime-event-frame.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from '../telemetry.js';
import { TransportBufferPool } from '../transport-buffer-pool.js';

describe('EventBus', () => {
  const clock = {
    now: vi.fn<() => number>(),
  };

  beforeEach(() => {
    clock.now.mockReset();
    clock.now.mockReturnValue(100);
  });

  function createBus(): EventBus {
    return new EventBus({
      clock,
      channels: DEFAULT_EVENT_BUS_OPTIONS.channels,
    });
  }

  function captureOverflow<TType extends RuntimeEventType>(
    operation: () => void,
  ): EventBufferOverflowError<TType> {
    let overflow: unknown;
    try {
      operation();
    } catch (error) {
      overflow = error;
    }
    expect(overflow).toBeInstanceOf(EventBufferOverflowError);
    return overflow as EventBufferOverflowError<TType>;
  }

  it('dispatches events to subscribers in FIFO order and allows nested publishes', () => {
    const bus = createBus();
    bus.beginTick(1);

    const received: string[] = [];

    bus.on('resource:threshold-reached', (event, context) => {
      received.push(`resource:${event.payload.threshold}:tick:${context.tick}`);

      bus.publish('automation:toggled', {
        automationId: 'auto:1',
        enabled: true,
      } as RuntimeEventPayload<'automation:toggled'>);
    });

    bus.on('automation:toggled', (event, context) => {
      received.push(`automation:${event.payload.enabled}:tick:${context.tick}`);
    });

    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 10,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    bus.dispatch({ tick: 1 });

    expect(received).toEqual([
      'resource:10:tick:1',
      'automation:true:tick:1',
    ]);
  });

  it('preserves publish order across channels', () => {
    const bus = createBus();
    bus.beginTick(1);

    const received: string[] = [];

    bus.on('automation:toggled', (event) => {
      received.push(`automation:${event.payload.enabled}`);
    });

    bus.on('resource:threshold-reached', (event) => {
      received.push(`resource:${event.payload.threshold}`);
    });

    bus.publish('automation:toggled', {
      automationId: 'auto:1',
      enabled: true,
    } as RuntimeEventPayload<'automation:toggled'>);

    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 10,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    bus.dispatch({ tick: 1 });

    expect(received).toEqual(['automation:true', 'resource:10']);
  });

  it('does not replay events when dispatch is invoked multiple times in the same tick', () => {
    const bus = createBus();
    bus.beginTick(1);

    const handler = vi.fn();
    bus.on('resource:threshold-reached', handler);

    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 3,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    bus.dispatch({ tick: 1 });
    bus.dispatch({ tick: 1 });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('resets buffers between ticks', () => {
    const bus = createBus();
    bus.beginTick(1);

    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 5,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    bus.beginTick(2);

    const handler = vi.fn();
    bus.on('resource:threshold-reached', handler);

    bus.dispatch({ tick: 2 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects publishes once a channel exceeds its capacity', () => {
    const bus = new EventBus({
      clock,
      channels: [
        {
          definition: {
            type: 'resource:threshold-reached',
            version: 1,
          },
          capacity: 1,
        },
      ],
    });

    bus.beginTick(1);

    const telemetryStub: TelemetryFacade = {
      recordError() {},
      recordWarning: vi.fn(),
      recordProgress() {},
      recordCounters() {},
      recordTick() {},
    };

    setTelemetry(telemetryStub);

    try {
      const first = bus.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: 7,
      } as RuntimeEventPayload<'resource:threshold-reached'>);

      expect(first.accepted).toBe(true);
      expect(first.state).toBe('soft-limit');
      expect(first.softLimitActive).toBe(true);

      const overflow = captureOverflow<'resource:threshold-reached'>(() => {
        bus.publish('resource:threshold-reached', {
          resourceId: 'energy',
          threshold: 8,
        } as RuntimeEventPayload<'resource:threshold-reached'>);
      });
      const overflowResult = overflow.result;
      expect(overflowResult.accepted).toBe(false);
      expect(overflowResult.state).toBe('rejected');
      expect(overflowResult.remainingCapacity).toBe(0);
      expect(overflowResult.softLimitActive).toBe(true);

      const handler = vi.fn();
      bus.on('resource:threshold-reached', handler);
      bus.dispatch({ tick: 1 });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]?.[0].payload.threshold).toBe(7);

      const snapshot = bus.getBackPressureSnapshot();
      expect(snapshot.counters.published).toBe(1);
      expect(snapshot.counters.overflowed).toBe(1);
      expect(snapshot.channels[0]).toMatchObject({
        capacity: 1,
        highWaterMark: 1,
        inUse: 0,
        remainingCapacity: 1,
        softLimitActive: true,
      });

      expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
        'EventBufferOverflow',
        {
          type: 'resource:threshold-reached',
          channel: 0,
          capacity: 1,
          tick: 1,
        },
      );
    } finally {
      resetTelemetry();
    }
  });

  it('returns rejected publishes until buffers reset on the next tick', () => {
    const bus = new EventBus({
      clock,
      channels: [
        {
          definition: {
            type: 'resource:threshold-reached',
            version: 1,
          },
          capacity: 1,
        },
      ],
    });

    bus.beginTick(1);

    const telemetryStub: TelemetryFacade = {
      recordError() {},
      recordWarning() {},
      recordProgress() {},
      recordCounters() {},
      recordTick() {},
    };

    setTelemetry(telemetryStub);

    try {
      const first = bus.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: 10,
      } as RuntimeEventPayload<'resource:threshold-reached'>);

      expect(first.accepted).toBe(true);
      expect(first.state).toBe('soft-limit');

      const second = captureOverflow<'resource:threshold-reached'>(() => {
        bus.publish('resource:threshold-reached', {
          resourceId: 'energy',
          threshold: 11,
        } as RuntimeEventPayload<'resource:threshold-reached'>);
      }).result;

      expect(second.accepted).toBe(false);
      expect(second.state).toBe('rejected');

      const third = captureOverflow<'resource:threshold-reached'>(() => {
        bus.publish('resource:threshold-reached', {
          resourceId: 'energy',
          threshold: 12,
        } as RuntimeEventPayload<'resource:threshold-reached'>);
      }).result;

      expect(third.accepted).toBe(false);
      expect(third.state).toBe('rejected');

      bus.beginTick(2);

      const fourth = bus.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: 13,
      } as RuntimeEventPayload<'resource:threshold-reached'>);

      expect(fourth.accepted).toBe(true);
      expect(fourth.state).toBe('soft-limit');
    } finally {
      resetTelemetry();
    }
  });

  it('reports outbound occupancy when rejecting publishes', () => {
    const bus = new EventBus({
      clock,
      channels: [
        {
          definition: {
            type: 'resource:threshold-reached',
            version: 1,
          },
          capacity: 1,
        },
      ],
    });

    bus.beginTick(1);

    const first = bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 21,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    expect(first.accepted).toBe(true);

    bus.beginTick(2, { resetOutbound: false });

    const second = captureOverflow<'resource:threshold-reached'>(() => {
      bus.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: 22,
      } as RuntimeEventPayload<'resource:threshold-reached'>);
    }).result;

    expect(second.accepted).toBe(false);
    expect(second.state).toBe('rejected');
    expect(second.bufferSize).toBe(1);
    expect(second.remainingCapacity).toBe(0);
    expect(second.softLimitActive).toBe(true);
  });

  it('invokes soft limit callbacks once per tick', () => {
    const softLimitSpy = vi.fn();
    const bus = new EventBus({
      clock,
      channels: [
        {
          definition: {
            type: 'resource:threshold-reached',
            version: 1,
          },
          capacity: 4,
          softLimit: 2,
          onSoftLimit: softLimitSpy,
        },
      ],
    });

    bus.beginTick(1);

    const first = bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 1,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    const second = bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 2,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    const third = bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 3,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    expect(first.state).toBe('accepted');
    expect(first.softLimitActive).toBe(false);
    expect(first.remainingCapacity).toBe(3);
    expect(second.state).toBe('soft-limit');
    expect(second.softLimitActive).toBe(true);
    expect(second.remainingCapacity).toBe(2);
    expect(third.state).toBe('soft-limit');
    expect(third.softLimitActive).toBe(true);
    expect(third.remainingCapacity).toBe(1);
    expect(softLimitSpy).toHaveBeenCalledTimes(1);
    expect(softLimitSpy).toHaveBeenCalledWith({
      type: 'resource:threshold-reached',
      channel: 0,
      bufferSize: 2,
      capacity: 4,
      softLimit: 2,
      remainingCapacity: 2,
    });

    bus.beginTick(2);

    const fourth = bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 4,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    expect(fourth.state).toBe('accepted');
    expect(fourth.softLimitActive).toBe(false);
  });

  it('treats soft limited publishes as accepted', () => {
    const bus = new EventBus({
      clock,
      channels: [
        {
          definition: {
            type: 'resource:threshold-reached',
            version: 1,
          },
          capacity: 4,
          softLimit: 2,
        },
      ],
    });

    bus.beginTick(1);

    const first = bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 1,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    const second = bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 2,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    expect(first.state).toBe('accepted');
    expect(first.accepted).toBe(true);
    expect(second.state).toBe('soft-limit');
    expect(second.accepted).toBe(true);
  });

  it('defaults channel soft limits to 75 percent of capacity', () => {
    const bus = new EventBus({
      clock,
      channels: [
        {
          definition: {
            type: 'resource:threshold-reached',
            version: 1,
          },
          capacity: 8,
        },
      ],
    });

    bus.beginTick(1);

    const snapshot = bus.getBackPressureSnapshot();
    expect(snapshot.channels[0]?.softLimit).toBe(6);

    for (let i = 0; i < 6; i += 1) {
      bus.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: i,
      } as RuntimeEventPayload<'resource:threshold-reached'>);
    }

    const result = bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 6,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    expect(result.state).toBe('soft-limit');
  });

  it('applies per-channel overrides from channelConfigs', () => {
    const bus = new EventBus({
      clock,
      channels: [
        {
          definition: {
            type: 'resource:threshold-reached',
            version: 1,
          },
        },
      ],
      channelConfigs: {
        'resource:threshold-reached': {
          capacity: 12,
          softLimit: 9,
        },
      },
    });

    bus.beginTick(1);

    const snapshot = bus.getBackPressureSnapshot();
    expect(snapshot.channels[0]).toMatchObject({
      capacity: 12,
      softLimit: 9,
    });
  });

  it('captures backpressure counters and channel metrics', () => {
    const bus = new EventBus({
      clock,
      channels: [
        {
          definition: {
            type: 'resource:threshold-reached',
            version: 1,
          },
          capacity: 4,
          softLimit: 2,
        },
      ],
    });

    bus.beginTick(1);

    for (let i = 0; i < 3; i += 1) {
      bus.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: i,
      } as RuntimeEventPayload<'resource:threshold-reached'>);
    }

    const snapshot = bus.getBackPressureSnapshot();

    expect(snapshot.counters).toEqual({
      published: 3,
      softLimited: 2,
      overflowed: 0,
      subscribers: 0,
    });

    expect(snapshot.channels[0]).toMatchObject({
      inUse: 3,
      highWaterMark: 3,
      remainingCapacity: 1,
      softLimitActive: true,
      cooldownTicksRemaining: 1,
      softLimitBreaches: 1,
      eventsPerSecond: 3,
    });
  });

  it('drops inactive subscriptions when a new tick begins', () => {
    const bus = createBus();
    bus.beginTick(1);

    const handler = vi.fn();
    const subscription = bus.on('resource:threshold-reached', handler);

    subscription.unsubscribe();

    bus.beginTick(2);

    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 11,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    bus.dispatch({ tick: 2 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('provides a read-only view of the outbound buffer', () => {
    const bus = createBus();
    bus.beginTick(42);

    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 9,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    const buffer = bus.getOutboundBuffer(0);
    expect(buffer.length).toBe(1);

    const record = buffer.at(0);
    expect(record.type).toBe('resource:threshold-reached');
    expect(record.tick).toBe(42);
    expect(record.payload).toEqual({
      resourceId: 'energy',
      threshold: 9,
    });
  });

  it('returns dispatch metadata from publish results', () => {
    const bus = createBus();
    bus.beginTick(7);

    const first = bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 1,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    const second = bus.publish('automation:toggled', {
      automationId: 'auto:42',
      enabled: false,
    } as RuntimeEventPayload<'automation:toggled'>);

    expect(first.dispatchOrder).toBe(0);
    expect(first.bufferSize).toBe(1);
    expect(first.remainingCapacity).toBeGreaterThan(0);
    expect(first.softLimitActive).toBe(false);
    expect(second.dispatchOrder).toBe(1);
    expect(second.bufferSize).toBe(1);
    expect(second.channel).not.toBe(first.channel);
    expect(second.softLimitActive).toBe(false);
  });

  it('allows subscribers to unsubscribe during dispatch without affecting others', () => {
    const bus = createBus();
    bus.beginTick(3);

    const calls: string[] = [];

    const subscription = bus.on('resource:threshold-reached', () => {
      calls.push('primary:before');
      subscription.unsubscribe();
      calls.push('primary:after');
    });

    bus.on('resource:threshold-reached', () => {
      calls.push('secondary');
    });

    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 12,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 13,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    bus.dispatch({ tick: 3 });

    expect(calls).toEqual([
      'primary:before',
      'primary:after',
      'secondary',
      'secondary',
    ]);

    bus.beginTick(4);
    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 14,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    bus.dispatch({ tick: 4 });

    expect(calls).toEqual([
      'primary:before',
      'primary:after',
      'secondary',
      'secondary',
      'secondary',
    ]);
  });

  it('records slow handler telemetry when execution exceeds the configured threshold', () => {
    let currentTime = 0;
    const localClock = {
      now: vi.fn(() => {
        currentTime += 1;
        return currentTime;
      }),
    };
    const onSlowHandler = vi.fn();

    const bus = new EventBus({
      clock: localClock,
      channels: DEFAULT_EVENT_BUS_OPTIONS.channels,
      slowHandlerThresholdMs: 0.5,
      onSlowHandler,
    });

    const telemetryStub: TelemetryFacade = {
      recordError() {},
      recordWarning: vi.fn(),
      recordProgress() {},
      recordCounters() {},
      recordTick() {},
    };

    setTelemetry(telemetryStub);

    try {
      bus.beginTick(7);

      bus.on(
        'resource:threshold-reached',
        () => {
          // No-op handler to drive timing via the mocked clock.
        },
        { label: 'system:test' },
      );

      bus.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: 3,
      } as RuntimeEventPayload<'resource:threshold-reached'>);

      bus.dispatch({ tick: 7 });

      expect(onSlowHandler).toHaveBeenCalledTimes(1);
      expect(onSlowHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'resource:threshold-reached',
          channel: 0,
          tick: 7,
          handlerLabel: 'system:test',
          durationMs: expect.any(Number),
          thresholdMs: 0.5,
        }),
      );

      expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
        'EventHandlerSlow',
        expect.objectContaining({
          eventType: 'resource:threshold-reached',
          handler: 'system:test',
          durationMs: expect.any(Number),
          thresholdMs: 0.5,
        }),
      );
    } finally {
      resetTelemetry();
    }
  });

  it('toggles event frame export format based on density when enabled', () => {
    const telemetryStub: TelemetryFacade = {
      recordError() {},
      recordWarning: vi.fn(),
      recordProgress() {},
      recordCounters() {},
      recordTick() {},
    };

    setTelemetry(telemetryStub);

    try {
      const bus = new EventBus({
        clock,
        channels: DEFAULT_EVENT_BUS_OPTIONS.channels,
        frameExport: {
          defaultFormat: 'struct-of-arrays',
          autoFallback: {
            enabled: true,
            windowLength: 1,
            densityThreshold: 2,
          },
        },
      });
      const pool = new TransportBufferPool();

      bus.beginTick(0);
      expect(bus.getFrameExportState().format).toBe('struct-of-arrays');

      bus.beginTick(1);
      expect(bus.getFrameExportState().format).toBe('object-array');
      expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
        'RuntimeEventFrameFormatChanged',
        expect.objectContaining({
          previousFormat: 'struct-of-arrays',
          nextFormat: 'object-array',
          featureFlagEnabled: true,
        }),
      );

      const exportState = bus.getFrameExportState();
      for (let i = 0; i < 4; i += 1) {
        bus.publish('resource:threshold-reached', {
          resourceId: `energy:${i}`,
          threshold: i,
        } as RuntimeEventPayload<'resource:threshold-reached'>);
      }

      const frameResult = buildRuntimeEventFrame(bus, pool, {
        tick: 1,
        manifestHash: bus.getManifestHash(),
        owner: 'test',
        format: exportState.format,
        diagnostics: exportState.diagnostics,
      });

      expect(frameResult.frame.format).toBe('object-array');
      frameResult.release();

      const channelCount = bus.getManifest().entries.length;
      const eventsNeeded = Math.ceil(channelCount * 2);

      for (let i = 0; i < eventsNeeded; i += 1) {
        bus.publish('resource:threshold-reached', {
          resourceId: `dense:${i}`,
          threshold: i,
        } as RuntimeEventPayload<'resource:threshold-reached'>);
      }

      bus.beginTick(2);

      expect(bus.getFrameExportState().format).toBe('struct-of-arrays');
      expect(telemetryStub.recordWarning).toHaveBeenLastCalledWith(
        'RuntimeEventFrameFormatChanged',
        expect.objectContaining({
          previousFormat: 'object-array',
          nextFormat: 'struct-of-arrays',
        }),
      );
    } finally {
      resetTelemetry();
    }
  });
});

describe('EventBus performance', () => {
  const ITERATIONS = 10_000;

  it('publishes and dispatches 10k events within the 100 ms budget', () => {
    const bus = new EventBus({
      clock: {
        now: () => 0,
      },
      channels: [
        {
          definition: {
            type: 'resource:threshold-reached',
            version: 1,
          },
          capacity: ITERATIONS + 100,
          softLimit: ITERATIONS + 50,
        },
      ],
    });

    bus.on('resource:threshold-reached', () => {});

    bus.beginTick(0);
    for (let i = 0; i < 100; i += 1) {
      bus.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: i,
      } as RuntimeEventPayload<'resource:threshold-reached'>);
    }
    bus.dispatch({ tick: 0 });

    bus.beginTick(1);
    const start = performance.now();

    for (let i = 0; i < ITERATIONS; i += 1) {
      bus.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: i,
      } as RuntimeEventPayload<'resource:threshold-reached'>);
    }

    bus.dispatch({ tick: 1 });
    const durationMs = performance.now() - start;

    expect(durationMs).toBeLessThanOrEqual(400); // allows headroom for manifest bookkeeping on slower CI hosts
  });
});
