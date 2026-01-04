import type { EventBus } from './event-bus.js';
import type { RuntimeEventFrame, RuntimeEventObjectRecord } from './runtime-event-frame.js';
import type {
  RuntimeEventManifestHash,
  RuntimeEventType,
} from './runtime-event.js';
import { fnv1a32 } from '../state-sync/checksum.js';

const DEFAULT_DEDUPER_CAPACITY = 10_000;
const utf8Encoder = new TextEncoder();
const compareDeterministicKeys = (left: string, right: string): number =>
  left.localeCompare(right, 'en');

export type SerializedRuntimeEvent = RuntimeEventObjectRecord;

export interface EventBroadcastFrame {
  readonly serverStep: number;
  readonly events: readonly SerializedRuntimeEvent[];
  readonly checksum?: string;
  readonly manifestHash?: RuntimeEventManifestHash;
}

export interface EventFilter {
  allows(event: SerializedRuntimeEvent): boolean;
}

export function createEventTypeFilter(
  allowedTypes: readonly RuntimeEventType[],
): EventFilter {
  const allowed = new Set(allowedTypes);
  return {
    allows(event) {
      return allowed.has(event.type);
    },
  };
}

export interface EventBroadcastFrameOptions {
  readonly serverStep?: number;
  readonly filter?: EventFilter;
  readonly includeManifestHash?: boolean;
  readonly includeChecksum?: boolean;
  readonly sortByDispatchOrder?: boolean;
}

export function createEventBroadcastFrame(
  frame: RuntimeEventFrame,
  options: EventBroadcastFrameOptions = {},
): EventBroadcastFrame {
  const serverStep = options.serverStep ?? frame.tick;
  const includeManifestHash = options.includeManifestHash ?? true;
  const includeChecksum = options.includeChecksum ?? false;
  const sortByDispatchOrder = options.sortByDispatchOrder ?? true;

  let events = serializeRuntimeEventFrame(frame);

  if (options.filter) {
    events = events.filter((event) => options.filter?.allows(event));
  }

  if (sortByDispatchOrder && events.length > 1) {
    events = [...events].sort(
      (left, right) => left.dispatchOrder - right.dispatchOrder,
    );
  }

  const base: EventBroadcastFrame = {
    serverStep,
    events,
    ...(includeManifestHash ? { manifestHash: frame.manifestHash } : {}),
  };

  if (!includeChecksum) {
    return base;
  }

  const checksum = computeEventBroadcastChecksum(base);
  return {
    ...base,
    checksum,
  };
}

export function computeEventBroadcastChecksum(
  frame: EventBroadcastFrame,
): string {
  const payload: Record<string, unknown> = {
    serverStep: frame.serverStep,
    events: frame.events,
  };

  if (frame.manifestHash !== undefined) {
    payload.manifestHash = frame.manifestHash;
  }

  const json = stringifyDeterministic(payload);
  return fnv1a32(utf8Encoder.encode(json));
}

function refreshBroadcastFrameChecksum(
  frame: EventBroadcastFrame,
  recompute: boolean,
): EventBroadcastFrame {
  if (!recompute || frame.checksum === undefined) {
    return frame;
  }
  return {
    ...frame,
    checksum: computeEventBroadcastChecksum(frame),
  };
}

export interface EventBroadcastHydrateOptions {
  readonly filter?: EventFilter;
  readonly deduper?: EventBroadcastDeduper;
  readonly validateManifest?: boolean;
  readonly validateChecksum?: boolean;
  readonly assumeSorted?: boolean;
  readonly resetOutbound?: boolean;
}

/**
 * Applies a broadcast frame to a bus.
 *
 * By default, begins the tick with `resetOutbound: true` to clear outbound buffers;
 * pass `resetOutbound: false` to preserve locally published outbound events.
 */
export function applyEventBroadcastFrame(
  bus: EventBus,
  frame: EventBroadcastFrame,
  options: EventBroadcastHydrateOptions = {},
): void {
  if (options.validateManifest !== false && frame.manifestHash !== undefined) {
    const manifestHash = bus.getManifestHash();
    if (manifestHash !== frame.manifestHash) {
      throw new Error(
        'Runtime event manifest hash mismatch while applying broadcast frame.',
      );
    }
  }

  if (options.validateChecksum !== false && frame.checksum !== undefined) {
    const expected = computeEventBroadcastChecksum(frame);
    if (expected !== frame.checksum) {
      throw new Error('Event broadcast checksum mismatch.');
    }
  }

  const filteredEvents = options.filter
    ? frame.events.filter((event) => options.filter?.allows(event))
    : frame.events;
  const orderedEvents = options.assumeSorted
    ? filteredEvents
    : [...filteredEvents].sort(
        (left, right) => left.dispatchOrder - right.dispatchOrder,
      );

  bus.beginTick(frame.serverStep, {
    resetOutbound: options.resetOutbound ?? true,
  });

  for (const event of orderedEvents) {
    if (options.deduper?.shouldSkip(frame.serverStep, event)) {
      continue;
    }
    bus.publish(event.type, event.payload, {
      issuedAt: event.issuedAt,
    });
  }

  bus.dispatch({ tick: frame.serverStep });
}

export interface EventBroadcastBatch {
  readonly frames: readonly EventBroadcastFrame[];
  readonly fromStep: number;
  readonly toStep: number;
  readonly eventCount: number;
}

export interface EventBroadcastBatcherOptions {
  readonly maxSteps?: number;
  readonly maxEvents?: number;
  readonly maxDelayMs?: number;
  readonly clock?: () => number;
  readonly filter?: EventFilter;
  readonly priorityEventTypes?: readonly RuntimeEventType[];
  readonly coalesce?: EventCoalescingOptions;
}

export interface EventCoalescingOptions {
  readonly key: (event: SerializedRuntimeEvent) => string;
  readonly mode?: 'first' | 'last';
}

export class EventBroadcastBatcher {
  private readonly maxSteps: number;
  private readonly maxEvents?: number;
  private readonly maxDelayMs?: number;
  private readonly clock: () => number;
  private readonly filter?: EventFilter;
  private readonly priorityTypes?: Set<RuntimeEventType>;
  private readonly coalesce?: EventCoalescingOptions;
  private pendingFrames: EventBroadcastFrame[] = [];
  private pendingEventCount = 0;
  private pendingSince: number | null = null;

  constructor(options: EventBroadcastBatcherOptions = {}) {
    const maxSteps = normalizePositiveInt(options.maxSteps, 'maxSteps');
    const maxEvents = normalizePositiveInt(options.maxEvents, 'maxEvents');
    const maxDelayMs = normalizeNonNegativeInt(
      options.maxDelayMs,
      'maxDelayMs',
    );
    const hasLimit = maxSteps !== undefined ||
      maxEvents !== undefined ||
      (maxDelayMs !== undefined && maxDelayMs > 0);

    this.maxSteps = maxSteps ?? (hasLimit ? Number.POSITIVE_INFINITY : 1);
    this.maxEvents = maxEvents;
    this.maxDelayMs = maxDelayMs;
    this.clock = options.clock ?? Date.now;
    this.filter = options.filter;
    this.priorityTypes = options.priorityEventTypes
      ? new Set(options.priorityEventTypes)
      : undefined;
    this.coalesce = options.coalesce;
  }

  ingestFrame(frame: EventBroadcastFrame, now = this.clock()): EventBroadcastBatch[] {
    const batches: EventBroadcastBatch[] = [];

    if (this.pendingSince !== null && this.maxDelayMs !== undefined) {
      if (now - this.pendingSince >= this.maxDelayMs) {
        const flushed = this.flush();
        if (flushed) {
          batches.push(flushed);
        }
      }
    }

    let events = frame.events;
    if (this.filter) {
      events = events.filter((event) => this.filter?.allows(event));
    }

    if (events.length === 0) {
      return batches;
    }

    let adjustedFrame: EventBroadcastFrame = {
      ...frame,
      events: [...events],
    };
    adjustedFrame = refreshBroadcastFrameChecksum(
      adjustedFrame,
      events.length !== frame.events.length,
    );

    if (this.priorityTypes && hasPriorityEvent(events, this.priorityTypes)) {
      const flushed = this.flush();
      if (flushed) {
        batches.push(flushed);
      }
      batches.push(this.buildBatch([adjustedFrame]));
      return batches;
    }

    this.addPendingFrame(adjustedFrame, now);

    if (this.shouldFlushAfterAdd()) {
      const flushed = this.flush();
      if (flushed) {
        batches.push(flushed);
      }
    }

    return batches;
  }

  flush(): EventBroadcastBatch | null {
    if (this.pendingFrames.length === 0) {
      return null;
    }

    const frames = this.coalesce
      ? coalesceBatchFrames(this.pendingFrames, this.coalesce)
      : this.pendingFrames;

    this.pendingFrames = [];
    this.pendingEventCount = 0;
    this.pendingSince = null;

    if (frames.length === 0) {
      return null;
    }

    return this.buildBatch(frames);
  }

  private buildBatch(frames: EventBroadcastFrame[]): EventBroadcastBatch {
    const ordered = frames.length > 1
      ? [...frames].sort((left, right) => left.serverStep - right.serverStep)
      : frames;
    const eventCount = ordered.reduce(
      (count, entry) => count + entry.events.length,
      0,
    );
    return {
      frames: ordered,
      fromStep: ordered[0].serverStep,
      toStep: ordered[ordered.length - 1].serverStep,
      eventCount,
    };
  }

  private addPendingFrame(frame: EventBroadcastFrame, now: number): void {
    if (this.pendingFrames.length === 0) {
      this.pendingSince = now;
    }
    this.pendingFrames.push(frame);
    this.pendingEventCount += frame.events.length;
  }

  private shouldFlushAfterAdd(): boolean {
    if (this.pendingFrames.length >= this.maxSteps) {
      return true;
    }
    if (
      this.maxEvents !== undefined &&
      this.pendingEventCount >= this.maxEvents
    ) {
      return true;
    }
    return false;
  }
}

export interface EventBroadcastDeduperOptions {
  readonly capacity?: number;
}

/**
 * Deduplicates replayed events using `serverStep`, `dispatchOrder`, and `type`.
 */
export class EventBroadcastDeduper {
  private readonly capacity: number;
  private readonly seen = new Set<string>();
  private readonly ring: Array<string | null>;
  private writeIndex = 0;
  private size = 0;

  constructor(options: EventBroadcastDeduperOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_DEDUPER_CAPACITY;
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(
        `EventBroadcastDeduper capacity must be a positive number (received ${capacity}).`,
      );
    }
    this.capacity = Math.floor(capacity);
    this.ring = new Array(this.capacity).fill(null);
  }

  shouldSkip(serverStep: number, event: SerializedRuntimeEvent): boolean {
    const key = `${serverStep}:${event.dispatchOrder}:${event.type}`;
    if (this.seen.has(key)) {
      return true;
    }
    this.seen.add(key);
    this.record(key);
    return false;
  }

  reset(): void {
    this.seen.clear();
    this.ring.fill(null);
    this.writeIndex = 0;
    this.size = 0;
  }

  private record(key: string): void {
    if (this.size < this.capacity) {
      this.ring[this.writeIndex] = key;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.size += 1;
      return;
    }

    const evicted = this.ring[this.writeIndex];
    if (evicted) {
      this.seen.delete(evicted);
    }
    this.ring[this.writeIndex] = key;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
  }
}

export function applyEventBroadcastBatch(
  bus: EventBus,
  batch: EventBroadcastBatch,
  options?: EventBroadcastHydrateOptions,
): void {
  for (const frame of batch.frames) {
    applyEventBroadcastFrame(bus, frame, options);
  }
}

function serializeRuntimeEventFrame(
  frame: RuntimeEventFrame,
): SerializedRuntimeEvent[] {
  if (frame.count === 0) {
    return [];
  }

  if (frame.format === 'object-array') {
    return frame.events.map((event) => ({
      type: event.type,
      channel: event.channel,
      issuedAt: event.issuedAt,
      dispatchOrder: event.dispatchOrder,
      payload: event.payload,
    }));
  }

  const events: SerializedRuntimeEvent[] = new Array(frame.count);
  for (let index = 0; index < frame.count; index += 1) {
    const type = frame.stringTable[frame.typeIndices[index]];
    events[index] = {
      type: type as RuntimeEventType,
      channel: frame.channelIndices[index],
      issuedAt: frame.issuedAt[index],
      dispatchOrder: frame.dispatchOrder[index],
      payload: frame.payloads[index],
    };
  }
  return events;
}

function hasPriorityEvent(
  events: readonly SerializedRuntimeEvent[],
  priorityTypes: Set<RuntimeEventType>,
): boolean {
  for (const event of events) {
    if (priorityTypes.has(event.type)) {
      return true;
    }
  }
  return false;
}

function coalesceBatchFrames(
  frames: readonly EventBroadcastFrame[],
  options: EventCoalescingOptions,
): EventBroadcastFrame[] {
  if (frames.length <= 1) {
    return frames.slice();
  }

  const mode = options.mode ?? 'last';
  const lookup = new Map<string, { frameIndex: number; eventIndex: number }>();
  const mutableFrames = frames.map((frame) => ({
    ...frame,
    events: frame.events.slice() as Array<SerializedRuntimeEvent | null>,
  }));

  for (let frameIndex = 0; frameIndex < mutableFrames.length; frameIndex += 1) {
    const events = mutableFrames[frameIndex].events;
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      if (!event) {
        continue;
      }
      const key = options.key(event);
      const existing = lookup.get(key);
      if (!existing) {
        lookup.set(key, { frameIndex, eventIndex });
        continue;
      }
      if (mode === 'first') {
        events[eventIndex] = null;
        continue;
      }
      const priorEvents = mutableFrames[existing.frameIndex].events;
      priorEvents[existing.eventIndex] = null;
      lookup.set(key, { frameIndex, eventIndex });
    }
  }

  const result: EventBroadcastFrame[] = [];
  for (const frame of mutableFrames) {
    const compacted = frame.events.filter(
      (event): event is SerializedRuntimeEvent => event !== null,
    );
    if (compacted.length === 0) {
      continue;
    }
    let updated: EventBroadcastFrame = {
      ...frame,
      events: compacted,
    };
    updated = refreshBroadcastFrameChecksum(
      updated,
      compacted.length !== frame.events.length,
    );
    result.push(updated);
  }
  return result;
}

function normalizePositiveInt(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (received ${value}).`);
  }
  const normalized = Math.floor(value);
  if (normalized <= 0) {
    throw new Error(`${name} must be a positive integer (received ${value}).`);
  }
  return normalized;
}

function normalizeNonNegativeInt(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number (received ${value}).`);
  }
  return Math.floor(value);
}

function normalizeForDeterministicJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForDeterministicJson(entry));
  }

  const result: Record<string, unknown> = {};
  const keys = Object.keys(value).sort(compareDeterministicKeys);
  for (const key of keys) {
    result[key] = normalizeForDeterministicJson(
      (value as Record<string, unknown>)[key],
    );
  }
  return result;
}

function stringifyDeterministic(value: unknown): string {
  return JSON.stringify(normalizeForDeterministicJson(value));
}
