---
title: Runtime Transform System — Core Support for Content Transforms (issue-523)
sidebar_position: 4
---

## Document Control
- **Title**: Implement deterministic runtime support for content transforms (issue-523)
- **Authors**: Idle Engine Design-Authoring Agent (AI)
- **Reviewers**: Core Runtime Maintainers; Content Pipeline Maintainers; Shell-Web Maintainers
- **Status**: Draft
- **Last Updated**: 2025-12-22
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/523
- **Execution Mode**: AI-led

## 1. Summary
GitHub issue #523 (“feat(core): implement runtime support for transforms”) introduces deterministic runtime execution for content-authored `transforms`, eliminating shell-specific implementations. The proposal adds a `TransformSystem` to `packages/core` that maintains transform runtime state (unlock/visibility, cooldown, and outstanding batches), executes atomic resource conversions according to `mode` (`instant`, `batch`, and later `continuous`), supports `manual` transforms via a new runtime command, and supports at least one non-manual trigger path (`event` and/or `condition`) by subscribing to the runtime event bus and evaluating `ConditionContext`. The initiative includes save/load persistence and a snapshot view so shells can render transforms and drive manual execution, satisfying issue-523 acceptance criteria while preserving determinism, tick budget, and backward compatibility.

## 2. Context & Problem Statement
- **Background**:
  - Content schema already defines transforms (triggers, modes, formulas, safety guards) in `packages/content-schema/src/modules/transforms.ts:42` and validates references in `packages/content-schema/src/pack/validate-cross-references.ts` plus cycles in `packages/content-schema/src/pack/validate-cycles.ts`.
  - The runtime tick loop executes commands, dispatches events, then ticks systems deterministically (`packages/core/src/index.ts:309`), and already supports similar “definition + system + persistence + snapshot” patterns for automations (`packages/core/src/automation-system.ts:178`) and progression snapshots (`packages/core/src/progression.ts:232`).
  - Shell-web’s worker currently wires progression + automation only and emits `STATE_UPDATE` without any transform state (`packages/shell-web/src/runtime.worker.ts:194`, `packages/shell-web/src/runtime.worker.ts:317`).
- **Problem** (issue-523):
  - Core has no `TransformSystem`, no command type to manually run a transform (`packages/core/src/command.ts:107`), no persistence for transform state (`packages/core/src/resource-state.ts:124`), and no snapshot view for transforms (`packages/shell-web/src/runtime.worker.ts:317`).
  - As a result, content packs cannot use transforms deterministically without bespoke shell code, undermining the “core runtime owns simulation” constraint and blocking authored mechanics.
- **Forces**:
  - **Determinism**: Transform execution must be replayable and stable across ticks and environments (align with command queue ordering in `packages/core/src/index.ts:318`).
  - **Atomicity**: Multi-resource input spends must behave transactionally (all-or-nothing) using `ResourceState.spendAmount` semantics (`packages/core/src/resource-state.ts:729`).
  - **Safety**: Runtime must enforce `safety.maxRunsPerTick` and `safety.maxOutstandingBatches` from schema (`packages/content-schema/src/modules/transforms.ts:149`) to prevent runaway loops.
  - **Compatibility**: Save schema additions must be backwards compatible and support step rebasing during restore (`packages/shell-web/src/runtime.worker.ts:835`).
  - **Performance**: Trigger evaluation and formula evaluation must stay within the 100ms step budget for typical packs; avoid O(N*M) per tick when possible.

## 3. Goals & Non-Goals
- **Goals**:
  1. Deliver issue-523: add deterministic transform execution to `@idle-engine/core` with a dedicated `TransformSystem`.
  2. Support `instant` + `manual` transforms end-to-end via a new runtime command (spend inputs → produce outputs) and unit tests.
  3. Support at least one additional trigger path for issue-523 (`event` and/or `condition`) using the existing runtime event bus (`packages/core/src/events/runtime-event-catalog.ts:61`) and `ConditionContext` (`packages/core/src/condition-evaluator.ts:39`).
  4. Enforce `cooldown` and `safety.maxRunsPerTick` deterministically; for batch transforms, enforce `safety.maxOutstandingBatches`.
  5. Add save/load hooks for transform state and batch queues, including step rebasing on restore (patterned after `AutomationSystem.restoreState`).
  6. Provide a snapshot view of transforms suitable for shell rendering and manual command issuance, and wire it into the worker `STATE_UPDATE` envelope.
- **Non-Goals**:
  - Delivering a complete shell-web UI for transforms (panels, layouts, animations) beyond exposing snapshot data and command wiring.
  - Implementing runtime execution for `continuous` transforms beyond documenting semantics (requires follow-up work).
  - Introducing generalized transactional resource operations beyond the transform system’s atomic multi-spend logic.
  - Expanding content DSL/schema (issue-523 assumes schema is authoritative and stable).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Core Runtime Maintainers (deterministic runtime behavior, saves, commands)
  - Content Authors / Content Pipeline Maintainers (authoring transforms, validation, sample packs)
  - Shell-Web Maintainers (snapshot consumption, worker bridge contracts)
  - QA / Determinism Verification Owners (test stability, replay consistency)
- **Agent Roles** (AI-led execution for issue-523):
  - Runtime Implementation Agent: implement `TransformSystem`, command handlers, and core unit tests in `packages/core`.
  - Persistence Agent: extend save schema and restore logic (resource-state export + worker snapshot/restore integration).
  - Event/Condition Trigger Agent: implement event subscriptions and condition evaluation trigger path.
  - Snapshot/Contract Agent: define and wire transform snapshot view into worker messages and shell bridge typings.
  - Content Authoring Agent: add minimal sample transform content and ensure compiler outputs are regenerated.
  - Docs Agent: update authoring guidance to include runtime semantics and limitations for transforms.
  - CI/Validation Agent: run `pnpm lint`, `pnpm test`, and `pnpm coverage:md` when coverage-affecting changes land; keep Vitest JSON summary intact.
- **Affected Packages/Services**:
  - `packages/core` (new system, commands, persistence types, snapshot builder, tests)
  - `packages/shell-web` (worker state envelope, session snapshot/restore integration)
  - `packages/content-schema` (no schema changes expected; referenced for contracts)
  - `packages/content-sample` (optional: add authored transforms to validate end-to-end usage)
  - `docs/` (this design + authoring semantics updates)
- **Compatibility Considerations**:
  - Additive command types and additive snapshot fields are backward compatible when gated by consumer capability checks.
  - Save format is extended additively (new optional `transformState` field) to preserve compatibility with existing saves; restore must tolerate absence.

## 5. Current State
- Transform definitions exist, but are inert at runtime:
  - Schema: `packages/content-schema/src/modules/transforms.ts:97` defines `mode`, `trigger`, `duration`, `cooldown`, and `safety`.
  - Validation: pack cross-reference checks include transforms (`packages/content-schema/src/pack/validate-cross-references.ts`) and cycles (`packages/content-schema/src/pack/validate-cycles.ts`).
  - Compiler: transforms are carried through into the normalized pack (`packages/content-compiler/src/runtime.ts:57`).
- Runtime execution infrastructure exists but does not include transforms:
  - Commands: no transform-related command identifiers exist (`packages/core/src/command.ts:107`).
  - Systems: runtime ticks systems after dispatching command-produced events (`packages/core/src/index.ts:365`), suitable for event-driven triggers.
  - Conditions: shared `ConditionContext` exists for unlock/visibility and trigger evaluation (`packages/core/src/condition-evaluator.ts:39`), exposed by progression coordinator (`packages/core/src/progression-coordinator.ts:1226`).
  - Persistence: resource save payload currently optionally embeds `automationState` only (`packages/core/src/resource-state.ts:124`); shell worker persists automation state but nothing for transforms (`packages/shell-web/src/runtime.worker.ts:939`).
- Shell-web state channel does not surface transforms:
  - Worker emits `STATE_UPDATE` with progression snapshot only (`packages/shell-web/src/runtime.worker.ts:317`), preventing shells from rendering transforms or issuing deterministic transform commands.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**:
  - Implement issue-523 by adding a deterministic `TransformSystem` to `packages/core` that owns transform runtime execution and state.
  - Add a new runtime command (provisionally `RUN_TRANSFORM`) for manual invocation. Command handlers call into `TransformSystem` so command ordering remains authoritative relative to other commands in the same tick (`packages/core/src/index.ts:318`).
  - Support at least one non-manual trigger path for issue-523:
    - **Event triggers**: `TransformSystem.setup()` subscribes to relevant runtime events and records pending triggers, then executes transforms in `tick()`.
    - **Condition triggers**: `TransformSystem.tick()` evaluates transform conditions via `evaluateCondition` against the shared `ConditionContext`.
  - `TransformSystem` enforces safety guards deterministically per tick and persists its state (including batch queues) via additive save fields.
- **Diagram**:
  - TODO (Docs Agent): add a small diagram (Mermaid or SVG) showing command → dispatcher → transform system → resource state and event bus trigger flow.

### 6.2 Detailed Design
- **Runtime Changes**:
  - Add `packages/core/src/transform-system.ts` exporting:
    - `createTransformSystem(options)` returning a `System` plus `getState()` / `restoreState()` and a `runManualTransform()` method used by command handlers.
    - `TransformState` (mutable internal) and `SerializedTransformState` (JSON-safe, step-based scheduling fields).
    - Batch queue entries (e.g., `TransformBatchState`) for `mode === 'batch'`.
  - Transform execution order and determinism:
    - Transform evaluation/execution order in `tick()` is stable: sort by `(order ?? 0, id)` using the transform definitions from the normalized pack (`packages/content-schema/src/modules/transforms.ts:69`).
    - Pending event triggers are coalesced per transform per tick (boolean pending via `Set<transformId>`), matching the AutomationSystem pattern (see Section 13.2 for rationale).
  - Trigger semantics (issue-523):
    - `manual`: executed only via `RUN_TRANSFORM` command handler; validates that `trigger.kind === 'manual'`.
    - `condition`: evaluated each tick; when true and transform is unlocked and not in cooldown, attempt one run (subject to safety).
    - `event`: when a subscribed event is received, mark transform as pending; `tick()` attempts one run per pending transform per tick (subject to safety), preserving pending state when the run is blocked (locked/cooldown/insufficient inputs/safety).
    - `automation`: supported via `automation:fired` events; when a referenced automation fires, mark the transform as pending and execute one run per pending transform per tick (subject to safety), retaining pending state when blocked.
  - Mode semantics (issue-523 “schedule output application according to mode”):
    - `instant`:
      - Evaluate inputs/outputs formulas (see “Formulas & Evaluation Context” below).
      - Atomically spend all inputs; if any input is unaffordable, fail without applying cooldown.
      - Apply outputs immediately (same command execution for manual; same tick for system-triggered runs).
    - `batch`:
      - On trigger, atomically spend inputs, then schedule outputs for delivery at `completeAtStep = currentStep + ceil(durationMs / stepDurationMs)`.
      - Enforce `safety.maxOutstandingBatches` at scheduling time; reject/skip new batches when at cap.
      - On `tick()`, deliver outputs for due batches deterministically in FIFO order (ties broken by schedule time then id).
    - `continuous` (see Section 13.1 for rationale):
      - Amounts are **per-second rates**: `amountThisTick = formula * deltaSeconds`.
      - Each tick while trigger is active: evaluate input/output formulas as rates, multiply by `deltaSeconds`, attempt spend/produce cycle.
      - If `duration` is undefined: continuous transform remains active while trigger condition is true.
      - If `duration` is specified: continuous transform remains active for `durationMs` after trigger activation, even if trigger becomes false.
      - Fractional amounts accumulate across ticks using ProductionSystem-style accumulators to prevent integer truncation.
      - Cooldown applies after each successful spend/produce cycle, not after duration expiration.
      - Subject to `maxRunsPerTick` safety cap per tick.
  - Formulas & evaluation context:
    - Transform formulas (`inputs[].amount`, `outputs[].amount`, `duration`, `cooldown`) use a `FormulaEvaluationContext` consistent with existing runtime patterns:
      - Prefer reusing `ProgressionCoordinator.createFormulaEvaluationContext` (`packages/core/src/progression-coordinator.ts:1459`) or `createAutomationFormulaEvaluationContext` (`packages/core/src/automation-system.ts:46`) as the baseline (level=0, time/deltaTime from `step`/`stepDurationMs`, entities backed by `ConditionContext`).
    - Guardrails:
      - Non-finite evaluations (`NaN`, `±Infinity`) invalidate the run (no spend, no outputs, no cooldown), with deterministic telemetry/error codes.
      - Negative evaluations are clamped to `0` for costs/outputs/durations/cooldowns (consistent with automation resourceCost handling).
      - Evaluate and normalize all input costs before spending; spend in a deterministic order to preserve atomicity and replay stability.
  - Unlock/visibility state:
    - `unlockCondition` (optional): evaluate via `evaluateCondition` (`packages/core/src/condition-evaluator.ts:122`) and apply **monotonically** (once unlocked, stay unlocked) to avoid regressions during replay and to match automation unlock persistence patterns.
    - `visibilityCondition` (optional): evaluate per tick to compute `visible` (default `true` when undefined, consistent with progression coordinator visibility semantics at `packages/core/src/progression-coordinator.ts:1455`).
    - Execution gating: `unlockCondition` gates execution; `visibilityCondition` gates snapshot/UI only.
  - Safety enforcement (see Section 13.4 for rationale):
    - `maxRunsPerTick`: default `10`, hard cap `100`. When undefined, use `DEFAULT_MAX_RUNS_PER_TICK = 10`. When authored value exceeds cap, clamp and record telemetry warning.
    - `maxOutstandingBatches`: default `50`, hard cap `1,000`. Enforced only for `batch` mode; reject new batches when at cap.

- **Data & Schemas**:
  - Add a new serialized transform state payload and embed it additively into the save payload:
    - Extend `packages/core/src/resource-state.ts:124` with `transformState?: readonly SerializedTransformState[]`.
    - Keep `PERSISTENCE_SCHEMA_VERSION` unchanged if the field is optional and restoration is backward compatible; bump only if a breaking change is introduced.
  - Serialized transform state (proposed):
    - `id: string`
    - `unlocked: boolean`
    - `cooldownExpiresStep: number`
    - `pendingEvent?: boolean` (optional; not persisted if derived)
    - `batches?: readonly { completeAtStep: number; outputs: readonly { resourceId: string; amount: number }[] }[]`
    - `continuous?: { enabled: boolean; activeUntilStep?: number }` (deferred until continuous semantics are confirmed)
  - Step rebasing on restore:
    - Mirror the automation restore strategy (`packages/core/src/automation-system.ts:242`): adjust step-based fields by `(currentStep - savedWorkerStep)` so cooldowns and batch completions preserve relative time across restores (`packages/shell-web/src/runtime.worker.ts:836`).

- **APIs & Contracts**:
  - Add command type and payload (issue-523 manual trigger):
    - `RUNTIME_COMMAND_TYPES.RUN_TRANSFORM = 'RUN_TRANSFORM'` in `packages/core/src/command.ts:107`.
    - `RunTransformPayload = { transformId: string; runs?: number }` (runs default 1; capped by safety).
    - Authorization policy (see Section 13.5 for rationale): restrict to `[PLAYER, SYSTEM]` priorities; block `AUTOMATION`. Manual transforms are player-initiated; automatic transforms (event/condition triggers) bypass the command system.
  - Add `registerTransformCommandHandlers({ dispatcher, transformSystem })` in `packages/core` mirroring `registerAutomationCommandHandlers` (`packages/core/src/automation-command-handlers.ts:27`).
  - Add a snapshot builder in `packages/core`:
    - `buildTransformSnapshot(step, publishedAt, { transforms, state, conditionContext, resourceState })` returning UI-ready transform views.
    - Transform view fields (proposed minimal contract):
      - `id`, `displayName`, `description`, `mode`, `unlocked`, `visible`
      - `cooldownRemainingMs`, `inputs`, `outputs`
      - `outstandingBatches` and `nextBatchReadyAtStep` (batch mode)
  - Wire into shell-web worker state updates (issue-523 snapshot view):
    - Extend `STATE_UPDATE.state` to include `transforms` alongside `progression` (`packages/shell-web/src/runtime.worker.ts:317`).
    - Extend session snapshot capture/restore to include transform state:
      - Capture: include transform state in `exportForSave` or as a sibling field (`packages/shell-web/src/runtime.worker.ts:939`).
      - Restore: call `transformSystem.restoreState(...)` if present (`packages/shell-web/src/runtime.worker.ts:835`).

- **Tooling & Automation**:
  - Unit tests:
    - Add colocated `*.test.ts` under `packages/core/src/` covering: manual instant success/failure, cooldown behavior, `maxRunsPerTick`, and one additional trigger path (event or condition) per issue-523.
  - Determinism discipline:
    - Avoid console noise in tests to preserve `vitest-llm-reporter` JSON summary output (repo guidelines in `AGENTS.md`).
  - Coverage:
    - If tests meaningfully change workspace coverage, regenerate `docs/coverage/index.md` via `pnpm coverage:md` (do not edit manually).

### 6.3 Operational Considerations
- **Deployment**:
  - `packages/core` publishes additive APIs (system + command types). Shells must consume the new snapshot field and command(s) before transforms are usable end-to-end.
  - Roll out in phases with feature-gated UI exposure; core support can land first without enabling authored transforms in sample content.
- **Telemetry & Observability**:
  - Add telemetry counters/errors for: invalid transform command payloads, unknown transform ids, insufficient resources, cooldown blocked, safety clamped, batch overflow.
  - Optionally publish runtime events for transform execution (e.g., `transform:executed`) as a follow-up, ensuring event catalogue updates remain deterministic (`packages/core/src/events/runtime-event-manifest.generated.ts:52`).
- **Security & Compliance**:
  - No PII in transform state/snapshots. Persist only ids and numeric scheduling/amount data. Validate all command payloads defensively (pattern in `packages/core/src/automation-command-handlers.ts:52`).

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
Populate the table as the canonical source for downstream GitHub issues.

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `docs: author runtime transform system design (issue-523)` | Finalize this design doc and confirm open questions for issue-523 scope. | Docs Agent | None | Doc approved; defaults/semantics agreed; issue map accepted. |
| `feat(core): add TransformSystem scaffolding + state (issue-523)` | Create `TransformSystem` with unlock/visibility, cooldown fields, deterministic ordering, and APIs for execution. | Runtime Implementation Agent | Design approved | `createTransformSystem` exists; state tracked; no regressions in core tests. |
| `feat(core): add RUN_TRANSFORM command + handler (issue-523)` | Add `RUN_TRANSFORM` to command catalog, payload typing, authorization policy, and handler that executes `instant` manual transforms atomically. | Runtime Implementation Agent | TransformSystem scaffold | Manual instant transform works end-to-end; invalid payloads fail with stable error codes; unit tests pass. |
| `feat(core): implement trigger path (condition or event) (issue-523)` | Implement at least one non-manual trigger path using `ConditionContext` and/or event subscriptions. | Event/Condition Trigger Agent | TransformSystem scaffold | At least one trigger path works; unit tests cover trigger activation + cooldown interaction. |
| `feat(core): implement batch scheduling + maxOutstandingBatches (issue-523)` | Add batch queue, duration scheduling, output delivery, and safety cap enforcement. | Runtime Implementation Agent | TransformSystem scaffold | Batch transforms schedule and deliver outputs deterministically; cap enforced; unit tests cover queue + cap. |
| `feat(core): persist transform state + restore rebasing (issue-523)` | Extend `SerializedResourceState` with `transformState`, export/import helpers, and step rebasing on restore. | Persistence Agent | Transform state defined | Save includes transform state; restore rebases steps correctly; integration test covers round-trip. |
| `feat(shell-web): surface transform snapshot + save/restore wiring (issue-523)` | Extend worker `STATE_UPDATE` to include transform snapshot and ensure session snapshot/restore includes transform state. | Snapshot/Contract Agent | Core snapshot API + persistence | Worker emits transforms snapshot; restore rehydrates state; existing worker tests updated and pass. |
| `feat(content-sample): add minimal transforms exercising runtime (issue-523)` | Add at least one transform to sample content to validate wiring; regenerate compiled artifacts. | Content Authoring Agent | Core support landed | `pnpm generate` clean; sample pack includes transform; optional integration smoke test passes. |
| `docs: update transform authoring guidance (issue-523)` | Document runtime semantics (manual/event/condition, cooldown, batch scheduling, safety defaults). | Docs Agent | Core semantics finalized | Docs updated; references to code paths and limitations included. |

### 7.2 Milestones
- **Phase 1**: MVP for issue-523 acceptance criteria
  - Deliver `TransformSystem` + `RUN_TRANSFORM` for `instant` manual transforms, cooldown, `maxRunsPerTick`, and one additional trigger path (event or condition), with unit tests.
  - Gate: `pnpm test --filter @idle-engine/core` green; deterministic behavior verified via repeated runs.
- **Phase 2**: Batch mode and persistence/snapshot completeness
  - Deliver batch scheduling, `maxOutstandingBatches`, save/load of transform state, and shell worker snapshot wiring.
  - Gate: session snapshot/restore integration test green; no regressions in worker bridge.
- **Phase 3**: Continuous mode support (automation triggers landed in #539)
  - Resolve semantics, implement continuous execution, and add determinism/performance tests.
  - Gate: performance budget verified; additional tests for continuous determinism.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Issue scope: https://github.com/hansjm10/Idle-Game-Engine/issues/523
  - Contracts: `packages/content-schema/src/modules/transforms.ts:97`, `docs/content-dsl-schema-design.md:738`
  - Runtime patterns: `packages/core/src/automation-system.ts:178`, `packages/core/src/index.ts:309`, `packages/core/src/resource-state.ts:124`
  - Shell worker wiring: `packages/shell-web/src/runtime.worker.ts:194`, `packages/shell-web/src/runtime.worker.ts:939`
- **Communication Cadence**:
  - Daily status updates on issue-523 with: completed issues, failing tests, and next agent assignment.
  - Review checkpoints at end of each phase; do not begin the next phase until reviewers sign off on the prior phase’s acceptance criteria.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Read: `docs/content-dsl-schema-design.md:738` (transform schema intent), `docs/content-dsl-usage-guidelines.md:288` (cycle/safety notes), and issue-523 body.
  - Load code context: `packages/content-schema/src/modules/transforms.ts`, `packages/core/src/automation-system.ts`, `packages/core/src/resource-state.ts`, `packages/core/src/events/runtime-event-catalog.ts`, `packages/shell-web/src/runtime.worker.ts`.
- **Prompting & Constraints**:
  - Canonical implementation prompt (Runtime Implementation Agent):
    - “Implement issue-523 by adding `TransformSystem` and `RUN_TRANSFORM` support in `packages/core`. Follow existing automation patterns for determinism, defensive validation, and persistence. Keep changes minimal, add colocated Vitest tests, and avoid console output.”
  - Canonical integration prompt (Shell Agent):
    - “Extend worker `STATE_UPDATE` to include transform snapshot data and ensure session snapshot/restore persists transform state. Maintain backwards compatibility with older snapshots.”
  - Repo constraints:
    - Use type-only imports/exports (`@typescript-eslint/consistent-type-imports/exports` is enforced).
    - Do not edit checked-in `dist/` outputs by hand; regenerate via workspace scripts if required.
- **Safety Rails**:
  - Do not reset git history, rewrite tags, or modify unrelated packages.
  - Avoid adding non-deterministic sources (Date.now in core logic); use runtime `step`/`timestamp` only when explicitly required.
  - Treat event-trigger backlogs defensively (coalesce by default) to avoid unbounded memory growth.
- **Validation Hooks**:
  - `pnpm lint`
  - `pnpm test --filter @idle-engine/core`
  - `pnpm test --filter shell-web` (when worker contracts change)
  - `pnpm coverage:md` (only when coverage-affecting tests/code land; commit `docs/coverage/index.md`)

## 9. Alternatives Considered
- **Shell-only transforms**:
  - Rejected: violates the deterministic-core architecture and fragments authored mechanics across shells; contradicts issue-523 goal.
- **Model transforms as generators (reuse ProductionSystem)**:
  - Pros: continuous transforms become “rates” naturally; can reuse accumulation and scaling.
  - Cons: awkward mapping for `instant` and `batch` semantics; introduces coupling and potentially leaks generator assumptions into transforms. Keep as a potential implementation strategy for `continuous` only.
- **Execute transforms exclusively via commands (no system)**:
  - Pros: preserves command ordering and simplifies determinism.
  - Cons: cannot naturally support event/condition triggers without synthesizing commands; batch delivery requires scheduled command emission anyway. A system remains the clearest owner for scheduled/batched work.
- **Evaluate batch outputs at completion instead of start**:
  - Pros: allows outputs to reflect late-bound state changes.
  - Cons: makes player-facing previews harder and complicates deterministic save/restore (requires re-evaluating formulas at completion). Prefer evaluating and freezing outputs at scheduling time for issue-523.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - `packages/core/src/transform-system.test.ts` (new): manual instant run success/failure, cooldown behavior, `maxRunsPerTick`, and one trigger path (`event` or `condition`) per issue-523.
  - `packages/shell-web/src/runtime.worker.test.ts` updates: assert `STATE_UPDATE` includes transform snapshot when enabled; session snapshot/restore round-trips transform state.
- **Performance**:
  - Add a targeted benchmark or test harness in `packages/core/benchmarks/` if transform evaluation becomes hot; validate no material regression versus baseline tick loop.
- **Tooling / A11y**:
  - No UI changes required for issue-523 MVP; if shell UI is extended to display transforms, run `pnpm test:a11y`.

## 11. Risks & Mitigations
- **Issue-523 scope drift (modes/triggers)**:
  - Mitigation: gate implementation by Phase 1 acceptance criteria; split `continuous` mode into an explicit follow-up issue if semantics are not confirmed.
- **Ambiguous continuous semantics**:
  - Mitigation: explicitly confirm continuous semantics before implementation (Open Questions); stage continuous as Phase 3 if needed.
- **Event-trigger backlog growth**:
  - Mitigation: coalesce event triggers per transform per tick; keep pending state on blocked runs; add hard cap if counts are later introduced.
- **Non-atomic multi-resource spends**:
  - Mitigation: precompute and validate all input costs before spending; spend in a deterministic order (sorted by resource id/index) and fail fast without partial application.
- **Save/restore step drift**:
  - Mitigation: rebase step-based fields using savedWorkerStep/currentStep (patterned after automation restore); add tests covering rebasing.
- **Performance regression with many transforms**:
  - Mitigation: evaluate unlock/visibility lazily for non-visible transforms; avoid recomputing quotes for hidden transforms; keep formula evaluation bounded.

## 12. Rollout Plan
- **Milestones**:
  - Phase 1: land core scaffolding + manual instant + one extra trigger path + tests.
  - Phase 2: land batch + persistence + snapshot wiring to shell-web worker.
  - Phase 3: land continuous mode support (automation triggers landed in #539).
- **Migration Strategy**:
  - Additive save field `transformState` only; restore tolerates absence; no migration required for existing saves.
  - If later changes require non-additive updates, bump `PERSISTENCE_SCHEMA_VERSION` and add migration transforms per `docs/persistence-migration-guide.md`.
- **Communication**:
  - Update issue-523 with phase completion notes and commands run.
  - Provide a short shell-web changelog entry when worker state envelope changes to ensure consumer alignment.

## 13. Resolved Design Decisions

The following questions were researched against existing codebase patterns, schema definitions, and idle game best practices. Each resolution includes rationale and references.

### 13.1 Continuous Mode Semantics ✓

**Decision**: For `continuous` transforms, `inputs/outputs[].amount` formulas evaluate to **per-second rates** (not per-tick amounts). The `duration` field, when specified, defines an **active window** in milliseconds.

**Rationale**:
- The ProductionSystem establishes per-second rates as the engine standard (`packages/core/src/production-system.ts:83-92`): `production = rate * owned * multiplier * deltaSeconds * consumptionRatio`.
- Formula evaluation context already provides `deltaTime` (seconds per step) for rate-to-amount conversion (`packages/core/src/automation-system.ts:46-99`).
- Per-second rates enable consistent scaling across varying tick durations and support accumulator patterns for fractional amounts.

**Implementation semantics**:
- Each tick while trigger is active: `amountThisTick = formula * deltaSeconds`.
- If `duration` is undefined: continuous transform remains active while trigger condition is true.
- If `duration` is specified: continuous transform remains active for `durationMs` after trigger activation, even if trigger becomes false.
- Cooldown applies after each successful run (spend + produce cycle), not after duration expiration.
- Fractional amounts should accumulate across ticks (reuse ProductionSystem accumulator pattern) to prevent integer truncation.

### 13.2 Event Trigger Multiplicity ✓

**Decision**: Multiple events of the same type firing in one tick are **coalesced** to a single trigger activation per transform (boolean pending state, not counted).

**Rationale**:
- The AutomationSystem establishes coalescing as the engine pattern (`packages/core/src/automation-system.ts:220, 307`): pending triggers are tracked via `Set<string>` (idempotent adds), not counted.
- Coalescing prevents unbounded transform runs if many events fire in a burst.
- Pending state is retained across ticks when execution is blocked (cooldown, insufficient resources), preventing event loss without counting.

**Implementation semantics**:
- `TransformSystem` maintains `pendingEventTriggers: Set<transformId>`.
- Event subscription: `events.on(eventId, () => pendingEventTriggers.add(transformId))`.
- `tick()` attempts one run per pending transform per tick (subject to safety caps).
- On successful run: remove from pending set.
- On blocked run (cooldown, resources, safety): retain in pending set for next tick.

### 13.3 Automation Trigger Support ✓

**Decision**: `trigger.kind === 'automation'` is **supported** via the `automation:fired` runtime event.

**Rationale**:
- `automation:fired` is published when an automation successfully executes, matching author expectations.
- The event-driven path preserves determinism and reuses the existing coalescing model.
- Content schema already requires an `automation` reference that matches the trigger automation id.

**Implementation semantics**:
- `AutomationSystem` publishes `automation:fired` with `{ automationId, triggerKind, step }`.
- `TransformSystem.setup()` subscribes to `automation:fired` and marks matching transforms as pending by `automationId`.
- Execution follows the same pending/coalescing rules as `event` triggers.

### 13.4 Safety Defaults and Caps ✓

**Decision**: Canonical defaults and hard caps are established as follows:

| Parameter | Default | Hard Cap | Rationale |
|-----------|---------|----------|-----------|
| `maxRunsPerTick` | **10** | **100** | Matches condition depth cap (100); prevents runaway loops while allowing controlled cascades. |
| `maxOutstandingBatches` | **50** | **1,000** | Proportional to command queue cap (10,000); prevents memory exhaustion from queued batches. |

**Rationale**:
- `MAX_CONDITION_DEPTH = 100` (`packages/core/src/condition-evaluator.ts:34`) establishes 100 as a safe recursion/iteration bound.
- `DEFAULT_MAX_QUEUE_SIZE = 10_000` (`packages/core/src/command-queue.ts:27`) establishes queue overflow semantics.
- Most idle games process 5-20 actions per tick; 10 is conservative for defaults while 100 allows intentional high-throughput designs.
- Each outstanding batch stores `{ completeAtStep, outputs[] }`; 1,000 batches ≈ 50-100KB (negligible memory).

**Implementation semantics**:
- When `safety.maxRunsPerTick` is undefined: use `DEFAULT_MAX_RUNS_PER_TICK = 10`.
- When authored value exceeds hard cap: clamp to `HARD_CAP_MAX_RUNS_PER_TICK = 100` and record telemetry warning.
- Apply same pattern for `maxOutstandingBatches` with defaults 50/1000.
- Non-finite or non-positive authored values fall back to defaults.

### 13.5 Command Authorization ✓

**Decision**: `RUN_TRANSFORM` is restricted to **`[PLAYER, SYSTEM]`** priorities. `AUTOMATION` priority is blocked.

**Rationale**:
- Manual transforms (via `RUN_TRANSFORM`) are player-initiated or system-driven, matching the `PRESTIGE_RESET` pattern (`packages/core/src/command.ts:275-281`).
- Automatic transforms (event/condition triggers) execute within `TransformSystem.tick()`, bypassing the command system entirely—no priority gating needed.
- Automation-triggered transforms use the event trigger path (not routed through `RUN_TRANSFORM`), keeping concerns separated.

**Implementation semantics**:
```typescript
RUN_TRANSFORM: {
  type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
  allowedPriorities: Object.freeze([CommandPriority.SYSTEM, CommandPriority.PLAYER]),
  rationale: 'Manual transforms are player-initiated or system-driven; automation trigger path is implemented separately.',
  unauthorizedEvent: 'UnauthorizedTransformCommand',
}
```

### 13.6 Remaining Follow-Up Items

No unresolved questions remain for issue-523 MVP scope. The following items are tracked as explicit follow-up work:

1. **Continuous mode accumulator pattern**: Confirm whether to reuse ProductionSystem's accumulator or implement transform-specific fractional handling.
2. **Transform execution events**: Consider publishing `transform:executed` events for observability (requires event manifest update).

## 14. Follow-Up Work
- Implement/confirm `continuous` mode behavior and add dedicated tests/benchmarks (new issue if split).
- Add optional runtime events for transform execution and wire into event manifest tooling (requires manifest regeneration and schema updates).
- Build shell-web UI surfaces for transforms (panel, affordance/disabled states, cooldown timers).

## 15. References
- GitHub issue #523: https://github.com/hansjm10/Idle-Game-Engine/issues/523
- Transform schema: `packages/content-schema/src/modules/transforms.ts:97`
- Transform validation + cycles: `packages/content-schema/src/pack/validate-cycles.ts`
- Runtime tick ordering: `packages/core/src/index.ts:309`
- Condition evaluation context: `packages/core/src/condition-evaluator.ts:39`
- Event catalogue / channels: `packages/core/src/events/runtime-event-catalog.ts:61`
- Worker runtime wiring + state update: `packages/shell-web/src/runtime.worker.ts:194`
- Worker snapshot capture: `packages/shell-web/src/runtime.worker.ts:939`

## Appendix A — Glossary
- **Transform (issue-523)**: A content-authored conversion that spends input resources and produces output resources under a trigger and mode (`packages/content-schema/src/modules/transforms.ts:97`).
- **Mode**: Execution style of a transform: `instant` (immediate), `batch` (delayed completion), `continuous` (per-second rate semantics documented; runtime support pending).
- **Trigger**: Activation mechanism for a transform: `manual`, `condition`, `event`, `automation` (`packages/content-schema/src/modules/transforms.ts:115`).
- **Cooldown**: Minimum time between successful transform starts; computed deterministically in steps from a `NumericFormula`.
- **Outstanding batch**: A queued batch transform instance waiting to deliver outputs at a scheduled future step.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-16 | Idle Engine Design-Authoring Agent (AI) | Initial draft for issue-523: TransformSystem, commands, triggers, persistence, snapshot plan. |
| 2025-12-16 | Claude Code (AI) | Resolved all 5 open questions with codebase research: continuous mode semantics (per-second rates), event coalescing (Set-based), automation triggers (deferred), safety caps (10/100, 50/1000), command auth (PLAYER+SYSTEM only). Updated Section 13 with rationale and implementation semantics. |
| 2025-12-22 | Codex (AI) | Updated automation-trigger support status after issue #539 landed. |
