import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventBus, EventBufferOverflowError } from './event-bus.js';
import { type RuntimeEventPayload } from './runtime-event.js';

declare module './runtime-event.js' {
  interface RuntimeEventPayloadMap {
    'resource:threshold-reached': {
      resourceId: string;
      threshold: number;
    };
    'automation:toggled': {
      automationId: string;
      enabled: boolean;
    };
  }
}

describe('EventBus', () => {
  const clock = {
    now: vi.fn<[], number>(),
  };

  beforeEach(() => {
    clock.now.mockReset();
    clock.now.mockReturnValue(100);
  });

  function createBus(): EventBus {
    return new EventBus({
      clock,
      channels: [
        {
          definition: {
            type: 'resource:threshold-reached',
            version: 1,
          },
        },
        {
          definition: {
            type: 'automation:toggled',
            version: 1,
          },
        },
      ],
    });
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

  it('throws before mutating state when a channel exceeds its capacity', () => {
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

    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 7,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    expect(() =>
      bus.publish('resource:threshold-reached', {
        resourceId: 'energy',
        threshold: 8,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ).toThrow(EventBufferOverflowError);

    const handler = vi.fn();
    bus.on('resource:threshold-reached', handler);
    bus.dispatch({ tick: 1 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0].payload.threshold).toBe(7);
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

    expect(first.softLimitTriggered).toBe(false);
    expect(second.softLimitTriggered).toBe(true);
    expect(third.softLimitTriggered).toBe(true);
    expect(softLimitSpy).toHaveBeenCalledTimes(1);

    bus.beginTick(2);

    const fourth = bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 4,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    expect(fourth.softLimitTriggered).toBe(false);
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
});
