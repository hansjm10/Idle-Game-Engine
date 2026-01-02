/**
 * Validation result caching for content packs.
 *
 * Provides an LRU (Least Recently Used) cache for storing validated and
 * normalized content packs. Cache keys are content digests, ensuring that
 * content changes automatically invalidate cached entries.
 */

import type { ContentSchemaWarning } from '../errors.js';
import type { ContentPackValidationResult, NormalizedContentPack } from './types.js';

/**
 * A cached validation result containing the normalized pack and any warnings.
 */
export interface CachedValidationResult {
  /** The validated and normalized content pack */
  readonly pack: NormalizedContentPack;
  /** Validation warnings from the original validation run */
  readonly warnings: readonly ContentSchemaWarning[];
  /** Balance warnings from the original validation run */
  readonly balanceWarnings: readonly ContentSchemaWarning[];
  /** Balance errors from the original validation run (when warnOnly is true) */
  readonly balanceErrors: readonly ContentSchemaWarning[];
  /** Timestamp when this entry was cached */
  readonly timestamp: number;
}

/**
 * Interface for a validation result cache.
 */
export interface ValidationCache {
  /**
   * Retrieves a cached validation result by digest key.
   * @param key - The cache key (typically from digestToCacheKey)
   * @returns The cached result, or undefined if not found
   */
  get(key: string): CachedValidationResult | undefined;

  /**
   * Stores a validation result in the cache.
   * @param key - The cache key (typically from digestToCacheKey)
   * @param result - The validation result to cache
   */
  set(key: string, result: CachedValidationResult): void;

  /**
   * Removes all entries from the cache.
   */
  clear(): void;

  /**
   * The current number of entries in the cache.
   */
  readonly size: number;

  /**
   * Removes a specific entry from the cache.
   * @param key - The cache key to remove
   * @returns true if an entry was removed, false if key was not found
   */
  delete(key: string): boolean;
}

/**
 * Options for creating a validation cache.
 */
export interface ValidationCacheOptions {
  /**
   * Maximum number of entries to keep in the cache.
   * When exceeded, the least recently used entries are evicted.
   * Set to 0 or less to disable caching.
   * @default 100
   */
  readonly maxSize?: number;
}

/**
 * Creates a validation result from a cached entry.
 * Used to reconstruct the ContentPackValidationResult from cache.
 */
export const cachedResultToValidationResult = (
  cached: CachedValidationResult,
): ContentPackValidationResult => ({
  pack: cached.pack,
  warnings: cached.warnings,
  balanceWarnings: cached.balanceWarnings,
  balanceErrors: cached.balanceErrors,
});

/**
 * Creates a cached result from a validation result.
 */
export const validationResultToCachedResult = (
  result: ContentPackValidationResult,
): CachedValidationResult => ({
  pack: result.pack,
  warnings: result.warnings,
  balanceWarnings: result.balanceWarnings,
  balanceErrors: result.balanceErrors,
  timestamp: Date.now(),
});

/**
 * Creates an LRU validation cache.
 *
 * The cache uses a Map with access-order tracking for LRU eviction.
 * When the cache exceeds maxSize, the least recently accessed entries
 * are removed.
 *
 * @param options - Cache configuration options
 * @returns A ValidationCache instance
 *
 * @example
 * ```typescript
 * const cache = createValidationCache({ maxSize: 50 });
 * const validator = createContentPackValidator({ cache });
 *
 * // First validation is a cache miss - runs full validation
 * const result1 = validator.parse(packJson);
 *
 * // Second validation of same content is a cache hit - returns cached result
 * const result2 = validator.parse(packJson);
 * ```
 */
export const createValidationCache = (
  options: ValidationCacheOptions = {},
): ValidationCache => {
  const maxSize = Math.max(0, options.maxSize ?? 100);
  const cache = new Map<string, CachedValidationResult>();

  const get = (key: string): CachedValidationResult | undefined => {
    const entry = cache.get(key);
    if (entry !== undefined) {
      // Move to end (most recently used) by re-inserting
      cache.delete(key);
      cache.set(key, entry);
    }
    return entry;
  };

  const set = (key: string, result: CachedValidationResult): void => {
    if (maxSize === 0) {
      return;
    }
    // If key exists, delete first to update insertion order
    if (cache.has(key)) {
      cache.delete(key);
    }

    // Evict oldest entries if at capacity
    while (cache.size >= maxSize) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }

    cache.set(key, result);
  };

  const clear = (): void => {
    cache.clear();
  };

  const deleteEntry = (key: string): boolean => cache.delete(key);

  return {
    get,
    set,
    clear,
    delete: deleteEntry,
    get size(): number {
      return cache.size;
    },
  };
};
