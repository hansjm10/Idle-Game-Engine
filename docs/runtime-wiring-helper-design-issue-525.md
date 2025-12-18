---
title: Runtime Wiring Helper — Standard Runtime Integration (issue-525)
sidebar_position: 4
---

## Document Control
- **Title**: Provide a standard runtime wiring helper (issue-525)
- **Authors**: Idle Engine Design-Authoring Agent (AI)
- **Reviewers**: Core Runtime Maintainers; Shell-Web Maintainers
- **Status**: Draft
- **Last Updated**: 2025-12-18
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/525, https://github.com/hansjm10/Idle-Game-Engine/issues/560
- **Execution Mode**: AI-led

## 1. Summary
This design document addresses GitHub issue **#525** by introducing a first-class helper in `@idle-engine/core` that wires `IdleEngineRuntime` to `ProgressionCoordinator`, `ProductionSystem`, `AutomationSystem`, and standard command handlers in a deterministic, tested, and documented order. The helper reduces shell-specific glue code and prevents order-sensitive integration bugs by providing a canonical system sequence (including optional finalize/apply semantics) plus a reference manual wiring snippet for advanced shells that opt out.

## 2. Context & Problem Statement
- **Background**:
  - Shells currently wire runtime subsystems manually, including command queue/dispatcher, the progression coordinator, automation system, and per-step coordinator updates (example: `packages/shell-web/src/runtime.worker.ts:127`).
  - `IdleEngineRuntime.tick()` executes commands for `currentStep`, then runs added systems in registration order (`packages/core/src/index.ts:273`), making system ordering a correctness constraint.
  - Production can be integrated via `createProductionSystem`, including an opt-in finalize/apply mode (`applyViaFinalizeTick`) that requires `ResourceState.finalizeTick` ordering correctness (`packages/core/src/production-system.ts:309`).
- **Problem** (issue-525):
  - A typical game loop needs to connect:
    - Runtime step lifecycle (`IdleEngineRuntime`)
    - Progression updates aligned with runtime steps (`ProgressionCoordinator.updateForStep`)
    - Production execution order (especially when using finalize/apply semantics)
    - Automation execution order and unlock wiring (upgrade-granted automation ids)
    - Registration of standard command handlers (resource/generator/upgrade/prestige, plus automation control)
  - Today this wiring is order-sensitive and re-implemented per shell/harness, which is easy to get wrong and hard to review consistently (examples: `packages/shell-web/src/runtime.worker.ts:127`, `packages/core/src/offline-catchup-command-handlers.test.ts:79`).
- **Forces**:
  - **Determinism**: Wiring must preserve deterministic step stamping and timestamps (see `docs/runtime-step-lifecycle.md:1`).
  - **Performance**: The helper must not impose per-step O(N) overhead beyond existing system work; it must be safe for offline catch-up and backlog processing.
  - **API stability**: The helper must be optional and additive; manual wiring remains supported (issue-525).
  - **Correctness under backlog**: `IdleEngineRuntime.tick()` may process multiple steps per invocation (`packages/core/src/index.ts:282`), so order-sensitive logic must remain correct under multi-step processing.

## 3. Goals & Non-Goals
- **Goals**:
  1. Implement issue-525 by adding a core-owned helper that produces a working, standard-wired runtime with minimal glue code.
  2. Provide a **canonical, documented system ordering** for: progression updates, production, automation, and (when enabled) finalize/apply semantics.
  3. Register standard command handlers as part of the wiring helper, including resource/generator/upgrade/prestige handlers and automation toggle handlers.
  4. Add a unit test that asserts the helper’s system ordering and step-update semantics (issue-525 acceptance criteria).
  5. Add documentation that includes a manual reference wiring snippet and diagram (issue-525 acceptance criteria).
- **Non-Goals**:
  - Replacing or rewriting `IdleEngineRuntime`’s tick loop semantics (out of scope for issue-525; only a helper/reference implementation is required).
  - Refactoring ProductionSystem to a command-only model (documented in older notes; not required to satisfy issue-525).
  - Building new shell-web UI panels or changing worker-bridge message schemas; only wiring simplification is in scope.
  - Standardizing tick scheduling, snapshot publication, or transport buffering; shells/harnesses remain responsible for publishing state (e.g., via `buildProgressionSnapshot`) and choosing a publish cadence.
  - Enforcing a single “one true” game loop for all shells; advanced shells may keep manual wiring (issue-525).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Core Runtime Maintainers (API surface, determinism guarantees)
  - Shell-Web Maintainers (worker wiring, state publication cadence)
  - Content Authors (indirectly: fewer integration bugs in production/automation unlock flows)
- **Agent Roles** (AI-led execution):
  - **Runtime Implementation Agent**: implement helper API in `packages/core`, ensure exports across Node/browser entrypoints.
  - **Test & Determinism Agent**: add unit/integration tests that assert system order and step-update semantics under multi-step `runtime.tick`.
  - **Docs Agent**: write manual wiring reference and ordering diagram; cross-link to relevant existing docs and code.
  - **Shell Integration Agent**: adopt the helper in `packages/shell-web` worker wiring (optional but recommended), ensuring no behavior regressions.
- **Affected Packages/Services**:
  - `packages/core` (new helper + tests + documentation references)
  - `packages/shell-web` (optional adoption; reduced wiring code)
  - `docs/` (new/updated documentation for standard wiring)
- **Compatibility Considerations**:
  - The helper is additive; existing manual wiring remains valid.
  - System IDs introduced by the helper must be stable and documented so tests, telemetry, and diagnostics timelines remain readable.
  - The helper must preserve existing step-stamping semantics (`runtime.getNextExecutableStep()` and `context.step + 1` patterns).

## 5. Current State
- **Runtime step lifecycle and system ordering**:
  - Commands for `currentStep` execute before systems, and systems run in the order added (`packages/core/src/index.ts:309`, `packages/core/src/index.ts:373`).
  - Multi-step processing can occur in a single `tick(deltaMs)` call (`packages/core/src/index.ts:282`), so per-step wiring must be correct under backlog.
- **Shell-web wiring today (manual, order-sensitive)**:
  - Worker constructs queue/dispatcher/runtime, creates a progression coordinator, registers resource command handlers, wires automation system, and adds a coordinator update system that calls `updateForStep(step + 1, { events })` (`packages/shell-web/src/runtime.worker.ts:127`, `packages/shell-web/src/runtime.worker.ts:208`).
  - Production is not wired in the worker today, so other harnesses re-implement production ordering (example test harness: `packages/core/src/offline-catchup-command-handlers.test.ts:79`).
- **Finalize/apply semantics are opt-in and integration-dependent**:
  - `createProductionSystem` supports `applyViaFinalizeTick` which requires `resourceState.finalizeTick(deltaMs)` for balances to update (`packages/core/src/production-system.ts:309`).
  - `ResourceState.applyIncome/applyExpense` are additive per tick and therefore require a publish/reset once per tick after `snapshot({ mode: 'publish' })` (`docs/resource-state-storage-design.md:455`, `packages/core/src/resource-state.ts:951`).
  - `buildProgressionSnapshot` currently calls `ResourceState.snapshot({ mode: 'publish' })` and then `resetPerTickAccumulators()` as a side-effect (`packages/core/src/progression.ts:234`), which is convenient but can be misapplied when steps are processed in batches.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**:
  - Implement issue-525 by adding a **standard runtime wiring helper** in `packages/core` that:
    - creates or wires `IdleEngineRuntime` + `ProgressionCoordinator`
    - creates standard systems (`ProductionSystem`, `AutomationSystem`, coordinator update system)
    - registers standard command handlers
    - returns a small, inspectable wiring object that exposes the instantiated systems in canonical order
  - The helper is optional; manual wiring remains supported and documented.
- **Diagram** (logical ordering; finalize/apply system is conditional):
  ```mermaid
  flowchart TD
    A[IdleEngineRuntime.tick step N] --> B[Execute commands @ step N]
    B --> C[System: ProductionSystem]
    C --> D{applyViaFinalizeTick?}
    D -- yes --> E[System: ResourceFinalizeSystem]
    D -- no --> F[System: AutomationSystem]
    E --> F[System: AutomationSystem]
    F --> G[System: ProgressionCoordinatorUpdateSystem<br/>updateForStep(step+1)]
    G --> H[Runtime increments currentStep to N+1]
  ```

### 6.2 Detailed Design
- **New Core API surface (issue-525)**:
  - Add `createGameRuntime(options)` as the primary API for standard runtime integration (issue-525).
  - Add `wireGameRuntime(options)` as a lower-level primitive for shells that already constructed a runtime/coordinator but want canonical system wiring.
  - `createGameRuntime` constructs `CommandQueue`, `CommandDispatcher`, `IdleEngineRuntime`, and `ProgressionCoordinator`, then delegates to `wireGameRuntime` for system wiring + handler registration.
  - `wireGameRuntime` only wires systems + handlers; it does not own tick scheduling, worker messaging, or save/restore flows.
  - Step size alignment (determinism): `createGameRuntime` MUST use a single `stepSizeMs` value for both `IdleEngineRuntime` and `ProgressionCoordinator` (`stepDurationMs`). `wireGameRuntime` MUST validate alignment (or require the caller to pass the shared step size explicitly).
  - Provisional options (enough to satisfy issue-525 without over-scoping):
    - `content: NormalizedContentPack` (required)
    - `stepSizeMs?: number` (default: `100`)
    - `maxStepsPerFrame?: number` (default: `IdleEngineRuntime` default; when `applyViaFinalizeTick: true`, default SHOULD become `1` unless explicitly set)
    - `initialProgressionState?: ProgressionAuthoritativeState` (optional; passed to `createProgressionCoordinator`)
    - `enableProduction?: boolean` (default: `content.generators.length > 0`)
    - `enableAutomation?: boolean` (default: `content.automations.length > 0`)
    - `production?: { applyViaFinalizeTick?: boolean }` (default: `false`; see finalize/apply notes below)
    - `registerOfflineCatchup?: boolean` (default: `true`; see Section 13)
  - Return a `GameRuntimeWiring` object that includes:
    - `runtime: IdleEngineRuntime`
    - `coordinator: ProgressionCoordinator`
    - `productionSystem?: ProductionSystem`
    - `automationSystem?: ReturnType<typeof createAutomationSystem>`
    - `systems: readonly System[]` (the exact system instances in the order added; used by tests and diagnostics)
    - `commandQueue: CommandQueue` and `commandDispatcher: CommandDispatcher` (or references via runtime getters)
- **Canonical system IDs and ordering**:
  - The helper MUST add systems in a fixed, documented order matching the diagram above:
    1. Production (if content has generators, and production is enabled)
    2. Resource finalize (only when production is configured with `applyViaFinalizeTick: true`)
    3. Automation (if content has automations, and automation is enabled)
    4. Progression coordinator update system (always; provides step alignment)
  - Ordering rationale:
    - Production runs before automation so resource mutations (or queued rates) are visible when automation evaluates thresholds.
    - When enabled, `resourceState.finalizeTick(deltaMs)` runs immediately after production so balances are applied before automation reads amounts.
    - The coordinator update system runs last and uses `updateForStep(step + 1)` so coordinator-derived unlocks (notably achievement-derived grants) become visible starting the next tick, avoiding “unlock-and-fire” chains within the same step while preserving immediate command-side effects.
  - Canonical system IDs (defaults; used by tests and diagnostics):
    - Production: `production` (default id from `createProductionSystem`)
    - Resource finalize: `resource-finalize` (new system owned by the helper)
    - Automation: `automation-system` (id from `createAutomationSystem`)
    - Coordinator update: `progression-coordinator` (matches `packages/shell-web/src/runtime.worker.ts:209`)
  - The coordinator update system MUST call `coordinator.updateForStep(context.step + 1, { events: context.events })` to keep coordinator state aligned with the runtime’s `currentStep` after the tick completes (existing pattern: `packages/shell-web/src/runtime.worker.ts:208`).
- **Standard system wiring details**:
  - Production: wire `createProductionSystem` against coordinator generator state by mapping coordinator generators into `GeneratorProductionState` (notably: ensure `produces`/`consumes` are always arrays; see snippet below) and `coordinator.resourceState`.
  - Automation: wire `createAutomationSystem` using `commandQueue: runtime.getCommandQueue()`, `resourceState: createResourceStateAdapter(coordinator.resourceState)`, `conditionContext: coordinator.getConditionContext()`, and `isAutomationUnlocked: (id) => coordinator.getGrantedAutomationIds().has(id)`.
- **Finalize/apply semantics wiring**:
  - When `applyViaFinalizeTick: true`, insert a `ResourceFinalizeSystem` immediately after production and before automation so that:
    - production can queue per-second rates (`applyIncome/applyExpense`)
    - `resourceState.finalizeTick(context.deltaMs)` applies balances before automation evaluates resource thresholds
  - When `applyViaFinalizeTick: false`, do not add finalize system (avoid per-step O(resourceCount) finalize loops).
  - UI rate display note: when using the core `ResourceState` (supports `finalizeTick`), direct-apply production updates balances but does not populate `incomePerSecond` / `expensePerSecond` / `netPerSecond`, so `buildProgressionSnapshot(...).resources[].perTick` will remain `0` unless finalize/apply semantics (or alternative rate tracking) are used.
  - Multi-step tick constraint: per-second rate fields are additive and must be cleared once per tick after a `snapshot({ mode: 'publish' })` + `resetPerTickAccumulators()` boundary (`docs/resource-state-storage-design.md:455`). When `applyViaFinalizeTick: true`, the integration MUST ensure that boundary occurs once per processed step; the simplest safe default is to keep `maxStepsPerFrame: 1` (or otherwise ensure only one step runs between resource publish/resets). Offline/backlog fast-forward can still run by looping ticks and publishing/resetting per step, forwarding only the final snapshot to the UI.
  - Documentation MUST explicitly state that per-second rate accumulators are additive and require a publish/reset per tick (`packages/core/src/resource-state.ts:951`), and link to `docs/resource-state-storage-design.md:455`.
- **Standard command handler registration**:
  - The helper MUST register:
    - `registerResourceCommandHandlers` with coordinator-derived evaluators (generator purchases + toggles, plus optional upgrade/prestige evaluators when present) (`packages/shell-web/src/runtime.worker.ts:170`).
    - `registerAutomationCommandHandlers` when automation is enabled (`packages/shell-web/src/runtime.worker.ts:215`).
  - The helper SHOULD register `registerOfflineCatchupCommandHandler` by default (`registerOfflineCatchup: true`) and allow opting out for shells that manage offline reconciliation externally (`packages/shell-web/src/runtime.worker.ts:188`).
- **Documentation deliverable (issue-525)**:
  - Add a docs page that includes:
    - A “use the helper” snippet
    - A “manual wiring reference” snippet showing the same ordering and required calls
    - A diagram of tick ordering and the `updateForStep(step + 1)` rationale
  - The docs page MUST cross-link to existing lifecycle notes (`docs/runtime-step-lifecycle.md:1`) and the worker as a concrete example (`packages/shell-web/src/runtime.worker.ts:127`).

#### Example snippets (for review)

##### Use the helper
```ts
import { buildProgressionSnapshot, createGameRuntime } from '@idle-engine/core';
import type { NormalizedContentPack } from '@idle-engine/content-schema';

export function createWorkerRuntime(content: NormalizedContentPack) {
  const wiring = createGameRuntime({
    content,
    stepSizeMs: 100,
    registerOfflineCatchup: true,
    // production: { applyViaFinalizeTick: true },
    // maxStepsPerFrame: 1, // recommended when applyViaFinalizeTick is enabled
  });

  const { runtime, coordinator } = wiring;

  return {
    runtime,
    coordinator,
    tick(deltaMs: number, publishedAt: number) {
      const processedSteps = runtime.tick(deltaMs);
      if (processedSteps === 0) {
        return undefined;
      }

      // Coordinator state is already step-aligned by the update system.
      return buildProgressionSnapshot(
        runtime.getCurrentStep(),
        publishedAt,
        coordinator.state,
      );
    },
  };
}
```

##### Manual wiring reference
```ts
import {
  CommandDispatcher,
  CommandQueue,
  IdleEngineRuntime,
  createAutomationSystem,
  createProductionSystem,
  createProgressionCoordinator,
  createResourceStateAdapter,
  registerAutomationCommandHandlers,
  registerOfflineCatchupCommandHandler,
  registerResourceCommandHandlers,
} from '@idle-engine/core';
import type { NormalizedContentPack } from '@idle-engine/content-schema';

const STEP_SIZE_MS = 100;

export function wireRuntimeManually(content: NormalizedContentPack) {
  const applyViaFinalizeTick = false;

  const commandQueue = new CommandQueue();
  const commandDispatcher = new CommandDispatcher();
  const runtime = new IdleEngineRuntime({
    commandQueue,
    commandDispatcher,
    stepSizeMs: STEP_SIZE_MS,
    ...(applyViaFinalizeTick ? { maxStepsPerFrame: 1 } : {}),
  });

  const coordinator = createProgressionCoordinator({
    content,
    stepDurationMs: STEP_SIZE_MS,
  });

  registerResourceCommandHandlers({
    dispatcher: runtime.getCommandDispatcher(),
    resources: coordinator.resourceState,
    generatorPurchases: coordinator.generatorEvaluator,
    generatorToggles: coordinator,
    ...(coordinator.upgradeEvaluator
      ? { upgradePurchases: coordinator.upgradeEvaluator }
      : {}),
    ...(coordinator.prestigeEvaluator
      ? { prestigeSystem: coordinator.prestigeEvaluator }
      : {}),
  });

  registerOfflineCatchupCommandHandler({
    dispatcher: runtime.getCommandDispatcher(),
    coordinator,
    runtime,
  });

  const productionSystem = createProductionSystem({
    applyViaFinalizeTick,
    generators: () =>
      (coordinator.state.generators ?? []).map((generator) => ({
        id: generator.id,
        owned: generator.owned,
        enabled: generator.enabled,
        produces: generator.produces ?? [],
        consumes: generator.consumes ?? [],
      })),
    resourceState: coordinator.resourceState,
  });
  runtime.addSystem(productionSystem);

  if (applyViaFinalizeTick) {
    runtime.addSystem({
      id: 'resource-finalize',
      tick: ({ deltaMs }) => coordinator.resourceState.finalizeTick(deltaMs),
    });
  }

  const automationSystem = createAutomationSystem({
    automations: content.automations,
    commandQueue: runtime.getCommandQueue(),
    resourceState: createResourceStateAdapter(coordinator.resourceState),
    stepDurationMs: STEP_SIZE_MS,
    conditionContext: coordinator.getConditionContext(),
    isAutomationUnlocked: (automationId) =>
      coordinator.getGrantedAutomationIds().has(automationId),
  });
  runtime.addSystem(automationSystem);

  runtime.addSystem({
    id: 'progression-coordinator',
    tick: ({ step, events }) => {
      coordinator.updateForStep(step + 1, { events });
    },
  });

  registerAutomationCommandHandlers({
    dispatcher: runtime.getCommandDispatcher(),
    automationSystem,
  });

  return { runtime, coordinator };
}
```

### 6.3 Operational Considerations
- **Deployment**: No runtime deployment changes; this is a library-level additive helper in `packages/core`.
- **Telemetry & Observability**:
  - System IDs provided by the helper should be stable to keep diagnostics readable (see `IdleEngineRuntime` diagnostics timeline integration in `packages/core/src/index.ts:294`).
  - Helper-generated wiring should not introduce new nondeterministic timestamps; continue using deterministic timestamps for automation enqueues as implemented (`docs/runtime-step-lifecycle.md:44`).
- **Security & Compliance**:
  - No new PII surface; the helper only composes existing runtime components.
  - The helper must not relax command authorization rules (command authorization remains enforced by `CommandDispatcher`/authorizers; out of scope for issue-525).

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(core): add createGameRuntime wiring helper (issue-525)` | Implement `createGameRuntime` + `wireGameRuntime`, canonical system IDs/order, and standard handler registration. | Runtime Implementation Agent | Design approved | Helper exported from both Node and browser entrypoints; `systems` list exposes canonical order; manual wiring remains possible. |
| `test(core): assert runtime wiring helper order + step semantics (issue-525)` | Add unit test(s) verifying `systems` order and `updateForStep(step+1)` alignment with `runtime.getCurrentStep()`. | Test & Determinism Agent | Helper implementation | Tests pass under multi-step `runtime.tick` backlog; no flaky wall-clock dependence. |
| `docs: add runtime wiring helper reference + manual snippet (issue-525)` | New docs page with diagram/snippets; update cross-links from lifecycle docs if needed. | Docs Agent | Helper API shape finalized | Docs include helper snippet + manual wiring reference + ordering diagram; links to core code paths. |
| `chore(shell-web): adopt core wiring helper in runtime.worker (issue-525)` | Replace manual worker wiring with helper (optional but recommended). | Shell Integration Agent | Helper + docs | Worker compiles; behavior parity for automation and coordinator updates; no change to bridge schema. |

### 7.2 Milestones
- **Phase 1 (Core API + tests)**:
  - Deliver `createGameRuntime`/`wireGameRuntime`, register handlers, and add unit tests proving order + step semantics.
  - Gate: reviewers approve API naming and canonical system ordering.
- **Phase 2 (Docs + reference adoption)**:
  - Publish docs page with diagram and manual wiring snippet.
  - Optionally adopt in `packages/shell-web` worker for dogfooding.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Issue scope: https://github.com/hansjm10/Idle-Game-Engine/issues/525
  - Reference wiring: `packages/shell-web/src/runtime.worker.ts:127`
  - Runtime ordering: `packages/core/src/index.ts:309`
  - Finalize/apply semantics: `packages/core/src/production-system.ts:309`
  - Publish/reset requirement: `packages/core/src/resource-state.ts:951`
- **Communication Cadence**:
  - Daily async updates in PR thread; request review once tests + docs are included.
  - Escalate naming/semantics decisions in Section 13 before merging.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Load issue text via `gh issue view 525 --repo hansjm10/Idle-Game-Engine` (source of truth).
  - Read worker wiring reference: `packages/shell-web/src/runtime.worker.ts:127`.
  - Read runtime step ordering: `packages/core/src/index.ts:273`.
  - Read per-tick accumulator rules: `docs/resource-state-storage-design.md:455`.
- **Prompting & Constraints**:
  - Use TypeScript ES modules; follow `@typescript-eslint/consistent-type-imports` and type-only exports (`AGENTS.md` repo root).
  - Keep helper optional and additive; do not remove manual wiring pathways.
  - Keep system order a single source of truth (returned `systems` list must match actual registration order).
  - Avoid nondeterministic timestamps in tests; prefer step-based values.
- **Safety Rails**:
  - Do not edit checked-in generated `dist/` outputs (repo guideline).
  - Do not add console logging in tests (Vitest reporter expects clean output).
  - Do not change command type names or authorization policies as part of issue-525.
- **Validation Hooks**:
  - `pnpm lint`
  - `pnpm test --filter @idle-engine/core`
  - `pnpm test --filter shell-web` (only if worker wiring changes land)

## 9. Alternatives Considered
- **Status quo (manual wiring in each shell)**:
  - Rejected: repeats order-sensitive logic and fails issue-525’s “minimal glue code” goal.
- **Docs-only reference without helper**:
  - Rejected: improves guidance but does not prevent incorrect wiring; issue-525 explicitly requests a helper and a unit test.
- **Make `IdleEngineRuntime` auto-wire progression/production/automation internally**:
  - Rejected: too opinionated and risks breaking advanced shells; helper must remain optional (issue-525).
- **Place helper in `packages/shell-web` instead of `packages/core`**:
  - Rejected: core should own canonical wiring to keep multiple shells/harnesses consistent.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Add unit tests in `packages/core` that:
    - assert `systems.map((s) => s.id)` matches canonical order (issue-525 acceptance criteria)
    - assert `coordinator.getLastUpdatedStep()` aligns with `runtime.getCurrentStep()` after ticking (step-update semantics)
  - Add at least one test case that exercises `runtime.tick` processing >1 step per call (to catch ordering regressions under backlog).
- **Performance**:
  - No new hot-loop allocations beyond existing wiring; avoid per-step O(N) work in helper itself.
  - If `applyViaFinalizeTick` is enabled, document the cost and require explicit opt-in.
- **Tooling / A11y**:
  - Not applicable to issue-525 unless `shell-web` UI flows change.

## 11. Risks & Mitigations
- **Risk: Incorrect canonical ordering causes subtle simulation drift**.
  - Mitigation: unit tests asserting system order + step-update semantics; document order with diagram and code references.
- **Risk: Helper becomes too opinionated and blocks advanced shells**.
  - Mitigation: keep helper optional; provide `wireGameRuntime` for partial adoption; document manual wiring.
- **Risk: Browser/Node entrypoint export drift** (`index.ts` vs `index.browser.ts`).
  - Mitigation: add export tests or a single source module imported by both entrypoints (implementation detail to be decided by Runtime Implementation Agent).
- **Risk: Performance regressions in backlog/offline catchup**.
  - Mitigation: keep finalize/apply and any per-step finalize loops behind explicit options; do not build progression snapshots per step inside the helper.

## 12. Rollout Plan
- **Milestones**:
  1. Land helper + tests in `packages/core` (issue-525 Phase 1).
  2. Publish docs page with helper + manual reference wiring (issue-525 Phase 2).
  3. Optionally migrate `packages/shell-web` worker to helper for dogfooding.
- **Migration Strategy**:
  - No data migrations; API is additive.
  - Shells can migrate incrementally: adopt helper in new shells first; optionally refactor existing worker wiring.
- **Communication**:
  - Announce the helper in `docs/automation-authoring-guide.md` or a runtime integration guide as follow-up (see Section 14).

## 13. Open Questions
1. **API naming**: Confirm `createGameRuntime` + `wireGameRuntime` as the public API names (matches issue-525 wording and the existing `createVerificationRuntime` precedent).
2. **Automation ordering semantics**: Confirm automation runs before the coordinator update system, and the coordinator update system remains last (rationale in Section 6.2).
3. **Offline catchup default**: Confirm `registerOfflineCatchup: true` default with an opt-out for shells that manage offline reconciliation externally.
4. **Production default mode**: Confirm `applyViaFinalizeTick: false` default (safe under backlog), acknowledging the `perTick` UI rate trade-off described in Section 6.2.
5. **Finalize/apply safety default**: Should `createGameRuntime` automatically default `maxStepsPerFrame` to `1` when `applyViaFinalizeTick: true`? (Proposed: yes unless explicitly set.)
6. **Transforms**: Confirm `TransformSystem` wiring remains out of scope for issue-525 v1.

## 14. Follow-Up Work
- Add an “integration guide” page that consolidates runtime wiring helper usage, state publication patterns, and common pitfalls (Owner: Docs Agent).
- Add optional transform wiring (if/when transforms are considered part of “standard” runtime composition) (Owner: Runtime Implementation Agent).
- Provide a `wireGameRuntime` example in `tools/` or `packages/content-sample` for headless simulation harnesses (Owner: Runtime Implementation Agent).

## 15. References
- GitHub issue #525: https://github.com/hansjm10/Idle-Game-Engine/issues/525
- Worker manual wiring example: `packages/shell-web/src/runtime.worker.ts:127`
- Coordinator update semantics (step + 1): `packages/shell-web/src/runtime.worker.ts:208`
- Runtime tick ordering (commands then systems): `packages/core/src/index.ts:309`
- Production finalize/apply option: `packages/core/src/production-system.ts:309`
- Per-tick accumulator reset guard: `packages/core/src/resource-state.ts:951`
- Snapshot builder resets accumulators: `packages/core/src/progression.ts:234`
- Backlog/multi-step processing behavior: `packages/core/src/index.ts:282`
- Resource publish/reset design rationale: `docs/resource-state-storage-design.md:455`
- Step stamping overview: `docs/runtime-step-lifecycle.md:1`

## Appendix A — Glossary
- **Issue-525**: GitHub issue “enhancement(core): provide standard runtime wiring helper” defining the scope for this initiative.
- **Wiring helper**: A core-provided function that constructs and/or wires runtime subsystems in a canonical order and registers handlers.
- **Coordinator update system**: A runtime system that calls `ProgressionCoordinator.updateForStep(step + 1)` so coordinator-derived state aligns with `IdleEngineRuntime.getCurrentStep()`.
- **Finalize/apply semantics**: Production mode (`applyViaFinalizeTick`) where systems queue per-second rates and `ResourceState.finalizeTick(deltaMs)` applies balances.
- **Per-tick accumulators**: `ResourceState` fields (`incomePerSecond`, `expensePerSecond`, `netPerSecond`, `tickDelta`) that must be reset once per tick after publishing.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-17 | Idle Engine Design-Authoring Agent (AI) | Initial draft for issue-525: standard runtime wiring helper proposal, canonical ordering, tests, docs, and AI-led work plan. |
| 2025-12-18 | Codex CLI (AI) | Clarify production generator mapping + finalize/apply rate implications; add reference snippets; reframe “resolved” items as open questions pending maintainer confirmation. |
