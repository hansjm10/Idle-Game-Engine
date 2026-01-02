# Content Validation Performance

This document describes the performance characteristics of content pack validation and how to use validation caching effectively.

## Overview

Content pack validation involves several stages:

1. **Structural Validation (Zod)** - Parse and validate the raw JSON structure
2. **Cross-Reference Validation** - Verify entity references are valid
3. **Cycle Detection** - Check for circular dependencies in transforms and unlock conditions
4. **Normalization** - Convert parsed data to normalized format with lookups
5. **Balance Validation** - Run economic balance checks (optional)

## Performance Characteristics

### Validation Time by Pack Size

Based on benchmarks with synthetic packs:

| Pack Size | Entities | Typical Validation Time |
|-----------|----------|------------------------|
| Tiny      | ~40      | 10-15ms               |
| Medium    | ~200     | 50-60ms               |
| Large     | ~850     | 190-220ms             |

**Targets:**
- `<30ms` for tiny packs (~40 entities)
- `<100ms` for medium packs (~200 entities)
- `<500ms` for large packs (~850 entities)

### Time Distribution

For a typical medium-sized pack, validation time is distributed roughly as:

- Zod structural parsing: ~80-90%
- Cross-reference validation: ~5%
- Normalization: ~5%
- Cycle detection: ~1%
- Balance validation: varies (disabled in benchmarks)

## Validation Caching

The validation cache stores normalized results keyed by pack content digest. This allows skipping the expensive refinement, normalization, and balance validation stages on repeat validations of the same content.

### Using the Cache

```typescript
import {
  createContentPackValidator,
  createValidationCache,
} from '@idle-engine/content-schema';

// Create a shared cache instance
const cache = createValidationCache();

// Create validator with cache
const validator = createContentPackValidator({
  cache,
  balance: { enabled: false }, // Optional: disable balance checks
});

// First validation (cache miss) - full validation
const result1 = validator.parse(packData);

// Second validation (cache hit) - returns cached result
const result2 = validator.parse(packData);
```

### Cache Configuration

```typescript
const cache = createValidationCache({
  maxSize: 100, // Default: 100 entries
});
```

The cache uses LRU (Least Recently Used) eviction when the maximum size is exceeded.

### Cache Behavior

- **Cache Key**: Based on pack content digest (FNV-1a hash)
- **Cache Hit**: Returns cached normalized pack and warnings
- **Cache Miss**: Runs full validation, caches result
- **Invalidation**: Automatic when pack content changes (different digest)

### Expected Speedup

The cache provides modest speedup (~5-15%) because Zod structural parsing still runs on every validation. The real benefit is:

1. Avoiding expensive cross-reference validation on repeats
2. Skipping normalization and lookup table construction
3. Reusing balance validation results

For workflows that repeatedly validate the same content (e.g., IDE integrations), caching reduces repeated work.

## Running Benchmarks

```bash
# Run benchmarks
pnpm --filter @idle-engine/content-schema bench

# Run with regression check against baseline
pnpm --filter @idle-engine/content-schema bench:check

# Update baseline (after intentional changes)
pnpm --filter @idle-engine/content-schema bench:update-baseline
```

### Benchmark Output

The benchmark produces JSON output with detailed statistics:

```json
{
  "event": "benchmark_run_end",
  "results": {
    "uncached": [
      {
        "label": "uncached-medium",
        "stats": {
          "meanMs": 55.0,
          "medianMs": 54.5,
          "stdDevMs": 2.0
        }
      }
    ],
    "cached": [
      {
        "label": "cached-medium",
        "hitStats": { "meanMs": 50.0 },
        "missStats": { "meanMs": 55.0 },
        "speedup": 0.09
      }
    ]
  }
}
```

## CI Integration

The CI pipeline runs benchmark regression checks on every PR. If validation time regresses by more than 25% compared to the baseline, the build fails.

To update the baseline after intentional changes (e.g., adding new validation rules):

```bash
pnpm --filter @idle-engine/content-schema bench:update-baseline
git add packages/content-schema/benchmarks/baseline.json
git commit -m "chore: update validation benchmark baseline"
```

## Optimization Tips

### For Content Authors

1. **Keep packs focused**: Smaller packs validate faster
2. **Minimize cross-references**: Each reference requires lookup validation
3. **Use caching in hot paths**: Pass a shared cache to validators in repeated validation scenarios

### For Engine Developers

1. **Reuse cache instances**: Create one cache per application context
2. **Consider cache size**: Increase `maxSize` if validating many different packs
3. **Profile before optimizing**: Use the benchmark suite to identify bottlenecks

## API Reference

### createValidationCache

```typescript
function createValidationCache(options?: {
  maxSize?: number; // Default: 100
}): ValidationCache;
```

### ValidationCache

```typescript
interface ValidationCache {
  get(key: string): CachedValidationResult | undefined;
  set(key: string, result: CachedValidationResult): void;
  clear(): void;
  delete(key: string): boolean;
  readonly size: number;
}
```

### Cache with Validator

```typescript
interface ContentSchemaOptions {
  cache?: ValidationCache;
  // ... other options
}
```
