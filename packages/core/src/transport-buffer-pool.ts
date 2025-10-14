import { telemetry } from './telemetry.js';

type TransportArrayKind = 'Float64Array' | 'Uint8Array' | 'Uint32Array';

type TypedArray = Float64Array | Uint8Array | Uint32Array;

interface LeaseAcquireContext {
  readonly component: string;
  readonly owner: string;
  readonly dirtyCount: number;
  readonly tick?: number;
}

export interface LeaseReleaseContext {
  readonly owner?: string;
  readonly tick?: number;
  readonly buffer?: ArrayBuffer;
}

export interface TransportBufferPoolOptions {
  readonly maxEstimatedDirty?: number;
  readonly maxDirtyCount?: number;
}

export interface TransportBufferLease<TArray extends TypedArray> {
  readonly id: number;
  readonly kind: TransportArrayKind;
  readonly array: TArray;
  readonly length: number;
  readonly capacity: number;
  release(context?: LeaseReleaseContext): void;
}

interface PoolEntry<TArray extends TypedArray> {
  readonly id: number;
  readonly kind: TransportArrayKind;
  capacity: number;
  buffer: ArrayBuffer;
  view: TArray;
  activeOwner?: string;
  activeComponent?: string;
  activeTick?: number;
  activeLength?: number;
  lastOwner?: string;
  lastTick?: number;
  lastComponent?: string;
}

const ARRAY_CTORS: Record<
  TransportArrayKind,
  {
    new(length: number): TypedArray;
    new(buffer: ArrayBuffer, byteOffset?: number, length?: number): TypedArray;
    readonly BYTES_PER_ELEMENT: number;
  }
> = {
  Float64Array,
  Uint8Array,
  Uint32Array,
};

export class TransportBufferPool {
  private readonly available: Record<TransportArrayKind, PoolEntry<TypedArray>[]> =
    {
      Float64Array: [],
      Uint8Array: [],
      Uint32Array: [],
    };
  private readonly active = new Map<number, PoolEntry<TypedArray>>();
  private readonly entries = new Map<number, PoolEntry<TypedArray>>();
  private readonly highWaterMark: Record<TransportArrayKind, number> = {
    Float64Array: 0,
    Uint8Array: 0,
    Uint32Array: 0,
  };
  private nextId = 1;

  private readonly hint?: number;
  private readonly maxDirtyCount?: number;

  constructor(options: TransportBufferPoolOptions = {}) {
    this.hint = options.maxEstimatedDirty;
    this.maxDirtyCount = options.maxDirtyCount;

    if (this.hint !== undefined && this.hint > 0) {
      this.bootstrapHint('Float64Array');
      this.bootstrapHint('Uint8Array');
      this.bootstrapHint('Uint32Array');
    }
  }

  acquireFloat64(
    length: number,
    context: LeaseAcquireContext,
  ): TransportBufferLease<Float64Array> {
    return this.acquire('Float64Array', length, context) as TransportBufferLease<Float64Array>;
  }

  acquireUint8(
    length: number,
    context: LeaseAcquireContext,
  ): TransportBufferLease<Uint8Array> {
    return this.acquire('Uint8Array', length, context) as TransportBufferLease<Uint8Array>;
  }

  acquireUint32(
    length: number,
    context: LeaseAcquireContext,
  ): TransportBufferLease<Uint32Array> {
    return this.acquire('Uint32Array', length, context) as TransportBufferLease<Uint32Array>;
  }

  private acquire(
    kind: TransportArrayKind,
    length: number,
    context: LeaseAcquireContext,
  ): TransportBufferLease<TypedArray> {
    if (length < 0) {
      throw new Error(`TransportBufferPool cannot serve negative length (${length}).`);
    }

    if (length === 0) {
      const ctor = ARRAY_CTORS[kind];
      const empty = new ctor(0) as TypedArray;
      return {
        id: 0,
        kind,
        array: empty,
        length: 0,
        capacity: 0,
        release() {
          // no-op for empty leases
        },
      };
    }

    if (this.maxDirtyCount !== undefined && length > this.maxDirtyCount) {
      const bytesPerElement = ARRAY_CTORS[kind].BYTES_PER_ELEMENT;
      telemetry.recordError('ResourceTransportPoolExhausted', {
        type: kind,
        component: context.component,
        requestedDirtyCount: length,
        requestedBytes: length * bytesPerElement,
        poolSize: this.getPoolSize(kind),
        dirtyCount: context.dirtyCount,
      });
      throw new Error(
        `TransportBufferPool exhausted for ${kind} (requested ${length}, max ${this.maxDirtyCount}).`,
      );
    }

    let entry = this.findAvailableEntry(kind, length);

    if (entry === undefined) {
      entry = this.createEntry(kind, length);
    }

    this.active.set(entry.id, entry);
    entry.activeOwner = context.owner;
    entry.activeComponent = context.component;
    entry.activeTick = context.tick;
    entry.activeLength = length;

    const view =
      length === entry.capacity
        ? entry.view
        : (entry.view.subarray(0, length) as TypedArray);

    return {
      id: entry.id,
      kind,
      array: view,
      length,
      capacity: entry.capacity,
      release: (releaseContext?: LeaseReleaseContext) => {
        this.release(entry!.id, releaseContext);
      },
    };
  }

  private release(id: number, context?: LeaseReleaseContext): void {
    const entry = this.active.get(id);
    if (entry === undefined) {
      const knownEntry = this.entries.get(id);
      telemetry.recordError('ResourceTransportDoubleRelease', {
        bufferId: id,
        releaseOwner: context?.owner,
        releaseTick: context?.tick,
        activeOwner: knownEntry?.lastOwner,
        activeTick: knownEntry?.lastTick,
        component: knownEntry?.lastComponent,
      });
      return;
    }

    this.active.delete(id);
    entry.lastOwner = entry.activeOwner;
    entry.lastTick = entry.activeTick;
    entry.lastComponent = entry.activeComponent;
    entry.activeOwner = undefined;
    entry.activeComponent = undefined;
    entry.activeTick = undefined;
    entry.activeLength = undefined;

    const ctor = ARRAY_CTORS[entry.kind];
    const bytesPerElement = ctor.BYTES_PER_ELEMENT;
    const replacementBuffer = context?.buffer;

    if (replacementBuffer !== undefined) {
      entry.buffer = replacementBuffer;
      const newCapacity = replacementBuffer.byteLength / bytesPerElement;
      entry.capacity = newCapacity;
      entry.view = new ctor(replacementBuffer) as TypedArray;
      this.updateHighWaterMark(entry.kind, newCapacity);
    } else if (entry.buffer.byteLength === 0) {
      const restoredBuffer = new ArrayBuffer(entry.capacity * bytesPerElement);
      entry.buffer = restoredBuffer;
      entry.view = new ctor(restoredBuffer) as TypedArray;
    }

    const list = this.available[entry.kind];
    list.push(entry);
    list.sort((a, b) => a.capacity - b.capacity);
  }

  private findAvailableEntry(
    kind: TransportArrayKind,
    requiredLength: number,
  ): PoolEntry<TypedArray> | undefined {
    const list = this.available[kind];
    for (let index = 0; index < list.length; index += 1) {
      const candidate = list[index];
      if (candidate.capacity >= requiredLength) {
        list.splice(index, 1);
        return candidate;
      }
    }
    return undefined;
  }

  private createEntry(
    kind: TransportArrayKind,
    capacity: number,
    bootstrap = false,
  ): PoolEntry<TypedArray> {
    const ctor = ARRAY_CTORS[kind];
    const buffer = new ArrayBuffer(capacity * ctor.BYTES_PER_ELEMENT);
    const view = new ctor(buffer) as TypedArray;
    const entry: PoolEntry<TypedArray> = {
      id: this.nextId,
      kind,
      capacity,
      buffer,
      view,
    };
    this.entries.set(entry.id, entry);
    this.nextId += 1;

    this.updateHighWaterMark(kind, capacity, bootstrap);

    return entry;
  }

  private bootstrapHint(kind: TransportArrayKind): void {
    if (this.hint === undefined || this.hint <= 0) {
      return;
    }
    const entry = this.createEntry(kind, this.hint, true);
    this.available[kind].push(entry);
    this.available[kind].sort((a, b) => a.capacity - b.capacity);
  }

  private getPoolSize(kind: TransportArrayKind): number {
    return (
      this.available[kind].length +
      Array.from(this.active.values()).filter((entry) => entry.kind === kind)
        .length
    );
  }

  private updateHighWaterMark(
    kind: TransportArrayKind,
    capacity: number,
    bootstrap = false,
  ): void {
    const previousCapacity = this.highWaterMark[kind];
    if (!bootstrap && capacity > previousCapacity) {
      telemetry.recordProgress('ResourceTransportPoolUpsized', {
        type: kind,
        previousCapacity,
        newCapacity: capacity,
      });
    }
    this.highWaterMark[kind] = Math.max(previousCapacity, capacity);
  }
}
