---
title: Vitest Coverage Report Automation
---

# Vitest Coverage Report Automation

## Document Control
- **Title**: Vitest Coverage Report Automation
- **Document ID**: 342
- **Authors**: Codex Automation Agent
- **Reviewers**: Quality & Diagnostics maintainers
- **Status**: Draft
- **Last Updated**: 2025-11-07
- **Related Issues**: [#342](https://github.com/hansjm10/Idle-Game-Engine/issues/342)
- **Execution Mode**: AI-led

## 1. Summary
CI lacks a deterministic view of Vitest coverage, forcing stakeholders to run local commands to inspect coverage drift. This design introduces a workspace command (`pnpm coverage:md`) that runs coverage-enabled Vitest suites for every package, aggregates the resulting `coverage-summary.json` files, and generates a Docusaurus page (`docs/coverage/index.md`) with both overall and per-package coverage tables plus regeneration instructions. The automation fails fast when coverage artifacts are missing or stale, runs inside CI, and keeps the generated markdown checked in so documentation stays in sync with test health.

## 2. Context & Problem Statement
- **Background**: Each package already runs Vitest via `pnpm test`/`pnpm test:ci`, but coverage reporters (`text`, `lcov`) only emit to stdout or artifacts that are never published. Docs visitors have no telemetry showing whether tests meaningfully cover the runtime, shell, or content tooling.
- **Problem**: Release managers and external contributors cannot verify coverage budgets or identify regressions without cloning the repo, running Vitest with `--coverage`, and manually inspecting multiple `coverage-summary.json` files.
- **Forces**: Coverage must be deterministic, CI-safe, and headless (no browsers). The generated markdown must remain noise-free so downstream agents parsing docs or the final JSON reporter stay reliable. Time spent regenerating docs should stay below 3 minutes on CI hardware.

## 3. Goals & Non-Goals
- **Goals**
  1. One-shot coverage command that fans out across every workspace package using Vitest.
  2. Deterministic aggregation script that renders overall and per-package coverage tables plus operator guidance.
  3. CI enforcement to prevent merges when coverage artifacts or docs drift.
  4. Documentation updates (sidebar + contributor handbook) so humans discover the workflow.
- **Non-Goals**
  - Tracking historical coverage trends or charts (handled later via analytics).
  - Converting all packages to 100% coverage; this work only reports current state.
  - Replacing LCov reporters or publishing HTML dashboards.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Quality & Diagnostics maintainers, Docs maintainers.
- **Agent Roles**
  - *Tooling Automation Agent*: implements the coverage command, aggregator script, and CI wiring.
  - *Docs Agent*: owns the generated markdown, sidebar entry, and contributor guidance.
- **Affected Packages/Services**: `@idle-engine/core`, `@idle-engine/content-*`, `packages/docs`, new `tools/coverage-report` utility, `.github/workflows/ci.yml`, root `package.json`.
- **Compatibility Considerations**: Coverage command must respect existing test filters and avoid mutating package APIs. Generated docs are additive and should not break existing sidebar routes.

## 5. Current State
- Workspace scripts (`pnpm test`, `pnpm test:ci`) call `tools/scripts/run-workspace-test.sh`, which runs each package’s `test` or `test:ci` script but never enables coverage.
- `@idle-engine/config-vitest` only emits `text` and `lcov` coverage reporters, so there is no `coverage/coverage-summary.json` to parse when tests succeed normally.
- There is no `docs/coverage/` directory, no sidebar entry, and no README mention of coverage workflows.
- CI’s `Quality Gate` job stops at `pnpm test:ci`; it neither runs coverage nor verifies docs derived from coverage.

## 6. Proposed Solution

### 6.1 Architecture Overview
1. **Collection**: `pnpm coverage:md` invokes a new helper (`tools/scripts/run-workspace-coverage.sh`) that reuses the existing workspace runner but always forwards `vitest run --coverage --reporter=json` to each package. Coverage config adds `json-summary` so Vitest writes `coverage/coverage-summary.json` under every package.
2. **Aggregation**: After tests finish, the command executes `tsx tools/coverage-report/index.ts`. The script crawls `packages/` and `tools/` for `coverage/coverage-summary.json`, infers the package name from the nearest `package.json`, and aggregates totals plus per-package stats.
3. **Publication**: The script writes `docs/coverage/index.md` with (a) an intro + regeneration instructions, (b) an overall coverage table, and (c) a per-package table sorted alphabetically. Formatting uses fixed-width percentage strings (two decimals) to keep diffs stable.
4. **Enforcement**: CI gains a `Coverage Report` step after `pnpm test:ci` that runs `pnpm coverage:md` and fails when coverage generation or markdown emission leaves a dirty working tree, guaranteeing main always contains the latest report.

### 6.2 Detailed Design
- **Coverage command**
  - Add `tools/scripts/run-workspace-coverage.sh` mirroring `run-workspace-test.sh` but forcing `pnpm -r run --if-present test:ci -- --coverage --reporter=json`.
  - Root `package.json` defines `"coverage:md": "./tools/scripts/run-workspace-coverage.sh && tsx tools/coverage-report/index.ts"`.
  - Each package extends scripts with `test:coverage` or reuses `test:ci` to ensure `vitest run --coverage` works headlessly.
- **Coverage reporter configuration**
  - Update `@idle-engine/config-vitest` to include `'json-summary'` in `coverage.reporter`.
  - Standardize output directories by setting `coverage.dir = 'coverage'` to avoid OS-specific defaults.
- **Aggregator script**
  - Implemented in TypeScript using built-in `fs/promises` plus `node:path`.
  - Discovers coverage files via manual directory walk limited to workspace roots to avoid node_modules.
  - Validates each file (schema: `total` + per-file objects) and ensures every participating package exposes `coverage.total`.
  - Aggregates totals by summing `covered` and `total` counts for the four metrics; `pct` recomputed instead of trusting input strings.
  - Output structure:
    ```
    # Coverage Report
    _Last updated: 2025-11-07_
    
    Run `pnpm coverage:md` ...
    
    ## Overall Coverage
    | Metric | Covered | Total | % |
    | ...    | ...     | ...   | ... |
    
    ## Coverage by Package
    | Package | Statements ... |
    ```
  - Script exits with non-zero code when (a) any package listed in `coverage.manifest.json` is missing coverage artifacts, (b) JSON parsing fails, or (c) no packages produced coverage (guarding against misconfigured runs).
- **Docs updates**
  - New generated file `docs/coverage/index.md` checked in and linked under a new “Diagnostics & Quality” sidebar category.
  - `docs/contributor-handbook.md` (or README) documents how to regenerate the coverage page and expectations for PRs touching tests.
- **Tooling dependencies**
  - Add `tsx` (or `ts-node`) as a dev dependency to run the TypeScript aggregator without a build step.

### 6.3 Operational Considerations
- **Deployment**: No runtime deployment; CI adds a deterministic gate. Local developers run `pnpm coverage:md` before pushing when tests change coverage behavior.
- **Telemetry & Observability**: None beyond coverage numbers themselves; `vitest-llm-reporter` remains unaffected because the coverage command runs in a separate script after standard `pnpm test:ci`.
- **Security & Compliance**: Script only reads workspace files and writes docs; no network calls or secrets involved.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| docs: automate Vitest coverage summary for Docusaurus (#342) | Add coverage command, aggregator, docs, and CI wiring | Tooling Automation Agent | This design approved | `pnpm coverage:md` and CI step succeed; docs updated |

### 7.2 Milestones
- **Phase 1 (This issue)**: Land coverage command, aggregator, generated doc, sidebar updates, and CI enforcement.
- **Phase 2 (Backlog)**: Evaluate publishing historical coverage trends (e.g., pushing JSON to an S3 bucket or GitHub Pages visualisation).

### 7.3 Coordination Notes
- Hand-off bundle: issue description, this design, `.github/workflows/ci.yml`, `packages/config-vitest/index.js`, and doc targets.
- Status sync: update GitHub issue comments when the design is approved and after CI verifies the first generated report.

## 8. Agent Guidance & Guardrails
- Load `docs/coverage-report-automation-design.md` and issue #342 before implementing.
- Use Conventional Commits with `Fixes #342` in the footer/body.
- Never edit generated `docs/coverage/index.md` manually; always rerun `pnpm coverage:md`.
- Keep tables ASCII-only and percentages formatted with `toFixed(2)` to stabilise diffs.
- CI must fail on dirty working trees after coverage generation; do not auto-commit in CI contexts.

## 9. Alternatives Considered
1. **Docusaurus plugin that reads `coverage-summary.json` at runtime** – rejected because docs deployments would drift from `main` without CI enforcement and would require bundling coverage JSON into the docs build.
2. **Publishing HTML coverage reports per package** – rejected to avoid bloating the repo and because stakeholders requested a single markdown summary.
3. **Extending `pnpm test:ci` to always run with coverage** – rejected due to the additional runtime overhead for every PR; coverage should be opt-in via `pnpm coverage:md`.

## 10. Testing & Validation Plan
- Unit-test the aggregator (pure functions) with fixture coverage JSON to verify sorting, aggregation, and failure modes.
- Run `pnpm coverage:md` locally on a clean workspace and confirm the resulting markdown matches expectations; rerun without code changes to verify determinism.
- Update CI to run the command on every push/PR; the job fails if coverage or markdown generation fails.

## 11. Risks & Mitigations
- **Long-running coverage suites**: Coverage adds overhead; mitigate by running packages sequentially (default `pnpm -r run`) and documenting estimated runtime.
- **Missing coverage artifacts**: Agents might forget to run the command after adding tests. Script throws clear errors listing missing packages, and CI prevents merges until resolved.
- **Markdown churn**: Small floating-point differences could thrash diffs. Recomputing percentages with fixed precision and consistent ordering keeps diffs predictable.

## 12. Rollout Plan
- Land this design + implementation via #342.
- Monitor CI runtime; if it grows significantly, consider gating coverage runs behind a nightly workflow.
- Announce the new command in the contributor handbook and link to the generated page.

## 13. Open Questions
1. Should the coverage command skip packages that intentionally lack tests (`test` script absent), or should we maintain an explicit allowlist?
2. Do we also want to publish branch coverage thresholds or alerts when a package drops below a target percentage?

## 14. Follow-Up Work
- Automate historical coverage trend storage once stakeholders confirm the static report meets their needs.
- Investigate embedding sparkline charts in the docs page once Docusaurus theme work is prioritised.

## 15. References
- `packages/config-vitest/index.js`
- `.github/workflows/ci.yml`
- `tools/scripts/run-workspace-test.sh`
- Issue [#342](https://github.com/hansjm10/Idle-Game-Engine/issues/342)

## Appendix A — Glossary
- **Coverage Summary**: The `coverage-summary.json` file emitted by Vitest/NYC containing `statements`, `branches`, `functions`, and `lines` totals.
- **Workspace Runner**: Helper scripts under `tools/scripts/` that execute a pnpm command across every package in the monorepo.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-11-07 | Codex Automation Agent | Initial draft |
