import {
  computeRuntimeEventManifestHash,
  createRuntimeEvent,
  type CreateRuntimeEventOptions,
  type RuntimeEvent,
  type RuntimeEventDefinition,
  type RuntimeEventManifest,
  type RuntimeEventManifestEntry,
  type RuntimeEventManifestHash,
  type RuntimeEventPayload,
  type RuntimeEventType,
} from './runtime-event.js';
import { EventDiagnostics } from './event-diagnostics.js';
import type { EventDiagnosticsChannelConfig } from './event-diagnostics.js';
import {
  RuntimeEventFrameFormatController,
  type RuntimeEventFrameExportOptions,
  type RuntimeEventFrameExportState,
} from './runtime-event-frame-format.js';
import { telemetry } from '../telemetry.js';

const DEFAULT_CHANNEL_CAPACITY = 256;
const DEFAULT_SOFT_LIMIT_RATIO = 0.75;
const DEFAULT_DIAGNOSTIC_COOLDOWN_TICKS = 1;
const DEFAULT_DIAGNOSTIC_MAX_COOLDOWN_MULTIPLIER = 16;
const DEFAULT_MAX_EVENTS_PER_SECOND_MULTIPLIER = 4;

export type PublishState = 'accepted' | 'soft-limit' | 'rejected';

export interface PublishMetadata {
  readonly issuedAt?: number;
}

export interface PublishResult<TType extends RuntimeEventType = RuntimeEventType> {
  readonly accepted: boolean;
  readonly state: PublishState;
  readonly type: TType;
  readonly channel: number;
  readonly bufferSize: number;
  readonly remainingCapacity: number;
  readonly dispatchOrder: number;
  readonly softLimitActive: boolean;
}

export interface EventPublisher {
  publish<TType extends RuntimeEventType>(
    eventType: TType,
    payload: RuntimeEventPayload<TType>,
    metadata?: PublishMetadata,
  ): PublishResult<TType>;
}

export type EventHandler<TType extends RuntimeEventType = RuntimeEventType> = (
  event: RuntimeEvent<TType>,
  context: EventDispatchContext,
) => void;

export interface EventDispatchContext {
  readonly tick: number;
}

export interface EventSubscription {
  unsubscribe(): void;
}

export interface OutboundEventRecord<TType extends RuntimeEventType = RuntimeEventType> {
  readonly type: TType;
  readonly tick: number;
  readonly issuedAt: number;
  readonly payload: RuntimeEventPayload<TType>;
  readonly dispatchOrder: number;
}

export interface OutboundEventBufferView<TType extends RuntimeEventType = RuntimeEventType> {
  readonly length: number;
  at(index: number): OutboundEventRecord<TType>;
}

export interface EventChannelConfiguration<TType extends RuntimeEventType = RuntimeEventType> {
  readonly definition: RuntimeEventDefinition<TType>;
  readonly capacity?: number;
  readonly softLimit?: number;
  readonly diagnostics?: EventChannelDiagnosticsOptions;
  readonly onSoftLimit?: (context: SoftLimitContext<TType>) => void;
}

export interface EventChannelConfigOverride {
  readonly capacity?: number;
  readonly softLimit?: number;
  readonly diagnostics?: EventChannelDiagnosticsOptions;
}

export type EventChannelConfigMap = Partial<
  Record<RuntimeEventType, EventChannelConfigOverride>
>;

export interface EventChannelDiagnosticsOptions {
  readonly maxEventsPerTick?: number;
  readonly maxEventsPerSecond?: number;
  readonly cooldownTicks?: number;
  readonly maxCooldownTicks?: number;
}

export interface SoftLimitContext<TType extends RuntimeEventType = RuntimeEventType> {
  readonly type: TType;
  readonly channel: number;
  readonly bufferSize: number;
  readonly capacity: number;
  readonly softLimit: number;
  readonly remainingCapacity: number;
}

export interface SlowHandlerContext<
  TType extends RuntimeEventType = RuntimeEventType,
> {
  readonly type: TType;
  readonly channel: number;
  readonly tick: number;
  readonly dispatchOrder: number;
  readonly durationMs: number;
  readonly thresholdMs: number;
  readonly handlerLabel?: string;
}

export interface EventSubscriptionOptions {
  readonly label?: string;
}

export interface EventBusOptions {
  readonly channels: ReadonlyArray<EventChannelConfiguration>;
  readonly channelConfigs?: EventChannelConfigMap;
  readonly clock?: Clock;
  readonly slowHandlerThresholdMs?: number;
  readonly onSlowHandler?: (context: SlowHandlerContext) => void;
  readonly frameExport?: RuntimeEventFrameExportOptions;
}

export interface Clock {
  now(): number;
}

export interface ChannelBackPressureSnapshot<
  TType extends RuntimeEventType = RuntimeEventType,
> {
  readonly type: TType;
  readonly channel: number;
  readonly capacity: number;
  readonly softLimit: number;
  readonly inUse: number;
  readonly remainingCapacity: number;
  readonly highWaterMark: number;
  readonly softLimitActive: boolean;
  readonly subscribers: number;
  readonly cooldownTicksRemaining: number;
  readonly softLimitBreaches: number;
  readonly eventsPerSecond: number;
}

export interface BackPressureCounters {
  published: number;
  softLimited: number;
  overflowed: number;
  subscribers: number;
}

export interface BackPressureSnapshot {
  readonly tick: number;
  readonly channels: readonly ChannelBackPressureSnapshot[];
  readonly counters: BackPressureCounters;
}

export class EventBufferOverflowError extends Error {
  readonly eventType: RuntimeEventType;
  readonly channel: number;
  readonly capacity: number;

  constructor(eventType: RuntimeEventType, channel: number, capacity: number) {
    super(
      `Event buffer overflow on channel ${channel} for ${eventType} (capacity ${capacity}).`,
    );
    this.name = 'EventBufferOverflowError';
    this.eventType = eventType;
    this.channel = channel;
    this.capacity = capacity;
  }
}

interface EventSlot<TType extends RuntimeEventType = RuntimeEventType> {
  type: TType;
  tick: number;
  issuedAt: number;
  payload: RuntimeEventPayload<TType>;
  dispatchOrder: number;
}

class EventSlotPool {
  private readonly pool: EventSlot[] = [];

  acquire<TType extends RuntimeEventType>(): EventSlot<TType> {
    const slot = this.pool.pop();

    if (slot !== undefined) {
      return slot as EventSlot<TType>;
    }

    return {
      type: '' as TType,
      tick: 0,
      issuedAt: 0,
      payload: undefined as unknown as RuntimeEventPayload<TType>,
      dispatchOrder: 0,
    };
  }

  release(slot: EventSlot): void {
    // Reset references to help GC before reusing the slot.
    slot.type = '' as RuntimeEventType;
    slot.tick = 0;
    slot.issuedAt = 0;
    slot.payload = undefined as unknown as RuntimeEventPayload<RuntimeEventType>;
    slot.dispatchOrder = 0;

    this.pool.push(slot);
  }
}

class EventBuffer {
  private readonly slots: EventSlot[] = [];
  private lengthValue = 0;

  constructor(
    private readonly pool: EventSlotPool,
    private readonly capacity: number,
  ) {}

  get length(): number {
    return this.lengthValue;
  }

  getCapacity(): number {
    return this.capacity;
  }

  isAtCapacity(): boolean {
    return this.lengthValue >= this.capacity;
  }

  push(slot: EventSlot): void {
    this.slots[this.lengthValue] = slot;
    this.lengthValue += 1;
  }

  at(index: number): EventSlot {
    if (index < 0 || index >= this.lengthValue) {
      throw new RangeError(`EventBuffer index ${index} is out of bounds (${this.lengthValue}).`);
    }
    return this.slots[index];
  }

  reset(): void {
    for (let index = 0; index < this.lengthValue; index += 1) {
      const slot = this.slots[index];
      this.pool.release(slot);
      // Clear the reference to allow GC before the slot is reused.
      this.slots[index] = undefined!;
    }
    this.lengthValue = 0;
  }
}

interface EventChannelDescriptor<TType extends RuntimeEventType = RuntimeEventType> {
  readonly index: number;
  readonly definition: RuntimeEventDefinition<TType>;
  readonly capacity: number;
  readonly softLimit: number;
  readonly diagnostics: EventDiagnosticsChannelConfig | null;
  readonly onSoftLimit?: (context: SoftLimitContext<TType>) => void;
}

class EventRegistry {
  private readonly descriptors: EventChannelDescriptor[];
  private readonly byType = new Map<RuntimeEventType, EventChannelDescriptor>();
  private readonly manifest: RuntimeEventManifest;
  private readonly manifestHash: RuntimeEventManifestHash;

  constructor(
    channels: ReadonlyArray<EventChannelConfiguration>,
    overrides: EventChannelConfigMap = {},
  ) {
    this.descriptors = channels.map((channelConfig, index) => {
      const override = overrides[channelConfig.definition.type];
      const capacity =
        override?.capacity ?? channelConfig.capacity ?? DEFAULT_CHANNEL_CAPACITY;
      if (!Number.isFinite(capacity) || capacity <= 0) {
        throw new Error(
          `Invalid capacity for channel ${channelConfig.definition.type}: ${capacity}.`,
        );
      }

      const resolvedSoftLimit =
        override?.softLimit ??
        channelConfig.softLimit ??
        Math.max(1, Math.floor(capacity * DEFAULT_SOFT_LIMIT_RATIO));

      if (!Number.isFinite(resolvedSoftLimit) || resolvedSoftLimit <= 0) {
        throw new Error(
          `Invalid soft limit for channel ${channelConfig.definition.type}: ${resolvedSoftLimit}.`,
        );
      }

      if (resolvedSoftLimit > capacity) {
        throw new Error(
          `Soft limit ${resolvedSoftLimit} exceeds capacity ${capacity} for channel ${channelConfig.definition.type}.`,
        );
      }

      const descriptor: EventChannelDescriptor = {
        index,
        definition: channelConfig.definition,
        capacity,
        softLimit: resolvedSoftLimit,
        diagnostics: resolveDiagnosticsConfig(
          channelConfig,
          override,
          resolvedSoftLimit,
        ),
        onSoftLimit: channelConfig.onSoftLimit,
      };

      const existing = this.byType.get(channelConfig.definition.type);
      if (existing !== undefined) {
        throw new Error(
          `Duplicate event type registered: ${channelConfig.definition.type} (${existing.index} vs ${index}).`,
        );
      }

      this.byType.set(channelConfig.definition.type, descriptor);
      return descriptor;
    });

    const entries: RuntimeEventManifestEntry[] = this.descriptors.map((descriptor) => ({
      type: descriptor.definition.type,
      channel: descriptor.index,
      version: descriptor.definition.version,
    }));

    this.manifest = {
      entries,
    };

    this.manifestHash = computeRuntimeEventManifestHash(this.manifest);
  }

  getDescriptor(type: RuntimeEventType): EventChannelDescriptor {
    const descriptor = this.byType.get(type);
    if (!descriptor) {
      throw new Error(`Unknown runtime event type: ${type}`);
    }
    return descriptor;
  }

  getDescriptors(): readonly EventChannelDescriptor[] {
    return this.descriptors;
  }

  getManifest(): RuntimeEventManifest {
    return this.manifest;
  }

  getManifestHash(): RuntimeEventManifestHash {
    return this.manifestHash;
  }
}

function resolveDiagnosticsConfig(
  channelConfig: EventChannelConfiguration,
  override: EventChannelConfigOverride | undefined,
  resolvedSoftLimit: number,
): EventDiagnosticsChannelConfig {
  const source = {
    ...(channelConfig.diagnostics ?? {}),
    ...(override?.diagnostics ?? {}),
  } as EventChannelDiagnosticsOptions;

  const resolvedMaxPerTick =
    source.maxEventsPerTick ?? resolvedSoftLimit;

  if (!Number.isFinite(resolvedMaxPerTick) || resolvedMaxPerTick <= 0) {
    throw new Error(
      `Invalid diagnostics maxEventsPerTick for channel ${channelConfig.definition.type}: ${resolvedMaxPerTick}.`,
    );
  }

  const maxEventsPerTick = Math.max(1, Math.floor(resolvedMaxPerTick));

  const computedMaxEventsPerSecond =
    source.maxEventsPerSecond ??
    maxEventsPerTick * DEFAULT_MAX_EVENTS_PER_SECOND_MULTIPLIER;

  const maxEventsPerSecond = Number.isFinite(computedMaxEventsPerSecond) &&
    computedMaxEventsPerSecond > 0
    ? computedMaxEventsPerSecond
    : undefined;

  const rawCooldownTicks =
    source.cooldownTicks ?? DEFAULT_DIAGNOSTIC_COOLDOWN_TICKS;

  if (!Number.isFinite(rawCooldownTicks) || rawCooldownTicks <= 0) {
    throw new Error(
      `Invalid diagnostics cooldownTicks for channel ${channelConfig.definition.type}: ${rawCooldownTicks}.`,
    );
  }

  const resolvedCooldownTicks = Math.max(1, Math.floor(rawCooldownTicks));

  const rawMaxCooldown =
    source.maxCooldownTicks ??
    resolvedCooldownTicks * DEFAULT_DIAGNOSTIC_MAX_COOLDOWN_MULTIPLIER;

  if (!Number.isFinite(rawMaxCooldown) || rawMaxCooldown <= 0) {
    throw new Error(
      `Invalid diagnostics maxCooldownTicks for channel ${channelConfig.definition.type}: ${rawMaxCooldown}.`,
    );
  }

  const maxCooldownTicks = Math.max(
    resolvedCooldownTicks,
    Math.floor(rawMaxCooldown),
  );

  return {
    maxEventsPerTick,
    maxEventsPerSecond,
    cooldownTicks: resolvedCooldownTicks,
    maxCooldownTicks,
  } satisfies EventDiagnosticsChannelConfig;
}

interface SubscriberRecord {
  readonly handler: EventHandler<RuntimeEventType>;
  active: boolean;
  readonly label?: string;
}

interface ChannelState {
  readonly descriptor: EventChannelDescriptor;
  readonly internalBuffer: EventBuffer;
  readonly outboundBuffer: EventBuffer;
  readonly subscribers: SubscriberRecord[];
  softLimitActive: boolean;
  currentOccupancy: number;
  highWaterMark: number;
}

export interface BeginTickOptions {
  readonly resetOutbound?: boolean;
}

export class EventBus implements EventPublisher {
  private readonly registry: EventRegistry;
  private readonly slotPool = new EventSlotPool();
  private readonly channelStates: ChannelState[];
  private readonly clock: Clock;
  private readonly slowHandlerThresholdMs: number;
  private readonly onSlowHandler?: (context: SlowHandlerContext) => void;
  private readonly diagnostics: EventDiagnostics | null;
  private readonly frameFormatController: RuntimeEventFrameFormatController;
  private telemetryCounters: BackPressureCounters = {
    published: 0,
    softLimited: 0,
    overflowed: 0,
    subscribers: 0,
  };

  private currentTick = 0;
  private dispatchCounter = 0;
  private eventsPublishedThisTick = 0;
  private firstTickPending = true;

  constructor(options: EventBusOptions) {
    if (options.channels.length === 0) {
      throw new Error('EventBus requires at least one channel configuration.');
    }

    this.registry = new EventRegistry(
      options.channels,
      options.channelConfigs,
    );
    this.channelStates = this.registry.getDescriptors().map((descriptor) => {
      return {
        descriptor,
        internalBuffer: new EventBuffer(this.slotPool, descriptor.capacity),
        outboundBuffer: new EventBuffer(this.slotPool, descriptor.capacity),
        subscribers: [],
        softLimitActive: false,
        currentOccupancy: 0,
        highWaterMark: 0,
      };
    });
    this.clock = options.clock ?? defaultClock;
    const diagnosticConfigs = this.registry
      .getDescriptors()
      .map((descriptor) => descriptor.diagnostics ?? null);
    this.diagnostics = diagnosticConfigs.some((config) => config !== null)
      ? new EventDiagnostics(diagnosticConfigs)
      : null;
    this.slowHandlerThresholdMs =
      typeof options.slowHandlerThresholdMs === 'number'
        ? Math.max(0, options.slowHandlerThresholdMs)
        : 2;
    this.onSlowHandler = options.onSlowHandler;
    this.frameFormatController = new RuntimeEventFrameFormatController(
      this.channelStates.length,
      options.frameExport,
    );
  }

  getManifest(): RuntimeEventManifest {
    return this.registry.getManifest();
  }

  getManifestHash(): RuntimeEventManifestHash {
    return this.registry.getManifestHash();
  }

  getFrameExportState(): RuntimeEventFrameExportState {
    return this.frameFormatController.getExportState();
  }

  beginTick(tick: number, options?: BeginTickOptions): void {
    const { resetOutbound = true } = options ?? {};
    const isSameTick = !this.firstTickPending && tick === this.currentTick;

    if (this.firstTickPending) {
      this.firstTickPending = false;
    } else if (!isSameTick) {
      this.frameFormatController.beginTick(this.eventsPublishedThisTick, tick);
    }

    if (!isSameTick) {
      this.eventsPublishedThisTick = 0;
    }

    this.currentTick = tick;
    this.dispatchCounter = 0;
    this.telemetryCounters = {
      published: 0,
      softLimited: 0,
      overflowed: 0,
      subscribers: 0,
    };
    this.diagnostics?.beginTick(tick);
    for (const channel of this.channelStates) {
      channel.internalBuffer.reset();
      if (resetOutbound) {
        channel.outboundBuffer.reset();
      }
      channel.softLimitActive = false;
      channel.currentOccupancy = 0;
      channel.highWaterMark = 0;
      this.compactSubscribers(channel);
    }
  }

  publish<TType extends RuntimeEventType>(
    eventType: TType,
    payload: RuntimeEventPayload<TType>,
    metadata?: PublishMetadata,
  ): PublishResult<TType> {
    const descriptor = this.registry.getDescriptor(eventType);
    const channel = this.channelStates[descriptor.index];

    if (channel.internalBuffer.isAtCapacity() || channel.outboundBuffer.isAtCapacity()) {
      const bufferOccupancy = Math.max(
        channel.internalBuffer.length,
        channel.outboundBuffer.length,
      );
      const remainingCapacity = Math.max(0, descriptor.capacity - bufferOccupancy);
      const softLimitActive =
        channel.softLimitActive || bufferOccupancy >= descriptor.softLimit;
      if (softLimitActive && !channel.softLimitActive) {
        channel.softLimitActive = true;
      }
      this.telemetryCounters.overflowed += 1;
      telemetry.recordWarning('EventBufferOverflow', {
        type: eventType,
        channel: descriptor.index,
        capacity: descriptor.capacity,
        tick: this.currentTick,
      });
      return {
        accepted: false,
        state: 'rejected',
        type: eventType,
        channel: descriptor.index,
        bufferSize: bufferOccupancy,
        remainingCapacity,
        dispatchOrder: this.dispatchCounter,
        softLimitActive,
      };
    }

    const timestamp = metadata?.issuedAt ?? this.clock.now();
    const dispatchOrder = this.dispatchCounter;
    this.dispatchCounter += 1;

    const validator = descriptor.definition
      .validator as ((value: RuntimeEventPayload<TType>) => void) | undefined;
    validator?.(payload);

    const internalSlot = this.slotPool.acquire<TType>();
    internalSlot.type = eventType;
    internalSlot.tick = this.currentTick;
    internalSlot.issuedAt = timestamp;
    internalSlot.payload = payload;
    internalSlot.dispatchOrder = dispatchOrder;
    channel.internalBuffer.push(internalSlot);

    const outboundSlot = this.slotPool.acquire<TType>();
    outboundSlot.type = eventType;
    outboundSlot.tick = this.currentTick;
    outboundSlot.issuedAt = timestamp;
    outboundSlot.payload = payload;
    outboundSlot.dispatchOrder = dispatchOrder;
    channel.outboundBuffer.push(outboundSlot);

    const bufferOccupancy = Math.max(
      channel.internalBuffer.length,
      channel.outboundBuffer.length,
    );
    const remainingCapacity = Math.max(0, descriptor.capacity - bufferOccupancy);
    channel.currentOccupancy = bufferOccupancy;
    channel.highWaterMark = Math.max(channel.highWaterMark, bufferOccupancy);
    this.telemetryCounters.published += 1;
    this.eventsPublishedThisTick += 1;
    this.diagnostics?.recordPublish(
      descriptor.index,
      this.currentTick,
      timestamp,
      eventType,
    );

    let state: PublishState = 'accepted';

    if (bufferOccupancy >= descriptor.softLimit) {
      state = 'soft-limit';
      this.telemetryCounters.softLimited += 1;
      if (!channel.softLimitActive) {
        channel.softLimitActive = true;
        descriptor.onSoftLimit?.({
          type: eventType,
          channel: descriptor.index,
          bufferSize: bufferOccupancy,
          capacity: descriptor.capacity,
          softLimit: descriptor.softLimit,
          remainingCapacity,
        });
        this.diagnostics?.handleSoftLimit({
          channel: descriptor.index,
          tick: this.currentTick,
          eventType,
          timestamp,
          reason: 'soft-limit',
          bufferSize: bufferOccupancy,
          capacity: descriptor.capacity,
          softLimit: descriptor.softLimit,
          remainingCapacity,
        });
      }
    }

    const accepted = state === 'accepted' || state === 'soft-limit';

    return {
      accepted,
      state,
      type: eventType,
      channel: descriptor.index,
      bufferSize: bufferOccupancy,
      remainingCapacity,
      dispatchOrder,
      softLimitActive: channel.softLimitActive,
    };
  }

  dispatch(context: EventDispatchContext): void {
    const cursors = new Array<number>(this.channelStates.length).fill(0);

    while (true) {
      let nextChannelIndex = -1;
      let nextSlot: EventSlot | undefined;

      for (let channelIndex = 0; channelIndex < this.channelStates.length; channelIndex += 1) {
        const channel = this.channelStates[channelIndex];
        const cursor = cursors[channelIndex];
        const buffer = channel.internalBuffer;

        if (cursor >= buffer.length) {
          continue;
        }

        const candidate = buffer.at(cursor);
        if (nextSlot === undefined || candidate.dispatchOrder < nextSlot.dispatchOrder) {
          nextSlot = candidate;
          nextChannelIndex = channelIndex;
        }
      }

      if (nextSlot === undefined || nextChannelIndex === -1) {
        break;
      }

      const channel = this.channelStates[nextChannelIndex];
      const event = createRuntimeEvent({
        type: nextSlot.type,
        tick: nextSlot.tick,
        issuedAt: nextSlot.issuedAt,
        payload: nextSlot.payload,
      } satisfies CreateRuntimeEventOptions<RuntimeEventType>);

      for (const subscriber of channel.subscribers) {
        if (!subscriber.active) {
          continue;
        }

        if (this.slowHandlerThresholdMs > 0) {
          const start = this.clock.now();
          try {
            subscriber.handler(event, context);
          } finally {
            const duration = this.clock.now() - start;
            if (duration > this.slowHandlerThresholdMs) {
              const slowContext: SlowHandlerContext = {
                type: event.type,
                channel: nextChannelIndex,
                tick: event.tick,
                dispatchOrder: nextSlot.dispatchOrder,
                durationMs: duration,
                thresholdMs: this.slowHandlerThresholdMs,
                handlerLabel: subscriber.label,
              };

              this.onSlowHandler?.(slowContext);
              telemetry.recordWarning('EventHandlerSlow', {
                eventType: event.type,
                channel: nextChannelIndex,
                tick: event.tick,
                dispatchOrder: nextSlot.dispatchOrder,
                durationMs: duration,
                thresholdMs: this.slowHandlerThresholdMs,
                handler: subscriber.label,
              });
            }
          }
        } else {
          subscriber.handler(event, context);
        }
      }

      cursors[nextChannelIndex] += 1;
    }

    for (const channel of this.channelStates) {
      channel.internalBuffer.reset();
      channel.currentOccupancy = 0;
    }
  }

  getBackPressureSnapshot(): BackPressureSnapshot {
    const channelSnapshots: ChannelBackPressureSnapshot[] =
      this.channelStates.map((channel) => {
        const activeSubscribers = channel.subscribers.reduce(
          (count, subscriber) => (subscriber.active ? count + 1 : count),
          0,
        );
        const remainingCapacity = Math.max(
          0,
          channel.descriptor.capacity - channel.currentOccupancy,
        );

        const diagnosticsSnapshot =
          this.diagnostics?.getChannelSnapshot(
            channel.descriptor.index,
            this.currentTick,
          ) ?? null;

        return {
          type: channel.descriptor.definition.type,
          channel: channel.descriptor.index,
          capacity: channel.descriptor.capacity,
          softLimit: channel.descriptor.softLimit,
          inUse: channel.currentOccupancy,
          remainingCapacity,
          highWaterMark: channel.highWaterMark,
          softLimitActive: channel.softLimitActive,
          subscribers: activeSubscribers,
          cooldownTicksRemaining:
            diagnosticsSnapshot?.cooldownTicksRemaining ?? 0,
          softLimitBreaches: diagnosticsSnapshot?.breaches ?? 0,
          eventsPerSecond: diagnosticsSnapshot?.eventsPerSecond ?? 0,
        };
      });

    const totalSubscribers = channelSnapshots.reduce(
      (count, snapshot) => count + snapshot.subscribers,
      0,
    );

    const counters: BackPressureCounters = {
      published: this.telemetryCounters.published,
      softLimited: this.telemetryCounters.softLimited,
      overflowed: this.telemetryCounters.overflowed,
      subscribers: totalSubscribers,
    };

    this.telemetryCounters = counters;

    return {
      tick: this.currentTick,
      channels: channelSnapshots,
      counters: { ...counters },
    };
  }

  on<TType extends RuntimeEventType>(
    eventType: TType,
    handler: EventHandler<TType>,
    options?: EventSubscriptionOptions,
  ): EventSubscription {
    const descriptor = this.registry.getDescriptor(eventType);
    const channel = this.channelStates[descriptor.index];

    const record: SubscriberRecord = {
      handler: handler as EventHandler<RuntimeEventType>,
      active: true,
      label: options?.label,
    };
    channel.subscribers.push(record);

    return {
      unsubscribe: () => {
        record.active = false;
      },
    };
  }

  getOutboundBuffer(channelIndex: number): OutboundEventBufferView {
    const channel = this.channelStates[channelIndex];
    if (!channel) {
      throw new Error(`Unknown channel index ${channelIndex}`);
    }
    const buffer = channel.outboundBuffer;

    return {
      get length() {
        return buffer.length;
      },
      at(index: number) {
        const slot = buffer.at(index);
        return {
          type: slot.type,
          tick: slot.tick,
          issuedAt: slot.issuedAt,
          payload: slot.payload,
          dispatchOrder: slot.dispatchOrder,
        };
      },
    };
  }

  private compactSubscribers(channel: ChannelState): void {
    if (channel.subscribers.length === 0) {
      return;
    }

    let writeIndex = 0;
    for (const record of channel.subscribers) {
      if (!record.active) {
        continue;
      }
      channel.subscribers[writeIndex] = record;
      writeIndex += 1;
    }

    channel.subscribers.length = writeIndex;
  }
}

const defaultClock: Clock = {
  now() {
    return performance.now();
  },
};
