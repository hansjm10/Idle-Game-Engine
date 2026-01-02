import { describe, it, expect, beforeEach } from 'vitest';

import {
  createValidationCache,
  cachedResultToValidationResult,
  validationResultToCachedResult,
  type CachedValidationResult,
  type ValidationCache,
} from './cache.js';
import type { ContentPackValidationResult, NormalizedContentPack } from './types.js';

// Minimal mock normalized pack for testing
// Uses unknown cast due to branded types in actual schema
const createMockNormalizedPack = (id: string): NormalizedContentPack =>
  ({
    metadata: {
      id,
      title: { default: 'Test Pack', variants: {} },
      version: '1.0.0',
      engine: '>=0.1.0',
      authors: [],
      defaultLocale: 'en',
      supportedLocales: ['en'],
      tags: [],
      links: [],
    },
    resources: [],
    generators: [],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    runtimeEvents: [],
    lookup: {
      resources: new Map(),
      generators: new Map(),
      upgrades: new Map(),
      metrics: new Map(),
      achievements: new Map(),
      automations: new Map(),
      transforms: new Map(),
      prestigeLayers: new Map(),
      runtimeEvents: new Map(),
    },
    serializedLookup: {
      resourceById: {},
      generatorById: {},
      upgradeById: {},
      metricById: {},
      achievementById: {},
      automationById: {},
      transformById: {},
      prestigeLayerById: {},
      runtimeEventById: {},
    },
    digest: { version: 1, hash: `fnv1a-${id}` },
  }) as unknown as NormalizedContentPack;

const createMockValidationResult = (id: string): ContentPackValidationResult => ({
  pack: createMockNormalizedPack(id),
  warnings: [],
  balanceWarnings: [],
  balanceErrors: [],
});

describe('createValidationCache', () => {
  let cache: ValidationCache;

  beforeEach(() => {
    cache = createValidationCache();
  });

  describe('basic operations', () => {
    it('returns undefined for cache miss', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('returns cached result for cache hit', () => {
      const result = validationResultToCachedResult(createMockValidationResult('pack1'));
      cache.set('key1', result);

      const cached = cache.get('key1');
      expect(cached).toBeDefined();
      expect(cached?.pack.metadata.id).toBe('pack1');
    });

    it('tracks size correctly', () => {
      expect(cache.size).toBe(0);

      cache.set('key1', validationResultToCachedResult(createMockValidationResult('pack1')));
      expect(cache.size).toBe(1);

      cache.set('key2', validationResultToCachedResult(createMockValidationResult('pack2')));
      expect(cache.size).toBe(2);
    });

    it('clears all entries', () => {
      cache.set('key1', validationResultToCachedResult(createMockValidationResult('pack1')));
      cache.set('key2', validationResultToCachedResult(createMockValidationResult('pack2')));
      expect(cache.size).toBe(2);

      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
    });

    it('deletes specific entries', () => {
      cache.set('key1', validationResultToCachedResult(createMockValidationResult('pack1')));
      cache.set('key2', validationResultToCachedResult(createMockValidationResult('pack2')));

      const deleted = cache.delete('key1');
      expect(deleted).toBe(true);
      expect(cache.size).toBe(1);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeDefined();
    });

    it('returns false when deleting nonexistent key', () => {
      const deleted = cache.delete('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entries when maxSize exceeded', () => {
      const smallCache = createValidationCache({ maxSize: 3 });

      smallCache.set('key1', validationResultToCachedResult(createMockValidationResult('pack1')));
      smallCache.set('key2', validationResultToCachedResult(createMockValidationResult('pack2')));
      smallCache.set('key3', validationResultToCachedResult(createMockValidationResult('pack3')));
      expect(smallCache.size).toBe(3);

      // Adding a 4th entry should evict the oldest (key1)
      smallCache.set('key4', validationResultToCachedResult(createMockValidationResult('pack4')));
      expect(smallCache.size).toBe(3);
      expect(smallCache.get('key1')).toBeUndefined();
      expect(smallCache.get('key2')).toBeDefined();
      expect(smallCache.get('key3')).toBeDefined();
      expect(smallCache.get('key4')).toBeDefined();
    });

    it('promotes accessed entries to MRU position', () => {
      const smallCache = createValidationCache({ maxSize: 3 });

      smallCache.set('key1', validationResultToCachedResult(createMockValidationResult('pack1')));
      smallCache.set('key2', validationResultToCachedResult(createMockValidationResult('pack2')));
      smallCache.set('key3', validationResultToCachedResult(createMockValidationResult('pack3')));

      // Access key1, making it most recently used
      smallCache.get('key1');

      // Adding a 4th entry should now evict key2 (oldest after key1 was accessed)
      smallCache.set('key4', validationResultToCachedResult(createMockValidationResult('pack4')));
      expect(smallCache.get('key1')).toBeDefined();
      expect(smallCache.get('key2')).toBeUndefined();
      expect(smallCache.get('key3')).toBeDefined();
      expect(smallCache.get('key4')).toBeDefined();
    });

    it('handles maxSize of 1', () => {
      const tinyCache = createValidationCache({ maxSize: 1 });

      tinyCache.set('key1', validationResultToCachedResult(createMockValidationResult('pack1')));
      expect(tinyCache.size).toBe(1);

      tinyCache.set('key2', validationResultToCachedResult(createMockValidationResult('pack2')));
      expect(tinyCache.size).toBe(1);
      expect(tinyCache.get('key1')).toBeUndefined();
      expect(tinyCache.get('key2')).toBeDefined();
    });

    it('treats maxSize of 0 as disabled', () => {
      const disabledCache = createValidationCache({ maxSize: 0 });

      disabledCache.set('key1', validationResultToCachedResult(createMockValidationResult('pack1')));
      expect(disabledCache.size).toBe(0);
      expect(disabledCache.get('key1')).toBeUndefined();
    });

    it('updates existing entry without eviction', () => {
      const smallCache = createValidationCache({ maxSize: 2 });

      smallCache.set('key1', validationResultToCachedResult(createMockValidationResult('pack1')));
      smallCache.set('key2', validationResultToCachedResult(createMockValidationResult('pack2')));
      expect(smallCache.size).toBe(2);

      // Update key1 - should not increase size or cause eviction
      smallCache.set('key1', validationResultToCachedResult(createMockValidationResult('pack1-updated')));
      expect(smallCache.size).toBe(2);
      expect(smallCache.get('key1')?.pack.metadata.id).toBe('pack1-updated');
      expect(smallCache.get('key2')).toBeDefined();
    });
  });

  describe('default configuration', () => {
    it('uses default maxSize of 100', () => {
      const defaultCache = createValidationCache();

      // Add 100 entries
      for (let i = 0; i < 100; i++) {
        defaultCache.set(`key${i}`, validationResultToCachedResult(createMockValidationResult(`pack${i}`)));
      }
      expect(defaultCache.size).toBe(100);

      // 101st entry should trigger eviction
      defaultCache.set('key100', validationResultToCachedResult(createMockValidationResult('pack100')));
      expect(defaultCache.size).toBe(100);
      expect(defaultCache.get('key0')).toBeUndefined();
    });
  });
});

describe('cachedResultToValidationResult', () => {
  it('converts cached result to validation result', () => {
    const cached: CachedValidationResult = {
      pack: createMockNormalizedPack('test'),
      warnings: [{ code: 'test.warning', message: 'Test warning', path: [], severity: 'warning' }],
      balanceWarnings: [],
      balanceErrors: [],
      timestamp: Date.now(),
    };

    const result = cachedResultToValidationResult(cached);

    expect(result.pack).toBe(cached.pack);
    expect(result.warnings).toBe(cached.warnings);
    expect(result.balanceWarnings).toBe(cached.balanceWarnings);
    expect(result.balanceErrors).toBe(cached.balanceErrors);
  });
});

describe('validationResultToCachedResult', () => {
  it('converts validation result to cached result with timestamp', () => {
    const before = Date.now();
    const validationResult = createMockValidationResult('test');
    const cached = validationResultToCachedResult(validationResult);
    const after = Date.now();

    expect(cached.pack).toBe(validationResult.pack);
    expect(cached.warnings).toBe(validationResult.warnings);
    expect(cached.balanceWarnings).toBe(validationResult.balanceWarnings);
    expect(cached.balanceErrors).toBe(validationResult.balanceErrors);
    expect(cached.timestamp).toBeGreaterThanOrEqual(before);
    expect(cached.timestamp).toBeLessThanOrEqual(after);
  });
});
