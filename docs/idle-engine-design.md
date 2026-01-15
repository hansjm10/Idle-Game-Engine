# Idle Engine Design Document

## Document Control
- **Title**: Idle Engine Design Document
- **Authors**: Jordan Hans
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-15
- **Related Issues**: Idle-Game-Engine#753; Idle-Game-Engine#586
- **Execution Mode**: Hybrid

## 1. Summary
The Idle Engine is a reusable, data-driven runtime for incremental/idle games. It separates a deterministic simulation core (`packages/core`) from game-specific content packs so multiple titles can share the same engine across browser and Node-based hosts. This repository does not ship an in-repo presentation shell; consumer apps integrate via commands, state snapshots, and runtime events.

## 2. Context & Problem Statement
- **Background**: Idle games repeatedly re-implement the same core mechanics (tick loop, resource math, upgrades, persistence). This repo aims to consolidate those patterns into a shared runtime that content authors and host applications can compose.
- **Problem**: Without a shared, deterministic engine core, content authoring and balancing are brittle, simulation is hard to test/replay, and platform portability (web → desktop) requires duplicated logic.
- **Forces**:
  - Web-first execution (Worker-friendly) while keeping portability to Node/desktop hosts.
  - Determinism for offline catch-up, diagnostics, and replay-based verification.
  - Performance budgets (foreground smoothness, background throttling) and bounded memory growth.

## 3. Goals & Non-Goals
- **Goals**:
  - Deliver a shared runtime that multiple idle games can layer content on top of with minimal duplication.
  - Maintain deterministic, efficient simulations capable of running in background tabs or native hosts with minimal CPU and memory usage.
  - Provide a declarative content pipeline for defining resources, generators, upgrades, achievements, and events.
  - Support instant deployment to browsers while enabling optional native packaging with the exact same engine build.
  - Keep the core easily testable, observable, and instrumentable for analytics and A/B experimentation.
- **Non-Goals**:
  - Building a general-purpose 3D engine or real-time action framework.
  - Supporting platforms with no modern browser/WebView runtime.
  - Shipping a visual content editor in the first iteration (tracked as follow-up work).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Runtime Core maintainers; Content Pipeline maintainers; Tooling maintainers; host application integrators.
- **Agent Roles**: Docs & Design Agent; Runtime Implementation Agent; Content Pipeline Agent; Integration Agent; QA & A11y Agent.
- **Affected Packages/Services**: `packages/core`, `packages/content-schema`, `packages/content-compiler`, `packages/content-sample`, `tools/`, `packages/docs`, and `docs/`.
- **Compatibility Considerations**:
  - Content packs declare an engine compatibility range; validation gates features via `packages/content-schema/src/runtime-compat.ts`.
  - Runtime and content APIs use semantic versioning; breaking changes require explicit migration guidance and version negotiation.

## 5. Current State
- Monorepo workstreams are split across deterministic runtime (`packages/core`), content schema/compiler (`packages/content-schema`, `packages/content-compiler`), reference content (`packages/content-sample`), and tooling under `tools/`. There is no in-repo presentation shell; integrations live in downstream apps.
- Detailed subsystem proposals live in dedicated design docs (command queue, resource storage, event bus, content schema/compiler, worker bridge, economy ledger); this document is the umbrella architecture.

## 6. Proposed Solution

### 6.1 Architecture Overview
- **Narrative**: Run a deterministic simulation loop inside a Worker/Node host, apply all state mutations via queued commands and registered systems in a fixed order, publish state snapshots/deltas plus runtime events to the host, and keep game-specific behavior in validated content packs.
- **Diagram**:
  ```
  +------------------------------+
  |        Host Application      |
  | (UI, server, tooling, tests) |
  +------------------------------+
                |
                v
  +------------------------------+
  |     Runtime Integration      |
  | (createGameRuntime + bridge) |
  +------------------------------+
                |
                v
  +------------------------------+
  |         Core Runtime         |
  | - IdleEngineRuntime          |
  | - CommandQueue/Dispatcher    |
  | - EventBus + Diagnostics     |
  | - Systems (Production,       |
  |   Automation, Transform,     |
  |   Entity, Coordinator)       |
  +------------------------------+
                |
                v
  +------------------------------+
  |         Content Pack         |
  | (NormalizedContentPack)      |
  +------------------------------+
  ```

### 6.2 Detailed Design

#### Runtime Changes

##### Simulation Scheduler
- Fixed timestep (default 100 ms) with accumulators to handle real-time catch-up.
- Offline progression: on resume/load, compute elapsed time and run batched ticks with configurable caps (e.g., max 12 hours) to avoid runaway progression.
- Background throttling: detect document visibility or host signals to adjust tick frequency and reduce CPU use.
- Deterministic tick loop: accumulate elapsed host time, clamp per-frame step count, process `systems` in a fixed order for reproducible results.
- Tick pipeline executes in phases: dequeue and execute commands for the current step, then tick each registered system in order, dispatching runtime events between systems.
- Instrumentation probes (tick duration, queue backlog) surface via diagnostics interfaces for tuning.

```ts
function runTick(deltaMs: number) {
  accumulator += deltaMs;
  const steps = clamp(Math.floor(accumulator / FIXED_STEP_MS), 0, MAX_STEPS_PER_FRAME);
  accumulator -= steps * FIXED_STEP_MS;

  for (let i = 0; i < steps; i++) {
    const commands = commandQueue.dequeueUpToStep(step);
    for (const command of commands) dispatcher.execute(command);
    eventBus.dispatch({ tick: step });

    for (const system of systems) {
      system.tick({ step, deltaMs: FIXED_STEP_MS, events });
      eventBus.dispatch({ tick: step });
    }

    step += 1;
  }
}
```

##### Runtime Configuration
- The core runtime exposes an `EngineConfig` structure so per-game tuning does not require editing source constants.
- `createGame({ config })` accepts partial overrides that are merged with `DEFAULT_ENGINE_CONFIG`.
- Configuration covers precision (dirty/publish tolerances) and safety/throughput limits (transform caps, command queue sizing, condition depth guards).

```ts
import { createGame } from '@idle-engine/core';

const game = createGame(contentPack, {
  config: {
    precision: {
      dirtyEpsilonAbsolute: 1e-6,
    },
    limits: {
      maxRunsPerTick: 20,
    },
  },
});

game.start();
```

##### State Model
- Normalized resource graph: each resource has identifiers, quantity, rates, and metadata.
- Systems maintain derived state (per-second production, unlocked status).
- Use structural sharing or typed arrays for efficient snapshots; avoid deep clone churn.
- Core resources stored in struct-of-arrays layout (`resourceIds[]`, `quantities[]`, `rates[]`) for cache-friendly iteration.
- Derived views are published as read-only snapshots to avoid mutation leaks.
- Change journals collect mutations each tick so deltas can be sent to clients without serializing full state.
- Transform state tracks outstanding batches (including mission batches); entity state tracks entity counts and optional per-entity instances/assignments; PRD state is persisted for deterministic mission outcomes.

##### Systems
- **Production System** (`production-system`): applies generator production and drains resource accumulators via `resource-finalize`.
- **Automation System** (`automation-system`): evaluates automation triggers and enqueues deterministic commands.
- **Transform System** (`transform-system`): executes transforms (`instant`, `batch`, and `mission` mode). Mission transforms deploy entities, roll deterministic success (optionally PRD), and emit mission runtime events.
- **Entity System** (`entity-system`): tracks entity counts and, when `trackInstances: true`, per-instance state (levels/stats/mission assignments) with deterministic instance IDs.
- **Progression Coordinator** (`progression-coordinator`): maintains the authoritative progression state, computes derived views, and provides a `ConditionContext` used by other systems.
- Systems execute in the order they are registered by `createGameRuntime` / `wireGameRuntime` (production → finalize → automation → transforms → entities → coordinator), with runtime events dispatched between each system tick.

##### Script Hooks (Host-Provided)
- Content can reference script-backed conditions (`Condition.kind: "script"`). The core runtime expects hosts to supply deterministic evaluation hooks via the `ConditionContext` contract.
- A sandboxed in-engine scripting runtime (QuickJS/WASM, time budgets) is not implemented in `packages/core` today; treat it as potential follow-up work.

##### Persistence
- State snapshots are serialized as JSON-friendly `GameStateSaveFormat` objects (schema versioned) with migration helpers.
- Autosave scheduler (e.g., every 30 seconds, on significant events, and before unload).
- Per-title save slots keyed by content package; no cross-title sharing to avoid balance exploits.
- Hosts choose the persistence backend (IndexedDB/localStorage/filesystem); the core provides `serialize` / `hydrate` helpers via `createGameRuntime`.

#### Data & Schemas

##### Content Pipeline
- Content described via declarative TypeScript/JSON modules and compiled into normalized definitions.
- Content DSL supports: resources, entities, generators, upgrades, achievements, prestige layers, automations, transforms (including missions), and runtime event extensions.
- Support for hierarchical content packages (base game, seasonal event, micro-DLC) with dependency resolution.
- Validation tooling verifies IDs, cyclical dependencies, formula sanity, and runtime feature compatibility before shipping.
- Property-based sanitization guidance lives in [`docs/content-schema-rollout-decisions.md#property-based-formula-sanitization-guidance`](content-schema-rollout-decisions.md#property-based-formula-sanitization-guidance); run schema and CLI suites before shipping new formulas.
- Provide a CLI to bundle content, generate documentation, and run balance simulations.
- `pnpm generate` invokes `tools/content-schema-cli`, which validates every `content/pack.json` via `@idle-engine/content-schema` before refreshing runtime event manifests and compiled artifacts. The CLI emits structured JSON log events (`content_pack.validated`, `content_pack.compiled`, `content_pack.validation_failed`, `watch.run`, etc.) so automation can gate builds on failures, warnings, or drift.
- Watch and check flows are first-class: `--watch` keeps the pipeline alive after failures while surfacing iteration summaries, and `--check` exits non-zero whenever validation summaries or compiled artifacts would change. Lefthook and CI invoke `pnpm generate --check` to prevent stale outputs from landing.
- Every run persists a workspace summary at `content/compiled/index.json` (overrideable via `--summary`) that records validation and compilation status. Downstream tooling must treat the summary as stale when validation fails or the CLI reports drift; rerun `pnpm generate` to refresh artifacts before consumption.
- Authoring packs live alongside their manifests (e.g., `packages/content-sample/content/pack.json`). Keep schema warnings at zero, add missing localized variants for declared locales, and document intentional deviations so future migrations stay deterministic.
- Extendable DSL supports custom modifiers and scripted events while maintaining sandbox boundaries.
- DSL expressed as strongly typed schemas (Zod) compiled into immutable definitions; support a YAML authoring option for non-TS teams via build-time conversion.
- Each content item declares metadata (version, compatibility range), definitions, formulas (AST or limited expression strings), and unlock conditions.
- Preprocessors resolve derived values (e.g., cumulative cost curves) and emit warnings when difficulty spikes exceed configured thresholds.
- Content lints enforce naming conventions, ID uniqueness, and forbid direct references across prestige layers without explicit bridges.

#### APIs & Contracts

##### Package Entry Points
- `@idle-engine/core`: public API intended for game developers and engine integration code.
- `@idle-engine/core/public`: explicit alias for the public API (helps readability and progressive disclosure).
- `@idle-engine/core/internals`: full API surface for engine contributors and advanced tooling; no stability guarantees.
- `@idle-engine/core/prometheus`: Node-only Prometheus telemetry integration (requires `prom-client`).

##### Runtime Wiring & Integration
- `createGame(content, options?)` returns a high-level `Game` façade (lifecycle, snapshots, type-safe player actions), with an explicit `game.internals` escape hatch for advanced integrations.
- `createGameRuntime({ content, config, ... })` returns a `GameRuntimeWiring` object that groups the runtime host (`runtime`), authoritative state (`coordinator`), core command plumbing (`commandQueue`, `commandDispatcher`), enabled systems (`productionSystem`, `automationSystem`, `transformSystem`, `entitySystem`), and persistence helpers (`serialize`, `hydrate`).
- For advanced hosts (custom scheduler/event loop), use `wireGameRuntime({ runtime, coordinator, content, ... })` to attach systems and command handlers to your own `RuntimeWiringRuntime` implementation.

##### Host Integration Contracts
- Hosts enqueue player/system commands into the command queue; the runtime drains and executes commands at deterministic steps before ticking systems.
- Hosts can subscribe to runtime events (for example `mission:*` events) via system `setup` subscriptions or by accessing the runtime event bus.
- For networked play, snapshot/restore, or divergence debugging, use the state-sync helpers under `packages/core/src/state-sync/` (see `docs/state-synchronization-protocol-design.md`).

#### Tooling & Automation

##### Performance Strategy
- Run simulation in a Web Worker with transferable state buffers to avoid main thread jank.
- Use data-oriented structures (typed arrays, struct-of-arrays) for high-frequency calculations.
- Memoize derived stats and recompute lazily when source data changes.
- Profile with browser tools and Node benchmarks; escalate hotspots to WebAssembly implementations when ROI is justified.

##### Tooling & Developer Experience
- Monorepo using pnpm: `packages/core`, `packages/content-*`, `tools/`.
- Shared type definitions and schema validation via Zod or similar.
- CLI tools for content linting, simulation playback, save migration testing.
- Storybook or component library for UI kit review.

### 6.3 Operational Considerations
- **Deployment**:
  - Browser build bundles runtime + content and serves via CDN; service workers support offline caching.
  - Desktop build packages web artifacts with Tauri/Electron and leverages native filesystem APIs for saves and optional integrations.
  - Continuous delivery runs tests, bundles content, and publishes npm packages for runtime/tools.
- **Telemetry & Observability**:
  - Provide opt-in telemetry hooks (events, state snapshots) sent via `fetch`/beacon or native channels.
  - Ensure privacy compliance and keep PII out of default payloads.
  - Allow games to register custom metrics via shared instrumentation APIs.
- **Security & Compliance**:
  - Sandbox third-party scripts to prevent DOM or host access.
  - Validate content bundles before loading to avoid malicious overrides.
  - Harden save loading with schema validation to avoid corrupted states.
  - Rotate API secrets regularly, store them in Vault/Secrets Manager, and audit access logs.

## 7. Work Tracking & Delivery Plan

Implementation work is tracked in GitHub issues and `docs/plans/`. This design document intentionally avoids week-based estimates; keep it focused on architecture and contracts.

### 7.1 Active Issues
| Issue | Scope |
| --- | --- |
| #753 | Documentation drift and alignment work |
| #586 | Entity + Mission system follow-ups |

### 7.2 Coordination Notes
- **Hand-off Package**: Agents should preload this doc and the subsystem specs in `docs/` referenced in §15.
- **Communication Cadence**: One PR per cohesive contract change; reviewers sign off on design contracts before implementation proceeds to dependent slices.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Read: `docs/design-document-template.md`, `docs/idle-engine-design.md`, `docs/implementation-plan.md`.
  - For runtime work: `docs/runtime-command-queue-design.md`, `docs/resource-state-storage-design.md`, `docs/runtime-event-pubsub-design.md`.
  - For content work: `docs/content-dsl-schema-design.md`, `docs/content-compiler-design.md`, `docs/content-validation-cli-design.md`.
- **Prompting & Constraints**:
  - Keep simulations deterministic: no wall-clock reads inside core logic without a provided clock abstraction.
  - Prefer pure functions and stable iteration order (sort inputs, avoid `Object` key-order dependence).
  - Use type-only imports/exports (`import type`, `export type`) and follow workspace lint rules.
  - Do not edit checked-in `dist/` outputs by hand; regenerate via the build pipeline if needed.
- **Safety Rails**:
  - Do not rewrite git history (`reset --hard`, force-push) unless explicitly instructed by a human maintainer.
  - Treat any auth/token material as secrets; never commit credentials or real user data.
  - Avoid console noise during test runs that could corrupt machine-readable summaries.
- **Validation Hooks**:
  - `pnpm lint` and `pnpm test` for all changes; `pnpm test --filter <package>` while iterating.
  - `pnpm generate --check` after content or schema changes.

## 9. Alternatives Considered
- **Single-repo, per-game bespoke engine**: faster iteration per title, but multiplies bugs and blocks shared tooling.
- **Server-authoritative full simulation**: simplifies anti-cheat for all resources but increases infra cost and breaks offline-first goals.
- **Runtime in a systems language only (Rust/Zig)**: improves performance and sandboxing but raises contributor friction; reserve for hotspots after profiling.
- **Unvalidated “content as code”**: flexible but increases runtime risk; schema + compiler provides deterministic guarantees and tooling hooks.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Unit tests for tick calculations, formula evaluation, state reducers, and determinism invariants.
  - Integration tests running full simulations for offline progression scenarios and save/load migrations.
  - Snapshot tests for content definitions and compiled artifacts to catch accidental drift.
  - Contract tests for offline/online reconciliation.
- **Performance**:
  - Browser and Node benchmarks for tick budget adherence; validate Worker isolation.
  - Memory profiling for state growth and snapshot costs.
- **Tooling / A11y**:

## 11. Risks & Mitigations
- **Determinism drift**: Centralize clocks/RNG; add property-based tests and replay harnesses.
- **Performance regressions**: Keep hot paths in SoA buffers; profile before optimizing; gate expensive features behind flags.
- **Content pipeline complexity**: Enforce `pnpm generate --check`, keep logs structured, and document upgrade paths in design docs.
- **Security of extensibility**: Sandbox script hooks; validate packs.

## 12. Rollout Plan
- **Milestones**: Ship prototype slices behind feature flags; expand surfaces only after determinism + diagnostics are stable.
- **Migration Strategy**: Version runtime APIs and content schema; add migration utilities for save formats and pack normalization.
- **Communication**: Link PRs to issue-map rows and update Appendix B; keep `docs/implementation-plan.md` synced when priorities change.

## 13. Open Questions
- How do we expose extensibility to partners while preserving engine stability (module vetting, version caps)?
- Which telemetry thresholds or machine-learning models will we standardize on for automated cheat detection escalation?

## 14. Follow-Up Work
- Wire the DSL compiler to emit schema-aligned packs instead of hand-authored TypeScript.
- Port legacy sample data into the CLI format.
- Extend CI so schema warnings fail builds once the broader content library lands.
- Add a formal compatibility/migration playbook for runtime API breaks.

## 15. References
- `docs/implementation-plan.md`
- `docs/runtime-command-queue-design.md`
- `docs/resource-state-storage-design.md`
- `docs/runtime-event-pubsub-design.md`
- `docs/tick-accumulator-coverage-design.md`
- `docs/content-dsl-schema-design.md`
- `docs/content-compiler-design.md`
- `docs/content-validation-cli-design.md`

## Appendix A — Glossary
- **Soft progression**: Client-authoritative simulation state (resources, upgrades, automation) managed deterministically by the runtime.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-14 | Idle Engine Docs Agent | Migrate `docs/idle-engine-design.md` onto the standard design template (Fixes #197). |
