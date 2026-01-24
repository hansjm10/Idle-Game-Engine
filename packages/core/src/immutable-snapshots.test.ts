import { describe, expect, it } from 'vitest';

import {
  createImmutableTypedArrayView,
  isImmutableTypedArraySnapshot,
} from './immutable-snapshots.js';

describe('immutable-snapshots', () => {
  describe('createImmutableTypedArrayView', () => {
    describe('basic functionality', () => {
      it('creates immutable view of Uint8Array', () => {
        const original = new Uint8Array([1, 2, 3, 4, 5]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable[0]).toBe(1);
        expect(immutable.length).toBe(5);
      });

      it('creates immutable view of Float64Array', () => {
        const original = new Float64Array([1.1, 2.2, 3.3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable[0]).toBeCloseTo(1.1);
        expect(immutable.length).toBe(3);
      });

      it('creates immutable view of Int32Array', () => {
        const original = new Int32Array([-1, 0, 1, 2147483647]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable[0]).toBe(-1);
        expect(immutable[3]).toBe(2147483647);
      });

      it('creates immutable view of BigInt64Array', () => {
        const original = new BigInt64Array([BigInt(1), BigInt(-1)]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable[0]).toBe(BigInt(1));
        expect(immutable[1]).toBe(BigInt(-1));
      });
    });

    describe('mutation blocking', () => {
      it('throws TypeError when setting index directly', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(() => {
          (immutable as unknown as Uint8Array)[0] = 99;
        }).toThrow(TypeError);
      });

      it('throws TypeError when using set() method', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(() => {
          immutable.set([9, 9], 0);
        }).toThrow(TypeError);
      });

      it('throws TypeError when using fill() method', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(() => {
          (immutable as unknown as Uint8Array).fill(0);
        }).toThrow(TypeError);
      });

      it('throws TypeError when using copyWithin() method', () => {
        const original = new Uint8Array([1, 2, 3, 4, 5]);
        const immutable = createImmutableTypedArrayView(original);

        expect(() => {
          (immutable as unknown as Uint8Array).copyWithin(0, 3);
        }).toThrow(TypeError);
      });

      it('throws TypeError when using sort() method', () => {
        const original = new Uint8Array([3, 1, 2]);
        const immutable = createImmutableTypedArrayView(original);

        expect(() => {
          (immutable as unknown as Uint8Array).sort();
        }).toThrow(TypeError);
      });

      it('throws TypeError when using reverse() method', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(() => {
          (immutable as unknown as Uint8Array).reverse();
        }).toThrow(TypeError);
      });

      it('throws TypeError when defineProperty is called', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(() => {
          Object.defineProperty(immutable, 'newProp', { value: 42 });
        }).toThrow(TypeError);
      });

      it('throws TypeError when deleteProperty is called', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(() => {
          delete (immutable as any)[0];
        }).toThrow(TypeError);
      });

      it('throws TypeError when setPrototypeOf is called', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(() => {
          Object.setPrototypeOf(immutable, {});
        }).toThrow(TypeError);
      });

      it('includes helpful error message', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(() => {
          (immutable as unknown as Uint8Array)[0] = 99;
        }).toThrow(
          'Immutable typed array snapshots are read-only. Clone the array before mutating.',
        );
      });
    });

    describe('read operations still work', () => {
      it('allows slice() and returns new array', () => {
        const original = new Uint8Array([1, 2, 3, 4, 5]);
        const immutable = createImmutableTypedArrayView(original);

        const sliced = immutable.slice(1, 4);
        expect(sliced).toEqual(new Uint8Array([2, 3, 4]));
      });

      it('allows subarray() and returns immutable view', () => {
        const original = new Uint8Array([1, 2, 3, 4, 5]);
        const immutable = createImmutableTypedArrayView(original);

        const sub = immutable.subarray(1, 4);
        expect(isImmutableTypedArraySnapshot(sub)).toBe(true);
        expect(sub[0]).toBe(2);
      });

      it('allows indexOf()', () => {
        const original = new Uint8Array([1, 2, 3, 2, 1]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.indexOf(2)).toBe(1);
        expect(immutable.indexOf(99)).toBe(-1);
      });

      it('allows includes()', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.includes(2)).toBe(true);
        expect(immutable.includes(99)).toBe(false);
      });

      it('allows find()', () => {
        const original = new Uint8Array([1, 2, 3, 4, 5]);
        const immutable = createImmutableTypedArrayView(original);

        const found = immutable.find((x) => x > 3);
        expect(found).toBe(4);
      });

      it('allows every()', () => {
        const original = new Uint8Array([2, 4, 6]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.every((x) => x % 2 === 0)).toBe(true);
      });

      it('allows some()', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.some((x) => x === 2)).toBe(true);
      });

      it('allows reduce()', () => {
        const original = new Uint8Array([1, 2, 3, 4]);
        const immutable = createImmutableTypedArrayView(original);

        const sum = immutable.reduce((acc, val) => acc + val, 0);
        expect(sum).toBe(10);
      });
    });

    describe('callback methods receive proxy as array argument', () => {
      it('forEach receives immutable view as array argument', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);
        let receivedArray: unknown;

        immutable.forEach((_value, _index, array) => {
          receivedArray = array;
        });

        expect(isImmutableTypedArraySnapshot(receivedArray)).toBe(true);
      });

      it('map receives immutable view as array argument', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);
        let receivedArray: unknown;

        immutable.map((x, _index, array) => {
          receivedArray = array;
          return x;
        });

        expect(isImmutableTypedArraySnapshot(receivedArray)).toBe(true);
      });

      it('filter receives immutable view as array argument', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);
        let receivedArray: unknown;

        immutable.filter((_value, _index, array) => {
          receivedArray = array;
          return true;
        });

        expect(isImmutableTypedArraySnapshot(receivedArray)).toBe(true);
      });

      it('wraps typed array results returned by map() and filter()', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        const mapped = immutable.map((value) => value + 1);
        expect(isImmutableTypedArraySnapshot(mapped)).toBe(true);
        expect([...mapped]).toEqual([2, 3, 4]);
        expect(() => {
          (mapped as any)[0] = 0;
        }).toThrow(TypeError);

        const filtered = immutable.filter((value) => value > 1);
        expect(isImmutableTypedArraySnapshot(filtered)).toBe(true);
        expect([...filtered]).toEqual([2, 3]);
      });
    });

    describe('buffer access', () => {
      it('buffer property returns immutable snapshot', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        const buffer = immutable.buffer;
        expect(buffer).toBeDefined();
        expect(buffer.byteLength).toBe(3);
      });

      it('exposes ArrayBuffer snapshot helpers and caches snapshots', () => {
        const buffer = new ArrayBuffer(4);
        const original = new Uint8Array(buffer);
        original.set([1, 2, 3, 4]);

        const immutableA = createImmutableTypedArrayView(original);
        const immutableB = createImmutableTypedArrayView(new Uint8Array(buffer));

        expect(immutableA.buffer).toBe(immutableB.buffer);

        const snapshot = immutableA.buffer as any;
        expect(Object.prototype.toString.call(snapshot)).toBe(
          '[object ImmutableArrayBufferSnapshot]',
        );
        expect(snapshot.toUint8Array()).toEqual(new Uint8Array([1, 2, 3, 4]));
        expect(new Uint8Array(snapshot.toArrayBuffer())).toEqual(
          new Uint8Array([1, 2, 3, 4]),
        );
        expect(snapshot.valueOf()).not.toBe(buffer);
        expect(new Uint8Array(snapshot.valueOf())).toEqual(
          new Uint8Array([1, 2, 3, 4]),
        );
        expect(snapshot.toDataView().getUint8(0)).toBe(1);

        const sliced = snapshot.slice(1, 3);
        expect(sliced.byteLength).toBe(2);
        expect(sliced.toUint8Array()).toEqual(new Uint8Array([2, 3]));
      });

      it('supports SharedArrayBuffer-backed typed arrays', () => {
        const sharedBuffer = new SharedArrayBuffer(4);
        const original = new Uint8Array(sharedBuffer);
        original.set([1, 2, 3, 4]);

        const immutableA = createImmutableTypedArrayView(original);
        const immutableB = createImmutableTypedArrayView(
          new Uint8Array(sharedBuffer),
        );

        expect(immutableA.buffer).toBe(immutableB.buffer);

        const snapshot = immutableA.buffer as any;
        expect(Object.prototype.toString.call(snapshot)).toBe(
          '[object ImmutableSharedArrayBufferSnapshot]',
        );
        expect(snapshot.toUint8Array()).toEqual(new Uint8Array([1, 2, 3, 4]));

        const sliced = snapshot.slice(-2);
        expect(sliced.byteLength).toBe(2);
        expect(sliced.toUint8Array()).toEqual(new Uint8Array([3, 4]));

        const empty = snapshot.slice(3, 1);
        expect(empty.byteLength).toBe(0);

        const clonedShared = snapshot.toSharedArrayBuffer();
        expect(clonedShared).not.toBe(sharedBuffer);
        expect(new Uint8Array(clonedShared)).toEqual(new Uint8Array([1, 2, 3, 4]));
      });

      it('byteOffset is preserved', () => {
        const buffer = new ArrayBuffer(10);
        const original = new Uint8Array(buffer, 2, 5);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.byteOffset).toBe(2);
      });

      it('byteLength is preserved', () => {
        const original = new Float64Array([1.0, 2.0, 3.0]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.byteLength).toBe(24); // 3 * 8 bytes
      });

      it('preserves the typed array constructor', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.constructor).toBe(Uint8Array);
      });
    });

    describe('iteration', () => {
      it('supports for...of iteration', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);
        const values: number[] = [];

        for (const value of immutable) {
          values.push(value);
        }

        expect(values).toEqual([1, 2, 3]);
      });

      it('supports entries()', () => {
        const original = new Uint8Array([10, 20]);
        const immutable = createImmutableTypedArrayView(original);

        const entries = [...immutable.entries()];
        expect(entries).toEqual([
          [0, 10],
          [1, 20],
        ]);
      });

      it('supports keys()', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        const keys = [...immutable.keys()];
        expect(keys).toEqual([0, 1, 2]);
      });

      it('supports values()', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        const values = [...immutable.values()];
        expect(values).toEqual([1, 2, 3]);
      });
    });

    describe('type coverage', () => {
      it.each([
        ['Int8Array', new Int8Array([-128, 0, 127])],
        ['Uint8Array', new Uint8Array([0, 128, 255])],
        ['Uint8ClampedArray', new Uint8ClampedArray([0, 128, 255])],
        ['Int16Array', new Int16Array([-32768, 0, 32767])],
        ['Uint16Array', new Uint16Array([0, 32768, 65535])],
        ['Int32Array', new Int32Array([-2147483648, 0, 2147483647])],
        ['Uint32Array', new Uint32Array([0, 2147483648, 4294967295])],
        ['Float32Array', new Float32Array([1.5, -2.5, 3.5])],
        ['Float64Array', new Float64Array([1.5, -2.5, 3.5])],
      ] as const)('works with %s', (_name, original) => {
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.length).toBe(original.length);
        expect(immutable[0]).toBe(original[0]);
        expect(() => {
          (immutable as any)[0] = 0;
        }).toThrow(TypeError);
      });

      it('works with BigInt64Array', () => {
        const original = new BigInt64Array([
          BigInt(-9007199254740991),
          BigInt(0),
        ]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.length).toBe(2);
        expect(immutable[0]).toBe(BigInt(-9007199254740991));
      });

      it('works with BigUint64Array', () => {
        const original = new BigUint64Array([
          BigInt(0),
          BigInt('18446744073709551615'),
        ]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.length).toBe(2);
        expect(immutable[0]).toBe(BigInt(0));
      });
    });

    describe('edge cases', () => {
      it('handles empty typed array', () => {
        const original = new Uint8Array(0);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.length).toBe(0);
        expect([...immutable]).toEqual([]);
      });

      it('handles single element', () => {
        const original = new Uint8Array([42]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.length).toBe(1);
        expect(immutable[0]).toBe(42);
      });

      it('handles large typed array', () => {
        const original = new Uint8Array(10000);
        original.fill(1);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.length).toBe(10000);
        expect(immutable.reduce((a, b) => a + b, 0)).toBe(10000);
      });

      it('negative indices via subarray work correctly', () => {
        const original = new Uint8Array([1, 2, 3, 4, 5]);
        const immutable = createImmutableTypedArrayView(original);

        // subarray with negative indices
        const sub = immutable.subarray(-3);
        expect([...sub]).toEqual([3, 4, 5]);
      });

      it('valueOf returns the immutable proxy', () => {
        const original = new Uint8Array([1, 2, 3]);
        const immutable = createImmutableTypedArrayView(original);

        expect(immutable.valueOf()).toBe(immutable);
      });
    });
  });

  describe('isImmutableTypedArraySnapshot', () => {
    it('returns true for immutable view', () => {
      const original = new Uint8Array([1, 2, 3]);
      const immutable = createImmutableTypedArrayView(original);

      expect(isImmutableTypedArraySnapshot(immutable)).toBe(true);
    });

    it('returns false for regular typed array', () => {
      const original = new Uint8Array([1, 2, 3]);

      expect(isImmutableTypedArraySnapshot(original)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isImmutableTypedArraySnapshot(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isImmutableTypedArraySnapshot(undefined)).toBe(false);
    });

    it('returns false for plain object', () => {
      expect(isImmutableTypedArraySnapshot({})).toBe(false);
    });

    it('returns false for array', () => {
      expect(isImmutableTypedArraySnapshot([1, 2, 3])).toBe(false);
    });
  });
});
