# Validation Performance Benchmarks and Caching

## Document Control
- **Title**: Add validation performance benchmarks and caching
- **Authors**: Claude Code
- **Reviewers**: Repository maintainers
- **Status**: Draft
- **Last Updated**: 2026-01-02
- **Related Issues**: #158 (this issue), #11 (Content DSL Schema parent), #137 (Content schema rollout)
- **Execution Mode**: AI-led

## 1. Summary

This design introduces performance benchmarks and validation result caching for content pack validation. The solution addresses the risk of slow validation blocking authoring workflows on large content packs (500+ entities). Key deliverables include: an in-memory validation cache keyed by content digest, a synthetic pack generator for stress testing, a benchmark suite using tinybench with CI regression detection, and performance documentation for content authors.

## 2. Context & Problem Statement

- **Background**: The content validation pipeline performs structural validation (Zod), cross-reference checks, cycle detection, balance validation, and normalization. Design docs recommend caching normalized results (content-dsl-schema-design.md §7), but no caching exists today. No performance benchmarks exist to establish baselines or catch regressions.
- **Problem**: Running complex validation on large content packs could be slow, blocking authoring workflows. Without benchmarks, we cannot measure performance or detect regressions.
- **Forces**:
  - Target: `<100ms` for 100-entity packs, `<500ms` for 500-entity packs
  - Caching must reduce repeat validation time by >90%
  - CI must catch performance regressions before merge

## 3. Goals & Non-Goals

### Goals
1. Implement in-memory validation result caching with >90% speedup on repeat validations
2. Create performance benchmarks measuring validation stages (schema, cross-ref, cycles, normalization)
3. Generate synthetic large packs (500+ resources, 200+ generators) for stress testing
4. Establish CI regression detection with baseline comparison (fail on >25% regression)
5. Document performance characteristics for content authors

### Non-Goals
- Worker-based validation (deferred unless main-thread blocking observed)
- File-based persistent caching (in-memory sufficient for CLI workflows)
- Balance validation optimization (separate concern)

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Content authors, CI/CD pipelines
- **Agent Roles**:
  - Implementation Agent: Creates cache module, benchmarks, and CI integration
  - Docs Agent: Updates performance documentation
- **Affected Packages/Services**:
  - `packages/content-schema` (cache, digest extraction, validator integration)
  - `.github/workflows/quality-gate.yml` (benchmark step)
- **Compatibility Considerations**: Cache is opt-in via options; no breaking changes to existing API

## 5. Current State

### Validation Pipeline (`packages/content-schema/src/pack/`)
1. **Schema validation** (`schema.ts`): Zod structural parsing with `superRefine`
2. **Cross-reference validation** (`validate-cross-references.ts`, 1232 lines): Entity reference checks, formula tree walking
3. **Cycle detection** (`validate-cycles.ts`, 588 lines): DFS graph traversal for unlock conditions and transforms
4. **Balance validation** (`balance.ts`, 1102 lines): Formula progression evaluation at sample levels
5. **Normalization** (`normalize.ts`, ~500 lines): Sorting, lookup map building, digest computation

### Current Gaps
- No caching: Each validation run starts from scratch
- No benchmarks: No visibility into performance characteristics
- No large test packs: Sample pack has ~100 entities
- Digest computed at end of normalization, preventing cache lookup early in pipeline

## 6. Proposed Solution

### 6.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Validation Pipeline                       │
├─────────────────────────────────────────────────────────────┤
│  Input Pack JSON                                            │
│       │                                                     │
│       ▼                                                     │
│  ┌──────────────┐                                          │
│  │ Zod Parse    │ ─── Structural validation                │
│  └──────┬───────┘                                          │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────┐     ┌─────────────────┐                  │
│  │Compute Digest│────▶│  Cache Lookup   │                  │
│  └──────┬───────┘     └────────┬────────┘                  │
│         │                      │                            │
│         │            ┌─────────┴─────────┐                 │
│         │            │                   │                  │
│         │         HIT│                MISS│                 │
│         │            ▼                   │                  │
│         │     Return cached              │                  │
│         │     NormalizedPack             │                  │
│         │                                ▼                  │
│         ▼                    ┌───────────────────┐         │
│  ┌──────────────┐           │ Cross-ref checks   │         │
│  │              │           ├───────────────────┤         │
│  │              │           │ Cycle detection    │         │
│  │              │           ├───────────────────┤         │
│  │              │           │ Balance validation │         │
│  │              │           ├───────────────────┤         │
│  │              │           │ Normalization      │         │
│  │              │           └─────────┬─────────┘         │
│  │              │                     │                    │
│  │              │                     ▼                    │
│  │              │           ┌───────────────────┐         │
│  │              │           │   Cache Store     │         │
│  │              │           └─────────┬─────────┘         │
│  │              │                     │                    │
│  └──────────────┘                     ▼                    │
│                              Return NormalizedPack          │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Detailed Design

#### 6.2.1 Cache Module

**Location**: `packages/content-schema/src/pack/cache.ts`

```typescript
export interface ValidationCache {
  get(digest: string): CachedValidationResult | undefined;
  set(digest: string, result: CachedValidationResult): void;
  clear(): void;
  readonly size: number;
}

export interface CachedValidationResult {
  pack: NormalizedContentPack;
  warnings: readonly ValidationWarning[];
  timestamp: number;
}

export interface ValidationCacheOptions {
  maxSize?: number;  // Default: 100, LRU eviction
}

export function createValidationCache(options?: ValidationCacheOptions): ValidationCache;
```

#### 6.2.2 Early Digest Computation

**Location**: `packages/content-schema/src/pack/digest.ts`

Extract digest computation from normalization to enable cache lookup after Zod parsing:

```typescript
export function computePackDigest(pack: ContentPack): PackDigest;

export interface PackDigest {
  version: number;  // Digest algorithm version
  hash: string;     // FNV-1a hex string
}
```

#### 6.2.3 Validator Integration

**Location**: `packages/content-schema/src/pack/index.ts`

Add cache option to `ContentSchemaOptions`:

```typescript
interface ContentSchemaOptions {
  // ... existing options
  cache?: ValidationCache;  // Optional cache instance
}
```

Flow modification:
1. Parse with Zod schema
2. Compute digest from parsed pack
3. Check cache for digest → return cached result on hit
4. Run cross-reference, cycle, balance validation
5. Normalize (reuse pre-computed digest)
6. Store in cache
7. Return result

#### 6.2.4 Benchmark Suite

**Location**: `packages/content-schema/benchmarks/`

```
benchmarks/
├── validation.bench.mjs      # Main benchmark suite
├── pack-generator.mjs        # Synthetic pack generator
├── baseline.json             # Performance baselines
└── run-benchmarks.mjs        # Runner with regression check
```

**Scenarios**:
| Scenario | Resources | Generators | Upgrades | Total Entities |
|----------|-----------|------------|----------|----------------|
| tiny-pack | 20 | 10 | 10 | ~40 |
| medium-pack | 100 | 50 | 50 | ~200 |
| large-pack | 500 | 200 | 150 | ~850 |

**Metrics per scenario**:
- `validation_total_ms` - Full validation pipeline
- `schema_parse_ms` - Zod structural validation
- `cross_ref_ms` - Cross-reference checks
- `cycle_detection_ms` - Graph traversal
- `normalization_ms` - Sorting + lookup map building
- `cache_hit_ms` - Cached validation (repeat run)

#### 6.2.5 Synthetic Pack Generator

**Location**: `packages/content-schema/benchmarks/pack-generator.mjs`

```typescript
interface PackGeneratorOptions {
  resources: number;
  generators: number;
  upgrades: number;
  achievements?: number;  // defaults to resources / 10
  automations?: number;   // defaults to generators / 10
  seed?: number;          // For reproducible generation
}

function generateSyntheticPack(options: PackGeneratorOptions): ContentPack;
```

Uses seeded mulberry32 PRNG for deterministic generation. Creates valid cross-references between entities.

#### 6.2.6 Baseline and Regression Detection

**Location**: `packages/content-schema/benchmarks/baseline.json`

```json
{
  "version": 1,
  "updatedAt": "2026-01-02T00:00:00Z",
  "thresholdPercent": 25,
  "scenarios": {
    "tiny-pack": { "validation_total_ms": 15, "cache_hit_ms": 0.5 },
    "medium-pack": { "validation_total_ms": 45, "cache_hit_ms": 0.8 },
    "large-pack": { "validation_total_ms": 180, "cache_hit_ms": 1.2 }
  }
}
```

Regression check: Fail if `current > baseline * 1.25` for any metric.

### 6.3 Operational Considerations

- **Deployment**: No runtime deployment; affects build-time validation only
- **Telemetry**: Benchmark JSON output follows `docs/benchmark-output-schema.md`
- **Security**: No security implications; validation is read-only

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| Extract digest computation | Move digest from normalize.ts to digest.ts | Implementation Agent | None | Unit tests pass, existing behavior unchanged |
| Implement validation cache | Create cache.ts with LRU eviction | Implementation Agent | Digest extraction | Cache hit/miss tests pass |
| Integrate cache with validator | Add cache option to createContentPackValidator | Implementation Agent | Cache module | Integration tests pass |
| Create synthetic pack generator | Implement pack-generator.mjs | Implementation Agent | None | Generates valid packs of configurable size |
| Create benchmark suite | Implement validation.bench.mjs | Implementation Agent | Pack generator | Benchmarks run and output JSON |
| Add baseline and regression check | Implement run-benchmarks.mjs with baseline comparison | Implementation Agent | Benchmark suite | CI fails on >25% regression |
| CI integration | Add benchmark step to quality-gate.yml | Implementation Agent | Regression check | Benchmarks run in CI |
| Documentation | Create content-validation-performance.md | Docs Agent | All above | Doc covers usage and targets |

### 7.2 Milestones

- **Phase 1**: Core implementation (cache, digest, validator integration)
- **Phase 2**: Benchmarks and CI integration
- **Phase 3**: Documentation and baseline tuning

### 7.3 Coordination Notes

- **Hand-off Package**: This design document, existing benchmark patterns in `packages/core/benchmarks/`
- **Communication Cadence**: Single PR with all changes; review before merge

## 8. Agent Guidance & Guardrails

- **Context Packets**:
  - `docs/content-dsl-schema-design.md` §7 (performance requirements)
  - `packages/core/benchmarks/` (existing benchmark patterns)
  - `docs/benchmark-output-schema.md` (JSON output format)
- **Prompting & Constraints**:
  - Use type-only imports per project convention
  - Follow existing benchmark patterns (tinybench, JSON output)
  - Commit style: `feat(content-schema): ...`
- **Safety Rails**:
  - Do not modify existing validation logic (only add caching layer)
  - Benchmarks must be deterministic (use seeded RNG)
- **Validation Hooks**:
  - `pnpm test` must pass
  - `pnpm lint` must pass
  - `pnpm typecheck` must pass
  - `pnpm --filter @idle-engine/content-schema bench` must complete

## 9. Alternatives Considered

| Alternative | Reason Rejected |
|-------------|-----------------|
| Cache in content-compiler | Less reusable; validation is the expensive operation |
| Composite cache key (id+version+digest) | Digest-only is simpler and content-addressable |
| Vitest bench mode | Less control over output format; existing pattern uses tinybench |
| Static large JSON fixtures | Bloats repo; programmatic generation is more flexible |
| Hard CI performance gates | Environment variance causes flaky failures; relative regression is more robust |
| File-based persistent caching | In-memory sufficient for CLI workflows; adds complexity |

## 10. Testing & Validation Plan

- **Unit Tests**:
  - Cache module: hit/miss/eviction/clear tests
  - Digest extraction: matches existing normalization output
  - Pack generator: produces valid packs of specified sizes
- **Integration Tests**:
  - Cached validation returns same result as uncached
  - Cache hit is significantly faster than miss (>90% speedup)
- **Performance**:
  - Benchmark suite measures all validation stages
  - CI regression detection with 25% threshold
  - Target: `<100ms` for 100 entities, `<500ms` for 500 entities

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| CI environment variance causes false failures | Flaky builds | Use 25% threshold; median instead of mean |
| Cache invalidation bugs cause stale results | Incorrect validation | Digest-based key ensures content changes invalidate cache |
| Large pack generation is slow | Slow benchmarks | Cache generated packs; use reasonable sizes |
| Digest computation overhead | Slower validation | FNV-1a is fast; overhead is negligible |

## 12. Rollout Plan

- **Milestones**: Single PR containing all changes
- **Migration Strategy**: Cache is opt-in; no migration needed
- **Communication**: Update CLAUDE.md with `pnpm bench` command

## 13. Open Questions

None remaining after design discussion.

## 14. Follow-Up Work

- Worker-based validation for very large packs (if main-thread blocking observed)
- Persistent file-based caching for watch mode optimization
- Integration with `pnpm generate` timing output

## 15. References

- `docs/content-dsl-schema-design.md` §7 - Performance requirements
- `docs/content-schema-rollout-decisions.md` §5.6 - Issue #143 mapping
- `packages/content-schema/src/pack/index.ts` - Current validator
- `packages/content-schema/src/pack/normalize.ts` - Current digest computation
- `packages/core/benchmarks/` - Existing benchmark patterns
- `docs/benchmark-output-schema.md` - JSON output specification

## Appendix A — Glossary

| Term | Definition |
|------|------------|
| Content Pack | JSON document defining game content (resources, generators, upgrades, etc.) |
| NormalizedContentPack | Validated, frozen, lookup-indexed pack ready for runtime consumption |
| Digest | FNV-1a hash of canonical pack representation for identity/caching |
| Cross-reference validation | Checking that entity references (e.g., upgrade → resource) are valid |

## Appendix B — Change Log

| Date | Author | Change Summary |
|------|--------|----------------|
| 2026-01-02 | Claude Code | Initial draft |
