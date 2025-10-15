import { describe, expect, it, vi } from 'vitest';

import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from '../telemetry.js';
import {
  EventBufferOverflowError,
  EventBus,
  type EventDispatchContext,
  type EventSoftLimitInfo,
} from './event-bus.js';
import type { RuntimeEvent } from './runtime-event.js';

declare module './runtime-event.js' {
  interface RuntimeEventPayloadMap {
    readonly 'resource.threshold': {
      readonly resourceId: string;
      readonly threshold: number;
    };
    readonly 'automation.toggle': {
      readonly automationId: string;
      readonly enabled: boolean;
    };
  }
}

const noopContext: EventDispatchContext = { tick: 0 };

describe('EventBus', () => {
  it('publishes events to registered subscribers in FIFO order', () => {
    let now = 0;
    const bus = new EventBus({
      now: () => {
        now += 1;
        return now;
      },
    });
    bus.registerEventType('resource.threshold');
    bus.registerEventType('automation.toggle');

    bus.startTick(5);

    const received: RuntimeEvent[] = [];
    bus.on('resource.threshold', (event) => {
      received.push(event);
    });

    const publishResult = bus.publish('resource.threshold', {
      resourceId: 'gold',
      threshold: 12,
    });

    expect(publishResult.dispatchOrder).toBe(0);
    expect(publishResult.remainingCapacity).toBe(255);
    expect(publishResult.softLimitTriggered).toBe(false);

    const publishResultTwo = bus.publish('resource.threshold', {
      resourceId: 'iron',
      threshold: 4,
    });
    expect(publishResultTwo.dispatchOrder).toBe(1);

    bus.dispatch({ tick: 5 });

    expect(received).toHaveLength(2);
    expect(received[0].payload.resourceId).toBe('gold');
    expect(received[0].tick).toBe(5);
    expect(received[0].dispatchOrder).toBe(0);
    expect(received[1].dispatchOrder).toBe(1);
    expect(received[1].issuedAt).toBeGreaterThan(received[0].issuedAt);
  });

  it('supports nested publishes and preserves deterministic ordering', () => {
    const bus = new EventBus({ now: () => 100 });
    bus.registerEventType('resource.threshold');
    bus.registerEventType('automation.toggle');

    const publisher = bus.getPublisher();
    const order: Array<{ type: string; dispatchOrder: number }> = [];

    bus.on('resource.threshold', (event) => {
      order.push({ type: event.type, dispatchOrder: event.dispatchOrder });
      publisher.publish('automation.toggle', {
        automationId: 'auto-1',
        enabled: true,
      });
    });

    const toggleHandler = vi.fn((event: RuntimeEvent) => {
      order.push({ type: event.type, dispatchOrder: event.dispatchOrder });
    });
    bus.on('automation.toggle', toggleHandler);

    bus.startTick(12);
    bus.publish('resource.threshold', {
      resourceId: 'wood',
      threshold: 99,
    });

    bus.dispatch({ tick: 12 });

    expect(order.map((entry) => entry.type)).toEqual([
      'resource.threshold',
      'automation.toggle',
    ]);
    expect(order.map((entry) => entry.dispatchOrder)).toEqual([0, 1]);
  });

  it('raises soft-limit callbacks exactly once per tick', () => {
    const softLimitSpy = vi.fn();
    const bus = new EventBus({
      now: () => 0,
      defaultChannelCapacity: 4,
      onSoftLimitThreshold: softLimitSpy,
    });
    bus.registerEventType('resource.threshold', {
      softLimit: 2,
    });

    bus.startTick(1);
    const first = bus.publish('resource.threshold', {
      resourceId: 'stone',
      threshold: 2,
    });
    expect(first.softLimitTriggered).toBe(false);

    const second = bus.publish('resource.threshold', {
      resourceId: 'stone',
      threshold: 3,
    });
    expect(second.softLimitTriggered).toBe(true);

    const third = bus.publish('resource.threshold', {
      resourceId: 'stone',
      threshold: 4,
    });
    expect(third.softLimitTriggered).toBe(false);

    expect(softLimitSpy).toHaveBeenCalledTimes(1);
    const info = softLimitSpy.mock.calls[0][0] as EventSoftLimitInfo;
    expect(info.softLimit).toBe(2);
    expect(info.size).toBe(2);
    expect(info.tick).toBe(1);
  });

  it('throws EventBufferOverflowError and records telemetry warnings on overflow', () => {
    const warningSpy = vi.fn();
    const telemetryStub: TelemetryFacade = {
      recordError: vi.fn(),
      recordWarning: warningSpy,
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };

    setTelemetry(telemetryStub);
    const bus = new EventBus({
      now: () => 0,
      defaultChannelCapacity: 2,
    });
    bus.registerEventType('resource.threshold');

    bus.startTick(2);
    bus.publish('resource.threshold', {
      resourceId: 'coal',
      threshold: 1,
    });
    bus.publish('resource.threshold', {
      resourceId: 'coal',
      threshold: 2,
    });

    expect(() =>
      bus.publish('resource.threshold', {
        resourceId: 'coal',
        threshold: 3,
      }),
    ).toThrow(EventBufferOverflowError);

    expect(warningSpy).toHaveBeenCalledWith('event-buffer-overflow', {
      eventType: 'resource.threshold',
      capacity: 2,
      tick: 2,
    });
    expect(bus.getChannelSize('resource.threshold')).toBe(2);

    resetTelemetry();
  });

  it('cleans up inactive subscriptions at the next tick boundary', () => {
    const bus = new EventBus({ now: () => 0 });
    bus.registerEventType('resource.threshold');

    bus.startTick(0);
    const subscription = bus.on('resource.threshold', () => {});
    subscription.unsubscribe();

    // Should not dispatch anything this tick
    bus.publish('resource.threshold', {
      resourceId: 'aluminum',
      threshold: 1,
    });
    const dispatchSpy = vi.fn();
    bus.on('resource.threshold', dispatchSpy);
    bus.dispatch(noopContext);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    bus.endTick();
    bus.startTick(1);
    bus.publish('resource.threshold', {
      resourceId: 'aluminum',
      threshold: 2,
    });
    bus.dispatch(noopContext);
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
  });

  it('exposes manifest metadata for registered event types', () => {
    const bus = new EventBus({ now: () => 0 });
    bus.registerEventType('automation.toggle');
    bus.registerEventType('resource.threshold');

    const manifest = bus.getManifest();
    expect(manifest.types).toEqual([
      'automation.toggle',
      'resource.threshold',
    ]);
    expect(manifest.version).toBe(2);
    expect(manifest.hash).toBe('fnv1a-ad5208d1');
  });
});
