import type { EventBus, OutboundEventBufferView } from './event-bus.js';
import type {
  RuntimeEventManifestHash,
  RuntimeEventPayload,
  RuntimeEventType,
} from './runtime-event.js';
import type {
  TransportBufferLease,
  TransportBufferPool,
} from '../transport-buffer-pool.js';

export interface RuntimeEventFrame {
  readonly tick: number;
  readonly manifestHash: RuntimeEventManifestHash;
  readonly count: number;
  readonly channelIndices: Uint32Array;
  readonly typeIndices: Uint32Array;
  readonly issuedAt: Float64Array;
  readonly dispatchOrder: Uint32Array;
  readonly payloads: readonly RuntimeEventPayload<RuntimeEventType>[];
  readonly stringTable: readonly string[];
}

export interface RuntimeEventFrameBuildOptions {
  readonly tick: number;
  readonly manifestHash: RuntimeEventManifestHash;
  readonly owner?: string;
  readonly mode?: 'share' | 'transfer';
}

export interface RuntimeEventFrameBuildResult {
  readonly frame: RuntimeEventFrame;
  readonly transferables: readonly ArrayBuffer[];
  release(): void;
}

const DEFAULT_OWNER = 'RuntimeEventFrame';

export function buildRuntimeEventFrame(
  bus: EventBus,
  pool: TransportBufferPool,
  options: RuntimeEventFrameBuildOptions,
): RuntimeEventFrameBuildResult {
  const owner = options.owner ?? DEFAULT_OWNER;
  const mode = options.mode ?? 'share';
  const manifest = bus.getManifest();
  const channelCount = manifest.entries.length;

  const outboundBuffers: OutboundEventBufferView[] = [];
  let totalEvents = 0;

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const buffer = bus.getOutboundBuffer(channelIndex);
    outboundBuffers.push(buffer);
    totalEvents += buffer.length;
  }

  const channelLease = pool.acquireUint32(totalEvents, {
    component: 'event-channel-indices',
    owner,
    dirtyCount: totalEvents,
    tick: options.tick,
  });
  const typeLease = pool.acquireUint32(totalEvents, {
    component: 'event-type-indices',
    owner,
    dirtyCount: totalEvents,
    tick: options.tick,
  });
  const dispatchLease = pool.acquireUint32(totalEvents, {
    component: 'event-dispatch-order',
    owner,
    dirtyCount: totalEvents,
    tick: options.tick,
  });
  const issuedAtLease = pool.acquireFloat64(totalEvents, {
    component: 'event-issued-at',
    owner,
    dirtyCount: totalEvents,
    tick: options.tick,
  });

  const channelIndices = channelLease.array;
  const typeIndices = typeLease.array;
  const dispatchOrder = dispatchLease.array;
  const issuedAt = issuedAtLease.array;
  const payloads: RuntimeEventPayload<RuntimeEventType>[] = new Array(totalEvents);

  const stringTable: string[] = [];
  const typeIndexLookup = new Map<string, number>();

  let writeIndex = 0;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const buffer = outboundBuffers[channelIndex];
    for (let bufferIndex = 0; bufferIndex < buffer.length; bufferIndex += 1) {
      const record = buffer.at(bufferIndex);
      channelIndices[writeIndex] = channelIndex;

      let typeIndex = typeIndexLookup.get(record.type);
      if (typeIndex === undefined) {
        typeIndex = stringTable.length;
        stringTable.push(record.type);
        typeIndexLookup.set(record.type, typeIndex);
      }

      typeIndices[writeIndex] = typeIndex;
      dispatchOrder[writeIndex] = record.dispatchOrder;
      issuedAt[writeIndex] = record.issuedAt;
      payloads[writeIndex] = record.payload;
      writeIndex += 1;
    }
  }

  const frame: RuntimeEventFrame = {
    tick: options.tick,
    manifestHash: options.manifestHash,
    count: totalEvents,
    channelIndices,
    typeIndices,
    issuedAt,
    dispatchOrder,
    payloads,
    stringTable,
  };

  const transferables =
    mode === 'transfer'
      ? dedupeBuffers([
          channelIndices.buffer as ArrayBuffer,
          typeIndices.buffer as ArrayBuffer,
          dispatchOrder.buffer as ArrayBuffer,
          issuedAt.buffer as ArrayBuffer,
        ])
      : [];

  const leases: TransportBufferLease<Float64Array | Uint32Array>[] = [
    channelLease,
    typeLease,
    dispatchLease,
    issuedAtLease,
  ];

  return {
    frame,
    transferables,
    release: () => {
      for (const lease of leases) {
        lease.release({
          owner,
          tick: options.tick,
        });
      }
    },
  };
}

function dedupeBuffers(buffers: readonly ArrayBuffer[]): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const result: ArrayBuffer[] = [];
  for (const buffer of buffers) {
    if (seen.has(buffer)) {
      continue;
    }
    seen.add(buffer);
    result.push(buffer);
  }
  return result;
}
