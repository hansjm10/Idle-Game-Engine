---
title: CreateGame Factory Design (Issue 750)
sidebar_position: 6
---

# CreateGame Factory Design (Issue 750)

## Document Control
- **Title**: Introduce `createGame()` high-level factory (Issue 750)
- **Authors**: Codex (AI)
- **Reviewers**: TODO (Owner: Runtime Core Maintainers)
- **Status**: Draft
- **Last Updated**: 2026-01-15
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/750
- **Execution Mode**: AI-led

## 1. Summary
In regards to issue 750 on GitHub (“feat(core): add high-level createGame factory for simplified onboarding”), this design introduces a stable `createGame(contentPack, options?)` façade that wraps existing runtime wiring (`createGameRuntime`) to deliver a minimal, type-safe `Game` interface (lifecycle, snapshots, player actions, persistence, events) while retaining advanced access via `game.internals` and preserving the deterministic command-queue execution model.

## 2. Context & Problem Statement
- **Background**: Issue 750 targets developer onboarding friction when integrating the deterministic runtime exposed via the stable public entrypoint (`packages/core/src/index.browser.ts:19`) and its current primary wiring function (`packages/core/src/internals.browser.ts:917`).
- **Problem**: Issue 750 reports that new developers must understand and plumb numerous internals (runtime host, coordinator, command queue/dispatcher, and per-domain systems) returned by `GameRuntimeWiring` (`packages/core/src/game-runtime-wiring.ts:44`), and must correctly stamp/queue commands to mutate state deterministically (priority/step/timestamp as described in `docs/runtime-command-queue-design.md:589` and `docs/runtime-command-queue-design.md:615`).
- **Forces**:
  - Determinism must be preserved: within a priority tier, commands execute in timestamp order (`docs/runtime-command-queue-design.md:594`), and existing systems already derive timestamps from simulation time for replay safety (`packages/core/src/automation-system.ts:967`).
  - The stable public surface is intentionally small and contract-tested (`packages/core/src/index.test.ts:164`); Issue 750 must remain additive and avoid exporting broad internals.
  - Browser-safe, host-agnostic API: no Node-only dependencies in `@idle-engine/core` public entrypoint; any scheduler/timer behavior must remain optional and side-effect-contained.
  - Backwards compatibility: existing `createGameRuntime`/`wireGameRuntime` integrations remain supported (`packages/core/src/index.browser.ts:19`), with clear guidance that Issue 750’s `createGame` is the preferred onboarding path.

## 3. Goals & Non-Goals
- **Goals**:
  - Issue 750 provides a one-call bootstrap (`createGame(contentPack)`) that yields a working runtime with default systems/handlers auto-wired (via existing wiring in `packages/core/src/game-runtime-wiring.ts:81`).
  - Issue 750 defines a stable `Game` interface in `packages/core/src/game.ts` that includes:
    - Lifecycle: `start`, `stop`, `tick`
    - State: `getSnapshot` returning a UI-ready snapshot derived from `buildProgressionSnapshot` (`packages/core/src/progression.ts:421`)
    - Persistence: `serialize`/`hydrate` over the existing save schema (`packages/core/src/game-state-save.ts:24`)
    - Player actions: type-safe convenience methods mapping to `RUNTIME_COMMAND_TYPES` (`packages/core/src/command.ts:107`)
    - Events: `on(...)` wrapper over runtime event bus subscriptions (`packages/core/src/events/event-bus.ts:54`)
    - Progressive disclosure: `internals: GameRuntimeWiring` for advanced use cases
  - Issue 750 standardizes command stamping for façade player actions:
    - Priority defaults to `CommandPriority.PLAYER` (`packages/core/src/command.ts:77`)
    - Step defaults to `runtime.getNextExecutableStep()` (per queue design guidance in `docs/runtime-command-queue-design.md:615`)
    - Timestamp defaults to simulation-time derived values (pattern in `packages/core/src/automation-system.ts:1040`)
  - Issue 750 updates documentation to include a `createGame()` onboarding example (`docs/content-quick-reference.md:1`) and references the layered architecture justification (`docs/idle-engine-design.md:190`).
  - Issue 750 adds integration tests validating factory behavior and action-method command enqueueing (patterned after `packages/core/src/game-runtime-wiring.test.ts:101`).
- **Non-Goals**:
  - Issue 750 does not remove or redesign `createGameRuntime` / `wireGameRuntime` or relocate them between entrypoints (follow-up optional).
  - Issue 750 does not introduce new command types, change command-queue ordering semantics, or execute commands outside tick boundaries.
  - Issue 750 does not ship a full host shell/worker bridge; it only provides a runtime façade suitable for downstream shells to embed.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Issue 750 is owned by Runtime Core maintainers, with downstream game integrators and Docs maintainers as stakeholders for adoption and guidance.
- **Agent Roles**:

| Agent | Responsibilities |
|-------|------------------|
| Runtime API Agent | Issue 750: implement `packages/core/src/game.ts` (`Game`, `CreateGameOptions`, `createGame`) and export via `packages/core/src/index.browser.ts`. |
| Command Semantics Agent | Issue 750: enforce deterministic command stamping rules for façade action methods; ensure alignment with `docs/runtime-command-queue-design.md:615`. |
| Testing Agent | Issue 750: add Vitest integration coverage for `createGame` lifecycle, action enqueueing, and persistence. |
| Docs Agent | Issue 750: add `createGame` onboarding examples and update any docs that position `createGameRuntime` as the primary integration surface. |
| Integration Agent | Issue 750: verify workspace exports and stable-surface tests (`packages/core/src/index.test.ts:164`) remain valid; ensure `@idle-engine/core/public` stays aligned. |

- **Affected Packages/Services**: Issue 750 impacts `packages/core` (new façade API), plus `docs/` for onboarding guidance (`docs/content-quick-reference.md:1`).
- **Compatibility Considerations**:
  - Issue 750 is additive: existing consumers of `createGameRuntime` remain unaffected.
  - The stable public entrypoint will add exactly one new runtime export (`createGame`), and must update the stable-surface contract test (`packages/core/src/index.test.ts:164`).
  - `game.internals` explicitly opts users into wiring details; stability expectations remain consistent with `@idle-engine/core` vs `@idle-engine/core/internals`.

## 5. Current State
- Issue 750’s current integration story centers on `createGameRuntime` (`packages/core/src/internals.browser.ts:917`), which wires systems, registers command handlers, and returns a broad `GameRuntimeWiring` object exposing runtime, coordinator, command plumbing, enabled systems, and persistence helpers (`packages/core/src/game-runtime-wiring.ts:44`).
- There is no single “game façade” that:
  - Encapsulates lifecycle scheduling (hosts must call `runtime.tick(...)` directly),
  - Provides a default UI snapshot function (despite `buildProgressionSnapshot` existing in `packages/core/src/progression.ts:421`),
  - Offers ergonomic, type-safe player action methods that consistently stamp commands per the command-queue contract (`docs/runtime-command-queue-design.md:615`).
- The result (as described in Issue 750) is that onboarding users either (a) misuse internals, or (b) reinvent ad-hoc wrappers that vary in determinism guarantees and error handling.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**: Issue 750 introduces `createGame(contentPack, options?)` as the primary onboarding API. Internally, it calls `createGameRuntime` (`packages/core/src/internals.browser.ts:917`) to produce `GameRuntimeWiring`, then wraps it in a stable `Game` façade that:
  - Controls ticking (manual `tick`, optional `start`/`stop` scheduler),
  - Publishes UI-ready snapshots (`buildProgressionSnapshot`, `packages/core/src/progression.ts:421`),
  - Enqueues player commands via dedicated action methods that stamp `priority`, `step`, and deterministic `timestamp`,
  - Delegates save/load to existing schema + wiring helpers (`packages/core/src/game-state-save.ts:24`),
  - Exposes `internals` explicitly for advanced use cases.
- **Diagram**:
```text
NormalizedContentPack
  -> createGame(content, options?)
       -> createGameRuntime({ content, ... })  [wires systems + handlers]
       -> Game façade
            - start/stop/tick
            - getSnapshot() -> buildProgressionSnapshot(...)
            - action methods -> enqueue PLAYER commands
            - serialize/hydrate -> wiring helpers
            - on(...) -> runtime EventBus
            - internals -> GameRuntimeWiring
```

### 6.2 Detailed Design
- **Runtime Changes** (Issue 750):
  - Add `packages/core/src/game.ts`:
    - `export interface Game { ... }`
    - `export type GameSnapshot = ProgressionSnapshot` (`packages/core/src/progression.ts:279`)
    - `export type SerializedGameState = GameStateSaveFormat` (`packages/core/src/game-state-save.ts:46`)
    - `export type CreateGameOptions = Readonly<{ ... }>`
    - `export function createGame(content: NormalizedContentPack, options?: CreateGameOptions): Game`
  - Export `createGame` from the stable entrypoint (`packages/core/src/index.browser.ts:19`) and update the stable-surface contract test (`packages/core/src/index.test.ts:164`).
- **CreateGameOptions** (Issue 750):
  - Defaults: call-site should be able to omit all options for the “one-liner” onboarding path.
  - Advanced factory configuration from Issue 750 maps onto existing wiring toggles and engine config:
    - `systems.*` → `CreateGameRuntimeOptions.enable*` (`packages/core/src/internals.browser.ts:902`)
    - `eventBus.capacity` → `EngineConfigOverrides.limits.eventBusDefaultChannelCapacity` (wired into `createGameRuntime`, `packages/core/src/internals.browser.ts:943`)
    - `diagnostics.*` → `IdleEngineRuntime.enableDiagnostics(...)` (`packages/core/src/internals.browser.ts:347`)
  - Proposed shape (exact naming finalized during implementation; TODO owner: Runtime Core maintainers):
```ts
export type CreateGameOptions = Readonly<{
  readonly config?: EngineConfigOverrides;
  readonly stepSizeMs?: number;
  readonly maxStepsPerFrame?: number;
  readonly initialStep?: number;
  readonly initialProgressionState?: ProgressionAuthoritativeState;

  readonly systems?: Readonly<{
    readonly production?: boolean;
    readonly automation?: boolean;
    readonly transforms?: boolean;
    readonly entities?: boolean;
  }>;

  readonly diagnostics?: Readonly<{
    readonly enabled?: boolean;
    readonly timeline?: RuntimeDiagnosticsTimelineOptions | false;
  }>;

  readonly eventBus?: Readonly<{
    readonly capacity?: number;
  }>;

  readonly scheduler?: Readonly<{
    readonly intervalMs?: number; // default: stepSizeMs
  }>;
}>;
```
- **Game Interface** (Issue 750; stable surface MUST match this shape):
```ts
export type Unsubscribe = () => void;

export interface Game {
  // Lifecycle (Issue 750)
  start(): void;
  stop(): void;
  tick(deltaMs: number): void;

  // State (Issue 750)
  getSnapshot(): GameSnapshot;

  // Persistence (Issue 750)
  serialize(): SerializedGameState;
  hydrate(save: SerializedGameState): void;

  // Player actions (Issue 750)
  purchaseGenerator(generatorId: string, count: number): CommandResult;
  purchaseUpgrade(upgradeId: string): CommandResult;
  toggleAutomation(automationId: string, enabled: boolean): CommandResult;
  startTransform(transformId: string): CommandResult;

  // Events (Issue 750)
  on<TType extends RuntimeEventType>(
    eventType: TType,
    handler: EventHandler<TType>,
    options?: EventSubscriptionOptions,
  ): Unsubscribe;

  // Advanced (Issue 750)
  readonly internals: GameRuntimeWiring;
}
```
  - Notes (Issue 750):
    - `getSnapshot` should use `buildProgressionSnapshot` (`packages/core/src/progression.ts:421`) over `internals.coordinator.state`; this keeps the snapshot JSON-friendly and UI-ready.
    - `serialize`/`hydrate` should delegate to wiring helpers (`GameRuntimeWiring.serialize`/`hydrate`, `packages/core/src/game-runtime-wiring.ts:179`) and keep the stable façade signature minimal; advanced options remain available via `game.internals`.
    - `start`/`stop` are convenience-only; downstream hosts may ignore them and drive `tick` directly.
- **Action Method → Command Mapping** (Issue 750):
  - Each action enqueues a `CommandPriority.PLAYER` command targeting `runtime.getNextExecutableStep()` and uses a deterministic timestamp derived from the simulation clock (as documented for automation in `packages/core/src/automation-system.ts:967`).

| Game method (Issue 750) | Command type | Payload type | Enqueue stamping |
|-------------------------|--------------|--------------|------------------|
| `purchaseGenerator(generatorId, count)` | `RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR` (`packages/core/src/command.ts:107`) | `PurchaseGeneratorPayload` (`packages/core/src/command.ts:133`) | `priority=PLAYER`; `step=runtime.getNextExecutableStep()`; `timestamp=currentStep*stepSizeMs` |
| `purchaseUpgrade(upgradeId)` | `RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE` (`packages/core/src/command.ts:107`) | `PurchaseUpgradePayload` (`packages/core/src/command.ts:141`) | deterministic stamp as above |
| `toggleAutomation(automationId, enabled)` | `RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION` (`packages/core/src/command.ts:107`) | `ToggleAutomationPayload` (`packages/core/src/command.ts:157`) | deterministic stamp as above |
| `startTransform(transformId)` | `RUNTIME_COMMAND_TYPES.RUN_TRANSFORM` (`packages/core/src/command.ts:107`) | `RunTransformPayload` (`packages/core/src/command.ts:206`) | deterministic stamp as above |

  - **Enqueue result semantics** (Issue 750):
    - Action methods return `CommandResult` indicating whether the command was accepted into the queue (not whether it ultimately succeeded during execution).
    - Implementation MUST detect enqueue rejection by comparing `commandQueue.size` before/after (`packages/core/src/command-queue.ts:205`), returning `{ success: false, error: { code: 'COMMAND_REJECTED', ... } }` when size does not increase.
    - Execution-time failures remain observable via `IdleEngineRuntime.drainCommandFailures()` (`packages/core/src/internals.browser.ts:264`) and runtime events.
- **Auto-registration of handlers** (Issue 750):
  - `createGame` must rely on `createGameRuntime`/`wireGameRuntime` wiring to register handlers based on content presence and enablement (`packages/core/src/game-runtime-wiring.ts:90` and `packages/core/src/game-runtime-wiring.ts:130`), removing the need for downstream manual registration.
- **Documentation updates** (Issue 750):
  - Add a concise `createGame()` onboarding snippet to `docs/content-quick-reference.md` (`docs/content-quick-reference.md:1`) and cross-link to the runtime wiring section in the architecture doc (`docs/idle-engine-design.md:190`).

### 6.3 Operational Considerations
- **Deployment**: Issue 750 is a DX enhancement in `packages/core` with additive exports; no CI/CD pipeline changes are required beyond ensuring tests/linters pass.
- **Telemetry & Observability**: Issue 750 should not add new telemetry streams; it should reuse existing runtime telemetry and event bus behavior (`packages/core/src/events/event-bus.ts:46`).
- **Security & Compliance**:
  - `hydrate` should assume inputs are untrusted and rely on the existing save-format validation/migration paths implemented in the save pipeline (follow-up: consider exposing `decodeGameStateSave` to the stable surface if needed; TODO owner: Runtime Core maintainers; currently available via internals exports at `packages/core/src/internals.browser.ts:1522`).
  - The façade must not introduce host I/O, network calls, or persistence side effects; all persistence remains caller-controlled.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
Populate the table as the canonical source for downstream GitHub issues.

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(core): add createGame facade (Issue 750)` | Add `packages/core/src/game.ts` implementing `Game` + `createGame`; deterministic action-method enqueueing; `internals` escape hatch. | Runtime API Agent | Design approved | `createGame(content)` works with defaults; actions enqueue PLAYER commands with deterministic stamping; `internals` exposes `GameRuntimeWiring`. |
| `test(core): add createGame integration coverage (Issue 750)` | Add Vitest suites that validate lifecycle (`tick`), snapshots, action enqueueing, and serialize/hydrate roundtrips. | Testing Agent | `feat(core): add createGame facade (Issue 750)` | Tests cover: snapshot shape, command queue acceptance, handler registration, save/load determinism. |
| `docs: document createGame onboarding path (Issue 750)` | Update `docs/content-quick-reference.md` and any runtime integration docs to recommend `createGame`. | Docs Agent | `feat(core): add createGame facade (Issue 750)` | Docs include minimal snippet; links to `@idle-engine/core` APIs; no broken references. |
| `chore(core): update stable public surface contract (Issue 750)` | Update `packages/core/src/index.test.ts` stable export-key list and ensure `@idle-engine/core/public` remains aligned. | Integration Agent | `feat(core): add createGame facade (Issue 750)` | Public export list includes `createGame`; tests pass; exported key count remains bounded. |

### 7.2 Milestones
- **Phase 1**: Issue 750 façade implemented + stable-surface contract updated (gate: CI green on `pnpm lint` + `pnpm test --filter @idle-engine/core`).
- **Phase 2**: Issue 750 integration tests + docs updates merged (gate: docs build succeeds; examples render correctly).
- **Phase 3** (optional): Evaluate deprecation messaging for low-level wiring entrypoints in docs and/or entrypoints (gate: maintainer decision; no breaking changes without explicit migration plan).

### 7.3 Coordination Notes
- **Hand-off Package** (Issue 750):
  - Issue scope: https://github.com/hansjm10/Idle-Game-Engine/issues/750
  - Key wiring + contracts: `packages/core/src/internals.browser.ts:917`, `packages/core/src/game-runtime-wiring.ts:44`, `docs/runtime-command-queue-design.md:615`
  - Snapshot helper: `packages/core/src/progression.ts:421`
  - Stable surface contract: `packages/core/src/index.test.ts:164`
- **Communication Cadence**:
  - One PR per row in §7.1 when feasible; reviewers sign off on the public API surface before follow-up docs/tests land.
  - Escalation path: Runtime Core Maintainers resolve open questions in §13 before Phase 3 work starts.

## 8. Agent Guidance & Guardrails
- **Context Packets** (Issue 750 agents MUST preload):
  - `docs/design-document-template.md`
  - `docs/runtime-command-queue-design.md:615`
  - `packages/core/src/index.browser.ts:19` and `packages/core/src/index.test.ts:164`
  - `packages/core/src/internals.browser.ts:917`
  - `packages/core/src/game-runtime-wiring.ts:44`
  - `packages/core/src/progression.ts:421`
- **Prompting & Constraints** (canonical snippets for Issue 750 execution):
```text
You are the Runtime API Agent for Idle Engine. Implement Issue 750 by adding a stable createGame(contentPack, options?) factory in packages/core/src/game.ts.
Constraints:
- Preserve determinism: stamp commands with CommandPriority.PLAYER, step=runtime.getNextExecutableStep(), timestamp derived from simulation time.
- Do not execute commands outside tick boundaries.
- Keep the stable public surface small: only add createGame and its types to packages/core/src/index.browser.ts.
- Use type-only imports/exports where applicable and follow existing lint rules.
Validation:
- pnpm lint
- pnpm test --filter @idle-engine/core
```
- **Safety Rails**:
  - Do not edit checked-in `dist/` artifacts by hand (repo guideline).
  - Do not introduce wall-clock nondeterminism into simulation logic; any `Date.now()` use must be limited to snapshot publication metadata and never influence state mutation ordering.
  - Do not add console output in tests (Vitest LLM reporter expects machine-readable summaries).
- **Validation Hooks**:
  - `pnpm lint`
  - `pnpm test --filter @idle-engine/core`
  - `pnpm test`
  - After adding tests that affect coverage: `pnpm coverage:md` and commit `docs/coverage/index.md` (repo guideline).

## 9. Alternatives Considered
- **Docs-only onboarding**: Update `docs/` to explain `createGameRuntime` wiring without adding a façade. Rejected for Issue 750 because it leaves high cognitive load and inconsistent downstream wrappers.
- **Helper-only approach**: Add `createPlayerCommand(...)` helpers but no `Game` façade. Rejected for Issue 750 because it still requires consumers to manage lifecycle, snapshot composition, and persistence glue.
- **New package (`@idle-engine/game`)**: Create a separate package for the façade. Deferred for Issue 750 to avoid workspace/module overhead and to keep onboarding within the primary `@idle-engine/core` entrypoint.
- **Generated type-safe API from content**: Codegen `purchase<GeneratorId>()`-style methods. Rejected for Issue 750 due to complexity and because content packs are dynamic at runtime.

## 10. Testing & Validation Plan
- **Unit / Integration** (Issue 750):
  - Add a new `packages/core/src/game.test.ts` validating:
    - `createGame(content)` returns a `Game` with `internals` populated and handlers registered.
    - `purchaseGenerator(...)` enqueues a PLAYER command targeting `runtime.getNextExecutableStep()`.
    - `tick(...)` processes commands deterministically and mutates state through handlers.
    - `getSnapshot()` returns a `ProgressionSnapshot`-compatible shape (via `packages/core/src/progression.ts:421`).
    - `serialize()` → `hydrate()` roundtrip restores state and command queue.
- **Performance**:
  - Ensure façade overhead is O(1) per call; avoid per-tick allocations beyond existing snapshot building.
  - No new benchmarks required for Issue 750 unless regressions are observed (TODO owner: Runtime Core maintainers).
- **Tooling / A11y**:
  - Not applicable for Issue 750 (no UI surface), except ensuring docs render correctly in Docusaurus.

## 11. Risks & Mitigations
| Risk (Issue 750) | Impact | Mitigation |
|------------------|--------|------------|
| `createGame` grows into a “god object” | Stable surface bloats; harder to evolve | Keep façade narrow; route advanced needs to `internals`; defer additional action methods to §14. |
| Nondeterministic command ordering from timestamps | Replay/debugging drift | Derive timestamps from simulation time (pattern in `packages/core/src/automation-system.ts:1040`) and use `runtime.getNextExecutableStep()` for step stamping (`docs/runtime-command-queue-design.md:615`). |
| Confusion between `createGame` and `createGameRuntime` | Misuse of internals; inconsistent docs | Update docs to recommend `createGame` as primary onboarding; explicitly label `createGameRuntime` as advanced wiring. |
| Scheduler semantics surprise (`start`/`stop`) | Games tick too fast/slow, inconsistent across hosts | Make scheduler opt-in; default to fixed-step interval derived from `stepSizeMs`; document that manual `tick` is authoritative. |
| Save/hydrate misuse with untrusted data | Corrupt state or runtime errors | Document that `hydrate` expects validated data; consider stable-surface decode helper as follow-up (see §6.3). |

## 12. Rollout Plan
- **Milestones**:
  - Land Issue 750 façade + stable-surface contract updates in one release increment (TODO owner: Runtime Core maintainers).
  - Update docs in the same release train so onboarding guidance matches shipped API.
- **Migration Strategy**:
  - No migration required for existing integrations; `createGameRuntime` remains available.
  - New integrations should start from `createGame` and only access `internals` when necessary.
- **Communication**:
  - Add release notes and a short “Getting started” snippet to docs referencing `createGame` (TODO owner: Docs maintainers).

## 13. Open Questions
- Issue 750: Should `createGameRuntime` and `wireGameRuntime` remain in the stable public entrypoint long-term, or be documented as advanced-only (potentially moved to `@idle-engine/core/internals`)? TODO (Owner: Runtime Core maintainers).
- Issue 750: What is the canonical scheduler behavior for `start()` (fixed-step `setInterval` vs `requestAnimationFrame` + accumulator)? TODO (Owner: Runtime Core maintainers).
- Issue 750: Should action methods accept/emit `requestId` for correlating execution outcomes (`IdleEngineRuntime.drainCommandOutcomes`, `packages/core/src/internals.browser.ts:272`)? TODO (Owner: Runtime Core maintainers).
- Issue 750: Should the stable surface expose an explicit decode/encode helper for saves (currently available via internals exports at `packages/core/src/internals.browser.ts:1522`)? TODO (Owner: Runtime Core maintainers).

## 14. Follow-Up Work
- Issue 750 follow-up: add additional façade actions for common commands (`toggleGenerator`, `collectResource`, `prestigeReset`, mission decisions, entity management) mapping to `RUNTIME_COMMAND_TYPES` (`packages/core/src/command.ts:107`). TODO (Owner: Runtime API Agent; Timing: post-Phase 2).
- Issue 750 follow-up: provide a minimal “worker bridge” example that uses `createGame` + message passing (Owner: Integration Agent; Timing: after Issue 545/547 alignment).
- Issue 750 follow-up: evaluate deprecation messaging and docs cleanup for low-level wiring entrypoints (Owner: Docs Agent; Timing: Phase 3).

## 15. References
- Issue 750: https://github.com/hansjm10/Idle-Game-Engine/issues/750
- Stable public entrypoint exports: `packages/core/src/index.browser.ts:19`
- Stable-surface contract test: `packages/core/src/index.test.ts:164`
- Runtime wiring factory: `packages/core/src/internals.browser.ts:917`
- Wiring contract type: `packages/core/src/game-runtime-wiring.ts:44`
- Handler auto-registration: `packages/core/src/game-runtime-wiring.ts:130`
- UI snapshot builder: `packages/core/src/progression.ts:421`
- Snapshot type: `packages/core/src/progression.ts:279`
- Command types + priorities: `packages/core/src/command.ts:77`
- Command types + payloads: `packages/core/src/command.ts:107`
- Deterministic timestamp pattern: `packages/core/src/automation-system.ts:967`
- Command queue stamping guidance: `docs/runtime-command-queue-design.md:615`
- Layered architecture context: `docs/idle-engine-design.md:190`
- Onboarding doc to update: `docs/content-quick-reference.md:1`
- Existing wiring tests: `packages/core/src/game-runtime-wiring.test.ts:101`

## Appendix A — Glossary
- **Issue 750**: GitHub issue requesting a high-level `createGame()` factory for simplified onboarding.
- **Game**: The Issue 750 façade interface providing lifecycle, snapshots, actions, persistence, and event subscriptions.
- **GameRuntimeWiring**: A structured set of runtime internals returned by `createGameRuntime` (`packages/core/src/game-runtime-wiring.ts:44`).
- **ProgressionSnapshot**: UI-ready snapshot derived from authoritative state via `buildProgressionSnapshot` (`packages/core/src/progression.ts:421`).
- **Deterministic stamping**: Setting `priority`, `step`, and `timestamp` in a way that preserves deterministic ordering in the command queue (`docs/runtime-command-queue-design.md:589`).

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-15 | Codex (AI) | Initial draft for Issue 750. |
