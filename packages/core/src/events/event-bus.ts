import { telemetry } from '../telemetry.js';
import {
  areRuntimeEventGuardsEnabled,
  createRuntimeEventManifest,
  ensureRuntimeEventPayload,
  type RuntimeEvent,
  type RuntimeEventManifest,
  type RuntimeEventPayload,
  type RuntimeEventPayloadInput,
  type RuntimeEventPayloadValidator,
  type RuntimeEventType,
} from './runtime-event.js';

const DEFAULT_CHANNEL_CAPACITY = 256;
const DEFAULT_SOFT_LIMIT_RATIO = 0.8;
const TELEMETRY_OVERFLOW_EVENT = 'event-buffer-overflow';

export interface EventBusOptions {
  readonly now?: () => number;
  readonly defaultChannelCapacity?: number;
  readonly defaultSoftLimitRatio?: number;
  readonly onSoftLimitThreshold?: (info: EventSoftLimitInfo) => void;
}

export interface EventChannelRegistrationOptions<
  TType extends RuntimeEventType,
> {
  readonly capacity?: number;
  readonly softLimit?: number;
  readonly softLimitRatio?: number;
  readonly validator?: RuntimeEventPayloadValidator<TType>;
}

export interface EventSoftLimitInfo {
  readonly eventType: RuntimeEventType;
  readonly channelIndex: number;
  readonly capacity: number;
  readonly softLimit: number;
  readonly size: number;
  readonly tick: number;
}

export interface PublishResult<TType extends RuntimeEventType> {
  readonly eventType: TType;
  readonly channelIndex: number;
  readonly tick: number;
  readonly dispatchOrder: number;
  readonly size: number;
  readonly remainingCapacity: number;
  readonly softLimitTriggered: boolean;
}

export interface EventPublisher {
  publish<TType extends RuntimeEventType>(
    eventType: TType,
    payload: RuntimeEventPayloadInput<TType>,
  ): PublishResult<TType>;
}

export interface EventDispatchContext {
  readonly tick: number;
  readonly issuedAt?: number;
}

export type EventHandler<TType extends RuntimeEventType> = (
  event: RuntimeEvent<TType>,
  context: EventDispatchContext,
) => void;

export interface EventSubscription {
  unsubscribe(): void;
}

export interface EventSubscriptionHost {
  on<TType extends RuntimeEventType>(
    eventType: TType,
    handler: EventHandler<TType>,
  ): EventSubscription;
}

interface EventRegistryEntry {
  readonly type: RuntimeEventType;
  readonly channelIndex: number;
  readonly capacity: number;
  readonly softLimit: number;
  readonly validator?: RuntimeEventPayloadValidator<RuntimeEventType>;
}

interface EventChannelState {
  readonly entry: EventRegistryEntry;
  readonly buffer: EventBuffer;
  softLimitNotified: boolean;
}

interface EventBufferPushResult {
  readonly event: RuntimeEvent;
  readonly size: number;
}

export class EventBufferOverflowError extends Error {
  readonly eventType: RuntimeEventType;
  readonly capacity: number;

  constructor(eventType: RuntimeEventType, capacity: number) {
    super(
      `Event buffer capacity exceeded for "${eventType}" (${capacity} events)`,
    );
    this.name = 'EventBufferOverflowError';
    this.eventType = eventType;
    this.capacity = capacity;
  }
}

export class EventBus implements EventPublisher, EventSubscriptionHost {
  private readonly registry = new Map<RuntimeEventType, EventRegistryEntry>();
  private readonly channels: EventChannelState[] = [];
  private readonly subscribers = new SubscriberTable();
  private readonly now: () => number;
  private readonly onSoftLimitThreshold?: EventBusOptions['onSoftLimitThreshold'];
  private readonly defaultCapacity: number;
  private readonly defaultSoftLimitRatio: number;
  private activeTick: number | null = null;
  private nextDispatchOrder = 0;

  constructor(options: EventBusOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onSoftLimitThreshold = options.onSoftLimitThreshold;
    this.defaultCapacity =
      options.defaultChannelCapacity ?? DEFAULT_CHANNEL_CAPACITY;
    this.defaultSoftLimitRatio =
      options.defaultSoftLimitRatio ?? DEFAULT_SOFT_LIMIT_RATIO;
  }

  registerEventType<TType extends RuntimeEventType>(
    eventType: TType,
    options: EventChannelRegistrationOptions<TType> = {},
  ): void {
    if (this.registry.has(eventType)) {
      throw new Error(`Event type "${eventType}" is already registered`);
    }

    const channelIndex = this.channels.length;
    const capacity = this.resolveCapacity(options.capacity);
    const softLimit = this.resolveSoftLimit(capacity, options);
    const entry: EventRegistryEntry = {
      type: eventType,
      channelIndex,
      capacity,
      softLimit,
      validator: options.validator as RuntimeEventPayloadValidator<RuntimeEventType> | undefined,
    };
    const buffer = new EventBuffer(capacity);
    this.registry.set(eventType, entry);
    this.channels.push({
      entry,
      buffer,
      softLimitNotified: false,
    });
  }

  getPublisher(): EventPublisher {
    return new EventPublisherView(this);
  }

  getManifest(): RuntimeEventManifest {
    return createRuntimeEventManifest([...this.registry.keys()]);
  }

  startTick(tick: number): void {
    this.activeTick = tick;
    this.nextDispatchOrder = 0;
    for (const channel of this.channels) {
      channel.buffer.reset();
      channel.softLimitNotified = false;
    }
    this.subscribers.flushPending();
  }

  endTick(): void {
    this.activeTick = null;
    this.nextDispatchOrder = 0;
  }

  publish<TType extends RuntimeEventType>(
    eventType: TType,
    payload: RuntimeEventPayloadInput<TType>,
  ): PublishResult<TType> {
    if (this.activeTick === null) {
      throw new Error('EventBus.publish invoked before startTick');
    }

    const entry = this.registry.get(eventType);
    if (!entry) {
      throw new Error(`Unknown runtime event type "${eventType}"`);
    }

    entry.validator?.(payload as RuntimeEventPayloadInput<RuntimeEventType>);

    const channel = this.channels[entry.channelIndex];
    if (channel.buffer.size >= entry.capacity) {
      telemetry.recordWarning(TELEMETRY_OVERFLOW_EVENT, {
        eventType,
        capacity: entry.capacity,
        tick: this.activeTick,
      });
      throw new EventBufferOverflowError(eventType, entry.capacity);
    }

    const immutablePayload = ensureRuntimeEventPayload(payload);
    const dispatchedAt = this.now();
    const dispatchOrder = this.nextDispatchOrder;
    this.nextDispatchOrder += 1;
    const result = channel.buffer.push({
      type: eventType,
      tick: this.activeTick,
      issuedAt: dispatchedAt,
      dispatchOrder,
      payload: immutablePayload,
    });

    const softLimitTriggered = this.maybeNotifySoftLimit(channel, result.size);

    return {
      eventType,
      channelIndex: entry.channelIndex,
      tick: this.activeTick,
      dispatchOrder,
      size: result.size,
      remainingCapacity: entry.capacity - result.size,
      softLimitTriggered,
    };
  }

  on<TType extends RuntimeEventType>(
    eventType: TType,
    handler: EventHandler<TType>,
  ): EventSubscription {
    const entry = this.registry.get(eventType);
    if (!entry) {
      throw new Error(`Unknown runtime event type "${eventType}"`);
    }

    return this.subscribers.register(entry.channelIndex, handler as EventHandler<RuntimeEventType>);
  }

  dispatch(context: EventDispatchContext): void {
    if (this.activeTick === null) {
      return;
    }

    for (const channel of this.channels) {
      const { buffer, entry } = channel;
      let index = 0;
      while (index < buffer.size) {
        const event = buffer.get(index);
        this.subscribers.invoke(entry.channelIndex, event, context);
        index += 1;
      }
    }
  }

  forEachEvent(
    eventType: RuntimeEventType,
    visitor: (event: RuntimeEvent) => void,
  ): void {
    const entry = this.registry.get(eventType);
    if (!entry) {
      throw new Error(`Unknown runtime event type "${eventType}"`);
    }
    const buffer = this.channels[entry.channelIndex].buffer;
    for (let index = 0; index < buffer.size; index += 1) {
      visitor(buffer.get(index));
    }
  }

  getChannelSize(eventType: RuntimeEventType): number {
    const entry = this.registry.get(eventType);
    if (!entry) {
      throw new Error(`Unknown runtime event type "${eventType}"`);
    }
    return this.channels[entry.channelIndex].buffer.size;
  }

  private resolveCapacity(
    capacity: number | undefined,
  ): number {
    if (capacity === undefined) {
      return this.defaultCapacity;
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('Event channel capacity must be a positive integer');
    }
    return capacity;
  }

  private resolveSoftLimit(
    capacity: number,
    options: EventChannelRegistrationOptions<RuntimeEventType>,
  ): number {
    if (options.softLimit !== undefined) {
      if (
        !Number.isInteger(options.softLimit) ||
        options.softLimit < 1 ||
        options.softLimit > capacity
      ) {
        throw new Error(
          'Event channel soft limit must be an integer between 1 and the channel capacity',
        );
      }
      return options.softLimit;
    }

    const ratio =
      options.softLimitRatio ?? this.defaultSoftLimitRatio;
    const computed = Math.max(1, Math.floor(capacity * ratio));
    if (capacity === 1) {
      return 1;
    }
    return Math.min(capacity - 1, computed);
  }

  private maybeNotifySoftLimit(
    channel: EventChannelState,
    size: number,
  ): boolean {
    if (channel.softLimitNotified) {
      return false;
    }
    if (size < channel.entry.softLimit) {
      return false;
    }

    channel.softLimitNotified = true;
    const info: EventSoftLimitInfo = {
      eventType: channel.entry.type,
      channelIndex: channel.entry.channelIndex,
      capacity: channel.entry.capacity,
      softLimit: channel.entry.softLimit,
      size,
      tick: this.activeTick ?? 0,
    };
    this.onSoftLimitThreshold?.(info);
    return true;
  }
}

class EventPublisherView implements EventPublisher {
  constructor(private readonly bus: EventBus) {}

  publish<TType extends RuntimeEventType>(
    eventType: TType,
    payload: RuntimeEventPayloadInput<TType>,
  ): PublishResult<TType> {
    return this.bus.publish(eventType, payload);
  }
}

type RuntimeEventPayloadUnion = RuntimeEventPayload<RuntimeEventType>;

interface MutableRuntimeEventSlot {
  type: RuntimeEventType;
  tick: number;
  issuedAt: number;
  dispatchOrder: number;
  payload: RuntimeEventPayloadUnion;
  view: RuntimeEvent;
}

class EventBuffer {
  private readonly slots: MutableRuntimeEventSlot[];
  private readonly views: RuntimeEvent[];
  size = 0;

  constructor(capacity: number) {
    this.slots = [];
    this.views = [];
    for (let index = 0; index < capacity; index += 1) {
      const slot: MutableRuntimeEventSlot = {
        type: '' as RuntimeEventType,
        tick: 0,
        issuedAt: 0,
        dispatchOrder: 0,
        payload: undefined as unknown as RuntimeEventPayloadUnion,
        view: undefined as unknown as RuntimeEvent,
      };
      const view = createRuntimeEventView(slot);
      slot.view = view;
      this.slots.push(slot);
      this.views.push(view);
    }
  }

  push(draft: {
    type: RuntimeEventType;
    tick: number;
    issuedAt: number;
    dispatchOrder: number;
    payload: RuntimeEventPayloadUnion;
  }): EventBufferPushResult {
    const slot = this.slots[this.size];
    slot.type = draft.type;
    slot.tick = draft.tick;
    slot.issuedAt = draft.issuedAt;
    slot.dispatchOrder = draft.dispatchOrder;
    slot.payload = draft.payload;
    const event = slot.view;
    this.size += 1;
    return {
      event,
      size: this.size,
    };
  }

  get(index: number): RuntimeEvent {
    return this.views[index];
  }

  reset(): void {
    this.size = 0;
  }
}

class SubscriberTable {
  private readonly table = new Map<number, HandlerRecord[]>();
  private readonly pendingCleanup = new Set<number>();

  register(
    channelIndex: number,
    handler: EventHandler<RuntimeEventType>,
  ): EventSubscription {
    const handlers = this.table.get(channelIndex) ?? [];
    const record: HandlerRecord = {
      handler,
      active: true,
    };
    handlers.push(record);
    this.table.set(channelIndex, handlers);

    return {
      unsubscribe: () => {
        if (!record.active) {
          return;
        }
        record.active = false;
        this.pendingCleanup.add(channelIndex);
      },
    };
  }

  invoke(
    channelIndex: number,
    event: RuntimeEvent,
    context: EventDispatchContext,
  ): void {
    const handlers = this.table.get(channelIndex);
    if (!handlers) {
      return;
    }
    for (const record of handlers) {
      if (!record.active) {
        continue;
      }
      record.handler(event, context);
    }
  }

  flushPending(): void {
    for (const channelIndex of this.pendingCleanup) {
      const handlers = this.table.get(channelIndex);
      if (!handlers) {
        continue;
      }
      const activeHandlers = handlers.filter(
        (record) => record.active,
      );
      if (activeHandlers.length === 0) {
        this.table.delete(channelIndex);
      } else {
        this.table.set(channelIndex, activeHandlers);
      }
    }
    this.pendingCleanup.clear();
  }
}

interface HandlerRecord {
  readonly handler: EventHandler<RuntimeEventType>;
  active: boolean;
}

function createRuntimeEventView(slot: MutableRuntimeEventSlot): RuntimeEvent {
  const view: Record<PropertyKey, unknown> = {};

  Object.defineProperties(view, {
    type: {
      enumerable: true,
      get: () => slot.type,
    },
    tick: {
      enumerable: true,
      get: () => slot.tick,
    },
    issuedAt: {
      enumerable: true,
      get: () => slot.issuedAt,
    },
    dispatchOrder: {
      enumerable: true,
      get: () => slot.dispatchOrder,
    },
    payload: {
      enumerable: true,
      get: () => slot.payload,
    },
  });

  if (areRuntimeEventGuardsEnabled()) {
    Object.freeze(view);
  }

  return view as unknown as RuntimeEvent;
}
