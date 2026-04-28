---
title: Agent-First Workflow Design
sidebar_position: 30
---

# Agent-First Workflow Design

## Document Control
- **Title**: Introduce agent-first workflow infrastructure
- **Authors**: Codex
- **Reviewers**: TBD
- **Status**: Draft
- **Last Updated**: 2026-04-28
- **Related Issues**: TBD
- **Execution Mode**: AI-led

## 1. Summary
Idle Engine already has many agent-friendly ingredients: a compact `AGENTS.md`, deterministic Vitest output, design documents, CI quality gates, fast local checks, shell-desktop MCP tools, and generated coverage/performance reports. The next step is to make those pieces operate as an explicit agent-first workflow. This design proposes a repository-local knowledge map, documentation freshness checks, architecture boundary linting, standardized agent run artifacts, one-command shell MCP validation, package-level orientation docs, and recurring cleanup tasks so agents can navigate, verify, and improve the codebase with less implicit context from humans.

## 2. Context & Problem Statement
- **Background**: The repository is a TypeScript pnpm monorepo for deterministic idle-game runtime, content tooling, renderers, shell automation, documentation, and diagnostic CLIs. Current guidance lives in `AGENTS.md`, `docs/index.md`, `docs/role-index.md`, package READMEs, design docs, CI workflows, Lefthook hooks, and shell MCP docs.
- **Problem**: Agent workflow depends on scattered knowledge that is not fully indexed or mechanically guarded. Some docs are stale, many docs are not exposed in the Docusaurus sidebar, several packages lack README entry points, architecture constraints are partly cultural instead of enforced, and the shell MCP validation loop requires humans or agents to assemble multiple commands manually.
- **Forces**:
  - Agent context is limited; entry instructions must point to the right source quickly.
  - Repository-local artifacts are the only durable context agents can depend on.
  - The runtime must remain deterministic, test output must remain machine-readable, and generated artifacts must stay in sync.
  - CI already has meaningful quality gates; new checks must avoid making routine docs-only work unnecessarily slow.
  - Local worktrees and agent scratch files must not pollute diffs or task context.

## 3. Goals & Non-Goals
- **Goals**:
  1. Make `AGENTS.md` a concise table of contents that routes agents to task-specific context.
  2. Create a canonical agent map that links tasks to docs, packages, commands, tools, and validation expectations.
  3. Detect stale or orphaned documentation mechanically.
  4. Encode architecture and taste invariants in lint/test tooling instead of relying on review memory.
  5. Provide a one-command local validation loop for shell-desktop MCP workflows.
  6. Standardize local agent run artifacts for screenshots, logs, diagnostics, benchmark JSON, and validation summaries.
  7. Reduce agent guesswork by adding package READMEs for all workspace packages and tools.
  8. Keep the workflow incremental so each improvement can land in a focused PR.
- **Non-Goals**:
  - Replacing human product or architecture judgment.
  - Rewriting existing design docs as part of the first rollout.
  - Introducing a production observability stack.
  - Enforcing every style preference through lint immediately.
  - Changing runtime, content, renderer, or shell public APIs except where needed for validation tooling.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Maintainers reviewing agent-authored work.
  - Runtime, content, renderer, shell, and tooling contributors.
  - Agents executing GitHub issues, design-doc tasks, reviews, and validation loops.
- **Agent Roles**:
  - **Workflow Infrastructure Agent**: Implements repository maps, scripts, CI hooks, and gitignore hygiene.
  - **Docs Agent**: Maintains doc indexes, frontmatter, sidebars, cross-links, and package READMEs.
  - **Architecture Guard Agent**: Adds and tunes import-boundary, file-size, generated-artifact, and docs freshness checks.
  - **Shell Validation Agent**: Builds shell-desktop MCP smoke/regression commands and standardized artifact output.
  - **Cleanup Agent**: Runs recurring scans for stale docs, oversized files, missing READMEs, and repeated helper patterns.
- **Affected Packages/Services**:
  - `AGENTS.md`
  - `docs/`
  - `packages/docs`
  - `packages/config-eslint`
  - `packages/shell-desktop`
  - `tools/scripts`
  - `.github/workflows`
  - `.gitignore`
- **Compatibility Considerations**:
  - Existing commands such as `pnpm lint`, `pnpm test:ci`, `pnpm docs:build`, `pnpm generate --check`, and `pnpm shell:desktop:mcp:smoke` must keep their current behavior.
  - New checks should start as focused tests or warnings where churn is expected, then become stricter once the repository is clean.
  - Docs-only PRs should remain cheap to validate locally.

## 5. Current State
- `AGENTS.md` is compact and useful, but it primarily lists conventions and commands. It does not route agents by task type or point to a canonical agent workflow map.
- `docs/index.md` introduces the docs hub and contributor flow, while `docs/role-index.md` gives high-level role entry points. The role index is currently too thin to serve as the only task router.
- `docs/design-document-template.md` already defines an AI-first design-doc structure with work breakdown, agent guidance, validation hooks, and migration playbooks.
- `docs/implementation-plan.md` is stale in important places: it describes missing CI, minimal tests, absent content compiler, and absent persistence, although the repository now includes those capabilities.
- The repository has many docs, but only a subset appears in `packages/docs/sidebars.ts`. Agents can miss design history that is present but not discoverable.
- `packages/docs/scripts/test-docs.mjs` verifies selected doc invariants, but `@idle-engine/docs` has no `test:ci` script, so the root `pnpm test:ci` workspace runner does not execute it.
- CI already runs lint, typecheck, generated version validation, schema compatibility, build, dist sync, content validation with JSON-tail verification, coverage generation, tests, benchmark checks, and SonarCloud.
- Lefthook already runs staged-file-sensitive lint, typecheck, build, content generation, focused core/content tests, version checks, and dist sync.
- `packages/config-eslint` can restrict accidental `@idle-engine/core/internals` imports, but broader package/domain dependency rules are not yet encoded.
- `docs/shell-desktop-mcp.md` documents shell MCP quickstart, gateway mode, tool surface, client setup, and example workflows. The workflow is strong but not packaged as a single agent validation command.
- Several workspace packages and tools do not have package-level README entry points, including `packages/content-compiler`, `packages/content-schema`, `packages/controls`, `packages/renderer-contract`, `packages/renderer-debug`, `tools/content-schema-cli`, `tools/coverage-report`, and `tools/runtime-sim`.
- Local untracked agent/worktree artifacts such as `.agtx/` and editor swap files can appear in `git status`, increasing noise for agents.

## 6. Proposed Solution

### 6.1 Architecture Overview
- **Narrative**: Treat the repository as the agent operating environment. Agents start with a small `AGENTS.md`, follow a task-to-context map, use package READMEs and design docs as the source of truth, run bounded validation commands, write artifacts to a predictable location, and rely on CI/lint/tests to enforce important invariants. Human review focuses on product and architecture judgment, while the repo handles repeatable navigation and quality checks.
- **Diagram**:

```text
Prompt or issue
  -> AGENTS.md
  -> docs/agent-map.md
  -> task-specific docs + package README
  -> implementation or docs change
  -> focused validation
  -> artifacts/agent-runs/<run-id>/
  -> CI + review
  -> doc/tooling cleanup when drift is found
```

### 6.2 Detailed Design
- **Runtime Changes**:
  - No runtime gameplay changes are required.
  - Shell validation may call existing runtime and renderer surfaces through shell-desktop MCP.
  - Any new runtime diagnostic output must keep deterministic JSON payloads and avoid corrupting Vitest or benchmark final JSON lines.
- **Data & Schemas**:
  - Add `docs/agent-map.md` as the canonical task router.
  - Add a lightweight `docs/doc-index.json` or generated manifest only if a Markdown-only index becomes too hard to validate.
  - Standardize local artifact output under `artifacts/agent-runs/<YYYYMMDD-HHMMSS-task>/`.
  - Suggested artifact files:
    - `summary.json`: command outcomes, duration, git SHA, branch, and validation status.
    - `commands.log`: bounded command list and exit codes.
    - `shell-mcp-health.json`: shell MCP health response when relevant.
    - `renderer-status.json`: renderer status and error banner state when relevant.
    - `logs-tail.jsonl`: bounded structured log samples.
    - `screenshot.png`: shell/window screenshot when UI or renderer behavior changed.
    - `notes.md`: short human-readable notes for review.
- **APIs & Contracts**:
  - `docs/agent-map.md` should contain a table with:
    - Task family.
    - Primary docs to read.
    - Main packages and files.
    - Required validation commands.
    - Artifact expectations.
    - Escalation triggers.
  - Add package README contracts for every workspace package:
    - Purpose.
    - Public entry points.
    - Important invariants.
    - Common commands.
    - Related docs.
    - Validation guidance.
  - Add architecture boundary rules to `@idle-engine/config-eslint` or a small structural test:
    - `packages/core` must not import shell, renderer, docs, or tool packages.
    - Content schema/compiler packages must not import shell-desktop.
    - Renderer contract must not import renderer implementations.
    - Shell-desktop may import integration surfaces but should prefer public or harness entry points before internals.
    - Game/app-facing code should avoid `@idle-engine/core/internals`.
- **Tooling & Automation**:
  - Add a docs index check:
    - Every top-level `docs/*.md` file must be in the sidebar, explicitly archived, or marked hidden through approved frontmatter.
    - Design docs should include `Document Control` and `Last Updated`.
    - Stale superseded docs must link to their replacement.
  - Add `test:ci` to `@idle-engine/docs` so root `pnpm test:ci` runs doc invariants.
  - Add a file-size guardrail:
    - Start with a warning/report for non-generated source files over a threshold such as 1,500 lines.
    - Exempt generated files and fixtures.
    - Promote worst offenders into follow-up refactor issues instead of blocking all work immediately.
  - Add `pnpm agent:shell-smoke`:
    - Start or verify the shell MCP gateway.
    - Start the headless shell backend when not already available.
    - Run health, sim status, pause/step, renderer status, logs tail, WebGPU health, and screenshot.
    - Write a single `summary.json` plus optional screenshot/log artifacts.
    - Stop only processes started by the command.
  - Add `pnpm agent:doctor`:
    - Print branch, git status summary, Node/pnpm versions, package install state, docs check status, and recommended focused validation commands for changed files.
  - Add `.gitignore` entries for local agent scratch directories and editor swap files that are known to appear during agent runs.

### 6.3 Operational Considerations
- **Deployment**:
  - Phase new checks into CI gradually. Start with docs tests and non-blocking reports, then convert stable checks to required failures.
  - Keep manual coverage/performance refresh behavior unchanged unless a PR explicitly targets those reports.
- **Telemetry & Observability**:
  - Prefer local JSON artifacts first.
  - Shell MCP artifacts should include bounded logs and renderer/WebGPU status.
  - Future observability can expose runtime metrics and trace-like diagnostic timelines through local files or MCP tools before adopting external services.
- **Security & Compliance**:
  - Local MCP must continue binding to loopback only.
  - Artifact writers must avoid capturing secrets, environment dumps, tokens, or arbitrary home-directory files.
  - Agent scratch directories should remain ignored and must not be uploaded by CI unless explicitly selected.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| docs(agent): add canonical agent map | Add `docs/agent-map.md` with task families, context packets, commands, artifacts, and escalation triggers | Docs Agent | Design approval | New doc is in sidebar; `AGENTS.md` links to it; docs build succeeds |
| docs(agent): refresh AGENTS.md as table of contents | Replace broad prose with a compact map to agent docs, role index, commands, and repo-specific safety rails | Docs Agent | Agent map | `AGENTS.md` stays under 120 lines; task routing is explicit; no duplicated long-form guidance |
| test(docs): run docs invariants in CI | Add `test:ci` to `@idle-engine/docs` and ensure root `pnpm test:ci` executes doc invariant tests | Workflow Infrastructure Agent | None | `pnpm --filter @idle-engine/docs test:ci` passes; root `pnpm test:ci --filter @idle-engine/docs` passes |
| test(docs): enforce doc index coverage | Add a docs script that reports unindexed top-level docs and unsupported frontmatter states | Architecture Guard Agent | Sidebar policy decision | Script fails for orphan docs unless they are explicitly archived or hidden |
| docs(plan): refresh or supersede stale implementation plan | Update `docs/implementation-plan.md` current state or mark it superseded with a replacement roadmap | Docs Agent | Doc index check | Stale claims about missing CI/compiler/persistence are removed or marked historical |
| docs(readme): add missing package READMEs | Add concise READMEs for workspace packages/tools without entry docs | Docs Agent | Agent map | Every workspace package and tool has purpose, entry points, invariants, commands, and related docs |
| feat(lint): enforce package architecture boundaries | Add ESLint or structural tests for package/domain import rules with agent-actionable messages | Architecture Guard Agent | Boundary rules approved | CI fails on prohibited imports; rule messages include the preferred import or doc |
| test(tools): add source file-size report | Add a script that reports oversized non-generated source files and supports threshold/exemption config | Architecture Guard Agent | None | Report identifies current oversized files; generated files are exempt; follow-up issues are easy to create |
| feat(agent): add shell MCP smoke artifact command | Add `pnpm agent:shell-smoke` to run the MCP validation loop and write artifacts | Shell Validation Agent | Existing shell MCP commands | Command emits `summary.json`; captures health, sim status, renderer status, logs, WebGPU health, and screenshot |
| feat(agent): add agent doctor command | Add `pnpm agent:doctor` for environment and focused-validation recommendations | Workflow Infrastructure Agent | None | Command prints machine-readable summary and human-readable next commands |
| chore(agent): ignore local agent scratch files | Add `.agtx/`, `*.swp`, and any agreed local scratch paths to `.gitignore` | Workflow Infrastructure Agent | None | Clean checkout ignores local agent worktrees and editor swap files |
| docs(cleanup): define recurring cleanup cadence | Add or extend docs describing weekly/monthly agent cleanup scans and PR expectations | Cleanup Agent | Agent map | Cleanup scan categories are documented with commands, owners, and review expectations |

### 7.2 Milestones
- **Phase 1 - Navigation and Freshness**:
  - Deliverables: `docs/agent-map.md`, updated `AGENTS.md`, docs `test:ci`, doc index coverage check, stale implementation-plan resolution.
  - Gating criteria: docs build passes; root CI runs docs tests; agents have a single starting map.
- **Phase 2 - Package Legibility and Hygiene**:
  - Deliverables: missing package READMEs, `.gitignore` cleanup, file-size report.
  - Gating criteria: every workspace package/tool has an orientation README; local agent scratch files do not appear in normal status; oversized files have follow-up tickets.
- **Phase 3 - Mechanical Architecture Guardrails**:
  - Deliverables: package-boundary lint/structural tests, improved lint remediation messages, initial rule documentation.
  - Gating criteria: CI enforces approved boundaries without blocking legitimate integration paths.
- **Phase 4 - Validation Loop Automation**:
  - Deliverables: `agent:shell-smoke`, `agent:doctor`, artifact directory contract.
  - Gating criteria: shell validation can be run from one command and produces reviewable local artifacts.
- **Phase 5 - Recurring Cleanup**:
  - Deliverables: documented cleanup cadence, optional scheduled/manual workflow, issue templates or PR checklist updates.
  - Gating criteria: recurring cleanup tasks can open small, reviewable PRs without human-generated context packets.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - `AGENTS.md`
  - `docs/index.md`
  - `docs/role-index.md`
  - `docs/design-document-template.md`
  - `docs/contributor-handbook.md`
  - `docs/testing-guidelines.md`
  - `docs/shell-desktop-mcp.md`
  - `packages/docs/scripts/test-docs.mjs`
  - `packages/docs/sidebars.ts`
  - `packages/config-eslint/index.js`
  - `package.json`
  - `lefthook.yml`
  - `.github/workflows/ci.yml`
- **Communication Cadence**:
  - Each phase should land as one or more focused PRs.
  - PR descriptions must list changed workflow commands and validation run.
  - Boundary-rule PRs require explicit examples of allowed and disallowed imports.
  - Shell MCP command PRs should attach or describe generated artifact paths.
- **Escalation Path**:
  - Escalate to maintainers when a lint rule would require moving public API boundaries.
  - Escalate when stale docs contradict shipped behavior and no source of truth is obvious.
  - Escalate when shell MCP validation requires long-running processes the script cannot safely own.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - For docs/navigation work: load `AGENTS.md`, `docs/index.md`, `docs/role-index.md`, `docs/design-document-template.md`, and `packages/docs/sidebars.ts`.
  - For docs tests: load `packages/docs/scripts/test-docs.mjs`, `packages/docs/scripts/lint-docs.mjs`, and `packages/docs/package.json`.
  - For architecture lint work: load `packages/config-eslint/index.js`, root `eslint.config.mjs`, and package-specific `eslint.config.js` files.
  - For shell validation: load `docs/shell-desktop-mcp.md`, `packages/shell-desktop/README.md`, and `tools/scripts/shell-desktop-mcp-smoke.mjs`.
  - For CI changes: load `.github/workflows/ci.yml`, `.github/workflows/docs-preview.yml`, `lefthook.yml`, and root `package.json`.
- **Prompting & Constraints**:
  - Keep `AGENTS.md` concise; move durable details into docs and link them.
  - Prefer mechanical checks over prose when the rule is repeatable.
  - Write lint/test failure messages with remediation instructions that an agent can act on.
  - Preserve final JSON output contracts for Vitest reporter, benchmarks, content generation, and CLI tools.
  - For shell validation commands, bound runtime, log volume, screenshot size, and retry count.
  - Do not update generated coverage or performance pages unless the task explicitly targets those reports.
- **Safety Rails**:
  - Do not commit secrets, `.env` files, local worktrees, agent scratch directories, or editor swap files.
  - Do not disable lint/test/build checks to land workflow changes.
  - Do not make broad architecture rules blocking until current violations are understood and either fixed or exempted with justification.
  - Do not stop or kill long-running local processes unless the script started them.
  - Do not rely on external chat, issue comments, or local-only notes as the durable source of truth; encode durable guidance in repository docs or tooling.
- **Validation Hooks**:
  - Docs-only navigation changes: `pnpm --filter @idle-engine/docs test`, `pnpm docs:build`.
  - `AGENTS.md` or root workflow guidance changes: `pnpm fast:check` plus any targeted docs tests.
  - ESLint config changes: `pnpm lint`, `pnpm --filter @idle-engine/config-eslint test:ci` if tests are added.
  - Shell MCP validation changes: `pnpm --filter @idle-engine/shell-desktop test:ci`, `pnpm shell:desktop:mcp:smoke`, and the new `pnpm agent:shell-smoke` once available.
  - CI workflow changes: local focused command where possible plus PR CI confirmation.

## 9. Alternatives Considered
- **One large `AGENTS.md` manual**:
  - Rejected because it would crowd out task context, duplicate docs, and become difficult to verify mechanically.
- **Docs-only workflow improvements**:
  - Rejected as insufficient. Prose helps agents navigate, but boundary, freshness, and artifact rules need tests or scripts.
- **Adopt full local observability stack immediately**:
  - Deferred. The repository already has diagnostics, MCP logs, benchmarks, and artifacts. A full logs/metrics/traces stack should follow only after local JSON artifacts and shell validation prove the need.
- **Block all oversized files immediately**:
  - Rejected for initial rollout. Existing large files need planned refactors; the first step should report and prioritize rather than block unrelated work.
- **Put agent artifacts in tracked docs**:
  - Rejected. Artifacts are run outputs and should remain ignored unless a specific report is intentionally committed.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Add docs tests for sidebar/index coverage and required frontmatter.
  - Add structural tests or ESLint fixtures for architecture-boundary rules.
  - Add package README coverage tests if missing README drift becomes common.
- **Performance**:
  - `agent:doctor` and docs checks should complete in seconds.
  - `agent:shell-smoke` should use bounded startup and validation timeouts and should report timeout separately from validation failure.
  - File-size report should scan tracked files without requiring TypeScript compilation.
- **Tooling / A11y**:
  - `pnpm docs:build` remains the primary documentation rendering check.
  - Shell screenshot artifacts should be review aids, not golden pixel tests in the initial rollout.
  - If renderer UI validation grows, add explicit screenshot comparison thresholds in a later design.

## 11. Risks & Mitigations
| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| New checks slow down routine work | Medium | Medium | Start with focused scripts and only wire stable checks into CI |
| Boundary rules block legitimate integration paths | High | Medium | Begin with documented allowed edges and fixture tests before enforcing broadly |
| Docs index check creates noisy churn | Medium | High | Allow explicit `archived` or `hidden` states and migrate docs in batches |
| Shell MCP smoke is flaky on headless hosts | Medium | Medium | Bound retries, separate startup failure from renderer failure, and preserve diagnostic artifacts |
| Agent artifacts accidentally capture sensitive data | High | Low | Bound artifact paths and contents; never dump full environment variables |
| Stale implementation docs keep misleading agents | High | High | Refresh or supersede stale roadmap docs in Phase 1 |
| Large-file guardrail produces reports without cleanup | Medium | Medium | Require follow-up issue links for files over the threshold |

## 12. Rollout Plan
- **Milestones**:
  1. Land this design document and sidebar entry.
  2. Implement Phase 1 navigation and freshness checks.
  3. Implement Phase 2 package README and local hygiene work.
  4. Implement Phase 3 architecture boundary checks.
  5. Implement Phase 4 shell validation and agent artifact commands.
  6. Implement Phase 5 recurring cleanup documentation/workflow.
- **Migration Strategy**:
  - Treat existing docs as valid until the doc index check lands.
  - Mark stale docs explicitly as `Status: Superseded` before deleting or moving them.
  - Introduce boundary checks with current-repo fixture coverage.
  - Add exemptions only with comments that identify the owner and removal condition.
- **Communication**:
  - Announce new agent commands in `AGENTS.md`, `docs/agent-map.md`, and `docs/contributor-handbook.md`.
  - Mention changed validation expectations in PR descriptions.
  - Capture recurring cleanup outputs as small PRs with clear before/after evidence.

## 13. Open Questions
1. Should archived design docs stay under `docs/` with hidden frontmatter, or move into a dedicated `docs/archive/` folder?
2. What exact file-size threshold should become blocking after the initial report phase?
3. Which package dependency edges should be allowed for shell-desktop integration with core internals?
4. Should agent artifacts use only ignored local files, or should selected summaries be uploaded as CI artifacts in workflow runs?
5. Should `agent:shell-smoke` manage xpra/Electron lifecycle itself, or require callers to start the daemon first?
6. Should recurring cleanup be a scheduled GitHub Actions workflow, a manual workflow, or a documented local task run by agents?

## 14. Follow-Up Work
1. Add PR template prompts for agent artifacts, validation commands, and doc updates.
2. Add a lightweight issue template for agent workflow improvements.
3. Add examples of successful `agent:shell-smoke` artifacts once the command exists.
4. Consider a local observability design after shell MCP artifacts and diagnostics expose concrete gaps.
5. Consider a dedicated quality score document that tracks doc freshness, package README coverage, boundary rule coverage, and oversized-file count.

## 15. References
- `AGENTS.md` - Repository-level agent instructions.
- `docs/index.md` - Documentation hub.
- `docs/role-index.md` - Current role-based entry points.
- `docs/design-document-template.md` - Canonical design document template.
- `docs/contributor-handbook.md` - Development and CI workflow guidance.
- `docs/testing-guidelines.md` - Test organization and deterministic-output expectations.
- `docs/shell-desktop-mcp.md` - Shell desktop MCP quickstart, tool surface, and workflows.
- `packages/docs/scripts/test-docs.mjs` - Existing docs invariant checks.
- `packages/docs/sidebars.ts` - Docusaurus sidebar index.
- `packages/config-eslint/index.js` - Shared ESLint configuration and current internals restriction.
- `package.json` - Workspace command surface.
- `.github/workflows/ci.yml` - CI quality gate.
- `lefthook.yml` - Local pre-commit quality gates.
- OpenAI, "Harness engineering: leveraging Codex in an agent-first world" (2026-02-11), https://openai.com/index/harness-engineering/

## Appendix A - Glossary
- **Agent map**: A repository-local task router that tells agents which docs, packages, commands, and validations apply to a task.
- **Artifact contract**: The expected local file layout and payloads produced by an agent validation run.
- **Boundary rule**: A lint or structural-test invariant that limits dependency direction between packages or domains.
- **Doc freshness check**: A script or test that detects stale, orphaned, superseded, or unindexed documentation.
- **Shell MCP validation loop**: A local workflow that uses shell-desktop MCP tools to inspect runtime, renderer, logs, WebGPU state, and screenshots.

## Appendix B - Change Log
| Date | Author | Change Summary |
|------|--------|----------------|
| 2026-04-28 | Codex | Initial draft for agent-first workflow infrastructure |
