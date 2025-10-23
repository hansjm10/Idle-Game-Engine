# Content Validation CLI Design Document

**Issue:** #13  
**Workstream:** Content Pipeline  
**Status:** Design  
**Last Updated:** 2025-10-23

> Issue #13 wires the content validation tooling into the shared CLI so `pnpm generate` enforces schema health before the compiler emits artifacts. The design builds on `docs/idle-engine-design.md` §10 and the schema contracts from `docs/content-dsl-schema-design.md`.

## 1. Overview

The Idle Engine repository currently ships a schema package (`@idle-engine/content-schema`) and a CLI scaffold under `tools/content-schema-cli`. The CLI generates the runtime event manifest but content packs can still ship invalid data because validation is not part of the default workflow. This document defines how the CLI discovers packs, runs validation with actionable diagnostics, and integrates the results with the compiler pipeline so contributors cannot land malformed content.

## 2. Goals

- **Deterministic enforcement:** Every `pnpm generate` run must validate all discovered packs before emitting runtime artifacts, aborting on schema failures to protect the deterministic runtime loop (`docs/idle-engine-design.md` §6 & §10).
- **Actionable diagnostics:** Emit machine-readable JSON events (`content_pack.*`) that surface pack slug, file path, warning counts, and blocker details so CI and humans can triage quickly without parsing prose logs.
- **Workflow integration:** Support one-shot, `--check`, and `--watch` modes with consistent exit codes, clean handling of drift, and optional pretty-printing to keep the developer experience aligned with other repo tooling.
- **Summary visibility:** Persist a workspace-level summary (`content/compiled/index.json`) that records validation and compilation outcomes, enabling downstream scripts to detect drift without rerunning the pipeline.
- **Build hygiene:** Automatically build `@idle-engine/content-compiler` on demand, skip redundant rewrites, and prune stale artifacts so committed outputs always match authored packs.

## 3. Non-Goals

- Replacing or redefining schema rules (tracked in Issue #11 and the schema design document).
- Designing visual authoring tools or IDE plugins for content authors.
- Shipping content balance heuristics, localisation audits, or runtime formula inspection (compiler follow-ups cover those capabilities).
- Altering the runtime event manifest format; the CLI continues to call `buildRuntimeEventManifest` for that responsibility.
- Introducing additional package managers or workflow orchestration beyond pnpm and chokidar.

## 4. Current State

- `tools/content-schema-cli/src/generate.js` reads runtime event metadata, builds the manifest module, and exposes `validateContentPacks` but this function is not wired into the default command.
- `pnpm generate` executes `pnpm --filter @idle-engine/content-schema-cli run compile`, which currently focuses on manifest regeneration and does not surface pack-level diagnostics or compiler integration.
- Structured logging guidance in `docs/idle-engine-design.md` (§10) is unmet; existing runs emit human-readable console noise that downstream automation cannot parse reliably.
- `packages/content-compiler` can compile packs into deterministic JSON/TypeScript artifacts (`docs/content-compiler-design.md`), but nothing triggers it during workspace routines and artifacts may drift.
- CI and Lefthook depend on `pnpm generate`; without validation wiring, schema regressions slip through local workflows.

## 5. Requirements

### 5.1 Functional

- Discover all packs under `packages/**/content/pack.json` (JSON and JSON5) and validate them via `createContentPackValidator`.
- Respect pack dependency metadata (`metadata.dependencies.requires`) so validation and compilation occur in a topologically sorted order.
- Emit structured logs for validation successes (`content_pack.validated`) and failures (`content_pack.validation_failed`), including warning payloads.
- Abort the command before compilation when any validation failure occurs; `process.exitCode` must be non-zero.
- Forward schema options (`knownPacks`, `activePackIds`, `runtimeEventCatalogue`) from validation into the compiler to eliminate redundant scans.
- Support the CLI options documented in §6.1 with consistent semantics across validation, manifest generation, and compilation.

### 5.2 Non-Functional

- Maintain deterministic log ordering tied to pack discovery order so CI diffing is stable.
- Avoid unnecessary rewrites by comparing byte content before writing generated modules, JSON artifacts, or the workspace summary.
- Prevent watch mode from flooding logs by debouncing events, summarising triggers, and flagging repeated validation errors without dropping detail.
- Keep the validation step performant for dozens of packs (parallel discovery, single validator instance).
- Preserve compatibility with Node ≥18.18 and pnpm ≥8 as defined in `package.json`.

## 6. Proposed Solution

### 6.1 CLI Entry Points & Usage

- Retain `tools/content-schema-cli/src/compile.js` as the executable entrypoint invoked by `pnpm generate`.
- Document and implement the following options:
  - `--check`: run without applying filesystem mutations; exit with code 1 if manifests, validation, or compiler artifacts would change.
  - `--clean`: force rewrites even when outputs match, ensuring stale artifacts are replaced (ignored in `--check` runs).
  - `--watch`: observe content, manifest metadata, and base manifest files with chokidar; rerun the pipeline with debouncing.
  - `--pretty`: pretty-print JSON log lines for human readability while keeping machine consumption viable.
  - `--cwd`/`-C`: override the workspace root (used for tests and sandboxes).
  - `--summary`: override the workspace summary output path, defaulting to `content/compiled/index.json`.
- Extend `printUsage()` to describe the integrated validation stage and log events.

### 6.2 Execution Pipeline

1. **Detect workspace root** and resolve options (`cwd`, `summary`, watch flags).
2. **Ensure compiler availability** by attempting to import `@idle-engine/content-compiler`; if it is missing, spawn `pnpm --filter @idle-engine/content-compiler run build` before retrying the import.
3. **Build runtime event manifest** via `buildRuntimeEventManifest`, capturing the generated source, manifest entries, and schema options (`manifestDefinitions`).
4. **Validate content packs** by calling `validateContentPacks(manifest.manifestDefinitions, options)`. The function:
   - Discovers pack documents.
   - Builds a validator with `createContentPackValidator`.
   - Emits a `content_pack.validated` log per pack, including warnings when present.
   - Emits `content_pack.validation_failed` logs for schema errors and throws when any failure occurs.
   - Returns schema options to seed the compiler (known packs, active IDs, runtime event catalogue).
5. **Write manifest** using `writeRuntimeEventManifest`, respecting `check` and `clean`.
6. **Compile packs** by calling `compileWorkspacePacks` with the workspace filesystem implementation and schema options from step 4. The compiler:
   - Topologically sorts packs based on declared dependencies.
   - Serializes normalized packs to deterministic JSON and generated TypeScript modules.
   - Produces artifact operations (written, deleted, unchanged) for per-pack outputs and the workspace summary.
7. **Emit compiler logs** using the logger returned by `loadContentCompiler().createLogger`, producing `content_pack.compiled`, `content_pack.skipped`, `content_pack.compilation_failed`, and `content_pack.pruned` events.
8. **Summarise run** by merging manifest and compiler results into a structured summary (pack totals, artifact actions, changed pack slugs). Watch mode emits an additional `watch.run` event with duration and trigger metadata.
9. **Set exit codes**: any validation failure, compiler failure, or drift in `--check` mode results in a non-zero exit status.

### 6.3 Structured Logging & Telemetry

- Stick to JSON-per-line logs with no trailing commentary to protect downstream ingestion (aligned with `docs/idle-engine-design.md` §10 logging guidance).
- Validation events include:
  - `content_pack.validated`: `{ event, packSlug, path, warningCount, warnings }`.
  - `content_pack.validation_failed`: `{ event, path, issues, message }`.
- Compiler events include:
  - `content_pack.compiled`: `{ name, slug, path, durationMs, warnings, artifacts, check }`.
  - `content_pack.skipped`: same shape but indicates all artifacts unchanged during `--check`.
  - `content_pack.compilation_failed`: adds `message` and `stack`.
  - `content_pack.pruned`: emitted when stale artifacts are removed.
- Watch loop emits `watch.status`, `watch.hint`, and `watch.run` events summarising triggers and run outcomes.
- All log emitters accept `pretty` to switch between single-line and indented JSON without changing field names.

### 6.4 Summary Artifact & Drift Detection

- Persist a deterministic workspace summary containing:
  - Pack totals (compiled, failed, warning counts).
  - Artifact action counts grouped by action.
  - Lists of changed and failed pack slugs.
  - Manifest and summary action states (`written`, `unchanged`, `would-write`, etc.).
- Default summary location: `content/compiled/index.json`, overrideable via `--summary`.
- In `--check` mode, mark drift when the summary or any artifact would change; exit 1 to gate CI.
- Provide helper metadata (e.g., timestamp, CLI version) for future analytics while keeping the JSON stable for diffing.

### 6.5 Watch Mode & Developer Experience

- Watch globs:
  - `packages/**/content/**/*.{json,json5}`
  - `packages/**/content/event-types.json`
  - `packages/core/src/events/runtime-event-base-metadata.json`
- Ignore generated outputs (`content/compiled/**`, `src/generated/*.generated.ts`, `node_modules`).
- Debounce events by 150 ms and cap logged trigger paths to avoid flooding (`MAX_TRIGGER_PATHS = 10`).
- After each run, emit `watch.run` summarising status (`success`, `failed`, `skipped`), iteration count, duration, triggers, and changed/failed packs.
- Keep the process alive despite validation failures; watch mode should continue listening after emitting failure events but surface a non-zero exit code on termination.

### 6.6 Failure Handling & Exit Codes

- Validation errors throw before compilation, ensuring stale artifacts are not re-emitted when packs are invalid.
- Compiler failures for specific packs do not abort the entire run; they mark the pack as failed, emit diagnostics, and continue compiling independent packs. Exit code remains non-zero when any pack fails.
- When `--check` is passed, drift (manifest or artifacts) sets `process.exitCode = 1` even if validation succeeds.
- Unexpected exceptions propagate to the top-level handler, logging the stack trace and marking the run as failed.

### 6.7 Integration Points

- Update repository docs (README, `docs/content-dsl-schema-design.md`, `docs/content-compiler-design.md`) to reference the new CLI behaviour.
- Ensure Lefthook invokes `pnpm generate --check` so staged changes include fresh artifacts and validation passes.
- CI pipelines continue to run `pnpm generate`; the structured logs enable future parsing for dashboards or gating on warning counts.
- Provide TypeScript definitions for log events in `@idle-engine/content-compiler` (runtime entrypoint) to ease consumption by other tooling.

## 7. Implementation Plan

1. **CLI Wiring**
   - Import and invoke `validateContentPacks` from the compile entrypoint.
   - Plumb schema options into the compiler call.
   - Ensure manifest writing respects validation outcomes (skip when validation fails).
2. **Logging Enhancements**
   - Emit structured validation and compiler events with clear fields.
   - Add watch-mode status logs and usage text updates.
3. **Summary Output & Drift Detection**
   - Persist deterministic summary JSON via the compiler.
   - Update exit code logic for `--check` drift handling.
4. **Documentation & Tests**
   - Add Vitest coverage around the CLI argument parser, validation failure flows, watch trigger aggregation, and summary generation.
   - Update repository docs and onboarding guides to describe the new workflow.

Delivery order: steps 1 → 3 must complete before CI accepts the change; step 4 can land incrementally but should finish before closing the issue.

## 8. Testing Strategy

- **Unit tests** (`tools/content-schema-cli/src/__tests__/compile.test.js`):
  - Validation success and failure scenarios, asserting exit codes and emitted logs.
  - `--check` drift detection for manifest and compiler artifacts.
  - Watch mode trigger summarisation and repeated failure handling.
- **Integration tests** in `packages/content-compiler`: verify schema options are honoured and dependency ordering works.
- **Manual verification**:
  - Run `pnpm generate` after editing a pack to ensure artifacts update and logs show `content_pack.compiled`.
  - Run `pnpm generate --check` to confirm drift detection.
  - Run `pnpm generate --watch --pretty` and modify packs to ensure watch events fire.
- **CI validation**: extend the pipeline to parse the final log line and assert exit statuses, ensuring no console noise corrupts JSON output (supports `vitest-llm-reporter` downstream).

## 9. Risks & Mitigations

- **Log noise breaking JSON consumers:** Constrain all console output to structured payloads; guard against incidental `console.log` calls by linting tests and reviewing diffs.
- **Performance degradation with many packs:** Cache the validator instance, avoid repeated filesystem reads, and measure wall-clock time in tests; future optimisation includes parallel validation if necessary.
- **Watch mode instability:** Debounce file system events, cap trigger logging, and provide clear status to avoid developer confusion when auto-runs fail repeatedly.
- **Schema/CLI version mismatch:** Build the compiler on demand and bubble import errors with contextual messaging so developers know to run `pnpm install` or rebuild packages.

## 10. Open Questions & Follow-Ups

- Should warning thresholds escalate to failures in CI (e.g., treat warnings as errors via `--fail-on-warning`)?
- Do we need a standalone `validate` subcommand for quick checks without manifest/compile work, or is the combined pipeline sufficient?
- How should we expose the summary JSON schema to other tooling (publish types or JSON Schema artifact)?
- When content packs specify optional digests or compatibility metadata, should validation enforce semantic version ranges beyond basic format checks (ties to Issue #138)?

