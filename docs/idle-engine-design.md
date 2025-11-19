# Idle Engine Design Document

## 1. Overview
The Idle Engine is a reusable, data-driven runtime tailored for incremental/idle games. It separates optimized simulation services from game-specific content so that multiple titles can wrap the same core engine. The architecture targets a web-first execution environment while keeping the runtime portable to desktop shells (Electron/Tauri) without rewriting logic.

## 2. Goals
- Deliver a shared runtime that multiple idle games can layer content on top of with minimal duplication.
- Maintain deterministic, efficient simulations capable of running in background tabs or native shells with minimal CPU and memory usage.
- Provide a declarative content pipeline for defining resources, generators, upgrades, achievements, and events.
- Support instant deployment to browsers while enabling optional native packaging with the exact same engine build.
- Keep the core easily testable, observable, and instrumentable for analytics and A/B experimentation.
- Stabilise shared/global economy via a server-authoritative ledger and economic invariants as defined in `docs/global-economy-ledger-design.md` (initiative `GEL-001`).

## 3. Non-Goals
- Building a general-purpose 3D engine or real-time action framework.
- Supporting platforms with no modern browser/WebView runtime.
- Shipping a visual content editor in the first iteration (can be roadmap work).

- Primary runtime language is TypeScript targeting modern browsers; heavy math/automation can move into WebAssembly modules (Rust/Zig) if profiling warrants it.
- Single-threaded determinism is sufficient for core simulation; concurrency is limited to Web Workers for isolation.
- Persistence leverages IndexedDB/localStorage in browser shells and filesystem APIs in native wrappers.
- Network services (leaderboards, guild coordination) are optional for core loop but must be reachable when social features are in use.
- Default deployment self-hosts social services, with adapter interface enabling migration to managed platforms when required.
- Authentication built on OpenID Connect; baseline deployment uses self-hosted Keycloak (or Ory Hydra/Kratos), and tokens remain compatible with managed OIDC providers.

## 5. Use Cases
- Wrap the engine with different content modules to create new idle games quickly.
- Patch content live without redeploying the runtime (configuration-driven events, seasonal content).
- Run automated simulations for balance verification and analytics inside Node.js.
- Package the engine with a native shell for offline desktop distribution or stores requiring binaries.

## 6. Functional Requirements
- Data-driven definition of: resources, generators, transforms, upgrades, milestones/achievements, prestige/reset layers.
- Deterministic tick scheduler with support for fixed-step and adaptive catch-up (offline progress credit).
- Event system for triggers (resource thresholds, time, scripted conditions).
- Save/load with versioned schemas and forward-compatible migrations; saves scoped per title with no cross-game import.
- UI integration layer exposing state snapshots and delta streams for rendering frameworks (React/Svelte/etc.).
- Instrumentation hooks (metrics/events) for analytics.
- Social layer services: leaderboards (global, guild) and guild roster/state management with server synchronization APIs.

## 7. Non-Functional Requirements
- Idle tick loop must sustain 60 ticks/sec in foreground and efficient low-frequency batching in background.<br />
- Engine memory footprint under ~5 MB for moderate content sets; no unbounded data growth.
- State serialization/deserialization under 10 ms for typical saves.
- Content module API stable across game releases; breaking changes require version negotiation.
- Social services must tolerate intermittent connectivity and reconcile state when clients reconnect.
- Test automation coverage for tick math, offline progression, prestige resets, migrations, and leaderboard/guild flows.

## 8. Architecture Overview
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
The runtime executes inside a Web Worker (browser) or dedicated thread (Node/native). Presentation layers communicate via a message channel (postMessage or IPC). Content modules register definitions at initialization and inject custom logic via well-scoped callbacks.
Social features interact with self-hosted backend services by default through the integration layer, which handles secure API calls, caching, and reconciliation. Adapter boundaries allow swapping to managed providers without engine rewrites.

## 9. Core Runtime Design
### 9.1 Simulation Scheduler
- Fixed timestep (default 100 ms) with accumulators to handle real-time catch-up.
- Offline progression: on resume/load, compute elapsed time and run batched ticks with configurable caps (eg. max 12 hours) to avoid runaway progression.
- Background throttling: detect document visibility or shell signals to adjust tick frequency and reduce CPU use.
- Scheduler implemented as a deterministic loop: accumulate elapsed real time, clamp per-frame step count, process `systems` in a fixed order for deterministic results.
- Tick pipeline executes in phases (input intents, automation, production, progression, events) with hooks so content modules can subscribe without reordering core systems.
- Provide instrumentation probes (tick duration, queue backlog) surfaced via diagnostics interface for tuning.

#### 9.1.1 Tick Pseudocode
```ts
function runTick(deltaMs) {
  accumulator += deltaMs;
  const steps = clamp(floor(accumulator / FIXED_STEP_MS), 0, MAX_STEPS_PER_FRAME);
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

### 9.2 State Model
- Normalized resource graph: each resource has identifiers, quantity, rate, metadata.
- Systems maintain derived state (per second production, unlocked status).
- Use structural sharing or typed arrays for efficient snapshots; avoid deep clone churn.
- Core entities stored in struct-of-arrays layout (`resourceIds[]`, `quantities[]`, `rates[]`) for cache-friendly iteration.
- Derived views published as read-only proxies to presentation layer to avoid mutation leaks.
- Change journal collects mutations each tick so deltas can be sent to clients without serializing full state.

### 9.3 Systems
- **Production System**: processes generators, cost reductions, automation toggles.
- **Upgrade System**: resolves prerequisites, applies modifiers (additive, multiplicative, exponential) via composable formula pipelines.
- **Prestige System**: manages layer resets with carry-over rewards.
- **Event System**: publishes domain events (e.g., thresholds met) for UI/analytics.
- **Task Scheduler**: handles time-based tasks (quests, research timers) with pause/resume semantics.
- **Social System**: interfaces with leaderboard and guild services, queues outbound intents, applies confirmed updates, and reconciles conflicts on reconnect.
- Systems register deterministic execution order and optional dependencies; engine validates order at startup to prevent circular hooks.
- Modifiers expressed as pure functions operating on typed contexts (`ResourceCtx`, `GeneratorCtx`) to preserve testability.

### 9.4 Script Hooks
- Script layer exposes deterministic APIs (no direct async). Hooks run inside simulation step for predictable results.
- Optional sandbox (QuickJS/WASM) for third-party content without compromising core runtime.
- Script host provides whitelisted math/util modules and deterministic random via seeded RNG per save.
- Hooks execute within time budget; overruns generate diagnostics and can be killed to preserve tick cadence.

### 9.5 Persistence
- State snapshots serialized to binary (MessagePack or custom) to minimize size.
- Versioned schema with migration pipeline to ensure backward compatibility.
- Autosave scheduler (e.g., every 30 seconds, on significant events, and before unload).
- Per-title save slots keyed by content package; no cross-title sharing to avoid balance exploits.

### 9.6 Social Services Integration
- Provide REST/gRPC client wrappers for leaderboard submissions, guild roster updates, messaging, and reward claims.
- Support optimistic UI updates with eventual server confirmation; roll back state when server rejects a change.
- Enforce rate limiting, authentication tokens, and replay protection to deter cheating.
- Offer abstraction so implementations can swap between in-house services and third-party platforms without touching game logic.
- Ship a reference self-host service (e.g., Node/Rust) with deployment scripts (Docker/Kubernetes) and clearly defined interfaces for alternative providers.
- Document data schemas and synchronization contracts so external platforms can implement compatible APIs.
- For global economy stability and hard-currency invariants, rely on a server-authoritative ledger and economy APIs as specified in `docs/global-economy-ledger-design.md` (initiative `GEL-001`).

### 9.7 Authentication & Integrity Controls
- Self-hosted Keycloak instance issues short-lived JWT access tokens and rotation-backed refresh tokens; clients authenticate via email magic link or device key exchange.
- Engine SDK signs every social mutation with the current token and device fingerprint; backend validates signature, token scope, and rate limits per identity/device/IP.
- Server derives authoritative leaderboard scores (never trusts raw client totals) and clamps suspicious deltas before persistence.
- Telemetry pipeline feeds anomaly detection (baseline heuristics + configurable z-score rules) that can flag or quarantine accounts automatically.
- Adapter interfaces accept any OIDC-compliant IdP so partners can switch to managed providers (Auth0, Cognito, etc.) without changing client code.

## 10. Content Pipeline
- Content described via declarative TypeScript/JSON modules and compiled into normalized definitions.
- Support for hierarchical content packages (base game, seasonal event, micro-DLC) with dependency resolution.
- Validation tooling to verify IDs, cyclical dependencies, formula sanity before shipping.
- Property-based sanitization guidance lives in [`docs/content-schema-rollout-decisions.md#6-property-based-formula-sanitization-guidance`](content-schema-rollout-decisions.md#6-property-based-formula-sanitization-guidance); run the schema and CLI suites before shipping new formulas.
- Provide CLI to bundle content, generate documentation, and run balance simulations.
- `pnpm generate` invokes `tools/content-schema-cli`, which now validates every `content/pack.json` via `@idle-engine/content-schema` before refreshing runtime event manifests. The CLI emits structured JSON log events (`content_pack.validated`, `content_pack.compiled`, `content_pack.validation_failed`, `watch.run`, etc.) so automation can gate builds on failures, warnings, or drift.
- Watch and check flows are first-class: `--watch` keeps the pipeline alive after failures while surfacing iteration summaries, and `--check` exits non-zero whenever validation summaries or compiled artifacts would change. Lefthook and CI invoke `pnpm generate --check` to prevent stale outputs from landing.
- Every run persists a workspace summary at `content/compiled/index.json` (overrideable via `--summary`) that records validation and compilation status. Downstream tooling must treat the summary as stale when validation fails or the CLI reports drift; rerun `pnpm generate` to refresh artifacts before consumption.
- Authoring packs live alongside their manifests (e.g., `packages/content-sample/content/pack.json`). Keep schema warnings at zero, add missing localized variants for declared locales, and document intentional deviations so future migrations stay deterministic.
- Extendable DSL supports custom modifiers, scripted events, and guild-related hooks while maintaining sandbox boundaries.
- DSL expressed as strongly typed schemas (Zod) compiled into immutable definitions; support YAML option for non-TS teams via build-time conversion.
- Each content item declares metadata (version, compatibility range), resource/generator definitions, formulas (expressed as AST or limited expression strings), and unlock conditions.
- Preprocessors resolve derived values (e.g., cumulative cost curves) and emit warnings when difficulty spikes exceed configured thresholds.
- Content lints enforce naming conventions, ID uniqueness, and forbid direct references across prestige layers without explicit bridges.

Follow-up migration work: wire the DSL compiler to emit schema-aligned packs instead of hand-authored TypeScript, port legacy sample data into the CLI format, and extend CI so schema warnings fail builds once the broader content library lands.

## 11. Presentation Layer Contracts
- Runtime sends UI ready snapshots through a state channel; UI sends user intents (purchase upgrade, toggle automation) via command channel.
- Presentation shell chooses framework (React, Svelte, plain DOM); engine only depends on the contract.
- Desktop wrapper uses the same contract through IPC between WebView and Node host.
- Provide default UI kit (resource panels, upgrade lists, modals) for rapid prototyping while allowing custom skins.

## 12. Performance Strategy
- Run simulation in Web Worker with transferable state buffers to avoid main thread jank.
- Use data-oriented structures (typed arrays, struct-of-arrays) for high-frequency calculations.
- Memoize derived stats and recompute lazily when source data changes.
- Profile with browser tools and Node benchmarks; escalate hotspots to WebAssembly implementations when ROI is justified.

## 13. Tooling & Developer Experience
- Monorepo using pnpm or Turborepo: `packages/core`, `packages/content-{game}`, `packages/shell-web`, `packages/shell-desktop`, `packages/tools`.
- Shared type definitions and schema validation via Zod or similar.
- CLI tools for content linting, simulation playback, save migration testing.
- Storybook or component library for UI kit review.

## 14. Testing Strategy
- Unit tests for tick calculations, formula evaluation, and state reducers.
- Property-based tests for resource balance invariants (e.g., never negative resources).
- Integration tests running full simulations for offline progress scenarios.
- Snapshot tests for content definitions to catch accidental changes.
- End-to-end UI smoke tests (Playwright) against web shell.
- Contract tests covering leaderboard submissions, guild workflows, and offline/online reconciliation paths.

## 15. Deployment & Distribution
- Browser build: bundle core runtime and content, serve via CDN. Use service workers for offline caching.
- Desktop build: package web artifacts with Tauri/Electron; leverage native file system for saves and optional Steam integrations.
- Continuous delivery pipeline runs tests, bundles content, publishes npm packages for runtime and tools.
- Runtime versioning: semantic version with engine-API compatibility matrix for content packs.
- Social services deploy independently; provide feature flag management for staged leaderboards and guild rollouts.
- Licensing delivered through a partner program: partners receive vetted runtime binaries, API keys for social services, and compliance guidelines.
- Provide infrastructure-as-code templates for self-host deployments (Docker Compose for local, Terraform/Kubernetes for production) and guidance for migrating to managed leaderboard providers.

## 16. Analytics & Telemetry
- Provide opt-in telemetry hooks (events, state snapshots) sending via fetch/beacon or native channels.
- Ensure privacy compliance; keep PII out of default payloads.
- Allow games to register custom metrics using shared instrumentation API.

## 17. Security Considerations
- Sandbox third-party scripts to prevent DOM or host access.
- Validate content bundles before loading to avoid malicious overrides.
- Harden save loading with schema validation to avoid corrupted states.
- Rotate API secrets regularly, store them in Vault/Secrets Manager, and audit access logs.
- Provide moderation tooling to ban or shadowban users flagged by integrity rules, and support rapid leaderboard purges.

## 18. Roadmap (High-Level)
1. Prototype core runtime: tick loop, resource model, basic upgrades, persistence.
2. Build web shell with default UI kit and integration channel.
3. Ship CLI tooling for content definition linting and simulation tests.
4. Produce reference game module to validate end-to-end loop.
5. Implement offline progression, prestige layers, analytics hooks.
6. Stand up leaderboard and guild services; integrate authentication and moderation tooling.
7. Optimize performance hotspots; introduce WebAssembly modules as needed.
8. Package desktop shell; add cloud sync optional module.
9. Explore content editor and modding workflows.

## 19. Prototype Milestone Plan
**Objective**: Deliver a vertical slice proving the engine loop, content DSL, and social scaffolding within 8 weeks.

- **Milestone Deliverables**
  - `packages/core`: runnable runtime with scheduler, resource system, upgrade processor, save/load (JSON stub), diagnostics dashboard.
  - `packages/shell-web`: minimal React UI consuming state snapshots, executing commands, and visualizing resources/upgrades.
  - `packages/content-sample`: reference game pack with ~10 resources, 6 generators, basic prestige layer, and sample guild perks.
  - `services/social`: self-hosted Node (NestJS) or Rust (Axum) API providing stubbed leaderboard/guild endpoints with Keycloak integration.
  - CI pipeline executing unit/integration tests and linting content.

- **Workstreams & Sequencing**
  1. Foundation (Week 1-2): set up monorepo tooling (pnpm, ESLint, Vitest), implement scheduler skeleton, resource data structures, command bus.
  2. Content & DSL (Week 2-4): define schemas, build content compiler, create sample content pack, implement validation CLI.
  3. Presentation Adapter (Week 3-5): integrate Worker runtime with React shell, implement delta subscription, basic UI kit components.
  4. Persistence & Offline (Week 4-6): add save/load, offline catch-up logic, autosave timers, smoke tests.
  5. Social Stub (Week 5-7): deploy Keycloak, implement social API, integrate token validation in engine SDK, mock leaderboard UI.
  6. Hardening (Week 7-8): profiling, test coverage targets, docs (runbooks, developer guide), milestone demo.

- **Success Criteria**
  - Reference game runs at 60 ticks/sec in browser foreground with under 30% main-thread utilization on target hardware.
  - Offline catch-up accurately simulates up to 12 hours without divergence from continuous play baseline.
  - Leaderboard submissions authenticated via Keycloak and shown in UI (stubbed data acceptable).
  - Content CLI blocks invalid definitions and outputs human-friendly diagnostics.
  - CI pipeline green (unit, integration, lint) and docker-compose stack (engine + Keycloak + social API) launches via single command.

## 20. Open Questions
- How do we expose extensibility to partners while preserving engine stability (module vetting, version caps)?
- Which managed providers should we validate adapters against, and what migration tooling do partners need?
- Which telemetry thresholds or machine-learning models will we standardize on for automated cheat detection escalation?
