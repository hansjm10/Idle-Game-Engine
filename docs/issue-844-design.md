---
title: "build: make workspace scripts run on Windows + Linux (Issue 844)"
sidebar_position: 99
---

# build: make workspace scripts run on Windows + Linux (Issue 844)

## Document Control
- **Title**: Make root workspace scripts cross-platform (Windows PowerShell + Linux bash) and prevent CRLF regressions
- **Authors**: Ralph (AI agent)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-25
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/844
- **Execution Mode**: AI-led

## 1. Summary
Replace the repo’s root workspace runner scripts (`pnpm build`, `pnpm lint`, `pnpm test`, etc.) that currently rely on `tools/scripts/*.sh` with cross-platform Node-based runners, so the commands work out-of-the-box on Linux and on Windows PowerShell without requiring WSL/Git Bash. Add guardrails to prevent CRLF line endings from breaking executable scripts, and extend CI to verify `pnpm run build` on both `ubuntu-latest` and `windows-latest`.

## 2. Context & Problem Statement
- **Background**:
  - The repo root `package.json` scripts call `./tools/scripts/run-workspace-*.sh` for common workflows (build/lint/test/coverage/benchmarks).
  - Those scripts are bash-specific (arrays, `[[ ... ]]`, `set -euo pipefail`) and are executed via shebang (`#!/usr/bin/env bash`).
- **Problem**:
  - On Windows/WSL checkouts where `tools/scripts/*.sh` end up with CRLF, the shebang line becomes `#!/usr/bin/env bash\r`, causing `/usr/bin/env: ‘bash\r’: No such file or directory`.
  - On native Windows (PowerShell/cmd), `.sh` scripts are not runnable without a bash environment (WSL/Git Bash), so `pnpm run build` fails immediately.
- **Forces**:
  - Preserve the existing CLI ergonomics (e.g. `pnpm build --filter @idle-engine/core -- --help`).
  - Keep runner logic simple and dependency-free (Node stdlib only).
  - Avoid introducing shell-dependent behaviour into developer-critical workflows (especially `build`, which Lefthook also runs).
  - Make failures actionable (clear error messages when prerequisites are missing).

## 3. Goals & Non-Goals
- **Goals**:
  1. Make `pnpm run build` work out-of-the-box on Linux and on Windows PowerShell without WSL/Git Bash.
  2. Keep the current argument contract: `pnpm <cmd> [pnpm args] -- [script args]` where pnpm args (like `--filter`) are forwarded to the underlying `pnpm -r ...`.
  3. Prevent CRLF regressions for executable scripts (via `.gitattributes` and/or other repo guardrails).
  4. Add CI coverage to verify `pnpm run build` on both `ubuntu-latest` and `windows-latest`.
- **Non-Goals**:
  - Redesigning per-package `build` scripts (this change is about the root “workspace runner” entry points).
  - Making every CI step cross-platform (e.g. bash-heavy `set -o pipefail` blocks) in the first iteration.
  - Supporting Node < 20 (the repo already requires Node ≥ 20.10).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Contributors developing on Windows (PowerShell/cmd)
  - CI maintainers (GitHub Actions workflow owners)
  - Repo tooling maintainers (Lefthook + workspace scripts)
- **Agent Roles**:
  - **Tooling Agent**: Replace bash workspace runner scripts with Node equivalents and update `package.json`.
  - **CI Agent**: Add `windows-latest` coverage that runs `pnpm run build` (and optionally other smoke commands).
  - **Docs Agent**: Update contributor docs/README notes if any workflow changes or prerequisites need clarifying.
  - **Guardrails Agent**: Add `.gitattributes` (and optional checks) to prevent CRLF regressions for executable scripts.
- **Affected Packages/Services**:
  - Root `package.json` scripts
  - `tools/scripts/*` workspace runner entrypoints
  - `.github/workflows/ci.yml` (add Windows build verification)
  - `lefthook.yml` (indirectly impacted because it calls `pnpm build`)
- **Compatibility Considerations**:
  - Intended to be backwards-compatible from a user perspective (`pnpm build` still exists and still accepts `--filter` and `--` forwarding).
  - Script entrypoints change from `.sh` to Node, so any tooling that directly invoked `tools/scripts/run-workspace-*.sh` may need to migrate (see Rollout Plan).

## 5. Current State
- Root scripts in `package.json` reference bash entrypoints:
  - `build`: `./tools/scripts/run-workspace-build.sh`
  - `lint`: `./tools/scripts/run-workspace-lint.sh`
  - `test`: `./tools/scripts/run-workspace-test.sh`
  - `test:ci`: `./tools/scripts/run-workspace-test-ci.sh`
  - `benchmark`: `./tools/scripts/run-workspace-benchmark.sh`
  - `coverage:md`: `./tools/scripts/run-workspace-coverage.sh && pnpm tsx tools/coverage-report/index.ts`
- The `.sh` scripts implement:
  - arg splitting at `--` so `pnpm`-level args (`--filter`, `--workspace-concurrency`, etc.) are forwarded to a recursive pnpm command, and trailing args are forwarded to the underlying script (e.g. package `build` script).
  - additional behaviour for some commands (e.g. `test:ci` sets `--workspace-concurrency` from `TEST_CI_WORKSPACE_CONCURRENCY`; coverage runs `normalize-lcov-paths.mjs` afterwards).
- The repo currently has no `.gitattributes`, so Windows checkouts may produce CRLF line endings for `.sh` files, leading to WSL shebang failures.
- CI currently runs only on `ubuntu-latest` for the main “Quality Gate” job. It runs `pnpm lint` (root script) but does not validate root `pnpm build` on Windows.

## 6. Proposed Solution
### 6.1 Architecture Overview
- Introduce a cross-platform Node-based “workspace runner” implementation that:
  - preserves the existing `pnpm <cmd> [pnpm args] -- [script args]` UX, and
  - invokes `pnpm -r ... run <script>` with correct flag placement, using `child_process.spawn` with argument arrays (no shell).
- Update root scripts to call Node runner entrypoints instead of `.sh`.
- Add `.gitattributes` rules to enforce LF line endings for executable scripts to prevent shebang breakage on WSL and other Unix environments.
- Add a CI job matrix for `ubuntu-latest` + `windows-latest` that runs `pnpm install` and `pnpm run build`.

### 6.2 Detailed Design
- **Workspace runner implementation**
  - Add `tools/scripts/run-workspace-script.mjs` (name TBD) with a simple CLI contract:
    - `node tools/scripts/run-workspace-script.mjs <scriptName> [pnpm args] -- [script args]`
  - Parsing rules:
    - Split `process.argv` at the first `--`.
    - Everything before `--` (after `<scriptName>`) becomes `pnpmArgs`.
    - Everything after becomes `scriptArgs` forwarded to `pnpm ... run <scriptName> -- ...`.
  - Execution rules:
    - Default: `pnpm -r <pnpmArgs> run --if-present <scriptName> [-- <scriptArgs>]`.
    - `test:ci`: `pnpm -r <pnpmArgs> run --no-sort --workspace-concurrency <n> test:ci [-- <scriptArgs>]` where `<n>` defaults to `process.env.TEST_CI_WORKSPACE_CONCURRENCY ?? 4`.
    - `coverage`: same as default but followed by `node tools/scripts/normalize-lcov-paths.mjs --quiet` (or integrate this as a “post step” option in the runner).
    - `benchmark`: preserve existing wrapper help output when `-h/--help` is provided (to document `--` forwarding).
  - Error handling:
    - If `pnpm` cannot be spawned (ENOENT), print a friendly message pointing to repo prerequisites (Node + pnpm/corepack) and exit non-zero.
    - Preserve pnpm exit codes for CI friendliness.
- **Package.json updates**
  - Replace root `.sh` invocations with Node runner invocations, for at least:
    - `build`, `lint`, `test`, `test:ci`, `benchmark`, `coverage:md`.
  - Keep `lint:fast` and `test:fast` as-is (already Node-based).
- **Shell scripts disposition**
  - Option A (preferred): remove `tools/scripts/run-workspace-*.sh` after migrating `package.json` to Node-based entrypoints.
  - Option B: keep `.sh` scripts as thin wrappers for POSIX users (they call `node ...`), but do not reference them from `package.json` so Windows users never need bash.
- **CRLF guardrails**
  - Add a root `.gitattributes` with at least:
    - `tools/scripts/*.sh text eol=lf` (if any `.sh` remain),
    - plus LF enforcement for any other shebang-driven executables that may be run directly (e.g. `tools/scripts/*.mjs`, `tools/**/src/*.ts` that start with `#!`).
  - (Optional) Add a lightweight CI check that fails if tracked script files contain CRLF (TBD; `.gitattributes` is the primary defence).
- **CI changes**
  - Add a new job (or a matrix job) that runs on:
    - `ubuntu-latest`
    - `windows-latest`
  - Steps:
    - Checkout
    - Setup pnpm + Node (same versions as existing workflow)
    - `pnpm install --frozen-lockfile`
    - `pnpm run build` (or `pnpm run build --filter "!@idle-engine/docs"` if CI time becomes a concern, but the goal is for the default to work everywhere).

### 6.3 Operational Considerations
- **Deployment**:
  - No production deployment; this is developer/CI tooling. Roll out via normal PR merge.
- **Telemetry & Observability**:
  - Not applicable (no runtime changes). Optional: print a single-line prefix when the runner starts for easier debugging, but avoid noisy output in CI.
- **Security & Compliance**:
  - Use `spawn(command, args, { stdio: 'inherit' })` and avoid `shell: true` to prevent argument injection and quoting hazards.
  - Treat forwarded args as opaque; do not attempt to interpret or eval them beyond `--` splitting.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(tools): add cross-platform workspace runner` | Implement Node-based workspace runner and per-command wiring (build/lint/test/test:ci/benchmark/coverage) | Tooling Agent | Design doc approved | `pnpm build` works on Windows PowerShell; argument forwarding parity maintained |
| `chore(repo): add gitattributes for executable scripts` | Prevent CRLF regressions for scripts likely to be executed via shebang | Guardrails Agent | Runner merged (if `.sh` removed, rules updated accordingly) | New checkouts keep LF endings; `bash\r` regression prevented |
| `ci: validate pnpm build on windows-latest` | Add CI job that runs `pnpm run build` on Ubuntu + Windows | CI Agent | Runner merged | CI passes on both OS targets and fails if build breaks |
| `docs: document Windows prerequisites (if needed)` | Update README/contributor docs if any requirements remain | Docs Agent | Runner merged | Clear guidance for Windows users; no WSL requirement for build |

### 7.2 Milestones
- **Phase 1**: Add Node runner + update `package.json` so `pnpm run build` works on Windows PowerShell.
- **Phase 2**: Add `.gitattributes` guardrails and CI Windows build job.
- **Phase 3 (optional)**: Expand Windows CI smoke coverage for `pnpm lint` / `pnpm test` once confidence is high.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Issue 844: https://github.com/hansjm10/Idle-Game-Engine/issues/844
  - Existing scripts:
    - `tools/scripts/run-workspace-build.sh`
    - `tools/scripts/run-workspace-lint.sh`
    - `tools/scripts/run-workspace-test.sh`
    - `tools/scripts/run-workspace-test-ci.sh`
    - `tools/scripts/run-workspace-benchmark.sh`
    - `tools/scripts/run-workspace-coverage.sh`
  - Call sites:
    - root `package.json`
    - `.github/workflows/ci.yml`
    - `lefthook.yml`
- **Communication Cadence**:
  - One PR is ideal; if CI + tooling changes get large, split into (1) runner + scripts, (2) CI + `.gitattributes`.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Read `package.json`, existing `tools/scripts/run-workspace-*.sh`, and `.github/workflows/ci.yml` before implementing.
  - Validate Windows behaviour using PowerShell on CI runners (local Windows validation optional).
- **Prompting & Constraints**:
  - Prefer Node stdlib and small, readable scripts; avoid introducing new dependencies just for argument parsing.
  - Preserve `--` forwarding semantics and help behaviour for `pnpm benchmark --help`.
- **Safety Rails**:
  - Do not use `shell: true` for subprocesses; avoid manual quoting.
  - Keep logs minimal; avoid output that could interfere with downstream JSON-tail parsing conventions (especially for `generate`/Vitest logs).
- **Validation Hooks**:
  - `pnpm run build`
  - `pnpm run build --filter @idle-engine/core`
  - `pnpm benchmark --help`
  - `pnpm test:ci` (optional, once runners are migrated)

## 9. Alternatives Considered
1. **Document Git Bash/WSL as a requirement**:
   - Pros: minimal code changes.
   - Cons: does not meet “works out-of-the-box on Windows PowerShell” goal; increases contributor friction.
2. **Add Windows `.cmd`/PowerShell wrappers parallel to `.sh`**:
   - Pros: avoids Node scripting.
   - Cons: duplicates logic across platforms; harder to keep parity; still needs CRLF guardrails.
3. **Remove root scripts and require contributors to use raw pnpm recursive commands**:
   - Pros: no wrappers needed.
   - Cons: worsens ergonomics; breaks documented patterns like `pnpm benchmark --filter ... -- ...`.
4. **Use `cross-env-shell` / shell abstraction libraries**:
   - Pros: familiar to some JS tooling.
   - Cons: still depends on shell semantics; not as robust as argument-array spawning.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Rely primarily on CI to validate end-to-end behaviour (`pnpm run build` on Windows + Ubuntu).
  - Optional: add a small Node-level unit test for argument splitting (`--` placement) if the repo has a suitable test harness for tooling scripts.
- **Performance**:
  - Runner overhead should be negligible (one extra Node process). No benchmarks required.
- **Tooling / A11y**:
  - Not applicable.

## 11. Risks & Mitigations
1. **Argument forwarding parity regressions** (filters or `--` forwarding behave differently):
   - Mitigation: mirror current `.sh` semantics; add CI usage that exercises `--filter` and `--` forwarding; keep runner small and covered by smoke checks.
2. **Windows PATH resolution issues for `pnpm`**:
   - Mitigation: use `spawn('pnpm', ...)` and provide a clear error when `pnpm` is missing; CI uses `pnpm/action-setup` to guarantee availability.
3. **CRLF regressions beyond `.sh` scripts** (other shebang executables):
   - Mitigation: enforce LF via `.gitattributes` for all directly-executable scripts with shebangs (scope TBD).
4. **CI job duration increases on Windows**:
   - Mitigation: start with build-only; optionally exclude docs via filter if needed; expand scope incrementally.

## 12. Rollout Plan
- **Milestones**:
  1. Land Node runner + switch root scripts from `.sh` to `node tools/scripts/...`.
  2. Add `.gitattributes` enforcing LF for relevant executables.
  3. Add CI build verification on Windows + Ubuntu.
- **Migration Strategy**:
  - Developers keep using `pnpm build` / `pnpm lint` / `pnpm test` as before.
  - If any automation calls `tools/scripts/run-workspace-*.sh` directly, migrate it to the new Node entrypoints (or keep `.sh` as a compatibility wrapper during a transition window).
- **Communication**:
  - Update issue/PR description with Windows confirmation steps and any remaining prerequisites (ideally: “no bash required for build”).

## 13. Open Questions
1. Should we delete `tools/scripts/run-workspace-*.sh` entirely, or keep them as POSIX wrappers for a deprecation period?
2. How broad should `.gitattributes` LF enforcement be (only `tools/scripts/*`, or all files with shebangs across `tools/` and `packages/`)?
3. Should Windows CI validate only `pnpm run build`, or also smoke `pnpm lint`/`pnpm test` once runners are migrated?
4. Do we want to add an explicit “preflight” check in the runner (e.g. detect `process.platform === 'win32'` and confirm `pnpm` is present) with a more structured error message, or is ENOENT handling sufficient?

## 14. Follow-Up Work
- Extend the Windows CI job to run `pnpm lint` and `pnpm test:ci` (once build is stable).
- Consider adding a lightweight “line endings check” CI step to fail fast when CRLF appears in shebang executables (if `.gitattributes` alone proves insufficient).
- Add a short “Windows setup” section to `docs/contributor-handbook.md` if new contributors continue to hit environment issues.

## 15. References
- Issue 844: https://github.com/hansjm10/Idle-Game-Engine/issues/844
- Root scripts: `package.json`
- Bash workspace runners: `tools/scripts/run-workspace-*.sh`
- CI workflow: `.github/workflows/ci.yml`
- Lefthook hooks: `lefthook.yml`

## Appendix A — Glossary
- **CRLF / LF**: Windows (`\r\n`) vs Unix (`\n`) line endings; CRLF in shebang lines can break Unix execution (`bash\r`).
- **Shebang**: First line of an executable script (e.g. `#!/usr/bin/env bash`) used by Unix-like OSes to select an interpreter.
- **WSL**: Windows Subsystem for Linux.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-25 | Ralph  | Initial draft |
