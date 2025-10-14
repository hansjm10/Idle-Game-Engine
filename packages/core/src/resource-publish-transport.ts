import type { ResourceState, ResourceStateSnapshot } from './resource-state.js';
import type {
  LeaseReleaseContext,
  TransportBufferLease,
  TransportBufferPool,
} from './transport-buffer-pool.js';

const TRANSPORT_VERSION = 2;
const FLAG_DIRTY_THIS_TICK = 1 << 2;

export type TransportComponent =
  | 'amounts'
  | 'capacities'
  | 'incomePerSecond'
  | 'expensePerSecond'
  | 'netPerSecond'
  | 'tickDelta'
  | 'flags'
  | 'dirtyTolerance';

export type TransportConstructorName =
  | 'Float64Array'
  | 'Uint8Array'
  | 'Uint32Array';

export interface TransportBufferDescriptor {
  readonly component: TransportComponent;
  readonly ctor: TransportConstructorName;
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly length: number;
}

export interface ResourcePublishTransport {
  readonly version: typeof TRANSPORT_VERSION;
  readonly ids: readonly string[];
  readonly dirtyIndices: Uint32Array;
  readonly buffers: readonly TransportBufferDescriptor[];
}

export interface ResourcePublishTransportBuildOptions {
  readonly mode?: 'transfer' | 'share';
  readonly owner?: string;
  readonly tick?: number;
}

export interface ResourcePublishTransportReleaseOptions {
  readonly tick?: number;
  readonly buffers?: Partial<Record<TransportComponent, ArrayBuffer>>;
  readonly dirtyIndicesBuffer?: ArrayBuffer;
}

export interface ResourcePublishTransportBuildResult {
  readonly transport: ResourcePublishTransport;
  readonly transferables: readonly ArrayBuffer[];
  release(options?: ResourcePublishTransportReleaseOptions): void;
}

type ComponentLease = {
  readonly component: TransportComponent;
  readonly lease: TransportBufferLease<Float64Array> | TransportBufferLease<Uint8Array>;
};

interface ComponentSpec {
  readonly component: TransportComponent;
  readonly ctor: TransportConstructorName;
  readonly acquire: (
    pool: TransportBufferPool,
    length: number,
    contextOwner: string,
    tick: number | undefined,
  ) => TransportBufferLease<Float64Array> | TransportBufferLease<Uint8Array>;
}

const COMPONENT_SPECS: readonly ComponentSpec[] = [
  {
    component: 'amounts',
    ctor: 'Float64Array',
    acquire: (pool, length, owner, tick) =>
      pool.acquireFloat64(length, {
        component: 'amounts',
        owner,
        dirtyCount: length,
        tick,
      }),
  },
  {
    component: 'capacities',
    ctor: 'Float64Array',
    acquire: (pool, length, owner, tick) =>
      pool.acquireFloat64(length, {
        component: 'capacities',
        owner,
        dirtyCount: length,
        tick,
      }),
  },
  {
    component: 'incomePerSecond',
    ctor: 'Float64Array',
    acquire: (pool, length, owner, tick) =>
      pool.acquireFloat64(length, {
        component: 'incomePerSecond',
        owner,
        dirtyCount: length,
        tick,
      }),
  },
  {
    component: 'expensePerSecond',
    ctor: 'Float64Array',
    acquire: (pool, length, owner, tick) =>
      pool.acquireFloat64(length, {
        component: 'expensePerSecond',
        owner,
        dirtyCount: length,
        tick,
      }),
  },
  {
    component: 'netPerSecond',
    ctor: 'Float64Array',
    acquire: (pool, length, owner, tick) =>
      pool.acquireFloat64(length, {
        component: 'netPerSecond',
        owner,
        dirtyCount: length,
        tick,
      }),
  },
  {
    component: 'tickDelta',
    ctor: 'Float64Array',
    acquire: (pool, length, owner, tick) =>
      pool.acquireFloat64(length, {
        component: 'tickDelta',
        owner,
        dirtyCount: length,
        tick,
      }),
  },
  {
    component: 'flags',
    ctor: 'Uint8Array',
    acquire: (pool, length, owner, tick) =>
      pool.acquireUint8(length, {
        component: 'flags',
        owner,
        dirtyCount: length,
        tick,
      }),
  },
  {
    component: 'dirtyTolerance',
    ctor: 'Float64Array',
    acquire: (pool, length, owner, tick) =>
      pool.acquireFloat64(length, {
        component: 'dirtyTolerance',
        owner,
        dirtyCount: length,
        tick,
      }),
  },
] as const;

export function createResourcePublishTransport(
  state: ResourceState,
  pool: TransportBufferPool,
  options?: ResourcePublishTransportBuildOptions,
): ResourcePublishTransportBuildResult {
  const snapshot = state.snapshot({ mode: 'publish' });
  return buildResourcePublishTransport(snapshot, pool, options);
}

export function buildResourcePublishTransport(
  snapshot: ResourceStateSnapshot,
  pool: TransportBufferPool,
  options: ResourcePublishTransportBuildOptions = {},
): ResourcePublishTransportBuildResult {
  const dirtyCount = snapshot.dirtyCount;
  const owner = options.owner ?? 'ResourcePublishTransport';
  const tick = options.tick;
  const mode = options.mode ?? 'share';

  if (dirtyCount === 0) {
    return buildEmptyTransport(snapshot);
  }

  const dirtyLease = pool.acquireUint32(dirtyCount, {
    component: 'dirtyIndices',
    owner,
    dirtyCount,
    tick,
  });

  const componentLeases: ComponentLease[] = COMPONENT_SPECS.map((spec) => ({
    component: spec.component,
    lease: spec.acquire(pool, dirtyCount, owner, tick),
  }));

  populateComponentBuffers(
    snapshot,
    dirtyLease,
    componentLeases,
  );

  const descriptors = componentLeases.map((entry) => {
    const { component, lease } = entry;
    return createDescriptor(component, lease.array);
  });

  const dirtyIndices = dirtyLease.array;
  const dirtyIndicesBuffer = requireArrayBuffer(dirtyIndices.buffer);

  const transport: ResourcePublishTransport = {
    version: TRANSPORT_VERSION,
    ids: snapshot.ids,
    dirtyIndices,
    buffers: descriptors,
  };

  const transferables =
    mode === 'transfer'
      ? dedupeBuffers([
          dirtyIndicesBuffer,
          ...descriptors.map((descriptor) => descriptor.buffer),
        ])
      : [];

  const release = (releaseOptions?: ResourcePublishTransportReleaseOptions) => {
    const releaseTick = releaseOptions?.tick;
    const buffers = releaseOptions?.buffers ?? {};
    const dirtyIndicesOverride = releaseOptions?.dirtyIndicesBuffer;

    const releaseContext = (buffer?: ArrayBuffer): LeaseReleaseContext => ({
      owner,
      tick: releaseTick,
      buffer,
    });

    dirtyLease.release(releaseContext(dirtyIndicesOverride));
    for (const entry of componentLeases) {
      entry.lease.release(releaseContext(buffers[entry.component]));
    }
  };

  return {
    transport,
    transferables,
    release,
  };
}

function buildEmptyTransport(
  snapshot: ResourceStateSnapshot,
): ResourcePublishTransportBuildResult {
  const emptyFloat = new Float64Array(0);
  const emptyUint8 = new Uint8Array(0);
  const emptyUint32 = new Uint32Array(0);

  const descriptors: TransportBufferDescriptor[] = [
    createDescriptor('amounts', emptyFloat),
    createDescriptor('capacities', emptyFloat),
    createDescriptor('incomePerSecond', emptyFloat),
    createDescriptor('expensePerSecond', emptyFloat),
    createDescriptor('netPerSecond', emptyFloat),
    createDescriptor('tickDelta', emptyFloat),
    createDescriptor('flags', emptyUint8),
    createDescriptor('dirtyTolerance', emptyFloat),
  ];

  const transport: ResourcePublishTransport = {
    version: TRANSPORT_VERSION,
    ids: snapshot.ids,
    dirtyIndices: emptyUint32,
    buffers: descriptors,
  };

  return {
    transport,
    transferables: [],
    release() {
      // nothing to release
    },
  };
}

function populateComponentBuffers(
  snapshot: ResourceStateSnapshot,
  dirtyLease: TransportBufferLease<Uint32Array>,
  componentLeases: readonly ComponentLease[],
): void {
  const {
    amounts,
    capacities,
    incomePerSecond,
    expensePerSecond,
    netPerSecond,
    tickDelta,
    flags,
    dirtyTolerance,
    dirtyIndices,
  } = snapshot;

  const dirtyIndicesTarget = dirtyLease.array;
  const mask = ~FLAG_DIRTY_THIS_TICK;

  for (let i = 0; i < snapshot.dirtyCount; i += 1) {
    const index = dirtyIndices[i];
    dirtyIndicesTarget[i] = index;
  }

  const componentLookup: Record<TransportComponent, Float64Array | Uint8Array> =
    {
      amounts,
      capacities,
      incomePerSecond,
      expensePerSecond,
      netPerSecond,
      tickDelta,
      flags,
      dirtyTolerance,
    };

  for (const entry of componentLeases) {
    const source = componentLookup[entry.component];
    const target = entry.lease.array;

    if (entry.component === 'flags') {
      for (let i = 0; i < snapshot.dirtyCount; i += 1) {
        const resourceIndex = dirtyIndices[i];
        target[i] = (source as Uint8Array)[resourceIndex] & mask;
      }
      continue;
    }

    for (let i = 0; i < snapshot.dirtyCount; i += 1) {
      const resourceIndex = dirtyIndices[i];
      target[i] = (source as Float64Array)[resourceIndex];
    }
  }
}

function createDescriptor(
  component: TransportComponent,
  view: Float64Array | Uint8Array,
): TransportBufferDescriptor {
  const buffer = requireArrayBuffer(view.buffer);
  return {
    component,
    ctor: view.constructor.name as TransportConstructorName,
    buffer,
    byteOffset: view.byteOffset,
    length: view.length,
  };
}

function requireArrayBuffer(buffer: ArrayBufferLike): ArrayBuffer {
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }
  throw new TypeError('Resource publish transport requires ArrayBuffer-backed views.');
}

function dedupeBuffers(buffers: readonly ArrayBuffer[]): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const result: ArrayBuffer[] = [];
  for (const buffer of buffers) {
    if (!seen.has(buffer)) {
      seen.add(buffer);
      result.push(buffer);
    }
  }
  return result;
}
