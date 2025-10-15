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

const DEFAULT_CHANNEL_CAPACITY = 256;

export interface PublishMetadata {
  readonly issuedAt?: number;
}

export interface PublishResult<TType extends RuntimeEventType = RuntimeEventType> {
  readonly accepted: true;
  readonly type: TType;
  readonly channel: number;
  readonly bufferSize: number;
  readonly dispatchOrder: number;
  readonly softLimitTriggered: boolean;
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
  readonly onSoftLimit?: (context: SoftLimitContext<TType>) => void;
}

export interface SoftLimitContext<TType extends RuntimeEventType = RuntimeEventType> {
  readonly type: TType;
  readonly channel: number;
  readonly bufferSize: number;
  readonly capacity: number;
  readonly softLimit: number;
}

export interface EventBusOptions {
  readonly channels: ReadonlyArray<EventChannelConfiguration>;
  readonly clock?: Clock;
}

export interface Clock {
  now(): number;
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
  readonly softLimit?: number;
  readonly onSoftLimit?: (context: SoftLimitContext<TType>) => void;
}

class EventRegistry {
  private readonly descriptors: EventChannelDescriptor[];
  private readonly byType = new Map<RuntimeEventType, EventChannelDescriptor>();
  private readonly manifest: RuntimeEventManifest;
  private readonly manifestHash: RuntimeEventManifestHash;

  constructor(channels: ReadonlyArray<EventChannelConfiguration>) {
    this.descriptors = channels.map((channelConfig, index) => {
      const capacity = channelConfig.capacity ?? DEFAULT_CHANNEL_CAPACITY;
      const descriptor: EventChannelDescriptor = {
        index,
        definition: channelConfig.definition,
        capacity,
        softLimit: channelConfig.softLimit,
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

interface SubscriberRecord {
  readonly handler: EventHandler<RuntimeEventType>;
  active: boolean;
}

interface ChannelState {
  readonly descriptor: EventChannelDescriptor;
  readonly internalBuffer: EventBuffer;
  readonly outboundBuffer: EventBuffer;
  readonly subscribers: SubscriberRecord[];
  softLimitTriggered: boolean;
}

export class EventBus implements EventPublisher {
  private readonly registry: EventRegistry;
  private readonly slotPool = new EventSlotPool();
  private readonly channelStates: ChannelState[];
  private readonly clock: Clock;

  private currentTick = 0;
  private dispatchCounter = 0;

  constructor(options: EventBusOptions) {
    if (options.channels.length === 0) {
      throw new Error('EventBus requires at least one channel configuration.');
    }

    this.registry = new EventRegistry(options.channels);
    this.channelStates = this.registry.getDescriptors().map((descriptor) => {
      return {
        descriptor,
        internalBuffer: new EventBuffer(this.slotPool, descriptor.capacity),
        outboundBuffer: new EventBuffer(this.slotPool, descriptor.capacity),
        subscribers: [],
        softLimitTriggered: false,
      };
    });
    this.clock = options.clock ?? defaultClock;
  }

  getManifest(): RuntimeEventManifest {
    return this.registry.getManifest();
  }

  getManifestHash(): RuntimeEventManifestHash {
    return this.registry.getManifestHash();
  }

  beginTick(tick: number): void {
    this.currentTick = tick;
    this.dispatchCounter = 0;
    for (const channel of this.channelStates) {
      channel.internalBuffer.reset();
      channel.outboundBuffer.reset();
      channel.softLimitTriggered = false;
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
      throw new EventBufferOverflowError(eventType, descriptor.index, descriptor.capacity);
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

    const bufferSize = channel.internalBuffer.length;

    if (
      descriptor.softLimit !== undefined &&
      bufferSize >= descriptor.softLimit &&
      !channel.softLimitTriggered
    ) {
      channel.softLimitTriggered = true;
      descriptor.onSoftLimit?.({
        type: eventType,
        channel: descriptor.index,
        bufferSize,
        capacity: descriptor.capacity,
        softLimit: descriptor.softLimit,
      });
    }

    return {
      accepted: true,
      type: eventType,
      channel: descriptor.index,
      bufferSize,
      dispatchOrder,
      softLimitTriggered: channel.softLimitTriggered,
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

        subscriber.handler(event, context);
      }

      cursors[nextChannelIndex] += 1;
    }

    for (const channel of this.channelStates) {
      channel.internalBuffer.reset();
    }
  }

  on<TType extends RuntimeEventType>(
    eventType: TType,
    handler: EventHandler<TType>,
  ): EventSubscription {
    const descriptor = this.registry.getDescriptor(eventType);
    const channel = this.channelStates[descriptor.index];

    const record: SubscriberRecord = {
      handler: handler as EventHandler<RuntimeEventType>,
      active: true,
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
