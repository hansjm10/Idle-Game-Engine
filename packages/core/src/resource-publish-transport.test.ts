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
    const dirtyIndicesReplacement = transport.dirtyIndices.buffer.slice(0);

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
    for (const descriptor of result.transport.buffers) {
      expect(descriptor.length).toBe(0);
    }
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
