---
title: "shell-desktop: add supported runtime harness API (Issue 848)"
sidebar_position: 99
---

# shell-desktop: add supported runtime harness API (Issue 848)

## Document Control
- **Title**: Add a supported public runtime harness surface for shells/test runners
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-26
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/848 (triggered by test-game shell work in #841)
- **Execution Mode**: AI-led

## 1. Summary
`@idle-engine/shell-desktop` and other host/test harnesses sometimes need lower-level runtime wiring primitives (coordinator construction, deterministic snapshot building, and save parsing/hydration) that are currently only directly importable via `@idle-engine/core/internals`. This defeats the repository’s `restrictCoreInternals` guardrails and makes shells brittle to internal refactors. This design introduces a supported, explicit “harness” entry point (`@idle-engine/core/harness`) that re-exports a small set of integration helpers (save format loader + snapshot builder, plus types), enabling shells to stop depending on `core/internals` while keeping the stable `@idle-engine/core` surface intentionally small.

## 2. Context & Problem Statement
- **Background**:
  - The engine exposes a stable entry point (`@idle-engine/core`) and an unstable internal entry point (`@idle-engine/core/internals`). `@idle-engine/config-eslint` can enforce this split via `restrictCoreInternals`.
  - The high-level `createGame(...)` façade already uses internal helpers like `loadGameStateSaveFormat(...)` and `buildProgressionSnapshot(...)` (see `packages/core/src/game.ts`), but those helpers are not themselves part of the stable exports.
- **Problem**:
  - Shells and test harnesses that need:
    - deterministic snapshot building (i.e., caller-supplied timestamps, not `Date.now()`),
    - validation + migration for unknown save payloads (JSON loaded from disk/IndexedDB),
    - or custom wiring around `createGameRuntime` / `wireGameRuntime`
    must currently import helpers from `@idle-engine/core/internals` (or duplicate logic).
  - This defeats `no-restricted-imports` for app-facing packages and couples shells to internal module organization.
- **Forces**:
  - Keep the stable public API (`@idle-engine/core`) intentionally small (per `packages/core/README.md`).
  - Provide a supported path for hosts/shells without forcing them to opt into “internals” (no stability guarantees).
  - Preserve deterministic simulation expectations (especially for CI + test harnesses).

## 3. Goals & Non-Goals
- **Goals**:
  - Provide a supported public entry point for host/shell/test-harness integrations that need save parsing + deterministic snapshot helpers.
  - Enable `@idle-engine/shell-desktop` to avoid `@idle-engine/core/internals` and remove any eslint escape hatches.
  - Keep determinism-first workflows ergonomic (callers can supply timestamps derived from step/stepSizeMs).
  - Keep the stable `@idle-engine/core` entry point small by making the harness surface explicit.
- **Non-Goals**:
  - Replacing `createGame(...)` or redesigning the runtime wiring model.
  - Changing the save schema or migration system.
  - Extracting a new package unless the subpath export approach proves insufficient.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Runtime/core maintainers (`packages/core`)
  - Shell maintainers (`packages/shell-desktop`, future shells)
  - Tooling maintainers (`tools/*` consumers that may also benefit from a supported harness surface)
- **Agent Roles**:
  - **Docs Agent**: Maintain this design doc and keep references current.
  - **Core API Agent**: Implement `@idle-engine/core/harness` and ensure exports/types are correct for both browser + Node resolution.
  - **Shell Migration Agent**: Update `@idle-engine/shell-desktop` to use the supported harness API and remove eslint disables.
  - **Test Agent**: Add focused unit tests that prevent the harness entry point from regressing.
- **Affected Packages/Services**:
  - `packages/core` (new subpath export + source entrypoint)
  - `packages/shell-desktop` (import migration; remove eslint escape hatch)
  - (Optional) `tools/runtime-sim`, `tools/economy-verification` (follow-up migration away from `core/internals`)
- **Compatibility Considerations**:
  - Additive change: new subpath export only; no breaking changes to existing entry points.
  - Keep `@idle-engine/core/internals` semantics unchanged for engine contributors.

## 5. Current State
- `@idle-engine/core` exports runtime wiring (`IdleEngineRuntime`, `createGameRuntime`, `wireGameRuntime`) and the high-level `createGame(...)` façade (`packages/core/src/index.browser.ts`).
- `createGame(...)` implements:
  - `hydrate(save: unknown)` by calling `loadGameStateSaveFormat(save)` (save validation + migration).
  - `getSnapshot()` by calling `buildProgressionSnapshot(step, Date.now(), coordinator.state)` (non-deterministic timestamp).
  These helpers live in `packages/core/src/game-state-save.ts` and `packages/core/src/progression.ts` but are not exposed on the stable entry point.
- Consumers that need the same primitives (especially deterministic snapshot timestamps, or save parsing when using `createGameRuntime` directly) have no supported import path besides `@idle-engine/core/internals`.

## 6. Proposed Solution
### 6.1 Architecture Overview
- Add a new, browser-safe harness entry point: `@idle-engine/core/harness`.
- Export a minimal set of integration helpers that shells/test harnesses need:
  - Save parsing/validation + migration: `loadGameStateSaveFormat` (and related types)
  - Deterministic snapshot building: `buildProgressionSnapshot` (and related types)
- Keep the stable entry point (`@idle-engine/core`) unchanged; harness is an opt-in “advanced integration” surface that remains supported and documented.

### 6.2 Detailed Design
- **Runtime Changes**:
  - Add new entrypoint modules under `packages/core/src/`:
    - `harness.browser.ts`: browser-safe exports
    - `harness.ts`: Node entrypoint that re-exports `harness.browser` (mirrors the existing `internals.ts` pattern)
  - Update `packages/core/package.json` `exports` map to include `./harness` (both `browser` and `default` conditions), emitting `dist/harness(.browser).js` and `.d.ts` via the existing `tsc` build.
- **Data & Schemas**:
  - No save schema changes. The harness entry point exposes the existing save loader API that already supports schema migrations.
- **APIs & Contracts**:
  - `@idle-engine/core/harness` exports:
    - `loadGameStateSaveFormat(value, options?)` for validating + migrating unknown save payloads into `GameStateSaveFormat`.
    - `buildProgressionSnapshot(step, nowMs, state)` for deterministic snapshot materialization.
    - The narrow set of types needed by these helpers (type exports only).
  - Shells can then:
    - parse a save from disk via `loadGameStateSaveFormat(JSON.parse(fileContents))`,
    - hydrate the wired runtime via `GameRuntimeWiring.hydrate(parsedSave, { currentStep: parsedSave.runtime.step })`,
    - and build snapshots using a deterministic clock (e.g., `nowMs = step * stepSizeMs`).
- **Tooling & Automation**:
  - No eslint rule changes required: `@idle-engine/config-eslint` only restricts `@idle-engine/core/internals`, so `@idle-engine/core/harness` is automatically permitted.
  - Add a small unit test in `packages/core` that imports from `@idle-engine/core/harness` and smoke-checks the main exports (prevents export-map drift).
  - Update documentation (`packages/core/README.md` and/or `docs/idle-engine-design.md`) to list and describe the harness entry point.

### 6.3 Operational Considerations
- **Deployment**: Additive API surface; consumers can migrate incrementally.
- **Telemetry & Observability**: N/A.
- **Security & Compliance**: No new data classes; harness exposes existing save validation and snapshot builders.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(core): add @idle-engine/core/harness entrypoint` | Add new `harness(.browser)` entrypoint(s) and export map wiring; re-export save loader + snapshot builder and required types. | Core API Agent | Doc approval | `@idle-engine/core/harness` is importable (Node + browser conditions); exports include `loadGameStateSaveFormat` and `buildProgressionSnapshot`; build passes without editing `dist/**` by hand. |
| `refactor(shell-desktop): migrate runtime harness imports` | Update shell/test harness code to use `@idle-engine/core/harness` (and/or stable `@idle-engine/core`) instead of `@idle-engine/core/internals`; remove eslint disables. | Shell Migration Agent | Core harness entrypoint | No `@idle-engine/core/internals` imports remain in `packages/shell-desktop`; any eslint escape hatches for `no-restricted-imports` are removed; `pnpm test --filter @idle-engine/shell-desktop` passes. |
| `test(core): add harness export smoke coverage` | Add a minimal Vitest suite that imports the harness entry point and verifies key exports exist and behave at a basic level. | Test Agent | Core harness entrypoint | New test fails if the harness export map breaks; test runs deterministically with no console noise. |
| `docs(core): document harness entrypoint` | Document the new supported harness surface and when to use it vs `@idle-engine/core` vs `@idle-engine/core/internals`. | Docs Agent | Core harness entrypoint | `packages/core/README.md` lists `@idle-engine/core/harness` and describes intended usage; design doc references stay current. |

### 7.2 Milestones
- **Phase 1**: Implement `@idle-engine/core/harness`, migrate `shell-desktop`, add tests, and document the new entry point (single PR is preferred).
- **Phase 2** (optional): Migrate tooling that currently imports from `@idle-engine/core/internals` to `@idle-engine/core/harness` where appropriate; leave true contributor-only tooling on `internals`.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Issue 848 body for context and acceptance criteria.
  - Existing internal helpers:
    - Save loader: `packages/core/src/game-state-save.ts` (`loadGameStateSaveFormat`)
    - Snapshot builder: `packages/core/src/progression.ts` (`buildProgressionSnapshot`)
  - Existing façade that already uses these helpers: `packages/core/src/game.ts`
  - Consumer package: `packages/shell-desktop`
- **Communication Cadence**: One reviewer pass after the harness API is proposed; confirm naming + export set before finishing the migration.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Review `packages/core/README.md` and `docs/idle-engine-design.md` entry point conventions (`core` vs `core/internals`).
  - Inspect `packages/core/src/game.ts` to understand current save/snapshot behavior and determinism implications.
- **Prompting & Constraints**:
  - Do not edit checked-in `dist/**` outputs by hand.
  - Keep exports minimal and “harness-focused” to avoid growing an accidental second stable API.
  - Use type-only exports (`export type { ... }`) for types; the repo enforces `consistent-type-imports/exports`.
  - Avoid console output in tests (Vitest LLM reporter expects clean output).
- **Safety Rails**:
  - Prefer additive exports over changing existing stable API behavior.
  - Avoid exporting broad internal modules (e.g., don’t re-export `internals` wholesale).
- **Validation Hooks**:
  - `pnpm lint`
  - `pnpm test --filter @idle-engine/core`
  - `pnpm test --filter @idle-engine/shell-desktop`

## 9. Alternatives Considered
- **Export the helpers directly from `@idle-engine/core`**:
  - Pros: simplest for consumers.
  - Cons: grows the stable entry point and blurs the public vs advanced boundary.
- **Create a new package (e.g., `@idle-engine/runtime-harness`)**:
  - Pros: clear dependency and stability boundary; avoids adding more subpath exports on core.
  - Cons: more monorepo overhead (new package, build outputs, versioning) for what is primarily a curated re-export surface.
- **Use `createGame(...)` everywhere**:
  - Pros: already stable; already performs save parsing and snapshot building.
  - Cons: `createGame.getSnapshot()` currently uses `Date.now()` and hides some knobs needed for deterministic shells/harnesses; also forces the higher-level command façade where lower-level wiring is desired.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Add a new `packages/core/src/harness.test.ts` (or colocated `*.test.ts`) that imports from `@idle-engine/core/harness` and asserts:
    - `loadGameStateSaveFormat` loads a minimal valid save (or throws on invalid shape).
    - `buildProgressionSnapshot` returns a snapshot with expected step/time fields for a small coordinator state fixture.
  - Run:
    - `pnpm test --filter @idle-engine/core`
    - `pnpm test --filter @idle-engine/shell-desktop`
- **Performance**: N/A (exports only).
- **Tooling / A11y**: N/A.

## 11. Risks & Mitigations
- **API creep**: Harness becomes a dumping ground of semi-public internals.
  - Mitigation: Keep the export list narrowly focused on shell/test harness needs; document intended usage.
- **Stability expectations**: Consumers might assume harness is as stable as the base entry point.
  - Mitigation: Document stability expectations explicitly in `packages/core/README.md` and JSDoc tags on `harness` entrypoint(s).
- **Export map drift**: Subpath exports can break with build output or tooling changes.
  - Mitigation: Add an explicit unit test importing `@idle-engine/core/harness` to catch broken exports in CI.

## 12. Rollout Plan
- **Milestones**:
  - Add `@idle-engine/core/harness` entrypoint and document it.
  - Migrate `@idle-engine/shell-desktop` away from `@idle-engine/core/internals`.
  - Optional: migrate additional shells/tools where appropriate.
- **Migration Strategy**:
  - No schema migrations required; existing save migration behavior is reused by exporting `loadGameStateSaveFormat`.
  - Keep `@idle-engine/core/internals` available for engine contributors and true internal tooling.
- **Communication**:
  - Update Issue 848 with the final chosen entrypoint name and a short example snippet for shells (import paths + deterministic timestamp pattern).

## 13. Open Questions
1. Entry point name: `@idle-engine/core/harness` vs `@idle-engine/core/testing` vs `@idle-engine/core/shell`?
2. Export set: should the harness also export `createProgressionCoordinator` (for custom wiring) or remain focused on save/snapshot helpers only?
3. Stability tag: should `harness` be documented as `stable` or `experimental-but-supported`?
4. Do we want to adjust `createGame.getSnapshot()` to allow injecting a deterministic clock (follow-up), or keep determinism as a harness-only concern?

## 14. Follow-Up Work
- Consider a small deterministic “clock policy” helper (e.g., `stepToSimTimeMs(step, stepSizeMs)`) if multiple shells duplicate it.
- Migrate selected tooling (`tools/runtime-sim`, `tools/economy-verification`) off `core/internals` if they only use the harness subset.
- If the harness surface grows substantially, revisit extracting it into a dedicated `@idle-engine/runtime-harness` package.

## 15. References
- Issue 848: https://github.com/hansjm10/Idle-Game-Engine/issues/848
- Entry point conventions: `packages/core/README.md`, `docs/idle-engine-design.md`
- Save parsing + migrations: `packages/core/src/game-state-save.ts` (`loadGameStateSaveFormat`)
- Snapshot building: `packages/core/src/progression.ts` (`buildProgressionSnapshot`)
- Existing façade usage: `packages/core/src/game.ts` (`hydrate`, `getSnapshot`)
- ESLint restriction: `packages/config-eslint/index.js` (`restrictCoreInternals`)

## Appendix A — Glossary
- **Harness**: A supported integration surface used by shells, simulations, and tests to wire runtimes, parse saves, and materialize snapshots without depending on unstable engine internals.
- **Shell**: A host application (desktop/web) embedding the engine runtime and renderer.
- **Deterministic time**: A clock model where “now” is derived from simulation step/stepSizeMs, not wall clock (`Date.now()`).

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-26 | Codex (AI) | Initial draft for Issue 848. |
