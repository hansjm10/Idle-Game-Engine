/**
 * Integration tests for validation caching.
 * Verifies that cached validation returns identical results to uncached validation,
 * and that caching provides significant speedup.
 */

import { describe, expect, it } from 'vitest';

import {
  createContentPackValidator,
  createValidationCache,
} from '../pack/index.js';
import { validComprehensivePackFixture } from '../__fixtures__/integration-packs.js';

describe('Validation Caching Integration', () => {
  const packInput = validComprehensivePackFixture;

  describe('result equivalence', () => {
    it('returns identical results for cached and uncached validation', () => {
      const cache = createValidationCache();
      const cachedValidator = createContentPackValidator({
        cache,
        balance: { enabled: false },
      });
      const uncachedValidator = createContentPackValidator({
        balance: { enabled: false },
      });

      // First validation (cache miss)
      const cachedResult1 = cachedValidator.parse(packInput);
      const uncachedResult = uncachedValidator.parse(packInput);

      // Compare normalized packs
      expect(cachedResult1.pack.digest).toEqual(uncachedResult.pack.digest);
      expect(cachedResult1.pack.metadata).toEqual(uncachedResult.pack.metadata);
      expect(cachedResult1.pack.resources.length).toBe(uncachedResult.pack.resources.length);
      expect(cachedResult1.pack.generators.length).toBe(uncachedResult.pack.generators.length);
      expect(cachedResult1.pack.upgrades.length).toBe(uncachedResult.pack.upgrades.length);

      // Second validation (cache hit)
      const cachedResult2 = cachedValidator.parse(packInput);

      // Verify cache hit returns equivalent result
      expect(cachedResult2.pack.digest).toEqual(cachedResult1.pack.digest);
      expect(cachedResult2.pack.metadata).toEqual(cachedResult1.pack.metadata);
    });

    it('returns identical results via safeParse', () => {
      const cache = createValidationCache();
      const cachedValidator = createContentPackValidator({
        cache,
        balance: { enabled: false },
      });
      const uncachedValidator = createContentPackValidator({
        balance: { enabled: false },
      });

      const cachedResult = cachedValidator.safeParse(packInput);
      const uncachedResult = uncachedValidator.safeParse(packInput);

      expect(cachedResult.success).toBe(true);
      expect(uncachedResult.success).toBe(true);

      if (cachedResult.success && uncachedResult.success) {
        expect(cachedResult.data.pack.digest).toEqual(uncachedResult.data.pack.digest);
      }
    });
  });

  describe('cache behavior', () => {
    it('caches results after first validation', () => {
      const cache = createValidationCache();
      const validator = createContentPackValidator({
        cache,
        balance: { enabled: false },
      });

      expect(cache.size).toBe(0);

      validator.parse(packInput);
      expect(cache.size).toBe(1);

      // Second validation should hit cache, not increase size
      validator.parse(packInput);
      expect(cache.size).toBe(1);
    });

    it('provides speedup on repeat validation (cache hit faster than miss)', () => {
      const cache = createValidationCache();
      const validator = createContentPackValidator({
        cache,
        balance: { enabled: false },
      });

      // Warmup and first validation (cache miss)
      validator.parse(packInput);

      // Measure cache miss time
      cache.clear();
      const missStart = performance.now();
      validator.parse(packInput);
      const missTime = performance.now() - missStart;

      // Measure cache hit time
      const hitStart = performance.now();
      validator.parse(packInput);
      const hitTime = performance.now() - hitStart;

      // Cache hit should be significantly faster
      // Note: We use a relaxed threshold since test environments vary
      expect(hitTime).toBeLessThan(missTime);

      // In ideal conditions, cache hit should be >90% faster
      // But for CI stability, we just verify it's faster
      const speedup = (1 - hitTime / missTime) * 100;
      // Log for debugging benchmark performance
      console.log(`Cache speedup: ${speedup.toFixed(1)}% (miss: ${missTime.toFixed(2)}ms, hit: ${hitTime.toFixed(2)}ms)`);
    });
  });

  describe('cache invalidation', () => {
    it('returns different results for different pack content', () => {
      const cache = createValidationCache();
      const validator = createContentPackValidator({
        cache,
        balance: { enabled: false },
      });

      const pack1 = { ...packInput };
      const pack2 = {
        ...packInput,
        metadata: {
          ...packInput.metadata,
          id: 'different-pack-id',
        },
      };

      const result1 = validator.parse(pack1);
      const result2 = validator.parse(pack2);

      expect(cache.size).toBe(2);
      expect(result1.pack.digest.hash).not.toBe(result2.pack.digest.hash);
    });

    it('invalidates cache when entity fields change', () => {
      const cache = createValidationCache();
      const validator = createContentPackValidator({
        cache,
        balance: { enabled: false },
      });

      const pack1 = JSON.parse(JSON.stringify(packInput));
      const pack2 = JSON.parse(JSON.stringify(packInput));
      const originalMultiplier = pack1.generators[0].purchase.costMultiplier;

      pack2.generators[0].purchase.costMultiplier = originalMultiplier + 1;

      const result1 = validator.parse(pack1);
      const result2 = validator.parse(pack2);
      const result1Purchase = result1.pack.generators[0].purchase;
      if (!('costMultiplier' in result1Purchase)) {
        throw new Error('Expected single-currency purchase for cache invalidation test.');
      }
      const result2Purchase = result2.pack.generators[0].purchase;
      if (!('costMultiplier' in result2Purchase)) {
        throw new Error('Expected single-currency purchase for cache invalidation test.');
      }

      expect(cache.size).toBe(2);
      expect(result1Purchase.costMultiplier).toBe(originalMultiplier);
      expect(result2Purchase.costMultiplier).toBe(originalMultiplier + 1);
    });
  });
});
