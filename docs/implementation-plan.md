# Idle Engine Implementation Plan

This plan converts the design document into actionable engineering work. It spans the prototype milestone and sets up later phases so we do not write production code without agreed priorities, scope, and success criteria.

## 1. Guiding Principles
- Prototype-first: ship a vertical slice proving the runtime loop, content DSL, and social scaffolding before expanding scope.
- Deterministic behaviours over features: correctness, profiling hooks, and observability trump new content until the engine core is trusted.
- Shared tooling: linting, testing, and content validation are centralized so packages stay consistent as the monorepo grows.
- Incremental delivery: every workstream maintains mergeable branches with behind-feature flags.
- Single-responsibility pull requests: each task below is expected to ship in its own PR so reviews stay focused and staging remains incremental.

### Immediate Next Steps (Phase 0 Priorities)
- [ ] Publish a GitHub Actions pipeline that runs `pnpm install`, `pnpm lint`, and `pnpm test` across the monorepo to mirror lefthook checks.
- [ ] Update the social-service Docker image to install dependencies with pnpm (or ship an npm-compatible lockfile) so `docker-compose build` succeeds.
- [ ] Provide a Keycloak realm bootstrap (import script or seed container) so the social service can acquire JWKS during local development.
- [ ] Land minimal Vitest coverage for the tick accumulator and social route validators to protect the current skeleton while Phase 1 expands.

## 2. Workstreams Overview
| Workstream | Goal | Execution Notes | Dependent On |
| --- | --- | --- | --- |
| Runtime Core | Deterministic scheduler, state graph, systems framework | Orchestrated by AI agents following design contracts | Tooling setup |
| Content Pipeline | DSL schemas, compiler, validation CLI, sample pack | AI-driven implementation once runtime APIs freeze | Runtime Core (data contracts) |
| Presentation Shell | Web UI consuming runtime snapshots | AI agents integrate UI/Worker bridge | Runtime Core (state API) |
| Social Services | Leaderboards, guild API, Keycloak integration | AI-managed service scaffolding and auth wiring | Tooling setup, Runtime Core (SDK contracts), Presentation Shell (auth hooks) |
| Tooling & QA | Monorepo infra, lint/test configs, CI/CD | AI automates lint/test config propagation | None |
| Delivery & Ops | Docker, IaC, release management | AI handles infra templates and release automation | Tooling & QA |

## 3. Phase Breakdown

### Phase 0 – Foundations (Weeks 0-1)
- Finalize coding standards: ESLint/Prettier config, Vitest setup, commit hooks.
- Confirm Node/Pnpm versions and add `.nvmrc`/toolchain docs.
- Implement CI skeleton (GitHub Actions or similar): install, lint, build smoke.
- Automate project hygiene: auto-add new issues to the prototype board and fail PRs that lack closing keywords.
- Risk: Tooling drift across packages. Mitigation: shared config packages.

### Phase 1 – Runtime Skeleton (Weeks 1-3)
- Flesh out runtime state model (`ResourceRegistry`, `SystemBus`, command queue).
- Implement unit tests for tick accumulator and command processing.
- Provide diagnostics interface (profiling counters, event bus).
- Deliver serialized state snapshot/delta publisher compatible with Worker messaging.
- Publish typed state/snapshot contract stubs and handshake notes by Week 2 to unblock downstream teams.
- Definition of Done: `@idle-engine/core` builds, tests green, docs for API contracts.

### Phase 2 – Content DSL & Sample Pack (Weeks 2-4)
- Kick off only after Runtime Core publishes the Week 2 contract freeze; confirm handshake during architecture review.
- Define Zod schemas for resources, generators, upgrades, prestige.
- Build compiler that transforms JSON/YAML/TS modules into normalized engine definitions.
- Integrate validation CLI with reporting (severity levels, actionable output).
- Generate extended sample content (at least 10 resources, 6 generators, 3 upgrade tiers, 1 prestige layer, guild perk stub).
- DoD: CLI rejects invalid sample intentionally, `@idle-engine/content-sample` builds from compiler output.

### Phase 3 – Presentation Shell Integration (Weeks 3-5)
- Implement Worker bridge (postMessage contract) between runtime and React shell.
- Render resource panels, generator cards, upgrade modal using sample content.
- Add devtools overlay for tick metrics and state diff inspection.
- DoD: Shell renders dynamic state, responds to user commands, passes accessibility smoke tests.

### Phase 4 – Persistence & Offline (Weeks 4-6)
- Implement save slot manager (IndexedDB/localStorage) with migration hooks.
- Add offline catch-up processing with caps and deterministic replay tests.
- Build deterministic offline/soak test harness (e.g., 12-hour replay) leveraging persistence APIs and sharing reports with Tooling & QA.
- Provide import/export for debugging (behind dev flag, hashed integrity check).
- DoD: Automated tests for 12-hour offline simulation, migrations verified via fixture saves.

### Phase 5 – Social Stub & Auth (Weeks 5-7)
- Configure Keycloak realm, automate provisioning script.
- Extend social service routes with in-memory persistence and validation.
- Integrate token fetching/refresh in shell/runtime SDK, sign mutations.
- Display leaderboard/guild info in shell using stub backend.
- DoD: End-to-end test posts score, displays ranking, denies invalid token.

### Phase 6 – Hardening & Demo (Weeks 7-8)
- Performance profiling: identify hotspots, confirm CPU/memory budgets.
- Security review checklist (auth flows, rate limits, audit logs).
- Documentation: onboarding guide, API references, runbooks, partner briefing deck.
- Milestone demo + retrospective to lock next phase priorities.

## 4. Detailed Task Backlog (Initial)

### Tooling & QA
- [ ] Create `@idle-engine/config-eslint` package consumed by all workspaces.
- [ ] Add `@idle-engine/config-vitest` shared test setup (jsdom/node) with AI-friendly reporting via `vitest-llm-reporter`.
- [ ] Configure Husky/lefthook for pre-commit lint/test/build runner.
- [ ] Introduce GitHub Actions pipeline (install → lint → test → build matrix).
- [ ] Add automated accessibility smoke tests (axe-core/Playwright) wired into CI.

### Runtime Core
- [ ] Implement command queue with priority tiers (player, automation, system).
- [ ] Define `ResourceState` struct-of-arrays storage and mutation helpers.
- [ ] Create events subsystem (publish/subscribe with typed payloads).
- [ ] Add `DiagnosticTimeline` to capture tick durations and system timings.
- [ ] Write Vitest suites covering catch-up, max-step clamping, and zero-delta behaviour.

### Content Pipeline
- [ ] Author Zod schemas for metadata, resources, generators, upgrades, prestige, guild perks.
- [ ] Implement compiler to convert TS modules into normalized JSON (with deterministic ordering).
- [ ] Add `pnpm` script for content validation and sample pack build.
- [ ] Write property-based tests for formula sanitization (e.g., stats never negative).
- [ ] Document DSL usage guidelines (naming, versioning, compatibility matrix).

### Presentation Shell
- [ ] Create Worker wrapper around `IdleEngineRuntime` (init, command channel, snapshot channel).
- [ ] Implement React context/provider for engine state subscriptions.
- [ ] Build UI components: `ResourcePanel`, `GeneratorGrid`, `UpgradeDialog`, `GuildPanel`.
- [ ] Expose auth hooks/SDK bridge for token fetch/refresh and signed command mutations.
- [ ] Integrate dev overlay with tick metrics and command logs (hotkey toggled).
- [ ] Add Playwright smoke test (load page, buy generator, observe resource increase).
- [ ] Integrate CI accessibility checks (consume shared tooling task) and document remediation workflow.

### Social Services
- [ ] Provision Keycloak realm via script (client, realm, scopes, roles).
- [ ] Update container builds to use pnpm (or include a production lockfile) so Docker images compile without manual tweaks.
- [ ] Add persistence layer abstraction (start with in-memory, plan for Postgres).
- [ ] Implement leaderboard ranking logic with deterministic tie-breaking.
- [ ] Add guild roster endpoints (join/leave/invite) with rate limits.
- [ ] Add Vitest coverage for the auth middleware and stubbed leaderboard/guild routes.
- [ ] Instrument endpoints with request metrics and anomaly alerts.

### Delivery & Ops
- [ ] Expand docker-compose to include Postgres (future persistence) and Keycloak config import.
- [ ] Create Terraform module stubs for self-host deployment (Kubernetes optional).
- [ ] Document on-call runbook (health checks, log inspection, rolling restart).
- [ ] Define release versioning policy and changelog process.

## 5. Dependencies & Risks
- **Keycloak Availability**: local dev needs reliable Keycloak startup; mitigate via container health checks and realm export.
- **React 19 / Vite 7**: confirm compatibility with Worker setup; fallback to React 18 if compatibility issues arise.
- **Express 5 Beta APIs**: Monitor stability, plan to pin to commit or revert if APIs shift before GA.
- **Performance Unknowns**: offline catch-up might strain CPU; ensure instrumentation early to avoid late surprises.
- **Team Capacity**: cross-team coordination needed; assign clear owners per workstream.

## 6. Communication Cadence
- AI orchestration emits weekly status summaries covering burn-down, risks, and decisions.
- Automated architecture reviews validate interface stability whenever contracts change; alerts surface for human audit if needed.
- Project board updates are generated automatically from completed tasks in the backlog below.

## 7. Exit Criteria for Prototype Milestone
- All Phase 0-6 tasks complete or explicitly deferred with rationale.
- Demo scenario: New user loads web shell, plays 5 minutes, closes tab, returns after 8 hours with correct offline progression, posts to leaderboard, sees guild placeholder.
- Documentation updated (README, design doc cross-links, developer onboarding guide).
- Retro captured with action items feeding Phase 2 (beyond prototype) backlog.

---

This plan should be revisited at the end of each phase; automated agents can surface recommendations, but scope changes require explicit approval to prevent unplanned work from slipping into the prototype milestone.
