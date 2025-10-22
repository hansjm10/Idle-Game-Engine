# Content Compiler Design Document

**Issue:** #12  
**Workstream:** Content Pipeline  
**Status:** Design  
**Last Updated:** 2025-10-23

> Issue #12 unlocks the compiler stage of the content pipeline. With the schema in place, packs must be transformed into deterministic runtime-ready artifacts so the engine and tooling never depend on ad-hoc TypeScript exports.

## 1. Overview

The monorepo now ships a canonical DSL schema (`@idle-engine/content-schema`), yet content packs are still consumed as raw authoring JSON via direct calls to `parseContentPack`. `packages/content-sample` reparses `content/pack.json` at import time, and the CLI's `pnpm generate` step only validates packs before regenerating the runtime event manifest. This design introduces an offline compiler that converts every pack into frozen `NormalizedContentPack` payloads plus indexed metadata the runtime can hydrate without re-running validation. The compiler integrates with the existing CLI, emits machine-readable logs, and keeps outputs deterministic for replay and caching guarantees described in `docs/idle-engine-design.md` §10.

## 2. Goals

- Produce deterministic, schema-backed artifacts for each pack that mirror `NormalizedContentPack` while remaining serialisable and versioned.
- Provide a programmatic API (`@idle-engine/content-compiler`) and CLI integration so `pnpm generate` validates, compiles, and watches packs in one pass.
- Export generated TypeScript modules that consumers can import instead of reparsing authoring JSON, along with JSON payloads for automation/CI.
- Capture per-pack digests, dependency metadata, and index tables that allow the runtime to map id → array positions without recomputing them at startup.
- Emit structured JSON events (`content_pack.compiled`, `content_pack.compilation_failed`) so downstream automation can gate builds on compiler health or warning thresholds.

## 3. Non-Goals

- Evaluating or optimising numeric formulas into bytecode—formula execution remains a runtime concern (see `docs/runtime-step-lifecycle.md`).
- Shipping balance heuristics or simulation linting; the compiler only normalises data.
- Implementing asset bundling or localisation export pipelines (tracked separately).
- Converting packs to bespoke binary formats; JSON + TypeScript outputs are sufficient for the prototype milestone.

## 4. Current State

- `@idle-engine/content-schema` normalises packs and returns `NormalizedContentPack`, but consumers call `parseContentPack` on every import, incurring validation cost and leaving outputs unserialised (`lookup` uses `Map` instances).
- `tools/content-schema-cli/src/generate.js` loads pack manifests only to validate them (`content_pack.validated`) before rebuilding the runtime event manifest; no compile artifacts are emitted.
- `packages/content-sample/src/index.ts` rethrows on schema warnings and re-exports the parsed pack but does not expose digests or indexes, forcing downstream code to re-derive IDs.
- There is no change detection beyond git diffs, so stale generated code can drift silently; Lefthook cannot verify that compiled content matches the committed pack definitions.

## 5. Proposed Solution

### 5.1 Packages and Ownership

- Add a new workspace package `packages/content-compiler` (`@idle-engine/content-compiler`) with two public entrypoints:
  - `index.ts` (Node-only) exports `compileContentPack(document, options)` and `compileWorkspacePacks(fs, options)` plus shared utilities for stable stringification, digest comparison, and artifact emission.
  - `runtime.ts` (browser-safe) exports `rehydrateNormalizedPack(serialized)` and supporting types without importing `node:*` modules so `packages/shell-web` and other runtime consumers avoid bundling filesystem code.
- Keep CLI concerns (`argument parsing`, `watch` mode, logging) inside `tools/content-schema-cli`. The CLI becomes a thin wrapper over the compiler package, mirroring the schema split documented in `docs/content-dsl-schema-design.md` §5.1.

Package layout:

```
packages/content-compiler/
  package.json
  src/
    index.ts
    runtime.ts
    compiler.ts
    artifacts/
      json.ts
      typescript.ts
      summary.ts
    io/
      discovery.ts
      writer.ts
    normalize.ts
    hashing.ts
    logging.ts
    types.ts
  __tests__/
    compiler.test.ts
    artifacts.test.ts
```

### 5.2 Compilation Pipeline

1. **Discover packs** – scan `packages/*/content/pack.json` (mirrors existing validation logic) and load documents (`ContentDocument` structure with file path + parsed JSON).
2. **Prepare context** – collect pack metadata to resolve dependency order, build the runtime event catalogue from `GENERATED_RUNTIME_EVENT_DEFINITIONS`, and assemble `ContentSchemaOptions` with allowlists, active pack IDs, and known packs.
3. **Validate & normalise** – invoke `parseContentPack(document, context)` once per pack. Persist the returned `warnings` alongside the normalised pack so downstream steps can surface severity without re-running schema logic.
4. **Transform to compiled payloads** – convert each `NormalizedContentPack` into a `SerializedNormalizedContentPack` suitable for JSON output:

```ts
interface SerializedNormalizedContentPack {
  readonly metadata: NormalizedMetadata;
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
  readonly serializedLookup: NormalizedContentPack['serializedLookup'];
  readonly moduleIndices: {
    readonly resourceIndex: Readonly<Record<string, number>>;
    readonly generatorIndex: Readonly<Record<string, number>>;
    readonly upgradeIndex: Readonly<Record<string, number>>;
    readonly metricIndex: Readonly<Record<string, number>>;
    readonly automationIndex: Readonly<Record<string, number>>;
    readonly prestigeLayerIndex: Readonly<Record<string, number>>;
    readonly achievementIndex: Readonly<Record<string, number>>;
    readonly transformIndex: Readonly<Record<string, number>>;
    readonly guildPerkIndex: Readonly<Record<string, number>>;
    readonly runtimeEventIndex: Readonly<Record<string, number>>;
  };
  readonly digest: NormalizedContentPack['digest'];
  readonly dependencies: NormalizedContentPack['metadata']['dependencies'];
}
```

Index tables are generated by enumerating module arrays; the `moduleIndices.*` records complement `serializedLookup.*` by adding position lookups the runtime uses when instantiating typed-array state (see `packages/core/src/resource-state.ts` for precedence). Keeping the indexes separate avoids colliding with the `lookup` Map structure already defined on `NormalizedContentPack`.

The compiler derives the `digest` field from a canonical serialization of the entire normalized payload (metadata, modules, serialized lookups, and index tables). Hashing the full structure—rather than only identifier lists—lets downstream importers detect any mutation to generated artifacts, including manual edits to numeric formulas or localized copy.

5. **Emit artifacts** – hand each compiled payload to emitter modules that render:
   - Stable JSON (`content/compiled/<packSlug>.normalized.json`) using canonical key ordering.
  - TypeScript (`src/generated/<packSlug>.generated.ts`) that imports `rehydrateNormalizedPack` from `@idle-engine/content-compiler/runtime` and exports a frozen `NormalizedContentPack`.
   - Workspace summary (`content/compiled/index.json`) enumerating `packSlug`, version, digest hash, dependencies, artifact paths, and warning counts to help automation and documentation tooling.
   - Prior to writing, delete any JSON/TypeScript artifacts for packs that were not part of the current discovery set so stale files cannot accumulate between runs.
6. **Log results** – stream JSON log entries:
   - Success: `{"event":"content_pack.compiled","packSlug":"sample-pack","artifacts":{"normalized":"...","module":"..."}, "warnings":0,"durationMs":57}`
   - Warning: include `warnings` array.
   - Failure: `{"event":"content_pack.compilation_failed","packSlug":"sample-pack","message":"...","path":"packages/.../content/pack.json","issues":[...]}`.

Compilation aborts on the first hard error but still reports all pack-level issues encountered before exit to aid debugging.

### 5.3 Artifact Semantics

- **Normalized JSON (`content/compiled/*.normalized.json`)**
  - Contains only structured-clone-safe data with sorted keys.
  - Uses newline-terminated JSON to keep diffs clear.
  - Serves as the source of truth for CI's `--check` mode and documentation pipelines.
  - Consumers can `import` or `require` it in Node for quick introspection.

- **Generated TypeScript (`src/generated/*.generated.ts`)**
  - Structure:

```ts
import {
  rehydrateNormalizedPack,
  type SerializedNormalizedContentPack,
} from '@idle-engine/content-compiler/runtime';

const serialized: SerializedNormalizedContentPack = { /* JSON payload inline */ };

export const SAMPLE_PACK = rehydrateNormalizedPack(serialized);
export const SAMPLE_PACK_DIGEST = serialized.digest;
export const SAMPLE_PACK_SUMMARY = {
  slug: serialized.metadata.id,
  version: serialized.metadata.version,
  resourceIds: serialized.modules.resources.map((resource) => resource.id),
  // ...
} as const;
```

  - `rehydrateNormalizedPack` rebuilds `ReadonlyMap` instances and restores the `serializedLookup.*` records from the JSON payload, then recomputes the digest using the same canonical serialization routine to ensure it matches the embedded value before freezing the resulting `NormalizedContentPack`. Any mismatch throws, preventing drift from hand-edited artifacts.
  - The module also exports precomputed `id` arrays and indices for ergonomics in tests.

- **Workspace Summary (`content/compiled/index.json`)**
  - Sorted by `packSlug`, includes digests and dependencies.
  - Used by documentation generators and IDE helpers to list available packs.
  - Enables `pnpm generate --check` to diff summary content quickly.

### 5.4 CLI Integration

- Extend `tools/content-schema-cli` with a new `compile` command (`pnpm --filter @idle-engine/content-schema-cli run compile`) and update the existing `generate` script to execute three phases in order: regenerate runtime event manifest → validate packs → compile packs.
- Support `--watch` (chokidar) to recompile packs and regenerate artifacts as files change. Watch mode will debounce writes and only overwrite targets when content changes, safeguarding developer workflows and avoiding churn in git history.
- Prune stale artifacts before writing new ones by diffing the discovered pack set against the existing output directories; missing packs should trigger removal of both JSON and TypeScript outputs. Mutating modes (regular compile/generate/watch) handle deletions, while `--check` skips writes and removals entirely so dry runs never mutate the workspace.
- Add `--check` to exit with code `1` when compilation would change any artifact, allowing Lefthook and CI to enforce stale-generated detection similar to `pnpm lint -- --max-warnings=0`, while remaining a read-only validation pass.
- Preserve JSON log output for automation; human-friendly summaries remain optional via `--pretty`.

### 5.5 Determinism, Change Detection, and Caching

- Use a stable stringifier (RFC-8785 compatible ordering) so repeated compilations of identical packs produce identical byte-for-byte artifacts and to derive the canonical digest that `rehydrateNormalizedPack` verifies at import time.
- Write files via a temporary path + atomic rename, and skip rewrites when the existing file already matches the newly generated bytes.
- Include the schema digest (`NormalizedContentPack.digest`) inside each artifact to guarantee alignment with runtime expectations (Command Recorder relies on digests for replay integrity per `docs/runtime-command-queue-design.md` §13).
- Generate module-local hashes (FNV-1a) for `resources`, `generators`, and `upgrades` to enable future incremental recompilation if large packs emerge.

### 5.6 Dependency Handling

- Resolve compilation order via topological sort on `metadata.dependencies.requires`. Packs without dependencies are compiled first; dependents inherit the digests and versions of required packs in the summary.
- Emit warnings when referenced dependencies are missing from the workspace or not compiled in the current run, guiding authors to install required packs before shipping.
- Future cross-pack validation (guild perks referencing external resources) can hook into this graph without altering the compiler's public API.

### 5.7 Testing Strategy

- Add Vitest coverage in `packages/content-compiler/__tests__`:
  - Snapshot compiled JSON/TS outputs for the sample pack fixture (ensuring deterministic formatting).
  - Unit tests for `rehydrateNormalizedPack` verifying that lookups and arrays are frozen and branded types are preserved.
  - CLI integration test (run via spawned process) to confirm log events, `--check`, and watch-mode debounce.
- Update `pnpm test --filter content-compiler` guard rails in Lefthook so new package coverage runs automatically.

### 5.8 Adoption Plan

- Replace manual parsing in `packages/content-sample/src/index.ts` with imports from `src/generated/sample-pack.generated.ts`, keeping the re-exported types intact while removing runtime file I/O.
- Document the new workflow in `packages/content-sample/README.md` (run `pnpm generate` after editing `content/pack.json`).
- Update onboarding docs (`README.md`, `docs/project-board-workflow.md`) to note that design docs referencing content data should point to compiled artifacts.

## 6. Implementation Plan

### Phase 1 – Compiler Foundation
- [ ] Scaffold `@idle-engine/content-compiler` with interfaces, serialization helpers, and hash utilities.
- [ ] Port existing CLI discovery/validation logic into reusable helpers and cover with unit tests.
- [ ] Implement `rehydrateNormalizedPack` and freeze semantics (ensuring `Map`/`Object.freeze` usage matches schema output).

### Phase 2 – Artifact Emitters & CLI Wiring
- [ ] Implement JSON and TypeScript emitters with stable ordering and content hashing.
- [ ] Add compilation orchestration to the CLI (`generate` + new `compile` command), including structured logging and error surfacing.
- [ ] Support `--check` and ensure CI/Lefthook adopt the new verification step.

### Phase 3 – Developer Experience & Adoption
- [ ] Implement watch mode with file-level debouncing and incremental recompilation.
- [ ] Swap `packages/content-sample` to rely on generated artifacts; update README/docs.
- [ ] Backfill documentation references (`docs/content-schema-rollout-decisions.md`, `docs/implementation-plan.md`) with compiler status.

## 7. Success Criteria

- Every pack in the workspace produces `content/compiled/*.normalized.json` and `src/generated/*.generated.ts` without manual intervention.
- `pnpm generate` emits `content_pack.compiled` events and fails when artifacts are stale or compilation errors occur.
- Runtime consumers (`packages/content-sample`, future engine loaders) import generated modules without calling `parseContentPack`.
- Re-running the compiler without source changes yields zero git diffs and zero file rewrites.
- Removing a pack from the workspace removes its generated artifacts in the same compilation run, keeping `content/compiled/` and `src/generated/` in sync with discovery.
- Tests covering the compiler package and CLI pass under `pnpm test` and `pnpm lint`, and CI can enforce `pnpm generate --check` with no intermittent failures.

## 8. Open Questions

1. **Formula precomputation:** Should we pre-evaluate common formulas (constant/linear) into coefficient tables to reduce runtime cost, or leave that to a later optimisation pass?
2. **Artifact granularity:** Do downstream tools need per-module JSON files (e.g., `resources.json`) in addition to the consolidated payload for documentation generation?
3. **Multi-pack bundles:** When multiple packs ship together, should the compiler also emit a combined manifest that the runtime can consume directly (e.g., for seasonal events), or is the workspace summary sufficient for now?

## 9. References

- `docs/content-dsl-schema-design.md`
- `docs/content-schema-rollout-decisions.md`
- `docs/idle-engine-design.md` §10
- `docs/runtime-command-queue-design.md` §13
- `tools/content-schema-cli/src/generate.js`
- `packages/content-schema/src/pack.ts`
- `packages/core/src/resource-state.ts`
