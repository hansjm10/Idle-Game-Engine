export interface ImmutableArrayBufferSnapshot {
  readonly byteLength: number;
  slice(
    begin?: number,
    end?: number,
  ): ImmutableArrayBufferSnapshot;
  toArrayBuffer(): ArrayBuffer;
  toDataView(): DataView;
  toUint8Array(): Uint8Array;
  valueOf(): ArrayBuffer;
  readonly [Symbol.toStringTag]: 'ImmutableArrayBufferSnapshot';
}

export interface ImmutableSharedArrayBufferSnapshot {
  readonly byteLength: number;
  slice(
    begin?: number,
    end?: number,
  ): ImmutableSharedArrayBufferSnapshot;
  toSharedArrayBuffer(): SharedArrayBuffer;
  toArrayBuffer(): ArrayBuffer;
  toDataView(): DataView;
  toUint8Array(): Uint8Array;
  valueOf(): SharedArrayBuffer;
  readonly [Symbol.toStringTag]: 'ImmutableSharedArrayBufferSnapshot';
}

export type ImmutableMapSnapshot<K, V> = Map<K, V> & {
  valueOf(): ImmutableMapSnapshot<K, V>;
  forEach(
    callbackfn: (
      value: V,
      key: K,
      map: ImmutableMapSnapshot<K, V>,
    ) => void,
    thisArg?: unknown,
  ): void;
  set(key: unknown, value: unknown): never;
  delete(key: unknown): never;
  clear(): never;
};

export type ImmutableSetSnapshot<V> = Set<V> & {
  valueOf(): ImmutableSetSnapshot<V>;
  forEach(
    callbackfn: (
      value: V,
      value2: V,
      set: ImmutableSetSnapshot<V>,
    ) => void,
    thisArg?: unknown,
  ): void;
  add(value: unknown): never;
  delete(value: unknown): never;
  clear(): never;
};

export type TypedArray =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

type TypedArrayValue<TArray extends TypedArray> =
  TArray extends ArrayLike<infer TValue> ? TValue : never;

type TypedArrayMutatorKeys =
  | 'copyWithin'
  | 'fill'
  | 'reverse'
  | 'set'
  | 'sort';

type TypedArrayCallbackKeys =
  | 'forEach'
  | 'map'
  | 'filter'
  | 'reduce'
  | 'reduceRight'
  | 'subarray';

export type ImmutableTypedArraySnapshot<TArray extends TypedArray> = Omit<
  TArray,
  TypedArrayMutatorKeys | TypedArrayCallbackKeys | 'buffer'
> & {
  readonly buffer:
    | ImmutableArrayBufferSnapshot
    | ImmutableSharedArrayBufferSnapshot;
  set(array: ArrayLike<number>, offset?: number): never;
  valueOf(): ImmutableTypedArraySnapshot<TArray>;
  subarray(
    begin?: number,
    end?: number,
  ): ImmutableTypedArraySnapshot<TArray>;
  filter(
    callbackfn: (
      value: TypedArrayValue<TArray>,
      index: number,
      array: ImmutableTypedArraySnapshot<TArray>,
    ) => unknown,
    thisArg?: unknown,
  ): ImmutableTypedArraySnapshot<TArray>;
  map(
    callbackfn: (
      value: TypedArrayValue<TArray>,
      index: number,
      array: ImmutableTypedArraySnapshot<TArray>,
    ) => TypedArrayValue<TArray>,
    thisArg?: unknown,
  ): ImmutableTypedArraySnapshot<TArray>;
  forEach(
    callbackfn: (
      value: TypedArrayValue<TArray>,
      index: number,
      array: ImmutableTypedArraySnapshot<TArray>,
    ) => void,
    thisArg?: unknown,
  ): void;
  reduceRight(
    callbackfn: (
      previousValue: TypedArrayValue<TArray>,
      currentValue: TypedArrayValue<TArray>,
      currentIndex: number,
      array: ImmutableTypedArraySnapshot<TArray>,
    ) => TypedArrayValue<TArray>,
  ): TypedArrayValue<TArray>;
  reduceRight(
    callbackfn: (
      previousValue: TypedArrayValue<TArray>,
      currentValue: TypedArrayValue<TArray>,
      currentIndex: number,
      array: ImmutableTypedArraySnapshot<TArray>,
    ) => TypedArrayValue<TArray>,
    initialValue: TypedArrayValue<TArray>,
  ): TypedArrayValue<TArray>;
  reduceRight<U>(
    callbackfn: (
      previousValue: U,
      currentValue: TypedArrayValue<TArray>,
      currentIndex: number,
      array: ImmutableTypedArraySnapshot<TArray>,
    ) => U,
    initialValue: U,
  ): U;
  reduce(
    callbackfn: (
      previousValue: TypedArrayValue<TArray>,
      currentValue: TypedArrayValue<TArray>,
      currentIndex: number,
      array: ImmutableTypedArraySnapshot<TArray>,
    ) => TypedArrayValue<TArray>,
  ): TypedArrayValue<TArray>;
  reduce(
    callbackfn: (
      previousValue: TypedArrayValue<TArray>,
      currentValue: TypedArrayValue<TArray>,
      currentIndex: number,
      array: ImmutableTypedArraySnapshot<TArray>,
    ) => TypedArrayValue<TArray>,
    initialValue: TypedArrayValue<TArray>,
  ): TypedArrayValue<TArray>;
  reduce<U>(
    callbackfn: (
      previousValue: U,
      currentValue: TypedArrayValue<TArray>,
      currentIndex: number,
      array: ImmutableTypedArraySnapshot<TArray>,
    ) => U,
    initialValue: U,
  ): U;
};

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

const typedArrayPrototype = Object.getPrototypeOf(
  Int8Array.prototype,
) as Record<PropertyKey, unknown> | null;

const sharedArrayBufferCtor = (globalThis as {
  SharedArrayBuffer?: new (byteLength: number) => SharedArrayBuffer;
}).SharedArrayBuffer;

const arrayBufferSnapshotCache = new WeakMap<
  ArrayBuffer,
  ImmutableArrayBufferSnapshot
>();

const sharedArrayBufferSnapshotCache = sharedArrayBufferCtor
  ? new WeakMap<
      SharedArrayBuffer,
      ImmutableSharedArrayBufferSnapshot
    >()
  : undefined;

const immutableTypedArraySnapshots = new WeakSet<object>();

const MUTATION_ERROR_MESSAGE =
  'Immutable typed array snapshots are read-only. Clone the array before mutating.';

function createImmutableArrayBufferSnapshot(
  buffer: ArrayBuffer,
): ImmutableArrayBufferSnapshot {
  const cached = arrayBufferSnapshotCache.get(buffer);
  if (cached) {
    return cached;
  }

  const snapshot: ImmutableArrayBufferSnapshot = {
    get byteLength() {
      return buffer.byteLength;
    },
    slice(begin?: number, end?: number) {
      const sliced = buffer.slice(
        begin ?? 0,
        end ?? buffer.byteLength,
      );
      return createImmutableArrayBufferSnapshot(sliced);
    },
    toArrayBuffer() {
      return buffer.slice(0);
    },
    toDataView() {
      return new DataView(buffer.slice(0));
    },
    toUint8Array() {
      return new Uint8Array(buffer.slice(0));
    },
    valueOf() {
      return buffer.slice(0);
    },
    [Symbol.toStringTag]: 'ImmutableArrayBufferSnapshot',
  };

  arrayBufferSnapshotCache.set(buffer, snapshot);
  return snapshot;
}

function cloneSharedArrayBuffer(
  buffer: SharedArrayBuffer,
): SharedArrayBuffer {
  if (!sharedArrayBufferCtor) {
    throw new TypeError('SharedArrayBuffer is not supported in this environment');
  }

  const clone = new sharedArrayBufferCtor(buffer.byteLength);
  const source = new Uint8Array(buffer);
  new Uint8Array(clone).set(source);
  return clone;
}

function computeSliceBounds(
  length: number,
  begin?: number,
  end?: number,
): [number, number] {
  const start =
    begin === undefined
      ? 0
      : begin < 0
        ? Math.max(length + begin, 0)
        : Math.min(begin, length);
  const rawEnd =
    end === undefined
      ? length
      : end < 0
        ? Math.max(length + end, 0)
        : Math.min(end, length);
  const finish = Math.max(0, Math.min(rawEnd, length));
  return [start, Math.max(start, finish)];
}

function createImmutableSharedArrayBufferSnapshot(
  buffer: SharedArrayBuffer,
): ImmutableSharedArrayBufferSnapshot {
  const cached = sharedArrayBufferSnapshotCache?.get(buffer);
  if (cached) {
    return cached;
  }

  if (!sharedArrayBufferCtor) {
    throw new TypeError('SharedArrayBuffer is not supported in this environment');
  }

  const snapshot: ImmutableSharedArrayBufferSnapshot = {
    get byteLength() {
      return buffer.byteLength;
    },
    slice(begin?: number, end?: number) {
      const [start, finish] = computeSliceBounds(
        buffer.byteLength,
        begin,
        end,
      );
      const clone = new sharedArrayBufferCtor(finish - start);
      const source = new Uint8Array(buffer, start, finish - start);
      new Uint8Array(clone).set(source);
      return createImmutableSharedArrayBufferSnapshot(clone);
    },
    toSharedArrayBuffer() {
      return cloneSharedArrayBuffer(buffer);
    },
    toArrayBuffer() {
      const copy = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(copy).set(new Uint8Array(buffer));
      return copy;
    },
    toDataView() {
      const copy = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(copy).set(new Uint8Array(buffer));
      return new DataView(copy);
    },
    toUint8Array() {
      const copy = new Uint8Array(buffer.byteLength);
      copy.set(new Uint8Array(buffer));
      return copy;
    },
    valueOf() {
      return cloneSharedArrayBuffer(buffer);
    },
    [Symbol.toStringTag]: 'ImmutableSharedArrayBufferSnapshot',
  };

  sharedArrayBufferSnapshotCache?.set(buffer, snapshot);
  return snapshot;
}

function ensureCallbackUsesReceiver(
  receiver: ArrayBufferView,
  callback: (...args: unknown[]) => unknown,
) {
  return function (
    this: unknown,
    ...callbackArgs: unknown[]
  ): unknown {
    if (callbackArgs.length > 0) {
      callbackArgs[callbackArgs.length - 1] = receiver;
    }
    return callback.apply(this, callbackArgs);
  };
}

function wrapMethodResult(
  result: unknown,
  target?: ArrayBufferView,
  receiver?: ArrayBufferView,
): unknown {
  if (target && result === target && receiver) {
    return receiver;
  }
  if (
    ArrayBuffer.isView(result) &&
    !(result instanceof DataView)
  ) {
    return createImmutableTypedArrayView(result as TypedArray);
  }
  return result;
}

function isTypedArrayPrototypeProperty(
  property: PropertyKey,
): boolean {
  if (!typedArrayPrototype) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(
    typedArrayPrototype,
    property,
  );
}

export function createImmutableTypedArrayView<
  TArray extends TypedArray,
>(view: TArray): ImmutableTypedArraySnapshot<TArray> {
  const buffer = view.buffer;
  const sharedBufferSnapshot =
    sharedArrayBufferCtor && buffer instanceof sharedArrayBufferCtor
      ? createImmutableSharedArrayBufferSnapshot(
          buffer,
        )
      : undefined;
  const arrayBufferSnapshot =
    sharedBufferSnapshot === undefined
      ? createImmutableArrayBufferSnapshot(buffer as ArrayBuffer)
      : undefined;

  const proxy = new Proxy(view, {
    get(target, property, receiver) {
      if (property === 'buffer') {
        return sharedBufferSnapshot ?? arrayBufferSnapshot!;
      }

      if (property === 'valueOf') {
        return () => receiver;
      }

      if (
        typeof property === 'string' &&
        TYPED_ARRAY_MUTATORS.has(property)
      ) {
        return () => {
          throw new TypeError(MUTATION_ERROR_MESSAGE);
        };
      }

      if (
        typeof property === 'string' &&
        property === 'subarray'
      ) {
        return (...args: unknown[]) => {
          const typedTarget = target as unknown as {
            subarray: (...params: unknown[]) => TypedArray;
          };
          const result = typedTarget.subarray(...args);
          return createImmutableTypedArrayView(result);
        };
      }

      if (
        typeof property === 'string' &&
        TYPED_ARRAY_CALLBACK_METHODS.has(property)
      ) {
        const original = Reflect.get(target as object, property, target);
        if (typeof original === 'function') {
          return (...args: unknown[]) => {
            if (args.length > 0 && typeof args[0] === 'function') {
              const [callback, ...rest] = args;
              const wrapped = ensureCallbackUsesReceiver(
                receiver as ArrayBufferView,
                callback as (...innerArgs: unknown[]) => unknown,
              );
              const result = (original as (...params: unknown[]) => unknown).apply(
                target,
                [wrapped, ...rest],
              );
              return wrapMethodResult(result, target, receiver as ArrayBufferView);
            }
            const result = (original as (...params: unknown[]) => unknown).apply(
              target,
              args,
            );
            return wrapMethodResult(result, target, receiver as ArrayBufferView);
          };
        }
      }

      const resolved = Reflect.get(target as ArrayBufferView, property);

      if (typeof resolved === 'function') {
        if (property === 'constructor') {
          return resolved;
        }
        if (
          isTypedArrayPrototypeProperty(property) ||
          ArrayBuffer.isView(target)
        ) {
          return (...args: unknown[]) => {
            const result = (resolved as (...params: unknown[]) => unknown).apply(
              target,
              args,
            );
            return wrapMethodResult(result, target, receiver as ArrayBufferView);
          };
        }
        return resolved.bind(target);
      }

      return resolved;
    },
    set() {
      throw new TypeError(MUTATION_ERROR_MESSAGE);
    },
    defineProperty() {
      throw new TypeError(MUTATION_ERROR_MESSAGE);
    },
    deleteProperty() {
      throw new TypeError(MUTATION_ERROR_MESSAGE);
    },
    setPrototypeOf() {
      throw new TypeError(MUTATION_ERROR_MESSAGE);
    },
  }) as unknown as ImmutableTypedArraySnapshot<TArray>;

  immutableTypedArraySnapshots.add(proxy as object);

  return proxy;
}

export function isImmutableTypedArraySnapshot(
  value: unknown,
): value is ImmutableTypedArraySnapshot<TypedArray> {
  return (
    value !== null &&
    typeof value === 'object' &&
    immutableTypedArraySnapshots.has(value)
  );
}
