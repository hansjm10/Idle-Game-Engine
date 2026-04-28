---
title: Agent Map
sidebar_position: 28
---

# Agent Map

This is the canonical task router for agents working in Idle Engine. Start here
after reading `AGENTS.md`, then load only the context packet for the task family
you are handling.

Source initiative: [`docs/agent-first-workflow-design.md`](./agent-first-workflow-design.md).

## How to use this map

1. Identify the task family that matches the issue, PR review, or maintenance
   request.
2. Load the listed context packet before editing files.
3. Keep the diff centered in the listed packages or files.
4. Run the focused validation commands first, then broaden validation when the
   change crosses package or workflow boundaries.
5. Capture only the artifacts that help reviewers reproduce or inspect the
   change.

Escalate instead of guessing when the task crosses public API boundaries,
contradicts a design document, requires a new generated artifact policy, or
needs long-running local processes that are not clearly owned by the command you
are running.

## Runtime

Use this family for deterministic simulation behavior, runtime commands,
events, persistence, scheduling, telemetry, and core package exports.

- **Context packet**:
  - `AGENTS.md`
  - `docs/idle-engine-design.md`
  - `docs/runtime-step-lifecycle.md`
  - `docs/runtime-command-queue-design.md`
  - `docs/runtime-event-manifest-authoring.md`
  - `docs/diagnostic-timeline-design.md`
  - `packages/core/README.md`
- **Primary packages and files**:
  - `packages/core/src/`
  - `packages/core/src/__tests__/`
  - `packages/core/benchmarks/`
  - `packages/core/package.json`
- **Validation commands**:
  - `pnpm --filter @idle-engine/core test`
  - `pnpm --filter @idle-engine/core run test:ci`
  - `pnpm --filter @idle-engine/core run typecheck`
  - `pnpm lint`
- **Artifact expectations**:
  - Keep Vitest output machine-readable; do not add console noise before the
    final reporter JSON.
  - Include benchmark JSON only when runtime performance or payload shape is
    part of the change.
  - Note changed public exports and migration guidance in the PR body.
- **Escalation triggers**:
  - A stable `@idle-engine/core` export needs to be renamed, removed, or moved.
  - Deterministic step ordering, hydration semantics, or runtime event frame
    shape would change.
  - The fix requires shell, renderer, or content packages to depend on
    `@idle-engine/core/internals` instead of a public or harness entry point.

## Content Pipeline

Use this family for content schemas, DSL validation, compiler output, sample
packs, generated content modules, and content validation CLIs.

- **Context packet**:
  - `AGENTS.md`
  - `docs/content-dsl-schema-design.md`
  - `docs/content-dsl-usage-guidelines.md`
  - `docs/content-schema-reference.md`
  - `docs/content-compiler-design.md`
  - `docs/content-validation-cli-design.md`
  - `packages/content-sample/README.md`
- **Primary packages and files**:
  - `packages/content-schema/src/`
  - `packages/content-compiler/src/`
  - `packages/content-sample/content/`
  - `packages/content-sample/dist/`
  - `tools/content-schema-cli/src/`
  - `docs/examples/`
- **Validation commands**:
  - `pnpm generate --check`
  - `pnpm --filter @idle-engine/content-schema test`
  - `pnpm --filter @idle-engine/content-compiler test`
  - `pnpm --filter @idle-engine/content-validation-cli test`
  - `pnpm test:ci`
- **Artifact expectations**:
  - Commit generated sample or compiled outputs when the source content change
    requires them.
  - Preserve final JSON payloads emitted by content tooling.
  - Include schema compatibility notes when older generated packs may be
    affected.
- **Escalation triggers**:
  - A schema change is not backward-compatible or needs a migration path.
  - Generated output changes without a source content or compiler change.
  - Validation failures point to ambiguous DSL behavior rather than a simple
    fixture update.

## Renderer

Use this family for renderer contracts, debug renderers, WebGPU rendering,
sprite batching, atlases, render-frame metadata, and action regions.

- **Context packet**:
  - `AGENTS.md`
  - `docs/controls-contract-design-issue-705.md`
  - `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md`
  - `docs/runtime-event-manifest-authoring.md`
  - `packages/renderer-webgpu/README.md`
  - `packages/shell-desktop/README.md`
- **Primary packages and files**:
  - `packages/renderer-contract/src/`
  - `packages/renderer-debug/src/`
  - `packages/renderer-webgpu/src/`
  - `packages/controls/src/`
  - `packages/shell-desktop/src/renderer/`
- **Validation commands**:
  - `pnpm --filter @idle-engine/renderer-contract test`
  - `pnpm --filter @idle-engine/renderer-debug test`
  - `pnpm --filter @idle-engine/renderer-webgpu test`
  - `pnpm --filter @idle-engine/shell-desktop test`
  - `pnpm build`
- **Artifact expectations**:
  - Attach or describe screenshots when visual output changes.
  - Capture renderer status, WebGPU health, and relevant logs for shell-facing
    regressions.
  - Include generated renderer bundles or copied assets only when build output
    sync requires them.
- **Escalation triggers**:
  - Renderer contract types need a breaking change.
  - WebGPU fallback behavior or hardware assumptions change.
  - A renderer fix depends on runtime state that is not exposed through a stable
    contract.

## Shell MCP

Use this family for the Electron shell, headless launchers, MCP server and
gateway tools, shell automation, screenshots, logs, and local diagnostics.

- **Context packet**:
  - `AGENTS.md`
  - `docs/shell-desktop-mcp.md`
  - `docs/agent-first-workflow-design.md`
  - `packages/shell-desktop/README.md`
  - `tools/scripts/shell-desktop-mcp-smoke.mjs`
- **Primary packages and files**:
  - `packages/shell-desktop/src/`
  - `packages/shell-desktop/src/mcp/`
  - `tools/scripts/start-shell-desktop-headless.sh`
  - `tools/scripts/shell-desktop-mcp-smoke.mjs`
  - `tools/scripts/*shell-desktop*mcp*`
- **Validation commands**:
  - `pnpm --filter @idle-engine/shell-desktop test`
  - `pnpm --filter @idle-engine/shell-desktop run test:ci`
  - `pnpm shell:desktop:mcp:smoke`
  - `pnpm shell:desktop:headless`
- **Artifact expectations**:
  - Store local run artifacts under `artifacts/agent-runs/<run-id>/` when the
    task requires screenshots, logs, or health snapshots.
  - Include `summary.json`, bounded command logs, renderer status, WebGPU
    health, and a screenshot when validating UI or renderer behavior.
  - Do not capture secrets, arbitrary environment dumps, or home-directory files.
- **Escalation triggers**:
  - The script would need to kill a process it did not start.
  - MCP must bind outside loopback or accept non-local clients.
  - The smoke loop needs long retries, broad log capture, or manual GUI
    interaction to pass.

## Docs

Use this family for Markdown docs, Docusaurus navigation, design documents,
role guidance, contributor instructions, and package README orientation.

- **Context packet**:
  - `AGENTS.md`
  - `docs/index.md`
  - `docs/role-index.md`
  - `docs/design-document-template.md`
  - `docs/contributor-handbook.md`
  - `docs/testing-guidelines.md`
  - `packages/docs/sidebars.ts`
- **Primary packages and files**:
  - `docs/`
  - `packages/docs/`
  - `packages/docs/scripts/`
  - package-level `README.md` files
  - `AGENTS.md`
- **Validation commands**:
  - `pnpm --filter @idle-engine/docs test`
  - `pnpm --filter @idle-engine/docs lint`
  - `pnpm docs:build`
  - `pnpm fast:check`
- **Artifact expectations**:
  - Reference the source design, issue, or decision record that the doc updates.
  - Keep navigation diffs focused in `packages/docs/sidebars.ts`.
  - Do not refresh generated coverage or performance pages unless the issue
    explicitly targets those pages.
- **Escalation triggers**:
  - Two docs disagree about current shipped behavior and no source of truth is
    obvious.
  - A docs-only issue would require a new CI check, package README policy, or
    generated manifest.
  - `AGENTS.md` starts growing into a long manual instead of routing to durable
    docs.

## Tooling and CI

Use this family for workspace scripts, GitHub Actions, Lefthook hooks, lint
presets, fast checks, repository hygiene, and agent doctor-style commands.

- **Context packet**:
  - `AGENTS.md`
  - `docs/contributor-handbook.md`
  - `docs/agent-first-workflow-design.md`
  - `packages/config-eslint/README.md`
  - `package.json`
  - `lefthook.yml`
  - `.github/workflows/ci.yml`
- **Primary packages and files**:
  - `tools/scripts/`
  - `packages/config-eslint/`
  - `packages/config-vitest/`
  - `.github/workflows/`
  - `lefthook.yml`
  - root `package.json`
- **Validation commands**:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test:ci`
  - `pnpm fast:check`
  - `pnpm exec lefthook run pre-commit --all-files --force`
- **Artifact expectations**:
  - Record before and after command duration when changing CI or hook scope.
  - Include actionable failure text for new lint or structural rules.
  - Keep local scratch paths ignored rather than committed.
- **Escalation triggers**:
  - A guardrail would block existing legitimate package dependencies.
  - CI duration changes materially or requires new external services.
  - A hook needs to mutate unstaged files or hide validation output from agents.

## Benchmarks and Performance

Use this family for benchmark harnesses, performance reports, generated
performance docs, runtime overhead checks, and threshold changes.

- **Context packet**:
  - `AGENTS.md`
  - `docs/benchmark-output-schema.md`
  - `docs/validation-performance-benchmarks-caching-design.md`
  - `docs/content-validation-performance.md`
  - `docs/agent-first-workflow-design.md`
  - `package.json`
  - `tools/perf-report/index.ts`
- **Primary packages and files**:
  - `packages/core/benchmarks/`
  - `packages/content-schema/benchmarks/`
  - `tools/perf-report/`
  - `docs/performance/index.md`
  - benchmark fixtures and baselines near the package under test
- **Validation commands**:
  - `pnpm benchmark`
  - `pnpm perf:run`
  - `pnpm perf:md`
  - `pnpm --filter @idle-engine/content-schema run bench:check`
  - `pnpm --filter @idle-engine/core run benchmark`
- **Artifact expectations**:
  - Preserve machine-readable benchmark output shape.
  - Commit `docs/performance/index.md` only when explicitly refreshing the
    generated performance page.
  - Include baseline update rationale and the compared commit or run ID.
- **Escalation triggers**:
  - A threshold change weakens a regression gate.
  - Benchmark noise makes pass or fail status ambiguous.
  - Performance output schema changes would break report generation.

## Release and Generated Artifacts

Use this family for checked-in `dist/` outputs, generated runtime version files,
coverage reports, content outputs, package publishing readiness, and release
validation.

- **Context packet**:
  - `AGENTS.md`
  - `docs/contributor-handbook.md`
  - `docs/coverage-report-automation-design.md`
  - `docs/benchmark-output-schema.md`
  - `docs/agent-first-workflow-design.md`
  - package README for every package whose generated output changes
- **Primary packages and files**:
  - `packages/*/dist/`
  - `packages/content-sample/dist/`
  - `docs/coverage/index.md`
  - `docs/performance/index.md`
  - `tools/scripts/generate-version.mjs`
  - `tools/scripts/verify-dist-sync.mjs`
- **Validation commands**:
  - `pnpm build`
  - `pnpm generate --check`
  - `pnpm coverage:md`
  - `pnpm perf:md`
  - `pnpm test:ci`
- **Artifact expectations**:
  - Do not edit generated files by hand.
  - Commit refreshed generated files only when the issue explicitly calls for
    the refresh or the source change requires the output to stay in sync.
  - Prefer the manual Coverage Report workflow for coverage page refreshes, then
    commit the generated `docs/coverage/index.md` artifact when applying it.
- **Escalation triggers**:
  - A generated diff appears without a reproducible command.
  - Coverage or performance pages change during an unrelated fix.
  - Release validation requires secrets, publishing credentials, or production
    package registry access.
