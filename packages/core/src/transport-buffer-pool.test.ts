import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TelemetryFacade } from './telemetry.js';
import { resetTelemetry, setTelemetry } from './telemetry.js';
import { TransportBufferPool } from './transport-buffer-pool.js';

describe('TransportBufferPool', () => {
  let telemetryStub: TelemetryFacade;

  beforeEach(() => {
    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);
  });

  afterEach(() => {
    resetTelemetry();
  });

  it('reuses pooled buffers and logs upsizing events', () => {
    const pool = new TransportBufferPool();
    const lease = pool.acquireFloat64(3, {
      component: 'amounts',
      owner: 'test-suite',
      dirtyCount: 3,
    });

    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'ResourceTransportPoolUpsized',
      expect.objectContaining({
        type: 'Float64Array',
        previousCapacity: 0,
        newCapacity: 3,
      }),
    );

    const buffer = lease.array.buffer;
    lease.release({ owner: 'test-suite' });

    const next = pool.acquireFloat64(3, {
      component: 'amounts',
      owner: 'test-suite',
      dirtyCount: 3,
    });

    expect(next.array.buffer).toBe(buffer);
    next.release({ owner: 'test-suite' });
  });

  it('records pool exhaustion telemetry when requests exceed the configured ceiling', () => {
    const pool = new TransportBufferPool({ maxDirtyCount: 4 });

    expect(() =>
      pool.acquireFloat64(5, {
        component: 'amounts',
        owner: 'test-suite',
        dirtyCount: 5,
      }),
    ).toThrowError(/exhausted/i);

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceTransportPoolExhausted',
      expect.objectContaining({
        type: 'Float64Array',
        requestedDirtyCount: 5,
        dirtyCount: 5,
      }),
    );
  });

  it('records telemetry when buffers are released multiple times', () => {
    const pool = new TransportBufferPool();
    const lease = pool.acquireUint8(2, {
      component: 'flags',
      owner: 'test-suite',
      dirtyCount: 2,
    });

    lease.release({ owner: 'test-suite' });
    lease.release({ owner: 'test-suite' });

    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'ResourceTransportDoubleRelease',
      expect.objectContaining({
        bufferId: lease.id,
        releaseOwner: 'test-suite',
      }),
    );
  });

  it('accepts replacement buffers when callers return transferables', () => {
    const pool = new TransportBufferPool();
    const lease = pool.acquireFloat64(2, {
      component: 'amounts',
      owner: 'test-suite',
      dirtyCount: 2,
    });

    const replacement = new ArrayBuffer(
      4 * Float64Array.BYTES_PER_ELEMENT,
    );

    lease.release({
      owner: 'test-suite',
      buffer: replacement,
    });

    const next = pool.acquireFloat64(4, {
      component: 'amounts',
      owner: 'test-suite',
      dirtyCount: 4,
    });

    expect(next.array.buffer).toBe(replacement);
    next.release({ owner: 'test-suite' });
  });
});
