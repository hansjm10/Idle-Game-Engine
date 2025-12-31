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
import type {
  RuntimeEventFrameDiagnostics,
  RuntimeEventFrameFormat,
} from './runtime-event-frame-format.js';

interface RuntimeEventFrameBase {
  readonly tick: number;
  readonly manifestHash: RuntimeEventManifestHash;
  readonly count: number;
  readonly format: RuntimeEventFrameFormat;
  readonly diagnostics?: RuntimeEventFrameDiagnostics;
}

export interface RuntimeEventStructOfArraysFrame extends RuntimeEventFrameBase {
  readonly format: 'struct-of-arrays';
  readonly channelIndices: Uint32Array;
  readonly typeIndices: Uint32Array;
  readonly issuedAt: Float64Array;
  readonly dispatchOrder: Uint32Array;
  readonly payloads: readonly RuntimeEventPayload<RuntimeEventType>[];
  readonly stringTable: readonly string[];
}

export interface RuntimeEventObjectRecord {
  readonly type: RuntimeEventType;
  readonly channel: number;
  readonly issuedAt: number;
  readonly dispatchOrder: number;
  readonly payload: RuntimeEventPayload<RuntimeEventType>;
}

export interface RuntimeEventObjectArrayFrame extends RuntimeEventFrameBase {
  readonly format: 'object-array';
  readonly events: readonly RuntimeEventObjectRecord[];
}

export type RuntimeEventFrame =
  | RuntimeEventStructOfArraysFrame
  | RuntimeEventObjectArrayFrame;

export interface RuntimeEventFrameBuildOptions {
  readonly tick: number;
  /** Defaults to bus.getManifestHash() when omitted. */
  readonly manifestHash?: RuntimeEventManifestHash;
  readonly owner?: string;
  readonly mode?: 'share' | 'transfer';
  readonly format?: RuntimeEventFrameFormat;
  readonly diagnostics?: RuntimeEventFrameDiagnostics;
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
  const manifestHash = options.manifestHash ?? bus.getManifestHash();
  const manifest = bus.getManifest();
  const channelCount = manifest.entries.length;

  const outboundBuffers: OutboundEventBufferView[] = [];
  let totalEvents = 0;

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const buffer = bus.getOutboundBuffer(channelIndex);
    outboundBuffers.push(buffer);
    totalEvents += buffer.length;
  }

  const format = options.format ?? 'struct-of-arrays';
  const diagnostics = options.diagnostics;

  if (format === 'object-array') {
    const events: RuntimeEventObjectRecord[] = new Array(totalEvents);
    let writeIndex = 0;

    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const buffer = outboundBuffers[channelIndex];
      for (let bufferIndex = 0; bufferIndex < buffer.length; bufferIndex += 1) {
        const record = buffer.at(bufferIndex);
        events[writeIndex] = {
          type: record.type,
          channel: channelIndex,
          issuedAt: record.issuedAt,
          dispatchOrder: record.dispatchOrder,
          payload: record.payload,
        };
        writeIndex += 1;
      }
    }

    const frame: RuntimeEventObjectArrayFrame = {
      format,
      tick: options.tick,
      manifestHash,
      count: totalEvents,
      events,
      diagnostics,
    };

    return {
      frame,
      transferables: [],
      release() {
        // no-op for object-array fallback frames
      },
    };
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
    format,
    tick: options.tick,
    manifestHash,
    count: totalEvents,
    channelIndices,
    typeIndices,
    issuedAt,
    dispatchOrder,
    payloads,
    stringTable,
    diagnostics,
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
