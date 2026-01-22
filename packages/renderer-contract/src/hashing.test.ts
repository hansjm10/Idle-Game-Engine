import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalizeForHash,
  hashRenderCommandBuffer,
  hashViewModel,
  normalizeNumbersForHash,
  sha256Hex,
} from './index.js';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from './types.js';
import type {
  RenderCommandBuffer,
  ViewModel,
} from './types.js';

describe('hashing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('RFC 8785 canonicalization edge cases', () => {
    it('serializes top-level null', () => {
      expect(canonicalizeForHash(null)).toBe('null');
    });

    it('serializes top-level booleans', () => {
      expect(canonicalizeForHash(true)).toBe('true');
      expect(canonicalizeForHash(false)).toBe('false');
    });

    it('serializes top-level numbers', () => {
      expect(canonicalizeForHash(42)).toBe('42');
      expect(canonicalizeForHash(3.14159)).toBe('3.14159');
      expect(canonicalizeForHash(0)).toBe('0');
      expect(canonicalizeForHash(-0)).toBe('0'); // -0 normalized to 0
    });

    it('serializes top-level strings with proper escaping', () => {
      expect(canonicalizeForHash('hello')).toBe('"hello"');
      expect(canonicalizeForHash('with "quotes"')).toBe('"with \\"quotes\\""');
      expect(canonicalizeForHash('line\nbreak')).toBe('"line\\nbreak"');
    });

    it('serializes empty structures', () => {
      expect(canonicalizeForHash([])).toBe('[]');
      expect(canonicalizeForHash({})).toBe('{}');
    });

    it('converts undefined array elements to null (RFC 8785 §3.2.2)', () => {
      expect(canonicalizeForHash([1, undefined, 3])).toBe('[1,null,3]');
      expect(canonicalizeForHash([undefined])).toBe('[null]');
    });

    it('omits undefined object values (RFC 8785 §3.2.3)', () => {
      expect(canonicalizeForHash({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
      expect(canonicalizeForHash({ only: undefined })).toBe('{}');
    });

    it('sorts object keys lexicographically by UTF-16 code units (RFC 8785 §3.2.3)', () => {
      // Standard ASCII key ordering
      expect(canonicalizeForHash({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');

      // Uppercase sorts before lowercase in UTF-16 (A=65, a=97)
      expect(canonicalizeForHash({ a: 1, A: 2 })).toBe('{"A":2,"a":1}');

      // Digits sort before letters (0=48, A=65, a=97)
      expect(canonicalizeForHash({ a: 1, '1': 2, A: 3 })).toBe('{"1":2,"A":3,"a":1}');

      // Special characters in keys
      expect(canonicalizeForHash({ 'a-b': 1, 'a_c': 2 })).toBe('{"a-b":1,"a_c":2}');
    });

    it('handles nested structures with deterministic ordering', () => {
      const nested = {
        z: { b: 2, a: 1 },
        a: [3, { y: 4, x: 5 }],
      };
      expect(canonicalizeForHash(nested)).toBe('{"a":[3,{"x":5,"y":4}],"z":{"a":1,"b":2}}');
    });

    it('handles null-prototype objects', () => {
      const nullProto = Object.create(null) as Record<string, unknown>;
      nullProto['b'] = 1;
      nullProto['a'] = 2;
      expect(canonicalizeForHash(nullProto)).toBe('{"a":2,"b":1}');
    });

    it('handles deeply nested arrays and objects', () => {
      const deep = { a: [[[{ b: 1 }]]] };
      expect(canonicalizeForHash(deep)).toBe('{"a":[[[{"b":1}]]]}');
    });

    it('rejects objects with toJSON methods (functions are not supported)', () => {
      // Unlike JSON.stringify which calls toJSON(), our implementation
      // iterates object keys directly. Objects with toJSON methods fail
      // because normalizeNumbersForHash encounters the function value.
      const withToJSON = { value: 1, toJSON: () => ({ serialized: true }) };
      expect(() => canonicalizeForHash(withToJSON)).toThrow(/function/);
    });
  });

  it('hashes ViewModel deterministically (independent of object key insertion order)', async () => {
    const a: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 2,
        simTimeMs: 32,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: 1, y: 2, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    const b: ViewModel = {
      ui: {
        nodes: [],
      },
      scene: {
        sprites: [],
        camera: { zoom: 1, y: 2, x: 1 },
      },
      frame: {
        contentHash: 'content:abc',
        simTimeMs: 32,
        step: 2,
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
      },
    };

    await expect(hashViewModel(a)).resolves.toEqual(await hashViewModel(b));
  });

  it('normalizes null and rejects unsupported types before hashing', () => {
    expect(normalizeNumbersForHash(null)).toBeNull();

    expect(() => normalizeNumbersForHash(1n)).toThrow(/bigint/);
    expect(() => normalizeNumbersForHash(Symbol('symbol'))).toThrow(/symbol/);
    expect(() => normalizeNumbersForHash(() => 'fn')).toThrow(/function/);
  });

  it('throws when canonicalization does not produce a string', () => {
    expect(() => canonicalizeForHash(undefined)).toThrow(
      'Failed to canonicalize value for hashing.',
    );
  });

  it('throws when WebCrypto is unavailable', async () => {
    vi.stubGlobal('crypto', {} as Crypto);
    await expect(sha256Hex(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /WebCrypto is unavailable/,
    );
  });

  it('hashes Uint8Array subarray views', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const view = bytes.subarray(1, 4);

    await expect(sha256Hex(view)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes SharedArrayBuffer-backed views', async () => {
    const buffer = new SharedArrayBuffer(4);
    const bytes = new Uint8Array(buffer);
    bytes.set([1, 2, 3, 4]);

    await expect(sha256Hex(bytes)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes -0 to 0 before hashing', async () => {
    const a: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 2,
        simTimeMs: 32,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: -0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    const b: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 2,
        simTimeMs: 32,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    await expect(hashViewModel(a)).resolves.toEqual(await hashViewModel(b));
  });

  it('rejects NaN and Infinity for hashing', async () => {
    const nan: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: Number.NaN, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    const infinity: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: Number.POSITIVE_INFINITY, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    await expect(hashViewModel(nan)).rejects.toThrow(/NaN/);
    await expect(hashViewModel(infinity)).rejects.toThrow(/Infinity/);
  });

  it('rejects Map, Set, and non-plain objects for hashing', async () => {
    class NotPlain {
      readonly value = 1;
    }

    const viewModelWithMap = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
      extra: new Map([['a', 1]]),
    } as unknown as ViewModel;

    const viewModelWithSet = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
      extra: new Set([1]),
    } as unknown as ViewModel;

    const viewModelWithClassInstance = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
      extra: new NotPlain(),
    } as unknown as ViewModel;

    await expect(hashViewModel(viewModelWithMap)).rejects.toThrow(/Map/);
    await expect(hashViewModel(viewModelWithSet)).rejects.toThrow(/Set/);
    await expect(hashViewModel(viewModelWithClassInstance)).rejects.toThrow(/non-plain/);
  });

  it('hashes RenderCommandBuffer deterministically', async () => {
    const a: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 2,
        simTimeMs: 32,
        contentHash: 'content:abc',
      },
      passes: [
        { id: 'world' },
        { id: 'ui' },
      ],
      draws: [
        {
          kind: 'clear',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0xff_00_00_ff,
        },
      ],
    };

    const b: RenderCommandBuffer = {
      draws: [
        {
          colorRgba: 0xff_00_00_ff,
          sortKey: { sortKeyLo: 0, sortKeyHi: 0 },
          passId: 'world',
          kind: 'clear',
        },
      ],
      passes: [
        { id: 'world' },
        { id: 'ui' },
      ],
      frame: {
        contentHash: 'content:abc',
        simTimeMs: 32,
        step: 2,
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
      },
    };

    await expect(hashRenderCommandBuffer(a)).resolves.toEqual(
      await hashRenderCommandBuffer(b),
    );
  });
});
