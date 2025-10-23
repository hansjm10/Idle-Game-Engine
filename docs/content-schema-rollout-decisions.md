# Content Schema Rollout: Decision Log

**Issue:** #137 (Parent: #11)
**Related Design:** docs/content-dsl-schema-design.md
**Date:** 2025-10-21
**Status:** Research Complete

This document addresses the open questions from §10 and risk mitigations from §7 of the content schema design document.

## 1. Icon Path Default Generation

**Question:** Should the schema expose calculated presentation defaults (e.g., auto-generated icon paths) or leave that to the compiler?

### Current State
- Icon fields are optional strings in all modules (resources, generators, upgrades, achievements, prestige layers, guild perks)
- Schema: `icon: z.string().trim().min(1).max(256).optional()`
- No automatic path generation or validation exists
- No convention for icon asset organization documented

### Analysis
Icon path generation involves several concerns:
1. **Asset resolution:** Paths must be resolvable at runtime (relative vs absolute, asset bundling)
2. **Convention vs configuration:** Auto-generation assumes naming conventions
3. **Build-time vs runtime:** Path resolution may depend on bundler configuration
4. **Presentation layer coupling:** Icon display is a UI concern, not a schema concern

### Decision
**Leave icon path defaults to the compiler/presentation layer.**

**Rationale:**
- Schema should remain presentation-agnostic per design principle §3 (Non-Goals)
- Asset bundling and path resolution vary by deployment (Vite, Webpack, CDN)
- Compiler can implement convention-based defaults when transforming packs
- Allows flexibility for different presentation layers (web, mobile, terminal UI)

**Action Items:**
- [ ] Document icon asset conventions in compiler specification (follow-up issue)
- [ ] Add optional `iconPath` validation to check extension types (.svg, .png, .webp)
- [ ] Consider adding `iconPathSchema` with URL validation when compiler spec lands

**Follow-up:** Create issue for DSL compiler icon resolution strategy (blocked on compiler design)

---

## 2. Guild Perk Persistence Integration

**Question:** How will guild perk costs interface with social-service data when live persistence lands?

### Current State
- Guild perk schema complete in `packages/content-schema/src/modules/guild-perks.ts`
- Social service has stub guild routes (`services/social/src/routes/guild.ts`)
- Persistence is in-memory only (Phase 5 work per implementation plan)
- No database schema exists for guild perks or guild state

### Analysis
Guild perk costs reference several potential currency types:
1. **Guild-scoped resources:** Contribution points, guild XP, treasury funds
2. **Player-scoped contributions:** Individual resource donations
3. **Time-gated unlocks:** Milestone-based availability
4. **Social metrics:** Member count, activity thresholds

Current cost schema uses generic `ContentId` references, which works for player resources but doesn't model guild-specific currencies.

### Decision
**Defer guild-specific cost modeling to Phase 5 persistence implementation.**

**Rationale:**
- Current `cost` schema is flexible enough for prototype phase (Issue #11, Phase 0-4)
- Guild persistence design is not yet finalized (Phase 5: Weeks 5-7)
- Schema can be extended with `GuildCostSchema` when social service adds persistence
- FEATURE_GATES already restrict guild perks to runtime >=0.5.0

**Immediate Actions:**
- [x] Verify guild perk `cost` schema supports `resourceId` references
- [x] Document that guild currencies must be defined as pack resources with `category: 'currency'`

**Phase 5 Follow-up (Issue #138 recommended):**
- [ ] Design guild persistence schema (Postgres tables: guilds, guild_perks, member_contributions)
- [ ] Add `GuildResourceDefinition` with ownership semantics (guild-scoped vs player-scoped)
- [ ] Extend cost schema with `scope: 'player' | 'guild'` discriminator if needed
- [ ] Add validation ensuring guild perk costs only reference guild-category resources

**Acceptance Criteria for Phase 5:**
- Social service persists guild perk unlock state
- Content packs can define guild-scoped currency resources
- Validation ensures guild perk costs reference valid guild currencies
- Documentation examples show guild contribution tracking

---

## 3. Scripted Modifiers & Effect Types

**Question:** Do we need additional effect types (e.g., scripted modifiers) before schema v1.0, or can they wait for the scripting design doc?

### Current State
Upgrade effects are discriminated unions with these variants (upgrades.ts:79-124):
- `modifyResourceRate`: Formula-based resource adjustments
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

### Analysis
**Scripting Layer Status (idle-engine-design.md §9.4):**
- "Script layer exposes deterministic APIs (no direct async)"
- "Script host provides whitelisted math/util modules and deterministic random via seeded RNG"
- No scripting design document exists yet
- Sandbox requirements not yet specified

**Current Formula Coverage:**
- Declarative formulas cover common idle game progressions (exponential scaling, piecewise curves)
- Expression AST allows complex calculations without scripting
- `script` and `flag` conditions already exist for hook points

**Gaps Requiring Scripting:**
1. Conditional logic beyond formula evaluation (complex branching)
2. State queries across multiple entities (aggregate calculations)
3. Custom effect application (e.g., randomized bonuses, combinatorial effects)
4. Event-driven behaviors (trigger chains, cascading effects)

### Decision
**Defer scripted modifiers until scripting design document and runtime sandbox land.**

**Rationale:**
- Current formula system covers prototype phase needs (Phase 0-6 in implementation-plan.md)
- Scripting requires security sandbox design (idle-engine-design.md §13: "Sandbox third-party scripts")
- Feature gate model supports incremental rollout (runtime-compat.ts FEATURE_GATES)
- No content pack has requested scripted modifiers yet

**Schema v1.0 Requirements (Satisfied):**
- ✅ Formula-based modifiers for common progressions
- ✅ Flag/script condition hooks for extensibility
- ✅ Event emission for trigger chains
- ✅ Effect composition via upgrade stacking

**Phase 7+ Follow-up (Issue #139 recommended):**
- [ ] Author scripting design document (sandbox model, API surface, determinism guarantees)
- [ ] Implement script runtime with deterministic execution
- [ ] Add `scriptedEffect` upgrade effect type:
  ```typescript
  {
    kind: 'scriptedEffect';
    scriptId: ScriptId;
    payload?: Record<string, unknown>;
  }
  ```
- [ ] Update FEATURE_GATES with `scriptedEffects` introduced in appropriate version
- [ ] Add content-schema validation ensuring scriptId references allowlisted scripts

**Acceptance Criteria for Scripted Modifiers:**
- Scripting design doc approved and sandbox implemented
- Script execution is deterministic (seeded RNG, no async)
- Scripts cannot access DOM or host environment
- Validation enforces script allowlists per ContentSchemaOptions

---

## 5. Compiler Adoption & Troubleshooting

**Status:** The content compiler now emits deterministic artifacts during `pnpm generate`, and `@idle-engine/content-sample` imports the generated module instead of reparsing `content/pack.json`.

- **Required workflow:** `pnpm generate` validates every discovered pack before the compiler writes artifacts. After editing any pack JSON, schema file, or runtime event manifest, run `pnpm generate` (or `pnpm generate --check` for CI/Lefthook) and commit the resulting updates under `content/compiled/`, `src/generated/`, and the workspace summary (`content/compiled/index.json`).
- **Structured logging:** The CLI emits JSON events (`content_pack.validated`, `content_pack.validation_failed`, `content_pack.compiled`, `content_pack.pruned`, `watch.run`, etc.) that automation should parse instead of scraping console text. Watch mode keeps the process alive across failures while still surfacing non-zero exit codes on termination.
- **Summary contract:** Treat `content/compiled/index.json` (or the path supplied via `--summary`) as the canonical record of validation and compilation outcomes. If validation fails or `pnpm generate --check` indicates drift, the summary is stale—rerun the command before using compiled artifacts downstream.
- **Runtime guarantees:** The generated module rehydrates a frozen `NormalizedContentPack`, exposes digest, artifact hash, module indices, and summary metadata, and fails fast if the compiler captured warnings. Downstream code should consume the exported summary (`sampleContentSummary`) instead of inferring metadata at runtime.
- **Digest verification:** `rehydrateNormalizedPack` recomputes the digest whenever `NODE_ENV !== 'production'`. To diagnose mismatches, rerun `pnpm generate --clean` and compare the hash reported in the thrown error with `content/compiled/sample-pack.normalized.json`. Production builds may opt out of digest verification by keeping `NODE_ENV=production`, preserving the previous behaviour.
- **Common failures:**  
  - *Import-time warning error*: fix schema warnings surfaced in the compiler log or add contextual suppressions before retrying.  
  - *Digest mismatch*: ensure artifacts were regenerated (use `pnpm generate --clean`), verify custom post-processing didn’t mutate the generated module, and re-run tests.  
  - *Stale summary*: if `content/compiled/index.json` (or a custom summary path) reports outdated versions or warning counts, rerun `pnpm generate` so validation and compilation refresh the summary before committing artifacts.

---

## 4. Schema Digest Migration Strategy

**Question:** What is the migration strategy when schema digests change (e.g., do we embed the digest into save files similar to event manifests)?

### Current State
**Digest Implementation (pack.ts:381-404):**
- FNV-1a hash of pack metadata + module id lists
- Format: `{ version: number; hash: string }` (e.g., `fnv1a-a3c2f1b8`)
- Digest version: `CONTENT_PACK_DIGEST_VERSION = 1`
- Computed during `normalizeContentPack`, included in `NormalizedContentPack.digest`

**Runtime Event Manifest Approach (runtime-event-manifest-authoring.md:38-43):**
- Manifest hash embedded in event frames for replay validation
- Hash checked during recording and playback
- Failures trigger "rerun pnpm generate" guidance
- Deterministic hash ensures replay integrity

**Save System Status (implementation-plan.md Phase 4):**
- Phase 4: "Implement save slot manager (IndexedDB/localStorage) with migration hooks"
- Versioned schemas mentioned in design (idle-engine-design.md:35,137)
- No save format specification exists yet
- Migration pipeline not yet designed

### Analysis
**Digest Use Cases:**
1. **Content pack versioning:** Track which pack version produced the save
2. **Compatibility checking:** Detect when content has changed
3. **Migration triggering:** Know when save data needs transformation
4. **Replay validation:** Ensure deterministic behavior (like event manifest)

**Embedding Trade-offs:**

| Approach | Pros | Cons |
|----------|------|------|
| Embed digest in saves | Fast compatibility checks; no external lookups; supports offline validation | Save size increase; digest changes break compatibility even for safe content updates |
| Store pack version only | Smaller saves; semantic versioning for compatibility | Requires pack registry lookup; version bumps may be infrequent |
| Hybrid (version + digest) | Best of both; version for coarse checks, digest for exact match | Larger saves; more complex validation logic |
| No embedding | Smallest saves; validation on load | Cannot detect incompatibility before hydration; may corrupt state |

### Decision
**Embed both pack version AND digest in save files (hybrid approach).**

**Rationale:**
- Pack version (semver) enables human-readable compatibility decisions
- Digest provides cryptographic-strength change detection like event manifests
- Supports offline validation (no registry lookup needed)
- Enables granular migration decisions (version -> which migration steps, digest -> exact content state)
- Aligns with runtime event manifest pattern (proven approach)

**Proposed Save Format Extension:**
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

**Migration Decision Tree:**
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

**Implementation Actions (Issue #140 recommended - Phase 4):**
- [ ] Design save file format with content pack manifests
- [ ] Implement save metadata serialization including digests
- [ ] Add migration registry (packId + version range -> migration functions)
- [ ] Create `validateSaveCompatibility(save, installedPacks)` utility
- [ ] Document migration authoring guide for content pack maintainers
- [ ] Add tests for cross-version save loading

**Edge Cases to Handle:**
- **Pack removed:** User uninstalls pack but has save referencing it (warning + option to continue with missing content)
- **Digest mismatch, same version:** Content changed without version bump (warn but allow, or force version bump in CI)
- **Multiple packs, cascading dependencies:** Validate dependency graph before migration (see dependencies.ts)
- **Partial migration failure:** Rollback or fallback strategy (atomic migration transactions)

**Acceptance Criteria:**
- Save files include content pack manifests with versions and digests
- Loading a save checks compatibility before hydration
- Incompatible saves trigger migration flow with user consent
- Migrations can be tested independently via fixtures
- Documentation includes migration authoring examples

---

## 5. Risk Mitigation Tracking

Review of risks from §7 and their current mitigation status:

### 5.1 Formula Explosion
**Risk:** Recursive expression parsing may allow deeply nested structures, risking performance issues.

**Mitigation Status:** ✅ **IMPLEMENTED**
- Recursion limits in `expressionNodeSchema` (formulas.ts)
- AST node count caps enforced during validation
- Property-based tests for formula sanitization (formulas.test.ts)

**Tracking:** No additional action needed; covered by existing tests.

---

### 5.2 Schema Drift vs Runtime
**Risk:** Runtime may evolve faster than schema updates.

**Mitigation Status:** ⚠️ **PARTIALLY IMPLEMENTED**
- FEATURE_GATES map runtime versions to schema modules (runtime-compat.ts:3-29)
- Validation checks `ContentSchemaOptions.runtimeVersion` compatibility
- CI validates core against schema digest (per acceptance criteria §9)

**Gaps:**
- No CI check enforcing that `@idle-engine/core` validates against schema before publish
- Runtime version must be manually kept in sync with FEATURE_GATES

**Action Items (Issue #141 recommended):**
- [ ] Add CI step: `pnpm --filter @idle-engine/core test:schema-compat`
- [ ] Create test ensuring core package.json version satisfies all feature gate ranges
- [ ] Add pre-publish hook blocking core releases if schema validation fails
- [ ] Document schema evolution policy (when to bump FEATURE_GATES, how to coordinate with runtime releases)

---

### 5.3 Author Friction
**Risk:** Strict schemas may frustrate early adopters.

**Mitigation Status:** ✅ **IMPLEMENTED**
- Descriptive error messages with structured `SchemaWarning` (errors.ts)
- Non-fatal warnings for soft constraints (missing translations, steep curves)
- Severity levels (`error`, `warning`, `info`) allow progressive strictness
- `safeParse` returns warnings alongside successful parses

**Tracking:** Monitor GitHub issues for author feedback; adjust warning thresholds if patterns emerge.

---

### 5.4 Compatibility Versioning
**Risk:** Packs targeting older runtime versions must continue to parse.

**Mitigation Status:** ✅ **IMPLEMENTED**
- FEATURE_GATES enable feature-based versioning (runtime-compat.ts)
- Metadata.engine field specifies runtime version range (metadata.ts)
- Validation allows older packs with subset of features
- Schema transforms can downgrade gracefully (design §7)

**Tracking:** Add integration tests for cross-version pack loading once save migration lands (Phase 4).

---

### 5.5 Transform Loops
**Risk:** Misconfigured transforms may create runaway production chains.

**Mitigation Status:** ✅ **IMPLEMENTED**
- Safety guards in transform schema (transforms.ts):
  - `maxRunsPerTick` caps executions per simulation step
  - `maxOutstandingBatches` limits queued batch transforms
- Validation ensures transform I/O references exist (validateCrossReferences)
- Cycle detection for unlock conditions (integration tests pending per integration.test.ts:155)

**Tracking:** Complete cycle detection implementation (currently TODO comment in integration.test.ts).

**Action Item (Issue #142 recommended):**
- [ ] Implement full cycle detection for transform chains (extend existing unlock cycle detector)
- [ ] Add integration tests for circular transform references
- [ ] Document safe transform patterns in authoring guide

---

### 5.6 Performance
**Risk:** Running complex validation on large content packs could be slow.

**Mitigation Status:** ⚠️ **DESIGN ONLY**
- Design recommends caching normalized results (§7)
- Lookup maps included in NormalizedContentPack (pack.ts:142-173)

**Current Performance:**
- No caching implemented yet
- No performance benchmarks exist
- No large content packs to test against

**Action Items (Issue #143 recommended - Phase 6):**
- [ ] Implement validation result caching (memoize by pack id + version + digest)
- [ ] Add performance benchmarks for validation (target: under 100ms for packs with 100+ entities)
- [ ] Create large test pack (500+ resources, 200+ generators) for performance testing
- [ ] Profile validation bottlenecks (cross-reference checks, formula walking, cycle detection)
- [ ] Consider worker-based validation for large packs if main-thread blocking observed

---

## 6. Summary & Recommendations

### Decisions Made
1. ✅ **Icon defaults:** Leave to compiler/presentation layer
2. ✅ **Guild persistence:** Defer to Phase 5, extend schema then
3. ✅ **Scripted modifiers:** Defer until scripting design + sandbox land
4. ✅ **Digest migration:** Embed version + digest in save files (hybrid approach)
5. ✅ **Risk tracking:** Most mitigations implemented; gaps documented below

### New Issues to Create
| Issue | Title | Priority | Blocking |
|-------|-------|----------|----------|
| #138 | Design guild persistence schema and extend cost model | P2 | Phase 5 |
| #139 | Scripting design document and scripted effect support | P3 | Post-prototype |
| #140 | Save file format with content pack manifests and migrations | P1 | Phase 4 |
| #141 | CI schema compatibility checks for runtime releases | P1 | Pre-v1.0 |
| #142 | Complete cycle detection for transform chains | P2 | Phase 3 |
| #143 | Validation performance benchmarks and caching | P2 | Phase 6 |

### Phase 2 Unblocked
Content schema is ready for production use in Phase 2 (Content DSL & Sample Pack, Weeks 2-4). Remaining work items are follow-ups for later phases or post-prototype features.

### Traceability to Issue #11
This decision log addresses:
- ✅ Section 10 open questions (all 4 questions + migration clarification)
- ✅ Section 7 risk mitigations (tracking status for all 6 risks)
- ✅ Acceptance criteria: Decision log exists with recommendations
- ✅ Findings linked back to parent issue #11 via references and new issue tracking

### Next Actions
1. Create tracking issues (#138-143) with details from this document
2. Link new issues to #11 as dependencies
3. Update implementation-plan.md Phase 5+ backlog with new tasks
4. Close issue #137 referencing this decision log
