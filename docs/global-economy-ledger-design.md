---
title: Stabilise Global Economy with Server-Authoritative Ledger
sidebar_position: 4
---

# Stabilise Global Economy with Server-Authoritative Ledger

## Document Control
- **Title**: Stabilise Global Economy with Server-Authoritative Ledger (initiative token: ``)
- **Authors**: Idle Engine design-authoring agent (AI), TODO: Human Owner
- **Reviewers**: TODO: Runtime lead, Social service lead, Content lead
- **Status**: Draft
- **Last Updated**: 2025-11-16
- **Related Issues**: [#397](https://github.com/hansjm10/Idle-Game-Engine/issues/397)
- **Execution Mode**: AI-led

## 1. Summary

This document specifies the design for the initiative ``: stabilising the Idle Engine’s **global economy** by introducing a **server-authoritative ledger** and economy APIs in `services/social`, while keeping per-player simulation client-side and deterministic via `@idle-engine/core`. The proposal formalises a split between **local, client-authoritative soft progression** and **server-authoritative hard economic state** that underpins leaderboards, guilds, and shared world features. Using this design, the social service enforces invariants on spends, trades, and contributions without running a continuous per-player simulation, relying instead on deterministic replay and bounded validation. The impact is a globally consistent economy that tolerates untrusted clients, supports cross-device play, and scales operationally without a full server-side sim for every player.

## 2. Context & Problem Statement

- **Background**
  - The Idle Engine core runtime (`packages/core/src/index.ts`) implements a deterministic fixed-step loop with a command queue, event bus, and diagnostics timeline suitable for browser and Node execution.
  - The web shell (`packages/shell-web`) runs the core in a worker and will present resources, upgrades, and social UI.
  - The social backend (`services/social/src/index.ts`) currently exposes stubbed `leaderboard` and `guild` routes but does not own any economic state; responses are placeholder-only.
  - Design goals in `docs/idle-engine-design.md` emphasise:
    - Web-first runtime, portable to Node and native shells.
    - Optional social services for leaderboards and guild coordination.
    - Deterministic, low-overhead simulations and Node-based headless runs (`tools/runtime-sim/index.ts`) for diagnostics and analytics.
  - In recent discussions, we asserted that the **global economy must be stable**, implying we should not fully trust clients for shared economic state.

- **Problem**
  - Today, there is no defined concept of **hard vs soft currencies**, no server-authoritative economic ledger, and no invariants enforced on leaderboard submissions or guild contributions.
  - All social endpoints in `services/social` are effectively **stateless stubs** returning fixed shapes, providing no real protection against:
    - Inflated or forged scores.
    - Illegitimate contributions to shared resources (guild banks, world events).
    - Economic exploits that would destabilise a global market or progression path.
  - Running the entire simulation on the server for every player to address these issues would be **resource-exhaustive and operationally complex**, contradicting the design’s web-first, client-centric runtime.

- **Forces**
  - **Constraints**
    - Maintain web-first, browser-run simulation per `docs/idle-engine-design.md`.
    - Avoid per-player continuous server ticks; server CPU budgets should remain bounded and predictable.
    - Preserve deterministic behaviour of `IdleEngineRuntime` (`packages/core/src/index.ts`) across client and server.
    - Uphold API stability for social endpoints as they evolve beyond stubs.
  - **External Requirements**
    - Global leaderboards and guild features must reflect **canonical, server-validated state**.
    - Clients may be untrusted; malicious actors must not be able to destabilise the global economy.
  - **Timelines**
    - Initial implementation must be small, testable, and incrementally deployable (no big-bang migration).
    - The initiative `` should be deliverable in phases that can be executed by AI agents following this document.

## 3. Goals & Non-Goals

- **Goals**
  1. Define a clear split between **hard, server-authoritative economies** and **soft, client-authoritative progression** within initiative ``.
  2. Extend `services/social` with a **persistent ledger and APIs** for balances, spends, trades, and contributions, enforcing economic invariants.
  3. Ensure **leaderboard and guild endpoints** rely on server-authoritative values, not client-reported totals.
  4. Provide a **validation model** that uses deterministic replay via `IdleEngineRuntime` in Node only for bounded, on-demand verification (e.g., suspicious updates), not continuous per-player ticking.
  5. Instrument economic flows with **telemetry and diagnostics** (e.g., counters for rejected operations, anomaly flags).
  6. Provide an **AI-ready work breakdown** and guardrails so autonomous agents can implement initiative `` safely.

- **Non-Goals**
  1. Implement a full in-game marketplace, auction house, or complex derivatives systems; this design focuses on linear balances and simple trades.
  2. Ship a GUI for economy tuning; balancing remains a content/design activity defined via existing content packs.
  3. Overhaul the entire simulation model in `@idle-engine/core`; we only integrate with it for verification and offline/analytic workloads.
  4. Replace or redesign the authentication stack (Keycloak/OIDC) already used in `services/social/src/middleware/auth.ts`.
  5. Guarantee perfect anti-cheat; we target **pragmatic stability of the global economy**, not absolute attack elimination.

## 4. Stakeholders, Agents & Impacted Surfaces

- **Primary Stakeholders**
  - Runtime Team: owners of `packages/core` and deterministic sim semantics.
  - Social Service Team: owners of `services/social` and economic APIs.
  - Content/Design Team: defines which currencies are “hard” vs “soft” and the intended economic constraints.
  - Dev Experience & Tooling: owners of `tools/runtime-sim` and CI integration.

- **Agent Roles**
  - **Runtime Implementation Agent**
    - Modifies `packages/core` only where needed to support economic verification hooks and diagnostic exports for initiative ``.
    - Maintains determinism and test coverage.
  - **Social Service Implementation Agent**
    - Implements ledger schemas, routes, and persistence in `services/social`.
    - Adds validations and guards to protect the global economy.
  - **Content/Schema Agent**
    - Updates `content-schema` and `content-sample` if economy classifications (hard/soft currencies) need schema-level representation.
  - **Docs & Design Agent**
    - Maintains this design and related docs in `docs/`, ensuring they track the implementation status of initiative ``.
  - **Testing & Validation Agent**
    - Extends Vitest suites in `packages/core`, `services/social`, and end-to-end smoke tests under `tools/a11y-smoke-tests`.

- **Affected Packages/Services**
  - `packages/core/src/index.ts` (runtime interface for diagnostics/verification).
  - `services/social/src/index.ts`, `services/social/src/routes/*`, `services/social/src/types/*`.
  - `content-schema` and `content-sample` (if currency classification is exposed to content authors).
  - `tools/runtime-sim/index.ts` (for reuse or extension in verification flows).
  - `docs/idle-engine-design.md` and related design docs referencing economy behaviour.

- **Compatibility Considerations**
  - Existing stub social endpoints must remain **backward compatible in shape** where external integrations exist; new fields should be additive.
  - Authentication semantics (`req.user` from `createAuthMiddleware` in `services/social/src/middleware/auth.ts`) must remain stable.
  - The runtime’s public API in `packages/core/src/index.ts` must not silently change semantics (tick behaviour, diagnostics contracts) without versioning.
  - Where breaking changes to social APIs are unavoidable, they must be gated behind versioned paths or feature flags.

## 5. Current State

- **Runtime (`@idle-engine/core`)**
  - Implements `IdleEngineRuntime` in `packages/core/src/index.ts`, which:
    - Runs a fixed-step tick loop (`tick(deltaMs)`), bounded by `maxStepsPerFrame`.
    - Uses a `CommandQueue` and `CommandDispatcher` to process commands deterministically.
    - Emits diagnostics via `createRuntimeDiagnosticsController` and `getDiagnosticTimelineSnapshot()` for offline analysis and CI (`tools/runtime-sim/index.ts`).
  - No explicit concept of “economy verification” exists; the runtime is agnostic to whether it is used in a client or server context.

- **Web Shell (`packages/shell-web`)**
  - Boots the runtime loop and will render panels for resources and social features (`packages/shell-web/README.md`).
  - Currently assumes the client owns the moment-to-moment sim and fetches social data from `services/social`.

- **Social Service (`services/social`)**
  - Express server entrypoint at `services/social/src/index.ts`:
    - Uses Helmet, JSON body parsing, and request logging.
    - Applies `createAuthMiddleware` to all routes, enforcing OIDC via Keycloak (`services/social/src/middleware/auth.ts`).
    - Mounts `leaderboardRouter` and `guildRouter`.
  - `leaderboardRouter` (`services/social/src/routes/leaderboard.ts`):
    - `GET /leaderboard/:leaderboardId`: returns a stub entry for the current user with score 0, no persistence.
    - `POST /leaderboard/submit`: validates payload using zod but only echoes back a “queued” response, with no ledger update.
  - `guildRouter` (`services/social/src/routes/guild.ts`):
    - `GET /guilds/mine`: returns `guild: null` stub.
    - `POST /guilds`: validates, generates a synthetic `guildId`, and returns an accepted response; no persistence or economic rules.
  - No DB or durable storage is configured; `docker-compose.yml` starts the social service alongside Keycloak but without an attached datastore.

- **Content & Schema**
  - Content modules and schemas define resources, generators, upgrades, etc., but there is no explicit notion of **hard** vs **soft** currencies encoded at the schema level (follow-up work may be needed).

- **Testing & Observability**
  - Vitest and diagnostics coverage for the runtime and social service exist but are not focused on economic invariants.
  - `tools/runtime-sim/index.ts` shows how the runtime is executed under Node with a diagnostics timeline.

## 6. Proposed Solution

### 6.1 Architecture Overview

- **Narrative**
  - Initiative `` introduces a **server-authoritative economic ledger** in `services/social` responsible for:
    - Tracking balances of designated **hard currencies** per authenticated user.
    - Applying and validating economic operations (earn, spend, trade, contribute).
    - Powering leaderboards and guild resource views using canonical server values.
  - The **client** (web shell and future native shells):
    - Runs the full simulation using `IdleEngineRuntime` locally.
    - Treats hard currency balances from the social service as authoritative.
    - Performs **optimistic UI updates** but reconciles against server-ledger responses and clamps to server-provided values.
  - The server **does not** tick the simulation for each player:
    - Instead, it accepts **commands/events** that mutate the ledger directly.
    - For certain high-risk operations or suspicious patterns, it uses **deterministic replay** of the runtime under Node (borrowing from `tools/runtime-sim`) to verify plausibility within bounded time windows.

- **Diagram**

Conceptual flow (to be formalised as a diagram in a follow-up PR):

- Client:
  - `IdleEngineRuntime` (local sim) → generates resource deltas and proposed actions (spend/trade/contribute).
  - Actions → `services/social` API calls with minimal data (operation type, amount, relevant identifiers, client-side state hints).
- Server:
  - Auth middleware attaches `user.id`.
  - Economy controller validates operation:
    - Checks ledger balances and invariants.
    - Optionally triggers deterministic replay verification for flagged cases.
  - Ledger state updated in DB.
  - Responses include authoritative balances and outcome metadata, which the client uses to reconcile.

### 6.2 Detailed Design

- **Runtime Changes**
  - Expose or refine an API in `packages/core/src/index.ts` to:
    - Generate a **compact summary** of a player’s economic state at a given tick (e.g., resource rates, key milestones) for replay scenarios.
    - Initialise `IdleEngineRuntime` from such a summary for deterministic replay on the server.
  - Provide a **“verification mode”** helper (e.g., `createVerificationRuntime`) that:
    - Runs a truncated number of ticks with specified content configuration.
    - Returns computed expected economic deltas for a given timeframe.
  - Ensure any changes maintain backwards compatibility and determinism across browser and Node.

- **Data & Schemas**
  - Introduce an economy schema in `services/social/src/types/economy.ts` (new file):
    - `HardCurrencyId` enum or string union (e.g., `"GEMS"`, `"BONDS"`, `"GUILD_TOKENS"`).
    - `LedgerEntry` type: `{ userId, currencyId, balance, updatedAt }`.
    - `EconomyOperation` type: `Earn`, `Spend`, `Transfer`, `GuildContribution`, with operation-specific payloads.
  - Persistence:
    - Initial implementation may start with an **in-memory store** for development, with a clear interface that can be backed by a database in a later milestone.
    - The abstraction boundary should allow swapping implementation without changing route handlers.
  - Optional schema updates in `content-schema`:
    - Flag each resource as `hard` or `soft`, so the runtime and social service can agree on which resources must be mediated by the ledger.
    - TODO: Content/Schema Agent to propose specific fields and validations.

- **APIs & Contracts**
  - New endpoints (versioned under `/economy` in `services/social`):
    - `GET /economy/balances`
      - Returns current balances for all hard currencies for `req.user.id`.
    - `POST /economy/earn`
      - Payload: `{ currencyId, amount, source, clientTimestamp, simMetadata? }`.
      - Use primarily for server-driven rewards (events, achievements); client-submitted earns are treated conservatively and often unnecessary if hard currency creation is server-triggered.
    - `POST /economy/spend`
      - Payload: `{ currencyId, amount, reason, clientTimestamp, simMetadata? }`.
      - Validation: server checks user’s balance and configurable max spend rate, applies spend atomically, returns new balance.
    - `POST /economy/transfer`
      - Payload: `{ currencyId, amount, toUserId, reason, clientTimestamp, simMetadata? }`.
      - Validation: checks sender’s balance, optional min/max limits, and anti-abuse policies before updating both ledgers.
    - `POST /economy/guild-contribute`
      - Payload: `{ currencyId, amount, guildId, clientTimestamp, simMetadata? }`.
      - Updates guild bank ledger, powers guild views and shared contributions.
  - Leaderboards and guild routes update:
    - `GET /leaderboard/:leaderboardId`
      - Data source: aggregated ledger values and precomputed ranks, not client-submitted scores.
      - In the initial phase, scores may still be stubbed but the shape should anticipate server-authoritative scores.
    - `POST /leaderboard/submit`
      - Transitions from “queued” stub to:
        - Validating submissions against known ledger state (e.g., verifying that global scores correlate with ledgered hard currency or key stats).
        - Optionally scheduling asynchronous verification jobs.
  - Request metadata:
    - `simMetadata` field (optional) may contain:
      - `lastKnownServerBalance`, `clientClaimedBalance`, `sessionsSinceLastSync`, `offlineDurationMs`, `runtimeVersion`.
    - This metadata is used by the server to detect anomalies, not to accept client balances as truth.

- **Tooling & Automation**
  - Extend `tools/runtime-sim` or add a sibling CLI:
    - Command: `pnpm core:economy-verify --ticks <n> --snapshot <file>` (exact API TBD).
    - Given a snapshot describing a player’s state and offline duration, computes the maximum plausible hard currency gain under current content.
  - CI integration:
    - Add targeted tests under `services/social` to ensure invariants:
      - Cannot overspend.
      - Cannot transfer more than balance.
      - Rate limits for earns/spends per time window.
  - Developer tooling:
    - Scripts to seed test users and ledgers for manual QA and Playwright tests (e.g., `tools/scripts/seed-economy-users.ts`, TODO).

### 6.3 Operational Considerations

- **Deployment**
  - Continue using `docker-compose.yml` for local Keycloak + social service; extend configuration to include persistent storage for the ledger when adopted.
  - For initial milestones, in-memory ledger is acceptable for development; production deployments MUST configure a persistent store before enabling real economic features (TODO: choose DB technology).
  - CI must run `pnpm test --filter @idle-engine/social-service` to validate economic routes and invariants.

- **Telemetry & Observability**
  - Metrics:
    - Count of operations by type: `economy.operations_total{type=Earn|Spend|Transfer|GuildContribution}`.
    - Count of rejected operations: `economy.rejections_total{reason=InsufficientFunds|RateLimit|InvalidPayload|ReplayMismatch}`.
    - Anomaly flags: `economy.anomalies_total{type=ReplayMismatch|SuspiciousOfflineGain}`.
  - Logging:
    - Structured logs for each economic operation with user ID, operation type, amounts, and decision outcome.
    - Avoid logging PII beyond stable identifiers (user ID, guild ID).
  - Diagnostics:
    - For replay-based verification, log operation IDs and diagnostic summaries without dumping full state.

- **Security & Compliance**
  - All economy endpoints must require authentication via Keycloak (`createAuthMiddleware`).
  - Input must be validated with zod schemas (following existing pattern in `leaderboard.ts` and `guild.ts`).
  - Avoid storing sensitive personal data beyond what is already implied by OIDC (user IDs, usernames).
  - Implement basic rate limiting for economic endpoints (middleware or reverse proxy rules; TODO for infra owner).
  - Audit logging should make it possible to trace economic changes per user and per guild.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

Populate GitHub issues based on the following table; all issues reference initiative `` in their descriptions.

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(design): formalise global economy stability (``) | Capture final design doc in `docs/` and link to related specs | Docs & Design Agent | None | Design merged; referenced from `docs/idle-engine-design.md`; reviewers sign off |
| feat(schema): classify hard vs soft currencies | Extend content schema to mark hard currencies and sample content to use them | Content/Schema Agent | Design approval | Schema/docs updated; tests in `content-schema` pass; sample packs compile |
| feat(social): introduce server-authoritative ledger abstraction | Add in-memory ledger types and interfaces in `services/social/src/types` | Social Service Implementation Agent | Schema classification (optional) | Ledger API supports create/read/update operations; unit tests cover basic operations |
| feat(social): implement economy routes (/economy) | Add balances, spend, transfer, and guild contribution endpoints | Social Service Implementation Agent | Ledger abstraction | Routes validated with zod, protected by auth; tests verify invariants (no overspend, etc.) |
| feat(social): wire leaderboards and guilds to ledger | Drive leaderboard scores and guild resources from ledger data | Social Service Implementation Agent | Economy routes | `GET /leaderboard/:id` and `GET /guilds/mine` use ledger-derived values; tests updated |
| feat(core): add verification runtime helpers | Expose runtime helpers to support deterministic economy replay | Runtime Implementation Agent | Design approval | New APIs documented; tests confirm deterministic behaviour in Node and browser |
| feat(tools): add economy verification CLI | CLI wrapper around runtime helper for economic replay/validation | Runtime Implementation Agent | Verification helpers | CLI runs on snapshots; emits JSON; used in at least one test |
| chore(test): add economic invariants to social tests | Expand Vitest suites under `services/social` | Testing & Validation Agent | Economy routes implemented | Tests fail on invariant violations; coverage includes all economic operations |
| chore(a11y): extend shell-web tests for economy UI | Ensure economic UI interactions do not regress accessibility | Testing & Validation Agent | Basic economy UI implemented in shell | `pnpm test:a11y` passes for flows involving hard currency displays and errors |
| chore(docs): update idle-engine-design.md with economy model | Summarise hard/soft currency model & ledger in main design doc | Docs & Design Agent | Implementation stable | `docs/idle-engine-design.md` references this document; glossary updated |

### 7.2 Milestones

- **Phase 1: Foundations**
  - Finalise this design (initiative ``), including updated `docs/idle-engine-design.md`.
  - Implement ledger abstraction and in-memory store in `services/social`.
  - Add `/economy/balances` and `/economy/spend` endpoints with strong validation.
  - Establish economic tests and metrics.
  - Gating criteria:
    - All new tests pass locally and in CI.
    - No breaking changes to existing social routes; stubs still functional.

- **Phase 2: Integration**
  - Wire leaderboards and guilds to the ledger.
  - Integrate the web shell with economy endpoints (client reconciliation logic).
  - Introduce optional replay-based verification for high-risk flows.
  - Gating criteria:
    - Leaderboard and guild endpoints operate against ledger state.
    - End-to-end flows (client → social → ledger) pass manual and automated QA.

- **Phase 3: Hardening & Scale**
  - Move ledger to a persistent store and configure in deployment pipelines.
  - Add rate limiting, anomaly detection, and operational runbooks.
  - Tune economic parameters based on early telemetry and tests.
  - Gating criteria:
    - No known class of exploit allows unlimited hard currency creation or transfer.
    - Operational dashboards show stable economic metrics over time.

### 7.3 Coordination Notes

- **Hand-off Package**
  - This design document (`docs/global-economy-ledger-design.md`).
  - References to runtime code (`packages/core/src/index.ts`), social service (`services/social/src`), and tools (`tools/runtime-sim/index.ts`).
  - Example payloads and JSON contracts for economy endpoints.
  - Test commands: `pnpm test --filter @idle-engine/social-service`, `pnpm test --filter @idle-engine/core`, `pnpm test:a11y`.

- **Communication Cadence**
  - Weekly status update on initiative `` summarising merged PRs and risk items.
  - Design reviews at the end of Phase 1 and Phase 2.
  - Escalation path: runtime lead → social lead → project owner.

## 8. Agent Guidance & Guardrails

- **Context Packets**
  - Before work on initiative ``, agents must load:
    - `docs/idle-engine-design.md`
    - This design document.
    - `packages/core/src/index.ts` and tests under `packages/core/src/__tests__`.
    - `services/social/src/index.ts`, routes, middleware, and types.
    - `tools/runtime-sim/index.ts`.
  - Environment:
    - Use `nvm use` to adopt `.nvmrc` Node version.
    - Use `pnpm` as per `package.json` and root `README.md`.

- **Prompting & Constraints**
  - Agents must:
    - Follow the repository guidelines in `AGENTS.md`.
    - Use TypeScript with existing lint rules; prefer pure functions for ledger logic.
    - Respect `@typescript-eslint/consistent-type-imports`/exports.
    - Structure commits as Conventional Commits (e.g., `feat(social): add economy routes`).
  - Canonical scripting:
    - Run `pnpm lint` and appropriate `pnpm test --filter ...` before considering work complete.
    - Do not edit generated `dist/` artifacts by hand.

- **Safety Rails**
  - Forbidden:
    - Resetting git history or force-pushing without explicit human approval.
    - Bypassing authentication checks on social routes.
    - Logging access tokens or other secrets; log only stable IDs and high-level metadata.
    - Manually editing `docs/coverage/index.md`; regenerate via `pnpm coverage:md` only when required.
  - Rollback procedures:
    - If a change destabilises tests or lint, agents must revert the specific commit or open a follow-up fix before proceeding.
    - For economic changes, include feature flags or configuration toggles to disable new behaviour if needed.

- **Validation Hooks**
  - Required commands before closing issues:
    - `pnpm lint`
    - `pnpm test --filter @idle-engine/social-service`
    - `pnpm test --filter @idle-engine/core`
    - `pnpm test:a11y` when touching shell-web economy UI.
  - For CLI additions:
    - Ensure CLIs print final results as single-line JSON when intended for machine consumption (follow `tools/runtime-sim/index.ts` pattern).

## 9. Alternatives Considered

1. **Fully Client-Authoritative Economy**
   - Description: All economic values are computed and stored on the client; server only echoes or passively records data.
   - Pros:
     - No server CPU or storage requirements for economy.
     - Simplest implementation.
   - Cons:
     - Trivially exploitable; players can freely forge balances and destabilise any global system.
     - Incompatible with “global economy must be stable” requirement of initiative ``.
   - Decision: Rejected.

2. **Fully Server-Authoritative Per-Player Simulation**
   - Description: Move the entire `IdleEngineRuntime` for each player to a server process, with clients acting as thin terminals.
   - Pros:
     - Strong anti-cheat; the server is the single source of truth for all state.
     - Simplifies economic verification (no need for replay; server is always right).
   - Cons:
     - Very high resource usage and operational complexity.
     - Latency-sensitive; idle gameplay responsiveness may suffer.
     - Contradicts web-first, offline-capable design goals in `docs/idle-engine-design.md`.
   - Decision: Rejected as the primary model; may be used selectively for high-value segments in future.

3. **Aggregated Analytics-Only Checks**
   - Description: Keep economy client-authoritative but use periodic analytics jobs to detect anomalies after the fact.
   - Pros:
     - Lower implementation complexity than a full ledger.
     - No need to change social APIs significantly.
   - Cons:
     - Detection is reactive; exploits may damage the economy before detection.
     - No guaranteed global consistency at any point in time.
   - Decision: Rejected as primary strategy; some anomaly detection may still be layered on top of the server-authoritative ledger.

## 10. Testing & Validation Plan

- **Unit / Integration**
  - `services/social`:
    - Unit tests for ledger operations: earns, spends, transfers, guild contributions, and edge cases (insufficient funds, rate limits).
    - Route tests for `/economy/*`, `/leaderboard/*`, and `/guilds/*` verifying invariants and error responses.
  - `packages/core`:
    - Tests for any new verification runtime helpers to ensure deterministic replay across Node and browser environments.
  - Integration tests:
    - Simulate a full flow where a user earns and spends hard currency via social APIs and confirm ledger consistency.

- **Performance**
  - Benchmarks:
    - Measure throughput of typical economy operations under load (earn/spend) in `services/social`.
    - Ensure replay-based verification runs within a bounded time (e.g., < 200ms per operation for typical cases).
  - Targets:
    - Economy endpoints should handle at least a baseline of X operations/sec (TODO: define SLO) without degrading latency beyond Y ms at p95.

- **Tooling / A11y**
  - Extend Playwright a11y tests (`tools/a11y-smoke-tests`) to include:
    - Display of hard currency balances.
    - Error states when spends are rejected.
  - Ensure new UI elements in `packages/shell-web` have proper ARIA attributes and keyboard accessibility.

## 11. Risks & Mitigations

- **Risk: Misclassification of Currencies**
  - Hard currency incorrectly modelled as soft (or vice versa) can undermine the ledger.
  - Mitigation:
    - Require content/design sign-off on currency classification.
    - Add schema validations and tests to enforce classification for new resources.

- **Risk: Ledger Implementation Bugs**
  - Incorrect balance updates could corrupt the global economy.
  - Mitigation:
    - Rigorous unit and integration tests.
    - Use transaction-like semantics when transitioning to a real DB.
    - Implement invariants and sanity checks as assertions (with safe handling in production).

- **Risk: Replay Verification Cost**
  - Deterministic replay may be more expensive than anticipated.
  - Mitigation:
    - Limit replay to suspicious cases, not all operations.
    - Constrain replay windows (e.g., maximum offline duration).
    - Profile and optimise runtime hotspots if needed.

- **Risk: Operational Overhead**
  - Additional metrics, logs, and DB operations may increase operational complexity.
  - Mitigation:
    - Start with minimal metrics and controlled logging levels.
    - Provide clear runbooks and dashboards for operators.

- **Risk: Backwards Compatibility of APIs**
  - Changing social APIs could break existing clients or test harnesses.
  - Mitigation:
    - Maintain additive changes where possible.
    - Version new endpoints if necessary.
    - Update tests and docs concurrently.

## 12. Rollout Plan

- **Milestones**
  - Phase 1:
    - Design approval, ledger abstraction, foundational economy routes, baseline tests.
  - Phase 2:
    - Leaderboard and guild wiring, client integration, replay-based verification for selected flows.
  - Phase 3:
    - Persistent storage integration, hardening, operationalisation (metrics, runbooks).

- **Migration Strategy**
  - Start with stub-compatible changes:
    - Keep existing routes functioning with their current shapes while introducing new `/economy` endpoints.
  - Introduce ledger-backed scoreboard/guild features behind feature flags or config toggles.
  - Once stable, gradually deprecate stub responses and rely solely on ledger-based data.

- **Communication**
  - Document user-visible behaviour changes in release notes and game patch notes.
  - Notify internal stakeholders (runtime, social, content) before enabling ledger-backed features.
  - Maintain an internal FAQ and runbooks for incident response involving economic anomalies.

## 13. Open Questions

1. What are the exact **hard currency identifiers** to be supported in the first iteration, and how do they map to existing content resources?  
   - Owner: Content/Design Team.
2. What are the **target SLOs** for economy endpoints (throughput, latency)?  
   - Owner: Social Service Team / Ops.
3. Which operations warrant **replay-based verification** vs simple heuristic checks?  
   - Owner: Runtime + Social leads.
4. What **database technology** will back the ledger in production (PostgreSQL, Redis, etc.)?  
   - Owner: Infra/Ops.
5. Are there regulatory or platform-specific **compliance requirements** (e.g., regional data residency) that affect storage of economic data?  
   - Owner: Product/Legal.

## 14. Follow-Up Work

- Design and implement a **marketplace/auction house** model on top of the ledger for player-to-player trading (out of scope for initiative ``).
- Evaluate and, if necessary, implement **currency sinks** to prevent runaway inflation (e.g., sink-only upgrades, fees).
- Add **economy visualisation tools** (dashboards or exports) for designers to inspect global state and tune parameters.
- Explore a lightweight **fraud detection/ML layer** using telemetry from economic operations.

## 15. References

- `docs/idle-engine-design.md`: Core runtime and social services overview.
- `packages/core/src/index.ts`: `IdleEngineRuntime` implementation and diagnostics API.
- `services/social/src/index.ts`: Social service entrypoint and route wiring.
- `services/social/src/routes/leaderboard.ts`: Current leaderboard endpoints.
- `services/social/src/routes/guild.ts`: Current guild endpoints.
- `services/social/src/middleware/auth.ts`: Auth middleware using Keycloak and JOSE.
- `tools/runtime-sim/index.ts`: Headless runtime simulator CLI.

## Appendix A — Glossary

- **Hard Currency**: A resource whose balance is maintained and enforced by the server (social service), e.g., premium currency, guild tokens.
- **Soft Currency**: Client-local resources that affect personal progression but do not directly impact shared global systems.
- **Ledger**: A durable record of economic balances and operations per user and/or guild, maintained by the server.
- **Deterministic Replay**: Re-running the core simulation with a known seed and content configuration to reconstruct expected economic outcomes.
- **Initiative ``**: Token denoting this design’s focus on global economy stability via a server-authoritative ledger.

## Appendix B — Change Log

| Date       | Author                          | Change Summary                                           |
|------------|---------------------------------|----------------------------------------------------------|
| 2025-11-16 | Idle Engine design-authoring AI | Initial draft of global economy stability design for `` |
