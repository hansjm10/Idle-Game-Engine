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
