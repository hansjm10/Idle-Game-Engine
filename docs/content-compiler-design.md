---
title: Content Compiler Design
sidebar_position: 4
---

# Content Compiler Design

Use this template when authoring new design proposals or retrofitting existing notes. Fill out every section or state explicitly why it is not applicable. Replace bracketed guidance with project-specific detail before submitting for review. The structure is optimised for an AI-first delivery model where work is decomposed into issues and executed by autonomous agents under human orchestration.

## Document Control
- **Title**: Introduce Deterministic Content Pack Compilation
- **Authors**: Content Pipeline Team
- **Reviewers**: N/A
- **Status**: Design
- **Last Updated**: 2025-10-22
- **Related Issues**: #159, #12
- **Execution Mode**: AI-led

## 1. Summary
The content compiler transforms validated content packs into deterministic, runtime-ready artifacts (normalized JSON and TypeScript modules) to eliminate redundant parsing, enable integrity verification, and unlock downstream tooling without bundling the full schema implementation. This design introduces `@idle-engine/content-compiler` to orchestrate discovery, compilation, atomic artifact emission, and structured logging, integrating into `pnpm generate` with watch mode, check mode, and clean-build support.

## 2. Context & Problem Statement
- **Background**: The content DSL distributed through `@idle-engine/content-schema` already returns fully normalized `NormalizedContentPack` objects, yet every consumer still reparses authoring JSON at runtime. Each import of `packages/content-sample` calls `parseContentPack`, rebuilding lookup maps and re-running validation. The CLI (`tools/content-schema-cli/src/generate.js`) only validates packs while generating the runtime event manifest, and automation has no way to assert that generated artifacts match what is committed. Missing compiler outputs also block downstream tooling from consuming packs without pulling in the schema bundle.
- **Problem**: Issue #12 unlocks the compiler stage of the content pipeline. With the schema in place, packs must be transformed into deterministic runtime-ready artifacts so the engine and tooling never depend on ad-hoc TypeScript exports.
- **Forces**: Artifacts must be deterministic (byte-identical across runs), atomic (avoid torn files on crash), and verifiable (support `--check` mode for CI). Compilation must integrate seamlessly into existing workflows without breaking watch mode or incremental builds.

## 3. Goals & Non-Goals
- **Goals**:
  - Compile each discovered pack into a deterministic `SerializedNormalizedContentPack` plus an `artifactHash` so mutations can be detected without revalidation.
  - Publish `@idle-engine/content-compiler` with a Node entrypoint for the CLI and a browser-safe runtime entrypoint for consumers that only need rehydration helpers.
  - Fold compilation into `pnpm generate` so validation, manifest regeneration, and compilation happen in one command that supports watch mode, `--check`, and `--clean`.
  - Emit TypeScript modules and JSON artifacts that runtime packages import instead of calling `parseContentPack`, while exposing digests, warning metadata, and positional indices.
  - Surface structured JSON log events that follow data-pipeline logging best practices, enabling CI and observability tooling to gate builds on compiler health.
  - Track discovery metadata and prune stale outputs so committed artifacts align with the set of packs in `packages/*/content/`.
- **Non-Goals**:
  - Pre-evaluating or optimizing pack formulas into bytecode; formula execution remains a runtime responsibility (`docs/runtime-step-lifecycle.md`).
  - Shipping content balance heuristics, localization exports, or asset bundling flows.
  - Producing bespoke binary assets; JSON and TypeScript output is sufficient for this milestone.
  - Replacing the runtime event manifest generator or altering digest semantics defined by the schema package.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Content Pipeline Team
- **Agent Roles**:
  - Docs Agent: Migrate design document to template format, update onboarding guides.
  - Runtime Implementation Agent: Implement compiler package, CLI integration, and test coverage.
- **Affected Packages/Services**:
  - `packages/content-compiler` (new)
  - `packages/content-schema` (runtime-helpers export)
  - `packages/content-sample` (consumer migration)
  - `tools/content-schema-cli` (compile command integration)
- **Compatibility Considerations**: Generated modules must remain compatible with both Node and browser runtimes. `formatVersion` changes require coordinated runtime updates to prevent rehydration failures.

## 5. Current State
- `packages/content-sample/src/index.ts` now imports the compiler's generated module (`src/generated/@idle-engine/sample-pack.generated.ts`), re-exporting the rehydrated pack alongside digest, summary, and module indices. Earlier revisions called `parseContentPack` on `content/pack.json` during import, re-running schema validation for every consumer.
- `tools/content-schema-cli/src/generate.js` builds the runtime event manifest and validates packs but does not write pack-level artifacts or logs.
- No package currently writes `content/compiled/` or `src/generated/` outputs; a search for those directories under `packages/` returns nothing.
- There is no shared digest registry, and Lefthook cannot assert that authored JSON matches committed outputs because none exist yet.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: `@idle-engine/content-compiler` orchestrates pack discovery, validation, serialization, and artifact emission. The compiler scans `packages/*/content/pack.json`, topologically sorts packs by dependencies, validates each using the existing schema, serializes normalized packs to canonical JSON and TypeScript modules, and emits a workspace summary at the repository root. Atomic writes prevent torn files, and `--check` mode enables CI drift detection without modifying outputs.
- **Diagram**: N/A (consider adding system diagram in future iteration)

### 6.2 Detailed Design
- **Runtime Changes**: Runtime packages import generated TypeScript modules instead of calling `parseContentPack` at startup. Rehydration rebuilds lookup maps and freezes arrays without re-running schema validation. Generated modules conditionally verify digests in non-production environments to catch corruption early.
- **Data & Schemas**:
  - `SerializedNormalizedContentPack` captures normalized modules, metadata, warnings, digest, and `artifactHash` in a frozen shape with `formatVersion: 1`.
  - `ContentDocument` wraps each discovered pack with absolute path, POSIX-relative path, slug, and parsed JSON.
  - `ModuleIndexTables` provides immutable maps from module IDs to array offsets.
  - RFC-8785 canonical JSON ensures byte-identical serialization across runs.
- **APIs & Contracts**:
  - `compileContentPack(document: ContentDocument, options: CompileOptions): Promise<PackArtifactResult>` – compile a single document and return artifact buffers plus metadata.
  - `compileWorkspacePacks(fs: WorkspaceFS, options: CompileWorkspaceOptions): Promise<WorkspaceCompileResult>` – orchestrate discovery, compilation, pruning, logging, and summary emission for all packs.
  - `rehydrateNormalizedPack(serialized: SerializedNormalizedContentPack, options?: RehydrateOptions): NormalizedContentPack` – rebuild lookup structures in browser or server runtimes.
  - `createModuleIndices(pack: NormalizedContentPack): Readonly<ModuleIndexTables>` – derive positional indices from frozen module arrays.
- **Tooling & Automation**:
  - `tools/content-schema-cli` gains a `compile` command and integrates compilation into `pnpm generate`.
  - `--watch` uses `chokidar` to observe authoring JSON and schema inputs, debouncing writes and ignoring compiler-owned outputs.
  - `--check` recompiles without writing files and exits with status 1 if any artifact would change.
  - `--clean` invalidates cached comparisons and forces rewrites.
  - Lefthook gains a `content` hook running `pnpm generate --check` to guard against stale artifacts before commit.

### 6.3 Operational Considerations
- **Deployment**: No CI/CD changes required beyond adding `pnpm generate --check` to the verification step. Nightly determinism checks rerun `--check` twice (incremental vs clean) and compare summary hashes.
- **Telemetry & Observability**: Structured JSON log events (`content_pack.compiled`, `content_pack.compilation_failed`, `content_pack.skipped`, `content_pack.pruned`) include slug, duration, warning counts, and artifact paths. Validation emits `content_pack.validated` / `.validation_failed` before compilation for end-to-end correlation.
- **Security & Compliance**: N/A (no PII handling; compiler operates on local workspace content only)

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(content-compiler): scaffold package foundations | Scaffold `packages/content-compiler`, add build tooling, exports map, baseline tests | Runtime Implementation Agent | Doc approval | Package builds; exports map verified; unit tests pass |
| feat(content-schema): add runtime-helpers export | Add `runtime-helpers` export with shared digest utilities | Runtime Implementation Agent | Package scaffold | Export available; digest helpers tested |
| feat(content-compiler): implement discovery and single-pack compilation | Implement discovery, context preparation, single-pack compilation APIs | Runtime Implementation Agent | Runtime helpers | Discovery returns `ContentDocument`; single pack compiles |
| feat(content-compiler): implement artifact emitters | Implement canonical JSON and TypeScript emitters with stable ordering, atomic writes | Runtime Implementation Agent | Single-pack compilation | Emitters produce RFC-8785 JSON; atomic rename verified |
| feat(content-schema-cli): integrate compiler command | Extend CLI with compile command, integrate logs, update `pnpm generate` | Runtime Implementation Agent | Artifact emitters | `pnpm generate` runs validation then compilation; logs emit |
| feat(content-compiler): implement check/clean modes | Implement `--check`, `--clean`, artifact pruning | Runtime Implementation Agent | CLI integration | `--check` detects drift; `--clean` forces rewrites |
| feat(content-compiler): implement watch mode | Implement watch mode with debounced recompilation | Runtime Implementation Agent | Check/clean modes | Watch detects changes; ignores generated outputs |
| chore(content-sample): migrate to generated artifacts | Update `packages/content-sample` to import generated modules | Runtime Implementation Agent | Compiler command | Runtime no longer calls `parseContentPack` at import |
| docs: update content pipeline documentation | Backfill docs with compiler usage and troubleshooting | Docs Agent | Sample migration | Documentation updated; onboarding complete |

### 7.2 Milestones
- **Phase 1 - Package Foundations**: Scaffold `packages/content-compiler`, add `runtime-helpers` export to `@idle-engine/content-schema`, implement discovery and single-pack compilation APIs. Target: Week 1.
- **Phase 2 - Artifact Emitters & CLI Wiring**: Implement canonical JSON and TypeScript emitters, extend CLI, persist warnings, implement `--check`/`--clean`, add Lefthook hook. Target: Week 2-3.
- **Phase 3 - Developer Experience & Adoption**: Implement watch mode, migrate `packages/content-sample`, backfill documentation. Target: Week 4.

### 7.3 Coordination Notes
- **Hand-off Package**: Compiler design doc, schema package source, CLI source, sample package import pattern.
- **Communication Cadence**: Weekly status updates; review checkpoints at end of each phase; escalate blocking issues to Content Pipeline Team immediately.

## 8. Agent Guidance & Guardrails
- **Context Packets**: Load `docs/content-dsl-schema-design.md`, `docs/content-schema-rollout-decisions.md`, `docs/idle-engine-design.md` §6.2, `docs/runtime-command-queue-design.md` §13. Review `packages/content-schema/src/pack.ts` and `tools/content-schema-cli/src/generate.js` before implementation.
- **Prompting & Constraints**: Use conventional commit format (`feat(content-compiler):`, `chore(content-sample):`, `docs:`). All generated modules must include header comment: `// Generated by @idle-engine/content-compiler - DO NOT EDIT`. Follow RFC-8785 for canonical JSON; use `fs.rename` for atomic writes.
- **Safety Rails**: Do not modify `packages/content-schema/src/pack.ts` digest logic. Do not remove existing `parseContentPack` tests until migration is complete. Never commit compiled artifacts without corresponding authored JSON changes.
- **Validation Hooks**: Run `pnpm test` and `pnpm lint` before marking tasks complete. Verify `pnpm generate --check` exits 0 on clean workspace and 1 after manual artifact edits.

## 9. Alternatives Considered
- **In-memory compilation without artifacts**: Rejected because downstream tooling (docs, automation) needs stable JSON outputs, and CI cannot verify drift without committed artifacts.
- **Binary artifact format**: Rejected for this milestone; JSON and TypeScript provide sufficient performance and debuggability. Binary formats deferred to future optimization pass.
- **Per-module JSON files** (e.g., `resources.json`, `generators.json`): Rejected to minimize file proliferation; consolidated pack payload is sufficient, and the workspace summary provides cross-pack indexing.
- **Formula precomputation during compilation**: Deferred to future optimization; formula execution remains a runtime responsibility per `docs/runtime-step-lifecycle.md`.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Compiler unit tests (`compiler.test.ts`, `artifacts.test.ts`) verify discovery, serialization, atomic writes, and determinism.
  - CLI integration tests verify `--check`, `--clean`, `--watch`, and log event emission.
  - Rehydration tests verify digest verification and lookup map reconstruction.
  - Coverage expectation: 90% for compiler core, 80% for CLI integration.
- **Performance**:
  - Benchmark compilation time for sample pack (target: `<100ms` on warm runs).
  - Benchmark rehydration time for sample pack (target: `<10ms`).
  - Verify consecutive runs skip rewrites when inputs unchanged.
- **Tooling / A11y**: N/A (no UI components)

## 11. Risks & Mitigations
- **Risk**: Compilation breaks watch mode or incremental builds.
  - **Mitigation**: `--watch` ignores compiler-owned outputs (`**/content/compiled/**`, `**/src/generated/*.generated.ts`). Emitters skip rewrites when bytes match. Test watch mode in CI.
- **Risk**: Digest mismatches between schema and compiler.
  - **Mitigation**: Compiler defers to `createContentPackDigest` from `runtime-helpers` export. Nightly determinism checks verify digest stability.
- **Risk**: Stale artifacts merged to main.
  - **Mitigation**: Lefthook runs `pnpm generate --check` pre-commit. CI runs same check in verify step. PR reviewers verify compiled artifacts changed when authoring JSON changed.
- **Risk**: Formula precomputation blockers emerge.
  - **Mitigation**: Non-goal for this milestone; deferred to future optimization pass once compiler is stable.

## 12. Rollout Plan
- **Milestones**: See §7.2 (Phase 1-3 over 4 weeks).
- **Migration Strategy**:
  - Phase 1: Scaffold compiler, no runtime changes.
  - Phase 2: Emit artifacts, add Lefthook hook, no consumer migration yet.
  - Phase 3: Migrate `packages/content-sample` to generated modules; other consumers follow in subsequent PRs.
  - Backward compatibility: Existing `parseContentPack` imports remain functional during migration; remove only after all consumers migrated.
- **Communication**: Announce compiler availability in #content-pipeline. Update onboarding docs. Add troubleshooting guide for common `--check` failures.

## 13. Open Questions
1. **Formula precomputation:** Is there value in capturing precomputed coefficients for common formula types during compilation, or should that remain a separate optimization pass?
2. **Artifact granularity:** Do documentation tools need per-module JSON (e.g., `resources.json`) in addition to the consolidated pack payload?
3. **Bundle outputs:** Should the compiler emit optional multi-pack bundles (e.g., seasonal content sets), or is the workspace summary sufficient for the current roadmap?

## 14. Follow-Up Work
- Artifact hash verification during rehydration (tracked in #159).
- Canonical serializer upgrades when `formatVersion` increments (tracked in #159).
- Binary artifact format exploration (deferred pending performance benchmarks).
- Per-module JSON emitters if documentation tooling requires them (pending stakeholder feedback).
- Formula precomputation optimization pass (pending runtime profiling).

## 15. References
- `docs/content-dsl-schema-design.md`
- `docs/content-schema-rollout-decisions.md`
- `docs/idle-engine-design.md` §6.2
- `docs/runtime-command-queue-design.md` §13
- `tools/content-schema-cli/src/generate.js`
- `packages/content-schema/src/pack.ts`
- `packages/content-sample/src/index.ts`
- [Unity Incremental Build Pipeline](https://docs.unity3d.com/Manual/incremental-build-pipeline.html)
- [Practical Hash IDs (Cowboy Programming)](https://cowboyprogramming.com/2007/01/04/practical-hash-ids/)
- [Deterministic builds with clang and lld](https://blog.llvm.org/2019/11/deterministic-builds-with-clang-and-lld.html)
- [Best Practices for Analyzing Logs in Data Pipelines](https://blog.dreamfactory.com/best-practices-for-analyzing-logs-in-data-pipelines)
- [9 Logging Best Practices You Should Know](https://www.dash0.com/guides/logging-best-practices)
- [Atomic file creation with temporary files](https://yakking.branchable.com/posts/atomic-file-creation-tmpfile/)
- [IPython Cookbook - Resolving dependencies in a directed acyclic graph with a topological sort](https://ipython-books.github.io/143-resolving-dependencies-in-a-directed-acyclic-graph-with-a-topological-sort/)
- [Engine Internals: Content Pipeline](https://medium.com/@heinapurola/engine-internals-content-pipeline-1af34a117f1)
- [Deterministic build systems](https://reproducible-builds.org/docs/deterministic-build-systems/)
- [What Is a Single Source of Truth?](https://maddevs.io/glossary/single-source-of-truth/)
- [Should the browser consider an import.meta.env object?](https://discourse.wicg.io/t/should-the-browser-consider-an-import-meta-env-object/4522/)

## Appendix A — Glossary
- **Artifact Hash**: SHA-256 hash of the RFC-8785 canonical JSON representation of a `SerializedNormalizedContentPack`, used to detect corruption or stale build outputs.
- **Content Pack**: A collection of game content modules (resources, generators, upgrades, etc.) defined in authoring JSON and compiled into normalized runtime artifacts.
- **Digest**: Schema-defined content identity hash used for dependency tracking and change detection (distinct from artifact hash).
- **Rehydration**: Process of reconstructing lookup maps and freezing arrays from serialized pack data without re-running schema validation.
- **RFC-8785**: JSON Canonicalization Scheme ensuring byte-identical serialization across implementations.
- **SerializedNormalizedContentPack**: Frozen, serializable representation of a validated content pack including metadata, modules, warnings, digest, and artifact hash.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-22 | Content Pipeline Team | Initial draft |
| 2025-12-21 | Docs Agent | Migrated to design document template format |

---

## Package Layout & Ownership

`@idle-engine/content-compiler` will live in `packages/content-compiler` and provide two public entrypoints:

- `index.ts` (Node-only) exposes compiler APIs and filesystem helpers.
- `runtime.ts` (browser-safe) exposes rehydration utilities without importing `node:` modules so web bundles stay lean.

Planned layout:

```
packages/content-compiler/
  package.json
  src/
    index.ts
    runtime.ts
    compiler/
      pipeline.ts
      context.ts
    artifacts/
      json.ts
      module.ts
      summary.ts
    fs/
      discovery.ts
      writer.ts
    hashing.ts
    logging.ts
    types.ts
    __tests__/
      compiler.test.ts
      artifacts.test.ts
```

`package.json` publishes an explicit `exports` map to prevent bundlers from pulling Node code into browser builds:

```json
{
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./runtime": { "import": "./dist/runtime.js", "types": "./dist/runtime.d.ts" },
    "./package.json": "./package.json"
  }
}
```

To share digest logic without bundling the full schema implementation, `@idle-engine/content-schema` now publishes a `runtime-helpers` export that surfaces `createContentPackDigest`, freeze helpers, and associated types. The compiler package depends on that entrypoint so hashing stays consistent across the workspace. Splitting orchestration from artifact emitters mirrors the manifest-driven content pipeline described in [Engine Internals: Content Pipeline](https://medium.com/@heinapurola/engine-internals-content-pipeline-1af34a117f1).

## Public API Surface

`@idle-engine/content-compiler` will export:

- `compileContentPack(document: ContentDocument, options: CompileOptions): Promise<PackArtifactResult>` – compile a single document and return artifact buffers plus metadata.
- `compileWorkspacePacks(fs: WorkspaceFS, options: CompileWorkspaceOptions): Promise<WorkspaceCompileResult>` – orchestrate discovery, compilation, pruning, logging, and summary emission for all packs.
- `rehydrateNormalizedPack(serialized: SerializedNormalizedContentPack, options?: RehydrateOptions): NormalizedContentPack` – rebuild lookup structures in browser or server runtimes.
- `createModuleIndices(pack: NormalizedContentPack): Readonly<ModuleIndexTables>` – derive positional indices from frozen module arrays.
- Types for `ContentDocument`, `SerializedNormalizedContentPack`, `CompileLogEvent`, and `WorkspaceSummary`.

`ModuleIndexTables` is defined as:

```ts
export interface ModuleIndexTables {
  readonly resources: ReadonlyMap<string, number>;
  readonly generators: ReadonlyMap<string, number>;
  readonly upgrades: ReadonlyMap<string, number>;
  readonly metrics: ReadonlyMap<string, number>;
  readonly achievements: ReadonlyMap<string, number>;
  readonly automations: ReadonlyMap<string, number>;
  readonly transforms: ReadonlyMap<string, number>;
  readonly prestigeLayers: ReadonlyMap<string, number>;
  readonly guildPerks: ReadonlyMap<string, number>;
  readonly runtimeEvents: ReadonlyMap<string, number>;
}
```

`createModuleIndices` preserves the ordering of the serialized module arrays, so each map's numeric value matches the zero-based offset in the corresponding array.

## Compilation Workflow

1. **Discover packs** – scan `packages/*/content/pack.json`, mirroring the manifest generator's discovery rules. Each file becomes a `ContentDocument` with absolute path, POSIX-relative path, slug (derived from `metadata.id`), and parsed JSON:

   ```ts
   interface ContentDocument {
     readonly absolutePath: string;
     readonly relativePath: string;
     readonly packSlug: string;
     readonly document: unknown;
   }
   ```

   Duplicate slugs emit a `content_pack.compilation_failed` event and abort the run before any artifacts are written so collisions cannot clobber outputs. Discovery also records every `metadata.id` and source path in a collision registry used later when verifying digests, following the hash-audit guidance in [Practical Hash IDs](https://cowboyprogramming.com/2007/01/04/practical-hash-ids/).

2. **Prepare context** – reuse the manifest definitions that `tools/content-schema-cli` already constructs to populate `ContentSchemaOptions` (`runtimeEventCatalogue`, `knownPacks`, `activePackIds`). The CLI passes these definitions to the compiler so consumers do not import `GENERATED_RUNTIME_EVENT_DEFINITIONS` directly.

3. **Validate and normalize** – call `parseContentPack(document, options)` exactly once per pack. Persist both the returned `NormalizedContentPack` and the `warnings` array so downstream steps can surface severities without re-running schema logic.

4. **Serialize to compiled payloads** – convert each `NormalizedContentPack` into a serializable shape:

   ```ts
   interface SerializedNormalizedContentPack {
     readonly formatVersion: 1;
     readonly metadata: NormalizedMetadata;
     readonly warnings: readonly SerializedContentSchemaWarning[];
     readonly modules: {
       readonly resources: readonly NormalizedResource[];
       readonly generators: readonly NormalizedGenerator[];
       readonly upgrades: readonly NormalizedUpgrade[];
       readonly metrics: readonly NormalizedMetric[];
       readonly achievements: readonly NormalizedAchievement[];
       readonly automations: readonly NormalizedAutomation[];
       readonly transforms: readonly NormalizedTransform[];
       readonly prestigeLayers: readonly NormalizedPrestigeLayer[];
       readonly guildPerks: readonly NormalizedGuildPerk[];
       readonly runtimeEvents: readonly NormalizedRuntimeEventContribution[];
     };
     readonly digest: NormalizedContentPack['digest'];
     readonly artifactHash: string;
   }
  ```

   `SerializedContentSchemaWarning` copies the schema warning properties onto plain data objects so JSON consumers can read them without prototype baggage. Lookup maps and positional indices are intentionally excluded; they are regenerated during rehydration to preserve referential identity.
   Dependency data remains anchored in `metadata.dependencies` so there is a single source of truth for downstream tooling ([What Is a Single Source of Truth?](https://maddevs.io/glossary/single-source-of-truth/)).

5. **Emit artifacts** – hand each payload to dedicated emitters that produce:
   - Canonical JSON: `packages/<pack>/content/compiled/<packSlug>.normalized.json`.
   - Generated modules: `packages/<pack>/src/generated/<packSlug>.generated.ts`.
   - Workspace summary: `<repo>/content/compiled/index.json`.

   Before writing, the compiler compares the current discovery set against existing artifacts and removes any JSON/TypeScript files for packs that disappeared so stale outputs do not linger. Writes go through a temporary file in the target directory followed by an atomic rename to avoid torn files, per the recommendations in [Atomic file creation with temporary files](https://yakking.branchable.com/posts/atomic-file-creation-tmpfile/). If the newly generated bytes match what already exists, the writer skips the rename entirely to minimize churn and keep incremental builds fast, aligning with Unity's incremental pipeline guidance ([Unity Incremental Build Pipeline](https://docs.unity3d.com/Manual/incremental-build-pipeline.html)).

   If `compileContentPack` throws or returns a failure state, the compiler deletes any existing `content/compiled/<slug>.normalized.json` and `src/generated/<slug>.generated.ts` artifacts before moving on. A `--check` run surfaces the removal as a drift so CI fails visibly, and the workspace summary records the failure to stop automation from silently using stale modules.

   The CLI never lets compilation run ahead of validation. `pnpm generate` persists a validation failure summary and exits early when schema checks break, and `--check` mode flags the run as drifted whenever that summary would change. This sequencing guarantees validation remains the gatekeeper for every artifact write.

6. **Log results** – emit machine-readable JSON events (`content_pack.compiled`, `content_pack.compilation_failed`, `content_pack.skipped`, `content_pack.pruned`) that include slug, duration, warning counts, and artifact paths. Validation emits its own `content_pack.validated` / `.validation_failed` events before compilation begins so log consumers can correlate outcomes end-to-end. Watch mode adds a `watch.run` event after each iteration with duration, trigger paths, and outcome to simplify monitoring. Logs follow structured logging practices that favor JSON key/value payloads for downstream parsing ([9 Logging Best Practices You Should Know](https://www.dash0.com/guides/logging-best-practices), [Best Practices for Analyzing Logs in Data Pipelines](https://blog.dreamfactory.com/best-practices-for-analyzing-logs-in-data-pipelines)).

## Artifact Contracts

- **Normalized JSON (`content/compiled/*.normalized.json`)**
  - Contains the exact `SerializedNormalizedContentPack` shape with canonical key ordering and a trailing newline to keep diffs legible.
  - Serves as the source of truth for `pnpm generate --check`, documentation tooling, and automation that needs raw JSON.
  - Embeds `warnings`, `digest`, and `artifactHash` so checks can fail without invoking the compiler.
  - Files live beside their originating pack to keep review diffs local to the owning package.

- **Generated TypeScript modules (`src/generated/*.generated.ts`)**

  ```ts
  import {
    createModuleIndices,
    rehydrateNormalizedPack,
    type SerializedNormalizedContentPack,
  } from '@idle-engine/content-compiler/runtime';

  const serialized: SerializedNormalizedContentPack = { /* inlined JSON */ };

  const runtimeEnv = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process;

  const shouldVerifyDigest = runtimeEnv?.env?.NODE_ENV !== 'production';

  export const SAMPLE_PACK = rehydrateNormalizedPack(serialized, {
    verifyDigest: shouldVerifyDigest,
  });
  export const SAMPLE_PACK_DIGEST = serialized.digest;
  export const SAMPLE_PACK_ARTIFACT_HASH = serialized.artifactHash;
  export const SAMPLE_PACK_INDICES = createModuleIndices(SAMPLE_PACK);
  export const SAMPLE_PACK_SUMMARY = Object.freeze({
    slug: serialized.metadata.id,
    version: serialized.metadata.version,
    resourceIds: serialized.modules.resources.map((resource) => resource.id),
  });
  ```

  `rehydrateNormalizedPack` (implemented in `runtime.ts`) reconstructs lookup maps, freezes arrays, and—when `verifyDigest` is true—recomputes the digest (artifact hash verification is planned as a follow-up in #159). `createModuleIndices` iterates the frozen module arrays, asserts identifier uniqueness, and returns immutable lookup tables so runtime code can map identifiers to array offsets without recomputing them on startup. `SAMPLE_PACK_INDICES.generators.get('starter-generator')` returns the array index inside `SAMPLE_PACK.generators`, allowing consumers to map ids to offsets without recomputing lookup tables.
  The `verifyDigest` guard inspects `globalThis.process?.env` when present instead of assuming `import.meta.env`, preventing runtime errors in environments that do not expose the Vite-style global ([Should the browser consider an import.meta.env object?](https://discourse.wicg.io/t/should-the-browser-consider-an-import-meta-env-object/4522/)).
  `@idle-engine/content-sample/src/index.ts` aliases these exports to ergonomic runtime names (`sampleContent`, `sampleContentSummary`, `sampleContentIndices`, etc.) and throws whenever the compiler recorded warnings so existing guardrails remain in place without reparsing authoring JSON.

- **Workspace summary (`content/compiled/index.json`)**
  - Resides at the repository root and lists every compiled pack with slug, version, digest, artifact hash, dependency set (sourced from `metadata.dependencies`), warning count, and artifact paths.
  - Serves as the canonical workspace index for automation, docs, and runtime bootstrapping. Consumers must treat the file as stale whenever validation fails or the CLI reports drift and rerun `pnpm generate` before relying on the data.
  - Doubles as the collision manifest: the compiler records when two packs share a digest or dependency and emits warnings immediately.
  - Drives documentation tooling and allows `pnpm generate --check` to diff a single file to detect drift.

## Determinism & Integrity

- JSON emitters use a stable RFC-8785 compatible stringifier so repeated runs produce byte-identical output. The digest stays aligned with the schema package by deferring to `createContentPackDigest` from the new `runtime-helpers` export.
- Writers operate on temporary files located in the target directory and complete writes with `fs.rename`, guaranteeing atomic replacements even when the process crashes mid-write ([Atomic file creation with temporary files](https://yakking.branchable.com/posts/atomic-file-creation-tmpfile/)).
- `pnpm generate --check` recompiles without writing files and exits with status `1` if any artifact would change, enabling Lefthook and CI to fail fast on stale outputs.
- `pnpm generate --clean` invalidates any cached comparisons and forces rewrites, providing the clean-build escape hatch recommended for incremental pipelines ([Unity Incremental Build Pipeline](https://docs.unity3d.com/Manual/incremental-build-pipeline.html)).
- Nightly determinism checks rerun `pnpm generate --check` twice in isolated working directories (incremental vs clean) and compare summary hashes, following the strategy outlined in [Deterministic builds with clang and lld](https://blog.llvm.org/2019/11/deterministic-builds-with-clang-and-lld.html).
- The workspace summary omits wall-clock timestamps so artifacts remain byte-identical across runs, in line with reproducible-build guidance to remove timestamp variability ([Deterministic build systems](https://reproducible-builds.org/docs/deterministic-build-systems/)).

## Artifact Integrity Contract

- `artifactHash` is the lowercase hex encoding of the SHA-256 hash of the RFC-8785 canonical JSON representation of the complete `SerializedNormalizedContentPack`, computed with `artifactHash` temporarily set to the empty string.
  - The compiler canonicalizes a clone of the payload with the hash cleared, hashes those bytes, and then writes the emitted JSON with the computed hash reinserted. Integrity checks repeat the same "blank then canonicalize" procedure before hashing.
  - `rehydrateNormalizedPack` recomputes the digest when `verifyDigest` is enabled (artifact hash validation will land alongside the canonical serializer upgrades tracked in #159).
  - `formatVersion` changes whenever the serialized payload shape or canonicalization rules change. When `formatVersion` increments, the compiler writes new artifacts and the runtime refuses to rehydrate packs whose `formatVersion` it does not understand.
  - `digest` remains the schema-defined content identity (used for dependency tracking, change detection, and collision reporting). `artifactHash` guarantees the integrity of the compiled artifact itself. Automation treats `digest` drift as a semantic change in content, while `artifactHash` mismatches indicate corrupted or stale build output.

## Dependency Handling

- The compiler resolves pack order with a topological sort on `metadata.dependencies.requires`, ensuring dependants always compile after their prerequisites ([IPython Cookbook - Resolving dependencies in a directed acyclic graph](https://ipython-books.github.io/143-resolving-dependencies-in-a-directed-acyclic-graph-with-a-topological-sort/)).
- Missing dependencies trigger warnings and mark the pack as failed; the summary captures the failure so automation can highlight the gap.
- Dependency cycles emit a single `content_pack.compilation_failed` event listing every slug in the loop and aborting the run before artifacts are written.
- The workspace summary records dependency digests so CI can detect mismatches when a referenced pack changed but a dependant did not rebuild.

## Logging & Telemetry

- Every compiler run writes structured JSON lines to stdout; human-friendly pretty-printing remains opt-in via `--pretty`. Each event includes an ISO timestamp, event name, slug, duration, warning count, and file paths. Structured payloads make it trivial for log processors to filter on keys rather than regex parsing ([9 Logging Best Practices You Should Know](https://www.dash0.com/guides/logging-best-practices)).
- Event schema:
  - `content_pack.compiled`: success path with `artifacts`, `warnings`, `durationMs`.
  - `content_pack.compilation_failed`: failure details with `message`, `path`, `issues`.
  - `content_pack.pruned`: emitted when stale artifacts are deleted.
  - `content_pack.skipped`: emitted when `--check` detects no changes.
- Logs integrate with existing CI parsers and future observability services without additional adapters.

## Developer Experience & Adoption

- `tools/content-schema-cli` gains a `compile` command (`pnpm --filter @idle-engine/content-validation-cli run compile`) and updates `generate` to execute manifest regeneration → validation → compilation in order.
- `--watch` uses `chokidar` to observe authoring JSON and schema inputs, debouncing writes and ignoring compiler-owned outputs (`**/content/compiled/**`, `**/src/generated/*.generated.ts`) to avoid loops.
- `packages/content-sample` switches to importing the generated module, keeping the direct JSON import only as a fallback test helper.
- Documentation (`docs/content-schema-rollout-decisions.md`, `docs/implementation-plan.md`) and READMEs will be updated once the compiler ships, so contributors know to run `pnpm generate` after editing content.
- Lefthook gains a `content` hook that runs `pnpm generate --check` to guard against stale artifacts before commit.

## Implementation Plan

### Phase 1 - Package Foundations
- [ ] Scaffold `packages/content-compiler`, add build tooling, exports map, and baseline tests.
- [x] Add `runtime-helpers` export to `@idle-engine/content-schema` with shared digest utilities.
- [ ] Implement discovery, context preparation, and single-pack compilation APIs.

### Phase 2 - Artifact Emitters & CLI Wiring
- [ ] Implement canonical JSON and TypeScript emitters with stable ordering, digest calculation, and atomic writes.
- [ ] Extend `tools/content-schema-cli` with the new compiler command, integrate logs, and update `pnpm generate` to run validation and compilation sequentially.
- [ ] Persist structured warnings in per-pack artifacts and the workspace summary.
- [ ] Implement `--check`, `--clean`, and artifact pruning; ensure Lefthook/CI adopt the new verification step.

### Phase 3 - Developer Experience & Adoption
- [ ] Implement watch mode with debounced recompilation and change detection.
- [x] Update `packages/content-sample` (and any other consumers) to import generated artifacts.
- [x] Backfill documentation and onboarding guides with compiler usage and troubleshooting tips.

## Success Criteria

- Every pack produces `content/compiled/*.normalized.json` and `src/generated/*.generated.ts` without manual intervention.
- `pnpm generate` emits `content_pack.*` events, fails when artifacts drift, and `--check` exits non-zero on stale outputs.
- Runtime consumers no longer call `parseContentPack` at import time; they rely on generated modules and rehydration helpers.
- Consecutive compiler runs with unchanged inputs produce no git diffs and skip file rewrites.
- Removing a pack deletes its compiled artifacts within the same run that detects the removal.
- Compiler unit tests and CLI smoke tests run under `pnpm test` and `pnpm lint`; CI passes with the determinism check enabled.
