---
title: Content Schema Rollout Decisions
---

# Content Schema Rollout Decisions

This document captures key architectural decisions and risk mitigation strategies for the content schema system. It addresses open questions from the content schema design document and provides guidance for production rollout.

## Document Control
- **Title**: Content Schema Rollout Decisions and Risk Mitigation
- **Authors**: Content Pipeline Team
- **Reviewers**: N/A
- **Status**: Approved
- **Last Updated**: 2025-10-21
- **Related Issues**: #137 (Parent: #11)
- **Execution Mode**: Hybrid

## 1. Summary

This document addresses critical design decisions for the content schema system's production rollout, including icon path generation strategy, guild perk persistence integration, scripted modifier support, and schema digest migration patterns. It also tracks mitigation status for six identified risks and provides property-based formula sanitization guidance. All decisions enable Phase 2 content DSL implementation while deferring complex features to later phases.

## 2. Context & Problem Statement

### Background
The content schema design document (docs/content-dsl-schema-design.md) established the foundation for declarative content authoring but left several open questions in Section 10 and identified risks in Section 7 requiring resolution before production rollout.

### Problem
Four critical design questions needed resolution:
1. Should the schema expose calculated presentation defaults (e.g., auto-generated icon paths)?
2. How will guild perk costs interface with social-service data when live persistence lands?
3. Do we need additional effect types (e.g., scripted modifiers) before schema v1.0?
4. What is the migration strategy when schema digests change?

Additionally, six identified risks required mitigation tracking and implementation validation.

### Forces
- **Timeline**: Phase 2 implementation (Weeks 2-4) depends on these decisions
- **Compatibility**: Must support incremental rollout across runtime versions
- **Performance**: Validation must handle large content packs efficiently
- **Author Experience**: Schema strictness must balance safety with usability

## 3. Goals & Non-Goals

### Goals
- Resolve all Section 10 open questions from content schema design
- Track mitigation status for all Section 7 risks
- Define clear implementation roadmap for deferred features
- Provide actionable guidance for content authors and compiler implementers
- Enable Phase 2 (Content DSL & Sample Pack) to proceed unblocked

### Non-Goals
- Implementing scripting runtime (deferred to Phase 7+)
- Designing guild persistence schema (deferred to Phase 5)
- Building compiler icon resolution (follow-up issue)
- Creating save file format specification (Phase 4 work)

## 4. Stakeholders, Agents & Impacted Surfaces

### Primary Stakeholders
- Content Pipeline Team (schema maintenance)
- Runtime Implementation Team (core engine integration)
- Game Design Lead (prestige/formula requirements)

### Agent Roles
N/A - This is a decision document, not an implementation plan.

### Affected Packages/Services
- `packages/content-schema` - Schema definitions and validation
- `packages/core` - Runtime integration
- `services/social` - Guild persistence (future)
- `tools/content-schema-cli` - Validation and compilation tooling

### Compatibility Considerations
All decisions maintain backward compatibility with existing content packs. New features use feature gates (FEATURE_GATES in runtime-compat.ts) to enable incremental adoption.

## 5. Current State

### Schema Implementation Status
- All core modules implemented (resources, generators, upgrades, achievements, prestige layers, guild perks)
- Formula system with numeric expressions, common curves, and safe math operations
- Feature gate system mapping runtime versions to schema modules
- Cross-reference validation with structured error reporting
- Property-based testing for formula sanitization

### Integration Points
- Content compiler emits deterministic artifacts during `pnpm generate`
- `@idle-engine/content-sample` imports generated modules
- Structured JSON event logging for automation
- Digest verification in development mode

### Outstanding Dependencies
- Scripting design document does not exist
- Guild persistence schema not yet designed (Phase 5)
- Save file format specification pending (Phase 4)
- Compiler icon resolution strategy undefined

## 6. Proposed Solution

### 6.1 Architecture Overview

The solution addresses each open question with a clear decision, rationale, and implementation roadmap. Decisions prioritize:
- **Separation of concerns**: Schema remains presentation-agnostic
- **Incremental delivery**: Complex features deferred to appropriate phases
- **Extensibility**: Feature gates and versioning support evolution
- **Safety**: Validation and migration strategies protect user data

### 6.2 Detailed Design

#### Decision 1: Icon Path Default Generation

**Decision**: Leave icon path defaults to the compiler/presentation layer.

**Rationale**:
- Schema should remain presentation-agnostic per design principles
- Asset bundling and path resolution vary by deployment (Vite, Webpack, CDN)
- Compiler can implement convention-based defaults when transforming packs
- Allows flexibility for different presentation layers (web, mobile, terminal UI)

**Current State**:
- Icon fields are optional strings in all modules
- Schema: `icon: z.string().trim().min(1).max(256).optional()`
- No automatic path generation or validation exists

**Action Items**:
- Document icon asset conventions in compiler specification (follow-up issue)
- Add optional `iconPath` validation to check extension types (.svg, .png, .webp)
- Consider adding `iconPathSchema` with URL validation when compiler spec lands

#### Decision 2: Guild Perk Persistence Integration

**Decision**: Defer guild-specific cost modeling to Phase 5 persistence implementation.

**Rationale**:
- Current `cost` schema is flexible enough for prototype phase (Issue #11, Phase 0-4)
- Guild persistence design is not yet finalized (Phase 5: Weeks 5-7)
- Schema can be extended with `GuildCostSchema` when social service adds persistence
- FEATURE_GATES already restrict guild perks to runtime >=0.5.0

**Current State**:
- Guild perk schema complete in `packages/content-schema/src/modules/guild-perks.ts`
- Social service has stub guild routes (`services/social/src/routes/guild.ts`)
- Persistence is in-memory only (Phase 5 work per implementation plan)
- No database schema exists for guild perks or guild state

**Phase 5 Follow-up** (Issue #138 recommended):
- Design guild persistence schema (Postgres tables: guilds, guild_perks, member_contributions)
- Add `GuildResourceDefinition` with ownership semantics (guild-scoped vs player-scoped)
- Extend cost schema with `scope: 'player' | 'guild'` discriminator if needed
- Add validation ensuring guild perk costs only reference guild-category resources

**Acceptance Criteria for Phase 5**:
- Social service persists guild perk unlock state
- Content packs can define guild-scoped currency resources
- Validation ensures guild perk costs reference valid guild currencies
- Documentation examples show guild contribution tracking

#### Decision 3: Scripted Modifiers & Effect Types

**Decision**: Defer scripted modifiers until scripting design document and runtime sandbox land.

**Rationale**:
- Current formula system covers prototype phase needs (Phase 0-6 in implementation-plan.md)
- Scripting requires security sandbox design (docs/idle-engine-design.md Section 6.3: "Sandbox third-party scripts")
- Feature gate model supports incremental rollout (runtime-compat.ts FEATURE_GATES)
- No content pack has requested scripted modifiers yet

**Current State**:
Upgrade effects support these variants (upgrades.ts:79-124):
- `modifyResourceRate`: Formula-based resource adjustments
- `modifyResourceCapacity`: Formula-based resource capacity adjustments
- `modifyGeneratorRate`: Formula-based generator production
- `modifyGeneratorCost`: Formula-based cost scaling
- `grantAutomation`: Enable automation toggles
- `grantFlag`: Set boolean flags
- `unlockResource` / `unlockGenerator`: Entity unlocking
- `alterDirtyTolerance`: Precision threshold adjustments
- `emitEvent`: Trigger runtime events

All modification effects use `NumericFormula` (formulas.ts), which supports:
- Structured expressions with typed references
- Common curves (linear, exponential, polynomial, piecewise)
- Safe math operations (add, sub, mul, div, pow, min, max)
- Function calls against allowlist (clamp, lerp, etc.)

**Schema v1.0 Requirements** (Satisfied):
- Formula-based modifiers for common progressions
- Flag/script condition hooks for extensibility
- Event emission for trigger chains
- Effect composition via upgrade stacking

**Phase 7+ Follow-up** (Issue #139 recommended):
- Author scripting design document (sandbox model, API surface, determinism guarantees)
- Implement script runtime with deterministic execution
- Add `scriptedEffect` upgrade effect type
- Update FEATURE_GATES with `scriptedEffects` introduced in appropriate version
- Add content-schema validation ensuring scriptId references allowlisted scripts

**Acceptance Criteria for Scripted Modifiers**:
- Scripting design doc approved and sandbox implemented
- Script execution is deterministic (seeded RNG, no async)
- Scripts cannot access DOM or host environment
- Validation enforces script allowlists per ContentSchemaOptions

#### Decision 4: Schema Digest Migration Strategy

**Decision**: Embed both pack version AND digest in save files (hybrid approach).

**Rationale**:
- Pack version (semver) enables human-readable compatibility decisions
- Digest provides cryptographic-strength change detection like event manifests
- Supports offline validation (no registry lookup needed)
- Enables granular migration decisions (version -> which migration steps, digest -> exact content state)
- Aligns with runtime event manifest pattern (proven approach)

**Current State**:

Digest Implementation (pack.ts:381-404):
- FNV-1a hash of pack metadata + module id lists
- Format: `{ version: number; hash: string }` (e.g., `fnv1a-a3c2f1b8`)
- Digest version: `CONTENT_PACK_DIGEST_VERSION = 1`
- Computed during `normalizeContentPack`, included in `NormalizedContentPack.digest`

Runtime Event Manifest Approach (runtime-event-manifest-authoring.md:38-43):
- Manifest hash embedded in event frames for replay validation
- Hash checked during recording and playback
- Failures trigger "rerun pnpm generate" guidance
- Deterministic hash ensures replay integrity

Save System Status (implementation-plan.md Phase 4):
- Phase 4: "Implement save slot manager (IndexedDB/localStorage) with migration hooks"
- Versioned schemas mentioned in design (docs/idle-engine-design.md Section 6.2)
- No save format specification exists yet
- Migration pipeline not yet designed

**Proposed Save Format Extension**:
```typescript
interface SaveFileMetadata {
  version: number; // Save format version
  createdAt: string; // ISO-8601 timestamp
  runtimeVersion: string; // Engine version (semver)
  contentPacks: Array<{
    id: string; // Pack slug
    version: string; // Pack version (semver)
    digest: {
      version: number; // Digest format version
      hash: string; // FNV-1a hash
    };
  }>;
  // ... other metadata
}
```

**Migration Decision Tree**:
```
Load save:
  1. Check runtimeVersion compatibility (semver range check)
  2. For each contentPacks entry:
     a. Lookup installed pack by id
     b. Compare version (semver):
        - Exact match -> check digest
        - Compatible minor/patch -> check for migrations
        - Incompatible major -> error or force migration
     c. Compare digest:
        - Match -> no migration needed
        - Mismatch -> run pack-specific migrations
```

**Implementation Actions** (Issue #140 recommended - Phase 4):
- Design save file format with content pack manifests
- Implement save metadata serialization including digests
- Add migration registry (packId + version range -> migration functions)
- Create `validateSaveCompatibility(save, installedPacks)` utility
- Document migration authoring guide for content pack maintainers
- Add tests for cross-version save loading

**Edge Cases to Handle**:
- **Pack removed**: User uninstalls pack but has save referencing it (warning + option to continue with missing content)
- **Digest mismatch, same version**: Content changed without version bump (warn but allow, or force version bump in CI)
- **Multiple packs, cascading dependencies**: Validate dependency graph before migration (see dependencies.ts)
- **Partial migration failure**: Rollback or fallback strategy (atomic migration transactions)

**Acceptance Criteria**:
- Save files include content pack manifests with versions and digests
- Loading a save checks compatibility before hydration
- Incompatible saves trigger migration flow with user consent
- Migrations can be tested independently via fixtures
- Documentation includes migration authoring examples

### 6.3 Operational Considerations

#### Deployment
- Required workflow: `pnpm generate` validates every discovered pack before the compiler writes artifacts
- After editing any pack JSON, schema file, or runtime event manifest, run `pnpm generate` (or `pnpm generate --check` for CI/Lefthook) and commit resulting updates
- Watch mode keeps the process alive across failures while still surfacing non-zero exit codes on termination

#### Telemetry & Observability
- Structured logging: CLI emits JSON events (`content_pack.validated`, `content_pack.validation_failed`, `content_pack.compiled`, `content_pack.pruned`, `watch.run`, etc.)
- Summary contract: Treat `content/compiled/index.json` as the canonical record of validation and compilation outcomes
- Digest verification: `rehydrateNormalizedPack` recomputes digest when `NODE_ENV !== 'production'`

#### Common Failures
- **Import-time warning error**: Fix schema warnings surfaced in compiler log or add contextual suppressions before retrying
- **Digest mismatch**: Ensure artifacts were regenerated (use `pnpm generate --clean`), verify custom post-processing didn't mutate the generated module, re-run tests
- **Stale summary**: If `content/compiled/index.json` reports outdated versions or warning counts, rerun `pnpm generate` so validation and compilation refresh the summary before committing artifacts

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| #138: Design guild persistence schema | Guild-scoped resources, cost model extension | Backend Team | Phase 5 start | Schema supports guild currencies, validation complete |
| #139: Scripting design document and scripted effect support | Sandbox model, scripted effect type | Runtime Team | Scripting design approval | Design doc approved, scripted effects implemented with security sandbox |
| #140: Save file format with content pack manifests | Save metadata, migration registry | Persistence Team | Phase 4 start | Save files include pack manifests, migrations tested |
| #141: CI schema compatibility checks | Runtime version validation | DevOps Team | None | CI blocks releases on schema drift |
| #142: Complete cycle detection for transform chains | Graph analysis for transforms | Runtime Team | None | Cycle detection tests passing |
| #143: Validation performance benchmarks | Caching, profiling | Performance Team | Phase 6 | Validation under 100ms for 100+ entity packs |

### 7.2 Milestones
- **Phase 2 (Weeks 2-4)**: Content DSL & Sample Pack - UNBLOCKED by this document
- **Phase 4 (Weeks 4-5)**: Save file format implementation (Issue #140)
- **Phase 5 (Weeks 5-7)**: Guild persistence schema (Issue #138)
- **Phase 6**: Performance optimization (Issue #143)
- **Phase 7+**: Scripting runtime (Issue #139)

### 7.3 Coordination Notes
All decisions documented here have been reviewed and approved. Follow-up issues should reference this document for context and rationale.

## 8. Agent Guidance & Guardrails

### Context Packets
- Content schema design document: `docs/content-dsl-schema-design.md`
- Property-based formula sanitization design: `docs/property-based-formula-sanitization-design.md`
- Content validation CLI design: `docs/content-validation-cli-design.md`
- Runtime event manifest authoring: `docs/runtime-event-manifest-authoring.md`

### Prompting & Constraints
- Always run `pnpm generate` after schema changes
- Use `pnpm generate --check` in CI to detect drift
- Commit compiled artifacts alongside source changes
- Reference issue #11 as parent for all follow-up work

### Safety Rails
- Never bypass digest verification in development mode
- Never mutate generated modules after compilation
- Always validate cross-references before committing schema changes
- Never skip property-based tests when adding formula types

### Validation Hooks

Schema coverage:
```bash
pnpm --filter @idle-engine/content-schema test -- --run createFormulaArbitrary
```

CLI coverage:
```bash
pnpm --filter @idle-engine/content-validation-cli test -- --run "validateContentPacks property"
```

## 9. Alternatives Considered

### Icon Path Generation Alternatives
| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Schema-level defaults | Consistent paths across all packs | Couples schema to presentation layer | Rejected |
| Compiler-level defaults | Flexible, deployment-aware | Requires compiler spec first | **Selected** (deferred to compiler design) |
| No defaults | Maximum flexibility | Author friction | Rejected |

### Guild Cost Model Alternatives
| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Extend schema now | Future-proof | No persistence design yet | Rejected |
| Generic cost schema | Works today | May need refactor later | **Selected** (defer to Phase 5) |
| Separate guild currency type | Type-safe | Premature optimization | Rejected |

### Scripted Modifier Alternatives
| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Add scripted effects now | Feature complete | No sandbox design | Rejected |
| Formula-only v1.0 | Safe, deterministic | Limited expressiveness | **Selected** (defer scripting to Phase 7+) |
| Hybrid (formulas + hooks) | Extensible | Complexity creep | Rejected |

### Digest Embedding Alternatives
| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Embed digest only | Fast validation | No semantic versioning | Rejected |
| Store version only | Smaller saves | Requires registry lookup | Rejected |
| Hybrid (version + digest) | Best of both | Larger saves | **Selected** |
| No embedding | Smallest saves | Cannot detect incompatibility | Rejected |

## 10. Testing & Validation Plan

### Unit / Integration
- Property-based tests for formula sanitization (formulas.property.test.ts)
- Cross-reference validation tests (integration.test.ts)
- Digest computation and verification tests
- Feature gate compatibility tests

### Performance
- Validation benchmarks: Target under 100ms for packs with 100+ entities (Issue #143)
- Large test pack creation: 500+ resources, 200+ generators
- Profiling: Cross-reference checks, formula walking, cycle detection

### Tooling
- CLI validation: `pnpm generate --check` in CI
- Structured event logging validation
- Digest mismatch detection
- Watch mode resilience

## 11. Risks & Mitigations

### Risk 1: Formula Explosion
**Status**: IMPLEMENTED

**Risk**: Recursive expression parsing may allow deeply nested structures, risking performance issues.

**Mitigation**:
- Recursion limits in `expressionNodeSchema` (formulas.ts)
- AST node count caps enforced during validation
- Property-based tests for formula sanitization (formulas.test.ts)

### Risk 2: Schema Drift vs Runtime
**Status**: PARTIALLY IMPLEMENTED

**Risk**: Runtime may evolve faster than schema updates.

**Mitigation Implemented**:
- FEATURE_GATES map runtime versions to schema modules (runtime-compat.ts:3-29)
- Validation checks `ContentSchemaOptions.runtimeVersion` compatibility
- CI validates core against schema digest (per acceptance criteria)

**Gaps**:
- No CI check enforcing that `@idle-engine/core` validates against schema before publish
- Runtime version must be manually kept in sync with FEATURE_GATES

**Action Items** (Issue #141):
- Add CI step: `pnpm --filter @idle-engine/core test:schema-compat`
- Create test ensuring core package.json version satisfies all feature gate ranges
- Add pre-publish hook blocking core releases if schema validation fails
- Document schema evolution policy

### Risk 3: Author Friction
**Status**: IMPLEMENTED

**Risk**: Strict schemas may frustrate early adopters.

**Mitigation**:
- Descriptive error messages with structured `SchemaWarning` (errors.ts)
- Non-fatal warnings for soft constraints (missing translations, steep curves)
- Severity levels (`error`, `warning`, `info`) allow progressive strictness
- `safeParse` returns warnings alongside successful parses

**Tracking**: Monitor GitHub issues for author feedback; adjust warning thresholds if patterns emerge.

### Risk 4: Compatibility Versioning
**Status**: IMPLEMENTED

**Risk**: Packs targeting older runtime versions must continue to parse.

**Mitigation**:
- FEATURE_GATES enable feature-based versioning (runtime-compat.ts)
- Metadata.engine field specifies runtime version range (metadata.ts)
- Validation allows older packs with subset of features
- Schema transforms can downgrade gracefully

**Tracking**: Add integration tests for cross-version pack loading once save migration lands (Phase 4).

### Risk 5: Transform Loops
**Status**: IMPLEMENTED

**Risk**: Misconfigured transforms may create runaway production chains.

**Mitigation**:
- Safety guards in transform schema (transforms.ts):
  - `maxRunsPerTick` caps executions per simulation step
  - `maxOutstandingBatches` limits queued batch transforms
- Validation ensures transform I/O references exist (validateCrossReferences)
- Cycle detection for unlock conditions (integration tests pending per integration.test.ts:155)

**Action Item** (Issue #142):
- Implement full cycle detection for transform chains (extend existing unlock cycle detector)
- Add integration tests for circular transform references
- Document safe transform patterns in authoring guide

### Risk 6: Performance
**Status**: DESIGN ONLY

**Risk**: Running complex validation on large content packs could be slow.

**Mitigation Planned**:
- Design recommends caching normalized results
- Lookup maps included in NormalizedContentPack (pack.ts:142-173)

**Current Performance**:
- No caching implemented yet
- No performance benchmarks exist
- No large content packs to test against

**Action Items** (Issue #143 - Phase 6):
- Implement validation result caching (memoize by pack id + version + digest)
- Add performance benchmarks for validation (target: under 100ms for packs with 100+ entities)
- Create large test pack (500+ resources, 200+ generators) for performance testing
- Profile validation bottlenecks (cross-reference checks, formula walking, cycle detection)
- Consider worker-based validation for large packs if main-thread blocking observed

## 12. Rollout Plan

### Milestones
- **Phase 2 (Weeks 2-4)**: Content DSL & Sample Pack - UNBLOCKED
- **Phase 4**: Save file format with digest migration (Issue #140)
- **Phase 5**: Guild persistence schema extension (Issue #138)
- **Phase 6**: Performance optimization and caching (Issue #143)
- **Phase 7+**: Scripting runtime and scripted effects (Issue #139)

### Migration Strategy
- Existing content packs continue to work without changes
- New features require runtime version bumps via FEATURE_GATES
- Save file migration support lands in Phase 4
- Backward compatibility maintained through feature detection

### Communication
- Decision log closes Issue #137
- Follow-up issues (#138-143) created and linked to #11
- Implementation plan updated with new backlog items
- Author documentation updated with compiler workflow guidance

## 13. Open Questions

All Section 10 open questions from the content schema design document have been resolved by this document. New questions:

| Question | Owner | Target Resolution | Status |
|----------|-------|-------------------|--------|
| Long-term maintenance of shared formula arbitraries | Content Pipeline Maintainers | Phase 2 exit (2025-11-15) | Open |
| Prestige-layer monotonicity requirements | Game Design Lead | Prestige roadmap checkpoint (2025-12-01) | Open |

## 14. Follow-Up Work

### New Issues Created
| Issue | Title | Priority | Blocking |
|-------|-------|----------|----------|
| #138 | Design guild persistence schema and extend cost model | P2 | Phase 5 |
| #139 | Scripting design document and scripted effect support | P3 | Post-prototype |
| #140 | Save file format with content pack manifests and migrations | P1 | Phase 4 |
| #141 | CI schema compatibility checks for runtime releases | P1 | Pre-v1.0 |
| #142 | Complete cycle detection for transform chains | P2 | Phase 3 |
| #143 | Validation performance benchmarks and caching | P2 | Phase 6 |

### Deferred Features
- Compiler icon resolution strategy (follow-up to compiler design)
- Guild-scoped resource ownership semantics (Phase 5)
- Scripting sandbox and security model (Phase 7+)
- Cross-version save migration registry (Phase 4)

## 15. References

### Design Documents
- Content DSL Schema Design: `docs/content-dsl-schema-design.md`
- Property-Based Formula Sanitization Design: `docs/property-based-formula-sanitization-design.md`
- Content Validation CLI Design: `docs/content-validation-cli-design.md`
- Runtime Event Manifest Authoring: `docs/runtime-event-manifest-authoring.md`
- Idle Engine Design: `docs/idle-engine-design.md`
- Implementation Plan: `docs/implementation-plan.md`

### Source Files
- Schema modules: `packages/content-schema/src/modules/`
- Formula definitions: `packages/content-schema/src/base/formulas.ts`
- Formula arbitraries: `packages/content-schema/src/base/formulas.arbitraries.ts`
- Runtime compatibility: `packages/content-schema/src/base/runtime-compat.ts`
- Pack normalization: `packages/content-schema/src/base/pack.ts`

### Test Suites
- Property-based formula tests: `packages/content-schema/src/base/formulas.property.test.ts`
- Integration tests: `packages/content-schema/src/__tests__/integration.test.ts`
- CLI property tests: `tools/content-schema-cli/src/__tests__/validation.property.test.ts`

## Appendix A - Glossary

- **Content Pack**: Declarative game content bundle (resources, generators, upgrades, etc.)
- **Digest**: Cryptographic hash (FNV-1a) of pack metadata and module lists
- **Feature Gate**: Runtime version-based feature availability check
- **Normalized Content Pack**: Validated and transformed content pack with lookup maps
- **Formula**: Structured expression for numeric calculations (linear, exponential, piecewise, etc.)
- **Schema Warning**: Structured validation message with severity (error, warning, info)
- **Transform**: Batch conversion process (inputs -> outputs with formulas)
- **Property-Based Testing**: Generative testing using fast-check arbitraries
- **Arbitrary**: fast-check generator for test data (e.g., valid formulas)

## Appendix B - Change Log

| Date | Author | Change Summary |
|------|--------|----------------|
| 2025-10-21 | Content Pipeline Team | Initial decision log addressing Section 10 open questions and Section 7 risk tracking |
| 2025-12-21 | Migration Agent | Migrated to design document template format (Issue #194) |

---

## Property-Based Formula Sanitization Guidance

Property-based suites now gate formula authoring across schema and CLI surfaces. Use the workflow below before submitting new packs or modifiers. Guidance complements `docs/property-based-formula-sanitization-design.md` and the CLI runbook in `docs/content-validation-cli-design.md`.

### Sanitization Invariants Enforced

- Formulas generated by `createFormulaArbitrary` must parse successfully and evaluate to finite, non-negative numbers across deterministic evaluation contexts
- Linear and exponential formulas are asserted to be monotonic in the `level` variable, with growth rates clamped to positive ranges even when callers provide invalid bounds
- Piecewise formulas require ordered `untilLevel` thresholds and terminate with a catch-all segment so sanitizers never fall off the range of defined pieces
- Expression arbitraries guard depth, root degree, and composed function usage so sanitizers keep results within `MAX_FORMULA_DEPTH` and preserve non-negative outputs via `max(0, ...)` guards
- Entity references are validated against sanitized pools; the CLI suite rejects packs that point to undefined resources and emits actionable `content_pack.validation_failed` payloads

### Running the Property Suites Locally

Schema coverage:
```bash
pnpm --filter @idle-engine/content-schema test -- --run createFormulaArbitrary
```

CLI coverage:
```bash
pnpm --filter @idle-engine/content-validation-cli test -- --run "validateContentPacks property"
```

Append `--watch` while iterating, and keep reporters quiet so the `vitest-llm-reporter` JSON summary remains the final console line for downstream agents.

### Troubleshooting & Replay Tips

- Both suites share `DEFAULT_FORMULA_PROPERTY_SEED = 177013` (see `packages/content-schema/src/base/formulas.arbitraries.ts`); fast-check prints the failing seed and path whenever a counterexample is found
- Copy the printed `seed` and `path` back into the local `propertyConfig` helper (or temporarily override the exported constant) to replay the failing run with `vitest`
- Inspect CLI failures via the captured `content_pack.validation_failed` event—it contains the pack slug, manifest path, and schema issues array surfaced by `ContentPackValidationError`
- Schema-side failures surface the counterexample formula in the stack trace; evaluate it with `evaluateNumericFormula` in a REPL to confirm which invariant was violated

### References for Downstream Agents

- Schema suite: `packages/content-schema/src/base/formulas.property.test.ts`
- Arbitrary definitions: `packages/content-schema/src/base/formulas.arbitraries.ts`
- CLI suite: `tools/content-schema-cli/src/__tests__/validation.property.test.ts`
- Design rationale: `docs/property-based-formula-sanitization-design.md`
