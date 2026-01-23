---
title: "core/content-schema: CI schema compatibility checks for runtime releases (Issue 157)"
sidebar_position: 99
---

# core/content-schema: CI schema compatibility checks for runtime releases (Issue 157)

## Document Control
- **Title**: CI schema compatibility checks for runtime releases
- **Authors**: Codex (AI)
- **Reviewers**: TBD
- **Status**: Draft
- **Last Updated**: 2026-01-23
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/157
- **Execution Mode**: AI-led

## 1. Summary
This design adds a fast, release-gating schema compatibility check for `@idle-engine/core` to prevent the runtime from being released in a state that is incompatible with the content schema feature-gating model. We introduce a focused `pnpm --filter @idle-engine/core test:schema-compat` script, wire it into CI, add a publish hook for core, and document the required workflow for evolving `FEATURE_GATES` alongside runtime version bumps.

## 2. Context & Problem Statement
- **Background**: Content packs are validated by `@idle-engine/content-schema`, which uses `FEATURE_GATES` to enforce minimum runtime versions per gated module (`packages/content-schema/src/runtime-compat.ts:3`). `resolveFeatureViolations` is applied during validation when `ContentSchemaOptions.runtimeVersion` is provided (`packages/content-schema/src/pack/index.ts:162`). The content validation CLI passes `runtimeVersion: RUNTIME_VERSION` when validating packs (`tools/content-schema-cli/src/generate.ts:1036`).
- **Problem**: We do not currently enforce that the runtime version being released (`@idle-engine/core` version / `RUNTIME_VERSION`) is compatible with all declared feature gates. CI can remain green if no active pack exercises a newly gated module. Before this change, `@idle-engine/core` was `0.4.0` while `FEATURE_GATES` included `entities` introduced in `0.5.0`, illustrating a drift scenario that was not caught by current workflows.
- **Forces**:
  - Keep checks deterministic and fast (suitable for CI and publish hooks).
  - Avoid test console output that could interfere with `vitest-llm-reporter`.
  - Provide a clear, documented process for updating `FEATURE_GATES` and runtime versions together.

## 3. Goals & Non-Goals
- **Goals**:
  - Add a dedicated `@idle-engine/core` script: `test:schema-compat` (invoked as `pnpm --filter @idle-engine/core test:schema-compat`).
  - Fail the check if `RUNTIME_VERSION` is lower than any `FEATURE_GATES[].introducedIn` value.
  - Validate that a synthetic “compat pack” enabling every gated module validates successfully when `runtimeVersion` is `RUNTIME_VERSION`.
  - Gate core publishing via `prepublishOnly` (or equivalent) so incompatible releases cannot be pushed accidentally.
  - Document a schema evolution policy for when and how to bump `FEATURE_GATES` and runtime versions.
- **Non-Goals**:
  - Changing the semantics of feature gates (min-version checks) or pack validation.
  - Reworking the overall release tooling for the monorepo (changesets, publish pipelines, etc.).
  - Proving full behavioral correctness of every runtime feature (this is a compatibility contract check, not a full simulation test suite).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Runtime maintainers (`packages/core`)
  - Content-schema maintainers (`packages/content-schema`)
  - Content pipeline maintainers (`tools/content-schema-cli`, `packages/content-compiler`)
- **Agent Roles**:
  - **Core Test Agent**: Add `test:schema-compat` and the focused Vitest suite.
  - **CI Agent**: Wire the new check into `.github/workflows/ci.yml` (and any release workflows).
  - **Docs Agent**: Document the schema evolution policy and maintenance checklist.
- **Affected Packages/Services**:
  - `packages/core/package.json` (new scripts, publish hooks)
  - `packages/core/src/**` (schema-compat tests)
  - `.github/workflows/ci.yml` (new CI step)
  - `docs/content-dsl-usage-guidelines.md` (policy/docs updates)
- **Compatibility Considerations**:
  - No runtime API changes; only test/CI/publish guardrails.
  - The new check may require a version bump or gate adjustment to restore consistency (see Open Questions).

## 5. Current State
- `FEATURE_GATES` is the canonical map of “schema module → minimum runtime version” (`packages/content-schema/src/runtime-compat.ts:3-29`).
- Feature gate enforcement happens only when a pack uses a gated module and the caller provides `ContentSchemaOptions.runtimeVersion` (`packages/content-schema/src/pack/index.ts:162-188`).
- The content validation pipeline runs with the current runtime version (CLI passes `runtimeVersion: RUNTIME_VERSION`) (`tools/content-schema-cli/src/generate.ts:1036-1042`), but this only catches drift if some validated pack exercises the newly gated module.
- CI currently validates that `RUNTIME_VERSION` matches `packages/core/package.json` (`tools/scripts/validate-runtime-version.mjs`), but not that it satisfies `FEATURE_GATES`.

## 6. Proposed Solution
### 6.1 Architecture Overview
- Add a small, isolated Vitest suite in `@idle-engine/core` that imports the schema package’s compatibility primitives (`FEATURE_GATES`, `resolveFeatureViolations`, `createContentPackValidator`).
- Run the suite via a dedicated package script (`test:schema-compat`) so CI and publish hooks can invoke it without executing the full core test suite.
- Update CI to run `pnpm --filter @idle-engine/core test:schema-compat` as a first-class quality gate.
- Guard core publishing via a `prepublishOnly` (or `prepack`) hook that runs the same script.

### 6.2 Detailed Design
- **Core script**
  - Add to `packages/core/package.json`:
    - `test:schema-compat`: runs only the schema compatibility tests (for example, `vitest run src/__tests__/schema-compat.test.ts`).
    - `prepublishOnly` (or `prepack`): runs `pnpm run test:schema-compat` to block publishing on failure.
- **Schema compat tests (core)**
  - Add `packages/core/src/__tests__/schema-compat.test.ts` with two primary test cases:
    1. **Runtime version ≥ all feature gates**
      - Build a `FeatureGateMap` where every module in `FEATURE_GATES` is treated as “in use”.
      - Assert `resolveFeatureViolations(RUNTIME_VERSION, allEnabledMap)` returns `[]`.
      - This directly enforces that `FEATURE_GATES[].introducedIn` never points to a future runtime release.
    2. **Schema validates a compat pack under current runtime**
      - Construct a minimal pack object that includes at least one entry in each gated module array:
        - `automations`, `entities`, `transforms`, `runtimeEvents`, `prestigeLayers`
      - Ensure all cross references are self-contained (resources referenced by generators/transforms exist; prestige layers include the required `${layerId}-prestige-count` resource).
      - Run `createContentPackValidator({ runtimeVersion: RUNTIME_VERSION })` and assert:
        - Validation succeeds
        - `warnings.length === 0` (or a tightly-scoped allowlist if unavoidable)
  - Optional (recommended) follow-up: instantiate a core runtime with the normalized pack and run a single tick as a smoke test to confirm core can consume the “all modules enabled” shape without throwing.
- **CI integration**
  - Update `.github/workflows/ci.yml` `quality-gate` job to add:
    - `pnpm --filter @idle-engine/core test:schema-compat`
  - Place it after dependency install and before broader `pnpm test:ci` to fail fast.
- **Documentation**
  - Update `docs/content-dsl-usage-guidelines.md` under “Compatibility Triage” with an explicit “Schema evolution policy” subsection:
    - When adding a new gated module (or expanding an existing one), update `FEATURE_GATES` and bump `@idle-engine/core` version in the same PR.
    - Require `pnpm --filter @idle-engine/core test:schema-compat` to pass before merging.
    - Require updating the compatibility table (and rely on existing docs-sync tests).

### 6.3 Operational Considerations
- **Deployment**: CI step addition is straightforward; the only operational change is an additional failing gate for incompatible version/gate updates.
- **Telemetry & Observability**: N/A (test-only).
- **Security & Compliance**: N/A.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
This table decomposes Issue 157 into implementation slices that can be executed and reviewed independently.

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(core): add schema compat tests | Add `test:schema-compat` + Vitest suite validating `FEATURE_GATES` vs `RUNTIME_VERSION` and validating a compat pack | Core Test Agent | None | `pnpm --filter @idle-engine/core test:schema-compat` fails on drift |
| chore(ci): run core schema compat | Add CI step to run `test:schema-compat` | CI Agent | schema compat tests merged | CI fails fast on drift |
| chore(core): guard publish with schema compat | Add `prepublishOnly`/`prepack` to core package | Core Test Agent | schema compat tests merged | Release/publish blocked when compat fails |
| docs: document schema evolution policy | Add workflow notes to `docs/content-dsl-usage-guidelines.md` | Docs Agent | None | Policy exists; references correct source files |

### 7.2 Milestones
- **Phase 1**: Implement core schema-compat tests + script.
- **Phase 2**: Wire CI + publish hooks.
- **Phase 3**: Document schema evolution policy and maintenance checklist.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - `packages/content-schema/src/runtime-compat.ts`
  - `packages/content-schema/src/pack/index.ts` (feature gate validation)
  - `tools/content-schema-cli/src/generate.ts` (runtimeVersion wiring)
  - `.github/workflows/ci.yml`
- **Communication Cadence**: One review checkpoint after Phase 1 (tests + script), then a second after CI/publish hooks are in place.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - `packages/content-schema/src/runtime-compat.ts`
  - `packages/content-schema/src/pack/index.ts`
  - `packages/core/src/version.ts`
  - `tools/content-schema-cli/src/generate.ts`
- **Prompting & Constraints**:
  - Keep tests deterministic and avoid console output that could interfere with `vitest-llm-reporter`.
  - Use type-only imports (`import type`) where applicable.
- **Safety Rails**:
  - Do not edit checked-in `dist/**` outputs by hand.
  - Do not weaken existing feature gate semantics (warnings vs errors) without explicit approval.
- **Validation Hooks**:
  - `pnpm --filter @idle-engine/core test:schema-compat`
  - `pnpm test:ci`
  - `pnpm lint`

## 9. Alternatives Considered
- **Rely on `pnpm generate --check`**: Insufficient because it only validates packs present in the repo; drift can hide until a pack exercises the gated module.
- **Put all checks in `@idle-engine/content-schema`**: Helps detect drift, but does not provide a core-local publish gate and complicates workflows that operate on the core package alone.
- **Allow “future” feature gates**: Could support roadmap planning, but undermines the goal of preventing runtime/schema drift for released artifacts. If needed, a separate “planned gates” list should be introduced explicitly.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Add focused Vitest tests in core (schema-compat suite only).
  - Ensure the compat pack validates with `runtimeVersion: RUNTIME_VERSION` and produces zero warnings.
- **Performance**:
  - Keep `test:schema-compat` under ~1s locally/CI by avoiding full runtime simulations.
- **Tooling / A11y**: N/A.

## 11. Risks & Mitigations
- **Risk**: The new gate forces version bumps whenever `FEATURE_GATES` changes.\
  **Mitigation**: Treat `FEATURE_GATES` as “shipped runtime features only”; do not add entries for future/planned versions.
- **Risk**: The compat pack becomes brittle as schema requirements evolve.\
  **Mitigation**: Build it using `@idle-engine/content-schema` factories where possible and keep it minimal; update alongside schema changes in the same PR.
- **Risk**: Duplicate checks between CI steps and publish hooks.\
  **Mitigation**: Keep the suite tiny; redundancy is intentional for defense-in-depth.

## 12. Rollout Plan
- **Milestones**:
  - Merge Phase 1: schema-compat tests and script in core.
  - Merge Phase 2: CI step + publish hook.
  - Merge Phase 3: docs update.
- **Migration Strategy**: None (guardrail addition only).
- **Communication**: Note in PR description that core releases are now blocked unless schema compatibility checks pass.

## 13. Open Questions
- Should `FEATURE_GATES` ever contain entries for unreleased/future runtime versions (roadmap), or must it always be ≤ `RUNTIME_VERSION`?
- For the current drift (`RUNTIME_VERSION = 0.4.0` vs `entities introducedIn = 0.5.0`), should we bump core to `0.5.0` or adjust the gate version? **Resolved in this implementation**: bump core to `0.5.0`.
- Should the schema-compat suite include a minimal runtime “tick once” smoke test, or keep validation-only to minimize runtime coupling?

## 14. Follow-Up Work
- Consider adding a small “contract smoke pack” that is also consumed by a runtime wiring test to catch schema/runtime mismatches beyond version gating.
- If release tooling changes (changesets, publishing public packages), ensure the new `prepublishOnly` hook is still invoked in the release pipeline.

## 15. References
- Issue 157: https://github.com/hansjm10/Idle-Game-Engine/issues/157
- `FEATURE_GATES`: `packages/content-schema/src/runtime-compat.ts:3`
- Feature gate validation: `packages/content-schema/src/pack/index.ts:162`
- CLI uses runtime version during validation: `tools/content-schema-cli/src/generate.ts:1036`
- Current runtime version constant: `packages/core/src/version.ts:26`
- CI workflow: `.github/workflows/ci.yml`
- Decision log risk entry: `docs/content-schema-rollout-decisions.md` (“Schema Drift vs Runtime”)
- Schema design risk table: `docs/content-dsl-schema-design.md` (“Schema drift vs runtime”)

## Appendix A — Glossary
- **Feature gate**: A mapping from a schema module to the minimum runtime version that can safely execute it.
- **`runtimeVersion`**: `ContentSchemaOptions.runtimeVersion`; the runtime version used to enforce feature-gate compatibility during content validation.
- **Schema drift**: When schema expectations (including feature gates) move ahead of the runtime being released.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-23 | Codex (AI) | Initial draft design doc for Issue 157 |
