import { describe, expect, it, vi } from 'vitest';

import { EventBus } from './event-bus.js';
import {
  EventBroadcastBatcher,
  EventBroadcastDeduper,
  applyEventBroadcastBatch,
  applyEventBroadcastFrame,
  computeEventBroadcastChecksum,
  createEventBroadcastFrame,
  createEventTypeFilter,
  type EventBroadcastBatch,
  type EventBroadcastFrame,
  type SerializedRuntimeEvent,
} from './event-broadcast.js';
import { DEFAULT_EVENT_BUS_OPTIONS } from './runtime-event-catalog.js';
import { buildRuntimeEventFrame } from './runtime-event-frame.js';
import type { RuntimeEventManifestHash, RuntimeEventPayload } from './runtime-event.js';
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

  const createChecksummedFrame = (
    serverStep: number,
    events: readonly SerializedRuntimeEvent[],
  ): EventBroadcastFrame => {
    const frame = createFrame(serverStep, events);
    return {
      ...frame,
      checksum: computeEventBroadcastChecksum(frame),
    };
  };

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

  it('filters events when hydrating broadcast frames', () => {
    const bus = createBus();
    const received: string[] = [];

    bus.on('resource:threshold-reached', (event) => {
      received.push(`resource:${event.payload.threshold}`);
    });
    bus.on('automation:toggled', (event) => {
      received.push(`automation:${event.payload.enabled}`);
    });

    const frame = createFrame(1, [
      createEvent('resource:threshold-reached', 1, {
        resourceId: 'energy',
        threshold: 10,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
      createEvent('automation:toggled', 0, {
        automationId: 'auto:1',
        enabled: true,
      } as RuntimeEventPayload<'automation:toggled'>),
    ]);

    const filter = createEventTypeFilter(['resource:threshold-reached']);

    applyEventBroadcastFrame(bus, frame, { filter });

    expect(received).toEqual(['resource:10']);
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

  it('replays after a deduper reset', () => {
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
    deduper.reset();
    applyEventBroadcastFrame(bus, frame, { deduper });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('applies batches with filters and dedupers', () => {
    const bus = createBus();
    const received: string[] = [];

    bus.on('resource:threshold-reached', (event) => {
      received.push(`resource:${event.payload.threshold}`);
    });
    bus.on('automation:toggled', (event) => {
      received.push(`automation:${event.payload.enabled}`);
    });

    const frame = createFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 1,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
      createEvent('automation:toggled', 1, {
        automationId: 'auto:1',
        enabled: true,
      } as RuntimeEventPayload<'automation:toggled'>),
    ]);

    const batch: EventBroadcastBatch = {
      frames: [frame, frame],
      fromStep: 1,
      toStep: 1,
      eventCount: 4,
    };

    const filter = createEventTypeFilter(['automation:toggled']);
    const deduper = new EventBroadcastDeduper();

    applyEventBroadcastBatch(bus, batch, { filter, deduper });

    expect(received).toEqual(['automation:true']);
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

  it('flushes when maxEvents is reached', () => {
    const batcher = new EventBroadcastBatcher({
      maxEvents: 2,
    });

    const first = createFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 1,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ]);
    const second = createFrame(2, [
      createEvent('automation:toggled', 1, {
        automationId: 'auto:1',
        enabled: true,
      } as RuntimeEventPayload<'automation:toggled'>),
    ]);

    expect(batcher.ingestFrame(first)).toHaveLength(0);
    const batches = batcher.ingestFrame(second);

    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch.eventCount).toBe(2);
    expect(batch.fromStep).toBe(1);
    expect(batch.toStep).toBe(2);
    expect(batch.frames).toHaveLength(2);
  });

  it('recomputes checksum when batcher filters events', () => {
    const frame = createChecksummedFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 7,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
      createEvent('automation:toggled', 1, {
        automationId: 'auto:1',
        enabled: true,
      } as RuntimeEventPayload<'automation:toggled'>),
    ]);

    const batcher = new EventBroadcastBatcher({
      filter: createEventTypeFilter(['automation:toggled']),
    });

    const batches = batcher.ingestFrame(frame);
    expect(batches).toHaveLength(1);
    const batchedFrame = batches[0].frames[0];

    expect(batchedFrame.events).toHaveLength(1);
    expect(batchedFrame.checksum).toBe(
      computeEventBroadcastChecksum(batchedFrame),
    );
  });

  it('recomputes checksum when batcher coalesces events', () => {
    const frame1 = createChecksummedFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 3,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
      createEvent('automation:toggled', 1, {
        automationId: 'auto:1',
        enabled: false,
      } as RuntimeEventPayload<'automation:toggled'>),
    ]);
    const frame2 = createChecksummedFrame(2, [
      createEvent('resource:threshold-reached', 2, {
        resourceId: 'energy',
        threshold: 4,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ]);

    const batcher = new EventBroadcastBatcher({
      maxSteps: 2,
      coalesce: { key: (event) => event.type },
    });

    expect(batcher.ingestFrame(frame1)).toHaveLength(0);
    const batches = batcher.ingestFrame(frame2);
    expect(batches).toHaveLength(1);
    const [batch] = batches;

    const coalescedFrame = batch.frames.find(
      (entry) => entry.serverStep === 1,
    );
    if (!coalescedFrame) {
      throw new Error('Expected coalesced frame for step 1.');
    }

    expect(coalescedFrame.events).toHaveLength(1);
    expect(coalescedFrame.events[0].type).toBe('automation:toggled');
    expect(coalescedFrame.checksum).toBe(
      computeEventBroadcastChecksum(coalescedFrame),
    );
  });

  it('coalesces with mode "first"', () => {
    const frame1 = createChecksummedFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 3,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ]);
    const frame2 = createChecksummedFrame(2, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 4,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
      createEvent('automation:toggled', 1, {
        automationId: 'auto:1',
        enabled: true,
      } as RuntimeEventPayload<'automation:toggled'>),
    ]);

    const batcher = new EventBroadcastBatcher({
      maxSteps: 2,
      coalesce: { key: (event) => event.type, mode: 'first' },
    });

    expect(batcher.ingestFrame(frame1)).toHaveLength(0);
    const batches = batcher.ingestFrame(frame2);
    expect(batches).toHaveLength(1);
    const [batch] = batches;

    const firstFrame = batch.frames.find((entry) => entry.serverStep === 1);
    if (!firstFrame) {
      throw new Error('Expected frame for step 1.');
    }
    const secondFrame = batch.frames.find((entry) => entry.serverStep === 2);
    if (!secondFrame) {
      throw new Error('Expected frame for step 2.');
    }

    expect(firstFrame.events).toHaveLength(1);
    expect(firstFrame.events[0].type).toBe('resource:threshold-reached');
    expect(firstFrame.events[0].payload).toMatchObject({ threshold: 3 });

    expect(secondFrame.events).toHaveLength(1);
    expect(secondFrame.events[0].type).toBe('automation:toggled');
    expect(secondFrame.checksum).toBe(
      computeEventBroadcastChecksum(secondFrame),
    );
  });

  it('throws when manifest hash mismatches', () => {
    const bus = createBus();

    const frame = createFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 3,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ]);

    const badFrame: EventBroadcastFrame = {
      ...frame,
      manifestHash: `${bus.getManifestHash()}-mismatch` as RuntimeEventManifestHash,
    };

    expect(() => applyEventBroadcastFrame(bus, badFrame)).toThrow(
      'Runtime event manifest hash mismatch while applying broadcast frame.',
    );
  });

  it('skips manifest validation when validateManifest is false', () => {
    const bus = createBus();

    const frame = createFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 3,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ]);

    const badFrame: EventBroadcastFrame = {
      ...frame,
      manifestHash: `${bus.getManifestHash()}-mismatch` as RuntimeEventManifestHash,
    };

    expect(() =>
      applyEventBroadcastFrame(bus, badFrame, { validateManifest: false }),
    ).not.toThrow();
  });

  it('throws when checksum mismatches', () => {
    const bus = createBus();
    const frame = createChecksummedFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 3,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ]);

    const badFrame: EventBroadcastFrame = {
      ...frame,
      checksum: 'bad-checksum',
    };

    expect(() => applyEventBroadcastFrame(bus, badFrame)).toThrow(
      'Event broadcast checksum mismatch.',
    );
  });

  it('skips checksum validation when validateChecksum is false', () => {
    const bus = createBus();
    const frame = createChecksummedFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 3,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ]);

    const badFrame: EventBroadcastFrame = {
      ...frame,
      checksum: 'bad-checksum',
    };

    expect(() =>
      applyEventBroadcastFrame(bus, badFrame, { validateChecksum: false }),
    ).not.toThrow();
  });

  it('flushes when maxDelayMs elapses', () => {
    const batcher = new EventBroadcastBatcher({
      maxSteps: 5,
      maxDelayMs: 10,
    });

    const first = createFrame(1, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 1,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ]);
    const second = createFrame(2, [
      createEvent('resource:threshold-reached', 0, {
        resourceId: 'energy',
        threshold: 2,
      } as RuntimeEventPayload<'resource:threshold-reached'>),
    ]);

    expect(batcher.ingestFrame(first, 0)).toHaveLength(0);
    const batches = batcher.ingestFrame(second, 10);

    expect(batches).toHaveLength(1);
    expect(batches[0].fromStep).toBe(1);
    expect(batches[0].toStep).toBe(1);
    expect(batches[0].frames).toHaveLength(1);
    expect(batches[0].frames[0].serverStep).toBe(1);
  });

  it('hydrates frames after JSON round-trip with checksum', () => {
    const serverBus = createBus();
    const pool = new TransportBufferPool();

    serverBus.beginTick(1);
    serverBus.publish('resource:threshold-reached', {
      resourceId: 'energy',
      threshold: 10,
    } as RuntimeEventPayload<'resource:threshold-reached'>);

    const frameResult = buildRuntimeEventFrame(serverBus, pool, {
      tick: 1,
      manifestHash: serverBus.getManifestHash(),
      format: 'object-array',
    });

    const broadcast = createEventBroadcastFrame(frameResult.frame, {
      includeChecksum: true,
    });
    frameResult.release();

    const roundTrip = JSON.parse(
      JSON.stringify(broadcast),
    ) as EventBroadcastFrame;

    const clientBus = createBus();
    const received: string[] = [];

    clientBus.on('resource:threshold-reached', (event) => {
      received.push(`resource:${event.payload.threshold}`);
    });

    applyEventBroadcastFrame(clientBus, roundTrip);

    expect(received).toEqual(['resource:10']);
  });
});
