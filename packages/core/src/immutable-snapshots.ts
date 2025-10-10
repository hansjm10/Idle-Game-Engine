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

export type ImmutableTypedArraySnapshot<TArray extends TypedArray> = TArray & {
  valueOf(): ImmutableTypedArraySnapshot<TArray>;
  subarray(
    begin?: number,
    end?: number,
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
