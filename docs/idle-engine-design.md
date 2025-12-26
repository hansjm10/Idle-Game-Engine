# Idle Engine Design Document

## Document Control
- **Title**: Idle Engine Design Document
- **Authors**: Jordan Hans
- **Reviewers**: TODO (Runtime Core, Content Pipeline, Shell, Social maintainers)
- **Status**: Draft
- **Last Updated**: 2025-12-14
- **Related Issues**: Idle-Game-Engine#197; Idle-Game-Engine#6; Idle-Game-Engine#11; Idle-Game-Engine#159; Idle-Game-Engine#399 (GEL-001); Idle-Game-Engine#408
- **Execution Mode**: Hybrid

## 1. Summary
The Idle Engine is a reusable, data-driven runtime for incremental/idle games. It separates a deterministic simulation core (`packages/core`) from game-specific content packs and presentation shells so multiple titles can share the same engine while remaining portable across web and desktop wrappers.

## 2. Context & Problem Statement
- **Background**: Idle games repeatedly re-implement the same core mechanics (tick loop, resource math, upgrades, persistence). This repo aims to consolidate those patterns into a shared runtime that content authors and shells can compose.
- **Problem**: Without a shared, deterministic engine core, content authoring and balancing are brittle, simulation is hard to test/replay, and platform portability (web → desktop) requires duplicated logic.
- **Forces**:
  - Web-first execution (Worker-friendly) while keeping portability to Node/desktop shells.
  - Determinism for offline catch-up, diagnostics, and replay-based verification.
  - Performance budgets (foreground smoothness, background throttling) and bounded memory growth.
  - Optional social features (leaderboards, guilds) must not compromise local simulation correctness.
  - Authentication uses OpenID Connect; baseline deployment uses self-hosted Keycloak (or Ory Hydra/Kratos), and tokens remain compatible with managed OIDC providers.

## 3. Goals & Non-Goals
- **Goals**:
  - Deliver a shared runtime that multiple idle games can layer content on top of with minimal duplication.
  - Maintain deterministic, efficient simulations capable of running in background tabs or native shells with minimal CPU and memory usage.
  - Provide a declarative content pipeline for defining resources, generators, upgrades, achievements, and events.
  - Support instant deployment to browsers while enabling optional native packaging with the exact same engine build.
  - Keep the core easily testable, observable, and instrumentable for analytics and A/B experimentation.
  - Stabilise shared/global economy via a server-authoritative ledger and economic invariants as defined in `docs/global-economy-ledger-design.md` (initiative `GEL-001`).
- **Non-Goals**:
  - Building a general-purpose 3D engine or real-time action framework.
  - Supporting platforms with no modern browser/WebView runtime.
  - Shipping a visual content editor in the first iteration (tracked as follow-up work).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Runtime Core maintainers; Content Pipeline maintainers; Shell maintainers; Social services maintainers; partner integrators.
- **Agent Roles**: Docs & Design Agent; Runtime Implementation Agent; Content Pipeline Agent; Shell Integration Agent; Social Services Agent; QA & A11y Agent.
- **Affected Packages/Services**: `packages/core`, `packages/content-schema`, `packages/content-sample`, `services/social`, `tools/`, and `docs/` (presentation shells are archived).
- **Compatibility Considerations**:
  - Content packs declare an engine compatibility range; validation gates features via `packages/content-schema/src/runtime-compat.ts`.
  - Runtime and content APIs use semantic versioning; breaking changes require explicit migration guidance and version negotiation.

## 5. Current State
- Monorepo workstreams are split across deterministic runtime (`packages/core`), reference content (`packages/content-sample`), and backend experiments (`services/social`). Presentation shells are archived and removed from the active workspace.
- Detailed subsystem proposals live in dedicated design docs (command queue, resource storage, event bus, content schema/compiler, worker bridge, economy ledger); this document is the umbrella architecture.

## 6. Proposed Solution

### 6.1 Architecture Overview
- **Narrative**: Run a deterministic simulation loop inside a Worker/Node host, apply all state mutations via commands and systems in a fixed order, publish snapshots/deltas to a presentation shell, and keep game-specific behavior in validated content packs. Social systems remain optional and integrate through explicit APIs and reconciliation rules.
- **Diagram**:
  ```
  +------------------------------+
  |          Presentation        |
  | (Web UI, Native Shell UI)    |
  +------------------------------+
                |
                v
  +------------------------------+
  |      Engine Integration      |
  |  (Runtime Adapter, IPC/API)  |
  +------------------------------+
                |
                v
  +------------------------------+
  |         Core Runtime         |
  |  - Simulation Scheduler      |
  |  - State Graph               |
  |  - Systems (Progression,     |
  |    Automation, Events)       |
  +------------------------------+
                |
                v
  +------------------------------+
  |       Content Modules        |
  | (Game-specific data + rules) |
  +------------------------------+
                |
                v
  +------------------------------+
  |     Social/Cloud Services    |
  |  (Leaderboards, Guild APIs)  |
  +------------------------------+
  ```

### 6.2 Detailed Design

#### Runtime Changes

##### Simulation Scheduler
- Fixed timestep (default 100 ms) with accumulators to handle real-time catch-up.
- Offline progression: on resume/load, compute elapsed time and run batched ticks with configurable caps (e.g., max 12 hours) to avoid runaway progression.
- Background throttling: detect document visibility or shell signals to adjust tick frequency and reduce CPU use.
- Deterministic tick loop: accumulate elapsed host time, clamp per-frame step count, process `systems` in a fixed order for reproducible results.
- Tick pipeline executes in phases (input intents, automation, production, progression, events) with hooks so content modules can subscribe without reordering core systems.
- Instrumentation probes (tick duration, queue backlog) surface via diagnostics interfaces for tuning.

```ts
function runTick(deltaMs: number) {
  accumulator += deltaMs;
  const steps = clamp(Math.floor(accumulator / FIXED_STEP_MS), 0, MAX_STEPS_PER_FRAME);
  accumulator -= steps * FIXED_STEP_MS;

  for (let i = 0; i < steps; i++) {
    applyQueuedCommands();
    automationSystem.tick();
    productionSystem.tick();
    progressionSystem.tick();
    eventSystem.tick();
    telemetry.recordTick();
  }
}
```

##### State Model
- Normalized resource graph: each resource has identifiers, quantity, rates, and metadata.
- Systems maintain derived state (per-second production, unlocked status).
- Use structural sharing or typed arrays for efficient snapshots; avoid deep clone churn.
- Core entities stored in struct-of-arrays layout (`resourceIds[]`, `quantities[]`, `rates[]`) for cache-friendly iteration.
- Derived views are published as read-only snapshots to avoid mutation leaks.
- Change journals collect mutations each tick so deltas can be sent to clients without serializing full state.

##### Systems
- **Production System**: processes generators, cost reductions, and automation toggles.
- **Upgrade System**: resolves prerequisites and applies modifiers (additive, multiplicative, exponential) via composable formula pipelines.
- **Prestige System**: manages layer resets with carry-over rewards.
- **Event System**: publishes domain events (thresholds met, unlocks) for UI/telemetry.
- **Task Scheduler**: handles time-based tasks (quests, research timers) with pause/resume semantics.
- **Social System**: interfaces with leaderboard and guild services, queues outbound intents, applies confirmed updates, and reconciles conflicts on reconnect.
- Systems register deterministic execution order and optional dependencies; the engine validates order at startup to prevent circular hooks.
- Modifiers are expressed as pure functions operating on typed contexts (`ResourceCtx`, `GeneratorCtx`) to preserve testability.

##### Script Hooks
- Script layer exposes deterministic APIs (no direct async). Hooks run inside simulation steps for predictable results.
- Optional sandbox (QuickJS/WASM) supports third-party content without compromising the core runtime.
- Script host provides whitelisted math/util modules and deterministic random via seeded RNG per save.
- Hooks execute within a time budget; overruns generate diagnostics and can be killed to preserve tick cadence.

##### Persistence
- State snapshots serialized to binary (MessagePack or custom) to minimize size.
- Versioned schema with migration pipeline to ensure backward compatibility.
- Autosave scheduler (e.g., every 30 seconds, on significant events, and before unload).
- Per-title save slots keyed by content package; no cross-title sharing to avoid balance exploits.
- Browser shells use IndexedDB/localStorage; native wrappers use filesystem APIs.

##### Social Services Integration
- Provide REST/gRPC client wrappers for leaderboard submissions, guild roster updates, messaging, and reward claims.
- Support optimistic UI updates with eventual server confirmation; roll back state when server rejects a change.
- Enforce rate limiting, authentication tokens, and replay protection to deter cheating.
- Offer abstractions so implementations can swap between in-house services and third-party platforms without touching game logic.
- Ship a reference self-host service (Node/Rust) with deployment scripts and clearly defined interfaces for alternative providers.
- For global economy stability and hard-currency invariants, rely on a server-authoritative ledger and economy APIs as specified in `docs/global-economy-ledger-design.md` (initiative `GEL-001`).

###### Economy Model (GEL-001)
- Hard vs soft split: **hard currencies** are server-authoritative and only mutate through validated social service operations; **soft progression** (local resources, upgrades, automation) stays client-authoritative and deterministic inside the runtime.
- Ledger ownership: the social service maintains the canonical ledger for all hard currencies (balances, transactions, guild contributions) and enforces invariants such as no overspend, bounded earn rates, and authenticated identities.
- Client/server cooperation: clients can render optimistic UI for spends/transfers but reconcile using authoritative ledger responses; discrepancies clamp to server values and can trigger anomaly flags.
- Verification: when needed, the social service can perform deterministic replay using the runtime under Node to bound-check suspicious claims without running a continuous server-side simulation.
- Navigation: see `docs/global-economy-ledger-design.md` (`GEL-001`) for API shapes, invariants, replay workflow, and delivery plan.

##### Authentication & Integrity Controls
- Self-hosted Keycloak issues short-lived JWT access tokens and rotation-backed refresh tokens; clients authenticate via email magic link or device key exchange.
- Engine SDK signs every social mutation with the current token and device fingerprint; backend validates signature, token scope, and rate limits per identity/device/IP.
- Server derives authoritative leaderboard scores (never trusts raw client totals) and clamps suspicious deltas before persistence.
- Telemetry pipeline feeds anomaly detection (baseline heuristics + configurable z-score rules) that can flag or quarantine accounts automatically.
- Adapter interfaces accept any OIDC-compliant IdP so partners can switch to managed providers (Auth0, Cognito, etc.) without changing client code.

#### Data & Schemas

##### Content Pipeline
- Content described via declarative TypeScript/JSON modules and compiled into normalized definitions.
- Content DSL supports: resources, generators, transforms, upgrades, milestones/achievements, prestige layers, automations, runtime event extensions, and guild perks.
- Support for hierarchical content packages (base game, seasonal event, micro-DLC) with dependency resolution.
- Validation tooling verifies IDs, cyclical dependencies, formula sanity, and runtime feature compatibility before shipping.
- Property-based sanitization guidance lives in [`docs/content-schema-rollout-decisions.md#property-based-formula-sanitization-guidance`](content-schema-rollout-decisions.md#property-based-formula-sanitization-guidance); run schema and CLI suites before shipping new formulas.
- Provide a CLI to bundle content, generate documentation, and run balance simulations.
- `pnpm generate` invokes `tools/content-schema-cli`, which validates every `content/pack.json` via `@idle-engine/content-schema` before refreshing runtime event manifests and compiled artifacts. The CLI emits structured JSON log events (`content_pack.validated`, `content_pack.compiled`, `content_pack.validation_failed`, `watch.run`, etc.) so automation can gate builds on failures, warnings, or drift.
- Watch and check flows are first-class: `--watch` keeps the pipeline alive after failures while surfacing iteration summaries, and `--check` exits non-zero whenever validation summaries or compiled artifacts would change. Lefthook and CI invoke `pnpm generate --check` to prevent stale outputs from landing.
- Every run persists a workspace summary at `content/compiled/index.json` (overrideable via `--summary`) that records validation and compilation status. Downstream tooling must treat the summary as stale when validation fails or the CLI reports drift; rerun `pnpm generate` to refresh artifacts before consumption.
- Authoring packs live alongside their manifests (e.g., `packages/content-sample/content/pack.json`). Keep schema warnings at zero, add missing localized variants for declared locales, and document intentional deviations so future migrations stay deterministic.
- Extendable DSL supports custom modifiers, scripted events, and guild-related hooks while maintaining sandbox boundaries.
- DSL expressed as strongly typed schemas (Zod) compiled into immutable definitions; support a YAML authoring option for non-TS teams via build-time conversion.
- Each content item declares metadata (version, compatibility range), definitions, formulas (AST or limited expression strings), and unlock conditions.
- Preprocessors resolve derived values (e.g., cumulative cost curves) and emit warnings when difficulty spikes exceed configured thresholds.
- Content lints enforce naming conventions, ID uniqueness, and forbid direct references across prestige layers without explicit bridges.

#### APIs & Contracts

##### Presentation Layer Contracts
- Runtime sends UI-ready snapshots through a state channel; UI sends user intents (purchase upgrade, toggle automation) via a command channel.
- Presentation shells choose framework (React/Svelte/plain DOM); the engine depends only on the contract.
- Desktop wrappers use the same contract through IPC between WebView and Node hosts.
- Provide a default UI kit (resource panels, upgrade lists, modals) for rapid prototyping while allowing custom skins.

#### Tooling & Automation

##### Performance Strategy
- Run simulation in a Web Worker with transferable state buffers to avoid main thread jank.
- Use data-oriented structures (typed arrays, struct-of-arrays) for high-frequency calculations.
- Memoize derived stats and recompute lazily when source data changes.
- Profile with browser tools and Node benchmarks; escalate hotspots to WebAssembly implementations when ROI is justified.

##### Tooling & Developer Experience
- Monorepo using pnpm: `packages/core`, `packages/content-*`, `services/social`, `tools/`.
- Shared type definitions and schema validation via Zod or similar.
- CLI tools for content linting, simulation playback, save migration testing.
- Storybook or component library for UI kit review.

### 6.3 Operational Considerations
- **Deployment**:
  - Browser build bundles runtime + content and serves via CDN; service workers support offline caching.
  - Desktop build packages web artifacts with Tauri/Electron and leverages native filesystem APIs for saves and optional integrations.
  - Continuous delivery runs tests, bundles content, and publishes npm packages for runtime/tools.
  - Social services deploy independently and use feature flags for staged rollouts.
- **Telemetry & Observability**:
  - Provide opt-in telemetry hooks (events, state snapshots) sent via `fetch`/beacon or native channels.
  - Ensure privacy compliance and keep PII out of default payloads.
  - Allow games to register custom metrics via shared instrumentation APIs.
- **Security & Compliance**:
  - Sandbox third-party scripts to prevent DOM or host access.
  - Validate content bundles before loading to avoid malicious overrides.
  - Harden save loading with schema validation to avoid corrupted states.
  - Rotate API secrets regularly, store them in Vault/Secrets Manager, and audit access logs.
  - Provide moderation tooling to ban or shadowban users flagged by integrity rules, and support rapid leaderboard purges.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| docs: migrate Idle Engine Design to template (#197) | Convert this doc to the standard template and refresh cross-links | Docs & Design Agent | None | Doc follows template headings; issue map + guardrails added; references updated |
| feat(core): deterministic command queue (#6) | Ensure all state mutations flow through a replayable command queue | Runtime Implementation Agent | Engine design aligned | Unit tests for ordering/replay; docs updated; no nondeterministic sources |
| feat(core): struct-of-arrays resource storage (#7) | Implement cache-friendly resource buffers and snapshot publishing | Runtime Implementation Agent | Command queue | Resource state tests; snapshot/delta API consumed by shell |
| feat(core): runtime event pub/sub (#8) | Deterministic event bus for cross-system signalling | Runtime Implementation Agent | Command queue | Event ordering tests; event frames exportable to shells/telemetry |
| feat(core): diagnostic timeline instrumentation (#9) | Per-tick phase timing + queue pressure snapshots | Runtime + QA Agent | Scheduler + queue | Timeline available via diagnostics; tests cover backlog & segments |
| feat(core): tick accumulator edge-case coverage (#10) | Clamp/drift/backlog tests for fixed-step scheduler | QA Agent | Scheduler implementation | Tests validate backlog telemetry and drift tolerance |
| feat(content): content DSL schema contract (#11) | Zod schemas + normalization for content packs | Content Pipeline Agent | Engine goals agreed | Schema tests; CLI validation gates packs; docs link |
| feat(content): deterministic content compiler (#159) | Compile packs into reproducible artifacts consumed by runtime | Content Pipeline Agent | Schema contract | `pnpm generate --check` stable; generated artifacts committed; smoke tests |
| feat(design): global economy ledger initiative (GEL-001) (#399) | Define ledger invariants + replay verification strategy | Social Services + Docs Agent | Auth model | Ledger APIs documented; invariants enforced; references in engine design |
| chore(docs): document economy model in engine design (#408) | Hard/soft currency split and glossary | Docs Agent | GEL-001 | Updated design section + glossary entries; links current |

### 7.2 Milestones
- **Prototype Milestone (8 weeks)**: Deliver a vertical slice proving the engine loop, content DSL, and social scaffolding.
  - **Deliverables**:
    - `packages/core`: runnable runtime with scheduler, resource system, upgrade processor, save/load (stub), diagnostics.
    - Presentation shells (archived): UI consumers of runtime snapshots and commands.
    - `packages/content-sample`: reference game pack with ~10 resources, 6 generators, basic prestige layer, and sample guild perks.
    - `services/social`: self-hosted API providing stubbed leaderboard/guild endpoints with Keycloak integration.
    - CI pipeline executing unit/integration tests and content validation (`pnpm generate --check`).
  - **Sequencing**:
    1. Foundation (Week 1-2): monorepo tooling, scheduler skeleton, resource structures, command bus.
    2. Content & DSL (Week 2-4): schema, compiler, sample content pack, validation CLI.
    3. Presentation Adapter (Week 3-5): Worker runtime integration, delta subscription, basic UI kit.
    4. Persistence & Offline (Week 4-6): save/load, offline catch-up logic, autosave timers, smoke tests.
    5. Social Stub (Week 5-7): Keycloak bootstrap, social API, token validation in SDK, stub leaderboard UI.
    6. Hardening (Week 7-8): profiling, coverage targets, docs/runbooks, milestone demo.
  - **Success Criteria**:
    - Reference game runs at 60 ticks/sec in browser foreground with under 30% main-thread utilization on target hardware.
    - Offline catch-up simulates up to 12 hours without divergence from continuous-play baselines.
    - Leaderboard submissions authenticated via Keycloak and shown in UI (stubbed data acceptable).
    - Content CLI blocks invalid definitions and outputs human-friendly diagnostics.
    - CI green (lint/test/generate).

### 7.3 Coordination Notes
- **Hand-off Package**: Agents should preload this doc, `docs/implementation-plan.md`, and the subsystem specs in `docs/` referenced in §15.
- **Communication Cadence**: One PR per issue-map row; reviewers sign off on design contracts before implementation proceeds to dependent slices.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Read: `docs/design-document-template.md`, `docs/idle-engine-design.md`, `docs/implementation-plan.md`.
  - For runtime work: `docs/runtime-command-queue-design.md`, `docs/resource-state-storage-design.md`, `docs/runtime-event-pubsub-design.md`.
  - For content work: `docs/content-dsl-schema-design.md`, `docs/content-compiler-design.md`, `docs/content-validation-cli-design.md`.
  - For social/economy work: `docs/global-economy-ledger-design.md`.
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
  - Contract tests for leaderboard submissions, guild workflows, and offline/online reconciliation.
- **Performance**:
  - Browser and Node benchmarks for tick budget adherence; validate Worker isolation.
  - Memory profiling for state growth and snapshot costs.
- **Tooling / A11y**:

## 11. Risks & Mitigations
- **Determinism drift**: Centralize clocks/RNG; add property-based tests and replay harnesses.
- **Performance regressions**: Keep hot paths in SoA buffers; profile before optimizing; gate expensive features behind flags.
- **Content pipeline complexity**: Enforce `pnpm generate --check`, keep logs structured, and document upgrade paths in design docs.
- **Security of extensibility**: Sandbox script hooks; validate packs; treat social mutations as server-authoritative where required.

## 12. Rollout Plan
- **Milestones**: Ship prototype slices behind feature flags; expand surfaces only after determinism + diagnostics are stable.
- **Migration Strategy**: Version runtime APIs and content schema; add migration utilities for save formats and pack normalization.
- **Communication**: Link PRs to issue-map rows and update Appendix B; keep `docs/implementation-plan.md` synced when priorities change.

## 13. Open Questions
- How do we expose extensibility to partners while preserving engine stability (module vetting, version caps)?
- Which managed providers should we validate adapters against, and what migration tooling do partners need?
- Which telemetry thresholds or machine-learning models will we standardize on for automated cheat detection escalation?

## 14. Follow-Up Work
- Wire the DSL compiler to emit schema-aligned packs instead of hand-authored TypeScript.
- Port legacy sample data into the CLI format.
- Extend CI so schema warnings fail builds once the broader content library lands.
- TODO: Add a formal compatibility/migration playbook for runtime API breaks.

## 15. References
- `docs/implementation-plan.md`
- `docs/runtime-command-queue-design.md`
- `docs/resource-state-storage-design.md`
- `docs/runtime-event-pubsub-design.md`
- `docs/tick-accumulator-coverage-design.md`
- `docs/content-dsl-schema-design.md`
- `docs/content-compiler-design.md`
- `docs/content-validation-cli-design.md`
- `docs/global-economy-ledger-design.md`

## Appendix A — Glossary
- **Hard currency**: Server-authoritative currency recorded in the global ledger; mutations only occur through authenticated social service operations that enforce invariants (no overspend, bounded earns).
- **Soft progression**: Client-authoritative simulation state (resources, upgrades, automation) managed deterministically by the runtime; reconciles only on sync boundaries where hard currency balances are authoritative.
- **Server-authoritative ledger**: Social service subsystem that maintains canonical balances and transaction history for hard currencies, powers leaderboards/guild contributions, and is documented in `docs/global-economy-ledger-design.md`.
- **Optimistic UI + reconciliation**: Client may show provisional spend/transfer results but must apply server responses to clamp balances to ledger truth and surface rejection metadata.
- **Deterministic replay verification**: Optional server-side check that replays a bounded segment of simulation using the runtime (Node) to validate suspicious economic claims without running continuous server-side simulation.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2025-12-14 | Idle Engine Docs Agent | Migrate `docs/idle-engine-design.md` onto the standard design template (Fixes #197). |
