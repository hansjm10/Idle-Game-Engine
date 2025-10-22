# Content Compiler Design Document

**Issue:** #159  
**Workstream:** Content Pipeline  
**Status:** Design  
**Last Updated:** 2025-10-22

> Issue #12 unlocks the compiler stage of the content pipeline. With the schema in place, packs must be transformed into deterministic runtime-ready artifacts so the engine and tooling never depend on ad-hoc TypeScript exports.

## 1. Problem Statement

The content DSL distributed through `@idle-engine/content-schema` already returns fully normalized `NormalizedContentPack` objects, yet every consumer still reparses authoring JSON at runtime. Each import of `packages/content-sample` calls `parseContentPack`, rebuilding lookup maps and re-running validation, the CLI (`tools/content-schema-cli/src/generate.js`) only validates packs while generating the runtime event manifest, and automation has no way to assert that generated artifacts match what is committed. Missing compiler outputs also block downstream tooling from consuming packs without pulling in the schema bundle.

## 2. Goals

- Compile each discovered pack into a deterministic `SerializedNormalizedContentPack` plus an `artifactHash` so mutations can be detected without revalidation.
- Publish `@idle-engine/content-compiler` with a Node entrypoint for the CLI and a browser-safe runtime entrypoint for consumers that only need rehydration helpers.
- Fold compilation into `pnpm generate` so validation, manifest regeneration, and compilation happen in one command that supports watch mode, `--check`, and `--clean`.
- Emit TypeScript modules and JSON artifacts that runtime packages import instead of calling `parseContentPack`, while exposing digests, warning metadata, and positional indices.
- Surface structured JSON log events that follow data-pipeline logging best practices, enabling CI and observability tooling to gate builds on compiler health.
- Track discovery metadata and prune stale outputs so committed artifacts align with the set of packs in `packages/*/content/`.

## 3. Non-Goals

- Pre-evaluating or optimizing pack formulas into bytecode; formula execution remains a runtime responsibility (`docs/runtime-step-lifecycle.md`).
- Shipping content balance heuristics, localization exports, or asset bundling flows.
- Producing bespoke binary assets; JSON and TypeScript output is sufficient for this milestone.
- Replacing the runtime event manifest generator or altering digest semantics defined by the schema package.

## 4. Current State

- `packages/content-sample/src/index.ts` reads `content/pack.json`, calls `parseContentPack`, throws on warnings, and exports the runtime event definitions; it never caches digests or indices.
- `tools/content-schema-cli/src/generate.js` builds the runtime event manifest and validates packs but does not write pack-level artifacts or logs.
- No package currently writes `content/compiled/` or `src/generated/` outputs; a search for those directories under `packages/` returns nothing.
- There is no shared digest registry, and Lefthook cannot assert that authored JSON matches committed outputs because none exist yet.

## 5. Target Architecture

### 5.1 Package Layout & Ownership

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

To share digest logic without bundling the full schema implementation, `@idle-engine/content-schema` will add a `runtime-helpers` export that surfaces `createContentPackDigest`, freeze helpers, and associated types. The compiler package depends on that entrypoint so hashing stays consistent across the workspace. Splitting orchestration from artifact emitters mirrors the manifest-driven content pipeline described in [Engine Internals: Content Pipeline](https://medium.com/@heinapurola/engine-internals-content-pipeline-1af34a117f1).

### 5.2 Public API Surface

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

### 5.3 Compilation Workflow

1. **Discover packs** – scan `packages/*/content/pack.json`, mirroring the manifest generator’s discovery rules. Each file becomes a `ContentDocument` with absolute path, POSIX-relative path, slug (derived from `metadata.id`), and parsed JSON:

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

6. **Log results** – emit machine-readable JSON events (`content_pack.compiled`, `content_pack.compilation_failed`, `content_pack.skipped`, `content_pack.pruned`) that include slug, duration, warning counts, and artifact paths. Logs follow structured logging practices that favor JSON key/value payloads for downstream parsing ([9 Logging Best Practices You Should Know](https://www.dash0.com/guides/logging-best-practices), [Best Practices for Analyzing Logs in Data Pipelines](https://blog.dreamfactory.com/best-practices-for-analyzing-logs-in-data-pipelines)).

### 5.4 Artifact Contracts

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

- **Workspace summary (`content/compiled/index.json`)**
  - Resides at the repository root and lists every compiled pack with slug, version, digest, artifact hash, dependency set (sourced from `metadata.dependencies`), warning count, and artifact paths.
  - Doubles as the collision manifest: the compiler records when two packs share a digest or dependency and emits warnings immediately.
  - Drives documentation tooling and allows `pnpm generate --check` to diff a single file to detect drift.

### 5.5 Determinism & Integrity

- JSON emitters use a stable RFC-8785 compatible stringifier so repeated runs produce byte-identical output. The digest stays aligned with the schema package by deferring to `createContentPackDigest` from the new `runtime-helpers` export.
- Writers operate on temporary files located in the target directory and complete writes with `fs.rename`, guaranteeing atomic replacements even when the process crashes mid-write ([Atomic file creation with temporary files](https://yakking.branchable.com/posts/atomic-file-creation-tmpfile/)).
- `pnpm generate --check` recompiles without writing files and exits with status `1` if any artifact would change, enabling Lefthook and CI to fail fast on stale outputs.
- `pnpm generate --clean` invalidates any cached comparisons and forces rewrites, providing the clean-build escape hatch recommended for incremental pipelines ([Unity Incremental Build Pipeline](https://docs.unity3d.com/Manual/incremental-build-pipeline.html)).
- Nightly determinism checks rerun `pnpm generate --check` twice in isolated working directories (incremental vs clean) and compare summary hashes, following the strategy outlined in [Deterministic builds with clang and lld](https://blog.llvm.org/2019/11/deterministic-builds-with-clang-and-lld.html).
- The workspace summary omits wall-clock timestamps so artifacts remain byte-identical across runs, in line with reproducible-build guidance to remove timestamp variability ([Deterministic build systems](https://reproducible-builds.org/docs/deterministic-build-systems/)).

### 5.5.1 Artifact Integrity Contract

- `artifactHash` is the lowercase hex encoding of the SHA-256 hash of the RFC-8785 canonical JSON representation of the complete `SerializedNormalizedContentPack` object (including `formatVersion`, `digest`, and warning metadata).
  - The compiler computes the hash after canonical serialization and stores it alongside the JSON artifact; `--check` recomputes the same bytes without touching disk.
  - `rehydrateNormalizedPack` recomputes the digest when `verifyDigest` is enabled (artifact hash validation will land alongside the canonical serializer upgrades tracked in #159).
  - `formatVersion` changes whenever the serialized payload shape or canonicalization rules change. When `formatVersion` increments, the compiler writes new artifacts and the runtime refuses to rehydrate packs whose `formatVersion` it does not understand.
  - `digest` remains the schema-defined content identity (used for dependency tracking, change detection, and collision reporting). `artifactHash` guarantees the integrity of the compiled artifact itself. Automation treats `digest` drift as a semantic change in content, while `artifactHash` mismatches indicate corrupted or stale build output.

### 5.6 Dependency Handling

- The compiler resolves pack order with a topological sort on `metadata.dependencies.requires`, ensuring dependants always compile after their prerequisites ([IPython Cookbook - Resolving dependencies in a directed acyclic graph](https://ipython-books.github.io/143-resolving-dependencies-in-a-directed-acyclic-graph-with-a-topological-sort/)).
- Missing dependencies trigger warnings and mark the pack as failed; the summary captures the failure so automation can highlight the gap.
- Dependency cycles emit a single `content_pack.compilation_failed` event listing every slug in the loop and aborting the run before artifacts are written.
- The workspace summary records dependency digests so CI can detect mismatches when a referenced pack changed but a dependant did not rebuild.

### 5.7 Logging & Telemetry

- Every compiler run writes structured JSON lines to stdout; human-friendly pretty-printing remains opt-in via `--pretty`. Each event includes an ISO timestamp, event name, slug, duration, warning count, and file paths. Structured payloads make it trivial for log processors to filter on keys rather than regex parsing ([9 Logging Best Practices You Should Know](https://www.dash0.com/guides/logging-best-practices)).
- Event schema:
  - `content_pack.compiled`: success path with `artifacts`, `warnings`, `durationMs`.
  - `content_pack.compilation_failed`: failure details with `message`, `path`, `issues`.
  - `content_pack.pruned`: emitted when stale artifacts are deleted.
  - `content_pack.skipped`: emitted when `--check` detects no changes.
- Logs integrate with existing CI parsers and future observability services without additional adapters.

### 5.8 Developer Experience & Adoption

- `tools/content-schema-cli` gains a `compile` command (`pnpm --filter @idle-engine/content-schema-cli run compile`) and updates `generate` to execute manifest regeneration → validation → compilation in order.
- `--watch` uses `chokidar` to observe authoring JSON and schema inputs, debouncing writes and ignoring compiler-owned outputs (`**/content/compiled/**`, `**/src/generated/*.generated.ts`) to avoid loops.
- `packages/content-sample` switches to importing the generated module, keeping the direct JSON import only as a fallback test helper.
- Documentation (`docs/content-schema-rollout-decisions.md`, `docs/implementation-plan.md`) and READMEs will be updated once the compiler ships, so contributors know to run `pnpm generate` after editing content.
- Lefthook gains a `content` hook that runs `pnpm generate --check` to guard against stale artifacts before commit.

## 6. Implementation Plan

### Phase 1 - Package Foundations
- [ ] Scaffold `packages/content-compiler`, add build tooling, exports map, and baseline tests.
- [ ] Add `runtime-helpers` export to `@idle-engine/content-schema` with shared digest utilities.
- [ ] Implement discovery, context preparation, and single-pack compilation APIs.

### Phase 2 - Artifact Emitters & CLI Wiring
- [ ] Implement canonical JSON and TypeScript emitters with stable ordering, digest calculation, and atomic writes.
- [ ] Extend `tools/content-schema-cli` with the new compiler command, integrate logs, and update `pnpm generate` to run validation and compilation sequentially.
- [ ] Persist structured warnings in per-pack artifacts and the workspace summary.
- [ ] Implement `--check`, `--clean`, and artifact pruning; ensure Lefthook/CI adopt the new verification step.

### Phase 3 - Developer Experience & Adoption
- [ ] Implement watch mode with debounced recompilation and change detection.
- [ ] Update `packages/content-sample` (and any other consumers) to import generated artifacts.
- [ ] Backfill documentation and onboarding guides with compiler usage and troubleshooting tips.

## 7. Success Criteria

- Every pack produces `content/compiled/*.normalized.json` and `src/generated/*.generated.ts` without manual intervention.
- `pnpm generate` emits `content_pack.*` events, fails when artifacts drift, and `--check` exits non-zero on stale outputs.
- Runtime consumers no longer call `parseContentPack` at import time; they rely on generated modules and rehydration helpers.
- Consecutive compiler runs with unchanged inputs produce no git diffs and skip file rewrites.
- Removing a pack deletes its compiled artifacts within the same run that detects the removal.
- Compiler unit tests and CLI smoke tests run under `pnpm test` and `pnpm lint`; CI passes with the determinism check enabled.

## 8. Open Questions

1. **Formula precomputation:** Is there value in capturing precomputed coefficients for common formula types during compilation, or should that remain a separate optimization pass?
2. **Artifact granularity:** Do documentation tools need per-module JSON (e.g., `resources.json`) in addition to the consolidated pack payload?
3. **Bundle outputs:** Should the compiler emit optional multi-pack bundles (e.g., seasonal content sets), or is the workspace summary sufficient for the current roadmap?

## 9. References

- `docs/content-dsl-schema-design.md`
- `docs/content-schema-rollout-decisions.md`
- `docs/idle-engine-design.md` §10
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
