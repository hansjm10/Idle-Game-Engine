---
title: Content Validation CLI Design
---

# Content Validation CLI Design

Use this document to understand how content validation tooling is integrated into the shared CLI so `pnpm generate` enforces schema health before the compiler emits artifacts.

## Document Control
- **Title**: Integrate Content Validation into Shared CLI Workflow
- **Authors**: TODO
- **Reviewers**: TODO
- **Status**: Design
- **Last Updated**: 2025-10-23
- **Related Issues**: #13
- **Execution Mode**: AI-led

## 1. Summary

The Idle Engine repository currently ships a schema package (`@idle-engine/content-schema`) and a CLI scaffold under `tools/content-schema-cli`. The CLI generates the runtime event manifest but content packs can still ship invalid data because validation is not part of the default workflow. This design integrates content pack validation into the `pnpm generate` command so that schema violations abort compilation, emit actionable diagnostics as structured logs, and protect the deterministic runtime loop. The solution discovers packs, validates them in dependency order, produces machine-readable JSON events for CI consumption, and persists a workspace-level summary tracking validation and compilation outcomes.

## 2. Context & Problem Statement

- **Background**: The Idle Engine content pipeline relies on schemas defined in `@idle-engine/content-schema` and a compiler (`@idle-engine/content-compiler`) that generates deterministic JSON/TypeScript artifacts. The CLI under `tools/content-schema-cli` currently focuses on manifest regeneration via `pnpm generate` but does not validate content packs before compilation. Historical decisions emphasized runtime event manifest generation (`docs/idle-engine-design.md` §6.2) and schema contracts (`docs/content-dsl-schema-design.md`), but enforcement was deferred.

- **Problem**: Content packs can ship invalid data because validation is not wired into the default workflow. Contributors can land malformed content without local or CI-level warnings. Existing runs emit human-readable console noise that downstream automation cannot parse reliably, and artifacts may drift from authored packs without detection. The deterministic runtime loop is at risk when invalid content bypasses the compiler pipeline.

- **Forces**:
  - Performance targets: validation must remain performant for dozens of packs
  - Timeline: must integrate before schema regressions slip through CI
  - Partner requirements: structured logging guidance in `docs/idle-engine-design.md` §6.2 must be met
  - Compatibility: Node ≥20.10, pnpm ≥8 as defined in `package.json`
  - Workflow integration: Lefthook and CI depend on `pnpm generate`

## 3. Goals & Non-Goals

- **Goals**:
  1. **Deterministic enforcement**: Every `pnpm generate` run must validate all discovered packs before emitting runtime artifacts, aborting on schema failures to protect the deterministic runtime loop (`docs/idle-engine-design.md` §6.2).
  2. **Actionable diagnostics**: Emit machine-readable JSON events (`content_pack.*`) that surface pack slug, file path, warning counts, and blocker details so CI and humans can triage quickly without parsing prose logs.
  3. **Workflow integration**: Support one-shot, `--check`, and `--watch` modes with consistent exit codes, clean handling of drift, and optional pretty-printing to keep the developer experience aligned with other repo tooling.
  4. **Summary visibility**: Persist a workspace-level summary (`content/compiled/index.json`) that records validation and compilation outcomes—even when validation aborts compilation—so downstream scripts never read stale success snapshots.
  5. **Build hygiene**: Automatically build `@idle-engine/content-compiler` on demand, skip redundant rewrites, and prune stale artifacts so committed outputs always match authored packs.

- **Non-Goals**:
  - Replacing or redefining schema rules (tracked in Issue #11 and the schema design document)
  - Designing visual authoring tools or IDE plugins for content authors
  - Shipping content balance heuristics, localisation audits, or runtime formula inspection (compiler follow-ups cover those capabilities)
  - Altering the runtime event manifest format; the CLI continues to call `buildRuntimeEventManifest` for that responsibility
  - Introducing additional package managers or workflow orchestration beyond pnpm and chokidar

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**: Content pipeline team, CI/CD infrastructure owners, content pack authors
- **Agent Roles**:
  - **CLI Implementation Agent**: Responsible for wiring validation into the compile entrypoint, implementing CLI options, and ensuring structured logging
  - **Testing Agent**: Covers unit tests for validation flows, watch mode, drift detection, and property-based tests
  - **Docs Agent**: Updates repository documentation to reflect new workflow behaviors

- **Affected Packages/Services**:
  - `tools/content-schema-cli`: main integration point for validation wiring
  - `@idle-engine/content-schema`: provides `createContentPackValidator` and `validateContentPacks`
  - `@idle-engine/content-compiler`: consumes schema options, produces artifacts
  - `packages/**/content/`: all content packs under validation

- **Compatibility Considerations**:
  - Backward compatibility: existing `pnpm generate` invocations will now validate packs and may fail where they previously succeeded with invalid content
  - API stability: structured log event schemas (`content_pack.*`, `watch.*`, `cli.*`) should remain stable for CI parsing

## 5. Current State

- `tools/content-schema-cli/src/generate.js` reads runtime event metadata, builds the manifest module, and exposes `validateContentPacks` but this function is not wired into the default command.
- `pnpm generate` executes `pnpm --filter @idle-engine/content-validation-cli run compile`, which currently focuses on manifest regeneration and does not surface pack-level diagnostics or compiler integration.
- Structured logging guidance in `docs/idle-engine-design.md` (§6.2) is unmet; existing runs emit human-readable console noise that downstream automation cannot parse reliably.
- `packages/content-compiler` can compile packs into deterministic JSON/TypeScript artifacts (`docs/content-compiler-design.md`), but nothing triggers it during workspace routines and artifacts may drift.
- CI and Lefthook depend on `pnpm generate`; without validation wiring, schema regressions slip through local workflows.

## 6. Proposed Solution

### 6.1 Architecture Overview

- **Narrative**: The solution extends the existing `tools/content-schema-cli/src/compile.js` entrypoint to orchestrate a four-stage pipeline: (1) build the runtime event manifest, (2) validate all discovered content packs using schema validators, (3) write the manifest module, and (4) compile validated packs into deterministic artifacts. Each stage emits structured JSON logs for CI consumption. Validation failures abort compilation and persist a failure summary so downstream tooling observes the latest state. Watch mode adds debounced file system observation with trigger summarization. The CLI respects `--check` for drift detection, `--clean` for forced rewrites, and `--pretty` for human-readable output.

- **Diagram**: N/A (CLI orchestration flow documented in §6.2)

### 6.2 Detailed Design

#### Execution Pipeline

1. **Detect workspace root** and resolve options (`cwd`, `summary`, watch flags).
2. **Ensure compiler availability** by attempting to import `@idle-engine/content-compiler`; if it is missing, spawn `pnpm --filter @idle-engine/content-compiler run build` before retrying the import.
3. **Build runtime event manifest** via `buildRuntimeEventManifest`, capturing the generated source, manifest entries, and schema options (`manifestDefinitions`).
4. **Validate content packs** by calling `validateContentPacks(manifest.manifestDefinitions, options)`. The function:
   - Discovers pack documents under `packages/**/content/pack.(json|json5)`.
   - Supports both `pack.json` and `pack.json5`, using JSON.parse for strict JSON files and the JSON5 parser for relaxed syntax.
   - Builds a validator with `createContentPackValidator`.
   - Emits a `content_pack.validated` log per pack, including balance warnings/errors when present.
   - Emits `content_pack.validation_failed` logs for schema errors and throws when any failure occurs.
   - Serializes a failure summary to the workspace summary path before bubbling the error so consumers observe the latest validation status.
   - Returns schema options to seed the compiler (known packs, active IDs, runtime event catalogue) when validation succeeds.
5. **Write manifest** using `writeRuntimeEventManifest`, respecting `check` and `clean`.
6. **Compile packs** by calling `compileWorkspacePacks` with the workspace filesystem implementation and schema options from step 4. The compiler:
   - Topologically sorts packs based on declared dependencies (respects `metadata.dependencies.requires`).
   - Serializes normalized packs to deterministic JSON and generated TypeScript modules.
   - Produces artifact operations (written, deleted, unchanged) for per-pack outputs and the workspace summary.
7. **Emit compiler logs** using the logger returned by `loadContentCompiler().createLogger`, producing `content_pack.compiled`, `content_pack.skipped`, `content_pack.compilation_failed`, and `content_pack.pruned` events.
8. **Summarise run** by merging manifest and compiler results into a structured summary (pack totals, artifact actions, changed pack slugs). When validation fails, write a structured failure summary that captures the offending packs and skip compilation details. Watch mode emits an additional `watch.run` event with duration and trigger metadata.
9. **Set exit codes**: any validation failure, compiler failure, or drift in `--check` mode results in a non-zero exit status.

#### Runtime Changes

- Extend `compile.js` to invoke `validateContentPacks` after manifest build and before manifest write
- Plumb schema options from validation into the compiler call
- Add automatic compiler build step if `@idle-engine/content-compiler` is not importable

#### Data & Schemas

- **Validation Events**:
  - `content_pack.validated`: `{ event, packSlug, path, warningCount, warnings, balanceWarningCount, balanceWarnings, balanceErrorCount, balanceErrors }`
  - `content_pack.validation_failed`: `{ event, packSlug, packVersion, path, issues, message }`

- **Compiler Events**:
  - `content_pack.compiled`: `{ name, slug, path, durationMs, warnings, artifacts, check }`
  - `content_pack.skipped`: same shape but indicates all artifacts unchanged during `--check`
  - `content_pack.compilation_failed`: adds `message` and `stack`
  - `content_pack.pruned`: emitted when stale artifacts are removed

- **Watch Events**:
  - `watch.status`, `watch.hint`, `watch.run`: summarize triggers and run outcomes

- **Error Events**:
  - `cli.unhandled_error`: `{ event, message, stack, fatal, timestamp }`

- **Workspace Summary** (`content/compiled/index.json`):
  - Pack totals (compiled, failed, warning counts)
  - Artifact action counts grouped by action
  - Lists of changed and failed pack slugs
  - Manifest and summary action states
  - Timestamp and CLI version metadata

#### APIs & Contracts

- **CLI Options**:
  - `--check`: run without applying filesystem mutations; exit with code 1 if manifests, validation, or compiler artifacts would change
  - `--clean`: force rewrites even when outputs match, ensuring stale artifacts are replaced (ignored in `--check` runs)
  - `--watch`: observe content, manifest metadata, and base manifest files with chokidar; rerun the pipeline with debouncing
  - `--pretty`: pretty-print JSON log lines for human readability
  - `--cwd`/`-C`: override the workspace root (used for tests and sandboxes)
  - `--summary`: override the workspace summary output path (default: `content/compiled/index.json`)

- **Exit Codes**:
  - `0`: success
  - `1`: validation failure, compilation failure, or drift detected in `--check` mode

#### Tooling & Automation

- Update `printUsage()` to describe the integrated validation stage and log events
- Extend pack discovery to read both `pack.json` and `pack.json5`, falling back to JSON5 parser when relaxed syntax is detected

### 6.3 Operational Considerations

- **Deployment**: No changes to CI/CD beyond ensuring `pnpm generate` continues to run; structured logs enable future parsing for dashboards

- **Telemetry & Observability**:
  - JSON-per-line logs with no trailing commentary to protect downstream ingestion
  - All log emitters accept `pretty` to switch between single-line and indented JSON without changing field names
  - Unexpected runtime errors surface as `cli.unhandled_error` events, keeping console output machine-readable while preserving stack traces

- **Security & Compliance**: N/A (no PII handling, no new permissions required)

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(content-schema-cli): wire validation into generate command | Import and invoke `validateContentPacks` from compile entrypoint; plumb schema options into compiler | CLI Implementation Agent | Schema package stable | Validation runs before compilation; schema failures abort pipeline |
| feat(content-schema-cli): add structured logging for validation | Emit `content_pack.validated` and `content_pack.validation_failed` events with actionable diagnostics | CLI Implementation Agent | Validation wiring complete | All validation outcomes emit structured JSON logs |
| feat(content-schema-cli): persist workspace summary | Write deterministic summary JSON tracking validation/compilation outcomes; handle failure summaries | CLI Implementation Agent | Logging complete | Summary written on success and failure; `--check` detects drift |
| feat(content-schema-cli): support pack.json5 discovery | Extend pack discovery to read both `.json` and `.json5`; use JSON5 parser for relaxed syntax | CLI Implementation Agent | Validation wiring complete | Both formats validated; diagnostics surface for JSON5 files |
| test(content-schema-cli): cover validation flows | Add Vitest tests for validation success/failure, exit codes, drift detection, watch mode triggers | Testing Agent | CLI implementation complete | Unit tests pass; coverage includes property-based formula sanitization |
| docs: update content pipeline documentation | Revise README, `content-dsl-schema-design.md`, `content-compiler-design.md` to reflect new CLI behavior | Docs Agent | Implementation complete | Documentation accurately describes integrated workflow |

### 7.2 Milestones

- **Phase 1: Core Integration** (Steps 1-3 from Implementation Plan)
  - Deliverables: Validation wiring, structured logging, summary output, drift detection
  - Timeline: Must complete before CI accepts changes
  - Gating criteria: All validation and compilation flows emit correct structured logs; exit codes match spec

- **Phase 2: Testing & Documentation** (Step 4 from Implementation Plan)
  - Deliverables: Vitest coverage, updated docs, onboarding guides
  - Timeline: Can land incrementally but must finish before closing Issue #13
  - Gating criteria: Tests pass in CI; documentation reviewed and merged

### 7.3 Coordination Notes

- **Hand-off Package**: Existing source files under `tools/content-schema-cli/src/`, schema package `@idle-engine/content-schema`, compiler package `@idle-engine/content-compiler`

- **Communication Cadence**: Status updates per milestone completion; review checkpoints before merging phase 1 and phase 2

## 8. Agent Guidance & Guardrails

- **Context Packets**:
  - Review `docs/idle-engine-design.md` §6.2 for structured logging guidance
  - Review `docs/content-dsl-schema-design.md` for schema contracts
  - Review `docs/content-compiler-design.md` for compiler integration
  - Load existing `tools/content-schema-cli/src/generate.js` and `compile.js` source

- **Prompting & Constraints**:
  - All console output must be structured JSON (JSON-per-line)
  - Commit messages follow conventional commits format
  - Use `vitest` for all test coverage
  - Preserve Node ≥20.10 and pnpm ≥8 compatibility

- **Safety Rails**:
  - Do not modify schema rules or compiler output formats
  - Do not alter runtime event manifest structure
  - Do not reset git history
  - Avoid incidental `console.log` calls that corrupt JSON output

- **Validation Hooks**:
  - Run `pnpm test` to verify unit tests pass
  - Run `pnpm generate` to ensure CLI executes without errors
  - Run `pnpm generate --check` to confirm drift detection works
  - Run `pnpm generate --watch --pretty` and modify a pack to verify watch events fire

## 9. Alternatives Considered

- **Separate `validate` subcommand**: Considered adding a standalone validation command for quick checks without manifest/compile work. Rejected because it would fragment the workflow and increase maintenance burden. The combined pipeline is sufficient and ensures validation always precedes compilation.

- **Fail-fast vs. continue-on-error for compilation**: Considered aborting compilation when any single pack fails vs. compiling independent packs and surfacing aggregate failures. Chose continue-on-error to maximize feedback during development while still setting non-zero exit codes.

- **Warning thresholds as errors**: Considered treating warnings as failures via `--fail-on-warning` flag. Deferred to future work as it requires product decisions on acceptable warning levels.

- **Parallel validation**: Considered parallelizing validation across packs for performance. Deferred because single validator instance with sequential discovery is sufficient for current pack counts; can revisit if performance degrades.

## 10. Testing & Validation Plan

- **Unit / Integration**:
  - Vitest tests under `tools/content-schema-cli/src/__tests__/compile.test.js`:
    - Validation success and failure scenarios, asserting exit codes and emitted logs
    - Pack discovery covering both `pack.json` and `pack.json5` inputs
    - `--check` drift detection for manifest and compiler artifacts
    - Top-level error handling emits `cli.unhandled_error` JSON logs
    - Watch mode trigger summarization and repeated failure handling
  - Property-based sanitization tests in `tools/content-schema-cli/src/__tests__/validation.property.test.ts`:
    - Reuse `DEFAULT_FORMULA_PROPERTY_SEED` from `@idle-engine/content-schema` with fixed offsets for deterministic `vitest-llm-reporter` JSON
    - Update documented offsets if seeds change (see `docs/content-schema-rollout-decisions.md#6-property-based-formula-sanitization-guidance`)
  - Integration tests in `packages/content-compiler`: verify schema options honored and dependency ordering works

- **Performance**:
  - Cache validator instance, avoid repeated filesystem reads
  - Measure wall-clock time in tests
  - Future: parallel validation if necessary

- **Tooling / A11y**: N/A (CLI tool, no UI components)

- **Manual QA**:
  - Run `pnpm generate` after editing a pack to ensure artifacts update and logs show `content_pack.compiled`
  - Run `pnpm generate --check` to confirm drift detection
  - Run `pnpm generate --watch --pretty` and modify packs to ensure watch events fire

- **CI Validation**:
  - Extend pipeline to parse final log line and assert exit statuses
  - Ensure no console noise corrupts JSON output (supports `vitest-llm-reporter` downstream)

## 11. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Log noise breaking JSON consumers | CI parsing fails; `vitest-llm-reporter` breaks | Constrain all console output to structured JSON; lint tests for incidental `console.log` calls; review diffs for prose output |
| Performance degradation with many packs | Slow local workflows; CI timeouts | Cache validator instance; avoid repeated filesystem reads; measure wall-clock time; parallel validation if needed |
| Watch mode instability | Developer confusion; lost error signals | Debounce file system events (150ms); cap trigger logging (`MAX_TRIGGER_PATHS = 10`); emit clear status events |
| Schema/CLI version mismatch | Import errors; cryptic failures | Build compiler on demand; bubble import errors with contextual messaging directing developers to `pnpm install` |
| Breaking existing workflows | Contributors blocked by new failures | Document migration path; provide clear diagnostics for validation errors; staged rollout with warning period if needed |

## 12. Rollout Plan

- **Milestones**: See §7.2 (Phase 1: Core Integration, Phase 2: Testing & Documentation)

- **Migration Strategy**:
  - Existing `pnpm generate` invocations will now validate packs; invalid content will surface as failures
  - No data migrations required
  - No feature flags (validation always runs)
  - Backwards compatibility: existing valid packs continue to work; invalid packs now fail explicitly

- **Communication**:
  - Update repository README to describe new validation behavior
  - Document structured log schema for CI consumers
  - Provide runbook for triaging validation failures

## 13. Open Questions

- Should warning thresholds escalate to failures in CI (e.g., treat warnings as errors via `--fail-on-warning`)?
- Do we need a standalone `validate` subcommand for quick checks without manifest/compile work, or is the combined pipeline sufficient?
- How should we expose the summary JSON schema to other tooling (publish types or JSON Schema artifact)?
- When content packs specify optional digests or compatibility metadata, should validation enforce semantic version ranges beyond basic format checks (ties to Issue #138)?

## 14. Follow-Up Work

- **Warning threshold enforcement** (`--fail-on-warning` flag): product decision required on acceptable warning levels; new issue to track
- **Parallel validation optimization**: revisit if performance degrades with larger pack counts; benchmark and profile first
- **Standalone validate subcommand**: defer until clear user demand emerges; current pipeline may be sufficient
- **Summary JSON schema publication**: publish TypeScript types or JSON Schema artifact for CI tooling; track in separate issue
- **Semantic version validation**: extend validation to enforce version ranges for pack dependencies (Issue #138)

## 15. References

- `docs/idle-engine-design.md` §6.2: Structured logging guidance and deterministic runtime loop
- `docs/content-dsl-schema-design.md`: Schema contracts for content packs
- `docs/content-compiler-design.md`: Compiler artifact generation and integration points
- `docs/content-schema-rollout-decisions.md#6-property-based-formula-sanitization-guidance`: Property-based test authoring guidance
- Issue #11: Schema rule definitions
- Issue #13: Content validation CLI wiring (this document)
- Issue #138: Semantic version validation for pack dependencies

## Appendix A — Glossary

- **Content Pack**: A JSON or JSON5 document under `packages/**/content/pack.(json|json5)` defining game content (resources, generators, upgrades, etc.)
- **Runtime Event Manifest**: Generated module exposing metadata about available runtime events for validation
- **Schema Validator**: Instance of `createContentPackValidator` that enforces content pack schema rules
- **Structured Logging**: JSON-per-line log format for machine parsing (aligned with `docs/idle-engine-design.md` §6.2)
- **Workspace Summary**: Deterministic JSON artifact at `content/compiled/index.json` tracking validation and compilation outcomes
- **Drift Detection**: Mechanism in `--check` mode to detect when generated artifacts differ from what would be written
- **Topological Sort**: Ordering content packs based on declared dependencies so dependent packs compile after their requirements

## Appendix B — Change Log

| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-10-23 | TODO   | Initial design document |
| 2025-12-21 | Claude Opus 4.5 | Migrated to template format for Issue #195 |
