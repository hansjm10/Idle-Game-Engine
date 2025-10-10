import type {
  Command,
  CommandQueueEntry,
  CommandSnapshot,
  ImmutablePayload,
} from './command.js';
import { CommandPriority } from './command.js';
import type {
  ImmutableArrayBufferSnapshot,
  ImmutableMapSnapshot,
  ImmutableSetSnapshot,
  ImmutableSharedArrayBufferSnapshot,
} from './immutable-snapshots.js';

const PRIORITY_ORDER: readonly CommandPriority[] = [
  CommandPriority.SYSTEM,
  CommandPriority.PLAYER,
  CommandPriority.AUTOMATION,
];

/**
 * Queue implementation that maintains per-priority FIFO lanes as documented in
 * docs/runtime-command-queue-design.md §4.2.
 *
 * Commands are cloned on enqueue to preserve determinism and to prevent
 * call-sites from mutating queued payloads.
 */
type SnapshotQueueEntry = CommandQueueEntry<CommandSnapshot<unknown>>;

export class CommandQueue {
  private readonly lanes: Map<CommandPriority, SnapshotQueueEntry[]> = new Map([
    [CommandPriority.SYSTEM, []],
    [CommandPriority.PLAYER, []],
    [CommandPriority.AUTOMATION, []],
  ]);

  private nextSequence = 0;
  private totalSize = 0;

  enqueue(command: Command): void {
    const queue = this.lanes.get(command.priority);
    if (!queue) {
      throw new Error(`Invalid command priority: ${command.priority}`);
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
      const other = queue[mid]!;
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
    if (this.totalSize === 0) {
      return [];
    }

    const drained: CommandSnapshot[] = [];
    for (const priority of PRIORITY_ORDER) {
      const queue = this.lanes.get(priority);
      if (!queue || queue.length === 0) {
        continue;
      }

      for (const entry of queue) {
        drained.push(entry.command);
      }
      this.totalSize -= queue.length;
      queue.length = 0; // Clear lane deterministically.
    }
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
}

const MAP_MUTATORS = new Set<PropertyKey>(['set', 'delete', 'clear']);
const SET_MUTATORS = new Set<PropertyKey>(['add', 'delete', 'clear']);
const DATE_MUTATOR_PREFIX = /^set/;
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

  const cached = seen.get(node as object);
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
    return makeImmutableView(node as ArrayBufferView, seen);
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
      if (typeof prop === 'string' && DATE_MUTATOR_PREFIX.test(prop)) {
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
    const TypedArrayCtor = source.constructor as {
      new (
        input:
          | ArrayBufferLike
          | ArrayBufferView
          | ArrayLike<unknown>
          | Iterable<unknown>,
      ): ArrayBufferView;
    };
    safeView = new TypedArrayCtor(source);
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
            return original.call(target, callback as never, thisArg);
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
            return original.call(target, callback as never, thisArg);
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
  const clone = Array.isArray(source)
    ? []
    : Object.create(proto === null ? null : proto);

  seen.set(source, clone);

  const keys: Array<PropertyKey> = [
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
            return originalInvoker.call(target, wrappedCallback, ...rest);
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
