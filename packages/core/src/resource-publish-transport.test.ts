import { afterEach, describe, expect, it } from 'vitest';

import {
  buildResourcePublishTransport,
  createResourcePublishTransport,
  type ResourcePublishTransport,
  type TransportComponent,
  type TransportBufferDescriptor,
} from './resource-publish-transport.js';
import { createResourceState } from './resource-state.js';
import { TransportBufferPool } from './transport-buffer-pool.js';
import { resetTelemetry } from './telemetry.js';
import { EventBus } from './events/event-bus.js';
import { DEFAULT_EVENT_BUS_OPTIONS } from './events/runtime-event-catalog.js';

describe('resource publish transport', () => {
  afterEach(() => {
    resetTelemetry();
  });

  it('materialises transport payloads with dirty-only data', () => {
    const state = createResourceState([
      { id: 'energy', startAmount: 10, capacity: 20 },
      { id: 'science', startAmount: 5, capacity: 15 },
      { id: 'gold', startAmount: 8, capacity: 25 },
    ]);

    const energy = state.requireIndex('energy');
    const gold = state.requireIndex('gold');

    state.addAmount(energy, 3);
    state.setCapacity(gold, 30);

    const snapshot = state.snapshot({ mode: 'publish' });
    expect(snapshot.dirtyCount).toBe(2);

    const pool = new TransportBufferPool();
    const result = buildResourcePublishTransport(snapshot, pool, {
      owner: 'test-suite',
    });

    const { transport } = result;
    expect(transport.version).toBe(2);
    expect(transport.events).toBeUndefined();
    expect(transport.diagnostics).toBeUndefined();
    expect(Array.from(transport.dirtyIndices)).toEqual([
      snapshot.dirtyIndices[0],
      snapshot.dirtyIndices[1],
    ]);

    const descriptors = indexDescriptors(transport);
    expect(descriptors.size).toBe(8);
    for (const descriptor of descriptors.values()) {
      expect(descriptor.length).toBe(snapshot.dirtyCount);
    }

    expect(readFloat(descriptors.get('amounts')!)).toEqual([
      snapshot.amounts[snapshot.dirtyIndices[0]],
      snapshot.amounts[snapshot.dirtyIndices[1]],
    ]);
    expect(readFloat(descriptors.get('capacities')!)).toEqual([
      snapshot.capacities[snapshot.dirtyIndices[0]],
      snapshot.capacities[snapshot.dirtyIndices[1]],
    ]);
    expect(readFloat(descriptors.get('tickDelta')!)).toEqual([
      snapshot.tickDelta[snapshot.dirtyIndices[0]],
      snapshot.tickDelta[snapshot.dirtyIndices[1]],
    ]);

    const flags = readUint8(descriptors.get('flags')!);
    for (const value of flags) {
      expect(value & (1 << 2)).toBe(0);
    }

    result.release();
  });

  it('includes runtime event frames when an event bus is provided', () => {
    const state = createResourceState([{ id: 'energy', startAmount: 2, capacity: 5 }]);
    const pool = new TransportBufferPool();
    const bus = new EventBus(DEFAULT_EVENT_BUS_OPTIONS);

    bus.beginTick(4);
    bus.publish('automation:toggled', {
      automationId: 'auto:1',
      enabled: false,
    });
    bus.dispatch({ tick: 4 });

    const snapshot = state.snapshot({ mode: 'publish' });
    const result = buildResourcePublishTransport(snapshot, pool, {
      owner: 'test-suite',
      tick: 4,
      eventBus: bus,
    });

    const frame = result.transport.events;
    expect(frame).toBeDefined();
    if (!frame || frame.format !== 'struct-of-arrays') {
      throw new Error('Expected struct-of-arrays frame when fallback is disabled.');
    }

    expect(frame.count).toBe(1);
    expect(frame.tick).toBe(4);
    expect(frame.manifestHash).toBe(bus.getManifestHash());
    expect(Array.from(frame.channelIndices)).toEqual([1]);

    const typeIndex = frame.typeIndices[0];
    expect(frame.stringTable[typeIndex]).toBe('automation:toggled');
    expect(frame.payloads[0]).toEqual({
      automationId: 'auto:1',
      enabled: false,
    });

    expect(result.transport.diagnostics).toBeUndefined();
    result.release();
  });

  it('produces transferables for worker pathways and accepts returned buffers', () => {
    const state = createResourceState([{ id: 'energy', startAmount: 1, capacity: 5 }]);
    const energy = state.requireIndex('energy');
    state.addAmount(energy, 1);
    const snapshot = state.snapshot({ mode: 'publish' });

    const pool = new TransportBufferPool();
    const result = buildResourcePublishTransport(snapshot, pool, {
      mode: 'transfer',
      owner: 'test-suite',
    });

    const { transport, transferables } = result;
    expect(transferables).toContain(transport.dirtyIndices.buffer);
    expect(transport.events).toBeUndefined();
    expect(transport.diagnostics).toBeUndefined();
    const descriptors = indexDescriptors(transport);
    for (const descriptor of descriptors.values()) {
      expect(transferables).toContain(descriptor.buffer);
    }

    const replacementBuffers = new Map<TransportComponent, ArrayBuffer>();
    for (const [component, descriptor] of descriptors) {
      replacementBuffers.set(
        component,
        descriptor.buffer.slice(0),
      );
    }
    const dirtyIndicesReplacement = transport.dirtyIndices.buffer.slice(
      0,
    ) as ArrayBuffer;

    result.release({
      buffers: Object.fromEntries(replacementBuffers),
      dirtyIndicesBuffer: dirtyIndicesReplacement,
    });
  });

  it('returns empty transport when no resources are dirty', () => {
    const state = createResourceState([{ id: 'energy', startAmount: 5, capacity: 10 }]);
    const pool = new TransportBufferPool();

    const snapshot = state.snapshot({ mode: 'publish' });
    expect(snapshot.dirtyCount).toBe(0);

    const result = createResourcePublishTransport(state, pool);
    expect(result.transport.dirtyIndices.length).toBe(0);
    expect(result.transferables).toHaveLength(0);
    expect(result.transport.events).toBeUndefined();
    expect(result.transport.diagnostics).toBeUndefined();
    for (const descriptor of result.transport.buffers) {
      expect(descriptor.length).toBe(0);
    }
    result.release();
  });

  it('attaches diagnostics payloads when provided', () => {
    const state = createResourceState([{ id: 'energy', startAmount: 5, capacity: 10 }]);
    const pool = new TransportBufferPool();
    const diagnosticsPayload = Object.freeze({
      entries: Object.freeze([]),
      head: 4,
      dropped: 0,
      configuration: Object.freeze({
        capacity: 120,
        slowTickBudgetMs: 50,
        enabled: true,
        slowSystemBudgetMs: 16,
        systemHistorySize: 60,
        tickBudgetMs: 100,
      }),
    });

    const snapshot = state.snapshot({ mode: 'publish' });
    const result = buildResourcePublishTransport(snapshot, pool, {
      diagnosticsPayload,
    });

    expect(result.transport.diagnostics).toBe(diagnosticsPayload);
    result.release();
  });
});

function indexDescriptors(
  transport: ResourcePublishTransport,
): Map<TransportComponent, TransportBufferDescriptor> {
  return new Map(
    transport.buffers.map((descriptor) => [descriptor.component, descriptor]),
  );
}

function readFloat(descriptor: TransportBufferDescriptor): number[] {
  const view = new Float64Array(
    descriptor.buffer,
    descriptor.byteOffset,
    descriptor.length,
  );
  return Array.from(view);
}

function readUint8(descriptor: TransportBufferDescriptor): Uint8Array {
  return new Uint8Array(
    descriptor.buffer,
    descriptor.byteOffset,
    descriptor.length,
  );
}
