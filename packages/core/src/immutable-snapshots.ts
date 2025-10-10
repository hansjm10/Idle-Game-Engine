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
