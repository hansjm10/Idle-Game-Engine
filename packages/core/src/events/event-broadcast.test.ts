import { describe, expect, it, vi } from 'vitest';

import { EventBus } from './event-bus.js';
import {
  EventBroadcastBatcher,
  EventBroadcastDeduper,
  applyEventBroadcastFrame,
  createEventBroadcastFrame,
  createEventTypeFilter,
  type EventBroadcastFrame,
  type SerializedRuntimeEvent,
} from './event-broadcast.js';
import { DEFAULT_EVENT_BUS_OPTIONS } from './runtime-event-catalog.js';
import { buildRuntimeEventFrame } from './runtime-event-frame.js';
import type { RuntimeEventPayload } from './runtime-event.js';
import { TransportBufferPool } from '../transport-buffer-pool.js';

describe('event broadcast', () => {
  const createBus = () => new EventBus(DEFAULT_EVENT_BUS_OPTIONS);

  const createEvent = (
    type: SerializedRuntimeEvent['type'],
    dispatchOrder: number,
    payload: SerializedRuntimeEvent['payload'],
  ): SerializedRuntimeEvent => ({
    type,
    channel: 0,
    issuedAt: 0,
    dispatchOrder,
    payload,
  });

  const createFrame = (
    serverStep: number,
    events: readonly SerializedRuntimeEvent[],
  ): EventBroadcastFrame => ({
    serverStep,
    events,
  });

  it('serializes runtime event frames with type filtering', () => {
    const bus = createBus();
    const pool = new TransportBufferPool();

    bus.beginTick(1);
    bus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 10,
    } as RuntimeEventPayload<'resource:threshold-reached'>);
    bus.publish('automation:toggled', {
      automationId: 'auto:1',
      enabled: true,
    } as RuntimeEventPayload<'automation:toggled'>);

    const frameResult = buildRuntimeEventFrame(bus, pool, {
      tick: 1,
      manifestHash: bus.getManifestHash(),
      format: 'object-array',
    });

    const filter = createEventTypeFilter(['automation:toggled']);
    const broadcast = createEventBroadcastFrame(frameResult.frame, { filter });

    expect(broadcast.serverStep).toBe(1);
    expect(broadcast.events).toHaveLength(1);
    expect(broadcast.events[0].type).toBe('automation:toggled');
    expect(broadcast.manifestHash).toBe(bus.getManifestHash());

    frameResult.release();
  });

  it('hydrates broadcast frames in dispatch order', () => {
    const serverBus = createBus();
    const pool = new TransportBufferPool();

    serverBus.beginTick(4);
    serverBus.publish('automation:toggled', {
      automationId: 'auto:1',
      enabled: true,
    } as RuntimeEventPayload<'automation:toggled'>);
    serverBus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 5,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    const frameResult = buildRuntimeEventFrame(serverBus, pool, {
      tick: 4,
      manifestHash: serverBus.getManifestHash(),
    });

    const broadcast = createEventBroadcastFrame(frameResult.frame, {
      sortByDispatchOrder: false,
    });
    frameResult.release();

    const clientBus = createBus();
    const received: string[] = [];

    clientBus.on('automation:toggled', (event) => {
      received.push(`automation:${event.payload.enabled}`);
    });
    clientBus.on('resource:threshold-reached', (event) => {
      received.push(`resource:${event.payload.threshold}`);
    });

    applyEventBroadcastFrame(clientBus, broadcast);

    expect(received).toEqual(['automation:true', 'resource:5']);
  });

  it('deduplicates replayed frames when a deduper is provided', () => {
    const bus = createBus();
    const handler = vi.fn();

    bus.on('resource:threshold-reached', handler);

    const frame = createFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 3,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ]);

    const deduper = new EventBroadcastDeduper({ capacity: 4 });

    applyEventBroadcastFrame(bus, frame, { deduper });
    applyEventBroadcastFrame(bus, frame, { deduper });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('batches frames and flushes when priority events arrive', () => {
    const batcher = new EventBroadcastBatcher({
      maxSteps: 5,
      priorityEventTypes: ['automation:toggled'],
    });

    const batches1 = batcher.ingestFrame(
      createFrame(1, [
        createEvent('resource:threshold-reached', 0, {
          resourceId: 'energy',
          threshold: 1,
        } as RuntimeEventPayload<'resource:threshold-reached'>),
      ]),
    );
    expect(batches1).toHaveLength(0);

    const batches2 = batcher.ingestFrame(
      createFrame(2, [
        createEvent('resource:threshold-reached', 0, {
          resourceId: 'energy',
          threshold: 2,
        } as RuntimeEventPayload<'resource:threshold-reached'>),
      ]),
    );
    expect(batches2).toHaveLength(0);

    const batches3 = batcher.ingestFrame(
      createFrame(3, [
        createEvent('automation:toggled', 0, {
          automationId: 'auto:1',
          enabled: true,
        } as RuntimeEventPayload<'automation:toggled'>),
      ]),
    );

    expect(batches3).toHaveLength(2);
    expect(batches3[0].frames).toHaveLength(2);
    expect(batches3[1].frames).toHaveLength(1);
    expect(batches3[1].frames[0].events[0].type).toBe('automation:toggled');
  });
});
