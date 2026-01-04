import type {
  Command,
  CommandQueueEntry,
  CommandSnapshot,
  ImmutablePayload,
} from './command.js';
import { CommandPriority, COMMAND_PRIORITY_ORDER } from './command.js';
import { authorizeCommand } from './command-authorization.js';
import type {
  ImmutableArrayBufferSnapshot,
  ImmutableMapSnapshot,
  ImmutableSetSnapshot,
  ImmutableSharedArrayBufferSnapshot,
  TypedArray,
} from './immutable-snapshots.js';
import { telemetry } from './telemetry.js';

/**
 * Queue implementation that maintains per-priority FIFO lanes as documented in
 * docs/runtime-command-queue-design.md §4.2.
 *
 * Commands are cloned on enqueue to preserve determinism and to prevent
 * call-sites from mutating queued payloads.
 */
type SnapshotQueueEntry = CommandQueueEntry<CommandSnapshot<unknown>>;

export const DEFAULT_MAX_QUEUE_SIZE = 10_000;

export interface CommandQueueOptions {
  readonly maxSize?: number;
}

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export const COMMAND_QUEUE_SAVE_SCHEMA_VERSION = 1;

export type SerializedCommandQueueEntryV1 = Readonly<{
  readonly type: string;
  readonly priority: CommandPriority;
  readonly timestamp: number;
  readonly step: number;
  readonly payload: JsonValue;
}>;

export type SerializedCommandQueueV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly entries: readonly SerializedCommandQueueEntryV1[];
}>;

export type SerializedCommandQueue = SerializedCommandQueueV1;

export interface RestoreCommandQueueOptions {
  /**
   * Optional predicate for skipping command types that are not supported by the
   * current runtime (forward-compatibility).
   */
  readonly isCommandTypeSupported?: (type: string) => boolean;
  /**
   * Optional step rebasing information for restores that reset the runtime step
   * counter (e.g., worker restore). When provided, each command's `step` is
   * shifted by `currentStep - savedStep`.
   */
  readonly rebaseStep?: Readonly<{
    readonly savedStep: number;
    readonly currentStep: number;
  }>;
}

export class CommandQueue {
  private readonly lanes = new Map<CommandPriority, SnapshotQueueEntry[]>([
    [CommandPriority.SYSTEM, []],
    [CommandPriority.PLAYER, []],
    [CommandPriority.AUTOMATION, []],
  ]);

  private nextSequence = 0;
  private totalSize = 0;
  private readonly maxSize: number;

  constructor(options: CommandQueueOptions = {}) {
    const configuredSize = options.maxSize ?? DEFAULT_MAX_QUEUE_SIZE;
    if (!Number.isFinite(configuredSize) || configuredSize <= 0) {
      throw new Error('maxSize must be a positive finite number');
    }
    this.maxSize = configuredSize;
  }

  enqueue(command: Command): void {
    if (!authorizeCommand(command, { phase: 'live', reason: 'queue' })) {
      return;
    }

    const queue = this.lanes.get(command.priority);
    if (!queue) {
      throw new Error(`Invalid command priority: ${command.priority}`);
    }

    if (this.totalSize >= this.maxSize) {
      telemetry.recordWarning('CommandQueueOverflow', {
        size: this.totalSize,
        maxSize: this.maxSize,
        priority: command.priority,
      });
      const dropped = this.dropLowestPriorityUpTo(command.priority);
      if (!dropped) {
        telemetry.recordWarning('CommandRejected', {
          type: command.type,
          priority: command.priority,
          timestamp: command.timestamp,
          size: this.totalSize,
          maxSize: this.maxSize,
        });
        return;
      }
    }

    const entry: SnapshotQueueEntry = {
      command: cloneCommand(command) as CommandSnapshot<unknown>,
      sequence: this.nextSequence++,
    };

    // Deterministic insertion by timestamp, then sequence as a stable tie-breaker.
    let low = 0;
    let high = queue.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const other = queue[mid];
      if (
        other.command.timestamp < entry.command.timestamp ||
        (other.command.timestamp === entry.command.timestamp &&
          other.sequence < entry.sequence)
      ) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    queue.splice(low, 0, entry);
    this.totalSize += 1;
  }

  dequeueAll(): CommandSnapshot<unknown>[] {
    return this.dequeueUpToStep(Number.POSITIVE_INFINITY);
  }

  dequeueUpToStep(step: number): CommandSnapshot<unknown>[] {
    if (this.totalSize === 0) {
      return [];
    }

    const drained: CommandSnapshot[] = [];
    let drainedCount = 0;

    for (const priority of COMMAND_PRIORITY_ORDER) {
      const queue = this.lanes.get(priority);
      if (!queue || queue.length === 0) {
        continue;
      }

      let writeIndex = 0;
      for (let readIndex = 0; readIndex < queue.length; readIndex += 1) {
        const entry = queue[readIndex];
        if (entry.command.step <= step) {
          drained.push(entry.command);
          drainedCount += 1;
          continue;
        }

        if (writeIndex !== readIndex) {
          queue[writeIndex] = entry;
        }
        writeIndex += 1;
      }

      if (writeIndex === 0) {
        queue.length = 0;
      } else if (writeIndex < queue.length) {
        queue.length = writeIndex;
      }
    }

    this.totalSize -= drainedCount;
    return drained;
  }

  clear(): void {
    if (this.totalSize === 0) {
      return;
    }
    for (const queue of this.lanes.values()) {
      this.totalSize -= queue.length;
      queue.length = 0;
    }
    this.totalSize = 0;
  }

  get size(): number {
    return this.totalSize;
  }

  exportForSave(): SerializedCommandQueueV1 {
    const entries: SerializedCommandQueueEntryV1[] = [];
    if (this.totalSize === 0) {
      return {
        schemaVersion: COMMAND_QUEUE_SAVE_SCHEMA_VERSION,
        entries,
      };
    }

    for (const priority of COMMAND_PRIORITY_ORDER) {
      const queue = this.lanes.get(priority);
      if (!queue || queue.length === 0) {
        continue;
      }

      for (const entry of queue) {
        const command = entry.command;
        try {
          entries.push({
            type: command.type,
            priority: command.priority,
            timestamp: command.timestamp,
            step: command.step,
            payload: cloneJsonValue(command.payload),
          });
        } catch (error) {
          telemetry.recordWarning('CommandQueueSnapshotSkipped', {
            type: command.type,
            priority: command.priority,
            step: command.step,
            timestamp: command.timestamp,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return {
      schemaVersion: COMMAND_QUEUE_SAVE_SCHEMA_VERSION,
      entries,
    };
  }

  restoreFromSave(
    serialized: SerializedCommandQueue | undefined,
    options: RestoreCommandQueueOptions = {},
  ): { restored: number; skipped: number } {
    this.clear();

    if (!serialized) {
      return { restored: 0, skipped: 0 };
    }

    if (
      typeof serialized !== 'object' ||
      serialized === null ||
      (serialized as { schemaVersion?: unknown }).schemaVersion !==
        COMMAND_QUEUE_SAVE_SCHEMA_VERSION
    ) {
      telemetry.recordWarning('CommandQueueRestoreUnsupportedSchema', {
        schemaVersion:
          serialized && typeof serialized === 'object'
            ? (serialized as { schemaVersion?: unknown }).schemaVersion
            : null,
      });
      return { restored: 0, skipped: 0 };
    }

    const entriesValue = (serialized as { entries?: unknown }).entries;
    const entries: readonly unknown[] = Array.isArray(entriesValue)
      ? entriesValue
      : [];

    let restored = 0;
    let skipped = 0;

    for (const entry of entries) {
      const command = normalizeSerializedCommandEntry(entry, options);
      if (!command) {
        skipped += 1;
        continue;
      }

      if (options.isCommandTypeSupported && !options.isCommandTypeSupported(command.type)) {
        skipped += 1;
        continue;
      }

      const sizeBefore = this.totalSize;
      this.enqueue(command);
      if (this.totalSize > sizeBefore) {
        restored += 1;
      } else {
        skipped += 1;
      }
    }

    return { restored, skipped };
  }

  private dropLowestPriorityUpTo(maxPriority: CommandPriority): boolean {
    for (let index = COMMAND_PRIORITY_ORDER.length - 1; index >= 0; index -= 1) {
      const priority = COMMAND_PRIORITY_ORDER[index];
      if (priority < maxPriority) {
        continue;
      }
      const queue = this.lanes.get(priority);
      if (!queue || queue.length === 0) {
        continue;
      }

      const dropped = queue.shift();
      if (!dropped) {
        continue;
      }

      this.totalSize -= 1;
      telemetry.recordWarning('CommandDropped', {
        type: dropped.command.type,
        priority,
        timestamp: dropped.command.timestamp,
      });
      return true;
    }
    return false;
  }
}

function normalizeSerializedCommandEntry(
  entry: unknown,
  options: RestoreCommandQueueOptions,
): Command | undefined {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }

  const record = entry as Record<string, unknown>;

  const type = record.type;
  if (typeof type !== 'string' || type.trim().length === 0) {
    return undefined;
  }

  const priority = record.priority;
  if (
    typeof priority !== 'number' ||
    !Number.isFinite(priority) ||
    !Object.values(CommandPriority).includes(priority as CommandPriority)
  ) {
    return undefined;
  }

  const timestamp = record.timestamp;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return undefined;
  }

  const step = record.step;
  if (
    typeof step !== 'number' ||
    !Number.isFinite(step) ||
    !Number.isInteger(step) ||
    step < 0
  ) {
    return undefined;
  }

  let normalizedPayload: JsonValue;
  try {
    normalizedPayload = cloneJsonValue(record.payload);
  } catch {
    return undefined;
  }

  const rebase = options.rebaseStep;
  const rebasedStep =
    rebase &&
    typeof rebase.savedStep === 'number' &&
    Number.isFinite(rebase.savedStep) &&
    typeof rebase.currentStep === 'number' &&
    Number.isFinite(rebase.currentStep)
      ? Math.max(0, step + (rebase.currentStep - rebase.savedStep))
      : step;

  return {
    type,
    priority: priority as CommandPriority,
    payload: normalizedPayload,
    timestamp,
    step: rebasedStep,
  };
}

function cloneJsonValue(value: unknown): JsonValue {
  const seen = new WeakSet<object>();
  return cloneJsonValueInner(value, seen);
}

function cloneJsonValueInner(
  value: unknown,
  seen: WeakSet<object>,
): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('Command payload contains non-finite number');
      }
      return value;
    case 'object':
      break;
    default:
      throw new Error(
        `Command payload contains unsupported JSON type: ${typeof value}`,
      );
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error('Command payload contains a circular reference');
    }
    seen.add(value);
    const cloned = value.map((entry) => cloneJsonValueInner(entry, seen));
    seen.delete(value);
    return cloned;
  }

  if (seen.has(value as object)) {
    throw new Error('Command payload contains a circular reference');
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('Command payload must be a plain JSON object');
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('Command payload contains symbol keys');
  }

  seen.add(value as object);
  const record = value as Record<string, unknown>;
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (entry === undefined) {
      throw new Error('Command payload contains undefined value');
    }
    result[key] = cloneJsonValueInner(entry, seen);
  }
  seen.delete(value as object);
  return result;
}

const MAP_MUTATORS = new Set<PropertyKey>(['set', 'delete', 'clear']);
const SET_MUTATORS = new Set<PropertyKey>(['add', 'delete', 'clear']);
const TYPED_ARRAY_MUTATORS = new Set<PropertyKey>([
  'copyWithin',
  'fill',
  'reverse',
  'set',
  'sort',
]);
const TYPED_ARRAY_CALLBACK_METHODS = new Set<PropertyKey>([
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
]);
const DATAVIEW_MUTATORS = new Set<PropertyKey>([
  'setInt8',
  'setUint8',
  'setInt16',
  'setUint16',
  'setInt32',
  'setUint32',
  'setBigInt64',
  'setBigUint64',
  'setFloat32',
  'setFloat64',
]);

type SharedArrayBufferCtor = new (byteLength: number) => SharedArrayBuffer;

const sharedArrayBufferCtor = (globalThis as {
  SharedArrayBuffer?: SharedArrayBufferCtor;
}).SharedArrayBuffer;

/**
 * Produce a deeply immutable snapshot of a structured cloned value. The returned
 * graph maintains referential identity while replacing Maps/Sets/Dates/TypedArrays
 * with read-only proxies that throw on mutation.
 */
export function deepFreezeInPlace<T>(value: T): ImmutablePayload<T> {
  const seen = new WeakMap<object, unknown>();
  return enforceImmutable(value, seen) as ImmutablePayload<T>;
}

function enforceImmutable(node: unknown, seen: WeakMap<object, unknown>): unknown {
  if (!node || typeof node !== 'object') {
    return node;
  }

  const cached = seen.get(node);
  if (cached) {
    return cached;
  }

  if (node instanceof Map) {
    return makeImmutableMap(node, seen);
  }

  if (node instanceof Set) {
    return makeImmutableSet(node, seen);
  }

  if (node instanceof Date) {
    return makeImmutableDate(node, seen);
  }

  if (node instanceof ArrayBuffer) {
    return makeImmutableArrayBuffer(node, seen);
  }

  if (
    typeof sharedArrayBufferCtor === 'function' &&
    node instanceof sharedArrayBufferCtor
  ) {
    return makeImmutableSharedArrayBuffer(node, seen);
  }

  if (node instanceof RegExp) {
    return makeImmutableRegExp(node, seen);
  }

  if (ArrayBuffer.isView(node)) {
    return makeImmutableView(node, seen);
  }

  return makeImmutableObject(node as Record<PropertyKey, unknown>, seen);
}

function makeImmutableMap<K, V>(
  source: Map<K, V>,
  seen: WeakMap<object, unknown>,
): ImmutableMapSnapshot<ImmutablePayload<K>, ImmutablePayload<V>> {
  const safeMap = new Map<ImmutablePayload<K>, ImmutablePayload<V>>();
  const proxy = new Proxy(
    safeMap,
    createMapMutationGuard<ImmutablePayload<K>, ImmutablePayload<V>>(),
  );
  seen.set(source, proxy);

  for (const [key, value] of source.entries()) {
    const immutableKey = enforceImmutable(key, seen) as ImmutablePayload<K>;
    const immutableValue = enforceImmutable(
      value,
      seen,
    ) as ImmutablePayload<V>;
    safeMap.set(immutableKey, immutableValue);
  }

  return proxy as ImmutableMapSnapshot<
    ImmutablePayload<K>,
    ImmutablePayload<V>
  >;
}

function makeImmutableSet<T>(
  source: Set<T>,
  seen: WeakMap<object, unknown>,
): ImmutableSetSnapshot<ImmutablePayload<T>> {
  const safeSet = new Set<ImmutablePayload<T>>();
  const proxy = new Proxy(
    safeSet,
    createSetMutationGuard<ImmutablePayload<T>>(),
  );
  seen.set(source, proxy);

  for (const item of source.values()) {
    const immutableItem = enforceImmutable(item, seen) as ImmutablePayload<T>;
    safeSet.add(immutableItem);
  }

  return proxy as ImmutableSetSnapshot<ImmutablePayload<T>>;
}

function makeImmutableDate(
  source: Date,
  seen: WeakMap<object, unknown>,
): Date {
  const safeDate = new Date(source.getTime());
  const proxy = new Proxy(safeDate, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop.startsWith("set")) {
        return () => {
          throw new TypeError('Cannot mutate immutable Date snapshot');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set() {
      throw new TypeError('Cannot mutate immutable Date snapshot');
    },
    defineProperty() {
      throw new TypeError('Cannot mutate immutable Date snapshot');
    },
    deleteProperty() {
      throw new TypeError('Cannot mutate immutable Date snapshot');
    },
  });
  seen.set(source, proxy);
  return proxy;
}

function makeImmutableArrayBuffer(
  source: ArrayBuffer,
  seen: WeakMap<object, unknown>,
): ImmutableArrayBufferSnapshot {
  const clone = source.slice(0);
  const snapshot = createImmutableArrayBufferSnapshot(clone);
  seen.set(source, snapshot);
  return snapshot;
}

function makeImmutableSharedArrayBuffer(
  source: SharedArrayBuffer,
  seen: WeakMap<object, unknown>,
): ImmutableSharedArrayBufferSnapshot {
  if (typeof sharedArrayBufferCtor !== 'function') {
    throw new Error('SharedArrayBuffer is not supported in this environment.');
  }

  const clone = new sharedArrayBufferCtor(source.byteLength);
  new Uint8Array(clone).set(new Uint8Array(source));
  const snapshot = createImmutableSharedArrayBufferSnapshot(clone);
  seen.set(source, snapshot);
  return snapshot;
}

function makeImmutableRegExp(
  source: RegExp,
  seen: WeakMap<object, unknown>,
): RegExp {
  const clone = new RegExp(source.source, source.flags);
  clone.lastIndex = source.lastIndex;
  seen.set(source, clone);
  return clone;
}

function makeImmutableView(
  source: ArrayBufferView,
  seen: WeakMap<object, unknown>,
): ArrayBufferView {
  let safeView: ArrayBufferView;

  if (source instanceof DataView) {
    const bufferClone = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    );
    safeView = new DataView(bufferClone, 0, source.byteLength);
  } else {
    const typedSource = source as TypedArray;
    const TypedArrayCtor = typedSource.constructor as {
      new (
        buffer: ArrayBufferLike,
        byteOffset?: number,
        length?: number,
      ): ArrayBufferView;
      new (
        input:
          | ArrayBufferView
          | ArrayLike<unknown>
          | Iterable<unknown>,
      ): ArrayBufferView;
    };
    if (
      typeof sharedArrayBufferCtor === 'function' &&
      typedSource.buffer instanceof sharedArrayBufferCtor
    ) {
      const sharedClone = cloneSharedArrayBuffer(typedSource.buffer);
      safeView = new TypedArrayCtor(
        sharedClone,
        typedSource.byteOffset,
        typedSource.length,
      );
    } else {
      const arrayClone = typedSource.buffer.slice(
        typedSource.byteOffset,
        typedSource.byteOffset + typedSource.byteLength,
      );
      safeView = new TypedArrayCtor(arrayClone);
    }
  }

  const proxy = new Proxy(safeView, createViewGuard(source, seen));
  seen.set(source, proxy);
  return proxy;
}

function createMapMutationGuard<K, V>(): ProxyHandler<Map<K, V>> {
  return {
    get(target, prop, receiver) {
      if (prop === 'valueOf') {
        return () => receiver;
      }

      if (prop === 'forEach') {
        const original = target.forEach;
        return (
          callback: Parameters<Map<K, V>['forEach']>[0],
          thisArg?: unknown,
        ) => {
          if (typeof callback !== 'function') {
            return original.call(target, callback, thisArg);
          }
          return original.call(
            target,
            (value, key) => {
              callback.call(thisArg, value, key, receiver);
            },
            thisArg,
          );
        };
      }

      if (MAP_MUTATORS.has(prop)) {
        return () => {
          throw new TypeError('Cannot mutate immutable Map snapshot');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set() {
      throw new TypeError('Cannot mutate immutable Map snapshot');
    },
    defineProperty() {
      throw new TypeError('Cannot mutate immutable Map snapshot');
    },
    deleteProperty() {
      throw new TypeError('Cannot mutate immutable Map snapshot');
    },
  };
}

function createSetMutationGuard<V>(): ProxyHandler<Set<V>> {
  return {
    get(target, prop, receiver) {
      if (prop === 'valueOf') {
        return () => receiver;
      }

      if (prop === 'forEach') {
        const original = target.forEach;
        return (
          callback: Parameters<Set<V>['forEach']>[0],
          thisArg?: unknown,
        ) => {
          if (typeof callback !== 'function') {
            return original.call(target, callback, thisArg);
          }
          return original.call(
            target,
            (value, sameValue) => {
              callback.call(thisArg, value, sameValue, receiver);
            },
            thisArg,
          );
        };
      }

      if (SET_MUTATORS.has(prop)) {
        return () => {
          throw new TypeError('Cannot mutate immutable Set snapshot');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set() {
      throw new TypeError('Cannot mutate immutable Set snapshot');
    },
    defineProperty() {
      throw new TypeError('Cannot mutate immutable Set snapshot');
    },
    deleteProperty() {
      throw new TypeError('Cannot mutate immutable Set snapshot');
    },
  };
}

function makeImmutableObject(
  source: Record<PropertyKey, unknown>,
  seen: WeakMap<object, unknown>,
): Record<PropertyKey, unknown> {
  const proto = Object.getPrototypeOf(source);
  const clonePrototype = proto === null ? null : proto;
  const clone = Array.isArray(source)
    ? []
    : Object.create(clonePrototype);

  seen.set(source, clone);

  const keys: PropertyKey[] = [
    ...Object.getOwnPropertyNames(source),
    ...Object.getOwnPropertySymbols(source),
  ];

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;

    if ('value' in descriptor) {
      descriptor.value = enforceImmutable(descriptor.value, seen);
    }

    Object.defineProperty(clone, key, descriptor);
  }

  Object.freeze(clone);
  return clone;
}

function createViewGuard(
  source: ArrayBufferView,
  seen: WeakMap<object, unknown>,
): ProxyHandler<ArrayBufferView> {
  const isDataView = source instanceof DataView;
  const typeName = isDataView
    ? 'DataView'
    : source.constructor.name || 'TypedArray';

  return {
    get(target, prop, receiver) {
      if (prop === 'buffer') {
        const buffer = target.buffer;
        if (buffer instanceof ArrayBuffer) {
          return makeImmutableArrayBuffer(buffer, seen);
        }
        if (
          typeof sharedArrayBufferCtor === 'function' &&
          buffer instanceof sharedArrayBufferCtor
        ) {
          return makeImmutableSharedArrayBuffer(buffer, seen);
        }
        return buffer;
      }

      if (prop === 'valueOf') {
        return () => receiver;
      }

      if (
        isDataView &&
        (prop === 'byteOffset' || prop === 'byteLength')
      ) {
        return Reflect.get(target, prop, target);
      }

      if (
        typeof prop === 'string' &&
        TYPED_ARRAY_CALLBACK_METHODS.has(prop) &&
        !isDataView
      ) {
          const original = Reflect.get(target as object, prop, receiver);
          if (typeof original === 'function') {
            const originalInvoker = original as (
              this: typeof target,
              ...callbackArgs: unknown[]
          ) => unknown;
          return (...args: unknown[]) => {
            const [callback, ...rest] = args;
            if (typeof callback !== 'function') {
              return originalInvoker.call(target, callback, ...rest);
            }
            const wrappedCallback = function (
              this: unknown,
              ...callbackArgs: unknown[]
            ) {
              if (callbackArgs.length > 0) {
                callbackArgs[callbackArgs.length - 1] = receiver;
              }
              const actualCallback = callback as (
                this: unknown,
                ...innerArgs: unknown[]
              ) => unknown;
              return actualCallback.apply(this, callbackArgs);
            };
            const result = originalInvoker.call(target, wrappedCallback, ...rest);
            if (
              ArrayBuffer.isView(result) &&
              !(result instanceof DataView)
            ) {
              return makeImmutableView(result, seen);
            }
            return result;
          };
        }
      }

      if (!isDataView && prop === 'subarray') {
        return (...args: unknown[]) => {
          const typedTarget = target as unknown as {
            subarray: (...params: unknown[]) => ArrayBufferView;
          };
          const result = typedTarget.subarray(...args);
          return makeImmutableView(result, seen);
        };
      }

      if (typeof prop === 'string') {
        if (
          (isDataView && DATAVIEW_MUTATORS.has(prop)) ||
          (!isDataView && TYPED_ARRAY_MUTATORS.has(prop))
        ) {
          return () => {
            throw new TypeError(`Cannot mutate immutable ${typeName} snapshot`);
          };
        }
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set() {
      throw new TypeError(`Cannot mutate immutable ${typeName} snapshot`);
    },
    defineProperty() {
      throw new TypeError(`Cannot mutate immutable ${typeName} snapshot`);
    },
    deleteProperty() {
      throw new TypeError(`Cannot mutate immutable ${typeName} snapshot`);
    },
  };
}

function createImmutableArrayBufferSnapshot(
  buffer: ArrayBuffer,
): ImmutableArrayBufferSnapshot {
  const backing = buffer;
  const snapshot: ImmutableArrayBufferSnapshot = {
    get byteLength() {
      return backing.byteLength;
    },
    slice(begin?: number, end?: number) {
      const sliced = backing.slice(begin ?? 0, end ?? backing.byteLength);
      return createImmutableArrayBufferSnapshot(sliced);
    },
    toArrayBuffer() {
      return backing.slice(0);
    },
    toDataView() {
      return new DataView(backing.slice(0));
    },
    toUint8Array() {
      return new Uint8Array(backing.slice(0));
    },
    valueOf() {
      return backing.slice(0);
    },
    [Symbol.toStringTag]: 'ImmutableArrayBufferSnapshot',
  };

  return Object.freeze(snapshot);
}

function createImmutableSharedArrayBufferSnapshot(
  buffer: SharedArrayBuffer,
): ImmutableSharedArrayBufferSnapshot {
  if (typeof sharedArrayBufferCtor !== 'function') {
    throw new Error('SharedArrayBuffer is not supported in this environment.');
  }

  const backing = buffer;
  const snapshot: ImmutableSharedArrayBufferSnapshot = {
    get byteLength() {
      return backing.byteLength;
    },
    slice(begin?: number, end?: number) {
      const sliced = sliceSharedArrayBuffer(backing, begin, end);
      return createImmutableSharedArrayBufferSnapshot(sliced);
    },
    toSharedArrayBuffer() {
      return cloneSharedArrayBuffer(backing);
    },
    toArrayBuffer() {
      return sharedArrayBufferToArrayBuffer(backing);
    },
    toDataView() {
      return new DataView(sharedArrayBufferToArrayBuffer(backing));
    },
    toUint8Array() {
      return new Uint8Array(sharedArrayBufferToArrayBuffer(backing));
    },
    valueOf() {
      return this.toSharedArrayBuffer();
    },
    [Symbol.toStringTag]: 'ImmutableSharedArrayBufferSnapshot',
  };

  return Object.freeze(snapshot);
}

function sliceSharedArrayBuffer(
  buffer: SharedArrayBuffer,
  begin?: number,
  end?: number,
): SharedArrayBuffer {
  if (typeof sharedArrayBufferCtor !== 'function') {
    throw new Error('SharedArrayBuffer is not supported in this environment.');
  }

  const { start, finish } = normalizeSliceRange(
    begin,
    end,
    buffer.byteLength,
  );
  const clone = new sharedArrayBufferCtor(finish - start);
  const sourceView = new Uint8Array(buffer, start, finish - start);
  const targetView = new Uint8Array(clone);
  targetView.set(sourceView);
  return clone;
}

function normalizeSliceRange(
  begin: number | undefined,
  end: number | undefined,
  length: number,
): { start: number; finish: number } {
  const start = normalizeSliceIndex(begin, length, 0);
  const finish = normalizeSliceIndex(end, length, length);
  return {
    start,
    finish: Math.max(finish, start),
  };
}

function normalizeSliceIndex(
  index: number | undefined,
  length: number,
  defaultValue: number,
): number {
  if (index === undefined) {
    return defaultValue;
  }
  const numeric = Number(index);
  if (Number.isNaN(numeric)) {
    return defaultValue;
  }
  if (!Number.isFinite(numeric)) {
    return numeric < 0 ? 0 : length;
  }
  const integer = Math.trunc(numeric);
  if (integer < 0) {
    return Math.max(length + integer, 0);
  }
  return Math.min(integer, length);
}

function cloneSharedArrayBuffer(
  buffer: SharedArrayBuffer,
): SharedArrayBuffer {
  if (typeof sharedArrayBufferCtor !== 'function') {
    throw new Error('SharedArrayBuffer is not supported in this environment.');
  }
  const clone = new sharedArrayBufferCtor(buffer.byteLength);
  new Uint8Array(clone).set(new Uint8Array(buffer));
  return clone;
}

function sharedArrayBufferToArrayBuffer(buffer: SharedArrayBuffer): ArrayBuffer {
  const view = new Uint8Array(buffer);
  const clone = new ArrayBuffer(view.byteLength);
  new Uint8Array(clone).set(view);
  return clone;
}

function cloneCommand<TPayload>(
  command: Command<TPayload>,
): CommandSnapshot<TPayload> {
  const snapshot = cloneStructured(command);
  return deepFreezeInPlace(snapshot);
}

function cloneStructured<T>(value: T): T {
  const structuredCloneGlobal = (globalThis as {
    structuredClone?: <U>(input: U) => U;
  }).structuredClone;

  if (typeof structuredCloneGlobal !== 'function') {
    throw new Error(
      'structuredClone is required for deterministic command queue snapshots.',
    );
  }

  return structuredCloneGlobal(value);
}
